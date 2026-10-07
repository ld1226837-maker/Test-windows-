const loadJSZip = async () => (await import("jszip")).default;
import {
  db,
  table,
  DATA_TABLES,
  nowIso,
  type BillRow,
  type ExpenseRow,
  type ReceiptHashRow,
} from "./localdb";
import {
  previewRestore,
  restoreBackup,
  withMigrationLock,
  captureLocalSettings,
  setInternalRestoreOptions,
  type BackupFile,
  type RestorePreview,
} from "./backup";
import {
  isSafeReceiptPath,
  findInvalidReceiptHashRows,
  validateBackupTablesEnvelope,
} from "./backup-validate";
import { sha256Hex } from "./receipts-share";
import {
  appDocumentExists,
  isAndroid,
  isDesktop,
  readAppDocument,
  removeAppDocument,
  saveExportFile,
  saveToAppDocuments,
} from "./desktop";
import { secureDelete, secureGet, secureSet } from "./android-secure-store";
import { istTimestampKey } from "./utils";
import { receiptMimeType } from "./receipt-storage";
import {
  decryptFullBackupBytes,
  encryptFullBackupBytes,
} from "./backup-crypto";
import { beginOp, errorCodeFor, redact } from "./backup-log";
import type { OpPhase } from "./operation-progress";

/**
 * Telegram full backup — ONE archive, ONE destination, ONE restore action.
 *
 * Before this module there were two half-backups: `backup.ts` exported every
 * table except `receipts` (photo bytes are too big for a diffable JSON
 * snapshot — see `DATA_TABLES` in localdb.ts) and `receipts-share.ts`
 * exported a separate `.zip` of just the photo files. Restoring meant doing
 * both, in order, by hand — and forgetting the second step looked exactly
 * like "the photos are gone".
 *
 * Here both halves are packed into a single zip (`manifest.json` holding
 * every table's rows *and* the per-file checksums, plus each receipt photo
 * at its usual `Receipts/<date>/<id>.<ext>` path) and that one zip is sent
 * to a private Telegram chat through a bot the person owns.
 *
 * Telegram's Bot API caps a bot upload at 50 MB and `getFile` downloads at
 * 20 MB, so anything past ~19 MB is split into parts. Delivery order is not
 * guaranteed across rate-limit retries, so every part carries the same
 * session timestamp plus its own `part N of M` in BOTH its filename and its
 * caption; restore groups by that timestamp instead of trusting order.
 *
 * The zip-building and checksum logic is deliberately shared with
 * `receipts-share.ts` (`sha256Hex`, `resolveImportAction`) rather than
 * duplicated, and the table restore goes through `backup.ts`'s
 * `restoreBackup` so replace/merge behaves identically to the local import.
 */

/* ------------------------------------------------------------------ *
 * Archive format
 * ------------------------------------------------------------------ */

export const FULL_BACKUP_FORMAT = "turf-snack-ledger-full";
export const MANIFEST_NAME = "manifest.json";

export type FullBackupFileEntry = {
  /** `Receipts/<date>/<id>.<ext>` — same convention the app already stores. */
  path: string;
  expense_id?: string;
  sha256: string;
};

export type FullBackup = {
  format: typeof FULL_BACKUP_FORMAT;
  /**
   * Version 1: one monolithic zip (whole archive buffered in memory at
   * build/restore time). Version 2 (R3): the photos stream out in shards
   * (per month, capped at SHARD_MAX_PHOTOS / SHARD_MAX_BYTES each) listed
   * in a top-level manifest; restore verifies and applies one shard at a
   * time with bounded memory, all-or-nothing per shard.
   */
  version: 1 | 2;
  created_at: string;
  /** "Windows" / "Android" / a name the person set — tells backups apart in the chat. */
  device_label: string;
  /** Every DATA_TABLES table, plus `receipts` row metadata (bytes travel as files). */
  tables: Record<string, Record<string, unknown>[]>;
  files: FullBackupFileEntry[];
  backup_id?: string;
  schema_version?: number;
  app_version?: string;
  theme?: Record<string, string | null>;
  layout?: Record<string, string | null>;
  localSettings?: Record<string, string | null>;
  /** Explicitly identifies a backup whose receipt set is incomplete. */
  partial?: boolean;
  warnings?: string[];
  /** Telegram transport locator written into the manifest after upload.
   * Allows a replacement device to restore a historical backup by the exact
   * manifest message instead of depending on getUpdates history. */
  telegram?: {
    /** Exact Telegram message locator for every uploaded shard, in shard order. */
    shardMessageIds: number[];
    shardBotIndexes: number[];
    /** Telegram file_id for each shard; avoids forwarding files during restore. */
    shardFileIds: string[];
  };
};

/* ------------------------------------------------------------------ *
 * R3: sharded archive format (version 2)
 * ------------------------------------------------------------------ */

/** Photos per shard — bounds one shard's zip to a sane working set. */
export const SHARD_MAX_PHOTOS = 500;
/** Hard byte cap per shard — keeps every Telegram part under the 19 MB
 *  upload limit with headroom for the zip container overhead. */
export const SHARD_MAX_BYTES = 17 * 1024 * 1024;

export type ShardableReceipt = {
  path: string;
  spent_at: string;
  size: number;
};

/**
 * Pure — groups receipts by the LOCAL month of their expense date
 * (`spent_at`), splits any group exceeding SHARD_MAX_PHOTOS, and further
 * splits when the running byte total would exceed SHARD_MAX_BYTES. Returns
 * ordered shard path lists. Deterministic (sorted months, stable order
 * within a month) so incremental backups compare cleanly.
 */
export function planReceiptShards(
  items: ShardableReceipt[],
  maxPhotos = SHARD_MAX_PHOTOS,
  maxBytes = SHARD_MAX_BYTES,
): string[][] {
  const byMonth = new Map<string, ShardableReceipt[]>();
  for (const it of items) {
    const month = (it.spent_at || "unknown").slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(it);
  }
  const shards: string[][] = [];
  for (const month of [...byMonth.keys()].sort()) {
    let current: string[] = [];
    let bytes = 0;
    for (const it of byMonth.get(month)!) {
      if (
        current.length > 0 &&
        (current.length >= maxPhotos || bytes + it.size > maxBytes)
      ) {
        shards.push(current);
        current = [];
        bytes = 0;
      }
      current.push(it.path);
      bytes += it.size;
    }
    if (current.length > 0) shards.push(current);
  }
  return shards;
}

export type FullBackupShardManifest = {
  format: typeof FULL_BACKUP_FORMAT;
  version: 2;
  /** 1-based shard index. */
  shard: number;
  shardCount: number;
  created_at: string;
  device_label: string;
  /** Photos carried in THIS shard, with their checksums. */
  files: FullBackupFileEntry[];
  backup_id?: string;
  schema_version?: number;
  app_version?: string;
  /** Tables travel in shard 1 only; null in later shards. */
  tables: Record<string, Record<string, unknown>[]> | null;
  theme?: Record<string, string | null> | undefined;
  layout?: Record<string, string | null> | undefined;
  localSettings?: Record<string, string | null> | undefined;
};

export type FullBackupTopManifest = {
  format: "turf-snack-ledger-full-manifest";
  version: 2;
  created_at: string;
  device_label: string;
  shardCount: number;
  /** sha256 of each shard zip, so a re-downloaded part is verified whole. */
  shards: { index: number; sha256: string; photoCount: number }[];
  /** Every photo across all shards (unchanged ones marked). */
  files: (FullBackupFileEntry & { unchanged?: boolean })[];
  backup_id?: string;
  schema_version?: number;
  app_version?: string;
  /** Portable UI/profile state captured in shard 1 and duplicated here so
   * restore can recover settings without depending on the shard payload. */
  theme?: Record<string, string | null>;
  layout?: Record<string, string | null>;
  localSettings?: Record<string, string | null>;
  /** Explicitly identifies a backup whose receipt set is incomplete. */
  partial?: boolean;
  warnings?: string[];
  /** Telegram transport locator written into the manifest after upload.
   * Allows a replacement device to restore a historical backup by the exact
   * manifest message instead of depending on getUpdates history. */
  telegram?: {
    /** Exact Telegram message locator for every uploaded shard, in shard order. */
    shardMessageIds: number[];
    shardBotIndexes: number[];
    /** Telegram file_id for each shard; avoids forwarding files during restore. */
    shardFileIds: string[];
  };
};

/** Pure — one `files[]` row for an expense known to have a receipt photo. */
export function buildFileEntry(
  receipt: {
    path?: string;
    receipt_path?: string;
    expense_id?: string | null | undefined;
    id?: string;
  },
  sha256: string,
): FullBackupFileEntry {
  const path = receipt.path ?? receipt.receipt_path;
  if (!path) throw new Error("Receipt file entry has no path");
  const expenseId = receipt.expense_id ?? receipt.id;
  return { path, ...(expenseId ? { expense_id: expenseId } : {}), sha256 };
}

export function defaultDeviceLabel(): string {
  if (isAndroid()) return "Android";
  if (isDesktop()) return "Windows";
  return "Browser";
}

/** Pure — validates and narrows a parsed `manifest.json`. */
export function parseFullBackupManifest(text: string): FullBackup {
  const parsed = JSON.parse(text) as FullBackup;
  // Version-2 shard manifests: shard 1 carries the tables; later shards
  // legitimately have `tables: null`.
  if (parsed?.format !== FULL_BACKUP_FORMAT)
    throw new Error("Not a valid full backup archive");
  if (
    !parsed.tables &&
    !(
      parsed.version === 2 &&
      typeof (parsed as { shard?: number }).shard === "number" &&
      (parsed as { shard?: number }).shard! > 1
    )
  )
    throw new Error("Not a valid full backup archive");
  if (parsed.version !== 1 && parsed.version !== 2)
    throw new Error("Unsupported full backup version");
  // Later v2 shards legitimately have no tables - nothing to validate.
  if (parsed.tables)
    validateBackupTablesEnvelope(parsed.tables, {
      // Partial archives are rejected by restoreFullBackupImpl before any
      // destructive work; do not let their intentionally incomplete table set
      // mask the useful "marked partial" error.
      requireAllDataTables: !(parsed as FullBackup).partial,
      allowFullBackupExtras: true,
    });
  if (!Array.isArray(parsed.files))
    throw new Error("Full backup receipt-file manifest is not an array");
  return { ...parsed, files: parsed.files };
}

/** The same row counts summary the local `.db` backup shows. */
type ReceiptArchiveZip = {
  files: Record<
    string,
    { dir?: boolean; async: (type: "uint8array") => Promise<Uint8Array> }
  >;
};

async function validateReceiptArchiveBeforeRestore(
  zip: ReceiptArchiveZip,
  backup: FullBackup,
): Promise<void> {
  if (!Array.isArray(backup.files))
    throw new Error("Full backup receipt-file manifest is not an array");

  const declared = new Map<string, FullBackupFileEntry>();
  for (const file of backup.files) {
    if (
      !file ||
      !isSafeReceiptPath(file.path) ||
      (file.expense_id !== undefined && typeof file.expense_id !== "string") ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(file.sha256)
    ) {
      throw new Error(
        "Full backup contains an invalid receipt-file manifest entry",
      );
    }
    if (declared.has(file.path))
      throw new Error(
        `Full backup contains duplicate receipt-file path "${file.path}"`,
      );
    declared.set(file.path, file);
  }

  const receiptRows = (backup.tables["receipts"] ?? []) as unknown as Array<{
    path?: unknown;
    size?: unknown;
    created_at?: unknown;
  }>;
  const referencedReceiptPaths = new Set<string>();
  for (const tableName of ["expenses", "investments", "bills"] as const) {
    for (const row of (backup.tables[tableName] ?? []) as unknown as Array<{
      receipt_path?: unknown;
    }>) {
      if (
        row &&
        typeof row.receipt_path === "string" &&
        row.receipt_path.length > 0
      ) {
        if (!isSafeReceiptPath(row.receipt_path))
          throw new Error(
            `Full backup contains an unsafe receipt path in ${tableName}`,
          );
        referencedReceiptPaths.add(row.receipt_path);
      }
    }
  }
  const receiptPaths = new Set<string>();
  for (const row of receiptRows) {
    if (
      !row ||
      typeof row.path !== "string" ||
      !isSafeReceiptPath(row.path) ||
      receiptPaths.has(row.path)
    )
      throw new Error(
        "Full backup contains an invalid or duplicate receipt metadata row",
      );
    receiptPaths.add(row.path);
    if (!declared.has(row.path))
      throw new Error(
        `Full backup receipt metadata is missing photo bytes for "${row.path}"`,
      );
    if (!referencedReceiptPaths.has(row.path))
      throw new Error(
        `Full backup contains orphan receipt metadata for "${row.path}"`,
      );
    if (row.created_at != null && typeof row.created_at !== "string")
      throw new Error(
        `Full backup receipt metadata has an invalid created_at for "${row.path}"`,
      );
  }
  const hashRows = (backup.tables["receipt_hashes"] ??
    []) as unknown as ReceiptHashRow[];
  for (const hash of hashRows) {
    if (!receiptPaths.has(hash.path))
      throw new Error(
        `Full backup receipt hash has no receipt metadata row for "${hash.path}"`,
      );
    if (!referencedReceiptPaths.has(hash.path))
      throw new Error(
        `Full backup receipt hash is orphaned for "${hash.path}"`,
      );
    const file = declared.get(hash.path);
    if (file && file.sha256.toLowerCase() !== hash.sha256.toLowerCase())
      throw new Error(
        `Full backup receipt hash does not match the photo manifest for "${hash.path}"`,
      );
  }

  const actual = new Set<string>();
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (!entry || entry.dir || path === MANIFEST_NAME) continue;
    if (!path.startsWith("Receipts/"))
      throw new Error(`Full backup contains an undeclared file "${path}"`);
    actual.add(path);
    if (!declared.has(path))
      throw new Error(
        `Full backup contains an undeclared receipt file "${path}"`,
      );
    const fileBytes = await entry.async("uint8array");
    const metadata = receiptRows.find((row) => row.path === path);
    if (metadata?.size != null && Number(metadata.size) !== fileBytes.length)
      throw new Error(
        `Receipt photo "${path}" failed its manifest checksum (recorded size mismatch)`,
      );
    const expected = declared.get(path)!.sha256;
    if ((await sha256Hex(fileBytes)).toLowerCase() !== expected.toLowerCase())
      throw new Error(
        `Receipt photo "${path}" failed its manifest checksum — nothing was restored.`,
      );
  }

  for (const path of declared.keys()) {
    if (!actual.has(path))
      throw new Error(
        `Full backup is missing declared receipt file "${path}" — nothing was restored.`,
      );
  }
}

export function fullBackupSummary(backup: FullBackup): string {
  const rows = DATA_TABLES.reduce(
    (n, t) => n + (backup.tables[t]?.length ?? 0),
    0,
  );
  return `${rows} records · ${backup.files.length} receipt photo${
    backup.files.length === 1 ? "" : "s"
  }`;
}

async function readReceiptBytes(path: string): Promise<Uint8Array> {
  if (isDesktop()) {
    if (!(await appDocumentExists(path)))
      throw new Error(`Missing on disk: ${path}`);
    return readAppDocument(path);
  }
  const row = await db.receipts.get(path);
  if (!row?.blob) throw new Error(`Missing in this browser: ${path}`);
  return new Uint8Array(await row.blob.arrayBuffer());
}

export type BuildFullBackupResult = {
  backup: FullBackup;
  /** The packed zip's raw bytes — the one payload both destinations send. */
  bytes: Uint8Array;
  /** `receipt_path`s an expense claims but whose photo isn't on this device. */
  missingFiles: string[];
};

/**
 * Reads every table AND every receipt photo into one zip. Missing photos are
 * reported, never fatal — a partially-restored device should still be able
 * to back up what it does have.
 */
export async function buildFullBackup(
  deviceLabel = defaultDeviceLabel(),
  onProgress?: (progress: { phase: OpPhase; done?: number; total?: number; bytesDone?: number; bytesTotal?: number }) => void,
): Promise<BuildFullBackupResult> {
  onProgress?.({ phase: "reading" });
  // Snapshot all IndexedDB metadata together. Photo bytes are read only after
  // this transaction, so a concurrent expense edit cannot produce a backup
  // whose tables describe one state while its receipt manifest describes another.
  const snapshot = await db.transaction(
    "r",
    [
      ...DATA_TABLES.map((t) => table(t)),
      db.receipts,
      db.receipt_hashes,
      db.expenses,
      db.investments,
      db.bills,
    ],
    async () => ({
      tables: Object.fromEntries(
        await Promise.all(
          DATA_TABLES.map(async (t) => [
            t,
            (await table(t).toArray()) as Record<string, unknown>[],
          ]),
        ),
      ) as FullBackup["tables"],
      receiptMeta: await db.receipts.toArray(),
      receiptHashes: (await db.receipt_hashes.toArray()) as ReceiptHashRow[],
      expenses: (await db.expenses.toArray()) as ExpenseRow[],
      investments: await db.investments.toArray(),
      bills: await db.bills.toArray(),
    }),
  );
  onProgress?.({ phase: "reading", done: DATA_TABLES.length, total: DATA_TABLES.length });
  const tables: FullBackup["tables"] = snapshot.tables;
  const receiptMeta: Record<string, unknown>[] = snapshot.receiptMeta.map(
    (r) => ({
      path: r.path,
      size: r.size ?? r.blob?.size ?? 0,
      created_at: r.created_at,
    }),
  );
  tables["receipts"] = receiptMeta;
  tables["receipt_hashes"] = snapshot.receiptHashes as unknown as Record<
    string,
    unknown
  >[];

  // Theme + layout live in localStorage, outside IndexedDB - carry them too
  // so a Telegram restore on a fresh device looks identical (F: one-file).
  const theme: FullBackup["theme"] = {};
  for (const k of [
    "app-theme-profiles",
    "app-custom-theme",
    "app-custom-theme-css",
    "app-theme-mode",
  ])
    theme[k] =
      typeof window === "undefined" ? null : window.localStorage.getItem(k);
  const layout: FullBackup["layout"] = {};
  const localSettings: FullBackup["localSettings"] = {};
  try {
    for (const k of Object.keys(window.localStorage)) {
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
      )
        localSettings[k] = window.localStorage.getItem(k);
    }
  } catch {
    /* localStorage unavailable in non-DOM env */
  }
  for (const k of [
    "ks:layout-active",
    "ks:layout-presets",
    "ks:layout-applied-preset",
    "ks:settings-order-version",
    "ks:nav-order-version",
  ])
    layout[k] =
      typeof window === "undefined" ? null : window.localStorage.getItem(k);

  const expenses = snapshot.expenses;
  onProgress?.({ phase: "compressing" });
  const withReceipts = [
    ...expenses.filter(
      (e): e is ExpenseRow & { receipt_path: string } => !!e.receipt_path,
    ),
    ...snapshot.investments.filter(
      (e): e is typeof e & { receipt_path: string } => !!e.receipt_path,
    ),
    ...snapshot.bills.filter(
      (e): e is typeof e & { receipt_path: string } => !!e.receipt_path,
    ),
  ];

  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const files: FullBackupFileEntry[] = [];
  const missingFiles: string[] = [];
  const knownReceiptHashes = new Map(
    snapshot.receiptHashes.map((h) => [h.path, h.sha256]),
  );
  const emittedReceiptPaths = new Set<string>();

  // Expense and investment rows can legally share one receipt path. A ZIP has
  // one logical entry per path, so writing the same path twice creates
  // duplicate archive entries and an ambiguous restore. Read each path once
  // and record the first owning row only; the table snapshot still preserves
  // every reference to that shared photo.
  for (const owner of withReceipts) {
    const path = owner.receipt_path;
    if (emittedReceiptPaths.has(path)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await readReceiptBytes(path);
    } catch {
      missingFiles.push(path);
      emittedReceiptPaths.add(path);
      continue;
    }
    const actual = await sha256Hex(bytes);
    const expected = knownReceiptHashes.get(path);
    if (expected && expected.toLowerCase() !== actual.toLowerCase()) {
      missingFiles.push(path);
      emittedReceiptPaths.add(path);
      continue;
    }
    emittedReceiptPaths.add(path);
    zip.file(path, bytes);
    files.push(buildFileEntry(owner, actual));
  }

  // Receipt photos are owned by business rows. Do not export standalone/orphan
  // receipt metadata: the audit contract requires every archived photo to have
  // a live expense, investment, or bill reference. This also makes Telegram
  // backups follow the same fail-closed policy as ordinary .db backups.
  const referencedReceiptPaths = new Set(
    withReceipts.map((row) => row.receipt_path).filter((p): p is string => !!p),
  );
  for (const row of snapshot.receiptMeta) {
    if (!referencedReceiptPaths.has(row.path)) {
      throw new Error(
        `Cannot build full backup: receipt photo "${row.path}" is orphaned (not referenced by an expense, investment, or bill).`,
      );
    }
  }

  // Missing/unreadable photos are NON-FATAL by design (see the FullBackup
  // "partial" contract documented above): the backup is exported with
  // partial: true + warnings so the user can see what was omitted, and the
  // restore side relaxes table requirements accordingly. A throw here would
  // make that contract unreachable (dead code) and contradicts the
  // "reported, never fatal" design comment.
  const backup: FullBackup = {
    format: FULL_BACKUP_FORMAT,
    version: 1,
    created_at: new Date().toISOString(),
    device_label: deviceLabel,
    tables,
    files,
    theme,
    layout,
    localSettings,
    ...(missingFiles.length
      ? {
          partial: true,
          warnings: [
            `${missingFiles.length} receipt photo(s) were omitted or unreadable`,
          ],
        }
      : {}),
  };

  zip.file(MANIFEST_NAME, JSON.stringify(backup));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return { backup, bytes, missingFiles };
}

