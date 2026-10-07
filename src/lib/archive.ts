import {
  serializeBackupBytes,
  readStoredReceiptBytes,
  type BackupFile,
  withMigrationLock,
} from "./backup";
import { isAndroid, isDesktop, saveExportFile } from "./desktop";
import { db, resyncCounters } from "./localdb";
import { sha256Hex } from "./receipts-share";
import { encryptFullBackupBytes } from "./backup-crypto";
import {
  isTelegramConfigured,
  readTelegramConfig,
  uploadYearArchive,
} from "./telegram-backup";
import {
  currentYear,
  deleteYear,
  distinctYears,
  rowsForArchiveYear,
  rowsForYear,
  yearOf,
  yearDeletionFingerprintFromSnapshot,
  RETAINED_YEARS,
  YEAR_TABLES,
  type YearTable,
} from "./years";

/**
 * Year archiving.
 *
 * The app keeps `RETAINED_YEARS` years of data. When an extra year appears,
 * the oldest year is:
 *   1. sent to the configured Telegram chat (encrypted the same way as a
 *      full backup — see `encryptFullBackupBytes`), so an off-device copy
 *      exists that the person doesn't have to remember to keep,
 *   2. saved as one local file, named after the year, for their own
 *      Documents/Downloads, and only then
 *   3. removed from the local database.
 *
 * Every step must succeed before the next runs, and the local database is
 * only touched after both copies (Telegram + local file) are confirmed
 * written — the same "never delete before it's safely out" guarantee the
 * original local-only version had, extended to cover the new Telegram leg.
 * Telegram must be configured and a backup passphrase must be set before a
 * year can be archived at all: once a year's rows are deleted here, the
 * Telegram copy is the only remaining off-device copy, so it can't be
 * optional the way it is for whole-database backups.
 */

export type YearArchive = BackupFile & { year: number; archived_at: string };

export type ArchiveRecord = {
  year: number;
  archived_at: string;
  rows: number;
  file_name: string;
  /** Telegram upload session id, when the archive was sent there. */
  telegram_session?: string;
};

const LOG_KEY = "ks:archive-log";
const SKIP_KEY = "ks:archive-skipped";
const archiveDeletionFingerprints = new WeakMap<object, string>();

export function readArchiveLog(): ArchiveRecord[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(
      window.localStorage.getItem(LOG_KEY) ?? "[]",
    ) as ArchiveRecord[];
  } catch {
    return [];
  }
}

function writeArchiveLog(rows: ArchiveRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOG_KEY, JSON.stringify(rows));
}

/** "Remind me later" for the current session only. */
export function skipArchiveForNow(year: number) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(SKIP_KEY, String(year));
}

export function isArchiveSkipped(year: number) {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(SKIP_KEY) === String(year);
}

/** Oldest year that must leave the app, or null when within the retention window. */
export async function yearDueForArchive(): Promise<number | null> {
  const years = await distinctYears();
  if (years.length <= RETAINED_YEARS) return null;
  return years[0] ?? null;
}

export async function yearRowCount(year: number) {
  let total = 0;
  for (const name of Object.keys(YEAR_TABLES) as YearTable[]) {
    total += (await rowsForArchiveYear(name, year)).length;
  }
  const expenses = await rowsForYear<{ receipt_path: string | null }>(
    "expenses",
    year,
  );
  const investments = await rowsForYear<{ receipt_path: string | null }>(
    "investments",
    year,
  );
  const bills = await rowsForYear<{ receipt_path: string | null }>(
    "bills",
    year,
  );
  const paths = new Set([
    ...expenses.map((e) => e.receipt_path).filter((p): p is string => !!p),
    ...investments.map((e) => e.receipt_path).filter((p): p is string => !!p),
    ...bills.map((e) => e.receipt_path).filter((p): p is string => !!p),
  ]);
  for (const path of paths) {
    if (await db.receipts.get(path)) total += 1;
    if (await db.receipt_hashes.get(path)) total += 1;
  }
  return total;
}

