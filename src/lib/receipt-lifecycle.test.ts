import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { db, newId, nowIso } from "./localdb";
import { purgeReceiptIfUnreferenced } from "./receipt-storage";
import { reconcileReceiptStorage, repairReceiptItem } from "./receipt-health";

const addExpense = (path: string | null) =>
  db.expenses.add({
    id: newId(),
    expense_no: `L-${Math.random().toString(36).slice(2, 8)}`,
    business: "Turf",
    category: "Other",
    description: "x",
    note: null,
    amount: 10,
    spent_at: "2026-09-01",
    receipt_path: path,
    created_at: nowIso(),
  } as never);

const addPhoto = async (path: string) => {
  await db.receipts.put({
    path,
    blob: new Blob(["abc"]),
    size: 3,
    created_at: nowIso(),
  });
  await db.receipt_hashes.put({ path, sha256: "x", created_at: nowIso() });
};

describe("receipt lifecycle", () => {
  beforeEach(async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
  });

  it("purges a photo nobody references", async () => {
    await addPhoto("Receipts/d/a.jpg");
    expect(await purgeReceiptIfUnreferenced("Receipts/d/a.jpg")).toBe(true);
    expect(await db.receipts.get("Receipts/d/a.jpg")).toBeUndefined();
    expect(await db.receipt_hashes.get("Receipts/d/a.jpg")).toBeUndefined();
  });

  it("keeps a photo another expense still uses", async () => {
    await addPhoto("Receipts/d/b.jpg");
    await addExpense("Receipts/d/b.jpg");
    expect(await purgeReceiptIfUnreferenced("Receipts/d/b.jpg")).toBe(false);
    expect(await db.receipts.get("Receipts/d/b.jpg")).toBeDefined();
  });

  it("reports an unclaimed photo as orphan even when it has a hash row", async () => {
    await addPhoto("Receipts/d/c.jpg");
    const r = await reconcileReceiptStorage();
    expect(r.orphans).toContain("Receipts/d/c.jpg");
  });

  it("orphan repair refuses to delete a photo an expense now claims", async () => {
    await addPhoto("Receipts/d/e.jpg");
    await addExpense("Receipts/d/e.jpg");
    const msg = await repairReceiptItem("orphan", "Receipts/d/e.jpg");
    expect(msg).toMatch(/not removed/);
    expect(await db.receipts.get("Receipts/d/e.jpg")).toBeDefined();
  });
});