export type RestoreFullBackupResult = {
  rowsRestored: number;
  filesRestored: number;
  filesSkippedExisting: number;
  /** Photos whose extracted bytes failed the manifest checksum — never written. */
  filesCorrupted: string[];
  /** Photos in the zip that no current expense row points at. */
  filesSkippedUnmatched: number;
};

/**
 * Restores rows and photos from one archive, in one pass, and reports one
 * combined result so the UI shows a single toast.
 *
 * Rows go through `backup.ts`'s `restoreBackup` (identical replace/merge
 * semantics to the local import). Photos are checksum-checked first and
 * never overwrite a file already on this device — exactly the
 * `resolveImportAction` rules the receipts import already used.
 */
async function restoreFullBackupImpl(
  archiveBytes: Uint8Array | ArrayBuffer,
  mode: "replace" | "merge" = "replace",
  passphraseOverride?: string,
): Promise<RestoreFullBackupResult> {
  let bytes =
    archiveBytes instanceof Uint8Array
      ? archiveBytes
      : new Uint8Array(archiveBytes);
  // Archives made after encryption was added are encrypted (see
  // `encryptFullBackupBytes`); older archives made before it are plain
  // zips. `decryptFullBackupBytes` detects and handles both so a backup
  // someone already has saved/sent doesn't become unrestorable.
  // `passphraseOverride` (from TelegramBackupCard, after a first attempt
  // with the stored passphrase throws) lets a session made under a
  // different passphrase still restore.
  bytes = await decryptFullBackupBytes(bytes, passphraseOverride);
  const zip = await (await loadJSZip()).loadAsync(bytes);
  const manifestEntry = zip.files[MANIFEST_NAME];
  if (!manifestEntry || manifestEntry.dir)
    throw new Error("This archive has no manifest.json");
  const backup = parseFullBackupManifest(await manifestEntry.async("string"));
  if (backup.partial) {
    throw new Error(
      `This backup is marked partial${backup.warnings?.length ? `: ${backup.warnings.join("; ")}` : ""}. Complete the backup before restoring it.`,
    );
  }

  const hashRowsEarly = (backup.tables["receipt_hashes"] ??
    []) as unknown as ReceiptHashRow[];
  const earlyHashProblems = findInvalidReceiptHashRows(hashRowsEarly);
  if (earlyHashProblems.length > 0)
    throw new Error(
      `This backup's receipt-hash records look corrupted (${earlyHashProblems.length} bad row${earlyHashProblems.length === 1 ? "" : "s"}) — nothing was restored.`,
    );

  // Validate the entire receipt-file side before restoreBackup() can clear or
  // write any IndexedDB rows. A corrupt/missing/undeclared photo must never
  // leave a replace restore half-applied.
  await validateReceiptArchiveBeforeRestore(zip, backup);

  // `receipt_hashes` isn't in BACKUP_TABLES (see DATA_TABLES in localdb.ts),
  // so restoreBackup()'s own row validation below never sees these rows —
  // check them here, before restoreBackup touches anything, so a corrupted
  // receipt-hashes block can't let the main tables get restored (and, in
  // replace mode, cleared) while this half of the archive is left broken.
  const hashRows = (backup.tables["receipt_hashes"] ??
    []) as unknown as ReceiptHashRow[];
  const hashProblems = findInvalidReceiptHashRows(hashRows);
  if (hashProblems.length > 0)
    throw new Error(
      `This backup's receipt-hash records look corrupted (${hashProblems.length} bad row${
        hashProblems.length === 1 ? "" : "s"
      }) — nothing was restored.`,
    );

  // Include receipt_hashes in the same restore transaction as the ledger
  // tables. Previously these rows were written in a second operation after
  // restoreBackup() returned, so a Dexie failure between the two writes could
  // leave the main ledger restored while receipt_hashes still represented the
  // pre-restore database.
  const legacy: BackupFile = {
    format: "turf-snack-ledger",
    version: 1,
    exported_at: backup.created_at,
    tables: backup.tables,
    receipt_hashes: hashRows,
    theme: backup.theme,
    layout: backup.layout,
    localSettings: backup.localSettings,
  };
  const backupId = crypto.randomUUID();
  const importMarkerKey =
    mode === "merge"
      ? `__migration_imported__:${legacy.backup_id ? String(legacy.backup_id) : `legacy-${await sha256Hex(new TextEncoder().encode(JSON.stringify(legacy)))}`}`
      : null;
  const oldReceiptPaths = (await db.receipts.toCollection().primaryKeys()).map(
    String,
  );
  const oldReceiptRows = await db.receipts.toArray();
  const oldReceiptHashes = await db.receipt_hashes.toArray();
  const oldSettings = captureLocalSettings();
  const tableSnapshot: Record<string, Record<string, unknown>[]> = {};
  for (const t of DATA_TABLES)
    tableSnapshot[t] = (await table(t).toArray()) as Record<string, unknown>[];
  // Single-file backups are already fully buffered in memory. Keep the old
  // native bytes for paths that may be overwritten so a photo-write failure
  // can restore the exact pre-restore state rather than only the DB rows.
  const oldNativeReceiptBytes = new Map<string, Uint8Array>();
  if (isDesktop()) {
    for (const path of oldReceiptPaths) {
      try {
        oldNativeReceiptBytes.set(path, await readAppDocument(path));
      } catch {
        /* metadata may legitimately outlive a missing file */
      }
    }
  }
  await writeTelegramRecoverySnapshot(backupId, tableSnapshot);
  await writeTelegramRestoreJournal({
    backupId,
    mode,
    completedShards: [],
    completedPhotos: [],
    dbCommitted: false,
    phase: "committed",
    snapshotKey: telegramSnapshotKey(backupId),
    oldReceiptPaths,
    oldReceiptHashes,
    oldSettings,
    inFlightPhotos: [],
    updatedAt: new Date().toISOString(),
  });

  // The archive has already been validated as a complete receipt bundle. Tell
  // restoreBackup not to reject receipt_path references while receipts are
  // rebuilt below.
  setInternalRestoreOptions(legacy, {
    preserveReceiptsDuringRestore: true,
  });

  const newlyWrittenPhotoPaths = new Set<string>();
  const incomingPhotoPaths = new Set<string>();
  let rowsRestored = 0;
  let filesRestored = 0;
  let filesSkippedExisting = 0;
  let filesSkippedUnmatched = 0;
  const filesCorrupted: string[] = [];

  try {
    rowsRestored = await restoreBackup(legacy, mode, { alreadyLocked: true });

    const receiptRows = (backup.tables["receipts"] ?? []) as unknown as {
      path: string;
      created_at: string;
    }[];
    const createdAtByPath = new Map(
      receiptRows.map((r) => [r.path, r.created_at]),
    );
    const expenses = await db.expenses.toArray();
    const investments = await db.investments.toArray();
    const bills = await db.bills.toArray();
    const knownReceiptPaths = new Set([
      ...expenses.map((e) => e.receipt_path).filter((p): p is string => !!p),
      ...investments.map((e) => e.receipt_path).filter((p): p is string => !!p),
      ...bills.map((e) => e.receipt_path).filter((p): p is string => !!p),
    ]);

    for (const path of Object.keys(zip.files)) {
      const entry = zip.files[path];
      if (
        !entry ||
        entry.dir ||
        path === MANIFEST_NAME ||
        !path.startsWith("Receipts/")
      )
        continue;
      if (!knownReceiptPaths.has(path)) {
        filesSkippedUnmatched++;
        continue;
      }
      incomingPhotoPaths.add(path);
      const fileBytes = await entry.async("uint8array");
      const expected = backup.files.find((f) => f.path === path)?.sha256;
      if (
        !expected ||
        (await sha256Hex(fileBytes)).toLowerCase() !== expected.toLowerCase()
      ) {
        filesCorrupted.push(path);
        throw new Error(
          `Receipt photo ${path} failed checksum; nothing was restored.`,
        );
      }
      const alreadyExists = isDesktop()
        ? await appDocumentExists(path)
        : (await db.receipts.get(path)) != null;
      if (alreadyExists && mode === "merge") {
        const existingRow = await db.receipts.get(path);
        const existingBytes = isDesktop()
          ? await readAppDocument(path)
          : existingRow?.blob instanceof Blob
            ? new Uint8Array(await existingRow.blob.arrayBuffer())
            : null;
        if (!existingBytes)
          throw new Error(
            `Full backup merge conflict: existing receipt ${path} is unreadable.`,
          );
        const same =
          existingBytes.length === fileBytes.length &&
          (await sha256Hex(existingBytes)).toLowerCase() ===
            (await sha256Hex(fileBytes)).toLowerCase();
        if (!same)
          throw new Error(
            `Full backup merge conflict: existing receipt ${path} differs from the backup.`,
          );
        filesSkippedExisting++;
        continue;
      }
      if (!isDesktop() && alreadyExists && mode === "replace") {
        // Preserve the old Blob in oldReceiptRows; the incoming row replaces it.
      }
      if (isDesktop()) {
        await saveToAppDocuments(path, fileBytes);
        newlyWrittenPhotoPaths.add(path);
        await db.receipts.put({
          path,
          size: fileBytes.length,
          created_at: createdAtByPath.get(path) ?? nowIso(),
        });
      } else {
        await db.receipts.put({
          path,
          blob: new Blob([fileBytes.slice().buffer as ArrayBuffer], {
            type: receiptMimeType(path),
          }),
          size: fileBytes.length,
          created_at: createdAtByPath.get(path) ?? nowIso(),
        });
        newlyWrittenPhotoPaths.add(path);
      }
      filesRestored++;
      await writeTelegramRestoreJournal({
        backupId,
        mode,
        completedShards: [],
        completedPhotos: [...newlyWrittenPhotoPaths],
        dbCommitted: true,
        phase: "committed",
        snapshotKey: telegramSnapshotKey(backupId),
        oldReceiptPaths,
        oldReceiptHashes,
        oldSettings,
        inFlightPhotos: [],
        updatedAt: new Date().toISOString(),
      });
    }

    if (mode === "replace") {
      await db.transaction("rw", [db.receipts, db.receipt_hashes], async () => {
        for (const path of (await db.receipts.toCollection().primaryKeys()).map(
          String,
        )) {
          if (!incomingPhotoPaths.has(path)) await db.receipts.delete(path);
        }
        await db.receipt_hashes.clear();
        if (hashRows.length) await db.receipt_hashes.bulkPut(hashRows);
      });
      for (const path of oldReceiptPaths) {
        if (!incomingPhotoPaths.has(path) && isDesktop()) {
          try {
            await removeAppDocument(path);
          } catch {
            /* best-effort: failure here is non-fatal */
          }
        }
      }
    }
    await db.app_settings.delete(telegramRestoreJournalKey(backupId));
    await deleteTelegramRecoverySnapshot(backupId);
    return {
      rowsRestored,
      filesRestored,
      filesSkippedExisting,
      filesCorrupted,
      filesSkippedUnmatched,
    };
  } catch (e) {
    // Durable rollback: remove incoming files, restore every business table,
    // restore receipt metadata/hashes, and restore overwritten native bytes.
    try {
      await writeTelegramRestoreJournal({
        backupId,
        mode,
        completedShards: [],
        completedPhotos: [...newlyWrittenPhotoPaths],
        dbCommitted: true,
        phase: "rollingBack",
        snapshotKey: telegramSnapshotKey(backupId),
        oldReceiptPaths,
        oldReceiptHashes,
        oldSettings,
        inFlightPhotos: [],
        updatedAt: new Date().toISOString(),
      });
    } catch {
      /* best-effort: failure here is non-fatal */
    }
    try {
      if (isDesktop()) {
        for (const path of newlyWrittenPhotoPaths) {
          const old = oldNativeReceiptBytes.get(path);
          if (old) await saveToAppDocuments(path, old);
          else await removeAppDocument(path).catch(() => {});
        }
      }
      await db.transaction(
        "rw",
        DATA_TABLES.map((t) => table(t)).concat([
          db.receipts,
          db.receipt_hashes,
        ]),
        async () => {
          for (const t of DATA_TABLES) {
            const target = table(t);
            await target.clear();
            const rows = tableSnapshot[t] ?? [];
            if (rows.length) await target.bulkAdd(rows);
          }
          await db.receipts.clear();
          if (oldReceiptRows.length) await db.receipts.bulkAdd(oldReceiptRows);
          await db.receipt_hashes.clear();
          if (oldReceiptHashes.length)
            await db.receipt_hashes.bulkPut(oldReceiptHashes);
        },
      );
      if (typeof window !== "undefined") {
        for (const k of Object.keys(window.localStorage)) {
          if (
            (k.startsWith("ks:") ||
              k.startsWith("app-") ||
              k.startsWith("sn-")) &&
            !k.startsWith("ks:telegram-backup") &&
            !/(token|passphrase|password|secret|api[-_]?key|credential|private[-_]?key|access[-_]?key)/i.test(
              k,
            )
          )
            window.localStorage.removeItem(k);
        }
        for (const [k, v] of Object.entries(oldSettings))
          if (v != null) window.localStorage.setItem(k, v);
      }
      // Remove newly-created native files that did not exist before restore.
      if (isDesktop())
        for (const path of newlyWrittenPhotoPaths)
          if (!oldNativeReceiptBytes.has(path))
            await removeAppDocument(path).catch(() => {});
      if (importMarkerKey) await db.app_settings.delete(importMarkerKey);
      await db.app_settings.delete(telegramRestoreJournalKey(backupId));
      await deleteTelegramRecoverySnapshot(backupId);
    } catch {
      // Keep the rollingBack journal/snapshot so startup recovery can finish it.
    }
    throw e;
  }
}

export type FullBackupPreview = {
  mode: "replace" | "merge";
  /** Row-level breakdown, identical to the local `.db` backup's preview. */
  tables: RestorePreview;
  /** Receipt photos this restore would actually write to disk/Dexie. */
  filesToAdd: number;
  /** Already saved at that path on this device — never overwritten. */
  filesSkippedExisting: number;
  /** In the archive but no current expense row's `receipt_path` claims them. */
  filesSkippedUnmatched: number;
};

/**
 * Restore a complete single-file Telegram backup under the same migration
 * lock as local imports and sharded Telegram restores. The lock covers the
 * metadata and receipt-photo phases together so concurrent migrations cannot
 * interleave.
 */
export async function restoreFullBackup(
  archiveBytes: Uint8Array | ArrayBuffer,
  mode: "replace" | "merge" = "replace",
  passphraseOverride?: string,
): Promise<RestoreFullBackupResult> {
  const op = beginOp("telegram-restore", "Restoring latest Telegram backup");
  try {
    const result = await withMigrationLock(() =>
      restoreFullBackupImpl(archiveBytes, mode, passphraseOverride),
    );
    op.finish(result.filesCorrupted.length ? "warning" : "success", "Telegram restore completed", {
      records: result.rowsRestored,
      photos: { saved: result.filesRestored, missing: result.filesSkippedUnmatched + result.filesCorrupted.length },
      encrypted: true,
    });
    onProgress?.({ phase: "finalizing", done: 1, total: 1, label: "Finalizing Telegram restore" });
    return result;
  } catch (e) {
    op.finish("error", "Telegram restore failed", { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)) });
    throw e;
  }
}

/**
 * Read-only "what will actually happen" preview for a full (Telegram or
 * local-file) archive, mirrored after `backup.ts`'s `previewRestore` — same
 * idea, extended to also cover the receipt-photo half that only this format
 * carries. Never decrypts into a write path and never touches `db`/disk.
 *
 * Row counts come straight from `previewRestore` by handing it the same
 * `legacy` shape `restoreFullBackup` builds for `restoreBackup`, so the two
 * can't drift apart. Photo counts replicate `restoreFullBackup`'s own
 * zip-file loop and `resolveImportAction` call one-for-one, just without the
 * final `saveToAppDocuments`/`db.receipts.put` write — `resolveImportAction`
 * doesn't take a mode, so these three numbers are the same for merge and
 * replace, exactly as the actual restore behaves (see that function's own
 * comment on why photos aren't cleared in replace mode).
 */