/** Builds a self-contained snapshot of every row that will actually be removed. */
export async function buildYearArchive(year: number): Promise<YearArchive> {
  // Capture every IndexedDB row that belongs to the archive in ONE read
  // transaction. Sequential reads of different tables can otherwise mix
  // pre-edit and post-edit states; the later delete fingerprint would then
  // incorrectly bless an archive that never represented one real DB state.
  const snapshot = await db.transaction(
    "r",
    [
      ...Object.keys(YEAR_TABLES).map((t) => db[t as YearTable]),
      db.customers,
      db.customer_tabs,
      db.receipts,
      db.receipt_hashes,
    ],
    async () => {
      const tables: BackupFile["tables"] = {};
      for (const name of Object.keys(YEAR_TABLES) as YearTable[]) {
        tables[name] = (await rowsForArchiveYear(name, year)) as Record<
          string,
          unknown
        >[];
      }
      tables["customers"] = (await db.customers.toArray()) as unknown as Record<
        string,
        unknown
      >[];
      const archivedTabEntries = (tables["tab_entries"] ?? []) as Record<
        string,
        unknown
      >[];
      const tabIds = new Set(
        archivedTabEntries.map((r) => String(r["tab_id"])).filter(Boolean),
      );
      tables["customer_tabs"] = tabIds.size
        ? ((await db.customer_tabs.toArray()).filter((t) =>
            tabIds.has(String(t.id)),
          ) as unknown as Record<string, unknown>[])
        : [];
      return {
        tables,
        expenses: (await db.expenses.toArray()) as Array<{
          receipt_path?: string | null;
          spent_at: string;
        }>,
        investments: (await db.investments.toArray()) as Array<{
          receipt_path?: string | null;
          investment_date: string;
        }>,
        bills: (await db.bills.toArray()) as Array<{
          receipt_path?: string | null;
          bill_date: string;
        }>,
        receipts: (await db.receipts.toArray()) as Array<{
          path: string;
          size?: number;
          blob?: Blob;
          created_at: string;
        }>,
        receiptHashes: await db.receipt_hashes.toArray(),
      };
    },
  );

  const tables = snapshot.tables;
  const expenses = tables["expenses"] as Record<string, unknown>[];
  const investments = tables["investments"] as Record<string, unknown>[];
  const bills = tables["bills"] as Record<string, unknown>[];
  const receiptPaths = new Set(
    [
      ...expenses.map((e) => e["receipt_path"]),
      ...investments.map((e) => e["receipt_path"]),
      ...bills.map((e) => e["receipt_path"]),
    ].filter((p): p is string => typeof p === "string" && p.length > 0),
  );

  // Cross-year sharing is checked against the same transaction snapshot, not
  // the live tables after the transaction has ended. Any later change causes
  // the deletion fingerprint below to differ and aborts destructive deletion.
  for (const path of receiptPaths) {
    const sharedExpense = snapshot.expenses.some(
      (e) => e.receipt_path === path && yearOf(e.spent_at) !== year,
    );
    const sharedInvestment = snapshot.investments.some(
      (e) => e.receipt_path === path && yearOf(e.investment_date) !== year,
    );
    const sharedBill = snapshot.bills.some(
      (e) => e.receipt_path === path && yearOf(e.bill_date) !== year,
    );
    if (sharedExpense || sharedInvestment || sharedBill)
      throw new Error(
        `Can't archive ${year}: receipt ${path} is referenced by another year's expense, investment, or bill.`,
      );
  }

  const photoManifest: NonNullable<BackupFile["photo_manifest"]> = [];
  const receiptHashes = [];
  const fingerprintReceipts: Record<string, unknown> = {};
  const receiptRowsByPath = new Map(snapshot.receipts.map((r) => [r.path, r]));
  const hashRowsByPath = new Map(
    snapshot.receiptHashes.map((r) => [r.path, r]),
  );

  // Receipt bytes are read after the metadata snapshot. Their hashes become
  // part of the expected deletion fingerprint, so a photo changed between
  // snapshot and deletion is caught instead of silently being deleted after
  // the archive captured an older/different byte sequence.
  for (const path of receiptPaths) {
    const photo = receiptRowsByPath.get(path);
    const hash = hashRowsByPath.get(path);
    if (!photo)
      throw new Error(
        `Can't archive ${year}: receipt ${path} is referenced by an expense, investment, or bill but the photo is missing.`,
      );
    if (hash) {
      if (!/^[0-9a-f]{64}$/i.test(String(hash.sha256)))
        throw new Error(
          `Can't archive ${year}: receipt hash for ${path} is invalid.`,
        );
      receiptHashes.push(hash);
    }
    const bytes = await readStoredReceiptBytes(path);
    const actual = await sha256Hex(bytes);
    if (hash && actual.toLowerCase() !== String(hash.sha256).toLowerCase())
      throw new Error(
        `Can't archive ${year}: receipt ${path} failed its capture-time checksum.`,
      );
    fingerprintReceipts[path] = {
      size: bytes.length,
      sha256: actual,
      created_at: photo.created_at ?? null,
    };
    photoManifest.push({
      path: photo.path,
      sha256: actual,
      size: bytes.length,
      created_at: photo.created_at,
    });
  }

  const archive: YearArchive = {
    format: "turf-snack-ledger",
    version: 3,
    exported_at: new Date().toISOString(),
    year,
    archived_at: new Date().toISOString(),
    tables,
    photo_manifest: photoManifest,
    receipt_hashes: receiptHashes,
  };
  archiveDeletionFingerprints.set(
    archive,
    await yearDeletionFingerprintFromSnapshot(tables, fingerprintReceipts),
  );
  return archive;
}

