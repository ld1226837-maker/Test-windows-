import { describe, expect, it } from "vitest";

import {
  drawerCashOn,
  periodStats,
  turfOccupancy,
  type Sources,
} from "./analytics";
import { buildOccupancy, freeCourtsFor } from "./courts";
import { VOID_QUERY_KEYS } from "./data";
import {
  bookingDue,
  bookingForfeitedRevenue,
  bookingRefundableAdvance,
  isFinancialBooking,
} from "./dues";
import { cancelInvoiceEffects, type CancelInvoicePreview } from "./merge";
import type { TurfBooking } from "./ops";

const bk = (status: string, o: Partial<TurfBooking> = {}) =>
  ({
    id: `b-${status}`,
    booking_no: `B-${status}`,
    booking_date: "2026-10-10",
    customer_name: "Ravi",
    phone: "9876543210",
    status,
    hours: 1,
    total_amount: 1000,
    advance_paid: 300,
    discount: 0,
    start_time: "6:00 PM",
    courts: 1,
    payment_mode: "Cash",
    merged_into_bill_id: null,
    ...o,
  }) as unknown as TurfBooking;

const src = (bookings: TurfBooking[]): Sources =>
  ({ bills: [], bookings, sales: [], expenses: [], tabEntries: [] }) as Sources;

describe("No-show is cancelled, everywhere", () => {
  const cancelled = bk("Cancelled");
  const noShow = bk("No-show");

  it("dues: neither owes anything, neither is financial", () => {
    for (const b of [cancelled, noShow]) {
      expect(isFinancialBooking(b)).toBe(false);
      expect(bookingDue(b)).toBe(0);
    }
  });

  it("revenue and dues: both are excluded identically", () => {
    const a = periodStats(src([cancelled]), () => true);
    const b = periodStats(src([noShow]), () => true);
    expect(b.revenue).toBe(a.revenue);
    expect(b.dues).toBe(a.dues);
    expect(b.dues).toBe(0);
  });

  it("kept advance is forfeited income for both; refundable one is a liability for both", () => {
    for (const b of [cancelled, noShow]) {
      expect(bookingForfeitedRevenue(b)).toBe(300);
      expect(bookingRefundableAdvance({ ...b, is_refundable: true })).toBe(300);
    }
  });

  it("Reports cancelled count includes No-show (and the live booking is not counted)", () => {
    const occ = turfOccupancy(
      [cancelled, noShow, bk("Confirmed", { id: "live" })],
      () => true,
    );
    expect(occ.cancelled.count).toBe(2);
    expect(occ.bookingCount).toBe(1);
  });

  it("calendar: a No-show frees its slot exactly like a Cancelled one", () => {
    for (const b of [cancelled, noShow]) {
      const occupied = buildOccupancy([b], "2026-10-10");
      expect(freeCourtsFor(occupied, 1, 18 * 60, 60)).toBe(1);
    }
    const live = buildOccupancy([bk("Confirmed")], "2026-10-10");
    expect(freeCourtsFor(live, 1, 18 * 60, 60)).toBe(0);
  });
});

describe("cancelInvoiceEffects: what each choice does", () => {
  const merged: CancelInvoicePreview = {
    invoiceNo: "INV-1",
    merged: true,
    total: 1100,
    collected: 500,
    bookings: [{ id: "b", no: "B-1", total: 1000 }],
    sales: [{ id: "s", no: "S-1", total: 100, units: 2 }],
    stockUnits: 2,
    billOnTab: 0,
    billOnlyMoney: 0,
    tabRestored: 300,
  };

  it("invoice only: sources released, tab due restored, no refund question", () => {
    const e = cancelInvoiceEffects(merged, "invoice-only");
    expect(e).toMatchObject({
      needsMoneyDecision: false,
      moneyAtStake: 0,
      sourcesReleased: 2,
      sourcesCancelled: 0,
      stockUnitsRestored: 0,
      tabDueRestored: 300,
    });
  });

  it("invoice and sources: all cancelled, stock restored, money question asked", () => {
    const e = cancelInvoiceEffects(merged, "invoice-and-sources");
    expect(e).toMatchObject({
      needsMoneyDecision: true,
      moneyAtStake: 500,
      sourcesReleased: 0,
      sourcesCancelled: 2,
      stockUnitsRestored: 2,
      tabDueRestored: 0,
    });
  });

  it("plain invoice: asks only when money was received", () => {
    const plain = { ...merged, merged: false, bookings: [], sales: [] };
    expect(cancelInvoiceEffects(plain, "invoice-only").needsMoneyDecision).toBe(
      true,
    );
    expect(
      cancelInvoiceEffects({ ...plain, collected: 0 }, "invoice-only")
        .needsMoneyDecision,
    ).toBe(false);
  });
});

describe("one invalidation list for every void", () => {
  it("covers payments, tab, customer tabs, bills, bookings and snack data", () => {
    for (const k of [
      "payments",
      "tab_entries",
      "customer_tabs",
      "bills",
      "turf_bookings",
      "snack_sales",
      "snack_items",
    ])
      expect(VOID_QUERY_KEYS).toContain(k);
  });
});

describe("F-DRAWER: refund timeline is the real cash timeline", () => {
  it("received day 1, refunded day 2: +500 on day 1, -500 on day 2, 0 overall", () => {
    const refunded = bk("Cancelled", {
      advance_paid: 500,
      is_refundable: true,
      refunded_at: "2026-10-11T06:00:00.000Z",
      refund_mode: "Cash",
      booking_date: "2026-10-10",
    });
    const s = src([refunded]);
    const day1 = drawerCashOn(s, "2026-10-10");
    const day2 = drawerCashOn(s, "2026-10-11");
    expect(day1.expected).toBe(500);
    expect(day2.expected).toBe(-500);
    expect(day1.expected + day2.expected).toBe(0);
    // paid back, so it is no longer a liability and never income
    const stats = periodStats(s, () => true);
    expect(stats.refundableAdvance).toBe(0);
    expect(stats.forfeitedRevenue).toBe(0);
    expect(stats.revenue).toBe(0);
  });
});