export async function previewFullBackup(
  archiveBytes: Uint8Array | ArrayBuffer,
  mode: "replace" | "merge" = "replace",
  passphraseOverride?: string,
): Promise<FullBackupPreview> {
  const op = beginOp("preview", "Previewing Telegram restore");
  try {
  let bytes =
    archiveBytes instanceof Uint8Array
      ? archiveBytes
      : new Uint8Array(archiveBytes);
  bytes = await decryptFullBackupBytes(bytes, passphraseOverride);
  const zip = await (await loadJSZip()).loadAsync(bytes);
  const manifestEntry = zip.files[MANIFEST_NAME];
  if (!manifestEntry || manifestEntry.dir)
    throw new Error("This archive has no manifest.json");
  const backup = parseFullBackupManifest(await manifestEntry.async("string"));

  const legacy: BackupFile = {
    format: "turf-snack-ledger",
    version: 1,
    exported_at: backup.created_at,
    tables: backup.tables,
  };
  const tables = await previewRestore(legacy, mode);

  const expenses = await db.expenses.toArray();
  const investments = await db.investments.toArray();
  const bills = await db.bills.toArray();
  const knownReceiptPaths = new Set([
    ...expenses.map((e) => e.receipt_path).filter((p): p is string => !!p),
    ...investments.map((e) => e.receipt_path).filter((p): p is string => !!p),
    ...bills.map((e) => e.receipt_path).filter((p): p is string => !!p),
  ]);

  let filesToAdd = 0;
  let filesSkippedExisting = 0;
  let filesSkippedUnmatched = 0;

  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (
      !entry ||
      entry.dir ||
      path === MANIFEST_NAME ||
      !path.startsWith("Receipts/")
    )
      continue;

    const alreadyExists = isDesktop()
      ? await appDocumentExists(path)
      : (await db.receipts.get(path)) != null;
    if (!knownReceiptPaths.has(path)) filesSkippedUnmatched++;
    else if (alreadyExists && mode === "merge") filesSkippedExisting++;
    else filesToAdd++;
  }

  const result = {
    mode,
    tables,
    filesToAdd,
    filesSkippedExisting,
    filesSkippedUnmatched,
  };
  op.finish("success", "Telegram restore preview ready", { records: tables.totalAdded, photos: { saved: filesToAdd, missing: filesSkippedUnmatched } });
  return result;
  } catch (e) {
    op.finish("error", "Telegram restore preview failed", { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)) });
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * Local file fallback (no account, no network)
 * ------------------------------------------------------------------ */

export function fullBackupFileName(created = new Date()): string {
  return `turf-ledger-full-${istTimestampKey(created)}.zip`;
}

/**
 * The Telegram backup path is sharded, but the optional "Save local copy"
 * action historically built one complete JSZip archive in memory. Refuse that
 * legacy path before construction when the receipt working set is large enough
 * to threaten low-RAM devices. Users can still use the normal sharded Telegram
 * backup, while small local copies keep the existing one-file UX.
 */
export const LOCAL_FULL_COPY_MAX_ESTIMATED_BYTES = 128 * 1024 * 1024;

export async function estimateFullBackupBytes(): Promise<number> {
  const rows = await db.receipts.toArray();
  const photoBytes = rows.reduce(
    (sum, row) => sum + Math.max(0, Number(row.size ?? row.blob?.size ?? 0)),
    0,
  );
  // ZIP headers/manifest/metadata are intentionally over-estimated.
  return photoBytes + rows.length * 256 * 2 + 2 * 1024 * 1024;
}

export async function assertLocalFullCopyWithinMemoryBudget(): Promise<void> {
  const estimated = await estimateFullBackupBytes();
  if (estimated > LOCAL_FULL_COPY_MAX_ESTIMATED_BYTES) {
    throw new Error(
      `Local full-backup copy is limited to about ${Math.round(LOCAL_FULL_COPY_MAX_ESTIMATED_BYTES / 1048576)} MiB of receipt data. ` +
        `Use “Backup now” to Telegram for large photo libraries; it uses bounded shards instead of one in-memory archive.`,
    );
  }
}

/**
 * Saves the combined archive to the device — the no-setup fallback. Same
 * dual path as `backup.ts`'s `downloadBackup`: the Android plugin writes
 * straight to public Downloads (the native Save dialog's `content://` URI
 * silently produces a 0-byte file there), a native dialog on real desktop,
 * a Blob download in the browser. `null` means the person cancelled.
 */
export async function saveFullBackupLocally(
  bytes: Uint8Array,
  name = fullBackupFileName(),
  onProgress?: (progress: { phase: OpPhase; done?: number; total?: number; bytesDone?: number; bytesTotal?: number }) => void,
): Promise<string | null> {
  onProgress?.({ phase: "writing", bytesDone: 0, bytesTotal: bytes.byteLength });
  const op = beginOp("local-export", "Saving local full backup");
  try {
    if (isAndroid()) {
      const result = await saveExportFile(bytes, name, "application/zip");
      if (!result.saved) throw new Error(`Couldn't save the backup: ${result.error ?? "unknown reason"}`);
      onProgress?.({ phase: "writing", bytesDone: bytes.byteLength, bytesTotal: bytes.byteLength });
      op.finish("success", "Local full backup saved", { bytes: bytes.byteLength });
      return result.path ?? name;
    }
    if (isDesktop()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({ defaultPath: name, filters: [{ name: "Full backup", extensions: ["zip"] }] });
      if (!path) {
        op.finish("cancelled", "Local full backup cancelled", { bytes: bytes.byteLength });
        return null;
      }
      await writeFile(path, bytes);
      onProgress?.({ phase: "writing", bytesDone: bytes.byteLength, bytesTotal: bytes.byteLength });
      op.finish("success", "Local full backup saved", { bytes: bytes.byteLength });
      return path;
    }
    const blob = new Blob([bytes.buffer.slice(0) as ArrayBuffer], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
    onProgress?.({ phase: "writing", bytesDone: bytes.byteLength, bytesTotal: bytes.byteLength });
    op.finish("success", "Local full backup downloaded", { bytes: bytes.byteLength });
    return name;
  } catch (e) {
    op.finish("error", "Local full backup failed", { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)) });
    throw e;
  }
}

/** Desktop-only native open dialog for a saved full backup. `null` = cancelled. */
export async function pickFullBackupFile(): Promise<Uint8Array | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const path = await open({
    multiple: false,
    filters: [{ name: "Full backup", extensions: ["zip"] }],
  });
  if (!path || Array.isArray(path)) return null;
  return readFile(path);
}

/* ------------------------------------------------------------------ *
 * Config & credential storage
 * ------------------------------------------------------------------ */

export type TelegramConfig = {
  botToken: string;
  chatId: string;
  /** Optional extra bots, round-robined per chunk to spread rate limits. */
  extraBotTokens: string[];
  deviceLabel: string;
};

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: "",
  chatId: "",
  extraBotTokens: [],
  deviceLabel: "",
};

// Non-secret fields only — safe in localStorage on both builds.
const META_KEY = "ks:telegram-backup";
// Fallback token store used ONLY in the browser/PWA build, where there is no
// OS credential store to move it into. On real desktop the token lives in
// the OS credential store (`keyring_*`, `#[cfg(not(target_os =
// "android"))]`-gated in `src-tauri/src/lib.rs`). On Android it lives in the
// `android-save` plugin's Keystore-backed `EncryptedSharedPreferences` store
// (`secureGet`/`secureSet` — see `android-secure-store.ts`) — audit item 1.3.
const WEB_TOKEN_KEY = "ks:telegram-backup-token";
// `keyring_*` on desktop hardcodes its own service name and validates
// `account` against a fixed allowlist (see `src-tauri/src/lib.rs`), so
// there's no `service` constant to pass from here — only the account name,
// which must match one of the allowlisted slots.
const KEYRING_ACCOUNT = "telegram-backup-token";
const SECURE_STORE_KEY = "telegram-backup-token";

// The round-robin extra bot tokens used to travel inside `Meta`/`META_KEY`,
// which meant they sat in plain `localStorage` on EVERY platform, including
// real desktop — a wider gap than the audit's 1.3 (which only flagged the
// primary `botToken`). They now go through the same tiered secret storage
// as the primary token, JSON-encoded, under their own key.
const WEB_EXTRA_TOKENS_KEY = "ks:telegram-backup-extra-tokens";
const KEYRING_EXTRA_ACCOUNT = "telegram-backup-extra-tokens";
const SECURE_STORE_EXTRA_KEY = "telegram-backup-extra-tokens";

type Meta = Omit<TelegramConfig, "botToken" | "extraBotTokens">;

function metaDefaults(): Meta {
  const { botToken: _t, extraBotTokens: _e, ...rest } = DEFAULT_TELEGRAM_CONFIG;
  return rest;
}

function readMeta(): Meta {
  if (typeof window === "undefined") return metaDefaults();
  try {
    const raw = window.localStorage.getItem(META_KEY);
    return raw
      ? { ...metaDefaults(), ...(JSON.parse(raw) as Partial<Meta>) }
      : metaDefaults();
  } catch {
    return metaDefaults();
  }
}

function writeMeta(meta: Meta) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(META_KEY, JSON.stringify(meta));
}

// readSecret()/writeSecret() below can both hit the keyring in the same
// tick (writeTelegramConfig() writes the primary token and the extra
// tokens concurrently via Promise.all). A fresh `await import(...)` per
// call is safe in the real bundled app (dynamic import of the same
// specifier always resolves to one cached module instance there), but
// under Vitest's module mocking, two *first* dynamic imports of the same
// mocked specifier racing in the same tick can resolve inconsistently —
// one gets the mock, the other the real (untransformed) module. Caching
// the import in one module-level promise means only one dynamic import
// ever actually executes, sidestepping that race entirely.
let tauriCorePromise: Promise<typeof import("@tauri-apps/api/core")> | null =
  null;
function tauriCore() {
  if (!tauriCorePromise) tauriCorePromise = import("@tauri-apps/api/core");
  return tauriCorePromise;
}

async function readSecret(
  webKey: string,
  keyringAccount: string,
  secureStoreKey: string,
): Promise<string> {
  if (isAndroid()) {
    // Credentials must never be read from plaintext localStorage on the app.
    return (await secureGet(secureStoreKey)) ?? "";
  }
  if (isDesktop()) {
    const { invoke } = await tauriCore();
    return (
      (await invoke<string | null>("keyring_get_token", {
        account: keyringAccount,
      })) ?? ""
    );
  }
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(webKey) ?? "";
  } catch {
    return "";
  }
}

async function writeSecret(
  webKey: string,
  keyringAccount: string,
  secureStoreKey: string,
  value: string,
): Promise<void> {
  if (isAndroid()) {
    // Telegram bot tokens are credentials. Never fall back to plaintext
    // localStorage when the Android Keystore-backed store is unavailable.
    // A failed secure write must surface to the UI so the user can retry.
    if (value) await secureSet(secureStoreKey, value);
    else await secureDelete(secureStoreKey);
    return;
  }
  if (isDesktop()) {
    // Never downgrade a Telegram credential to plaintext localStorage on
    // desktop. Windows Credential Manager (or the platform keyring) is the
    // required storage boundary.
    const { invoke } = await tauriCore();
    if (value) {
      await invoke("keyring_set_token", {
        account: keyringAccount,
        token: value,
      });
    } else {
      await invoke("keyring_delete_token", { account: keyringAccount });
    }
    return;
  }
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(webKey, value);
  else window.localStorage.removeItem(webKey);
}

async function readToken(): Promise<string> {
  return readSecret(WEB_TOKEN_KEY, KEYRING_ACCOUNT, SECURE_STORE_KEY);
}

async function writeToken(token: string): Promise<void> {
  return writeSecret(WEB_TOKEN_KEY, KEYRING_ACCOUNT, SECURE_STORE_KEY, token);
}

async function readExtraTokens(): Promise<string[]> {
  const raw = await readSecret(
    WEB_EXTRA_TOKENS_KEY,
    KEYRING_EXTRA_ACCOUNT,
    SECURE_STORE_EXTRA_KEY,
  );
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function writeExtraTokens(tokens: string[]): Promise<void> {
  const cleaned = tokens.filter(Boolean);
  const raw = cleaned.length ? JSON.stringify(cleaned) : "";
  return writeSecret(
    WEB_EXTRA_TOKENS_KEY,
    KEYRING_EXTRA_ACCOUNT,
    SECURE_STORE_EXTRA_KEY,
    raw,
  );
}

export async function readTelegramConfig(): Promise<TelegramConfig> {
  const [meta, botToken, extraBotTokens] = await Promise.all([
    readMeta(),
    readToken(),
    readExtraTokens(),
  ]);
  return { ...meta, extraBotTokens, botToken };
}

export async function writeTelegramConfig(cfg: TelegramConfig): Promise<void> {
  const op = beginOp("telegram-config", "Saving Telegram configuration");
  try {
    const { botToken, extraBotTokens, ...meta } = cfg;
    writeMeta(meta);
    await Promise.all([writeToken(botToken), writeExtraTokens(extraBotTokens ?? [])]);
    op.finish("success", "Telegram configuration saved");
  } catch (e) {
    op.finish("error", "Telegram configuration could not be saved", { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)) });
    throw e;
  }
}

export function isTelegramConfigured(cfg: TelegramConfig): boolean {
  return !!cfg.botToken?.trim() && !!cfg.chatId?.trim();
}

export async function validateTelegramConfig(
  cfg: TelegramConfig,
): Promise<{ username?: string }> {
  const op = beginOp("telegram-config", "Validating Telegram configuration");
  try {
    if (!cfg.botToken?.trim()) throw new Error("Enter the Telegram bot token.");
    if (!cfg.chatId?.trim()) throw new Error("Enter the Telegram chat ID.");
    const me = await callApi<{ username?: string }>(cfg.botToken, "getMe", {});
    await callApi(cfg.botToken, "getChat", { chat_id: cfg.chatId });
    op.finish("success", "Telegram configuration validated");
    return { username: me?.username };
  } catch (e) {
    op.finish("error", "Telegram configuration validation failed", { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)) });
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * QR pairing
 * ------------------------------------------------------------------ */

export type PairingPayload = {
  botToken: string;
  chatId: string;
  extraBotTokens?: string[];
  lastUpload?: LastUpload;
};

export function encodePairingPayload(cfg: TelegramConfig): string {
  return JSON.stringify({
    v: 1,
    botToken: cfg.botToken,
    chatId: cfg.chatId,
    extraBotTokens: cfg.extraBotTokens,
    lastUpload: readLastUpload() ?? undefined,
  });
}

/** Pure — reads a scanned QR's text back into credentials, or throws. */
export function decodePairingPayload(text: string): PairingPayload {
  let parsed: Partial<PairingPayload> & { v?: number };
  try {
    parsed = JSON.parse(text) as Partial<PairingPayload>;
  } catch {
    throw new Error("That QR code isn't a Telegram backup setup code");
  }
  if (parsed.v !== 1 || !parsed.botToken || !parsed.chatId)
    throw new Error("That QR code is missing the bot token or chat ID");
  return {
    botToken: String(parsed.botToken),
    chatId: String(parsed.chatId),
    extraBotTokens: Array.isArray(parsed.extraBotTokens)
      ? parsed.extraBotTokens.map(String)
      : [],
    ...(parsed.lastUpload && Array.isArray(parsed.lastUpload.messageIds)
      ? { lastUpload: parsed.lastUpload as LastUpload }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */

/** 19 MB — under both the bot upload limit and `getFile`'s 20 MB download cap. */
export const CHUNK_BYTES = 19 * 1024 * 1024;
/** AES-GCM backup containers add a fixed 53-byte header/tag overhead. */
export const ENCRYPTED_BACKUP_OVERHEAD_BYTES = 53;
/** Maximum plaintext shard size that is guaranteed to remain one Telegram document. */
export const SHARD_PLAINTEXT_MAX_BYTES =
  CHUNK_BYTES - ENCRYPTED_BACKUP_OVERHEAD_BYTES;
export const MAX_CHUNK_ATTEMPTS = 5;

/** Pure — how many parts a payload of this size needs. */
export function chunkCount(
  totalBytes: number,
  chunkBytes = CHUNK_BYTES,
): number {
  if (totalBytes <= 0) return 1;
  return Math.ceil(totalBytes / chunkBytes);
}

/** Pure — splits payload bytes into ordered parts. */
export function splitIntoChunks(
  bytes: Uint8Array,
  chunkBytes = CHUNK_BYTES,
): Uint8Array[] {
  if (bytes.length <= chunkBytes) return [bytes];
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    parts.push(
      bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)),
    );
  }
  return parts;
}

