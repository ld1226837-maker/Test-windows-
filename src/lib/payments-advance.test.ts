import { describe, expect, it } from "vitest";

import { receiptAdvanceAmount, setReceiptPayments } from "./payments";
import { billReceipt } from "./receipt";
import type { Bill } from "./biz";

const row = (
  parent_id: string,
  amount: number,
  created_at: string,
  mode = "Cash",
) => ({
  id: `${parent_id}-${created_at}`,
  parent_type: "bill" as const,
  parent_id,
  amount,
  mode,
  received_at: created_at,
  created_at,
});

const bill = (over: Partial<Bill> = {}): Bill => ({
  id: "bill1",
  invoice_no: "INV-1",
  customer_name: "Test",
  customer_phone: null,
  items: [{ item: "Turf", qty: 1, rate: 2520, total: 2520, unit: "hr" }],
  subtotal: 2520,
  discount: 240,
  total: 2280,
  amount_paid: 2280,
  status: "paid",
  payment_mode: "UPI",
  bill_date: "2026-10-09T10:00:00.000Z",
  ...over,
});

describe("receiptAdvanceAmount (display only)", () => {
  it("falls back to the given figure when no payment rows exist", () => {
    setReceiptPayments([]);
    expect(receiptAdvanceAmount("bill", "x", 500)).toBe(500);
  });

  it("returns the first receipt, not the later settlement", () => {
    setReceiptPayments([
      row("bill1", 1000, "2026-10-09T10:00:00.000Z"),
      row("bill1", 1280, "2026-10-09T18:30:00.000Z", "UPI"),
    ]);
    expect(receiptAdvanceAmount("bill", "bill1", 2280)).toBe(2280 - 1280);
  });

  it("sums the parts of a split first receipt", () => {
    setReceiptPayments([
      row("bill1", 600, "2026-10-09T10:00:00.000Z"),
      row("bill1", 400, "2026-10-09T10:00:00.001Z", "UPI"),
      row("bill1", 1280, "2026-10-10T09:00:00.000Z"),
    ]);
    expect(receiptAdvanceAmount("bill", "bill1", 2280)).toBe(1000);
  });
});

describe("billReceipt Advance paid line", () => {
  it("shows the entered advance while totals stay unchanged", () => {
    setReceiptPayments([
      row("bill1", 1000, "2026-10-09T10:00:00.000Z"),
      row("bill1", 1280, "2026-10-09T18:30:00.000Z", "UPI"),
    ]);
    const doc = billReceipt(bill());
    expect(doc.lines.find((l) => l.label === "Advance paid")?.amount).toBe(
      -1000,
    );
    const t = (l: string) => doc.totals.find((x) => x.label === l)?.value;
    expect(t("GRAND TOTAL")).toMatch(/2,280/);
    expect(t("Paid")).toMatch(/2,280/);
    expect(doc.balanceDue).toBe(0);
  });

  it("is unchanged for bills with no payment rows", () => {
    setReceiptPayments([]);
    const doc = billReceipt(bill());
    expect(doc.lines.find((l) => l.label === "Advance paid")?.amount).toBe(
      -2280,
    );
  });
});
