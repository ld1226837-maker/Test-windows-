import {
  db,
  table,
  DATA_TABLES,
  resyncCounters,
  backfillInvestmentBillNumbers,
  nowIso,
  type DataTable,
  type Row,
  type ReceiptHashRow,
} from "./localdb";
import {
  isAndroid,
  isDesktop,
  saveExportFile,
  beginAndroidExportStream,
  saveToAppDocuments,
  removeAppDocument,
  readAppDocument,
  appDocumentExists,
  moveAppDocument,
  bytesToBase64,
  base64ToBytes,
} from "./desktop";
import {
  findInvalidRows,
  findInvalidPhotoRows,
  findInvalidReceiptHashRows,
  describeInvalidRows,
  validateBackupTablesEnvelope,
  isSafeReceiptPath,
} from "./backup-validate";
import { reloadLayoutFromStorage } from "./layout-prefs";
import {
  encryptFullBackupBytes,
  decryptFullBackupBytes,
} from "./backup-crypto";
import { sha256Hex } from "./receipts-share";
import { receiptMimeType } from "./receipt-storage";
import {
  writeStoreZip,
  readStoreZipStream,
  memoryZipSink,
  type ZipEntry,
  type ZipSink,
} from "./stream-zip";
import { istTimestampKey } from "./utils";

export const BACKUP_TABLES = DATA_TABLES;

export type BackupTable = DataTable;

/** One receipt photo, base64-encoded, as carried inline in a version-2 backup. */
export type BackupPhoto = { path: string; data: string; created_at: string };

/** R4: one row of a version-3 backup's photo manifest. */
export type PhotoManifestEntry = {
  path: string;
  sha256: string;
  size: number;
  created_at: string;
};

type InternalRestoreOptions = {
  preserveReceiptsDuringRestore?: boolean | undefined;
  suppressImportMarker?: boolean | undefined;
  restoreCommitJournalKey?: string | undefined;
  restoreCommitJournalValue?: string | undefined;
};

const internalRestoreOptions = new WeakMap<object, InternalRestoreOptions>();

/** Internal-only restore controls. These are kept outside BackupFile so they
 * cannot be forged by imported JSON or normal .db backups. */
export function setInternalRestoreOptions(
  backup: BackupFile,
  options: InternalRestoreOptions,
): void {
  internalRestoreOptions.set(backup, { ...options });
}

function getInternalRestoreOptions(backup: BackupFile): InternalRestoreOptions {
  return internalRestoreOptions.get(backup) ?? {};
}

/**
 * Normalize rows from older backup schema versions before validation/write.
 * Opening Dexie at the current schema does NOT run historical upgrade hooks
 * against rows being bulkPut from a backup, so restore must apply any
 * data-shape backfills explicitly. This is deliberately conservative: only
 * fields whose historical upgrade contract is known are filled.
 */
function normalizeBackupForCurrentSchema(backup: BackupFile): BackupFile {
  const schema = Number(backup.schema_version ?? 1);
  if (!Number.isSafeInteger(schema) || schema < 1)
    throw new Error("Backup has an invalid schema version");
  if (schema >= 5) return backup;
  const tables = { ...backup.tables };
  if (Array.isArray(tables["snack_sales"])) {
    tables["snack_sales"] = tables["snack_sales"].map((row) =>
      row && row["merged_into_bill_id"] === undefined
        ? { ...row, merged_into_bill_id: null }
        : row,
    );
  }
  return { ...backup, tables };
}

/** JSON with sorted object keys, so equal records compare equal regardless of
 * key insertion order (IndexedDB vs JSON-parsed rows). */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export type BackupFile = {
  /** Stable identity used to make repeated merge imports idempotent. */
  backup_id?: string | undefined;
  /** Dexie schema version that produced this backup. */
  schema_version?: number | undefined;
  app_version?: string | undefined;
  format: "turf-snack-ledger";
  /**
   * Version 1 was table rows only — receipt photos travelled separately via
   * the `.zip` export in receipts-share.ts. Version 2 adds `photos` below,
   * so a single `.db` file is fully self-contained (data + receipt photos)
   * and can be copied straight to another device (Windows ⇄ Android) with
   * nothing else to transfer. `restoreBackup` reads both versions the same
   * way — `photos` simply comes back empty for a version-1 file.
   */
  version: 1 | 2 | 3 | 4 | 5;
  exported_at: string;
  /** Present on a year archive; used to preserve unrelated live tab state during replace. */
  year?: number | undefined;
  tables: Record<string, Record<string, unknown>[]>;
  photos?: BackupPhoto[] | undefined;
  /**
   * Capture-time hashes for `photos[]`, same table `buildFullBackup`
   * (telegram-backup.ts) already carries. Not part of `tables` — like
   * `receipts`, `receipt_hashes` isn't in `DATA_TABLES` — so it's its own
   * optional field, absent from anything built before this field existed.
   */
  receipt_hashes?: ReceiptHashRow[] | undefined;
  /**
   * R4 (version 3): receipt photos no longer travel as one giant base64
   * JSON string. `photo_manifest` records {path, sha256, size, created_at}
   * per photo; the bytes themselves travel in a zip container next to this
   * JSON (`downloadBackup` packs `backup.json` + `photos/<path>` entries;
   * `decodeBackupBytes`/`restoreBackup` unpack it). Version 1/2 files keep
   * their inline `photos` array and restore unchanged.
   */
  photo_manifest?: PhotoManifestEntry[];
  theme?: Record<string, string | null> | undefined;
  layout?: Record<string, string | null> | undefined;
  localSettings?: Record<string, string | null> | undefined;
  /** Explicitly reported omissions from a partial backup. */
  partial?: boolean;
  warnings?: string[];
};

/**
 * Reads every local table, plus every receipt photo, into one portable
 * snapshot. Photos come from `db.receipts` — `uploadReceipt` (expenses.ts)
 * mirrors every photo there on every platform (not just the browser/PWA
 * build), so this one Dexie table is always the complete set regardless of
 * whether the device also keeps an on-disk copy under `Documents/TurfApp`.
 */
/** Snapshot / restore the theme + layout localStorage keys so the backup
 * truly carries EVERYTHING (theme profiles, custom theme, mode, layout and
 * applied preset), not just the IndexedDB tables. */
function captureThemeLayout(): Pick<BackupFile, "theme" | "layout"> {
  const theme: Record<string, string | null> = {};
  for (const k of [
    "app-theme-profiles",
    "app-custom-theme",
    "app-custom-theme-css",
    "app-theme-mode",
  ])
    theme[k] =
      typeof window === "undefined" ? null : window.localStorage.getItem(k);
  const layout: Record<string, string | null> = {};
  for (const k of [
    "ks:layout-active",
    "ks:layout-presets",
    "ks:layout-applied-preset",
    // The order-version keys pin the restored layout to the same schema
    // version, so a restore does NOT trigger a re-migration that could
    // reorder the arrangement array.
    "ks:settings-order-version",
    "ks:nav-order-version",
  ])
    layout[k] =
      typeof window === "undefined" ? null : window.localStorage.getItem(k);
  return { theme, layout };
}
function applyThemeLayout(
  theme: Record<string, string | null> | undefined,
  layout: Record<string, string | null> | undefined,
) {
  if (typeof window === "undefined") return; // non-DOM env (tests/SSR)
  for (const [k, v] of Object.entries(theme ?? {}))
    if (v != null) window.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(layout ?? {}))
    if (v != null) window.localStorage.setItem(k, v);
  reloadLayoutFromStorage();
}

/** Snapshot / restore ALL localStorage settings (print, business ops,
 * app settings, step settings) so the backup holds everything, not just
 * IndexedDB tables + theme/layout. */
export function captureLocalSettings(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  try {
    const keys = Object.keys(window.localStorage);
    for (const k of keys) {
      if (
        (k.startsWith("ks:") || k.startsWith("app-") || k.startsWith("sn-")) &&
        !k.startsWith("__migration_imported__:") &&
        !k.startsWith("__migration_restore__:") &&
        !k.startsWith("__telegram_restore__") &&
        !k.startsWith("__telegram_restore_snapshot__") &&
        !k.startsWith("ks:telegram-backup") &&
        !/(token|passphrase|password|secret|api[-_]?key|credential|private[-_]?key|access[-_]?key)/i.test(
          k,
        )
      ) {
        out[k] = window.localStorage.getItem(k);
      }
    }
  } catch {
    /* localStorage unavailable (SSR) */
  }
  return out;
}
function applyLocalSettings(saved: Record<string, string | null> | undefined) {
  if (!saved || typeof window === "undefined") return;
  for (const [k, v] of Object.entries(saved)) {
    // Telegram routing is device-local: never replace the target chat ID or
    // label during a cross-device restore. Credentials are separately kept
    // in the OS secure store.
    if (k.startsWith("ks:telegram-backup")) continue;
    if (v != null) window.localStorage.setItem(k, v);
  }
}

/**
 * Reads one receipt photo's bytes from the platform's source of truth —
 * on disk for desktop/Android (R2: IndexedDB rows there carry no blob),
 * the Dexie blob on web. One photo is live in memory at a time; callers
 * must stream, never collect (rule 2).
 */
export async function readStoredReceiptBytes(
  path: string,
): Promise<Uint8Array> {
  const row = await db.receipts.get(path);
  if (row?.blob) return new Uint8Array(await row.blob.arrayBuffer());
  if (isDesktop()) return readAppDocument(path);
  throw new Error(`Receipt photo missing from this device: ${path}`);
}

type RestoreJournal = {
  backupId: string;
  mode: "replace" | "merge";
  metadataApplied: boolean;
  completedPhotos: string[];
  nativePhase?:
    "staging" | "promoting" | "files-promoted" | "metadata-applied" | undefined;
  nativeCreated?: string[] | undefined;
  nativeBackups?: { original: string; temp: string }[] | undefined;
  nativeStaged?: { final: string; temp: string }[] | undefined;
  nativeItems?:
    | {
        final: string;
        state: "prepared" | "backed-up" | "deleted" | "promoted";
      }[]
    | undefined;
  localSettingsBefore?: Record<string, string | null> | undefined;
  localSettingsAfter?: Record<string, string | null> | undefined;
  updatedAt: string;
};

const restoreJournalKey = (backupId: string) =>
  `__migration_restore__:${backupId}`;