/** Pure — joins parts back in the order given. */
export function joinChunks(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Filename-safe form of the session's ISO timestamp. */
export function sessionId(created = new Date()): string {
  return created.toISOString().replace(/[:.]/g, "-");
}

export const BACKUP_NAME_PREFIX = "turf-ledger-full-backup";

/** Pure — the filename for one part. Single-part backups get no part suffix. */
export function chunkFileName(
  session: string,
  part: number,
  total: number,
): string {
  return total === 1
    ? `${BACKUP_NAME_PREFIX}-${session}.zip`
    : `${BACKUP_NAME_PREFIX}-${session}.zip.part${part}of${total}`;
}

/** Pure — the caption every part carries, so the chat history is readable. */
export function chunkCaption(
  session: string,
  part: number,
  total: number,
  deviceLabel: string,
): string {
  const who = deviceLabel ? ` from ${deviceLabel}` : "";
  const raw =
    total === 1
      ? `${BACKUP_NAME_PREFIX} ${session}${who}`
      : `${BACKUP_NAME_PREFIX} ${session}${who} part ${part}/${total}`;
  return raw.length <= 900 ? raw : `${raw.slice(0, 899)}…`;
}

export type ParsedChunkName = { session: string; part: number; total: number };

/**
 * Pure — reads session/part/total back out of a filename. Order of arrival
 * is never trusted; this is what regroups parts after a retry reshuffles
 * them (or a restart interleaves two backup runs).
 */
export function parseChunkName(name: string): ParsedChunkName | null {
  const match =
    /^turf-ledger-full-backup-(.+?)\.zip(?:\.part(\d+)of(\d+))?$/.exec(name);
  if (!match) return null;
  const session = match[1] ?? "";
  const part = match[2];
  const total = match[3];
  if (!part || !total) return { session, part: 1, total: 1 };
  return { session, part: Number(part), total: Number(total) };
}

export type RemoteChunk = {
  fileName: string;
  fileId: string;
  messageId?: number | undefined;
  /** The bot that owns this Telegram file_id. */
  botToken?: string | undefined;
};
export type ChunkGroup = {
  session: string;
  total: number;
  chunks: RemoteChunk[];
};

/**
 * Pure — groups documents seen in the chat by session and returns the newest
 * COMPLETE group (session ids sort lexicographically in time order, since
 * they're ISO timestamps). A half-uploaded run is skipped rather than
 * restored as a truncated zip.
 */
export function latestCompleteGroup(
  documents: RemoteChunk[],
): ChunkGroup | null {
  const bySession = new Map<string, ChunkGroup>();
  for (const doc of documents) {
    const parsed = parseChunkName(doc.fileName);
    if (!parsed) continue;
    const group = bySession.get(parsed.session) ?? {
      session: parsed.session,
      total: parsed.total,
      chunks: [],
    };
    // A session is valid only if every filename agrees on the same total.
    // Never let a later/malformed part silently overwrite the group's total.
    if (parsed.total !== group.total) {
      group.total = -1;
      bySession.set(parsed.session, group);
      continue;
    }
    // Reject impossible part numbers before counting them toward completeness.
    if (parsed.part < 1 || parsed.part > group.total) {
      group.total = -1;
      bySession.set(parsed.session, group);
      continue;
    }
    // De-dupe: a retried part can appear twice in the chat.
    if (!group.chunks.some((c) => c.fileName === doc.fileName))
      group.chunks.push(doc);
    bySession.set(parsed.session, group);
  }

  // Recency = Telegram message_id order (ids increase with time). When a
  // chunk has no message_id (older messages), fall back to discovery order:
  // Array#sort is stable, so equal keys keep arrival order — and getUpdates
  // pages strictly in ascending update_id order, so the LAST complete group
  // is the most recently discovered backup. A lexicographic session sort
  // ranks "old-99" above "new" and defeats the whole drain loop.
  const complete = [...bySession.values()]
    .filter((g) => g.chunks.length === g.total)
    .sort(
      (a, b) =>
        Math.max(...a.chunks.map((c) => c.messageId ?? 0)) -
        Math.max(...b.chunks.map((c) => c.messageId ?? 0)),
    );
  const newest = complete[complete.length - 1];
  if (!newest) return null;
  return {
    ...newest,
    chunks: [...newest.chunks].sort(
      (a, b) =>
        (parseChunkName(a.fileName)?.part ?? 0) -
        (parseChunkName(b.fileName)?.part ?? 0),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Telegram Bot API
 * ------------------------------------------------------------------ */

const API_ROOT = "https://api.telegram.org";

/** Pure — the token used for a given chunk when several bots are configured. */
export function botTokenForChunk(cfg: TelegramConfig, index: number): string {
  const pool = [cfg.botToken, ...(cfg.extraBotTokens ?? []).filter(Boolean)];
  return pool[index % pool.length] ?? cfg.botToken;
}

/** Pure — how long to wait after a 429, from Telegram's own `retry_after`. */
export function retryAfterMs(body: unknown, attempt: number): number {
  const retryAfter = (body as { parameters?: { retry_after?: number } } | null)
    ?.parameters?.retry_after;
  if (typeof retryAfter === "number" && retryAfter > 0)
    return retryAfter * 1000;
  return Math.min(60_000, 3_000 * 2 ** Math.max(0, attempt - 1));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function telegramFetch(
  url: string,
  init?: RequestInit,
  options: { retryNetwork?: boolean; signal?: AbortSignal } = {},
): Promise<Response> {
  const retryNetwork = options.retryNetwork !== false;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, { ...init, signal: options.signal ?? init?.signal });
    } catch {
      if (attempt < MAX_CHUNK_ATTEMPTS)
        await sleep(retryAfterMs(null, attempt));
    }
  }
  throw new Error(
    `Couldn't reach Telegram after ${MAX_CHUNK_ATTEMPTS} attempts — check the internet connection and try again.`,
  );
}

/** Turns a failed Telegram response body into a sentence a person can act on. */
export function telegramErrorMessage(status: number, body: unknown): string {
  const description =
    (body as { description?: string } | null)?.description ?? `HTTP ${status}`;
  if (status === 401)
    return "Telegram rejected the bot token — check it and paste it in again.";
  if (status === 403)
    return "The bot can't post in that chat. Add it to the channel/group and make it an admin that can post messages.";
  if (status === 400 && /chat not found/i.test(description))
    return "Telegram couldn't find that chat ID. Check the chat ID in the setup fields.";
  return `Telegram refused the request: ${description}`;
}

/** One Telegram rate-limit / 5xx wait, reported to progress UIs. */
export type RetryInfo = { attempt: number; max: number; retryAfterMs: number };
export type UploadProgress = { part: number; total: number; phase?: "preparing" | "encrypting" | "uploading" | "downloading" | "verifying" | "restoring-records" | "restoring-photos" | "finalizing"; bytesDone?: number; bytesTotal?: number; retry?: RetryInfo };

export type UploadResult = {
  session: string;
  parts: number;
  messageIds: number[];
};

/**
 * Sends one archive as one logical backup: a single `sendDocument` when it
 * fits, otherwise one `sendDocument` per ~19 MB part, each tagged with the
 * same session id in its filename and caption. 429s wait for Telegram's own
 * `retry_after`; extra bots are round-robined per part to spread the limit.
 */
/**
 * Shared send loop: splits `bytes` into ~19 MB parts and posts each with
 * `sendDocument`, retrying 429/5xx per Telegram's own backoff. Callers
 * supply their own filename/caption naming (`uploadFullBackup` and
 * `uploadYearArchive` each use a different, non-colliding name prefix) so
 * the two archive kinds never get grouped together when restoring. This
 * function only sends — remembering "last upload" pointers is the caller's
 * job, since full backups and year archives keep separate pointers.
 */
async function findRecentTelegramDocumentMessage(
  token: string,
  chatId: string,
  fileName: string,
): Promise<{ messageId: number; fileId: string } | null> {
  try {
    const updates = await callApi<TelegramUpdate[]>(token, "getUpdates", {
      limit: 100,
      allowed_updates: ["message", "channel_post"],
    });
    for (const update of updates ?? []) {
      const post = update.message ?? update.channel_post;
      if (String(post?.chat?.id ?? "") !== String(chatId)) continue;
      if (
        post?.document?.file_name === fileName &&
        typeof post.message_id === "number" &&
        post.document.file_id
      )
        return { messageId: post.message_id, fileId: post.document.file_id };
    }
  } catch {
    // A failed lookup must never turn a recoverable network error into a
    // failed backup; the caller will retry the upload normally.
  }
  return null;
}

async function uploadChunks(
  cfg: TelegramConfig,
  bytes: Uint8Array,
  makeFileName: (part: number, total: number) => string,
  makeCaption: (part: number, total: number) => string,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<{
  messageIds: number[];
  botIndexes: number[];
  fileIds: string[];
  parts: number;
}> {
  const parts = splitIntoChunks(bytes);
  const messageIds: number[] = [];
  const botIndexes: number[] = [];
  const fileIds: string[] = [];
  let bytesDone = 0;

  for (let i = 0; i < parts.length; i++) {
    if (signal?.aborted) throw new DOMException("The backup was cancelled", "AbortError");
    const part = i + 1;
    onProgress?.({ part, total: parts.length, phase: "uploading", bytesDone, bytesTotal: bytes.byteLength });
    const fileName = makeFileName(part, parts.length);
    const caption = makeCaption(part, parts.length);
    const token = botTokenForChunk(cfg, i);

    for (let attempt = 1; ; attempt++) {
      const form = new FormData();
      form.append("chat_id", cfg.chatId);
      form.append("caption", caption);
      form.append(
        "document",
        new Blob([(parts[i] as Uint8Array).slice().buffer as ArrayBuffer], {
          type: "application/zip",
        }),
        fileName,
      );
      let res: Response;
      try {
        // Do not internally retry a state-changing upload. The outer loop
        // first reconciles the exact filename with Telegram, then retries only
        // when the document was not accepted. This closes the duplicate-send
        // window when the HTTP response is lost after Telegram accepted it.
        res = await telegramFetch(
          `${API_ROOT}/bot${token}/sendDocument`,
          {
            method: "POST",
            body: form,
            signal,
          },
          { retryNetwork: false },
        );
      } catch (networkError) {
        // The HTTP response can be lost after Telegram has already accepted
        // the document. Before retrying, look for the exact filename in the
        // bot's recent update queue. This prevents a timeout from producing a
        // duplicate cloud backup part.
        const recovered = await findRecentTelegramDocumentMessage(
          token,
          cfg.chatId,
          fileName,
        );
        if (recovered != null) {
          messageIds.push(recovered.messageId);
          fileIds.push(recovered.fileId);
          botIndexes.push(
            i % (1 + (cfg.extraBotTokens ?? []).filter(Boolean).length),
          );
          break;
        }
        if (attempt < MAX_CHUNK_ATTEMPTS) {
          await sleep(retryAfterMs(null, attempt));
          continue;
        }
        throw networkError;
      }
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: { message_id?: number };
      } | null;

      if (res.ok && body?.ok) {
        bytesDone += (parts[i] as Uint8Array).byteLength;
        onProgress?.({ part, total: parts.length, phase: "uploading", bytesDone, bytesTotal: bytes.byteLength });
        // A successful sendDocument response must include the message ID.
        // Without it we cannot persist the last-upload pointer or reliably
        // recover the exact Telegram message later via forwardMessage.
        if (typeof body.result?.message_id !== "number")
          throw new Error(
            "Telegram accepted the backup upload but did not return a message ID; try the backup again.",
          );
        messageIds.push(body.result.message_id);
        const uploadedFileId = (
          body.result as { document?: { file_id?: string } }
        )?.document?.file_id;
        if (!uploadedFileId)
          throw new Error(
            "Telegram accepted the backup upload but did not return a document file_id; try the backup again.",
          );
        fileIds.push(uploadedFileId);
        botIndexes.push(
          i % (1 + (cfg.extraBotTokens ?? []).filter(Boolean).length),
        );
        break;
      }
      if (res.status >= 500 && attempt < MAX_CHUNK_ATTEMPTS) {
        // A 5xx can arrive after Telegram has accepted the document.
        // Search for the exact filename before resending.
        const recovered = await findRecentTelegramDocumentMessage(
          token,
          cfg.chatId,
          fileName,
        );
        if (recovered != null) {
          messageIds.push(recovered.messageId);
          fileIds.push(recovered.fileId);
          botIndexes.push(
            i % (1 + (cfg.extraBotTokens ?? []).filter(Boolean).length),
          );
          break;
        }
        await sleep(retryAfterMs(body, attempt));
        continue;
      }
      if (res.status === 429 && attempt < MAX_CHUNK_ATTEMPTS) {
        const waitMs = retryAfterMs(body, attempt);
        onProgress?.({ part, total: parts.length, phase: "uploading", bytesDone, bytesTotal: bytes.byteLength, retry: { attempt, max: MAX_CHUNK_ATTEMPTS, retryAfterMs: waitMs } });
        await sleep(waitMs);
        continue;
      }
      throw new Error(telegramErrorMessage(res.status, body));
    }
  }

  return { messageIds, botIndexes, fileIds, parts: parts.length };
}

async function uploadFullBackupImpl(
  cfg: TelegramConfig,
  archiveBytes: Uint8Array,
  options: {
    session?: string;
    deviceLabel?: string;
    onProgress?: (p: UploadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<UploadResult> {
  if (!isTelegramConfigured(cfg))
    throw new Error(
      "Add the bot token and chat ID before backing up to Telegram.",
    );

  const session = options.session ?? sessionId();
  const deviceLabel =
    options.deviceLabel ?? cfg.deviceLabel ?? defaultDeviceLabel();

  const { messageIds, botIndexes, parts } = await uploadChunks(
    cfg,
    archiveBytes,
    (part, total) => chunkFileName(session, part, total),
    (part, total) => chunkCaption(session, part, total, deviceLabel),
    options.onProgress,
    options.signal,
  );

  const uploadInfo = {
    session,
    total: parts,
    messageIds,
    botIndexes,
    at: new Date().toISOString(),
  };
  rememberLastUpload(uploadInfo);
  void pruneOldTelegramBackups(cfg, uploadInfo);
  return { session, parts, messageIds };
}

/* ------------------------------------------------------------------ *
 * Year-archive uploads
 *
 * A year archive is a different artifact from a full backup (only one
 * year's dated rows, no receipt photos) and is restored differently (by
 * year, not "the newest backup"), so it gets its own name prefix and its
 * own "last upload" pointer — keyed per year — rather than reusing
 * `BACKUP_NAME_PREFIX` / `LAST_UPLOAD_KEY`. That keeps a year-archive
 * upload from ever being picked up by `fetchLatestFullBackupArchive`, and
 * vice versa.
 * ------------------------------------------------------------------ */

export const YEAR_ARCHIVE_NAME_PREFIX = "turf-ledger-year-archive";

/** Pure — the filename for one part of one year's archive. */
export function yearArchiveFileName(
  year: number,
  session: string,
  part: number,
  total: number,
): string {
  return total === 1
    ? `${YEAR_ARCHIVE_NAME_PREFIX}-${year}-${session}.zip`
    : `${YEAR_ARCHIVE_NAME_PREFIX}-${year}-${session}.zip.part${part}of${total}`;
}

/** Pure — the caption every part of a year archive carries. */
export function yearArchiveCaption(
  year: number,
  session: string,
  part: number,
  total: number,
  deviceLabel: string,
): string {
  const who = deviceLabel ? ` from ${deviceLabel}` : "";
  return total === 1
    ? `${YEAR_ARCHIVE_NAME_PREFIX} ${year} ${session}${who}`
    : `${YEAR_ARCHIVE_NAME_PREFIX} ${year} ${session}${who} part ${part}/${total}`;
}

export type ParsedYearArchiveName = {
  year: number;
  session: string;
  part: number;
  total: number;
};

/** Pure — reads year/session/part/total back out of a year-archive filename. */
export function parseYearArchiveName(
  name: string,
): ParsedYearArchiveName | null {
  const match = new RegExp(
    `^${YEAR_ARCHIVE_NAME_PREFIX}-(\\d{4})-(.+?)\\.zip(?:\\.part(\\d+)of(\\d+))?$`,
  ).exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const session = match[2] ?? "";
  const part = match[3];
  const total = match[4];
  if (!part || !total) return { year, session, part: 1, total: 1 };
  return { year, session, part: Number(part), total: Number(total) };
}

const YEAR_ARCHIVE_LAST_UPLOAD_PREFIX = "ks:telegram-year-archive-last-";

export type LastYearArchiveUpload = {
  year: number;
  session: string;
  total: number;
  messageIds: number[];
  at: string;
};

function rememberLastYearArchiveUpload(info: LastYearArchiveUpload) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${YEAR_ARCHIVE_LAST_UPLOAD_PREFIX}${info.year}`,
      JSON.stringify(info),
    );
  } catch {
    /* a full/blocked localStorage must not fail an otherwise-good upload */
  }
}

/** The remembered pointer for one year's archive upload, if this device made one. */
export function readLastYearArchiveUpload(
  year: number,
): LastYearArchiveUpload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      `${YEAR_ARCHIVE_LAST_UPLOAD_PREFIX}${year}`,
    );
    return raw ? (JSON.parse(raw) as LastYearArchiveUpload) : null;
  } catch {
    return null;
  }
}

export type UploadYearArchiveResult = {
  year: number;
  session: string;
  parts: number;
  messageIds: number[];
};

/**
 * Sends one year's archive to Telegram, chunked the same way as a full
 * backup. Used by `archive.ts` before it deletes that year's rows locally —
 * the upload is the safety net that makes local deletion acceptable, so
 * this throws (rather than failing silently) on any Telegram error.
 */
async function uploadYearArchiveImpl(
  cfg: TelegramConfig,
  year: number,
  archiveBytes: Uint8Array,
  options: {
    session?: string;
    deviceLabel?: string;
    onProgress?: (p: UploadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<UploadYearArchiveResult> {
  if (!isTelegramConfigured(cfg))
    throw new Error(
      "Add the bot token and chat ID before archiving a year to Telegram.",
    );

  const session = options.session ?? sessionId();
  const deviceLabel =
    options.deviceLabel ?? cfg.deviceLabel ?? defaultDeviceLabel();

  const { messageIds, parts } = await uploadChunks(
    cfg,
    archiveBytes,
    (part, total) => yearArchiveFileName(year, session, part, total),
    (part, total) =>
      yearArchiveCaption(year, session, part, total, deviceLabel),
    options.onProgress,
    options.signal,
  );

  rememberLastYearArchiveUpload({
    year,
    session,
    total: parts,
    messageIds,
    at: new Date().toISOString(),
  });
  return { year, session, parts, messageIds };
}

/* ------------------------------------------------------------------ *
 * Restore side: finding and downloading the latest backup
 * ------------------------------------------------------------------ */

const LAST_UPLOAD_KEY = "ks:telegram-backup-last";
const LAST_UPLOAD_HISTORY_KEY = "ks:telegram-backup-history";
/** Keep a bounded Telegram history so an enabled automatic backup does not
 * grow the private chat forever. Deletion is best-effort and never makes a
 * successful backup fail. */
export const TELEGRAM_BACKUP_RETENTION = 7;

function readUploadHistory(): LastUpload[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LAST_UPLOAD_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as LastUpload[]) : [];
  } catch {
    return [];
  }
}

function rememberUploadHistory(info: LastUpload): LastUpload[] {
  const history = [
    info,
    ...readUploadHistory().filter((x) => x?.session !== info.session),
  ];
  try {
    if (typeof window !== "undefined")
      window.localStorage.setItem(
        LAST_UPLOAD_HISTORY_KEY,
        JSON.stringify(history),
      );
  } catch {
    /* best-effort: failure here is non-fatal */
  }
  return history;
}

async function pruneOldTelegramBackups(
  cfg: TelegramConfig,
  current: LastUpload,
): Promise<void> {
  const history = rememberUploadHistory(current);
  const stale = history.slice(TELEGRAM_BACKUP_RETENTION);
  for (const old of stale) {
    for (let i = 0; i < old.messageIds.length; i++) {
      const token = botTokenForChunk(cfg, old.botIndexes?.[i] ?? 0);
      try {
        await callApi(token, "deleteMessage", {
          chat_id: cfg.chatId,
          message_id: old.messageIds[i],
        });
      } catch {
        /* Telegram may forbid deletion; retention is best-effort. */
      }
    }
  }
  try {
    if (typeof window !== "undefined")
      window.localStorage.setItem(
        LAST_UPLOAD_HISTORY_KEY,
        JSON.stringify(history.slice(0, TELEGRAM_BACKUP_RETENTION)),
      );
  } catch {
    /* best-effort: failure here is non-fatal */
  }
}

export type LastUpload = {
  session: string;
  total: number;
  messageIds: number[];
  /** Bot-pool slot used for each uploaded part; preserves ownership if the pool changes later. */
  botIndexes?: number[];
  at: string;
};

function rememberLastUpload(info: LastUpload) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_UPLOAD_KEY, JSON.stringify(info));
  } catch {
    /* a full/blocked localStorage must not fail an otherwise-good upload */
  }
}

export function readLastUpload(): LastUpload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_UPLOAD_KEY);
    return raw ? (JSON.parse(raw) as LastUpload) : null;
  } catch {
    return null;
  }
}

type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: number | string };
    document?: { file_id?: string; file_name?: string };
    message_id?: number;
  };
  channel_post?: {
    chat?: { id?: number | string };
    document?: { file_id?: string; file_name?: string };
    message_id?: number;
  };
};

/** Pure — pulls backup documents for the configured chat out of a getUpdates payload. */
export function chunksFromUpdates(
  updates: TelegramUpdate[],
  chatId: string,
  botToken?: string,
): RemoteChunk[] {
  const found: RemoteChunk[] = [];
  for (const update of updates) {
    const post = update.message ?? update.channel_post;
    const doc = post?.document;
    if (!doc?.file_id || !doc.file_name) continue;
    if (String(post?.chat?.id ?? "") !== String(chatId)) continue;
    if (!parseChunkName(doc.file_name)) continue;
    const chunk: RemoteChunk = {
      fileName: doc.file_name,
      fileId: doc.file_id,
      ...(botToken ? { botToken } : {}),
    };
    if (typeof post?.message_id === "number") chunk.messageId = post.message_id;
    found.push(chunk);
  }
  return found;
}

async function callApi<T>(
  token: string,
  method: string,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal; onRetry?: (retry: RetryInfo) => void } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await telegramFetch(`${API_ROOT}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }, { signal: options.signal });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
    } | null;
    if (res.ok && body?.ok) return body.result as T;
    if (
      (res.status === 429 || res.status >= 500) &&
      attempt < MAX_CHUNK_ATTEMPTS
    ) {
      const waitMs = retryAfterMs(body, attempt);
      // Observer only: lets the progress bar show a live "retrying in N s".
      try { options.onRetry?.({ attempt, max: MAX_CHUNK_ATTEMPTS, retryAfterMs: waitMs }); } catch { /* observer */ }
      await sleep(waitMs);
      continue;
    }
    throw new Error(telegramErrorMessage(res.status, body));
  }
}