export const archiveFileName = (year: number) =>
  `Turf bookings and sales - ${year}.db`;

/**
 * Saves the archive's ENCRYPTED bytes (see `encryptFullBackupBytes` in
 * `archiveYear` below) — never the plaintext snapshot. This file lands in
 * the same public Documents/Downloads location the Telegram copy is meant
 * to have a backup for, so it needs the same protection: anything written
 * to a shared location "can end up copied/shared like any other file" (see
 * `telegram-backup.ts`'s `encryptFullBackupBytes` doc comment), and a whole
 * year of bookings/sales sitting in cleartext in Downloads was exactly that
 * risk. Browser/PWA: Blob download, same as before. Desktop: native Save
 * dialog + `tauri-plugin-fs`'s binary `writeFile` (not `writeTextFile` —
 * the bytes are an encrypted container, not text), matching backup.ts's
 * `downloadBackup`. Returns `false` if a desktop Save dialog was cancelled,
 * so `archiveYear` below can stop before deleting anything — the archive
 * must not be considered "downloaded" if the user backed out of the dialog.
 *
 * Android is matched before the generic desktop branch and skips that Save
 * dialog entirely: on Android, `save()` hands back a `content://` URI that
 * `tauri-plugin-fs` cannot actually write to — it fails silently rather than
 * throwing, so this used to return `true` (a real path, from the dialog)
 * while leaving a 0-byte file on disk. That's the worst possible failure
 * mode for this specific function: `archiveYear` deletes the local rows
 * right after `saveArchiveBytes` reports success, so a silent 0-byte write
 * here meant permanently losing a year of bookings/sales with no usable
 * backup of them anywhere. Routing Android through `saveExportFile` (the
 * same MediaStore-backed plugin used for backups/exports) makes the write
 * actually succeed-or-fail honestly, so that guarantee holds again.
 */
async function saveArchiveBytes(
  bytes: Uint8Array,
  name: string,
): Promise<boolean> {
  if (isAndroid()) {
    const result = await saveExportFile(
      bytes,
      name,
      "application/octet-stream",
    );
    // archiveYear deletes rows once this reports success, so a failure must
    // be loud and carry its reason rather than a silent false.
    if (!result.saved)
      throw new Error(
        `Couldn't save the archive file: ${result.error ?? "unknown reason"}`,
      );
    return true;
  }
  if (isDesktop()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile, readFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: name,
      filters: [{ name: "Ledger archive", extensions: ["db"] }],
    });
    if (!path) return false;
    await writeFile(path, bytes);
    // Archiving is destructive after this function returns. Verify the actual
    // file that the native picker accepted, so a partial/zero-byte write can
    // never be reported as a successful archive.
    const written = new Uint8Array(await readFile(path));
    if (
      written.length !== bytes.length ||
      (await sha256Hex(written)).toLowerCase() !==
        (await sha256Hex(bytes)).toLowerCase()
    ) {
      throw new Error(
        "The archive file failed its write-back checksum; nothing was deleted.",
      );
    }
    return true;
  }
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

