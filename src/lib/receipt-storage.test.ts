import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { db, newId, nowIso } from "./localdb";
import { sha256Hex } from "./receipts-share";
import {
  migrateReceiptBlobsToDisk,
  purgeReceiptIfUnreferenced,
  readReceiptBytes,
} from "./receipt-storage";

// Tauri plugins don't exist under jsdom; `isDesktop()` is false here, so
// migration is a no-op — the web/blob behavior is what's exercised.
describe("receipt-storage (R2)", () => {
  beforeEach(async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
    await db.investments.clear();
    await db.bills.clear();
  });

  it("readReceiptBytes returns the stored blob on web", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await db.receipts.put({
      path: "Receipts/2026-09-01/x.jpg",
      blob: new Blob([bytes]),
      created_at: nowIso(),
    });
    expect(await readReceiptBytes("Receipts/2026-09-01/x.jpg")).toEqual(bytes);
  });

  it("readReceiptBytes returns null when nothing is stored", async () => {
    expect(await readReceiptBytes("Receipts/nowhere/x.jpg")).toBeNull();
  });

  it("migration is a no-op off-desktop and touches nothing", async () => {
    const bytes = new Uint8Array([9, 9]);
    const path = "Receipts/2026-09-01/keep.jpg";
    await db.receipts.put({
      path,
      blob: new Blob([bytes]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path,
      sha256: await sha256Hex(bytes),
      created_at: nowIso(),
    });
    const { migrated, kept } = await migrateReceiptBlobsToDisk();
    expect(migrated).toBe(0);
    expect(kept).toEqual([]);
    const row = await db.receipts.get(path);
    expect(row?.blob).toBeInstanceOf(Blob); // untouched
  });

  it("does not purge a receipt still referenced by a bill", async () => {
    const path = "Receipts/2026-09-01/bill.jpg";
    const bytes = new Uint8Array([1, 2, 3]);
    await db.bills.put({
      id: "storage-bill",
      invoice_no: "INV-20260901-0001",
      customer_name: "Walk-in",
      customer_phone: null,
      items: [],
      subtotal: 10,
      discount: 0,
      total: 10,
      amount_paid: 0,
      status: "Unpaid",
      payment_mode: "Cash",
      bill_date: "2026-09-01",
      created_at: nowIso(),
      receipt_path: path,
    } as never);
    await db.receipts.put({
      path,
      blob: new Blob([bytes]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path,
      sha256: await sha256Hex(bytes),
      created_at: nowIso(),
    });
    await expect(purgeReceiptIfUnreferenced(path)).resolves.toBe(false);
    expect(await db.receipts.get(path)).toBeDefined();
    expect(await db.receipt_hashes.get(path)).toBeDefined();
  });

  it("metadata-only rows (no blob) report a size", async () => {
    await db.receipts.put({
      path: "Receipts/2026-09-01/meta.jpg",
      size: 125 * 1024,
      created_at: nowIso(),
    });
    let seen = 0;
    await db.receipts.each((r) => {
      if (r.path.endsWith("meta.jpg")) seen = r.size ?? 0;
    });
    expect(seen).toBe(125 * 1024);
  });
});