/** Downloads one document's bytes via `getFile` + the file endpoint. */
export async function downloadChunk(
  token: string,
  fileId: string,
  options: { signal?: AbortSignal; onProgress?: (done: number, total?: number) => void; onRetry?: (retry: RetryInfo) => void } = {},
): Promise<Uint8Array> {
  const file = await callApi<{ file_path?: string }>(token, "getFile", {
    file_id: fileId,
  }, { signal: options.signal, onRetry: options.onRetry });
  if (!file?.file_path)
    throw new Error("Telegram didn't return a download path for that part.");
  const res = await telegramFetch(
    `${API_ROOT}/file/bot${token}/${file.file_path}`,
    undefined,
    { signal: options.signal },
  );
  if (!res.ok)
    throw new Error(`Couldn't download a backup part (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length") ?? "");
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    options.onProgress?.(bytes.byteLength, Number.isFinite(total) ? total : undefined);
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    if (options.signal?.aborted) throw new DOMException("The Telegram restore was cancelled before data was written.", "AbortError");
    const part = await reader.read();
    if (part.done) break;
    if (part.value) { chunks.push(part.value); done += part.value.byteLength; options.onProgress?.(done, Number.isFinite(total) ? total : undefined); }
  }
  const bytes = new Uint8Array(done);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Finds the newest complete backup in the chat and returns its reassembled
 * archive bytes.
 *
 * `getUpdates` is the only history a bot can read back, and it only holds
 * recent, un-consumed updates — so the parts sent by THIS device are also
 * remembered locally (`readLastUpload`) and used when the poll comes back
 * empty. Either way the parts are grouped by session id, never by arrival
 * order.
 */
async function fetchLatestFullBackupArchiveImpl(
  cfg: TelegramConfig,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ session: string; bytes: Uint8Array }> {
  if (!isTelegramConfigured(cfg))
    throw new Error(
      "Add the bot token and chat ID before restoring from Telegram.",
    );

  // Telegram keeps getUpdates state per bot token. A backup uploaded with
  // extraBotTokens is therefore split across multiple independent update
  // queues; polling only cfg.botToken can never see the parts sent by the
  // other bots and can incorrectly report that no complete backup exists.
  // Poll every configured bot and combine the matching chat documents before
  // grouping by session.
  const tokens = [cfg.botToken, ...(cfg.extraBotTokens ?? []).filter(Boolean)];
  // A single getUpdates(limit=100) call is not a complete history read. If a
  // bot has more than 100 unconsumed updates, Telegram returns the oldest 100
  // first. Without advancing `offset`, every restore attempt can see the same
  // old batch and miss the newest backup entirely. Drain each bot's queue by
  // advancing past the highest update_id until Telegram returns fewer than 100.
  const pollAllUpdates = async (token: string): Promise<TelegramUpdate[]> => {
    const all: TelegramUpdate[] = [];
    let offset: number | undefined;
    for (;;) {
      const batch = await callApi<TelegramUpdate[]>(token, "getUpdates", {
        ...(offset === undefined ? {} : { offset }),
        limit: 100,
        allowed_updates: ["message", "channel_post"],
      });
      const updates = batch ?? [];
      all.push(...updates);
      if (updates.length < 100) return all;
      const ids = updates
        .map((update) => update.update_id)
        .filter((id): id is number => Number.isInteger(id));
      if (ids.length === 0) return all;
      offset = Math.max(...ids) + 1;
    }
  };
  const updateSets = await Promise.all(tokens.map(pollAllUpdates));
  const discovered = updateSets.flatMap((updates, i) =>
    chunksFromUpdates(updates, cfg.chatId, tokens[i]),
  );
  let group = latestCompleteGroup(discovered);

  if (!group) {
    const last = readLastUpload();
    if (!last || last.messageIds.length !== last.total)
      throw new Error(
        "No complete backup found in that Telegram chat yet. Tap 'Backup now' on the device that has the data, then try again.",
      );
    // Fall back to the pointer this device kept when it uploaded: re-read
    // each remembered message through forwardMessage so we get its file_id
    // back even after getUpdates has aged out.
    const chunks: RemoteChunk[] = [];
    for (let i = 0; i < last.messageIds.length; i++) {
      const forwarded = await callApi<TelegramUpdate["message"]>(
        botTokenForChunk(cfg, last.botIndexes?.[i] ?? i),
        "forwardMessage",
        {
          chat_id: cfg.chatId,
          from_chat_id: cfg.chatId,
          message_id: last.messageIds[i],
        },
      );
      const doc = forwarded?.document;
      if (doc?.file_id && doc.file_name) {
        const chunk: RemoteChunk = {
          fileName: doc.file_name,
          fileId: doc.file_id,
          botToken: botTokenForChunk(cfg, last.botIndexes?.[i] ?? i),
        };
        const mid = last.messageIds[i];
        if (typeof mid === "number") chunk.messageId = mid;
        chunks.push(chunk);
      }
    }
    group = latestCompleteGroup(chunks);
    if (!group)
      throw new Error(
        "Couldn't read the last backup's parts back from Telegram.",
      );
  }

  const parts: Uint8Array[] = [];
  for (let i = 0; i < group.chunks.length; i++) {
    onProgress?.({ part: i + 1, total: group.chunks.length });
    parts.push(
      await downloadChunk(
        group.chunks[i]!.botToken ?? botTokenForChunk(cfg, i),
        group.chunks[i]!.fileId,
        { onRetry: (retry) => onProgress?.({ part: i + 1, total: group.chunks.length, phase: "downloading", retry }) },
      ),
    );
  }
  return { session: group.session, bytes: joinChunks(parts) };
}

/** One-line summary for the single post-restore toast. */
export function restoreSummary(result: RestoreFullBackupResult): string {
  const parts = [
    `${result.rowsRestored} record${result.rowsRestored === 1 ? "" : "s"}`,
    `${result.filesRestored} receipt photo${result.filesRestored === 1 ? "" : "s"}`,
  ];
  if (result.filesSkippedExisting > 0)
    parts.push(
      `${result.filesSkippedExisting} photo(s) already on this device`,
    );
  if (result.filesSkippedUnmatched > 0)
    parts.push(
      `${result.filesSkippedUnmatched} photo(s) didn't match an expense`,
    );
  if (result.filesCorrupted.length > 0)
    parts.push(
      `${result.filesCorrupted.length} photo(s) failed a checksum and were not restored`,
    );
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ *
 * R3: sharded build/restore (version 2 format) — bounded memory,
 * incremental, all-or-nothing per shard.
 * ------------------------------------------------------------------ */

export type ShardedBuildResult = {
  top: FullBackupTopManifest;
  /** One zip per shard, index-aligned with top.shards. */
  shardBytes: Uint8Array[];
  missingFiles: string[];
};

/**
 * Builds a version-2 sharded full backup: photos stream out in per-month
 * shards (capped by SHARD_MAX_PHOTOS and SHARD_MAX_BYTES), each shard zip
 * is generated with `streamFiles` + STORE so peak memory stays at one
 * shard's photos regardless of how many receipts exist. Each generated backup is self-contained. `lastManifest` is accepted for
 * compatibility with older callers, but unchanged files are still included
 * so the newest backup can always be restored independently.
 */
export async function buildShardedFullBackup(
  deviceLabel: string = defaultDeviceLabel(),
  opts: {
    lastManifest?: FullBackupTopManifest | null;
    onShard?:
      ((done: number, total: number) => void | Promise<void>) | undefined;
    /** Called as each shard is finalized; useful for true streaming uploads. */
    onShardBuilt?: (
      bytes: Uint8Array,
      index: number,
      total: number,
    ) => void | Promise<void>;
    collectShards?: boolean;
    onProgress?: (progress: { phase: OpPhase; done?: number; total?: number; bytesDone?: number; bytesTotal?: number }) => void;
  } = {},
): Promise<ShardedBuildResult> {
  opts.onProgress?.({ phase: "reading" });
  // Snapshot the expense/receipt relationship before planning shards. This
  // prevents an edit between planning and byte reads from silently changing
  // which receipt belongs to which expense. The actual table payload remains
  // captured below for shard 1.
  const snap = await db.transaction(
    "r",
    [...DATA_TABLES.map((t) => table(t)), db.receipts, db.receipt_hashes],
    async () => ({
      tables: Object.fromEntries(
        await Promise.all(
          DATA_TABLES.map(async (t) => [
            t,
            (await table(t).toArray()) as Record<string, unknown>[],
          ]),
        ),
      ) as Record<string, Record<string, unknown>[]>,
      expenses: (await db.expenses.toArray()) as ExpenseRow[],
      investments: await db.investments.toArray(),
      bills: (await db.bills.toArray()) as BillRow[],
      receiptRows: await db.receipts.toArray(),
      hashRows: (await db.receipt_hashes.toArray()) as ReceiptHashRow[],
    }),
  );
  const expenses = snap.expenses;
  const investments = snap.investments;
  const byPath = new Map<string, { id: string; spent_at: string }>();
  for (const expense of expenses) {
    if (expense.receipt_path) byPath.set(expense.receipt_path, expense);
  }
  // Bills are also first-class receipt owners. Keep their date in the
  // fallback metadata used for a photo that has no expense owner. Without
  // this, a bill-only receipt could be emitted with the wrong owner context
  // and, more importantly, a missing/corrupt bill photo would not be reflected
  // consistently in the partial-backup guard below.
  for (const bill of snap.bills) {
    if (bill.receipt_path)
      byPath.set(bill.receipt_path, { id: bill.id, spent_at: bill.bill_date });
  }
  const receiptRowsByPath = new Map(snap.receiptRows.map((r) => [r.path, r]));
  const referencedReceiptPaths = new Set(
    [...expenses, ...investments, ...snap.bills]
      .map((row) => row.receipt_path)
      .filter((p): p is string => !!p),
  );
  const receiptMetaRows: Record<string, unknown>[] = [];
  const receiptItemsByPath = new Map<
    string,
    { path: string; spent_at: string; size: number; expense_id?: string }
  >();

  // Include BOTH standalone receipt rows and every expense-referenced path.
  // A missing receipt row must not make an expense photo disappear from the
  // Telegram backup silently.
  for (const expense of expenses) {
    const path =
      typeof expense.receipt_path === "string" ? expense.receipt_path : "";
    if (!path) continue;
    if (!isSafeReceiptPath(path))
      throw new Error(
        `Telegram backup aborted: unsafe receipt path "${path}".`,
      );
    const row = receiptRowsByPath.get(path);
    receiptItemsByPath.set(path, {
      path,
      spent_at: expense.spent_at,
      size: row?.size ?? row?.blob?.size ?? 0,
      expense_id: expense.id,
    });
  }
  for (const investment of investments) {
    const path =
      typeof investment.receipt_path === "string"
        ? investment.receipt_path
        : "";
    if (!path) continue;
    if (!isSafeReceiptPath(path))
      throw new Error(
        `Telegram backup aborted: unsafe receipt path "${path}".`,
      );
    const row = receiptRowsByPath.get(path);
    receiptItemsByPath.set(path, {
      path,
      spent_at: investment.investment_date,
      size: row?.size ?? row?.blob?.size ?? 0,
      expense_id: investment.id,
    });
  }
  // Bills are receipt owners too. Add their references explicitly so a
  // bill-only path with a missing receipt row is preflighted and reported as
  // partial, rather than being invisible to the sharded photo planner.
  for (const bill of snap.bills) {
    const path = typeof bill.receipt_path === "string" ? bill.receipt_path : "";
    if (!path) continue;
    if (!isSafeReceiptPath(path))
      throw new Error(
        `Telegram backup aborted: unsafe receipt path "${path}".`,
      );
    const row = receiptRowsByPath.get(path);
    receiptItemsByPath.set(path, {
      path,
      spent_at: bill.bill_date,
      size: row?.size ?? row?.blob?.size ?? 0,
      expense_id: bill.id,
    });
  }
  for (const r of snap.receiptRows) {
    if (!isSafeReceiptPath(r.path))
      throw new Error(
        `Telegram backup aborted: unsafe receipt path "${r.path}".`,
      );
    receiptMetaRows.push({
      path: r.path,
      size: r.size ?? r.blob?.size ?? 0,
      created_at: r.created_at,
    });
    if (!receiptItemsByPath.has(r.path)) {
      // Standalone imported receipts are valid backup data too. They are
      // grouped by their creation date when no business-row date exists.
      receiptItemsByPath.set(r.path, {
        path: r.path,
        spent_at: byPath.get(r.path)?.spent_at ?? r.created_at.slice(0, 10),
        size: r.size ?? r.blob?.size ?? 0,
      });
    }
  }
  const receiptItems = [...receiptItemsByPath.values()];
  const normalizedReceiptKeys = new Set<string>();
  for (const item of receiptItems) {
    const key = item.path.normalize("NFC").toLowerCase();
    if (normalizedReceiptKeys.has(key))
      throw new Error(
        `Telegram backup aborted: receipt paths collide by case/Unicode normalization ("${item.path}").`,
      );
    normalizedReceiptKeys.add(key);
  }
  const hashRows = snap.hashRows;
  const allReceiptPaths = new Set(snap.receiptRows.map((r) => r.path));
  for (const hash of hashRows) {
    if (!allReceiptPaths.has(hash.path)) {
      throw new Error(
        `Cannot build sharded full backup: receipt hash "${hash.path}" is orphaned.`,
      );
    }
    if (!receiptRowsByPath.has(hash.path)) {
      throw new Error(
        `Cannot build sharded full backup: receipt hash "${hash.path}" has no receipt metadata row.`,
      );
    }
  }
  const hashes = new Map(hashRows.map((h) => [h.path, h.sha256]));
  let planned = planReceiptShards(receiptItems);
  if (planned.length === 0) planned.push([]);
  const JSZip = await loadJSZip();
  const shardBytes: Uint8Array[] = [];
  const shardHashes: string[] = [];
  const shardPhotoCounts: number[] = [];
  const files: FullBackupTopManifest["files"] = [];
  const missingFiles: string[] = [];
  const created = new Date().toISOString();
  const backupId = crypto.randomUUID();

  // Tables/theme/layout/localSettings travel in shard 1 only, same
  // construction as buildFullBackup.
  // Use the same transaction snapshot for every table. Reading tables one by
  // one after the snapshot could otherwise mix pre/post-edit states in shard 1.
  const tables = snap.tables;
  // Node/test environments have no localStorage - capture defensively.
  const ls: Pick<Storage, "length" | "key" | "getItem"> =
    typeof localStorage !== "undefined"
      ? localStorage
      : { length: 0, key: () => null, getItem: () => null };
  const allSettings = captureLocalSettings();
  const theme: Record<string, string | null> = {};
  const layout: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(allSettings)) {
    if (k.startsWith("app-theme-")) theme[k] = v;
    if (
      k.startsWith("ks:layout-") ||
      k === "ks:settings-order-version" ||
      k === "ks:nav-order-version"
    )
      layout[k] = v;
  }
  const localSettings = allSettings;

  // Preflight every receipt before invoking onShardBuilt. Bad photos are
  // excluded from this backup rather than making every other business row
  // un-backupable. The exported table copy explicitly clears those references
  // and the manifest reports the omissions to the caller.
  const unavailable = new Set<string>();
  for (const item of receiptItems) {
    try {
      const bytes = await readReceiptBytes(item.path);
      const known = hashes.get(item.path);
      if (
        known &&
        (await sha256Hex(bytes)).toLowerCase() !== known.toLowerCase()
      )
        unavailable.add(item.path);
    } catch {
      unavailable.add(item.path);
    }
  }
  if (unavailable.size) {
    for (const row of tables["expenses"] ?? []) {
      if (
        typeof row["receipt_path"] === "string" &&
        unavailable.has(row["receipt_path"])
      )
        row["receipt_path"] = null;
    }
    for (const row of tables["investments"] ?? []) {
      if (
        typeof row["receipt_path"] === "string" &&
        unavailable.has(row["receipt_path"])
      )
        row["receipt_path"] = null;
    }
    for (const row of tables["bills"] ?? []) {
      if (
        typeof row["receipt_path"] === "string" &&
        unavailable.has(row["receipt_path"])
      )
        row["receipt_path"] = null;
    }
  }
  missingFiles.push(...unavailable);
  const validReceiptItems = receiptItems.filter(
    (x) => !unavailable.has(x.path),
  );
  planned = planReceiptShards(validReceiptItems);
  if (planned.length === 0) planned.push([]);

  for (let i = 0; i < planned.length; i++) {
    const zip = new JSZip();
    const shardFiles: FullBackupFileEntry[] = [];
    for (const path of planned[i]!) {
      const expense = byPath.get(path);
      const known = hashes.get(path);
      let bytes: Uint8Array;
      try {
        bytes = await readReceiptBytes(path);
      } catch {
        missingFiles.push(path);
        continue;
      }
      const actual = await sha256Hex(bytes);
      if (known && actual.toLowerCase() !== known.toLowerCase()) {
        missingFiles.push(path);
        continue;
      }
      zip.file(path, bytes);
      const entry = buildFileEntry({ path, expense_id: expense?.id }, actual);
      shardFiles.push(entry);
      files.push(entry);
    }
    const manifest: FullBackupShardManifest = {
      format: FULL_BACKUP_FORMAT,
      version: 2,
      shard: i + 1,
      shardCount: planned.length,
      created_at: created,
      device_label: deviceLabel,
      backup_id: backupId,
      schema_version: db.verno,
      app_version: import.meta.env?.["VITE_APP_VERSION"] ?? "r17",
      files: shardFiles,
      tables:
        i === 0
          ? { ...tables, receipts: receiptMetaRows, receipt_hashes: hashRows }
          : null,
      theme: i === 0 ? theme : undefined,
      layout: i === 0 ? layout : undefined,
      localSettings: i === 0 ? localSettings : undefined,
    };
    zip.file(MANIFEST_NAME, JSON.stringify(manifest));
    const builtShard = await zip.generateAsync({
      type: "uint8array",
      streamFiles: true,
      compression: "STORE",
    });
    // A Telegram shard must fit in a single transport document. If one
    // receipt itself is larger than the shard budget, never silently let
    // uploadChunks split it into transport parts: the sharded restore
    // discovery protocol treats one filename as one shard.
    if (builtShard.length > SHARD_PLAINTEXT_MAX_BYTES) {
      throw new Error(
        `Shard ${i + 1} is ${Math.ceil(builtShard.length / 1048576)} MiB after packaging; ` +
          `reduce the receipt size or use the regular disk backup path.`,
      );
    }
    shardPhotoCounts.push(shardFiles.length);
    shardHashes.push(await sha256Hex(builtShard));
    if (opts.collectShards !== false) shardBytes.push(builtShard);
    await opts.onShardBuilt?.(builtShard, i + 1, planned.length);
    await opts.onShard?.(i + 1, planned.length);
  }

  const top: FullBackupTopManifest = {
    format: "turf-snack-ledger-full-manifest",
    version: 2,
    created_at: created,
    device_label: deviceLabel,
    shardCount: planned.length,
    shards: shardHashes.map((sha256, i) => ({
      index: i + 1,
      sha256,
      photoCount: shardPhotoCounts[i] ?? 0,
    })),
    files,
    backup_id: backupId,
    schema_version: db.verno,
    app_version: import.meta.env?.["VITE_APP_VERSION"] ?? "r17",
    theme,
    layout,
    localSettings,
    ...(missingFiles.length
      ? {
          partial: true,
          warnings: [
            `${missingFiles.length} receipt photo(s) were omitted or unreadable`,
          ],
        }
      : {}),
  };
  return { top, shardBytes, missingFiles };
}

export const SHARDED_BACKUP_PREFIX = "turf-ledger-full-shard";
export const SHARDED_MANIFEST_PREFIX = "turf-ledger-full-manifest";

