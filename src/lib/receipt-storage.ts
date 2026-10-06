/**
 * R2: receipt storage modes + migration.
 *
 * Web/PWA: photos stay as Blobs in `db.receipts` (the browser sandbox has
 * no accessible disk). Desktop/Android (Tauri): the on-disk file under
 * `Documents/TurfApp` (app-private storage on Android) is the source of
 * truth and `db.receipts` rows carry only `{path, size, created_at}` with
 * `blob` undefined. `receipt_hashes` is unchanged and stays the integrity
 * record on every platform.
 *
 * Lives in its own module (not localdb.ts) so the Dexie schema file keeps
 * zero runtime imports.
 */
import { db } from "./localdb";
import {
  isDesktop,
  saveToAppDocuments,
  removeAppDocument,
  readAppDocument,
  appDocumentExists,
} from "./desktop";
import { sha256Hex } from "./receipts-share";

/**
 * Receipt paths uploaded by an open, not-yet-submitted expense form. They
 * have no expense row yet, so the storage-health check must not report (or
 * offer to delete) them as orphans.
 */
export const pendingReceiptPaths = new Set<string>();

/** Stable MIME type for restored receipt blobs when the source Blob type was
 * not preserved by the backup container. */
export function receiptMimeType(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return (
    (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        heic: "image/heic",
        heif: "image/heif",
      } as Record<string, string>
    )[ext] ?? "application/octet-stream"
  );
}

export type ReceiptBytesSource =
  { kind: "dexie"; blob: Blob } | { kind: "disk"; bytes: Uint8Array };

/**
 * Reads a receipt's bytes from wherever this platform keeps the source of
 * truth. One photo's bytes are live at a time - callers must not collect
 * the results of many of these (rule 2).
 */
export async function readReceiptBytes(
  path: string,
): Promise<Uint8Array | null> {
  const row = await db.receipts.get(path);
  if (row?.blob) return new Uint8Array(await row.blob.arrayBuffer());
  if (isDesktop() && (await appDocumentExists(path)))
    return readAppDocument(path);
  return null;
}

/**
 * One row at a time: writes a blob-backed receipt to disk (desktop only),
 * verifies the on-disk bytes against `receipt_hashes`, and only then drops
 * the blob from IndexedDB. Rows whose hash fails to verify keep their blob
 * (the surviving copy) and are reported, never silently lost. Streams via
 * `each()` - never `toArray()` - so peak memory is one photo.
 */
export async function migrateReceiptBlobsToDisk(
  onProgress?: (done: number, total: number) => void,
): Promise<{ migrated: number; kept: string[] }> {
  let migrated = 0;
  const kept: string[] = [];
  if (!isDesktop()) return { migrated, kept };
  const total = await db.receipts.count();
  // Sequential, guaranteed-awaiting (see backup.ts for why not each()):
  // the key loop guarantees write-then-drop ordering.
  const keys = (await db.receipts.toCollection().primaryKeys()) as string[];
  for (const key of keys) {
    const row = (await db.receipts.get(key))!;
    if (!(row.blob instanceof Blob)) {
      migrated++; // already file-backed
      onProgress?.(migrated, total);
      continue;
    }
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    const hashRow = await db.receipt_hashes.get(row.path);
    try {
      // A file already on disk is never overwritten: verify it instead, and
      // never delete it on a mismatch (it may be the only good copy).
      const existed = await appDocumentExists(row.path);
      if (!existed) await saveToAppDocuments(row.path, bytes);
      // Verify the bytes that actually landed on disk, not merely the Blob
      // that was held in memory. If an older row has no hash yet, create one
      // from the verified on-disk bytes before dropping the fallback Blob.
      const diskBytes = await readAppDocument(row.path);
      const diskHash = await sha256Hex(diskBytes);
      const expected =
        hashRow?.sha256 ?? (existed ? await sha256Hex(bytes) : diskHash);
      if (diskHash !== expected) {
        if (!existed) await removeAppDocument(row.path);
        kept.push(row.path);
        onProgress?.(migrated, total);
        continue;
      }
      if (!hashRow) {
        await db.receipt_hashes.put({
          path: row.path,
          sha256: diskHash,
          created_at: row.created_at,
        });
      }
      await db.receipts
        .where("path")
        .equals(row.path)
        .modify((r) => {
          delete r.blob;
          r.size = diskBytes.length;
        });
      migrated++;
    } catch {
      kept.push(row.path); // disk write failed - blob stays as the copy
    }
    onProgress?.(migrated, total);
  }
  return { migrated, kept };
}

/**
 * Deletes a receipt photo (Dexie row, hash row, and the on-disk file on
 * desktop/Android) ONLY if no expense still references it. Used when an
 * expense is deleted, so its photo does not linger forever (and keep being
 * backed up), without ever removing a photo another expense shares.
 */
export async function purgeReceiptIfUnreferenced(
  path: string | null | undefined,
): Promise<boolean> {
  if (!path) return false;
  const stillUsed = await db.expenses
    .filter((e) => e.receipt_path === path)
    .first();
  if (stillUsed) return false;
  // Investments can reference the same receipt path as an expense. Never
  // delete the shared bytes while either table still owns the reference.
  const stillUsedByInvestment = await db.investments
    .filter((i) => i.receipt_path === path)
    .first();
  if (stillUsedByInvestment) return false;
  // Bills are also first-class receipt owners. Never delete a shared photo
  // while a bill still references the same path.
  const stillUsedByBill = await db.bills
    .filter((b) => b.receipt_path === path)
    .first();
  if (stillUsedByBill) return false;
  // Delete the native file first. If the filesystem refuses the delete, keep
  // the DB metadata/reference so health reconciliation can retry instead of
  // silently creating an untracked orphan.
  if (isDesktop()) {
    try {
      await removeAppDocument(path);
    } catch {
      return false;
    }
  }
  await db.receipts.delete(path);
  await db.receipt_hashes.delete(path);
  return true;
}
