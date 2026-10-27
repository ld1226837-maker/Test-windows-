import { describe, expect, it } from "vitest";

import type { Bill } from "./biz";
import type { TurfBooking } from "./ops";
import {
  billReceipt,
  bookingReceipt,
  paymentReceipt,
  receiptText,
} from "./receipt";
import { remainingSummary } from "./remaining-summary";

/**
 * A customer who paid ZERO advance (or paid more than the bill) must never
 * see a negative "remaining" figure anywhere: the field reads Rs 0.
 */
const amountOf = (v: string | undefined) =>
  Number((v ?? "").replace(/[^0-9.-]/g, ""));
const totalOf = (
  doc: { totals: { label: string; value: string }[] },
  l: string,
) => doc.totals.find((t) => t.label === l)?.value;

const booking = (over: Partial<TurfBooking> = {}): TurfBooking =>
  ({
    id: "b1",
    booking_no: "INV-20260101-0001",
    booking_date: "2026-01-01",
    customer_name: "Test Customer",
    phone: "9876543210",
    slot_name: "Weekdays",
    hours: 1,
    rate_per_hour: 1200,
    total_amount: 1200,
    advance_paid: 0,
    payment_mode: "Cash",
    status: "Confirmed",
    discount: 0,
    notes: null,
    start_time: "06:00 AM",
    end_time: "07:00 AM",
    courts: 1,
    snacks: [],
    snacks_total: 0,
    turf_amount: 1200,
    merged_into_bill_id: null,
    ...over,
  }) as TurfBooking;

const bill = (over: Partial<Bill> = {}): Bill =>
  ({
    id: "bill1",
    invoice_no: "INV-20260101-0001",
    customer_name: "Test Customer",
    customer_phone: "9876543210",
    items: [{ item: "Turf", rate: 1000, qty: 1, total: 1000, unit: "hr" }],
    subtotal: 1000,
    discount: 0,
    total: 1000,
    amount_paid: 0,
    status: "unpaid",
    payment_mode: null,
    bill_date: "2026-01-01T06:00:00.000Z",
    ...over,
  }) as Bill;

describe("remaining is never negative", () => {
  it("remainingSummary: zero advance and overpaid both stay >= 0", () => {
    const fmt = (n: number) => `Rs ${n}`;
    const zero = remainingSummary({
      grandTotal: 1000,
      advances: 0,
      paid: 0,
      fmt,
    });
    expect(zero.remaining).toBe(1000);
    expect(zero.payable).toBe(1000);
    const over = remainingSummary({
      grandTotal: 1000,
      advances: 0,
      paid: 1500,
      fmt,
    });
    expect(over.remaining).toBe(0);
    const bigAdv = remainingSummary({
      grandTotal: 500,
      advances: 900,
      paid: 900,
      fmt,
    });
    expect(bigAdv.remaining).toBe(0);
    expect(bigAdv.payable).toBe(0);
  });

  it("booking with zero advance prints the full remaining, never negative", () => {
    const doc = bookingReceipt(booking(), []);
    expect(amountOf(totalOf(doc, "Remaining to be paid"))).toBe(1200);
  });

  it("booking collected beyond its total prints Remaining Rs 0", () => {
    const doc = bookingReceipt(booking({ advance_paid: 2000 }), []);
    expect(amountOf(totalOf(doc, "Remaining to be paid"))).toBe(0);
    expect(receiptText(doc)).not.toMatch(/Remaining[^\n]*(-\s?Rs|Rs\s?-)/);
  });

  it("bill paid beyond its total prints Remaining Rs 0", () => {
    const doc = billReceipt(bill({ amount_paid: 1800, status: "paid" }), []);
    expect(amountOf(totalOf(doc, "Remaining to be paid"))).toBe(0);
  });

  it("payment receipt clamps a negative balanceAfter to Rs 0", () => {
    const doc = paymentReceipt({
      customer: "Test Customer",
      against: "Full balance",
      amount: 500,
      mode: "Cash",
      balanceAfter: -250,
    });
    expect(amountOf(totalOf(doc, "Balance remaining"))).toBe(0);
    expect(amountOf(totalOf(doc, "Balance before this payment"))).toBe(500);
    expect(doc.note ?? "").toContain("settled in full");
    expect(doc.note ?? "").not.toMatch(/(-\s?Rs|Rs\s?-)/);
  });
});
