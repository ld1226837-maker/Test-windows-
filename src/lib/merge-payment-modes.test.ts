import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import {
  buildMergedItems,
  mergeIntoBill,
  previewMerge,
  unmergeBill,
} from "./merge";
import { billReceipt } from "./receipt";
import { modeBreakdown, modeLines } from "./payment-breakdown";
import { setReceiptPayments } from "./payments";
import { db, type SnackSaleRow, type TurfBookingRow } from "./localdb";
import type { Bill } from "./biz";

const booking = (over: Partial<TurfBookingRow> = {}): TurfBookingRow =>
  ({
    id: "pm-b1",
    booking_no: "B-PM1",
    booking_date: "2026-09-01",
    customer_name: "Ravi",
    phone: "9876543210",
    slot_name: "Evening",
    hours: 1,
    rate_per_hour: 1000,
    total_amount: 1000,
    advance_paid: 400,
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
    ...over,
  }) as TurfBookingRow;

const sale = (over: Partial<SnackSaleRow> = {}): SnackSaleRow =>
  ({
    id: "pm-s1",
    bill_no: "SNK-PM1",
    sale_date: "2026-09-01",
    customer_name: "Ravi",
    items: [
      {
        item_name: "Chips",
        qty: 2,
        unit_price: 100,
        amount: 200,
        cost_price: 50,
      },
    ],
    total: 200,
    profit: 100,
    payment_mode: "UPI",
    notes: null,
    booking_id: null,
    booking_no: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  }) as SnackSaleRow;

const pay = (
  id: string,
  parent_type: "turf_booking" | "snack_sale",
  parent_id: string,
  amount: number,
  mode: string,
  t: string,
) => ({
  id,
  parent_type,
  parent_id,
  amount,
  mode,
  received_at: "2026-09-01",
  created_at: t,
});

describe("modeBreakdown()", () => {
  it("separates Cash and Online and only reports a split for 2+ modes", () => {
    const b = modeBreakdown([
      { amount: 700, mode: "Cash" },
      { amount: 200, mode: "UPI" },
      { amount: 100, mode: "Card" },
    ]);
    expect(b.cash).toBe(700);
    expect(b.online).toBe(300);
    expect(b.total).toBe(1000);
    expect(b.onlineModes).toBe("UPI + Card");
    expect(b.split).toContain("Cash");
    expect(modeBreakdown([{ amount: 500, mode: "Cash" }]).split).toBeNull();
    expect(modeLines(modeBreakdown([]))).toEqual([]);
  });
});

describe("merged bill keeps the payment mode data", () => {
  it("preview, saved bill and receipt agree on Cash / Online / split", async () => {
    const b = booking();
    const s = sale();
    await db.turf_bookings.add(b);
    await db.snack_sales.add(s);
    // Turf advance ₹400 split Cash 300 + UPI 100; snack ₹200 paid in UPI.
    const rows = [
      pay(
        "pm-p1",
        "turf_booking",
        b.id,
        300,
        "Cash",
        "2026-09-01T10:00:00.000Z",
      ),
      pay(
        "pm-p2",
        "turf_booking",
        b.id,
        100,
        "UPI",
        "2026-09-01T10:00:00.100Z",
      ),
      pay("pm-p3", "snack_sale", s.id, 200, "UPI", "2026-09-01T10:05:00.000Z"),
    ];
    await db.payments.bulkAdd(rows);

    const built = buildMergedItems([b], [s] as never);
    const preview = previewMerge({
      total: built.total,
      bookings: [
        {
          id: b.id,
          advance_paid: 400,
          payment_mode: "Cash",
          booking_date: b.booking_date,
        },
      ],
      sales: [
        { id: s.id, total: 200, payment_mode: "UPI", sale_date: s.sale_date },
      ],
      tabEntries: [],
      payments: rows as never,
    });
    expect(preview.received.cash).toBe(300);
    expect(preview.received.online).toBe(300);
    expect(preview.received.split).toContain("Cash");
    expect(preview.collected).toBe(600);

    const bill = await mergeIntoBill({
      name: "Ravi",
      phone: null,
      bookingIds: [b.id],
      saleIds: [s.id],
      items: built.items,
      subtotal: built.subtotal,
      discount: built.discount,
      total: built.total,
      putOnTab: true,
    });

    // Saved bill carries the same money, by mode.
    const billRows = await db.payments
      .where("parent_id")
      .equals(bill.id)
      .toArray();
    const saved = modeBreakdown(billRows);
    expect(saved.cash).toBe(preview.received.cash);
    expect(saved.online).toBe(preview.received.online);
    expect(bill.merged_breakdown?.turf_modes?.length).toBe(2);
    expect(bill.merged_breakdown?.snacks[0]?.modes?.[0]?.mode).toBe("UPI");

    // Receipt prints Cash received, Online received, Split payment, per part.
    setReceiptPayments(await db.payments.toArray());
    const doc = billReceipt(bill as Bill);
    const label = (l: string) => doc.totals.find((t) => t.label.startsWith(l));
    expect(label("Cash received")?.value).toMatch(/300/);
    expect(label("Online received (UPI)")?.value).toMatch(/300/);
    expect(label("Split payment")?.value).toMatch(/Cash.*UPI/);
    expect(label("Turf paid")?.value).toMatch(/Cash.*UPI/);
    expect(label("Snacks paid (SNK-PM1)")?.value).toMatch(/UPI/);
    expect(label("Mode")?.value).toBe("Split (Cash + UPI)");

    // Un-merge removes the copied bill rows; sources keep theirs.
    await unmergeBill(bill.id);
    expect(await db.payments.where("parent_id").equals(bill.id).count()).toBe(
      0,
    );
    expect(await db.payments.where("parent_id").equals(b.id).count()).toBe(2);
    expect(await db.payments.where("parent_id").equals(s.id).count()).toBe(1);
  });

  it("a legacy merged bill (no breakdown) prints exactly as before", () => {
    setReceiptPayments([]);
    const legacy = {
      id: "legacy-1",
      invoice_no: "INV-L1",
      customer_name: "Old",
      customer_phone: null,
      items: [{ item: "Turf", qty: 1, rate: 1000, total: 1000, unit: "hr" }],
      subtotal: 1000,
      discount: 0,
      total: 1000,
      tax_amount: 0,
      tax_lines: [],
      amount_paid: 0,
      status: "unpaid",
      payment_mode: "On tab",
      bill_date: "2026-09-01T00:00:00.000Z",
      created_at: "2026-09-01T00:00:00.000Z",
    } as unknown as Bill;
    const doc = billReceipt(legacy);
    expect(doc.totals.some((t) => t.label === "Cash received")).toBe(false);
    expect(doc.totals.find((t) => t.label === "Mode")?.value).toBe("On tab");
  });
});
