/**
 * R6: receipt storage health - reconcile the business receipt owners
 * (expenses, investments, and bills), the stored bytes, and `receipt_hashes` and
 * repair items one at a time, safely.
 */
import { db } from "./localdb";
import {
  isDesktop,
  appDocumentExists,
  readAppDocument,
  removeAppDocument,
} from "./desktop";
import { sha256Hex } from "./receipts-share";
import { readReceiptBytes, pendingReceiptPaths } from "./receipt-storage";

export type ReceiptHealthReport = {
  photoCount: number;
  totalBytes: number;
  avgBytes: number;
  /** A business row claims this path but no bytes exist anywhere. */
  missing: string[];
  /** Bytes exist but no business row points at them. */
  orphans: string[];
  /** Bytes disagree with the recorded capture-time hash. */
  mismatched: string[];
};

export async function receiptStorageStats(): Promise<
  Pick<ReceiptHealthReport, "photoCount" | "totalBytes" | "avgBytes">
> {
  let photoCount = 0;
  let totalBytes = 0;
  await db.receipts.each((r) => {
    photoCount++;
    totalBytes += r.size ?? r.blob?.size ?? 0;
  });
  return {
    photoCount,
    totalBytes,
    avgBytes: photoCount ? Math.round(totalBytes / photoCount) : 0,
  };
}

/** Full reconcile. Streams rows; re-reads bytes one photo at a time. */
export async function reconcileReceiptStorage(): Promise<ReceiptHealthReport> {
  const stats = await receiptStorageStats();
  const claimed = new Set<string>();
  await db.expenses.each((e) => {
    if (e.receipt_path) claimed.add(e.receipt_path);
  });
  await db.investments.each((i) => {
    if (i.receipt_path) claimed.add(i.receipt_path);
  });
  await db.bills.each((b) => {
    if (b.receipt_path) claimed.add(b.receipt_path);
  });
  const missing: string[] = [];
  const orphans: string[] = [];
  const mismatched: string[] = [];

  for (const path of claimed) {
    const row = await db.receipts.get(path);
    const present = isDesktop()
      ? (await appDocumentExists(path)) || !!row?.blob
      : !!row;
    if (!present) missing.push(path);
  }

  // Sequential, guaranteed-awaiting (see backup.ts for why not each()).
  const keys = (await db.receipts.toCollection().primaryKeys()) as string[];
  for (const key of keys) {
    const row = await db.receipts.get(key);
    if (!row) continue; // deleted while scanning
    const hashRow = await db.receipt_hashes.get(row.path);
    if (!claimed.has(row.path) && !pendingReceiptPaths.has(row.path))
      orphans.push(row.path);
    if (hashRow) {
      let bytes: Uint8Array | null = null;
      if (isDesktop() && (await appDocumentExists(row.path)))
        bytes = await readAppDocument(row.path);
      else if (row.blob) bytes = new Uint8Array(await row.blob.arrayBuffer());
      if (bytes && (await sha256Hex(bytes)) !== hashRow.sha256)
        mismatched.push(row.path);
    }
  }

  return { ...stats, missing, orphans, mismatched };
}

/**
 * Safe per-item repair. Returns a one-line result for the UI.
 *  - missing/mismatch: re-hash whatever bytes survive and, if they verify
 *    against themselves, refresh the capture-time hash row. (A true
 *    mismatch means the bytes changed after capture; recording the new
 *    hash makes the CURRENT bytes the verified truth and stops every
 *    backup/restore from rejecting them.)
 *  - orphan: remove the unclaimed copy (disk + Dexie + hash row).
 */
export async function repairReceiptItem(
  kind: "missing" | "orphan" | "mismatch",
  path: string,
): Promise<string> {
  if (kind === "orphan") {
    // The report may be stale: never delete a photo an expense now claims.
    const claimedNow = await db.expenses
      .filter((e) => e.receipt_path === path)
      .first();
    const investmentClaim = await db.investments
      .filter((i) => i.receipt_path === path)
      .first();
    const billClaim = await db.bills
      .filter((b) => b.receipt_path === path)
      .first();
    if (
      claimedNow ||
      investmentClaim ||
      billClaim ||
      pendingReceiptPaths.has(path)
    )
      return `${path}: now used by an expense, investment, or bill - not removed.`;
    if (isDesktop()) await removeAppDocument(path);
    await db.receipts.delete(path);
    await db.receipt_hashes.delete(path);
    return `${path}: orphaned copy removed.`;
  }
  const bytes = await readReceiptBytes(path);
  if (!bytes) return `${path}: no bytes found anywhere - nothing to repair.`;
  const existing = await db.receipt_hashes.get(path);
  if (kind === "mismatch" && existing) {
    // A mismatch means the current bytes differ from the capture-time truth.
    // Do not silently bless the changed bytes by replacing the historical
    // hash; that destroys the only evidence that corruption occurred.
    return `${path}: hash mismatch detected; the stored bytes were not re-approved. Replace the receipt from a trusted copy.`;
  }
  const sha256 = await sha256Hex(bytes);
  await db.receipt_hashes.put({
    path,
    sha256,
    created_at: existing?.created_at ?? new Date().toISOString(),
  });
  return `${path}: hash recorded and verified.`;
}

/**
 * Web-only persistent-storage request (so IndexedDB isn't evicted under
 * pressure). No-op on Tauri shells, which don't use the browser quota.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (isDesktop() || typeof navigator === "undefined" || !navigator.storage)
    return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
