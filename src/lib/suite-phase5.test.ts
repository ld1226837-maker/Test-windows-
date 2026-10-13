// @vitest-environment jsdom
import "fake-indexeddb/auto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { billReceipt, bookingReceipt, snackSaleReceipt } from "./receipt";
import { receiptText } from "./receipt";
import type { Bill } from "./biz";
import type { SnackSale, TurfBooking } from "./ops";
import type { TabEntry } from "./tabs";
import { db, type BillRow } from "./localdb";
import { recordPayment } from "./payments";
import { writeAppSettings } from "./settings";

const total = (d: { totals: { label: string; value: string }[] }, l: string) =>
  d.totals.find((t) => t.label === l)?.value;
const charge = (refType: string, refId: string, amount: number): TabEntry =>
  ({
    id: `c-${refId}`,
    tab_id: "t1",
    customer_key: "p:9876543210",
    kind: "charge",
    business: "Shared",
    amount,
    ref_type: refType,
    ref_id: refId,
  }) as unknown as TabEntry;
const reversal = (refType: string, refId: string, amount: number): TabEntry =>
  ({
    ...charge(refType, refId, amount),
    id: `r-${refId}`,
    kind: "payment",
  }) as unknown as TabEntry;

const bill = (over: Partial<Bill> = {}): Bill =>
  ({
    id: "b1",
    invoice_no: "INV-1",
    customer_name: "Ravi",
    customer_phone: "9876543210",
    bill_date: "2026-01-05",
    subtotal: 1000,
    discount: 0,
    total: 1000,
    amount_paid: 400,
    status: "partial",
    payment_mode: "Cash",
    items: [],
    ...over,
  }) as unknown as Bill;

const booking = (over: Partial<TurfBooking> = {}): TurfBooking =>
  ({
    id: "bk1",
    booking_no: "BK-1",
    booking_date: "2026-01-05",
    customer_name: "Ravi",
    phone: "9876543210",
    slot_name: "Weekdays",
    hours: 1,
    rate_per_hour: 1200,
    total_amount: 1200,
    advance_paid: 500,
    payment_mode: "Cash",
    status: "Confirmed",
    discount: 0,
    courts: 1,
    snacks: [],
    snacks_total: 0,
    turf_amount: 1200,
    merged_into_bill_id: null,
    ...over,
  }) as unknown as TurfBooking;

const sale = (over: Partial<SnackSale> = {}): SnackSale =>
  ({
    id: "s1",
    bill_no: "SB-1",
    sale_date: "2026-01-05",
    customer_name: "Ravi",
    items: [
      { item_name: "Chips", qty: 1, unit_price: 45, amount: 45, cost: 20 },
    ],
    total: 45,
    payment_mode: "On tab",
    ...over,
  }) as unknown as SnackSale;

describe("A1 - bill receipt reads the running tab", () => {
  it("a bill whose balance moved to dues does not demand it again", () => {
    const entries = [charge("bill", "b1", 600)];
    const doc = billReceipt(bill(), entries);
    expect(total(doc, "Status")).toBe("MOVED TO DUES");
    expect(doc.balanceDue).toBe(0);
    expect(receiptText(doc)).toMatch(/moved to the customer's tab/i);
  });
  it("without the tab it is an ordinary pending bill", () => {
    const doc = billReceipt(bill(), []);
    expect(total(doc, "Status")).toBe("PENDING");
    expect(doc.balanceDue).toBe(600);
  });
  it("a bill saved On tab is wholly on the tab", () => {
    const doc = billReceipt(bill({ payment_mode: "On tab" }), []);
    expect(total(doc, "Status")).toBe("MOVED TO DUES");
    expect(doc.balanceDue).toBe(0);
  });
  it("a cancelled bill prints CANCELLED and owes nothing", () => {
    const doc = billReceipt(bill({ status: "cancelled" }), []);
    expect(total(doc, "Status")).toBe("CANCELLED");
    expect(doc.balanceDue).toBe(0);
  });
});

describe("A2 - On-tab snack receipt follows the tab", () => {
  it("still on the tab: MOVED TO DUES with the amount owed", () => {
    const doc = snackSaleReceipt(sale(), [charge("snack_sale", "s1", 45)]);
    expect(total(doc, "Status")).toBe("MOVED TO DUES");
    expect(doc.balanceDue).toBe(45);
  });
  it("once the sale's tab charge is cleared it is PAID and owes nothing", () => {
    const doc = snackSaleReceipt(sale(), [
      charge("snack_sale", "s1", 45),
      reversal("snack_sale", "s1", 45),
    ]);
    expect(total(doc, "Status")).toBe("PAID");
    expect(doc.balanceDue).toBe(0);
    expect(total(doc, "Paid")).toMatch(/45/);
  });
  it("without a loaded ledger an On-tab sale still owes its total", () => {
    const doc = snackSaleReceipt(sale(), undefined);
    expect(doc.balanceDue).toBe(45);
  });
});

describe("A3 - booking receipt", () => {
  it("a No-show booking owes nothing (same as bookingDue)", () => {
    const doc = bookingReceipt(booking({ status: "No-show" }), []);
    expect(doc.balanceDue).toBe(0);
    expect(doc.totals.some((t) => t.label === "Remaining to be paid")).toBe(
      false,
    );
  });
  it("a balance put on the tab prints real cash paid and no second demand", () => {
    // "Put balance on tab" writes advance_paid = grand total.
    const doc = bookingReceipt(booking({ advance_paid: 1200 }), [
      charge("turf_booking", "bk1", 700),
    ]);
    expect(total(doc, "Paid")).toMatch(/500/);
    expect(doc.balanceDue).toBe(0);
    expect(receiptText(doc)).toMatch(/700.*moved to the customer's tab/i);
  });
});

describe("A7 / B1 - source guards", () => {
  const src = (f: string) =>
    fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
  it("the daily summary uses the shared dues figure and live snack sales", () => {
    const s = src("components/app/WhatsAppSummaryCard.tsx");
    expect(s).toContain("pendingMoneyIndex(");
    expect(s).toContain("isFinancialSale(x)");
    expect(s).not.toMatch(/Pending dues: \$\{money\(s\.dues\)\}/);
  });
  it("no screen hand-writes total + tax_amount", () => {
    for (const f of [
      "components/app/BillActions.tsx",
      "components/app/SnackSalesList.tsx",
    ])
      expect(src(f)).not.toMatch(/total\s*\+\s*\(?[\w.?]*tax_amount/);
  });
});

describe("B2 - collection ceiling for a legacy row without a tax snapshot", () => {
  it("lets the printed Grand Total (taxed at the live rate) be collected", async () => {
    writeAppSettings({ gstEnabled: true, gstRate: 18 } as never);
    const row = {
      id: "legacy1",
      invoice_no: "INV-L",
      customer_name: "Old",
      customer_phone: null,
      items: [],
      subtotal: 1000,
      discount: 0,
      total: 1000,
      amount_paid: 0,
      status: "unpaid",
      payment_mode: null,
      bill_date: "2026-01-05",
      created_at: "2026-01-05T10:00:00.000Z",
    } as unknown as BillRow;
    await db.bills.add(row);
    await expect(
      recordPayment({
        parentType: "bill",
        parentId: "legacy1",
        entries: [{ amount: 1180, mode: "Cash" }],
      }),
    ).resolves.toBeDefined();
    await expect(
      recordPayment({
        parentType: "bill",
        parentId: "legacy1",
        entries: [{ amount: 1, mode: "Cash" }],
      }),
    ).rejects.toThrow("would exceed");
  });
});