export function shardedShardFileName(
  session: string,
  index: number,
  total: number,
) {
  return `${SHARDED_BACKUP_PREFIX}-${session}.shard${index}of${total}.bin`;
}
export function shardedManifestFileName(session: string) {
  return `${SHARDED_MANIFEST_PREFIX}-${session}.json`;
}
export function parseShardedShardName(
  name: string,
): { session: string; index: number; total: number } | null {
  const m = new RegExp(
    `^${SHARDED_BACKUP_PREFIX}-(.+?)\\.shard(\\d+)of(\\d+)\\.bin$`,
  ).exec(name);
  if (!m) return null;
  const index = Number(m[2]),
    total = Number(m[3]);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    index < 1 ||
    index > total
  )
    return null;
  return { session: m[1]!, index, total };
}
export function parseShardedManifestName(
  name: string,
): { session: string } | null {
  const m = new RegExp(`^${SHARDED_MANIFEST_PREFIX}-(.+?)\\.json$`).exec(name);
  return m ? { session: m[1]! } : null;
}

export type ShardedTelegramUploadResult = {
  session: string;
  shardCount: number;
  messageIds: number[];
  manifestMessageId?: number | undefined;
  missingFiles: string[];
};

/** Uploads the actual R3 shards to Telegram. Each shard is independently
 * encrypted before transport, so restore can download/decrypt/verify one
 * shard at a time instead of rebuilding one multi-GB archive in memory. */
async function uploadShardedFullBackupImpl(
  cfg: TelegramConfig,
  deviceLabel = cfg.deviceLabel ?? defaultDeviceLabel(),
  onProgress?: (p: { shard: number; total: number; phase?: UploadProgress["phase"]; bytesDone?: number; bytesTotal?: number; retry?: UploadProgress["retry"] }) => void,
  signal?: AbortSignal,
): Promise<ShardedTelegramUploadResult> {
  if (!isTelegramConfigured(cfg))
    throw new Error(
      "Add the bot token and chat ID before backing up to Telegram.",
    );
  const session = sessionId();
  const messageIds: number[] = [];
  const botIndexes: number[] = [];
  const shardFileIds: string[] = [];
  try {
  const built = await buildShardedFullBackup(deviceLabel, {
    collectShards: false,
    onShardBuilt: async (plainShard, index, total) => {
      onProgress?.({ shard: index, total, phase: "encrypting", bytesDone: 0, bytesTotal: plainShard.byteLength });
      const encrypted = await encryptFullBackupBytes(plainShard);
      // The plaintext cap above reserves the exact fixed AES-GCM container
      // overhead. Keep this assertion at the transport boundary too: if the
      // encryption format ever changes, we must fail rather than silently
      // split one logical shard into multiple Telegram documents.
      if (encrypted.length > CHUNK_BYTES) {
        throw new Error(
          `Encrypted shard ${index} exceeds the single-document Telegram limit; ` +
            `the shard must be smaller before encryption.`,
        );
      }
      const {
        messageIds: ids,
        botIndexes: indexes,
        fileIds,
      } = await uploadChunks(
        cfg,
        encrypted,
        () => shardedShardFileName(session, index, total),
        () =>
          `Sharded full backup ${session} shard ${index}/${total} from ${deviceLabel}`,
        (progress) => onProgress?.({ shard: index, total, phase: progress.phase, bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal, retry: progress.retry }),
        signal,
      );
      messageIds.push(...ids);
      botIndexes.push(...indexes);
      shardFileIds.push(...fileIds);
    },
    onShard: onProgress
      ? (done, total) => onProgress({ shard: done, total })
      : undefined,
  });
  if (built.missingFiles.length > 0) {
    console.warn(
      `Telegram backup is partial: ${built.missingFiles.length} receipt photo(s) were omitted.`,
      built.missingFiles,
    );
  }
  const shardMessageIds = [...messageIds];
  const shardBotIndexes = [...botIndexes];
  if (
    shardMessageIds.length !== built.top.shardCount ||
    shardBotIndexes.length !== built.top.shardCount ||
    shardFileIds.length !== built.top.shardCount
  ) {
    throw new Error(
      "Telegram backup did not receive exactly one message ID for each shard; refusing to publish an incomplete manifest.",
    );
  }
  const manifestTop: FullBackupTopManifest = {
    ...built.top,
    telegram: { shardMessageIds, shardBotIndexes, shardFileIds },
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifestTop));
  const encryptedManifest = await encryptFullBackupBytes(manifestBytes);
  // The manifest is itself a single logical Telegram document. Never let the
  // generic chunk uploader split it, because restore discovery treats one
  // manifest filename as one manifest.
  if (encryptedManifest.length > CHUNK_BYTES) {
    throw new Error(
      `Encrypted sharded-backup manifest is ${Math.ceil(encryptedManifest.length / 1048576)} MiB and exceeds the single-document Telegram limit.`,
    );
  }
  const { messageIds: manifestIds, botIndexes: manifestBotIndexes } =
    await uploadChunks(
      cfg,
      encryptedManifest,
      () => shardedManifestFileName(session),
      () => `Sharded full backup ${session} manifest from ${deviceLabel}`,
    );
  messageIds.push(...manifestIds);
  botIndexes.push(...manifestBotIndexes);
  const manifestMessageId = manifestIds.at(-1);
  if (typeof manifestMessageId === "number") {
    try {
      const pinToken = botTokenForChunk(cfg, manifestBotIndexes.at(-1) ?? 0);
      await callApi(pinToken, "pinChatMessage", {
        chat_id: cfg.chatId,
        message_id: manifestMessageId,
        disable_notification: true,
      });
    } catch (e) {
      console.warn(
        "Telegram manifest pin failed; exact message ID remains available.",
        e,
      );
    }
  }
  if (typeof manifestMessageId !== "number") {
    // Fail BEFORE recording/pruning: an upload without a usable manifest must
    // never cause older, complete backups to be deleted.
    throw new Error(
      "Telegram backup manifest upload completed without a message ID.",
    );
  }
  const uploadInfo = {
    session,
    total: messageIds.length,
    messageIds,
    botIndexes,
    at: new Date().toISOString(),
  };
  rememberLastUpload(uploadInfo);
  if (built.missingFiles.length === 0) {
    void pruneOldTelegramBackups(cfg, uploadInfo);
  } else {
    // A partial backup (receipt photos omitted) is recorded but must not push
    // older complete backups out of the retention window.
    rememberUploadHistory(uploadInfo);
  }
  return {
    session,
    shardCount: built.top.shardCount,
    messageIds,
    manifestMessageId,
    missingFiles: built.missingFiles,
  };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError" && messageIds.length) {
      for (let i = 0; i < messageIds.length; i++) {
        try {
          await callApi(botTokenForChunk(cfg, botIndexes[i] ?? i), "deleteMessage", { chat_id: cfg.chatId, message_id: messageIds[i] });
        } catch { /* cancellation cleanup is best effort */ }
      }
    }
    throw error;
  }

}

/** Full sharded upload is a migration operation: a backup built while another
 * restore/import is mutating IndexedDB could capture a mixed state and then
 * become the newest Telegram backup. Keep the lock around the entire build +
 * upload + retention publication, not just the restore path. */
export async function uploadFullBackup(
  cfg: TelegramConfig,
  archiveBytes: Uint8Array,
  options: { session?: string; deviceLabel?: string; onProgress?: (p: UploadProgress) => void } = {},
): Promise<UploadResult> {
  const op = beginOp("telegram-upload", "Telegram backup upload");
  let retries = 0; let retryAfterMs: number | undefined;
  const wrappedOptions = { ...options, onProgress: (progress: UploadProgress) => { if (progress.retry) { retries = Math.max(retries, progress.retry.attempt); retryAfterMs = progress.retry.retryAfterMs; } options.onProgress?.(progress); } };
  try { const result = await uploadFullBackupImpl(cfg, archiveBytes, wrappedOptions); op.finish("success", "Telegram backup completed", { parts: { done: result.parts, total: result.parts }, bytes: archiveBytes.byteLength, encrypted: true, ...(retries ? { retries, retryAfterMs } : {}) }); return result; }
  catch (e) { op.finish("error", "Telegram backup failed", { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)), ...(retries ? { retries, retryAfterMs } : {}) }); throw e; }
}

export async function uploadYearArchive(
  cfg: TelegramConfig,
  year: number,
  archiveBytes: Uint8Array,
  options: { session?: string; deviceLabel?: string; onProgress?: (p: UploadProgress) => void } = {},
): Promise<UploadYearArchiveResult> {
  const op = beginOp("telegram-year-archive", `Uploading ${year} archive`);
  let retries = 0; let retryAfterMs: number | undefined;
  const wrappedOptions = { ...options, onProgress: (progress: UploadProgress) => { if (progress.retry) { retries = Math.max(retries, progress.retry.attempt); retryAfterMs = progress.retry.retryAfterMs; } options.onProgress?.(progress); } };
  try { const result = await uploadYearArchiveImpl(cfg, year, archiveBytes, wrappedOptions); op.finish("success", `Year ${year} archive uploaded`, { parts: { done: result.parts, total: result.parts }, bytes: archiveBytes.byteLength, encrypted: true, ...(retries ? { retries, retryAfterMs } : {}) }); return result; }
  catch (e) { op.finish("error", `Year ${year} archive upload failed`, { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)), ...(retries ? { retries, retryAfterMs } : {}) }); throw e; }
}

export async function uploadShardedFullBackup(
  cfg: TelegramConfig,
  deviceLabel = cfg.deviceLabel ?? defaultDeviceLabel(),
  onProgress?: (p: { shard: number; total: number; phase?: UploadProgress["phase"]; bytesDone?: number; bytesTotal?: number; retry?: UploadProgress["retry"] }) => void,
  options: { log?: boolean; signal?: AbortSignal } = {},
): Promise<ShardedTelegramUploadResult> {
  const op = options.log === false ? null : beginOp("telegram-upload", "Telegram backup upload");
  try {
    const result = await withMigrationLock(() => uploadShardedFullBackupImpl(cfg, deviceLabel, onProgress, options.signal));
    op?.finish("success", "Telegram backup completed", { parts: { done: result.shardCount, total: result.shardCount }, encrypted: true });
    return result;
  } catch (e) {
    op?.finish("error", "Telegram backup failed", { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)) });
    throw e;
  }
}

type ShardedRemoteSet = {
  session: string;
  manifest: RemoteChunk;
  shards: RemoteChunk[];
};

function latestCompleteShardedSet(
  documents: RemoteChunk[],
): ShardedRemoteSet | null {
  const sets = new Map<string, ShardedRemoteSet & { total?: number }>();
  for (const doc of documents) {
    const man = parseShardedManifestName(doc.fileName);
    if (man) {
      const set = sets.get(man.session) ?? {
        session: man.session,
        manifest: doc,
        shards: [],
      };
      set.manifest = doc;
      sets.set(man.session, set);
      continue;
    }
    const shard = parseShardedShardName(doc.fileName);
    if (!shard) continue;
    const set = sets.get(shard.session) ?? {
      session: shard.session,
      manifest: null as never,
      shards: [],
    };
    set.total = set.total ?? shard.total;
    if (set.total !== shard.total) continue;
    if (!set.shards.some((x) => x.fileName === doc.fileName))
      set.shards.push(doc);
    sets.set(shard.session, set);
  }
  return (
    [...sets.values()]
      .filter(
        (x) => x.manifest && x.total != null && x.shards.length === x.total,
      )
      .sort((a, b) => (Math.max(...xIds(a)) || 0) - (Math.max(...xIds(b)) || 0))
      .at(-1) ?? null
  );
  function xIds(x: ShardedRemoteSet) {
    return [
      x.manifest.messageId ?? 0,
      ...x.shards.map((s) => s.messageId ?? 0),
    ];
  }
}

/**
 * Replacement-device restore path. Telegram does not expose arbitrary chat
 * history through the Bot API, so a historical backup cannot be discovered
 * reliably with getUpdates alone. The user can paste the Telegram message ID
 * (or a t.me/c/.../<message> link) of the backup manifest. We fetch exactly
 * that message, read its session, then use getUpdates for the shard set only
 * when those messages are still available; otherwise the manifest must carry
 * the shard message IDs. Current uploads therefore also store the shard
 * message IDs in a sidecar manifest index message.
 */
export function parseTelegramMessageLocator(input: string): number {
  const value = input.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/(?:^|\/)\d+$/);
  if (!match)
    throw new Error(
      "Enter a Telegram backup message ID or a copied Telegram message link.",
    );
  const id = Number(match[0].slice(1));
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("Invalid Telegram message ID.");
  return id;
}

export async function fetchShardedFullBackupByMessage(
  cfg: TelegramConfig,
  messageLocator: string,
  options: { signal?: AbortSignal; onProgress?: (p: TelegramRestoreProgress) => void } = {},
): Promise<{
  session: string;
  top: FullBackupTopManifest;
  shards: ShardSource;
}> {
  if (!isTelegramConfigured(cfg))
    throw new Error(
      "Add the bot token and chat ID before restoring from Telegram.",
    );
  const messageId = parseTelegramMessageLocator(messageLocator);
  const tokens = [cfg.botToken, ...(cfg.extraBotTokens ?? []).filter(Boolean)];
  for (let botIndex = 0; botIndex < tokens.length; botIndex++) {
    const token = tokens[botIndex]!;
    try {
      const forwarded = await callApi<TelegramUpdate["message"]>(
        token,
        "forwardMessage",
        {
          chat_id: cfg.chatId,
          from_chat_id: cfg.chatId,
          message_id: messageId,
        },
        { signal: options.signal },
      );
      const doc = forwarded?.document;
      if (!doc?.file_id || !doc.file_name) continue;
      const parsedManifest = parseShardedManifestName(doc.file_name);
      if (!parsedManifest) continue;
      const manifestBytes = await downloadChunk(token, doc.file_id, { signal: options.signal, onRetry: (retry: RetryInfo) => options.onProgress?.({ phase: "downloading", retry }) });
      const top = JSON.parse(
        new TextDecoder().decode(await decryptFullBackupBytes(manifestBytes)),
      ) as FullBackupTopManifest;
      if (
        top.version !== 2 ||
        !Number.isInteger(top.shardCount) ||
        top.shardCount < 1
      )
        throw new Error("Telegram backup manifest is invalid.");

      // R17+ manifests contain exact shard message IDs. This is the durable
      // replacement-device restore path and does not depend on getUpdates
      // history. Older manifests fall back to the historical discovery path.
      if (
        top.telegram &&
        Array.isArray(top.telegram.shardFileIds) &&
        top.telegram.shardFileIds.length === top.shardCount
      ) {
        const shardIds = top.telegram.shardMessageIds ?? [];
        const shardBots = top.telegram.shardBotIndexes ?? [];
        const shardFiles = top.telegram.shardFileIds;
        const ordered: RemoteChunk[] = [];
        for (let i = 0; i < shardIds.length; i++) {
          const shardBotIndex = Number.isInteger(shardBots[i])
            ? shardBots[i]!
            : 0;
          const shardToken = tokens[shardBotIndex];
          if (!shardToken)
            throw new Error(
              `Telegram backup references an unavailable bot for shard ${i + 1}.`,
            );
          const shardFileId = shardFiles[i];
          // file_id itself does not carry the original filename; recover the
          // filename from the manifest shard index convention.
          const shardDocName = shardedShardFileName(
            parsedManifest.session,
            i + 1,
            top.shardCount,
          );
          const parsed = parseShardedShardName(shardDocName);
          if (!shardFileId || !parsed)
            throw new Error(
              `Telegram backup shard ${i + 1} could not be opened.`,
            );
          if (
            !parsed ||
            parsed.session !== parsedManifest.session ||
            parsed.index !== i + 1 ||
            parsed.total !== top.shardCount
          )
            throw new Error(
              `Telegram backup shard ${i + 1} does not match the selected manifest.`,
            );
          ordered.push({
            fileName: shardDocName,
            fileId: shardFileId,
            messageId: shardIds[i],
            botToken: shardToken,
          });
        }
        return {
          session: parsedManifest.session,
          top,
          shards: {
            fetch: async (index) => {
              if (options.signal?.aborted) throw new DOMException("The Telegram restore was cancelled before data was written.", "AbortError");
              const shard = ordered[index];
              if (!shard) return null;
              return decryptFullBackupBytes(
                await downloadChunk(shard.botToken ?? token, shard.fileId, { signal: options.signal, onRetry: (retry: RetryInfo) => options.onProgress?.({ phase: "downloading", retry }) }),
              );
            },
          },
        };
      }

      // Compatibility path for pre-R17 manifests. It can only work while the
      // bot still exposes the old shard messages through getUpdates.
      const found: RemoteChunk[] = [];
      for (const discoveryToken of tokens) {
        let offset: number | undefined;
        for (;;) {
          const updates = await callApi<TelegramUpdate[]>(
            discoveryToken,
            "getUpdates",
            {
              ...(offset == null ? {} : { offset }),
              limit: 100,
              allowed_updates: ["message", "channel_post"],
            },
          );
          for (const update of updates ?? []) {
            const post = update.message ?? update.channel_post;
            const d = post?.document;
            if (
              !d?.file_id ||
              !d.file_name ||
              String(post?.chat?.id ?? "") !== String(cfg.chatId)
            )
              continue;
            const parsed = parseShardedShardName(d.file_name);
            if (parsed?.session === parsedManifest.session)
              found.push({
                fileName: d.file_name,
                fileId: d.file_id,
                messageId: post?.message_id,
                botToken: discoveryToken,
              });
          }
          if (!updates || updates.length < 100) break;
          const ids = updates
            .map((u) => u.update_id)
            .filter((x): x is number => Number.isInteger(x));
          if (!ids.length) break;
          offset = Math.max(...ids) + 1;
        }
      }
      const set = latestCompleteShardedSet([
        {
          fileName: doc.file_name,
          fileId: doc.file_id,
          messageId,
          botToken: token,
        },
        ...found,
      ]);
      if (!set)
        throw new Error(
          "This older Telegram backup has no durable shard index and its shard messages are no longer in Telegram bot update history. Create a fresh R17 backup on the original device.",
        );
      const ordered = [...set.shards].sort(
        (a, b) =>
          parseShardedShardName(a.fileName)!.index -
          parseShardedShardName(b.fileName)!.index,
      );
      return {
        session: set.session,
        top,
        shards: {
          fetch: async (index) => {
            if (options.signal?.aborted) throw new DOMException("The Telegram restore was cancelled before data was written.", "AbortError");
            const shard = ordered[index];
            if (!shard) return null;
            return decryptFullBackupBytes(
              await downloadChunk(shard.botToken ?? token, shard.fileId, { signal: options.signal, onRetry: (retry: RetryInfo) => options.onProgress?.({ phase: "downloading", retry }) }),
            );
          },
        },
      };
    } catch (error) {
      if (botIndex === tokens.length - 1) throw error;
    }
  }
  throw new Error(
    "Telegram backup message could not be opened with the configured bot(s).",
  );
}

