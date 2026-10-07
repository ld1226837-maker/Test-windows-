// Regression test for the monthly collections dating rule.
//
// calculation-rules.md §2c/§3: collections are dated by when the money
// actually arrived (payment `received_at`) — "a due collected today on last
// week's booking is received today". The app's periodStats() implements
// exactly this (via effectivePaymentEntries). The independent oracle
// (loadtest-ledger.ts) used to bucket billsCollected/collected by the
// DOCUMENT date instead, which diverged from both the app and the docs
// whenever a payment crossed a month edge — 17 monthly audit checks failed
// on every load-test run. These tests pin the documented rule.
import { describe, expect, it } from "vitest";

import { buildExpectedLedger } from "./loadtest-ledger";
import type { BillRow, PaymentRow } from "./localdb";

const taxOf18 = (net: number) => Math.round(net * 18) / 100;
const liveTaxOf = (net: number) => taxOf18(net);

const makeBill = (over: Partial<BillRow> = {}): BillRow =>
  ({
    id: "B-1",
    invoice_no: "INV-1",
    customer_name: "Ravi",
    customer_phone: "9876543210",
    items: [],
    subtotal: 1000,
    discount: 0,
    total: 1000,
    tax_amount: 180,
    tax_lines: null,
    amount_paid: 1180,
    status: "paid",
    payment_mode: "Cash",
    receipt_path: null,
    bill_date: "2026-09-28",
    created_at: "2026-09-28T10:00:00.000Z",
    ...over,
  }) as BillRow;

const run = (bills: BillRow[], payments: PaymentRow[]) =>
  buildExpectedLedger({
    bills,
    bookings: [],
    sales: [],
    expenses: [],
    payments,
    tabEntries: [],
    dayCloses: [],
    liveTaxOf,
  });

describe("buildExpectedLedger: collections are received_at-dated (rules 2c/3)", () => {
  it("buckets a paid bill's collection into the payment's received month, not the bill's month", () => {
    const bills = [makeBill()];
    const payments: PaymentRow[] = [
      {
        id: "P-1",
        parent_type: "bill",
        parent_id: "B-1",
        amount: 1180,
        mode: "Cash",
        received_at: "2026-10-02",
        created_at: "2026-10-02T10:00:00.000Z",
      },
    ];
    const ledger = run(bills, payments);
    // The money arrived in October: docs §2c — the bill's own month (Sept)
    // collected nothing.
    expect(ledger.months["2026-09"]?.billsCollected ?? 0).toBe(0);
    expect(ledger.months["2026-10"]?.billsCollected ?? 0).toBe(1180);
    expect(ledger.months["2026-10"]?.collected ?? 0).toBe(1180);
  });

  it("keeps an implied collection (no payment rows) at the document's own month", () => {
    const bills = [makeBill({ bill_date: "2026-09-15" })];
    const ledger = run(bills, []);
    // No payment rows -> effectivePaymentEntries implies a payment on the
    // record's own date (both app and docs agree).
    expect(ledger.months["2026-09"]?.billsCollected ?? 0).toBe(1180);
    expect(ledger.months["2026-09"]?.collected ?? 0).toBe(1180);
  });
});
