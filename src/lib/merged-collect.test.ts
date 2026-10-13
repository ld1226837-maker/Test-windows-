import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { buildMergedItems, mergeIntoBill } from "./merge";
import { collectMergedBillDue } from "./merged-collect";
import { netTabAmountFor, isTabCashPayment } from "./dues";
import { db, type TurfBookingRow } from "./localdb";
import { TAB_REF_BILL } from "./tabs";
import type { Bill } from "./biz";

const booking = {
  id: "mc-b1",
  booking_no: "B-MC1",
  booking_date: "2026-09-01",
  customer_name: "Meena",
  phone: "9876500000",
  slot_name: "Evening",
  hours: 1,
  rate_per_hour: 1000,
  total_amount: 1000,
  advance_paid: 0,
  payment_mode: "Cash",
  status: "Confirmed",
  discount: 0,
  notes: null,
  start_time: "18:00",
  end_time: "19:00",
  courts: 1,
  snacks: [],
  snacks_total: 0,
  turf_amount: 1000,
  merged_into_bill_id: null,
  created_at: "2026-09-01T00:00:00.000Z",
} as unknown as TurfBookingRow;

describe("collectMergedBillDue()", () => {
  it("records customer-level tab payments per mode and refuses over-collection", async () => {
    await db.turf_bookings.add(booking);
    const built = buildMergedItems([booking], []);
    const bill = (await mergeIntoBill({
      name: "Meena",
      phone: "9876500000",
      bookingIds: [booking.id],
      saleIds: [],
      items: built.items,
      subtotal: built.subtotal,
      discount: 0,
      total: built.total,
      putOnTab: true,
    })) as Bill;

    await expect(
      collectMergedBillDue({ bill, entries: [{ amount: 1500, mode: "Cash" }] }),
    ).rejects.toThrow(/more than/);

    const r = await collectMergedBillDue({
      bill,
      entries: [
        { amount: 600, mode: "Cash" },
        { amount: 400, mode: "UPI" },
      ],
    });
    expect(r.collected).toBe(1000);
    expect(r.balanceAfter).toBe(0);

    const rows = await db.tab_entries
      .filter((e) => e.kind === "payment" && !e.ref_type)
      .toArray();
    expect(rows.map((e) => [e.amount, e.payment_mode]).sort()).toEqual([
      [400, "UPI"],
      [600, "Cash"],
    ]);
    expect(rows.every((e) => isTabCashPayment(e))).toBe(true);
    // The bill's own tab charge is untouched (same as paying from Outstanding).
    const ledger = await db.tab_entries.toArray();
    expect(netTabAmountFor(ledger, TAB_REF_BILL, bill.id)).toBe(1000);
  });
});