async function fetchLatestShardedFullBackupImpl(
  cfg: TelegramConfig,
  options: { onProgress?: (p: TelegramRestoreProgress) => void; signal?: AbortSignal } = {},
): Promise<{
  session: string;
  top: FullBackupTopManifest;
  shards: ShardSource;
}> {
  if (!isTelegramConfigured(cfg))
    throw new Error(
      "Add the bot token and chat ID before restoring from Telegram.",
    );
  if (options.signal?.aborted) throw new DOMException("The Telegram restore was cancelled before data was written.", "AbortError");
  const tokens = [cfg.botToken, ...(cfg.extraBotTokens ?? []).filter(Boolean)];
  const found: RemoteChunk[] = [];
  // Prefer the pinned manifest. This survives replacement-device restore and
  // avoids consuming getUpdates just to locate the newest backup.
  for (const token of tokens) {
    try {
      const chat = await callApi<{
        pinned_message?: TelegramUpdate["message"];
      }>(token, "getChat", { chat_id: cfg.chatId });
      const post = chat.pinned_message;
      const doc = post?.document;
      if (doc?.file_id && doc.file_name) {
        const parsed = parseShardedManifestName(doc.file_name);
        if (parsed) {
          const manifestBytes = await downloadChunk(token, doc.file_id, { signal: options.signal, onRetry: (retry: RetryInfo) => options.onProgress?.({ phase: "downloading", retry }) });
          const top = JSON.parse(
            new TextDecoder().decode(
              await decryptFullBackupBytes(manifestBytes),
            ),
          ) as FullBackupTopManifest;
          if (
            top.version === 2 &&
            top.telegram?.shardFileIds?.length === top.shardCount
          ) {
            const ordered: RemoteChunk[] = top.telegram.shardFileIds.map(
              (fileId, i) => ({
                fileName: shardedShardFileName(
                  parsed.session,
                  i + 1,
                  top.shardCount,
                ),
                fileId,
                messageId: top.telegram?.shardMessageIds?.[i],
                botToken: botTokenForChunk(
                  cfg,
                  top.telegram?.shardBotIndexes?.[i] ?? 0,
                ),
              }),
            );
            return {
              session: parsed.session,
              top,
              shards: {
                fetch: async (index) => {
                  if (options.signal?.aborted) throw new DOMException("The Telegram restore was cancelled before data was written.", "AbortError");
                  const shard = ordered[index];
                  return shard
                    ? decryptFullBackupBytes(
                        await downloadChunk(
                          shard.botToken ?? token,
                          shard.fileId,
                          { signal: options.signal, onRetry: (retry) => options.onProgress?.({ phase: "downloading", retry }) },
                        ),
                      )
                    : null;
                },
              },
            };
          }
        }
      }
    } catch (e) {
      console.warn(
        "Pinned Telegram manifest discovery failed; falling back to legacy discovery.",
        e,
      );
    }
  }
  for (const token of tokens) {
    let offset: number | undefined;
    for (;;) {
      const updates = await callApi<TelegramUpdate[]>(token, "getUpdates", {
        ...(offset == null ? {} : { offset }),
        limit: 100,
        allowed_updates: ["message", "channel_post"],
      });
      for (const update of updates ?? []) {
        const post = update.message ?? update.channel_post;
        const doc = post?.document;
        if (
          !post ||
          !doc?.file_id ||
          !doc.file_name ||
          String(post.chat?.id ?? "") !== String(cfg.chatId)
        )
          continue;
        if (
          !parseShardedShardName(doc.file_name) &&
          !parseShardedManifestName(doc.file_name)
        )
          continue;
        found.push({
          fileName: doc.file_name,
          fileId: doc.file_id,
          ...(typeof post.message_id === "number"
            ? { messageId: post.message_id }
            : {}),
          botToken: token,
        });
      }
      if (!updates || updates.length < 100) break;
      const ids = updates
        .map((u) => u.update_id)
        .filter((x): x is number => Number.isInteger(x));
      if (!ids.length) break;
      offset = Math.max(...ids) + 1;
    }
  }
  let set = latestCompleteShardedSet(found);
  if (!set) {
    const last = readLastUpload();
    if (last && last.messageIds.length === last.total) {
      const docs: RemoteChunk[] = [];
      for (let i = 0; i < last.messageIds.length; i++) {
        const token = botTokenForChunk(cfg, last.botIndexes?.[i] ?? i);
        try {
          const forwarded = await callApi<TelegramUpdate["message"]>(
            token,
            "forwardMessage",
            {
              chat_id: cfg.chatId,
              from_chat_id: cfg.chatId,
              message_id: last.messageIds[i],
            },
          );
          const doc = forwarded?.document;
          if (doc?.file_id && doc.file_name)
            docs.push({
              fileName: doc.file_name,
              fileId: doc.file_id,
              messageId: last.messageIds[i],
              botToken: token,
            });
        } catch {
          /* best-effort: failure here is non-fatal */
        }
      }
      set = latestCompleteShardedSet(docs);
    }
  }
  if (!set)
    throw new Error(
      "No complete sharded backup found in that Telegram chat. The backup may be older than Telegram update history or was not completed.",
    );
  const topBytes = await downloadChunk(
    set.manifest.botToken ?? cfg.botToken,
    set.manifest.fileId,
  );
  const top = JSON.parse(
    new TextDecoder().decode(await decryptFullBackupBytes(topBytes)),
  ) as FullBackupTopManifest;
  if (top.version !== 2 || top.shardCount !== set.shards.length)
    throw new Error("Sharded backup manifest is incomplete or invalid.");
  const ordered = [...set.shards].sort(
    (a, b) =>
      parseShardedShardName(a.fileName)!.index -
      parseShardedShardName(b.fileName)!.index,
  );
  const shards: ShardSource = {
    fetch: async (index) => {
      if (options.signal?.aborted) throw new DOMException("The Telegram restore was cancelled before data was written.", "AbortError");
      const shard = ordered[index];
      if (!shard) return null;
      const encrypted = await downloadChunk(
        shard.botToken ?? cfg.botToken,
        shard.fileId,
        { signal: options.signal, onRetry: (retry) => options.onProgress?.({ phase: "downloading", retry }) },
      );
      return decryptFullBackupBytes(encrypted);
    },
  };
  return { session: set.session, top, shards };
}

/** A pull-based shard source: fetch(i) returns shard i's bytes, or null
 * when done. Backed by an in-memory array, Telegram part downloads, or a
 * file iterator — the restore never needs more than one shard resident
 * (R7: bounded memory at 30k). */
export type ShardSource = {
  fetch(index: number): Promise<Uint8Array | null>;
};

export type TelegramRestoreProgress = {
  phase: "downloading" | "verifying" | "restoring-records" | "restoring-photos" | "finalizing";
  done?: number;
  total?: number;
  label?: string;
  /** Present only while a download is waiting out a Telegram 429/5xx. */
  retry?: RetryInfo;
};

type TelegramRestoreJournal = {
  backupId: string;
  mode: "replace" | "merge";
  completedShards: number[];
  completedPhotos: string[];
  dbCommitted?: boolean;
  phase?: "committed" | "rollingBack";
  /** Durable pre-restore snapshot used to recover after a process restart. */
  snapshotKey?: string;
  oldReceiptPaths?: string[];
  oldReceiptHashes?: ReceiptHashRow[];
  oldSettings?: Record<string, string | null>;
  inFlightPhotos?: string[];
  updatedAt: string;
};

const telegramRestoreJournalKey = (backupId: string) =>
  `__telegram_restore__:${backupId}`;

async function readTelegramRestoreJournal(
  backupId: string,
): Promise<TelegramRestoreJournal | null> {
  if (!backupId) return null;
  const row = await db.app_settings.get(telegramRestoreJournalKey(backupId));
  if (!row || typeof row.value !== "string") return null;
  try {
    const parsed = JSON.parse(row.value) as TelegramRestoreJournal;
    return parsed.backupId === backupId &&
      Array.isArray(parsed.completedShards) &&
      Array.isArray(parsed.completedPhotos)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function writeTelegramRestoreJournal(
  journal: TelegramRestoreJournal,
): Promise<void> {
  await db.app_settings.put({
    key: telegramRestoreJournalKey(journal.backupId),
    value: JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }),
  } as never);
}

const telegramSnapshotKey = (backupId: string) =>
  `__telegram_restore_snapshot__:${backupId}`;

async function writeTelegramRecoverySnapshot(
  backupId: string,
  tables: Record<string, Record<string, unknown>[]>,
): Promise<void> {
  const key = telegramSnapshotKey(backupId);
  await db.app_settings.put({
    key,
    value: JSON.stringify({ tables }),
  } as never);
}

async function readTelegramRecoverySnapshot(
  backupId: string,
): Promise<Record<string, Record<string, unknown>[]> | null> {
  const row = await db.app_settings.get(telegramSnapshotKey(backupId));
  if (!row || typeof row.value !== "string") return null;
  try {
    const parsed = JSON.parse(row.value) as {
      tables?: Record<string, Record<string, unknown>[]>;
    };
    return parsed.tables && typeof parsed.tables === "object"
      ? parsed.tables
      : null;
  } catch {
    return null;
  }
}

async function deleteTelegramRecoverySnapshot(backupId: string): Promise<void> {
  await db.app_settings.delete(telegramSnapshotKey(backupId));
}

/** Recover a Telegram restore that was interrupted by process death. The
 * snapshot contains only DB metadata; receipt bytes are never copied.
 * Incoming photos are removed from the journaled in-flight/completed set,
 * while pre-existing paths are preserved. */
export async function recoverPendingTelegramRestoreSessions(): Promise<void> {
  const rows = await db.app_settings.toArray();
  for (const row of rows) {
    if (
      !row.key.startsWith("__telegram_restore__:") ||
      typeof row.value !== "string"
    )
      continue;
    try {
      const journal = JSON.parse(row.value) as TelegramRestoreJournal;
      if (!journal?.backupId || !journal.snapshotKey) continue;
      const snapshot = await readTelegramRecoverySnapshot(journal.backupId);
      if (!snapshot) continue;
      const oldPaths = new Set(journal.oldReceiptPaths ?? []);
      const incoming = new Set([
        ...(journal.completedPhotos ?? []),
        ...(journal.inFlightPhotos ?? []),
      ]);
      for (const path of incoming) {
        if (oldPaths.has(path)) continue;
        try {
          if (isDesktop()) await removeAppDocument(path);
        } catch {
          /* best-effort: failure here is non-fatal */
        }
        try {
          await db.receipts.delete(path);
        } catch {
          /* best-effort: failure here is non-fatal */
        }
      }
      await db.transaction(
        "rw",
        DATA_TABLES.map((t) => table(t)),
        async () => {
          for (const t of DATA_TABLES) {
            const target = table(t);
            await target.clear();
            const rowsForTable = snapshot[t] ?? [];
            if (rowsForTable.length) await target.bulkAdd(rowsForTable);
          }
        },
      );
      await db.receipt_hashes.clear();
      if (journal.oldReceiptHashes?.length)
        await db.receipt_hashes.bulkPut(journal.oldReceiptHashes);
      if (typeof window !== "undefined") {
        for (const k of Object.keys(window.localStorage)) {
          if (
            (k.startsWith("ks:") ||
              k.startsWith("app-") ||
              k.startsWith("sn-")) &&
            !k.startsWith("ks:telegram-backup") &&
            !/(token|passphrase|password|secret|api[-_]?key|credential|private[-_]?key|access[-_]?key)/i.test(
              k,
            )
          )
            window.localStorage.removeItem(k);
        }
        for (const [k, v] of Object.entries(journal.oldSettings ?? {}))
          if (v != null) window.localStorage.setItem(k, v);
      }
      await deleteTelegramRecoverySnapshot(journal.backupId);
      await db.app_settings.delete(telegramRestoreJournalKey(journal.backupId));
    } catch (error) {
      console.error("Failed to recover an interrupted Telegram restore", error);
    }
  }
}

