import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { db, newId, nowIso } from "./localdb";
import { sha256Hex } from "./receipts-share";
import {
  receiptStorageStats,
  reconcileReceiptStorage,
  repairReceiptItem,
} from "./receipt-health";

const addExpense = (path: string | null) =>
  db.expenses.add({
    id: newId(),
    expense_no: `H-${Math.random().toString(36).slice(2, 8)}`,
    business: "Turf",
    category: "Other",
    description: "health",
    note: null,
    amount: 10,
    spent_at: "2026-09-01",
    receipt_path: path,
    created_at: nowIso(),
  } as never);

describe("receipt-health (R6)", () => {
  beforeEach(async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
    await db.investments.clear();
    await db.bills.clear();
  });

  it("stats count photos, bytes and average", async () => {
    await db.receipts.put({
      path: "Receipts/a/1.jpg",
      blob: new Blob([new Uint8Array(100)]),
      created_at: nowIso(),
    });
    await db.receipts.put({
      path: "Receipts/a/2.jpg",
      blob: new Blob([new Uint8Array(300)]),
      created_at: nowIso(),
    });
    const s = await receiptStorageStats();
    expect(s.photoCount).toBe(2);
    expect(s.totalBytes).toBe(400);
    expect(s.avgBytes).toBe(200);
  });

  it("reconcile flags missing, orphan and mismatch", async () => {
    const good = new Uint8Array([1, 2, 3]);
    const bad = new Uint8Array([4, 5, 6]);
    // good: expense + blob + matching hash
    await addExpense("Receipts/h/good.jpg");
    await db.receipts.put({
      path: "Receipts/h/good.jpg",
      blob: new Blob([good]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path: "Receipts/h/good.jpg",
      sha256: await sha256Hex(good),
      created_at: nowIso(),
    });
    // missing: expense claims it, no bytes
    await addExpense("Receipts/h/missing.jpg");
    // orphan: bytes exist, no expense
    await db.receipts.put({
      path: "Receipts/h/orphan.jpg",
      blob: new Blob([good]),
      created_at: nowIso(),
    });
    // mismatch: bytes disagree with hash
    await addExpense("Receipts/h/bad.jpg");
    await db.receipts.put({
      path: "Receipts/h/bad.jpg",
      blob: new Blob([bad]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path: "Receipts/h/bad.jpg",
      sha256: await sha256Hex(good), // hash of OTHER bytes
      created_at: nowIso(),
    });

    const r = await reconcileReceiptStorage();
    expect(r.missing).toEqual(["Receipts/h/missing.jpg"]);
    expect(r.orphans).toEqual(["Receipts/h/orphan.jpg"]);
    expect(r.mismatched).toEqual(["Receipts/h/bad.jpg"]);
  });

  it("counts bill-owned photos as claimed and never reports them as orphans", async () => {
    const path = "Receipts/h/bill.jpg";
    const bytes = new Uint8Array([1, 2, 3]);
    await db.bills.put({
      id: "health-bill",
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
    const r = await reconcileReceiptStorage();
    expect(r.missing).toEqual([]);
    expect(r.orphans).toEqual([]);
  });

  it("repair fixes exactly the targeted item", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    await addExpense("Receipts/h/fix.jpg");
    await db.receipts.put({
      path: "Receipts/h/fix.jpg",
      blob: new Blob([bytes]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path: "Receipts/h/fix.jpg",
      sha256: await sha256Hex(new Uint8Array([0])), // wrong on purpose
      created_at: nowIso(),
    });
    const message = await repairReceiptItem("mismatch", "Receipts/h/fix.jpg");
    expect(message).toMatch(/not re-approved|trusted copy/i);
    const h = await db.receipt_hashes.get("Receipts/h/fix.jpg");
    expect(h?.sha256).toBe(await sha256Hex(new Uint8Array([0])));
    const r = await reconcileReceiptStorage();
    expect(r.mismatched).toEqual(["Receipts/h/fix.jpg"]);
  });
});