export type ArchiveResult = {
  year: number;
  rows: number;
  fileName: string;
  telegramSession: string;
  telegramParts: number;
};

/**
 * Archives one year: Telegram upload → local download → delete rows. Any
 * failure before the delete leaves the data completely untouched —
 * including the user cancelling the desktop Save dialog (see
 * `saveArchiveBytes` above), a missing/invalid Telegram setup, a missing backup
 * passphrase, or the Telegram upload itself failing partway through.
 *
 * Telegram is checked (and the archive encrypted) before the local Save
 * dialog even opens, so a person isn't asked to pick a save location only
 * to be told afterwards that nothing could be deleted anyway. The order
 * after that is: local file saved first (cheap, already-tested path), then
 * the network upload, then — only if both landed — the delete.
 */
export async function archiveYear(year: number): Promise<ArchiveResult> {
  // Defense in depth: the automatic dialog can only ever offer a year past
  // the retention window (never the current one), but the manual picker in
  // Settings has no such structural guarantee — it lists every year with
  // any data, current year included. Archiving the year still in active
  // use would delete live, in-progress bookings/sales/bills out from under
  // the person using the app right now, so this is rejected here too, not
  // just left to the UI to remember.
  if (year === currentYear())
    throw new Error(
      `${year} is the current year and still in use — it can't be archived.`,
    );

  const snapshot = await buildYearArchive(year);
  const deletionFingerprint = archiveDeletionFingerprints.get(snapshot);
  if (!deletionFingerprint)
    throw new Error(
      `Archive ${year} could not establish a deletion fingerprint.`,
    );
  const rows = await yearRowCount(year);

  if (rows === 0) throw new Error(`No ${year} records found to archive.`);

  const cfg = await readTelegramConfig();
  if (!isTelegramConfigured(cfg))
    throw new Error(
      "Set up Telegram backup (Settings → Telegram backup) before archiving a year — the archived year is sent there, which is what makes it safe to remove locally.",
    );

  // R4: version-3 archives travel as a zip container (archive JSON +
  // photos/*) via backup.ts's serializer — the old version-2 form put a
  // whole year of base64 photo data into ONE JSON string, which could not
  // be built at all at tens of thousands of receipts. `restoreBackup`
  // reads both forms.
  const bytes = await serializeBackupBytes(snapshot);

  // Encrypted the same way as a full backup (see encryptFullBackupBytes) —
  // neither Telegram nor the local file this function saves ever sees
  // plaintext bookings/sales data; both get these same encrypted bytes.
  // Throws a clear, actionable error if no backup passphrase has been set
  // yet.
  const encrypted = await encryptFullBackupBytes(bytes);

  const fileName = archiveFileName(year);
  const saved = await saveArchiveBytes(encrypted, fileName);
  if (!saved) throw new Error(`Archive cancelled — nothing was deleted.`);

  let telegramSession: string;
  let telegramParts: number;
  try {
    const uploaded = await uploadYearArchive(cfg, year, encrypted, {
      deviceLabel: cfg.deviceLabel,
    });
    telegramSession = uploaded.session;
    telegramParts = uploaded.parts;
  } catch (e) {
    throw new Error(
      `Saved locally as "${fileName}", but the Telegram upload failed, so nothing was deleted: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  await withMigrationLock(async () => {
    await deleteYear(year, deletionFingerprint);
    await resyncCounters();
  });

  const record: ArchiveRecord = {
    year,
    archived_at: new Date().toISOString(),
    rows,
    file_name: fileName,
    telegram_session: telegramSession,
  };
  writeArchiveLog([record, ...readArchiveLog().filter((r) => r.year !== year)]);

  return { year, rows, fileName, telegramSession, telegramParts };
}