async function readRestoreJournal(
  backupId: string,
): Promise<RestoreJournal | null> {
  if (!backupId) return null;
  const row = await db.app_settings.get(restoreJournalKey(backupId));
  if (!row || typeof row.value !== "string") return null;
  try {
    const parsed = JSON.parse(row.value) as RestoreJournal;
    if (parsed.backupId !== backupId || !Array.isArray(parsed.completedPhotos))
      return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeRestoreJournal(journal: RestoreJournal): Promise<void> {
  await db.app_settings.put({
    key: restoreJournalKey(journal.backupId),
    value: JSON.stringify({ ...journal, updatedAt: nowIso() }),
  } as never);
}

export async function cleanupStaleBackupArtifacts(
  protectedPaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const { baseDir } = await (async () => {
      const d = await import("./desktop");
      return d.getAppDocsBaseForInternalUse();
    })();
    const { remove } = await import("@tauri-apps/plugin-fs");
    const roots = ["Exports", "Receipts"] as const;
    for (const root of roots) {
      const entries = await readDir(`TurfApp/${root}`, { baseDir });
      for (const entry of entries) {
        const name = entry.name ?? "";
        const stale =
          (root === "Exports" &&
            name.startsWith(".") &&
            (name.includes(".partial") ||
              name.includes(".previous") ||
              name.startsWith(".restore-"))) ||
          (root === "Receipts" &&
            (name === ".restore-staging" || name === ".restore-rollback"));
        const relative = `${root}/${name}`;
        if (
          stale &&
          ![...protectedPaths].some(
            (protectedPath) =>
              protectedPath === relative ||
              protectedPath.startsWith(`${relative}/`),
          )
        )
          await remove(`TurfApp/${root}/${name}`, {
            baseDir,
            recursive: true,
          }).catch(() => {});
      }
    }
  } catch {
    /* best-effort startup hygiene */
  }
}

export async function recoverPendingNativeRestoreSessions(): Promise<void> {
  if (!isDesktop()) return;
  const rows = await db.app_settings.toArray();
  const protectedPaths = new Set<string>();
  for (const row of rows) {
    if (
      !row.key.startsWith("__migration_restore__:") ||
      typeof row.value !== "string"
    )
      continue;
    try {
      const journal = JSON.parse(row.value) as RestoreJournal;
      if (!journal?.backupId || !journal.nativePhase) continue;
      for (const item of journal.nativeStaged ?? [])
        protectedPaths.add(item.temp);
      for (const pair of journal.nativeBackups ?? [])
        protectedPaths.add(pair.temp);
      try {
        await recoverNativeRestoreJournal(journal);
      } catch {
        // Keep every journal-referenced staging/rollback artifact protected
        // below if recovery itself fails; deleting it here would destroy the
        // only durable material needed for the next startup recovery.
      }
    } catch {
      // Ignore malformed settings; unrelated restore validation remains
      // fail-closed.
    }
  }
  // Cleanup is deliberately last. Never delete an artifact still referenced
  // by a journal whose recovery could not complete.
  await cleanupStaleBackupArtifacts(protectedPaths);
}

async function recoverNativeRestoreJournal(
  journal: RestoreJournal,
): Promise<void> {
  if (!isDesktop() || !journal.nativePhase) return;
  const staged = journal.nativeStaged ?? [];
  const created = journal.nativeCreated ?? [];
  const backups = journal.nativeBackups ?? [];
  const items = journal.nativeItems ?? [];
  if (
    !journal.metadataApplied &&
    (journal.nativePhase === "promoting" ||
      journal.nativePhase === "files-promoted")
  ) {
    // Only an UNCOMMITTED native promotion may be rolled back. The durable
    // metadataApplied flag is committed in the same Dexie transaction as the
    // restored DB metadata, so it is authoritative even if the process dies
    // before the follow-up nativePhase="metadata-applied" checkpoint.
    // Incoming final paths are safe to remove because every such path belongs
    // to this restore's staged set; originals are restored from durable backups.
    const incomingFinals = new Set(staged.map((item) => item.final));
    const replacedPaths = new Set(backups.map((pair) => pair.original));
    const stateByPath = new Map(items.map((item) => [item.final, item.state]));
    // Recovery is driven by the durable per-file state, not by nativeCreated
    // alone. A prepared item may have its rollback identity journaled before the
    // backup exists; in that state the original is still authoritative.
    for (const path of incomingFinals) {
      const state = stateByPath.get(path);
      if (replacedPaths.has(path)) {
        const pair = backups.find((b) => b.original === path);
        const backupExists = !!pair && (await appDocumentExists(pair.temp));
        if (state === "promoted" || state === "deleted") {
          if (backupExists) {
            try {
              await removeAppDocument(path);
            } catch {
              /* best-effort: failure here is non-fatal */
            }
            try {
              await moveAppDocument(pair!.temp, path);
            } catch {
              /* best-effort: failure here is non-fatal */
            }
          }
        } else if (state === "backed-up") {
          // The delete and its journal checkpoint are separate durable steps.
          // If the process died after deleting the original but before recording
          // state="deleted", the filesystem is authoritative: a missing
          // original plus a valid rollback copy means the delete already
          // happened, so restore the original instead of discarding the backup.
          if (backupExists) {
            const originalExists = await appDocumentExists(path);
            if (originalExists) {
              try {
                await removeAppDocument(pair!.temp);
              } catch {
                /* best-effort: failure here is non-fatal */
              }
            } else {
              try {
                await moveAppDocument(pair!.temp, path);
              } catch {
                /* best-effort: failure here is non-fatal */
              }
            }
          }
        }
        // prepared: preserve the original; the backup may not exist yet.
      } else {
        // New target: if promotion reached the filesystem, remove the incoming
        // file; otherwise only the staging temp needs cleanup.
        if (state === "promoted" || state === "deleted") {
          try {
            await removeAppDocument(path);
          } catch {
            /* best-effort: failure here is non-fatal */
          }
        }
      }
    }
    for (const path of created) {
      if (!replacedPaths.has(path) && !incomingFinals.has(path)) {
        try {
          await removeAppDocument(path);
        } catch {
          /* best-effort: failure here is non-fatal */
        }
      }
    }
    for (const pair of backups) {
      // Any backup left after recovery is temporary and can be removed once
      // the original has been preserved/restored.
      try {
        if (await appDocumentExists(pair.temp))
          await removeAppDocument(pair.temp);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
    for (const item of staged) {
      try {
        await removeAppDocument(item.temp);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
  } else {
    // Staging only, or metadata already committed: never roll back committed
    // database state. Remove temporary/backup files and leave promoted files.
    for (const item of staged) {
      try {
        await removeAppDocument(item.temp);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
    for (const pair of backups) {
      try {
        await removeAppDocument(pair.temp);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
  }
  // A merge never changes local settings, so recovery must not apply the
  // imported ones (or wipe local keys) either. Replace restores only.
  const settingsToApply =
    journal.mode === "merge"
      ? undefined
      : journal.metadataApplied
        ? journal.localSettingsAfter
        : journal.localSettingsBefore;
  if (settingsToApply && typeof window !== "undefined") {
    try {
      for (const k of Object.keys(window.localStorage)) {
        if (
          (k.startsWith("ks:") ||
            k.startsWith("app-") ||
            k.startsWith("sn-")) &&
          !k.startsWith("ks:telegram-backup") &&
          !/(token|passphrase|password|secret|api[-_]?key|credential|private[-_]?key|access[-_]?key)/i.test(
            k,
          ) &&
          !Object.prototype.hasOwnProperty.call(settingsToApply, k)
        )
          window.localStorage.removeItem(k);
      }
      for (const [k, v] of Object.entries(settingsToApply)) {
        if (k.startsWith("ks:telegram-backup")) continue;
        if (v != null) window.localStorage.setItem(k, v);
        else window.localStorage.removeItem(k);
      }
      reloadLayoutFromStorage();
    } catch {
      /* best-effort: failure here is non-fatal */
    }
  }
  await db.app_settings.delete(restoreJournalKey(journal.backupId));
}

export async function buildBackup(): Promise<BackupFile> {
  // Capture all IndexedDB metadata in one readonly transaction. The actual
  // photo bytes are read after this snapshot, but their manifest is pinned to
  // this exact DB state and serializeBackupToSink re-checks size/hash before
  // publishing, so an expense edit during export cannot silently mix states.
  const snapshot = await db.transaction(
    "r",
    [...BACKUP_TABLES.map((t) => table(t)), db.receipts, db.receipt_hashes],
    async () => {
      const tables: BackupFile["tables"] = {};
      for (const t of BACKUP_TABLES)
        tables[t] = (await table(t).toArray()) as Record<string, unknown>[];
      const receiptRows: { path: string; size: number; created_at: string }[] =
        (await db.receipts.toArray()).map((r) => ({
          path: String(r.path),
          size: r.size ?? r.blob?.size ?? 0,
          created_at: String(r.created_at),
        }));
      const receiptHashes = await db.receipt_hashes.toArray();
      return { tables, receiptRows, receiptHashes };
    },
  );
  const tables = snapshot.tables;
  // Internal migration/restore markers are process metadata, not portable
  // business settings. Never export them and never let an imported backup
  // recreate them on another device.
  if (tables["app_settings"]) {
    tables["app_settings"] = tables["app_settings"].filter((row) => {
      const key = String(row["key"] ?? "");
      return !key.startsWith("__migration_") && !key.startsWith("__telegram_");
    });
  }
  const hashesByPath = new Map(
    snapshot.receiptHashes.map((h) => [h.path, h.sha256]),
  );
  const receiptRowsByPath = new Map(
    snapshot.receiptRows.map((r) => [r.path, r]),
  );
  const referencedPaths = new Set<string>();
  for (const row of tables["expenses"] ?? []) {
    const path =
      typeof row["receipt_path"] === "string" ? row["receipt_path"] : "";
    if (!path) continue;
    if (!isSafeReceiptPath(path))
      throw new Error(
        `Invalid receipt path in expense ${String(row["id"] ?? "unknown")}: ${path}`,
      );
    referencedPaths.add(path);
  }
  for (const row of tables["investments"] ?? []) {
    const path =
      typeof row["receipt_path"] === "string" ? row["receipt_path"] : "";
    if (!path) continue;
    if (!isSafeReceiptPath(path))
      throw new Error(
        `Invalid receipt path in investment ${String(row["id"] ?? "unknown")}: ${path}`,
      );
    referencedPaths.add(path);
  }
  // Bills may also own receipt photos. Keep the export manifest strictly
  // reference-driven: an orphan `db.receipts` row is never exported as if it
  // were user data. Pending form uploads are intentionally not backup data
  // until a business row claims the path.
  for (const row of tables["bills"] ?? []) {
    const path =
      typeof row["receipt_path"] === "string" ? row["receipt_path"] : "";
    if (!path) continue;
    if (!isSafeReceiptPath(path))
      throw new Error(
        `Invalid receipt path in bill ${String(row["id"] ?? "unknown")}: ${path}`,
      );
    referencedPaths.add(path);
  }

  const photoManifest: PhotoManifestEntry[] = [];
  const warnings: string[] = [];
  const unavailablePhotos = new Set<string>();
  for (const path of referencedPaths) {
    const row = receiptRowsByPath.get(path);
    let size = row?.size ?? 0;
    let sha256 = hashesByPath.get(path);
    try {
      const bytes = await readStoredReceiptBytes(path);
      const actualHash = await sha256Hex(bytes);
      if (sha256 && sha256.toLowerCase() !== actualHash.toLowerCase()) {
        unavailablePhotos.add(path);
        warnings.push(`Receipt photo is corrupt or changed at rest: ${path}`);
        continue;
      }
      if (!size || size !== bytes.length || !sha256) {
        size = bytes.length;
        sha256 = actualHash;
      }
      photoManifest.push({
        path,
        sha256,
        size,
        created_at: row?.created_at ?? new Date().toISOString(),
      });
    } catch (e) {
      unavailablePhotos.add(path);
      warnings.push(`Receipt photo is missing or unreadable: ${path}`);
    }
  }
  // A single broken receipt must not make the entire business backup unusable.
  // Remove only the broken reference from the exported copy and make the
  // omission explicit in the backup envelope. The live database is untouched.
  if (unavailablePhotos.size) {
    for (const row of tables["expenses"] ?? []) {
      if (
        typeof row["receipt_path"] === "string" &&
        unavailablePhotos.has(row["receipt_path"])
      )
        row["receipt_path"] = null;
    }
    for (const row of tables["investments"] ?? []) {
      if (
        typeof row["receipt_path"] === "string" &&
        unavailablePhotos.has(row["receipt_path"])
      )
        row["receipt_path"] = null;
    }
    for (const row of tables["bills"] ?? []) {
      if (
        typeof row["receipt_path"] === "string" &&
        unavailablePhotos.has(row["receipt_path"])
      )
        row["receipt_path"] = null;
    }
  }
  const MAX_PHOTO_ENTRIES = 50_000;
  const MAX_PHOTO_BYTES = 8 * 1024 * 1024 * 1024;
  const totalPhotoBytes = photoManifest.reduce(
    (sum, entry) => sum + entry.size,
    0,
  );
  if (
    photoManifest.length > MAX_PHOTO_ENTRIES ||
    totalPhotoBytes > MAX_PHOTO_BYTES
  ) {
    throw new Error(
      `This backup contains ${photoManifest.length.toLocaleString()} receipt photos (${Math.round(totalPhotoBytes / (1024 * 1024))} MiB), which exceeds the safe restore limit of 50,000 photos / 8 GiB. Repair/archive photos or use Telegram sharded backup before exporting.`,
    );
  }
  const exportedPhotoPaths = new Set(photoManifest.map((entry) => entry.path));
  const receiptHashes = snapshot.receiptHashes.filter((hash) =>
    exportedPhotoPaths.has(hash.path),
  );
  const { theme, layout } = captureThemeLayout();
  const localSettings = Object.fromEntries(
    Object.entries(captureLocalSettings()).filter(
      ([key]) =>
        !key.startsWith("__migration_imported__:") &&
        !key.startsWith("__migration_restore__:") &&
        !key.startsWith("__telegram_restore__") &&
        !key.startsWith("__telegram_restore_snapshot__") &&
        !key.startsWith("ks:telegram-backup"),
    ),
  );
  return {
    backup_id: crypto.randomUUID(),
    schema_version: db.verno,
    app_version: import.meta.env?.["VITE_APP_VERSION"] ?? "r17",
    format: "turf-snack-ledger",
    version: 5,
    exported_at: new Date().toISOString(),
    tables,
    photo_manifest: photoManifest,
    receipt_hashes: receiptHashes,
    theme,
    layout,
    localSettings,
    partial: warnings.length > 0,
    warnings,
  };
}

export function backupFileName() {
  return `turf-ledger-${istTimestampKey()}.db`;
}

/**
 * Saves a backup to disk. In the browser/PWA this is a Blob + `<a download>`
 * click (fire-and-forget, no result). In the desktop shell it opens a native
 * Save dialog via `tauri-plugin-dialog` + `tauri-plugin-fs`; returns the path
 * the user chose, or `null` if they cancelled the dialog.
 *
 * Android is matched before the generic desktop branch and does NOT use that
 * Save dialog: `tauri-plugin-dialog`'s `save()` hands back a `content://`
 * URI on Android that `tauri-plugin-fs`'s `writeFile()` cannot write to — it
 * does not throw, it just silently produces a 0-byte file (see
 * `saveExportFile`'s doc comment in desktop.ts). That's a real correctness
 * risk here specifically, since `archiveYear` in archive.ts (which shares
 * this same dialog+fs pattern) deletes local rows once its own download
 * reports success — a silently-empty backup would mean deleted data with no
 * usable copy anywhere. Android instead writes through the bundled
 * `android-save` plugin straight into the public Downloads folder, with no
 * dialog and thus no "cancelled" outcome — just saved or not.
 *
 * The file this writes is encrypted (see `encryptFullBackupBytes` in
 * backup-crypto.ts) — this is the single-file `.db` export people are most
 * likely to copy to a USB drive, email, or drop in a shared cloud folder, so
 * it gets the same AES-256-GCM treatment the Telegram full backup and year
 * archive already had; there's no plaintext branch left. `encryptFullBackupBytes`
 * throws a clear, actionable error if no backup passphrase has been set yet
 * (Settings → Backup encryption) rather than silently falling back to
 * plaintext.
 *
 * Kept async (the browser branch always did the work synchronously, so
 * existing unawaited call sites keep working unchanged) so BackupCard/
 * ArchiveCard can `await` it to know whether a desktop save was cancelled
 * (or an Android save failed).
 */
/**
 * Serializes a backup for download. Version 1/2 keep their plain-JSON form.
 * Version 3 (R4) becomes a zip container — `backup.json` (tables + photo
 * manifest, tiny) plus each photo at `photos/<path>` — built with
 * `streamFiles` + STORE so peak memory stays one photo regardless of how
 * many receipts exist; the previous version-2 form put every photo's
 * base64 into ONE giant JSON string, which could not be built at all for
 * tens of thousands of receipts.
 */
/**
 * Streams a backup to `sink`. Version 1/2 write their plain JSON; version 3
 * (R4/R7) writes a STORE zip — `backup.json` first, then each photo at
 * `photos/<path>` in manifest order — via the bounded-memory streaming
 * writer: one photo is live at a time regardless of archive size. This is
 * the production path for desktop exports (file sink) and the basis of
 * `serializeBackupBytes`.
 */
export async function serializeBackupToSink(
  backup: BackupFile,
  sink: { write(bytes: Uint8Array): Promise<void> },
): Promise<number> {
  if (backup.version < 3) {
    const json = new TextEncoder().encode(JSON.stringify(backup));
    await sink.write(json);
    return json.length;
  }
  async function* entries(): AsyncIterable<ZipEntry> {
    yield {
      name: "backup.json",
      bytes: new TextEncoder().encode(JSON.stringify(backup)),
    };
    for (const entry of backup.photo_manifest ?? []) {
      const bytes = await readStoredReceiptBytes(entry.path);
      if (
        bytes.length !== entry.size ||
        (await sha256Hex(bytes)).toLowerCase() !== entry.sha256.toLowerCase()
      )
        throw new Error(
          `Receipt photo "${entry.path}" is corrupt or changed at rest — export aborted. Re-run backup after repairing the receipt.`,
        );
      yield { name: `photos/${entry.path}`, bytes };
    }
  }
  return writeStoreZip(entries(), sink);
}

export async function serializeBackupBytes(
  backup: BackupFile,
): Promise<Uint8Array> {
  // Materializing form (web downloads, tests): same container as the
  // streaming path, collected into one array by the sink.
  const sink = memoryZipSink();
  await serializeBackupToSink(backup, sink);
  return sink.bytes();
}

/**
 * R7 desktop export: streams a v3 backup to `<AppDocs>/TurfApp/Exports/<name>`
 * (chunked-AEAD encrypted) without materializing the container. Passphrase
 * is supplied explicitly so tests can exercise the full branch; the UI
 * path obtains it from secure storage via `downloadBackup`.
 */
export async function streamBackupToDisk(
  backup: BackupFile,
  name: string,
  passphrase: string,
): Promise<string> {
  const {
    appendToAppDocument,
    appDocumentExists,
    removeAppDocument,
    moveAppDocument,
  } = await import("./desktop");
  const { createChunkedEncryptor } = await import("./backup-crypto");
  const outPath = `Exports/${name}`;
  const tempPath = `Exports/.${name}.${Date.now()}.partial`;
  const previousPath = `Exports/.${name}.${Date.now()}.previous`;
  if (await appDocumentExists(tempPath)) await removeAppDocument(tempPath);
  if (await appDocumentExists(previousPath))
    await removeAppDocument(previousPath);
  let movedPrevious = false;
  try {
    const enc = await createChunkedEncryptor(passphrase, {
      write: (chunk) => appendToAppDocument(tempPath, chunk),
    });
    await serializeBackupToSink(backup, { write: (chunk) => enc.write(chunk) });
    await enc.finish();
    // Never delete a known-good export before the new file is complete.
    if (await appDocumentExists(outPath)) {
      await moveAppDocument(outPath, previousPath);
      movedPrevious = true;
    }
    try {
      await moveAppDocument(tempPath, outPath);
    } catch (publishError) {
      if (movedPrevious) {
        try {
          await moveAppDocument(previousPath, outPath);
        } catch {
          /* best-effort: failure here is non-fatal */
        }
      }
      throw publishError;
    }
    if (movedPrevious) await removeAppDocument(previousPath);
    return outPath;
  } catch (e) {
    try {
      await removeAppDocument(tempPath);
    } catch {
      /* best-effort: failure here is non-fatal */
    }
    throw e;
  }
}

export async function downloadBackup(
  backup: BackupFile,
  name = backupFileName(),
): Promise<string | null> {
  if (isDesktop() && !isAndroid() && backup.version >= 3) {
    // R7: stream the v3 container straight to disk - zip writer -> chunked
    // AEAD -> append sink. The container (GBs at 30k photos) is never
    // materialized in memory. Web keeps the bytes path below (browser
    // downloads buffer anyway).
    const { readBackupPassphrase } = await import("./backup-passphrase");
    const passphrase = await readBackupPassphrase();
    if (!passphrase) {
      const { NoPassphraseSetError } = await import("./backup-crypto");
      throw new NoPassphraseSetError();
    }
    return streamBackupToDisk(backup, name, passphrase);
  }
  if (isAndroid() && backup.version >= 3) {
    const { readBackupPassphrase } = await import("./backup-passphrase");
    const { createChunkedEncryptor } = await import("./backup-crypto");
    const passphrase = await readBackupPassphrase();
    if (!passphrase) {
      const { NoPassphraseSetError } = await import("./backup-crypto");
      throw new NoPassphraseSetError();
    }
    const out = await beginAndroidExportStream(
      name,
      "application/octet-stream",
    );
    try {
      const enc = await createChunkedEncryptor(passphrase, {
        write: out.write,
      });
      await serializeBackupToSink(backup, {
        write: (chunk) => enc.write(chunk),
      });
      await enc.finish();
      const result = await out.finish();
      if (!result.saved)
        throw new Error(
          `Couldn't save the backup: ${result.error ?? "unknown reason"}`,
        );
      return result.path ?? name;
    } catch (e) {
      await out.abort();
      throw e;
    }
  }
  const bytes = await encryptFullBackupBytes(
    await serializeBackupBytes(backup),
  );

  if (isAndroid()) {
    const result = await saveExportFile(
      bytes,
      name,
      "application/octet-stream",
    );
    if (!result.saved)
      throw new Error(
        `Couldn't save the backup: ${result.error ?? "unknown reason"}`,
      );
    return result.path ?? name;
  }

  if (isDesktop()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: name,
      filters: [{ name: "Ledger backup", extensions: ["db", "json"] }],
    });
    if (!path) return null; // user cancelled — caller should not claim success
    await writeFile(path, bytes);
    return path;
  }

  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

/**
 * Opens a native file-open dialog and reads the chosen backup's raw bytes.
 * Desktop-only — the browser build keeps using the `<input type="file">`
 * element already in BackupCard.tsx (`file.arrayBuffer()`), since a plain
 * `<input>` has no native-dialog equivalent to call from here. Returns
 * `null` if the user cancelled.
 *
 * Reads bytes, not text (`readFile`, not `readTextFile`) — since
 * `downloadBackup` started encrypting this file, its on-disk form is a
 * binary `TSLE` container, not UTF-8 JSON. `decodeBackupBytes` below turns
 * whatever comes back here into the JSON text `parseBackup` expects.
 */
export async function pickBackupFile(): Promise<Uint8Array | null> {
  const path = await pickBackupFilePath();
  if (!path) return null;
  const { readFile } = await import("@tauri-apps/plugin-fs");
  return readFile(path);
}

/** Native picker variant used by the bounded-memory restore path. */
export async function pickBackupFilePath(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    ...(isAndroid()
      ? {}
      : { filters: [{ name: "Ledger backup", extensions: ["db", "json"] }] }),
  });
  return !path || Array.isArray(path) ? null : path;
}

/**
 * Turns raw bytes read from a `.db` file (`pickBackupFile`, or a picked
 * `<input type="file">`) into the JSON text `parseBackup` expects.
 * Decrypts first if the bytes look like a `TSLE` container (see
 * `decryptFullBackupBytes`); older backups made before encryption was
 * added are plain UTF-8 JSON already and pass through unchanged, so they
 * keep restoring normally.
 *
 * `passphraseOverride` is forwarded to `decryptFullBackupBytes` as-is — see
 * its doc comment. `BackupCard` leaves this unset for the first attempt
 * (stored device passphrase) and only supplies one after that attempt
 * throws `WrongPassphraseError`/`NoPassphraseSetError` and the person types
 * one in, for a file made under a different passphrase (a year archive or
 * `.db` from another device, or from before this device's passphrase was
 * last changed).
 */
/**
 * Holds the photo zip of the most recent v3 container decoded by
 * `decodeBackupBytes`, consumed by `restoreBackup`. The UI decodes and
 * restores one file at a time, so single-flight is sufficient — this
 * exists so `BackupCard`'s existing flow (decode → parse → restore) needs
 * no signature changes for the container format.
 */
type PendingPhotoSource = {
  read(path: string): Promise<Uint8Array>;
  cleanup(): Promise<void>;
};
let pendingPhotoZip: PendingPhotoSource | null = null;
/**
 * A decoded backup may be parsed into a BackupFile and then sit in the
 * confirmation UI while another file is decoded. Keep the photo source tied
 * to that exact BackupFile instead of relying on one process-global slot.
 */
const photoSourceByBackup = new WeakMap<object, PendingPhotoSource>();
const activePhotoSources = new Set<PendingPhotoSource>();

/** Test hook: drop any stashed container. */
export function clearPendingPhotoZip(): void {
  const source = pendingPhotoZip;
  pendingPhotoZip = null;
  if (source && !activePhotoSources.has(source))
    void source.cleanup().catch(() => {});
}

export const LEGACY_BACKUP_MAX_BYTES = 64 * 1024 * 1024;

export async function decodeBackupBytes(
  bytes: Uint8Array,
  passphraseOverride?: string,
): Promise<string> {
  const isZipContainer =
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;
  if (
    bytes.byteLength > LEGACY_BACKUP_MAX_BYTES &&
    !(
      bytes[0] === 0x54 &&
      bytes[1] === 0x53 &&
      bytes[2] === 0x4c &&
      bytes[3] === 0x45
    ) &&
    !isZipContainer
  )
    throw new Error(
      "This legacy backup is larger than 64 MiB and uses the pre-R7 single-shot format. It cannot be streamed safely by this build; restore it with the original/older build that created it, then create a new R17 backup.",
    );
  if (bytes.byteLength > 0xffffffff)
    throw new Error(
      "Backup exceeds the supported ZIP32/container size limit; use sharded backup.",
    );
  const plain = await decryptFullBackupBytes(bytes, passphraseOverride);
  if (
    plain[0] === 0x50 &&
    plain[1] === 0x4b &&
    plain[2] === 3 &&
    plain[3] === 4
  ) {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(plain);
    const jsonEntry = zip.files["backup.json"];
    if (!jsonEntry || jsonEntry.dir)
      throw new Error("Not a valid ledger backup file");
    const old = pendingPhotoZip;
    pendingPhotoZip = {
      async read(path) {
        const entry = zip.files[`photos/${path}`];
        if (!entry)
          throw new Error(
            `Receipt photo "${path}" is missing from the backup.`,
          );
        return entry.async("uint8array");
      },
      async cleanup() {
        /* The previous source belongs to another decode/restore session. */
      },
    };
    if (old && !activePhotoSources.has(old)) void old.cleanup().catch(() => {});
    return jsonEntry.async("string");
  }
  pendingPhotoZip = null;
  return new TextDecoder().decode(plain);
}

/**
 * Native/desktop restore path. The selected file is opened as a Tauri
 * FileHandle and decrypted as a stream. Version-3 ZIP entries are extracted
 * one at a time into app-private temporary files; the encrypted container and
 * complete plaintext ZIP are never materialized in JavaScript memory.
 */
export async function decodeBackupFile(
  path: string,
  passphraseOverride?: string,
): Promise<string> {
  // Android document pickers commonly return content:// URIs. Some Tauri FS
  // versions cannot seek/open those URIs even though readFile() can resolve
  // them through the platform content resolver. Prefer the streaming handle,
  // but use a bounded legacy fallback when the URI cannot be opened.
  if (isAndroid() && /^content:\/\//i.test(path)) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // The system picker owns the content:// URI. Copy it natively in chunks
      // into app-private storage, then hand the resulting normal path to the
      // existing streaming decryptor. This avoids materialising a large
      // encrypted backup + plaintext ZIP in the WebView heap.
      const { path: privatePath } = await invoke<{ path: string }>(
        "plugin:android-save|copy_uri_to_private_file",
        {
          payload: { uri: path, fileName: `restore-${Date.now()}.db` },
        },
      );
      try {
        return await decodeBackupFile(privatePath, passphraseOverride);
      } finally {
        await invoke("plugin:android-save|delete_private_file", {
          payload: { path: privatePath },
        }).catch(() => {});
      }
    } catch (e) {
      throw new Error(
        `Android could not read the selected backup document: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const { open } = await import("@tauri-apps/plugin-fs");
  const { SeekMode } = await import("@tauri-apps/plugin-fs");
  const file = await open(path, { read: true });
  try {
    const first = new Uint8Array(5);
    let got = 0;
    while (got < first.length) {
      const n = await file.read(first.subarray(got));
      if (n == null || n === 0) break;
      got += n;
    }
    await file.seek(0, SeekMode.Start);
    const isChunked =
      got >= 5 &&
      first[0] === 0x54 &&
      first[1] === 0x53 &&
      first[2] === 0x4c &&
      first[3] === 0x45 &&
      (first[4] === 2 || first[4] === 3);
    if (!isChunked) {
      // Legacy v1/v2 backups are JSON and require whole-file parsing. Refuse
      // oversized legacy input before allocating it so a large historical
      // photo backup cannot take down a low-memory Android/WebView process.
      const stat = await file.stat();
      if (typeof stat.size === "number" && stat.size > LEGACY_BACKUP_MAX_BYTES)
        throw new Error(
          "This legacy backup is larger than 64 MiB and uses the pre-R7 single-shot format. It cannot be streamed safely by this build; restore it with the original/older build that created it, then create a new R17 backup.",
        );
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(path);
      return decodeBackupBytes(bytes, passphraseOverride);
    }
    const source = {
      async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
        const buf = new Uint8Array(1024 * 1024);
        for (;;) {
          const n = await file.read(buf);
          if (n == null || n === 0) return;
          yield buf.slice(0, n);
        }
      },
    };
    const { decryptChunkedStream } = await import("./backup-crypto");
    const tempDir = `Exports/.restore-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempFiles = new Set<string>();
    const stagedPhotos = new Map<string, string>();
    let extractedPhotoBytes = 0;
    let photoEntryCount = 0;
    const MAX_PHOTO_ENTRIES = 50_000;
    const MAX_EXTRACTED_PHOTO_BYTES = 8 * 1024 * 1024 * 1024;
    let json = "";
    try {
      for await (const entry of readStoreZipStream(
        decryptChunkedStream(source, passphraseOverride),
      )) {
        if (entry.name === "backup.json") {
          if (json)
            throw new Error("Backup contains duplicate backup.json entries");
          json = new TextDecoder().decode(entry.bytes);
          continue;
        }
        if (entry.name.startsWith("photos/") && entry.name.length > 7) {
          const photoPath = entry.name.slice(7);
          if (!isSafeReceiptPath(photoPath))
            throw new Error(
              `Backup contains an unsafe receipt path: ${photoPath}`,
            );
          if (stagedPhotos.has(photoPath))
            throw new Error(
              `Backup contains duplicate receipt photo: ${photoPath}`,
            );
          photoEntryCount++;
          extractedPhotoBytes += entry.bytes.length;
          if (
            photoEntryCount > MAX_PHOTO_ENTRIES ||
            extractedPhotoBytes > MAX_EXTRACTED_PHOTO_BYTES
          )
            throw new Error(
              "Backup contains too many or too many bytes of receipt photos",
            );
          // Never materialize an attacker-controlled archive name under the
          // restore directory. Stage each entry under an opaque filename; the
          // manifest is validated later and only then exposes the logical path.
          const tempPath = `${tempDir}/photo-${photoEntryCount}.bin`;
          await saveToAppDocuments(tempPath, entry.bytes);
          tempFiles.add(tempPath);
          stagedPhotos.set(photoPath, tempPath);
        }
      }
    } catch (e) {
      for (const p of tempFiles) {
        try {
          await removeAppDocument(p);
        } catch {
          /* best-effort: failure here is non-fatal */
        }
      }
      throw e;
    }
    if (!json) {
      for (const p of tempFiles) {
        try {
          await removeAppDocument(p);
        } catch {
          /* best-effort: failure here is non-fatal */
        }
      }
      throw new Error("Not a valid ledger backup file");
    }
    const previous = pendingPhotoZip;
    pendingPhotoZip = {
      async read(photoPath) {
        const tempPath = stagedPhotos.get(photoPath);
        if (!tempPath)
          throw new Error(
            `Receipt photo "${photoPath}" is missing from the backup.`,
          );
        const { readAppDocument } = await import("./desktop");
        return readAppDocument(tempPath);
      },
      async cleanup() {
        for (const p of tempFiles) {
          try {
            await removeAppDocument(p);
          } catch {
            /* best-effort: failure here is non-fatal */
          }
        }
        /* Do not clean a previous source here: it may belong to an
         * already-running restore. That restore owns its source session. */
      },
    };
    if (previous && !activePhotoSources.has(previous))
      void previous.cleanup().catch(() => {});
    return json;
  } finally {
    await file.close();
  }
}

export function parseBackup(text: string): BackupFile {
  const parsed = JSON.parse(text) as BackupFile;
  if (pendingPhotoZip) photoSourceByBackup.set(parsed, pendingPhotoZip);
  if (parsed?.format !== "turf-snack-ledger" || !parsed.tables)
    throw new Error("Not a valid ledger backup file");
  if (
    parsed.version !== 1 &&
    parsed.version !== 2 &&
    parsed.version !== 3 &&
    parsed.version !== 4 &&
    parsed.version !== 5
  )
    throw new Error("Unsupported ledger backup version");
  if (
    parsed.schema_version != null &&
    (!Number.isSafeInteger(parsed.schema_version) || parsed.schema_version < 1)
  )
    throw new Error("Backup has an invalid schema version");
  validateBackupTablesEnvelope(parsed.tables);
  if (parsed.version >= 3) {
    if (!Array.isArray(parsed.photo_manifest))
      throw new Error("Version-3 backup has no photo manifest");
    const seenPhotoPaths = new Set<string>();
    for (const entry of parsed.photo_manifest) {
      if (
        !entry ||
        typeof entry.path !== "string" ||
        !entry.path ||
        !isSafeReceiptPath(entry.path) ||
        entry.path.startsWith("/") ||
        entry.path.startsWith("\\") ||
        /^[A-Za-z]:[\\/]/.test(entry.path) ||
        entry.path.split(/[\\/]/).includes("..") ||
        seenPhotoPaths.has(entry.path.normalize("NFC").toLowerCase()) ||
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(entry.sha256) ||
        typeof entry.size !== "number" ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      )
        throw new Error("Version-3 backup has a corrupted photo manifest");
      seenPhotoPaths.add(entry.path.normalize("NFC").toLowerCase());
    }
  }
  return parsed;
}

export function backupSummary(backup: BackupFile) {
  const base = BACKUP_TABLES.map(
    (t) => `${t}: ${backup.tables[t]?.length ?? 0}`,
  ).join(" · ");
  const photoCount =
    backup.version >= 3
      ? (backup.photo_manifest?.length ?? 0)
      : (backup.photos?.length ?? 0);
  return photoCount > 0 ? `${base} · photos: ${photoCount}` : base;
}

/**
 * Read-only "what will actually happen" preview for the confirmation dialog
 * in front of a restore — plan item: "Preview a restore before applying it.
 * Show what will be added, replaced, or skipped." Mirrors `restoreBackup`'s
 * own per-table logic exactly (same primary-key dedup for merge, same
 * clear-then-write for replace) but never writes anything, so it's safe to
 * call before the person has committed to anything.
 *
 * Doesn't re-run `findInvalidRows`/etc — `restoreBackup` still does that
 * validation immediately before it writes, so a corrupted file still can't
 * reach local data; it just means a corrupted file's preview numbers are
 * shown before that check runs, same as any other read of the file's raw
 * contents.
 */
export type RestorePreviewRow =
  | {
      table: BackupTable;
      mode: "merge";
      added: number;
      alreadyPresent: number;
      differing: number;
    }
  | {
      table: BackupTable;
      mode: "replace";
      willAdd: number;
      willRemove: number;
    };

export type RestorePreview = {
  mode: "replace" | "merge";
  perTable: RestorePreviewRow[];
  /** Rows from the backup that will end up in the local database. */
  totalAdded: number;
  /** merge: rows already present locally, left untouched. replace: rows
   *  currently on this device that get deleted before the backup is written. */
  totalUnchangedOrRemoved: number;
  photoCount: number;
};

export async function previewRestore(
  backup: BackupFile,
  mode: "replace" | "merge",
): Promise<RestorePreview> {
  const perTable: RestorePreviewRow[] = [];
  let totalAdded = 0;
  let totalUnchangedOrRemoved = 0;

  for (const t of BACKUP_TABLES) {
    const rows = (backup.tables[t] ?? []) as Row[];
    if (mode === "merge") {
      const target = table(t);
      const primKey = target.schema.primKey.name as string;
      const existingIds = new Set(
        await target
          .toCollection()
          .primaryKeys()
          .then((keys) => keys.map(String)),
      );
      const localRows = await target.toArray();
      const localById = new Map(
        localRows.map((r) => [String((r as Row)[primKey]), r as Row]),
      );
      const added = rows.filter(
        (r) => !existingIds.has(String(r[primKey])),
      ).length;
      const alreadyPresent = rows.length - added;
      const differing = rows.filter((r) => {
        const local = localById.get(String(r[primKey]));
        return !!local && stableStringify(local) !== stableStringify(r);
      }).length;
      perTable.push({
        table: t,
        mode: "merge",
        added,
        alreadyPresent,
        differing,
      });
      totalAdded += added;
      totalUnchangedOrRemoved += alreadyPresent;
    } else {
      const willRemove = await table(t).count();
      perTable.push({
        table: t,
        mode: "replace",
        willAdd: rows.length,
        willRemove,
      });
      totalAdded += rows.length;
      totalUnchangedOrRemoved += willRemove;
    }
  }

  return {
    mode,
    perTable,
    totalAdded,
    totalUnchangedOrRemoved,
    photoCount:
      backup.version >= 3
        ? (backup.photo_manifest?.length ?? 0)
        : (backup.photos?.length ?? 0),
  };
}

/**
 * Cross-checks each photo's actual bytes against its capture-time
 * `receipt_hashes` entry, when one exists. A `.db` backup has no separate
 * checksum manifest the way a Telegram full-backup zip does (see
 * `findInvalidReceiptHashRows`'s use in `restoreFullBackup`) — its receipt
 * hashes travel alongside the photos in the same JSON, which is why this
 * checks photo bytes against `receipt_hashes` directly rather than reusing
 * that zip-manifest flow. A path with no matching hash row is
 * "unverifiable", not corrupt (see the `receipt_hashes` store's own doc
 * comment in localdb.ts) — most backups taken before this field existed
 * will have none at all, and that's expected, not a problem to report.
 */
async function findHashMismatchedPhotos(
  photos: BackupPhoto[],
  hashes: ReceiptHashRow[],
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const byPath = new Map(hashes.map((h) => [h.path, h.sha256]));
  const mismatched: string[] = [];
  for (const photo of photos) {
    const expected = byPath.get(photo.path);
    if (!expected) continue; // no captured hash for this path — unverifiable, not corrupt
    const actual = await sha256Hex(base64ToBytes(photo.data));
    if (actual !== expected) mismatched.push(photo.path);
  }
  return mismatched;
}

/**
 * Restores a snapshot. `mode: "replace"` wipes current rows first;
 * `mode: "merge"` keeps existing rows and adds only the ones missing.
 * Returns the number of table rows inserted — photos and receipt hashes
 * are restored too (see the loops below), but aren't counted in this
 * return value.
 */
async function validateReferentialIntegrity(
  tables: Record<string, Row[]>,
  backup: BackupFile,
  mode: "replace" | "merge",
  restoreOptions: InternalRestoreOptions = {},
) {
  const ids = new Map<string, Set<string>>();
  for (const t of BACKUP_TABLES) {
    const set = new Set<string>();
    for (const row of tables[t] ?? [])
      if (row && row["id"] != null) set.add(String(row["id"]));
    if (mode === "merge" && t !== "app_settings") {
      const existing = await table(t).toCollection().primaryKeys();
      for (const id of existing) set.add(String(id));
    }
    ids.set(t, set);
  }

  const errors: string[] = [];
  const requireRef = (
    tableName: string,
    index: number,
    field: string,
    value: unknown,
    target: DataTable,
  ) => {
    if (value == null || value === "") return;
    if (!ids.get(target)?.has(String(value))) {
      errors.push(
        `${tableName}[${index}].${field} references missing ${target} record "${String(value)}"`,
      );
    }
  };

  const incomingPhotos = new Set<string>([
    ...(backup.photo_manifest ?? []).map((p) => p.path),
    ...(backup.photos ?? []).map((p) => p.path),
  ]);
  const referencedIncomingPhotos = new Set<string>();
  for (const tableName of ["expenses", "investments", "bills"] as const) {
    for (const row of tables[tableName] ?? []) {
      if (typeof row["receipt_path"] === "string" && row["receipt_path"]) {
        referencedIncomingPhotos.add(row["receipt_path"]);
      }
    }
    // In merge mode, a colliding row is deliberately omitted from
    // mergeTables. Its receipt photo is still a valid reference to the local
    // row, so it must not be treated as an orphan manifest entry.
    if (mode === "merge") {
      const existingRows = (await table(tableName)
        .toCollection()
        .toArray()) as Row[];
      for (const row of existingRows) {
        if (typeof row["receipt_path"] === "string" && row["receipt_path"]) {
          referencedIncomingPhotos.add(row["receipt_path"]);
        }
      }
    }
  }
  // Version-3 manifests are reference-driven and must not carry standalone
  // files. Legacy v1/v2 backups legitimately carried standalone imported
  // photos, so preserve those files during migration.
  if (backup.version >= 3) {
    for (const path of incomingPhotos) {
      if (!referencedIncomingPhotos.has(path)) {
        errors.push(
          `receipt photo "${path}" has no referencing expense, investment, or bill row`,
        );
      }
    }
  }

  for (const [tableName, rows] of Object.entries(tables)) {
    rows.forEach((row, index) => {
      // Historical stock/sale rows intentionally outlive some source records;
      // those references are audit history, not strict foreign keys.
      if (tableName === "tab_entries") {
        requireRef(tableName, index, "tab_id", row["tab_id"], "customer_tabs");

        // Every populated tab-entry reference is a real foreign-key-like link.
        // merge_reverse uses ref_id for the destination bill and source_ref_id
        // for the original turf booking/snack sale. Reject unknown types rather
        // than silently accepting an uncheckable/dangling reference.
        const refTargets: Record<string, DataTable> = {
          bill: "bills",
          turf_booking: "turf_bookings",
          snack_sale: "snack_sales",
          merge_reverse: "bills",
        };
        const refType =
          row["ref_type"] == null || row["ref_type"] === ""
            ? null
            : String(row["ref_type"]);
        const refId =
          row["ref_id"] == null || row["ref_id"] === ""
            ? null
            : String(row["ref_id"]);
        if (refType === null && refId !== null) {
          errors.push(
            `${tableName}[${index}].ref_id is populated but ref_type is missing`,
          );
        } else if (refType !== null) {
          const target = refTargets[refType];
          if (!target)
            errors.push(
              `${tableName}[${index}].ref_type has invalid value "${refType}"`,
            );
          else if (refId === null)
            errors.push(
              `${tableName}[${index}].ref_id is missing for ref_type "${refType}"`,
            );
          else requireRef(tableName, index, "ref_id", refId, target);
        }

        const sourceType =
          row["source_ref_type"] == null || row["source_ref_type"] === ""
            ? null
            : String(row["source_ref_type"]);
        const sourceId =
          row["source_ref_id"] == null || row["source_ref_id"] === ""
            ? null
            : String(row["source_ref_id"]);
        if (sourceType === null && sourceId !== null) {
          errors.push(
            `${tableName}[${index}].source_ref_id is populated but source_ref_type is missing`,
          );
        } else if (sourceType !== null) {
          const target =
            sourceType === "bill"
              ? "bills"
              : sourceType === "turf_booking"
                ? "turf_bookings"
                : sourceType === "snack_sale"
                  ? "snack_sales"
                  : null;
          if (!target)
            errors.push(
              `${tableName}[${index}].source_ref_type has invalid value "${sourceType}"`,
            );
          else if (sourceId === null)
            errors.push(
              `${tableName}[${index}].source_ref_id is missing for source_ref_type "${sourceType}"`,
            );
          else requireRef(tableName, index, "source_ref_id", sourceId, target);
        }
      }
      if (tableName === "payments") {
        const typ = String(row["parent_type"] ?? "");
        const target =
          typ === "bill"
            ? "bills"
            : typ === "turf_booking"
              ? "turf_bookings"
              : typ === "snack_sale"
                ? "snack_sales"
                : null;
        if (!target)
          errors.push(
            `${tableName}[${index}].parent_type has invalid value "${typ}"`,
          );
        else
          requireRef(tableName, index, "parent_id", row["parent_id"], target);
      }
      if (tableName === "snack_sales" || tableName === "turf_bookings")
        requireRef(
          tableName,
          index,
          "merged_into_bill_id",
          row["merged_into_bill_id"],
          "bills",
        );
      if (
        tableName === "bills" ||
        tableName === "turf_bookings" ||
        tableName === "snack_sales"
      )
        requireRef(
          tableName,
          index,
          "customer_id",
          row["customer_id"],
          "customers",
        );
      if (tableName === "teams")
        requireRef(
          tableName,
          index,
          "customer_id",
          row["customer_id"],
          "customers",
        );
      if (tableName === "team_players")
        requireRef(tableName, index, "team_id", row["team_id"], "teams");
      if (tableName === "calendar_events" && row["customer_id"])
        requireRef(
          tableName,
          index,
          "customer_id",
          row["customer_id"],
          "customers",
        );
      if (tableName === "calendar_event_exceptions")
        requireRef(
          tableName,
          index,
          "event_id",
          row["event_id"],
          "calendar_events",
        );
      if (
        (tableName === "expenses" ||
          tableName === "investments" ||
          tableName === "bills") &&
        row["receipt_path"]
      ) {
        const path = String(row["receipt_path"]);
        // Telegram sharded restore validates all photo shards before calling
        // restoreBackup(), then materializes those photos in a second phase.
        // Its internal preserveReceiptsDuringRestore flag therefore means the
        // receipt reference is validated by the sharded preflight, not against
        // this temporary empty photo manifest. This applies to both replace
        // and merge, because a merge may introduce a brand-new receipt path.
        if (!restoreOptions.preserveReceiptsDuringRestore) {
          if (mode === "replace") {
            if (!incomingPhotos.has(path))
              errors.push(
                `${tableName}[${index}].receipt_path references missing receipt photo "${path}"`,
              );
          }
        }
      }
    });
  }

  // Resolve merge-only local receipt checks deterministically before returning.
  // The Telegram sharded path defers photo materialization, so its internal
  // preserveReceiptsDuringRestore boundary skips this temporary check; the
  // shard preflight has already validated every incoming photo.
  if (mode === "merge" && !restoreOptions.preserveReceiptsDuringRestore) {
    for (const [tableName, rows] of Object.entries(tables)) {
      if (
        tableName !== "expenses" &&
        tableName !== "investments" &&
        tableName !== "bills"
      )
        continue;
      for (const [index, row] of rows.entries()) {
        if (!row["receipt_path"]) continue;
        const path = String(row["receipt_path"]);
        if (incomingPhotos.has(path)) continue;
        if (!(await db.receipts.get(path)))
          errors.push(
            `${tableName}[${index}].receipt_path references missing receipt photo "${path}"`,
          );
      }
    }
  }

  if (errors.length) {
    const shown = errors.slice(0, 20).join("; ");
    throw new Error(
      `Backup referential integrity check failed (${errors.length} issue${errors.length === 1 ? "" : "s"}): ${shown}`,
    );
  }
}

export async function withMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (
    globalThis as {
      navigator?: {
        locks?: {
          request: <R>(
            name: string,
            options: { mode: "exclusive" },
            callback: () => Promise<R>,
          ) => Promise<R>;
        };
      };
    }
  ).navigator?.locks;
  if (locks?.request) {
    return locks.request(
      "truff-data-migration",
      { mode: "exclusive" },
      async () => fn(),
    );
  }
  // Some test/native WebViews do not expose navigator.locks. A boolean busy
  // flag is not enough there: concurrent replace restores would make the
  // second caller fail instead of serializing, leaving callers with an
  // avoidable race/error. Keep a tiny in-process FIFO fallback.
  const state = globalThis as unknown as {
    __truffMigrationTail?: Promise<void>;
  };
  const previous = state.__truffMigrationTail ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.__truffMigrationTail = current;
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (state.__truffMigrationTail === current)
      delete state.__truffMigrationTail;
  }
}

export async function restoreBackupImpl(
  backup: BackupFile,
  mode: "replace" | "merge" = "replace",
) {
  // Capture the photo source before schema normalisation. The source is bound
  // to this exact backup object, so concurrent restores cannot steal it.
  const restorePhotoSource = photoSourceByBackup.get(backup) ?? pendingPhotoZip;
  if (restorePhotoSource) activePhotoSources.add(restorePhotoSource);

  // Internal options are keyed by the ORIGINAL object; normalisation returns a
  // new object for schema < 5, so read them (and the legacy identity) first.
  const restoreOptions = getInternalRestoreOptions(backup);
  const rawBackupForIdentity = backup;
  backup = normalizeBackupForCurrentSchema(backup);
  // Merge restores are idempotent for the same backup file. A successful
  // merge records a tiny marker in app_settings; replace restores clear it as
  // part of the target replacement. This avoids duplicating business rows when
  // a user taps Import twice or retries the same file after a UI timeout.
  // Legacy backups predate backup_id. Derive a deterministic identity from the
  // exact parsed payload so repeated merge imports of the same legacy file are
  // idempotent even when a primary-key collision requires ID remapping.
  const backupId = backup.backup_id
    ? String(backup.backup_id)
    : `legacy-${await sha256Hex(new TextEncoder().encode(JSON.stringify(rawBackupForIdentity)))}`;
  let journal = backupId ? await readRestoreJournal(backupId) : null;
  if (
    journal &&
    isDesktop() &&
    journal.nativePhase === "files-promoted" &&
    !journal.metadataApplied
  ) {
    await recoverNativeRestoreJournal(journal);
    journal = null;
  }
  if (mode === "merge" && backupId) {
    const markerKey = `__migration_imported__:${backupId}`;
    const already = await db.app_settings.get(markerKey);
    // A completed journal is authoritative. An interrupted journal remains
    // resumable: never turn a crash into a duplicate merge.
    if (already && !journal) return 0;
  }

  // Validate every row BEFORE anything is cleared or written — a `mode:
  // "replace"` restore clears each table first, so a shape problem
  // discovered mid-transaction would leave the ledger emptier than before
  // the restore was attempted, not just unrestored. See backup-validate.ts.
  // Refuse backups produced by a newer DB schema. Older schema versions are
  // accepted because their optional fields can be absent and the current DB
  // upgrade path can fill defaults. A future schema must never be guessed at.
  if (
    backup.schema_version != null &&
    Number(backup.schema_version) > db.verno
  ) {
    throw new Error(
      `Backup schema ${backup.schema_version} is newer than this app schema ${db.verno}. Update the app before importing it.`,
    );
  }
  // A partial backup explicitly declares that one or more receipt bytes were
  // unavailable at capture time. It is never a safe source for a replace or
  // merge restore: restoring its ledger rows would silently detach receipts.
  // Fail before any destructive or durable mutation.
  if (backup.partial) {
    throw new Error(
      `This backup is marked partial${backup.warnings?.length ? `: ${backup.warnings.join("; ")}` : ""}. Complete the backup before restoring it.`,
    );
  }
  const rowProblems = findInvalidRows(backup.tables);
  if (rowProblems.length > 0) throw new Error(describeInvalidRows(rowProblems));

  const photoProblems = findInvalidPhotoRows(backup.photos ?? []);
  if (photoProblems.length > 0)
    throw new Error(
      `This backup has ${photoProblems.length} corrupted receipt photo record${
        photoProblems.length === 1 ? "" : "s"
      } — nothing was restored.`,
    );

  // A v3 manifest is a primary-keyed photo set just like the legacy photos[]
  // array. Reject duplicate paths before any restore work; otherwise two
  // entries for one path could verify different bytes and the last writer
  // would silently decide which image survives.
  const manifestSeen = new Set<string>();
  for (const [index, entry] of (backup.photo_manifest ?? []).entries()) {
    if (!isSafeReceiptPath(entry.path))
      throw new Error(
        `Backup contains an unsafe receipt path at photo_manifest[${index}]: ${entry.path}`,
      );
    const normalized = entry.path.normalize("NFC").toLowerCase();
    if (manifestSeen.has(normalized))
      throw new Error(
        `Backup contains duplicate receipt photo path "${entry.path}" — nothing was restored.`,
      );
    manifestSeen.add(normalized);
  }

  // R4 (version 3): every photo byte is verified against the manifest
  // BEFORE anything is cleared or written (same "nothing was restored"
  // invariant as the v2 hash check below). Entries are read one at a time
  // so peak memory is one photo. In merge mode a photo already stored is
  // never re-verified or overwritten — same rule as v2.
  const photoContainer = backup.version >= 3 ? restorePhotoSource : null;
  // Verify v3 photos without retaining their bytes. The browser fallback
  // reads one JSZip entry at a time; the native streaming path reads one
  // staged file at a time. The actual bytes are read again only after all
  // manifest checks pass, preserving the "nothing written on failure"
  // invariant without a multi-GB verifiedV3Photos map.
  const verifiedV3Paths: PhotoManifestEntry[] = [];
  const verifyV3Entry = async (
    entry: PhotoManifestEntry,
    source: typeof photoContainer,
  ) => {
    if (!source) {
      const bytes = await readStoredReceiptBytes(entry.path);
      if (
        bytes.length !== entry.size ||
        (await sha256Hex(bytes)).toLowerCase() !== entry.sha256.toLowerCase()
      )
        throw new Error(
          `Receipt photo "${entry.path}" failed its manifest checksum — nothing was restored.`,
        );
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await source.read(entry.path);
    } catch {
      throw new Error(
        `This backup is missing receipt photo "${entry.path}" — nothing was restored.`,
      );
    }
    if (bytes.length !== entry.size)
      throw new Error(
        `Receipt photo "${entry.path}" has the wrong size — nothing was restored.`,
      );
    if ((await sha256Hex(bytes)).toLowerCase() !== entry.sha256.toLowerCase())
      throw new Error(
        `Receipt photo "${entry.path}" failed its manifest checksum — nothing was restored.`,
      );
  };
  if (backup.version >= 3) {
    for (const entry of backup.photo_manifest ?? []) {
      if (!isSafeReceiptPath(entry.path))
        throw new Error(
          `Backup contains an unsafe receipt path: ${entry.path}`,
        );
      if (mode === "merge") {
        const exists = isDesktop()
          ? await appDocumentExists(entry.path)
          : (await db.receipts.get(entry.path)) != null;
        if (exists) {
          // A same-path receipt is safe to keep only when it is byte-for-byte
          // identical to the incoming manifest. Silently keeping a different
          // local file would attach the wrong/corrupt photo to the imported
          // expense. Fail closed so the user can resolve the conflict.
          let existingBytes: Uint8Array;
          try {
            existingBytes = isDesktop()
              ? await readAppDocument(entry.path)
              : await readStoredReceiptBytes(entry.path);
          } catch {
            throw new Error(
              `Existing receipt photo "${entry.path}" cannot be read safely during merge.`,
            );
          }
          if (
            existingBytes.length !== entry.size ||
            (await sha256Hex(existingBytes)).toLowerCase() !==
              entry.sha256.toLowerCase()
          ) {
            throw new Error(
              `Merge conflict: receipt photo "${entry.path}" already exists with different bytes — nothing was restored.`,
            );
          }
          continue;
        }
      }
      await verifyV3Entry(entry, photoContainer);
      verifiedV3Paths.push(entry);
    }
  }

  const receiptHashes = backup.receipt_hashes ?? [];
  const hashProblems = findInvalidReceiptHashRows(receiptHashes);
  if (hashProblems.length > 0)
    throw new Error(
      `This backup's receipt-hash records look corrupted (${hashProblems.length} bad row${
        hashProblems.length === 1 ? "" : "s"
      }) — nothing was restored.`,
    );

  // v3 stores photo bytes in photo_manifest and capture-time hashes in the
  // receipt_hashes table. Both representations must agree; otherwise a
  // corrupt/tampered hash row could survive restore even though the photo bytes
  // themselves pass the manifest checksum.
  if (backup.version >= 3 && receiptHashes.length > 0) {
    const manifestByPath = new Map(
      (backup.photo_manifest ?? []).map((p) => [p.path, p]),
    );
    const seenHashPaths = new Set<string>();
    for (const hash of receiptHashes) {
      if (seenHashPaths.has(hash.path))
        throw new Error(
          `This backup contains duplicate receipt-hash records for "${hash.path}" — nothing was restored.`,
        );
      seenHashPaths.add(hash.path);
      const manifest = manifestByPath.get(hash.path);
      if (
        !manifest ||
        manifest.sha256.toLowerCase() !== hash.sha256.toLowerCase()
      )
        throw new Error(
          `Receipt hash metadata does not match the v3 photo manifest for "${hash.path}" — nothing was restored.`,
        );
    }
  }

  const mismatchedPhotos = await findHashMismatchedPhotos(
    backup.photos ?? [],
    receiptHashes,
  );
  if (mismatchedPhotos.length > 0)
    throw new Error(
      `${mismatchedPhotos.length} receipt photo${
        mismatchedPhotos.length === 1 ? "" : "s"
      } failed the capture-time checksum check — nothing was restored.`,
    );

  // Legacy v1/v2 backups carried photo bytes inline. Unlike v3, those photos
  // did not have a manifest preflight, so a merge could previously keep a
  // same-path local photo even when its bytes differed from the imported
  // photo, silently attaching the wrong image to the imported expense.
  if (mode === "merge" && backup.version < 3) {
    for (const photo of backup.photos ?? []) {
      const exists = isDesktop()
        ? await appDocumentExists(photo.path)
        : (await db.receipts.get(photo.path)) != null;
      if (!exists) continue;
      let existingBytes: Uint8Array;
      try {
        existingBytes = isDesktop()
          ? await readAppDocument(photo.path)
          : await readStoredReceiptBytes(photo.path);
      } catch {
        throw new Error(
          `Existing receipt photo "${photo.path}" cannot be read safely during merge.`,
        );
      }
      const incomingBytes = base64ToBytes(photo.data);
      if (
        existingBytes.length !== incomingBytes.length ||
        (await sha256Hex(existingBytes)).toLowerCase() !==
          (await sha256Hex(incomingBytes)).toLowerCase()
      ) {
        throw new Error(
          `Merge conflict: receipt photo "${photo.path}" already exists with different bytes — nothing was restored.`,
        );
      }
    }
  }

  let inserted = 0;
  let activeJournal: RestoreJournal | null = journal;

  // Native shells keep receipt bytes on disk. Write them BEFORE touching
  // IndexedDB so a disk failure leaves the database exactly as it was
  // (all-or-nothing), and so a later database failure can remove just the
  // files this restore created. Pre-existing files are never deleted.
  const oldReceiptPaths: string[] =
    isDesktop() && mode === "replace"
      ? ((await db.receipts.toCollection().primaryKeys()) as string[])
      : [];
  // Mirror the durable journal into the local rollback sets. On resume these
  // must start with the already-recorded operations; otherwise a crash after
  // restart could cause the in-memory rollback path to forget what happened
  // before the restart.
  const diskCreated: string[] = [...(journal?.nativeCreated ?? [])];
  const diskBackups: { original: string; temp: string }[] = [
    ...(journal?.nativeBackups ?? []),
  ];
  const diskStaged: { final: string; temp: string }[] = [
    ...(journal?.nativeStaged ?? []),
  ];
  const diskItems: {
    final: string;
    state: "prepared" | "backed-up" | "deleted" | "promoted";
  }[] = [...(journal?.nativeItems ?? [])];
  const rollbackDisk = async () => {
    for (const path of diskCreated) {
      try {
        await removeAppDocument(path);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
    for (const pair of [...diskBackups].reverse()) {
      try {
        await removeAppDocument(pair.original);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
      try {
        await moveAppDocument(pair.temp, pair.original);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
    for (const item of diskStaged) {
      try {
        await removeAppDocument(item.temp);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
  };
  const finalizeDisk = async () => {
    for (const pair of diskBackups) {
      try {
        await removeAppDocument(pair.temp);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
    for (const item of diskStaged) {
      try {
        await removeAppDocument(item.temp);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
  };
  if (isDesktop()) {
    try {
      // Resume an interrupted native restore without discarding any durable
      // recovery information. A process kill can happen after any filesystem
      // boundary, so the existing journal is the source of truth for staged
      // files, backups, promoted targets, and completed browser photos. Never
      // replace those arrays with empty values when resuming the same backup.
      const session: RestoreJournal = journal
        ? {
            ...journal,
            backupId,
            mode,
            metadataApplied: journal.metadataApplied ?? false,
            completedPhotos: Array.isArray(journal.completedPhotos)
              ? [...journal.completedPhotos]
              : [],
            nativeCreated: Array.isArray(journal.nativeCreated)
              ? [...journal.nativeCreated]
              : [],
            nativeBackups: Array.isArray(journal.nativeBackups)
              ? [...journal.nativeBackups]
              : [],
            nativeStaged: Array.isArray(journal.nativeStaged)
              ? [...journal.nativeStaged]
              : [],
            nativeItems: Array.isArray(journal.nativeItems)
              ? [...journal.nativeItems]
              : [],
            localSettingsBefore:
              journal.localSettingsBefore ?? captureLocalSettings(),
            localSettingsAfter: journal.localSettingsAfter,
            nativePhase:
              journal.nativePhase === "promoting" ||
              journal.nativePhase === "files-promoted"
                ? journal.nativePhase
                : "staging",
            updatedAt: nowIso(),
          }
        : {
            backupId,
            mode,
            metadataApplied: false,
            completedPhotos: [],
            nativePhase: "staging",
            nativeCreated: [],
            nativeBackups: [],
            nativeStaged: [],
            nativeItems: [],
            localSettingsBefore: captureLocalSettings(),
            localSettingsAfter: backup.localSettings,
            updatedAt: nowIso(),
          };
      await writeRestoreJournal(session);
      activeJournal = session;
      const stageOne = async (path: string, bytes: Uint8Array) => {
        if (!isSafeReceiptPath(path))
          throw new Error(`Backup contains an unsafe receipt path: ${path}`);
        const existed = await appDocumentExists(path);
        if (mode === "merge" && existed) return;
        const temp = `Receipts/.restore-staging/${backupId}/${crypto.randomUUID()}.tmp`;
        // If a previous attempt already staged this exact target and the temp
        // file still exists, keep it and resume from that durable checkpoint.
        const prior = session.nativeStaged!.find((item) => item.final === path);
        if (prior) {
          if (await appDocumentExists(prior.temp)) return;
          if (
            session.nativeCreated!.includes(path) &&
            (await appDocumentExists(path))
          )
            return;
          // The old staged entry points at a missing temp and was never
          // promoted. Remove that stale checkpoint before restaging.
          session.nativeStaged = session.nativeStaged!.filter(
            (item) => item !== prior,
          );
          for (let i = diskStaged.length - 1; i >= 0; i--)
            if (
              diskStaged[i]?.final === path &&
              diskStaged[i]?.temp === prior.temp
            )
              diskStaged.splice(i, 1);
        }
        await saveToAppDocuments(temp, bytes);
        diskStaged.push({ final: path, temp });
        session.nativeStaged!.push({ final: path, temp });
        await writeRestoreJournal(session);
      };
      // Stage sequentially so a 30k-photo restore never accumulates the whole
      // backup in JS memory. The durable journal records every staged file.
      for (const photo of backup.photos ?? [])
        await stageOne(photo.path, base64ToBytes(photo.data));
      if (backup.version >= 3) {
        for (const entry of verifiedV3Paths) {
          const bytes = photoContainer
            ? await photoContainer.read(entry.path)
            : await readStoredReceiptBytes(entry.path);
          await stageOne(entry.path, bytes);
        }
      }
      // Publish the complete file set before the DB commit. The journal enters
      // the promoting phase before the first irreversible operation, then is
      // checkpointed after each backup/delete/move boundary. A process kill at
      // any point therefore leaves enough durable information to reconstruct
      // the pre-restore filesystem exactly.
      session.nativePhase = "promoting";
      await writeRestoreJournal(session);
      for (const item of diskStaged) {
        const targetExists = await appDocumentExists(item.final);
        const tempExists = await appDocumentExists(item.temp);
        let itemState = session.nativeItems!.find(
          (x) => x.final === item.final,
        );
        const setItemState = async (
          state: "prepared" | "backed-up" | "deleted" | "promoted",
        ) => {
          if (itemState) itemState.state = state;
          else {
            itemState = { final: item.final, state };
            session.nativeItems!.push(itemState);
            diskItems.push(itemState);
          }
          await writeRestoreJournal(session);
        };
        if (itemState?.state === "promoted" && !tempExists && targetExists)
          continue;
        if (itemState?.state === "deleted" && !tempExists && targetExists) {
          // Delete was durably recorded and the staged file is gone; therefore
          // a surviving target can only be the successful promotion whose final
          // checkpoint was interrupted. Do not delete it or recreate the backup.
          await setItemState("promoted");
          continue;
        }
        if (!itemState) await setItemState("prepared");
        const existed = targetExists;
        if (existed && mode === "replace") {
          let backup = session.nativeBackups!.find(
            (b) => b.original === item.final,
          );
          if (!backup) {
            const backupPath = `Receipts/.restore-rollback/${backupId}/${crypto.randomUUID()}.bak`;
            backup = { original: item.final, temp: backupPath };
            session.nativeBackups!.push(backup);
            diskBackups.push(backup);
            // WAL record: original identity is durable before backup creation.
            await writeRestoreJournal(session);
          }
          if (!(await appDocumentExists(backup.temp))) {
            const oldBytes = await readAppDocument(item.final);
            await saveToAppDocuments(backup.temp, oldBytes);
          }
          await setItemState("backed-up");
          if (await appDocumentExists(item.final)) {
            await removeAppDocument(item.final);
            await setItemState("deleted");
          }
        } else if (!existed) {
          // For a new target, durably record that the target is now expected
          // to be absent before the irreversible move. If the process dies
          // after the move but before the final checkpoint, recovery can
          // safely remove the incoming file without guessing whether an
          // original file existed.
          await setItemState("deleted");
        }
        if (await appDocumentExists(item.temp)) {
          await moveAppDocument(item.temp, item.final);
          // Record every successful promotion in both the in-memory rollback
          // set and the durable journal. A DB failure after promotion must not
          // leave an orphan receipt, and a process kill before the next phase
          // checkpoint must still be recoverable from nativeItems.
          if (!diskCreated.includes(item.final)) diskCreated.push(item.final);
          if (!session.nativeCreated!.includes(item.final))
            session.nativeCreated!.push(item.final);
          await writeRestoreJournal(session);
          await setItemState("promoted");
        } else if (
          (await appDocumentExists(item.final)) &&
          itemState?.state === "promoted"
        ) {
          continue;
        } else {
          throw new Error(
            `Restore staging file missing before promotion: ${item.temp}`,
          );
        }
      }
      session.nativePhase = "files-promoted";
      await writeRestoreJournal(session);
    } catch (e) {
      await rollbackDisk();
      if (backupId)
        await db.app_settings
          .delete(restoreJournalKey(backupId))
          .catch(() => {});
      throw e;
    }
  }

  // Merge is ID-aware. When an imported parent collides, allocate a new
  // ID for that imported row and rewrite every known child foreign key to the
  // new ID. This prevents a fresh child from accidentally attaching to the
  // existing local parent. app_settings uses `key` as its natural key and is
  // intentionally skipped on collision rather than remapped.
  let mergeTables = backup.tables;
  if (mode === "merge") {
    // Same primary key means the same record. A differing local copy is kept
    // (the preview reports it as "differed and kept local"); minting a second
    // id would duplicate edited bills/sales/stock and double-count them.
    const idMaps = new Map<string, Map<string, string>>();
    const ref = (row: Row, field: string, target: string) => {
      const value = row[field];
      const mapped = idMaps.get(target)?.get(String(value));
      if (mapped && value != null) row[field] = mapped;
    };
    // Same primary key means the target device already owns that record. Keep
    // the local row and omit the incoming copy. Child rows are filtered below
    // when they would otherwise attach to that kept local parent.
    const skipExisting = new Map<DataTable, Set<string>>();
    for (const t of BACKUP_TABLES) {
      if (t === "app_settings" || t === "counters") continue;
      const existing = new Set(
        (await table(t).toCollection().primaryKeys()).map(String),
      );
      const skipped = new Set<string>();
      for (const row of (backup.tables[t] ?? []) as Row[]) {
        const id = typeof row["id"] === "string" ? row["id"] : null;
        if (id && existing.has(id) && !idMaps.get(t)?.has(id)) skipped.add(id);
      }
      if (skipped.size) skipExisting.set(t, skipped);
    }
    // A payment row replaces the parent's implied payment (amount_paid) the
    // moment one exists, so adding another device's payment rows to a parent
    // that stays local would silently change what is considered paid. The kept
    // local parent stays authoritative for its own payments.
    const keptPaymentParent = (r: Row) => {
      const typ = String(r["parent_type"] ?? "");
      const target: DataTable | null =
        typ === "bill"
          ? "bills"
          : typ === "turf_booking"
            ? "turf_bookings"
            : typ === "snack_sale"
              ? "snack_sales"
              : null;
      return (
        !!target && !!skipExisting.get(target)?.has(String(r["parent_id"]))
      );
    };
    const clone = Object.fromEntries(
      BACKUP_TABLES.map((t) => [
        t,
        ((backup.tables[t] ?? []) as Row[])
          .filter(
            (r) =>
              !(
                typeof r["id"] === "string" && skipExisting.get(t)?.has(r["id"])
              ),
          )
          .filter((r) => !(t === "payments" && keptPaymentParent(r)))
          .map((r) => ({ ...r })),
      ]),
    );

    // Parallel-device merge safety: document numbers are human-visible and
    // are not primary keys. Two devices can legitimately create the same
    // daily number before either one is merged. Never keep duplicate visible
    // document numbers after a merge; remap only the incoming conflicting row
    // to the next free sequence for the same document-day/prefix.
    const documentSeries: Array<[DataTable, string, string]> = [
      ["bills", "invoice_no", "INV-"],
      ["turf_bookings", "booking_no", "TURF-"],
      ["snack_sales", "bill_no", "SB-"],
      ["expenses", "expense_no", "TX-"],
      ["investments", "bill_no", "INVES-"],
    ];
    for (const [tableName, field, prefix] of documentSeries) {
      const target = table(tableName);
      const used = new Set(
        (await target.toCollection().toArray())
          .map((r) => String((r as Row)[field] ?? ""))
          .filter(Boolean),
      );
      const incoming = (clone[tableName] ?? []) as Row[];
      const nextByDay = new Map<string, number>();
      for (const value of used) {
        const m = new RegExp(
          `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9]{8})-([0-9]+)$`,
        ).exec(value);
        if (m?.[1])
          nextByDay.set(
            m[1],
            Math.max(nextByDay.get(m[1]) ?? 0, Number(m[2]) || 0),
          );
      }
      for (const row of incoming) {
        const value = String(row[field] ?? "");
        if (!value || !used.has(value)) {
          if (value) used.add(value);
          continue;
        }
        const m = new RegExp(
          `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9]{8})-([0-9]+)$`,
        ).exec(value);
        if (!m) {
          // Unknown legacy numbering cannot be safely remapped. Fail closed
          // rather than leaving duplicate human-visible document numbers.
          throw new Error(
            `Merge conflict: ${field} "${value}" already exists and has an unknown numbering format; resolve the duplicate before merging.`,
          );
        }
        const day = m[1]!;
        let seq = nextByDay.get(day) ?? 0;
        let candidate = "";
        do {
          seq += 1;
          candidate = `${prefix}${day}-${String(seq).padStart(prefix === "INVES-" ? 3 : 4, "0")}`;
        } while (used.has(candidate));
        nextByDay.set(day, seq);
        used.add(candidate);
        row[field] = candidate;
        console.warn(
          `[migration] remapped conflicting ${field} ${value} -> ${candidate}`,
        );
      }
    }
    {
      // snack_sales.booking_no is a denormalised copy of the linked booking's
      // number; refresh it so a remapped TURF- number is never printed stale.
      const bookingNo = new Map<string, string>();
      for (const b of (await table("turf_bookings").toArray()) as Row[])
        if (typeof b["id"] === "string" && typeof b["booking_no"] === "string")
          bookingNo.set(b["id"], b["booking_no"]);
      for (const b of (clone["turf_bookings"] ?? []) as Row[])
        if (typeof b["id"] === "string" && typeof b["booking_no"] === "string")
          bookingNo.set(b["id"], b["booking_no"]);
      for (const sale of (clone["snack_sales"] ?? []) as Row[]) {
        const n =
          typeof sale["booking_id"] === "string"
            ? bookingNo.get(sale["booking_id"])
            : undefined;
        if (n && sale["booking_no"] !== n) sale["booking_no"] = n;
      }
    }
    for (const [t, rows] of Object.entries(clone) as [DataTable, Row[]][]) {
      if (t !== "app_settings" && t !== "counters")
        for (const row of rows) {
          if (typeof row["id"] === "string")
            row["id"] = idMaps.get(t)?.get(row["id"]) ?? row["id"];
          if (t === "snack_stock_history") ref(row, "item_id", "snack_items");
          if (t === "snack_sales") {
            ref(row, "booking_id", "turf_bookings");
            ref(row, "merged_into_bill_id", "bills");
          }
          if (t === "turf_bookings") ref(row, "merged_into_bill_id", "bills");
          if (t === "tab_entries") {
            ref(row, "tab_id", "customer_tabs");
            const targetFor = (typ: unknown) => {
              const x = String(typ ?? "");
              return x === "booking"
                ? "turf_bookings"
                : x === "snack_sale"
                  ? "snack_sales"
                  : x === "bill"
                    ? "bills"
                    : null;
            };
            const target = targetFor(row["ref_type"]);
            if (target) ref(row, "ref_id", target);
            const sourceTarget = targetFor(row["source_ref_type"]);
            if (sourceTarget) ref(row, "source_ref_id", sourceTarget);
          }
          if (t === "snack_sales" && Array.isArray(row["items"])) {
            row["items"] = row["items"].map(
              (item: Record<string, unknown>) => ({
                ...item,
                combo_id:
                  idMaps.get("snack_combos")?.get(String(item?.["combo_id"])) ??
                  item?.["combo_id"],
              }),
            );
          }
          if (t === "payments") {
            const typ = String(row["parent_type"] ?? "");
            const target =
              typ === "bill"
                ? "bills"
                : typ === "turf_booking"
                  ? "turf_bookings"
                  : typ === "snack_sale"
                    ? "snack_sales"
                    : null;
            if (target) ref(row, "parent_id", target);
          }
          if (t === "teams") ref(row, "customer_id", "customers");
          if (t === "team_players") ref(row, "team_id", "teams");
          if (t === "calendar_events") ref(row, "customer_id", "customers");
          if (t === "calendar_event_exceptions")
            ref(row, "event_id", "calendar_events");
        }
    }
    mergeTables = clone;
  }

  await validateReferentialIntegrity(
    mergeTables as Record<string, Row[]>,
    backup,
    mode,
    restoreOptions,
  );

  // Browser v3 photos are written AFTER the metadata commit. Keep the old
  // photos until every new one is stored so a quota/crash failure cannot leave
  // the user with neither set.
  const deferReceiptClear =
    mode === "replace" &&
    !isDesktop() &&
    backup.version >= 3 &&
    !restoreOptions.preserveReceiptsDuringRestore;
  try {
    if (!activeJournal?.metadataApplied)
      await db.transaction(
        "rw",
        [...BACKUP_TABLES.map((t) => table(t)), db.receipts, db.receipt_hashes],
        async () => {
          if (mode === "replace") {
            // Only clear tables that are actually present in the backup. Older
            // backups legitimately lack stores introduced by later schema
            // versions; treating a missing table as [] would otherwise erase
            // newer local data during a replace restore.
            // Child tables absent from an older backup must still be cleared when
            // their parent table is replaced, or they become orphans (or attach to
            // an unrelated row that reuses an id).
            const replacedFromBackup = (x: DataTable) =>
              x in backup.tables &&
              !(backup.version < 2 && (backup.tables[x] ?? []).length === 0) &&
              !(backup.year != null && x === "customer_tabs");
            const CHILD_PARENTS: Partial<Record<DataTable, DataTable[]>> = {
              payments: ["bills", "turf_bookings", "snack_sales"],
              tab_entries: ["customer_tabs"],
              snack_stock_history: ["snack_items"],
              teams: ["customers"],
              team_players: ["teams"],
              calendar_event_exceptions: ["calendar_events"],
            };
            const cascadeCleared = (x: DataTable) =>
              backup.year == null &&
              (CHILD_PARENTS[x] ?? []).some(replacedFromBackup);
            for (const t of [...BACKUP_TABLES].reverse()) {
              if (t === "counters") continue; // counters are derived state
              // Year archives carry only the tabs referenced by archived entries;
              // never clear unrelated live tabs during a replace restore.
              if (backup.year != null && t === "customer_tabs") continue;
              if (!(t in backup.tables) && !cascadeCleared(t)) continue;
              // An older-format backup with an EMPTY table array predates this
              // table's data model — it means "not tracked yet", not "delete my
              // rows". Preserve newer-version data instead of wiping it (WP3
              // restore-safety: replace from an old backup must not erase tables
              // the old app didn't populate).
              if (
                t in backup.tables &&
                backup.version < 2 &&
                (backup.tables[t] ?? []).length === 0
              )
                continue;
              if (t === "app_settings") {
                const existingSettings = await db.app_settings.toArray();
                for (const row of existingSettings) {
                  if (
                    String(row.key).startsWith("__migration_restore__:") ||
                    String(row.key).startsWith("__telegram_restore__:") ||
                    String(row.key).startsWith("__telegram_restore_snapshot__:")
                  )
                    continue;
                  await db.app_settings.delete(row.key);
                }
              } else {
                await table(t).clear();
              }
            }
            // Photos are keyed by `receipt_path`, so a "replace" that wipes the
            // expense rows but leaves old photos behind would strand them —
            // clear them together so the two stay in sync. Hashes are keyed the
            // same way and cleared alongside for the same reason.
            if (
              !restoreOptions.preserveReceiptsDuringRestore &&
              !deferReceiptClear
            ) {
              await db.receipts.clear();
              await db.receipt_hashes.clear();
            }
          }

          for (const t of BACKUP_TABLES) {
            if (t === "counters") continue; // derived state; always rebuilt below
            const rows = ((mergeTables[t] ?? []) as Row[]).filter(
              (r) =>
                t !== "app_settings" ||
                !(
                  String(r["key"]).startsWith("__migration_restore__:") ||
                  String(r["key"]).startsWith("__telegram_restore__:") ||
                  String(r["key"]).startsWith("__telegram_restore_snapshot__:")
                ),
            );
            if (rows.length === 0) continue;
            const target = table(t);
            if (mode === "merge") {
              // Dedup on each table's OWN primary key, not a hardcoded "id" —
              // most DATA_TABLES use "id", but app_settings is keyed by "key"
              // (see localdb.ts). Hardcoding "id" made every app_settings row
              // (existing and incoming) collapse to the same "undefined" bucket,
              // so a merge restore silently kept whichever settings the target
              // device already had and dropped the incoming ones with no error.
              const primKey = target.schema.primKey.name as string;
              const existing = new Set(
                await target
                  .toCollection()
                  .primaryKeys()
                  .then((keys) => keys.map(String)),
              );
              const fresh = rows.filter(
                (r) => !existing.has(String(r[primKey])),
              );
              if (fresh.length === 0) continue;
              await target.bulkAdd(fresh);
              inserted += fresh.length;
            } else {
              await target.bulkPut(rows);
              inserted += rows.length;
            }
          }

          // Native v3 receipts are stored on disk, so Dexie keeps metadata only.
          // Recreate those metadata rows during the same metadata commit so a
          // successful .db restore cannot leave filesystem photos invisible to
          // receipt-health, cleanup, or later migrations.
          if (isDesktop() && backup.version >= 3) {
            for (const entry of verifiedV3Paths) {
              if (mode === "merge" && (await db.receipts.get(entry.path)))
                continue;
              await db.receipts.put({
                path: entry.path,
                size: entry.size,
                created_at: entry.created_at ?? nowIso(),
              });
            }
          }

          // Legacy v1/v2 photos are already materialized in `backup.photos`.
          // v3 photos are deliberately NOT decoded inside this Dexie transaction:
          // JSZip's async decode yields to the event loop and can cause Dexie's
          // transaction to auto-commit (PrematureCommitError). v3 bytes are
          // decoded and written after this metadata transaction completes, one
          // photo at a time, so we never retain the full photo set in memory.
          if (backup.version < 3) {
            for (const photo of backup.photos ?? []) {
              if (mode === "merge" && (await db.receipts.get(photo.path)))
                continue;
              await db.receipts.put({
                path: photo.path,
                blob: new Blob([
                  base64ToBytes(photo.data).buffer as ArrayBuffer,
                ]),
                created_at: photo.created_at,
              });
            }
          }

          if (receiptHashes.length > 0) {
            if (mode === "merge") {
              const existingHashPaths = new Set(
                await db.receipt_hashes
                  .toCollection()
                  .primaryKeys()
                  .then((keys) => keys.map(String)),
              );
              const freshHashes = receiptHashes.filter(
                (h) => !existingHashPaths.has(h.path),
              );
              if (freshHashes.length > 0)
                await db.receipt_hashes.bulkPut(freshHashes);
            } else {
              await db.receipt_hashes.bulkPut(receiptHashes);
            }
          }

          if (backupId && !activeJournal?.metadataApplied) {
            // The restore journal is part of the SAME Dexie transaction as the
            // metadata changes. This is the commit boundary between native file
            // promotion and the database: either both metadata + metadataApplied
            // become durable, or neither does. A process kill cannot leave the
            // native files promoted while the journal still says the DB is
            // uncommitted.
            const nextJournal: RestoreJournal = {
              ...(activeJournal ?? { backupId, mode, completedPhotos: [] }),
              backupId,
              mode,
              metadataApplied: true,
              completedPhotos: activeJournal?.completedPhotos ?? [],
              localSettingsBefore:
                activeJournal?.localSettingsBefore ?? captureLocalSettings(),
              localSettingsAfter:
                activeJournal?.localSettingsAfter ?? backup.localSettings,
              updatedAt: nowIso(),
            };
            await db.app_settings.put({
              key: restoreJournalKey(backupId),
              value: JSON.stringify(nextJournal),
            } as never);
            activeJournal = nextJournal;
          }
          if (
            restoreOptions.restoreCommitJournalKey &&
            restoreOptions.restoreCommitJournalValue
          ) {
            await db.app_settings.put({
              key: restoreOptions.restoreCommitJournalKey,
              value: restoreOptions.restoreCommitJournalValue,
            } as never);
          }
        },
      );
  } catch (e) {
    await rollbackDisk();
    throw e;
  }

  // Browser v3 restores keep photo bytes in IndexedDB. Decode outside the
  // Dexie metadata transaction, one entry at a time, to avoid transaction
  // auto-commit and to keep peak memory bounded to one photo.
  if (backup.version >= 3 && !isDesktop()) {
    for (const entry of verifiedV3Paths) {
      if (activeJournal?.completedPhotos.includes(entry.path)) continue;
      const bytes = photoContainer
        ? await photoContainer.read(entry.path)
        : await readStoredReceiptBytes(entry.path);
      const existing = await db.receipts.get(entry.path);
      if (existing && mode === "merge") {
        activeJournal?.completedPhotos.push(entry.path);
        if (activeJournal) await writeRestoreJournal(activeJournal);
        continue;
      }
      await db.receipts.put({
        path: entry.path,
        blob: new Blob([bytes.slice().buffer as ArrayBuffer], {
          type: receiptMimeType(entry.path),
        }),
        size: bytes.length,
        created_at: entry.created_at ?? nowIso(),
      });
      if (activeJournal) {
        activeJournal.completedPhotos.push(entry.path);
        await writeRestoreJournal(activeJournal);
      }
    }
  }

  if (deferReceiptClear) {
    const keep = new Set(verifiedV3Paths.map((e) => e.path));
    for (const path of (await db.receipts
      .toCollection()
      .primaryKeys()) as string[])
      if (!keep.has(String(path))) await db.receipts.delete(path);
    for (const path of (await db.receipt_hashes
      .toCollection()
      .primaryKeys()) as string[])
      if (!keep.has(String(path))) await db.receipt_hashes.delete(path);
  }

  // Native shells: the complete file set was promoted before the DB commit.
  // Once metadata is committed, old rollback copies can safely be discarded.
  if (isDesktop()) {
    try {
      if (activeJournal) {
        activeJournal.metadataApplied = true;
        activeJournal.nativePhase = "metadata-applied";
        await writeRestoreJournal(activeJournal);
      }
      if (
        mode === "replace" &&
        (backup.version >= 3 || (backup.photos ?? []).length > 0)
      ) {
        const keep = new Set<string>([
          ...(backup.photos ?? []).map((ph) => ph.path),
          ...(backup.photo_manifest ?? []).map((m) => m.path),
        ]);
        for (const path of oldReceiptPaths) {
          if (!keep.has(path)) await removeAppDocument(path);
        }
      }
      await finalizeDisk();
    } finally {
      // Do not attempt to roll back committed DB metadata. Leave the durable
      // journal for the next restore/startup cleanup pass.
    }
  }
  // Theme/layout are part of the portable profile. In merge mode, however,
  // existing device preferences must remain untouched; only replace restores
  // replace the target profile with the backup profile.
  if (mode === "replace") applyThemeLayout(backup.theme, backup.layout);
  if (backupId) {
    const completed = activeJournal ?? {
      backupId,
      mode,
      metadataApplied: true,
      completedPhotos: [],
      updatedAt: nowIso(),
    };
    if (mode === "merge" && !restoreOptions.suppressImportMarker) {
      const markerKey = `__migration_imported__:${backupId}`;
      await db.transaction("rw", [db.app_settings], async () => {
        await db.app_settings.put({ key: markerKey, value: nowIso() } as never);
        await db.app_settings.delete(restoreJournalKey(backupId));
      });
    } else {
      await db.app_settings.delete(restoreJournalKey(backupId));
    }
  }
  if (mode === "replace") {
    const incoming = new Set(Object.keys(backup.localSettings ?? {}));
    try {
      for (const k of Object.keys(window.localStorage)) {
        if (
          (k.startsWith("ks:") ||
            k.startsWith("app-") ||
            k.startsWith("sn-")) &&
          !k.startsWith("ks:telegram-backup") &&
          !/(token|passphrase|password|secret|api[-_]?key|credential|private[-_]?key|access[-_]?key)/i.test(
            k,
          ) &&
          !incoming.has(k)
        )
          window.localStorage.removeItem(k);
      }
    } catch {
      /* best-effort: failure here is non-fatal */
    }
  }
  if (mode === "replace") applyLocalSettings(backup.localSettings);

  // Older backups/imports may predate investment bill numbers. Backfill
  // deterministically before rebuilding derived counters; existing numbers
  // remain untouched, including across merge restores.
  await backfillInvestmentBillNumbers();

  // Counters are not part of the backup (they are derived state). Rebuild
  // them from the restored rows so a fresh profile can never reuse an
  // invoice/bill/booking number that already exists in the restored data —
  // the same pattern clear-all uses (F-11).
  await resyncCounters();

  return inserted;
}

export async function restoreBackup(
  backup: BackupFile,
  mode: "replace" | "merge" = "replace",
  opts: { alreadyLocked?: boolean } = {},
) {
  let acquired = false;
  // The photo source this restore owns, captured the moment it holds the lock.
  // Never re-read the shared slot afterwards: another file may have been
  // decoded meanwhile, and its source must not be cleaned by this restore.
  let ownedSource: PendingPhotoSource | null = null;
  const run = async () => {
    acquired = true;
    ownedSource = photoSourceByBackup.get(backup) ?? pendingPhotoZip;
    return restoreBackupImpl(backup, mode);
  };
  try {
    return await (opts.alreadyLocked ? run() : withMigrationLock(run));
  } finally {
    // A rejected second restore never entered the lock and must not clear the
    // first restore's photo source.
    if (acquired) {
      const source = ownedSource as PendingPhotoSource | null;
      if (source) activePhotoSources.delete(source);
      if (pendingPhotoZip === source) pendingPhotoZip = null;
      await source?.cleanup().catch(() => {});
      if (photoSourceByBackup.has(backup)) photoSourceByBackup.delete(backup);
    }
  }
}