async function restoreFullBackupShardedImpl(
  shards: Uint8Array[] | ShardSource,
  mode: "replace" | "merge" = "replace",
  top?: FullBackupTopManifest | null,
  onProgress?: (p: TelegramRestoreProgress) => void,
  signal?: AbortSignal,
): Promise<RestoreFullBackupResult> {
  const JSZip = await loadJSZip();
  const result: RestoreFullBackupResult = {
    rowsRestored: 0,
    filesRestored: 0,
    filesSkippedExisting: 0,
    filesCorrupted: [],
    filesSkippedUnmatched: 0,
  };
  const source: ShardSource = Array.isArray(shards)
    ? { fetch: async (i) => shards[i] ?? null }
    : shards;
  const backupId = String(top?.backup_id ?? "");
  if (top?.partial) {
    throw new Error(
      `This Telegram backup is marked partial${top.warnings?.length ? `: ${top.warnings.join("; ")}` : ""}. Complete the backup before restoring it.`,
    );
  }
  if (mode === "merge" && backupId) {
    const marker = await db.app_settings.get(
      `__migration_imported__:${backupId}`,
    );
    if (marker) return result;
  }
  const journal = backupId ? await readTelegramRestoreJournal(backupId) : null;
  const completedPhotos = new Set(journal?.completedPhotos ?? []);
  const completed = new Set(journal?.completedShards ?? []);

  // Phase 1: validate every shard and collect ONLY table rows/metadata. Photo
  // bytes are never retained across shards, so a 30k-photo backup stays bounded.
  const aggregatedTables: Record<string, Record<string, unknown>[]> = {};
  const aggregatedReceiptHashes: ReceiptHashRow[] = [];
  const aggregatedReceiptMeta: Array<{
    path: string;
    size?: number;
    created_at?: string;
  }> = [];
  const incomingPhotoHashes = new Map<string, string>();
  let shardOneSettings:
    | Pick<FullBackupShardManifest, "theme" | "layout" | "localSettings">
    | undefined;
  // Build the complete incoming-photo set during preflight. This must include
  // shards already checkpointed before a process restart; otherwise replace
  // cleanup could mistake successfully restored photos for stale files.
  const validatedIncomingPhotoPaths = new Set<string>();
  const validatedIncomingPhotoKeys = new Set<string>();
  let validatedCount = 0;
  let expectedCount = top?.shardCount ?? Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < expectedCount; i++) {
    if (signal?.aborted) throw new DOMException("The Telegram restore was cancelled before data was written.", "AbortError");
    onProgress?.({ phase: "downloading", done: i, total: expectedCount === Number.MAX_SAFE_INTEGER ? undefined : expectedCount, label: `Downloading backup part ${i + 1}` });
    const bytes = await source.fetch(i);
    if (bytes === null || bytes.length === 0) break;
    if (
      top?.shards[i] &&
      (await sha256Hex(bytes)).toLowerCase() !==
        top.shards[i]!.sha256.toLowerCase()
    )
      throw new Error(
        `Shard ${i + 1} failed its top-manifest checksum; nothing was restored.`,
      );
    const z = await JSZip.loadAsync(bytes);
    const me = z.files[MANIFEST_NAME];
    if (!me || me.dir)
      throw new Error(`Shard ${i + 1} has no manifest; nothing was restored.`);
    const m = parseFullBackupManifest(
      await me.async("string"),
    ) as FullBackupShardManifest;
    if (m.version !== 2 || m.shard !== i + 1)
      throw new Error(
        `Shard ${i + 1} is missing or out of order; nothing was restored.`,
      );
    if (top && m.shardCount !== top.shardCount)
      throw new Error(
        `Shard ${i + 1} has an inconsistent shard count; nothing was restored.`,
      );
    // Without a top manifest the shards themselves declare how many exist.
    // Trust the first declaration and require every later shard to agree, so a
    // missing middle/last shard can never be mistaken for the end of the set.
    if (!top) {
      if (
        typeof m.shardCount !== "number" ||
        !Number.isSafeInteger(m.shardCount) ||
        m.shardCount < 1
      )
        throw new Error(
          `Shard ${i + 1} does not declare a valid shard count; nothing was restored.`,
        );
      if (expectedCount === Number.MAX_SAFE_INTEGER)
        expectedCount = m.shardCount;
      else if (m.shardCount !== expectedCount)
        throw new Error(
          `Shard ${i + 1} has an inconsistent shard count; nothing was restored.`,
        );
    }
    for (const f of m.files) {
      if (!isSafeReceiptPath(f.path))
        throw new Error(
          `Shard ${i + 1} contains an unsafe receipt path; nothing was restored.`,
        );
      const normalizedPath = f.path.normalize("NFC").toLowerCase();
      if (validatedIncomingPhotoKeys.has(normalizedPath))
        throw new Error(
          `Telegram backup contains duplicate receipt path ${f.path}; nothing was restored.`,
        );
      validatedIncomingPhotoKeys.add(normalizedPath);
      validatedIncomingPhotoPaths.add(f.path);
      const ze = z.files[f.path];
      if (!ze || ze.dir)
        throw new Error(
          `Shard ${i + 1} is missing receipt photo ${f.path}; nothing was restored.`,
        );
      const photo = await ze.async("uint8array");
      const actualPhotoHash = await sha256Hex(photo);
      if (actualPhotoHash.toLowerCase() !== f.sha256.toLowerCase())
        throw new Error(
          `Shard ${i + 1} receipt photo ${f.path} failed checksum; nothing was restored.`,
        );
      incomingPhotoHashes.set(f.path, actualPhotoHash);
    }
    if (m.shard === 1) {
      shardOneSettings = {
        theme: m.theme,
        layout: m.layout,
        localSettings: m.localSettings,
      };
    }
    if (m.tables) {
      for (const [tableName, rows] of Object.entries(m.tables)) {
        if (tableName === "receipt_hashes") {
          aggregatedReceiptHashes.push(...((rows ?? []) as ReceiptHashRow[]));
          continue;
        }
        if (tableName === "receipts") {
          aggregatedReceiptMeta.push(
            ...((rows ?? []) as Array<{
              path: string;
              size?: number;
              created_at?: string;
            }>),
          );
          continue;
        }
        if (!aggregatedTables[tableName]) aggregatedTables[tableName] = [];
        aggregatedTables[tableName].push(
          ...((rows ?? []) as Record<string, unknown>[]),
        );
      }
    }
    validatedCount++;
    onProgress?.({ phase: "verifying", done: validatedCount, total: expectedCount === Number.MAX_SAFE_INTEGER ? validatedCount : expectedCount, label: `Verified backup part ${validatedCount}${expectedCount !== Number.MAX_SAFE_INTEGER ? `/${expectedCount}` : ""}` });
    if (!top && bytes.length === 0) break;
  }
  if (validatedCount !== expectedCount)
    throw new Error(
      `Telegram backup is incomplete: expected ${expectedCount === Number.MAX_SAFE_INTEGER ? "at least one" : expectedCount} shard(s), received ${validatedCount}. Nothing was restored.`,
    );

  const incomingReferencedReceiptPaths = new Set<string>();
  for (const tableName of ["expenses", "investments", "bills"] as const) {
    for (const row of aggregatedTables[tableName] ?? []) {
      if (typeof row["receipt_path"] === "string" && row["receipt_path"])
        incomingReferencedReceiptPaths.add(row["receipt_path"]);
    }
  }
  const incomingReceiptMetaByPath = new Map(
    aggregatedReceiptMeta.map((r) => [r.path, r]),
  );
  for (const meta of aggregatedReceiptMeta) {
    if (!isSafeReceiptPath(meta.path))
      throw new Error(
        `Telegram backup contains an unsafe receipt metadata path "${meta.path}"; nothing was restored.`,
      );
    if (!incomingPhotoHashes.has(meta.path))
      throw new Error(
        `Telegram backup is missing receipt photo bytes for "${meta.path}"; nothing was restored.`,
      );
  }
  for (const path of incomingReferencedReceiptPaths) {
    if (!incomingReceiptMetaByPath.has(path) || !incomingPhotoHashes.has(path))
      throw new Error(
        `Telegram backup receipt reference "${path}" has no complete metadata/photo pair; nothing was restored.`,
      );
  }
  const seenHashPaths = new Set<string>();
  for (const hash of aggregatedReceiptHashes) {
    if (seenHashPaths.has(hash.path))
      throw new Error(
        `Telegram backup contains duplicate receipt hash "${hash.path}"; nothing was restored.`,
      );
    seenHashPaths.add(hash.path);
    const actual = incomingPhotoHashes.get(hash.path);
    if (!actual || actual.toLowerCase() !== String(hash.sha256).toLowerCase())
      throw new Error(
        `Telegram backup receipt hash does not match photo "${hash.path}"; nothing was restored.`,
      );
    if (!incomingReceiptMetaByPath.has(hash.path))
      throw new Error(
        `Telegram backup receipt hash "${hash.path}" has no receipt metadata; nothing was restored.`,
      );
  }
  // A source containing more shards than the manifest declares is also invalid:
  // silently ignoring an extra shard can hide a split/duplicate backup set.
  if (expectedCount !== Number.MAX_SAFE_INTEGER) {
    const extraShard = await source.fetch(expectedCount);
    if (extraShard !== null && extraShard.length > 0)
      throw new Error(
        `Telegram backup contains an unexpected extra shard after ${expectedCount}; nothing was restored.`,
      );
  }

  if (signal?.aborted) throw new DOMException("The Telegram restore was cancelled before data was written.", "AbortError");

  // Snapshot only the relatively small table state. Receipt bytes are kept in
  // place during the transaction; this is what lets a failed Telegram restore
  // roll back without buffering 3–4.5 GB of photos.
  const tableSnapshot: Record<string, Record<string, unknown>[]> = {};
  for (const t of DATA_TABLES)
    tableSnapshot[t] = (await table(t).toArray()) as Record<string, unknown>[];
  const oldSettings = captureLocalSettings();
  const oldReceiptHashes = await db.receipt_hashes.toArray();
  const oldReceiptPaths = new Set(
    (await db.receipts.toCollection().primaryKeys()).map(String),
  );
  // Persist the rollback metadata BEFORE mutating the live DB. This is the
  // durable boundary missing from an in-memory-only Telegram rollback.
  if (backupId) await writeTelegramRecoverySnapshot(backupId, tableSnapshot);
  const incomingPhotoPaths = new Set(validatedIncomingPhotoPaths);
  const newlyWrittenPhotoPaths = new Set<string>();

  // One metadata transaction for the entire Telegram backup. This removes the
  // old per-shard commit boundary: either all business tables are imported, or
  // the pre-restore table snapshot is put back.
  const aggregateBackup: BackupFile = {
    format: "turf-snack-ledger",
    backup_id: backupId || crypto.randomUUID(),
    schema_version: top?.schema_version,
    app_version: top?.app_version,
    version: 5,
    exported_at: new Date().toISOString(),
    tables: aggregatedTables,
    photo_manifest: [],
    receipt_hashes: [],
    theme: top?.theme ?? shardOneSettings?.theme,
    layout: top?.layout ?? shardOneSettings?.layout,
    localSettings: top?.localSettings ?? shardOneSettings?.localSettings,
  };
  if (backupId)
    await writeTelegramRestoreJournal({
      backupId,
      mode,
      completedShards: [],
      completedPhotos: [],
      dbCommitted: false,
      phase: "committed",
      snapshotKey: telegramSnapshotKey(backupId),
      oldReceiptPaths: [...oldReceiptPaths],
      oldReceiptHashes,
      oldSettings,
      inFlightPhotos: [],
      updatedAt: new Date().toISOString(),
    });

  setInternalRestoreOptions(aggregateBackup, {
    preserveReceiptsDuringRestore: true,
    suppressImportMarker: true,
    restoreCommitJournalKey: backupId
      ? telegramRestoreJournalKey(backupId)
      : undefined,
    restoreCommitJournalValue: backupId
      ? JSON.stringify({
          backupId,
          mode,
          completedShards: [],
          completedPhotos: [...completedPhotos],
          dbCommitted: true,
          phase: "committed",
          updatedAt: new Date().toISOString(),
        })
      : undefined,
  });

  try {
    // A journal marked rollingBack means the previous attempt crashed while
    // undoing its metadata. Re-run the metadata import from the validated
    // backup rather than trusting a partially restored database.
    onProgress?.({ phase: "restoring-records", done: 0, total: DATA_TABLES.length, label: "Restoring records" });
    if (!journal?.dbCommitted || journal.phase === "rollingBack") {
      result.rowsRestored = await restoreBackup(aggregateBackup, mode, {
        alreadyLocked: true,
        onProgress: (progress) => onProgress?.({ phase: progress.phase === "restoring-photos" ? "restoring-photos" : progress.phase === "restoring-records" ? "restoring-records" : progress.phase === "verifying" ? "verifying" : "restoring-records", done: progress.done, total: progress.total, label: progress.label }),
      });
    }
    onProgress?.({ phase: "restoring-records", done: DATA_TABLES.length, total: DATA_TABLES.length, label: `Restored records (${result.rowsRestored.toLocaleString()} rows)` });
    if (aggregatedReceiptHashes.length) {
      await db.transaction("rw", [db.receipt_hashes], async () => {
        if (mode === "replace") await db.receipt_hashes.clear();
        if (aggregatedReceiptHashes.length)
          await db.receipt_hashes.bulkPut(aggregatedReceiptHashes);
      });
    }

    onProgress?.({ phase: "restoring-photos", done: 0, total: validatedIncomingPhotoPaths.size, label: `Restoring receipt photos (0/${validatedIncomingPhotoPaths.size})` });
    // Apply photos shard-by-shard. Every photo is checksum-verified before it
    // is committed. On an ordinary failure, newly-created photos are removed
    // and all business tables are restored from the pre-restore snapshot.
    let photoDone = 0;
    for (let i = 0; i < validatedCount; i++) {
      // Revisit every shard on retry. Durable checkpoints are informational only;
      // storage is revalidated below so a crash or external deletion cannot turn
      // a completed checkpoint into a silently missing receipt.
      const shardBytes = await source.fetch(i);
      if (!shardBytes)
        throw new Error(`Telegram shard ${i + 1} disappeared during restore.`);
      const zip = await JSZip.loadAsync(shardBytes);
      const manifest = parseFullBackupManifest(
        await zip.files[MANIFEST_NAME]!.async("string"),
      ) as FullBackupShardManifest;
      for (const f of manifest.files) {
        if (backupId)
          await writeTelegramRestoreJournal({
            backupId,
            mode,
            completedShards: [...completed].sort((a, b) => a - b),
            completedPhotos: [...completedPhotos],
            dbCommitted: true,
            phase: "committed",
            snapshotKey: telegramSnapshotKey(backupId),
            oldReceiptPaths: [...oldReceiptPaths],
            oldReceiptHashes,
            oldSettings,
            inFlightPhotos: [f.path],
            updatedAt: new Date().toISOString(),
          });
        // Do not trust a completed-photo checkpoint by itself. Verify the
        // destination below so a missing/corrupt file is restored on retry.
        const ze = zip.files[f.path];
        if (!ze || ze.dir)
          throw new Error(`Shard ${i + 1} is missing receipt photo ${f.path}.`);
        const bytes = await ze.async("uint8array");
        if ((await sha256Hex(bytes)).toLowerCase() !== f.sha256.toLowerCase())
          throw new Error(
            `Shard ${i + 1} receipt photo ${f.path} failed checksum.`,
          );
        incomingPhotoPaths.add(f.path);
        if (isDesktop()) {
          // Never destructively overwrite an existing Telegram receipt during
          // the photo phase. A same-path receipt must be byte-identical; a
          // different file is a fail-closed conflict, leaving the old file
          // available for the rollback boundary.
          if (await appDocumentExists(f.path)) {
            const existing = await readAppDocument(f.path);
            if (
              existing.length !== bytes.length ||
              (await sha256Hex(existing)).toLowerCase() !==
                f.sha256.toLowerCase()
            )
              throw new Error(
                `Telegram restore conflict: existing receipt ${f.path} differs from the backup.`,
              );
            // A crash during rollback can leave the file while its DB row has
            // already been restored away. Recreate the row instead of treating
            // the matching file as a completed restore.
            if (!(await db.receipts.get(f.path))) {
              await db.receipts.put({
                path: f.path,
                size: bytes.length,
                created_at:
                  incomingReceiptMetaByPath.get(f.path)?.created_at ??
                  new Date().toISOString(),
              });
              result.filesRestored++;
            } else {
              result.filesSkippedExisting++;
            }
            completedPhotos.add(f.path);
            photoDone++;
            onProgress?.({ phase: "restoring-photos", done: photoDone, total: validatedIncomingPhotoPaths.size, label: `Restoring receipt photos (${photoDone}/${validatedIncomingPhotoPaths.size})` });
            continue;
          }
          await saveToAppDocuments(f.path, bytes);
          newlyWrittenPhotoPaths.add(f.path);
          await db.receipts.put({
            path: f.path,
            size: bytes.length,
            created_at:
              incomingReceiptMetaByPath.get(f.path)?.created_at ??
              new Date().toISOString(),
          });
        } else {
          const existing = await db.receipts.get(f.path);
          if (existing) {
            const existingBlob =
              existing.blob instanceof Blob
                ? new Uint8Array(await existing.blob.arrayBuffer())
                : null;
            if (
              !existingBlob ||
              existingBlob.length !== bytes.length ||
              (await sha256Hex(existingBlob)).toLowerCase() !==
                f.sha256.toLowerCase()
            )
              throw new Error(
                `Telegram restore conflict: existing receipt ${f.path} differs from the backup.`,
              );
            result.filesSkippedExisting++;
            completedPhotos.add(f.path);
            photoDone++;
            onProgress?.({ phase: "restoring-photos", done: photoDone, total: validatedIncomingPhotoPaths.size, label: `Restoring receipt photos (${photoDone}/${validatedIncomingPhotoPaths.size})` });
            continue;
          }
          await db.receipts.put({
            path: f.path,
            blob: new Blob([bytes.slice().buffer as ArrayBuffer], {
              type: receiptMimeType(f.path),
            }),
            size: bytes.length,
            created_at:
              incomingReceiptMetaByPath.get(f.path)?.created_at ??
              new Date().toISOString(),
          });
          newlyWrittenPhotoPaths.add(f.path);
        }
        result.filesRestored++;
        completedPhotos.add(f.path);
        photoDone++;
        onProgress?.({ phase: "restoring-photos", done: photoDone, total: validatedIncomingPhotoPaths.size, label: `Restoring receipt photos (${photoDone}/${validatedIncomingPhotoPaths.size})` });
      }
      completed.add(i);
      if (backupId)
        await writeTelegramRestoreJournal({
          backupId,
          mode,
          completedShards: [...completed].sort((a, b) => a - b),
          completedPhotos: [...completedPhotos],
          dbCommitted: true,
          phase: "committed",
          snapshotKey: telegramSnapshotKey(backupId),
          oldReceiptPaths: [...oldReceiptPaths],
          oldReceiptHashes,
          oldSettings,
          inFlightPhotos: [],
          updatedAt: new Date().toISOString(),
        });
    }

    // The incoming restore is complete. Do not delete stale old receipts until
    // the durable recovery snapshot has been removed; a process kill during
    // cleanup must never make rollback impossible.
    if (mode === "replace") {
      await db.receipt_hashes.clear();
      if (aggregatedReceiptHashes.length)
        await db.receipt_hashes.bulkPut(aggregatedReceiptHashes);
    }
    if (backupId) {
      await db.transaction("rw", [db.app_settings], async () => {
        if (mode === "merge")
          await db.app_settings.put({
            key: `__migration_imported__:${backupId}`,
            value: new Date().toISOString(),
          } as never);
        await db.app_settings.delete(telegramRestoreJournalKey(backupId));
        await db.app_settings.delete(telegramSnapshotKey(backupId));
      });
    }
    // Cleanup is deliberately last. If the process dies here, only orphaned
    // old receipt files/metadata can remain; the committed restore is durable.
    if (mode === "replace") {
      const keep = incomingPhotoPaths;
      for (const path of oldReceiptPaths) {
        if (keep.has(path)) continue;
        if (isDesktop()) {
          try {
            await removeAppDocument(path);
          } catch {
            /* best-effort: failure here is non-fatal */
          }
        }
        await db.receipts.delete(path);
      }
    }
    return result;
  } catch (e) {
    // Make rollback itself crash-recoverable. A rollingBack journal tells the
    // next attempt to re-apply metadata from the validated backup instead of
    // assuming that a process killed halfway through rollback left the old
    // database intact.
    if (backupId) {
      try {
        await writeTelegramRestoreJournal({
          backupId,
          mode,
          // Rollback removes the incoming photo set and restores the old DB,
          // so none of the previous completion checkpoints are valid for a
          // subsequent fresh restore.
          completedShards: [],
          completedPhotos: [],
          dbCommitted: false,
          phase: "rollingBack",
          snapshotKey: telegramSnapshotKey(backupId),
          oldReceiptPaths: [...oldReceiptPaths],
          oldReceiptHashes,
          oldSettings,
          inFlightPhotos: [],
          updatedAt: new Date().toISOString(),
        });
      } catch {
        /* preserve the original restore error */
      }
    }
    // Remove every incoming receipt that did not belong to the pre-restore
    // state. Existing merge receipts were never overwritten.
    for (const path of newlyWrittenPhotoPaths) {
      try {
        if (isDesktop()) await removeAppDocument(path);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
      try {
        await db.receipts.delete(path);
      } catch {
        /* best-effort: failure here is non-fatal */
      }
    }
    // Restore all business tables in one transaction. This is intentionally
    // independent of photo size and therefore remains bounded for 30k photos.
    let rollbackSucceeded = false;
    try {
      await db.transaction(
        "rw",
        DATA_TABLES.map((t) => table(t)),
        async () => {
          for (const t of DATA_TABLES) {
            await table(t).clear();
            const rows = tableSnapshot[t] ?? [];
            if (rows.length) await table(t).bulkAdd(rows);
          }
        },
      );
      await db.receipt_hashes.clear();
      if (oldReceiptHashes.length)
        await db.receipt_hashes.bulkPut(oldReceiptHashes);
      if (typeof window !== "undefined") {
        for (const k of Object.keys(window.localStorage)) {
          if (
            (k.startsWith("ks:") ||
              k.startsWith("app-") ||
              k.startsWith("sn-")) &&
            !k.startsWith("ks:telegram-backup") &&
            !/(token|passphrase|password|secret|api[-_]?key|credential|private[-_]?key|access[-_]?key)/i.test(
              k,
            )
          )
            window.localStorage.removeItem(k);
        }
        for (const [k, v] of Object.entries(oldSettings))
          if (v != null) window.localStorage.setItem(k, v);
      }
      rollbackSucceeded = true;
    } catch {
      // Keep the durable rollingBack journal when rollback itself fails. A
      // subsequent restore attempt must be able to recognize that the prior
      // database may be only partially restored and re-apply the validated
      // backup metadata before continuing.
    }
    if (backupId && rollbackSucceeded) {
      // Only remove the recovery journal after every rollback component has
      // succeeded. If rollback failed, retaining rollingBack is essential:
      // deleting it would erase the only durable signal that recovery is
      // incomplete.
      try {
        await db.app_settings.delete(telegramRestoreJournalKey(backupId));
        await db.app_settings.delete(telegramSnapshotKey(backupId));
      } catch {
        /* preserve the original restore error */
      }
    }
    throw e;
  }
}

/**
 * Restore a complete Telegram backup under the same migration lock used by
 * local imports. The lock deliberately covers both the database phase and the
 * potentially long receipt-photo phase so another migration cannot interleave
 * with a sharded restore.
 */
export async function detectTelegramChatId(cfg: TelegramConfig): Promise<string | null> {
  if (!cfg.botToken?.trim()) throw new Error("Enter the Telegram bot token first.");
  const updates = await callApi<TelegramUpdate[]>(cfg.botToken, "getUpdates", { limit: 100, allowed_updates: ["message", "channel_post"] });
  for (const update of updates ?? []) {
    const chat = update.message?.chat ?? update.channel_post?.chat;
    const id = chat?.id;
    if (id != null) return String(id);
  }
  return null;
}

export type TelegramScanResult = { botToken?: string; chatId?: string; extraBotTokens?: string[]; lastUpload?: LastUpload; source: "pairing" | "token" | "chat-id" };
const TELEGRAM_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT_ID = /^-?\d{5,}$/;
export function parseTelegramScan(input: string): TelegramScanResult {
  const text = input.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().replace(/^["']|["']$/g, "");
  if (text.length > 4096) throw new Error("That code doesn't look like Telegram bot details");
  try { return { ...decodePairingPayload(text), source: "pairing" }; } catch { /* generic formats */ }
  // Accept `.../bot<TOKEN>`, `.../bot<TOKEN>/method` and `.../bot<TOKEN>?query`.
  // Only the token (and an explicit chat_id parameter) is taken; the rest of the URL is dropped.
  const url = text.match(/^https?:\/\/api\.telegram\.org\/bot([^/?#\s]+)(?:[/?#].*)?$/i);
  if (url?.[1]) {
    if (!TELEGRAM_TOKEN.test(url[1])) throw new Error("That code doesn't look like Telegram bot details");
    const chat = text.match(/[?&]chat_id=(-?\d{5,})(?:[&#]|$)/)?.[1];
    return { botToken: url[1], ...(chat && TELEGRAM_CHAT_ID.test(chat) ? { chatId: chat } : {}), source: "token" };
  }
  const parts = text.split(/\s*[|,]\s*|\s*\n\s*|\s+/).filter(Boolean);
  const token = parts.find((part) => TELEGRAM_TOKEN.test(part));
  const chatId = parts.find((part) => TELEGRAM_CHAT_ID.test(part));
  if (token) return { botToken: token, ...(chatId ? { chatId } : {}), source: "token" };
  if (TELEGRAM_CHAT_ID.test(text)) return { chatId: text, source: "chat-id" };
  throw new Error("That code doesn't look like Telegram bot details");
}


export async function fetchLatestShardedFullBackup(cfg: TelegramConfig, options: { onProgress?: (p: TelegramRestoreProgress) => void; signal?: AbortSignal } = {}) {
  return fetchLatestShardedFullBackupImpl(cfg, options);
}

export async function restoreFullBackupSharded(shards: Uint8Array[] | ShardSource, mode: "replace" | "merge" = "replace", top?: FullBackupTopManifest | null, options: { onProgress?: (p: TelegramRestoreProgress) => void; signal?: AbortSignal } = {}): Promise<RestoreFullBackupResult> {
  const op = beginOp("telegram-restore", "Restoring Telegram backup shards");
  try { const result = await withMigrationLock(() => restoreFullBackupShardedImpl(shards, mode, top, options.onProgress, options.signal)); op.finish(result.filesCorrupted.length ? "warning" : "success", "Telegram sharded restore completed", { records: result.rowsRestored, photos: { saved: result.filesRestored, missing: result.filesSkippedUnmatched + result.filesCorrupted.length }, encrypted: true, session: top?.session }); return result; }
  catch (e) { op.finish("error", "Telegram sharded restore failed", { errorCode: errorCodeFor(e), errorMessage: redact(e instanceof Error ? e.message : String(e)) }); throw e; }
}


export async function fetchLatestFullBackupArchive(cfg: TelegramConfig, onProgress?: (p: UploadProgress) => void): Promise<{ session: string; bytes: Uint8Array }> {
  return fetchLatestFullBackupArchiveImpl(cfg, onProgress);
}
