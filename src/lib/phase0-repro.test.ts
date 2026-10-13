import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { billDue, isFinancialBooking, isFinancialSale } from "./dues";
import { mergeIntoBill, buildMergedItems } from "./merge";
import { db, type SnackSaleRow, type TurfBookingRow } from "./localdb";
import type { Bill } from "./biz";
import { netTabAmountFor } from "./dues";
import { TAB_REF_BILL, type TabEntry } from "./tabs";

const booking = (over: Partial<TurfBookingRow> = {}): TurfBookingRow =>
  ({
    id: "bk1",
    booking_no: "B-1",
    booking_date: "2026-10-10",
    customer_name: "Ravi",
    phone: "9876543210",
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
    created_at: "2026-10-10T00:00:00.000Z",
    ...over,
  }) as TurfBookingRow;

const sale = (over: Partial<SnackSaleRow> = {}): SnackSaleRow =>
  ({
    id: "ss1",
    bill_no: "S-1",
    sale_date: "2026-10-10",
    customer_name: "Ravi",
    items: [
      {
        item_name: "Chips",
        qty: 2,
        unit_price: 50,
        cost_price: 30,
        amount: 100,
      },
    ],
    total: 100,
    profit: 40,
    payment_mode: "On tab",
    notes: null,
    merged_into_bill_id: null,
    created_at: "2026-10-10T00:00:00.000Z",
    ...over,
  }) as SnackSaleRow;

beforeEach(async () => {
  await Promise.all([
    db.bills.clear(),
    db.turf_bookings.clear(),
    db.snack_sales.clear(),
    db.tab_entries.clear(),
    db.customer_tabs.clear(),
    db.payments.clear(),
  ]);
});

const input = (
  b: TurfBookingRow[],
  s: SnackSaleRow[],
  over: Partial<Parameters<typeof mergeIntoBill>[0]> = {},
) => {
  const built = buildMergedItems(b as never, s as never);
  return {
    name: "Ravi",
    phone: "9876543210",
    bookingIds: b.map((x) => x.id),
    saleIds: s.map((x) => x.id),
    items: built.items,
    subtotal: built.subtotal,
    discount: built.discount,
    total: built.total,
    putOnTab: false,
    ...over,
  };
};

describe("PHASE 0 - why can't the owner merge with nothing paid?", () => {
  it("S1: zero advance, name typed, putOnTab=false -> bill IS created (unpaid)", async () => {
    await db.turf_bookings.add(booking());
    await db.snack_sales.add(sale({ payment_mode: "Cash" }));
    const bill = await mergeIntoBill(
      input([booking()], [sale({ payment_mode: "Cash" })]),
    );
    console.log(
      "S1",
      bill.status,
      bill.amount_paid,
      bill.payment_mode,
      bill.total,
    );
    expect(bill.status).toBe("partial"); // snack was paid in cash -> 100 collected
  });

  it("S2: zero money anywhere (turf advance 0 + snack On tab), putOnTab=false", async () => {
    await db.turf_bookings.add(booking());
    await db.snack_sales.add(sale());
    const bill = await mergeIntoBill(input([booking()], [sale()]));
    console.log("S2", bill.status, bill.amount_paid, bill.payment_mode);
    expect(bill.status).toBe("unpaid");
    const entries = (await db.tab_entries.toArray()) as unknown as TabEntry[];
    console.log("S2 due on bill", billDue(bill as unknown as Bill, entries));
  });

  it("S3: same but putOnTab=true", async () => {
    await db.turf_bookings.add(booking());
    await db.snack_sales.add(sale());
    const bill = await mergeIntoBill(
      input([booking()], [sale()], { putOnTab: true }),
    );
    const entries = (await db.tab_entries.toArray()) as unknown as TabEntry[];
    console.log(
      "S3",
      bill.status,
      bill.payment_mode,
      "billDue",
      billDue(bill as unknown as Bill, entries),
      "tab charge on bill",
      netTabAmountFor(entries, TAB_REF_BILL, bill.id),
    );
  });

  it("S4: EMPTY NAME - Phase 0 refused here; Phase 1 now falls back to the first source", async () => {
    await db.turf_bookings.add(booking());
    const bill = await mergeIntoBill(input([booking()], [], { name: "" }));
    expect(bill.customer_name).toBe("Ravi");
  });

  it("S5: already merged -> refused; and hidden from candidates", async () => {
    await db.turf_bookings.add(booking());
    const first = await mergeIntoBill(input([booking()], []));
    await expect(mergeIntoBill(input([booking()], []))).rejects.toThrow(
      /already on another bill/,
    );
    const after = (await db.turf_bookings.get("bk1"))!;
    expect(after.merged_into_bill_id).toBe(first.id);
    expect(isFinancialBooking(after as never)).toBe(false);
  });

  it("S6: a booking whose balance is already on the tab is still a candidate", async () => {
    const b = booking({ advance_paid: 1000 }); // 'put on tab' writes advance=total
    expect(isFinancialBooking(b as never)).toBe(true);
    expect(isFinancialSale(sale() as never)).toBe(true);
  });

  it("S7: No-show / Cancelled bookings are hidden from candidates", () => {
    expect(isFinancialBooking(booking({ status: "No-show" }) as never)).toBe(
      false,
    );
    expect(isFinancialBooking(booking({ status: "Cancelled" }) as never)).toBe(
      false,
    );
  });
});
