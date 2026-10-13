import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  isCancelled,
  isLive,
  isPending,
  pendingAmount,
  pendingLabel,
} from "./bill-state";
import type { Bill } from "./biz";
import type { SnackSale, TurfBooking } from "./ops";
import { toSnackSale, toTurfBooking } from "./ops";
import type { SnackSaleRow, TurfBookingRow } from "./localdb";
import type { TabEntry } from "./tabs";

const bk = (o: Partial<TurfBooking> = {}) =>
  ({
    id: "b1",
    booking_no: "B-1",
    status: "Confirmed",
    total_amount: 1000,
    advance_paid: 400,
    discount: 0,
    merged_into_bill_id: null,
    ...o,
  }) as TurfBooking;
const sl = (o: Partial<SnackSale> = {}) =>
  ({
    id: "s1",
    bill_no: "S-1",
    total: 100,
    payment_mode: "On tab",
    merged_into_bill_id: null,
    ...o,
  }) as SnackSale;
const bl = (o: Partial<Bill> = {}) =>
  ({
    id: "i1",
    invoice_no: "INV-1",
    total: 500,
    amount_paid: 100,
    status: "partial",
    payment_mode: null,
    items: [],
    ...o,
  }) as unknown as Bill;
const charge = (refType: string, id: string, amount: number): TabEntry =>
  ({
    id: `e-${id}`,
    kind: "charge",
    amount,
    ref_type: refType,
    ref_id: id,
  }) as unknown as TabEntry;

beforeEach(() => undefined);

describe("isCancelled / isLive: one meaning everywhere", () => {
  it("turf: Cancelled AND No-show are cancelled; the rest are live", () => {
    expect(isCancelled(bk({ status: "Cancelled" }))).toBe(true);
    expect(isCancelled(bk({ status: "No-show" }))).toBe(true);
    for (const s of ["Confirmed", "Completed", "Pending"])
      expect(isLive(bk({ status: s }))).toBe(true);
  });
  it("snack sale: cancelled flag", () => {
    expect(isCancelled(sl({ cancelled: true }))).toBe(true);
    expect(isLive(sl())).toBe(true);
  });
  it("bill: status cancelled", () => {
    expect(isCancelled(bl({ status: "cancelled" }))).toBe(true);
    for (const s of ["paid", "unpaid", "partial"] as const)
      expect(isLive(bl({ status: s }))).toBe(true);
  });
});

describe("pendingAmount / isPending: live money still owed", () => {
  it("booking: unpaid balance; tab-moved balance counts once; merged/cancelled owe nothing", () => {
    expect(pendingAmount(bk())).toBe(600);
    expect(isPending(bk())).toBe(true);
    // balance moved onto the tab: booking shows advance = total, tab holds 600
    const moved = bk({ advance_paid: 1000 });
    expect(
      pendingAmount(moved, { tabEntries: [charge("turf_booking", "b1", 600)] }),
    ).toBe(600);
    expect(pendingAmount(bk({ merged_into_bill_id: "i1" }))).toBe(0);
    expect(pendingAmount(bk({ status: "No-show" }))).toBe(0);
    expect(isPending(bk({ advance_paid: 1000 }))).toBe(false);
  });
  it("snack sale: On tab owes its tab balance; paid or voided owes nothing", () => {
    expect(pendingAmount(sl())).toBe(100); // no ledger given: whole total
    expect(
      pendingAmount(sl(), { tabEntries: [charge("snack_sale", "s1", 100)] }),
    ).toBe(100);
    expect(pendingAmount(sl(), { tabEntries: [] })).toBe(0);
    expect(pendingAmount(sl({ payment_mode: "Cash" }))).toBe(0);
    expect(pendingAmount(sl({ cancelled: true }))).toBe(0);
  });
  it("a snack sale linked to a booking (booking_no set) is still a sale", () => {
    const linked = sl({ booking_no: "B-9", booking_id: "b9" } as never);
    expect(pendingAmount(linked, { tabEntries: [] })).toBe(0);
    expect(pendingAmount(linked)).toBe(100); // On tab, no ledger: whole total
  });
  it("bill: unpaid balance; paid / cancelled owe nothing", () => {
    expect(pendingAmount(bl())).toBe(400);
    expect(pendingAmount(bl({ status: "paid" }))).toBe(0);
    expect(pendingAmount(bl({ status: "cancelled" }))).toBe(0);
  });
  it("one wording: Pending Rs X in plain ASCII", () => {
    expect(pendingLabel(1100)).toBe("Pending Rs 1,100");
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(pendingLabel(250000))).toBe(true);
  });
});

describe("row mappers keep every stored field the screens depend on", () => {
  it("turf: refunded_at / refund_mode survive (they used to be dropped)", () => {
    const row = {
      id: "b1",
      booking_no: "B-1",
      booking_date: "2026-10-10",
      customer_name: "R",
      phone: null,
      slot_name: "x",
      hours: 1,
      rate_per_hour: 1,
      total_amount: 1,
      advance_paid: 1,
      payment_mode: "Cash",
      status: "Cancelled",
      is_refundable: true,
      refunded_at: "2026-10-11T10:00:00.000Z",
      refund_mode: "UPI",
      discount: 0,
      notes: null,
      start_time: null,
      end_time: null,
      courts: 1,
      snacks: [],
      snacks_total: 0,
      turf_amount: 1,
      created_at: "x",
    } as TurfBookingRow;
    const t = toTurfBooking(row);
    expect(t.refunded_at).toBe("2026-10-11T10:00:00.000Z");
    expect(t.refund_mode).toBe("UPI");
    expect(isCancelled(t)).toBe(true);
  });
  it("snack: cancelled and refund fields survive (cancelled used to be dropped)", () => {
    const row = {
      id: "s1",
      bill_no: "S-1",
      sale_date: "2026-10-10",
      customer_name: null,
      items: [],
      total: 100,
      profit: 0,
      payment_mode: "Cash",
      notes: null,
      booking_id: null,
      booking_no: null,
      created_at: "x",
      cancelled: true,
      is_refundable: false,
      refund_amount: 40,
    } as SnackSaleRow;
    const s = toSnackSale(row);
    expect(s.cancelled).toBe(true);
    expect(s.is_refundable).toBe(false);
    expect(s.refund_amount).toBe(40);
    expect(isLive(s)).toBe(false);
  });
});
