import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { periodStats, type Sources } from "./analytics";
import type { Bill } from "./biz";
import { billDue, customerOutstanding } from "./dues";
import { collectBillPayment } from "./collect";
import { billShareText } from "./receipt";
import { db, type SnackSaleRow, type TurfBookingRow } from "./localdb";
import {
  WALK_IN_NAME,
  buildMergedItems,
  distinctMergeCustomers,
  mergeIntoBill,
  orderCandidates,
  resolveMergeCustomer,
} from "./merge";
import type { SnackSale, TurfBooking } from "./ops";
import type { TabEntry } from "./tabs";

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

const merge = (
  b: TurfBookingRow[],
  s: SnackSaleRow[],
  over: Partial<Parameters<typeof mergeIntoBill>[0]> = {},
) => {
  const built = buildMergedItems(b as never, s as never);
  return mergeIntoBill({
    name: "Ravi",
    phone: "9876543210",
    bookingIds: b.map((x) => x.id),
    saleIds: s.map((x) => x.id),
    items: built.items,
    subtotal: built.subtotal,
    discount: built.discount,
    total: built.total,
    dueMode: "pending",
    ...over,
  });
};

const seed = async (b: TurfBookingRow[], s: SnackSaleRow[]) => {
  await db.turf_bookings.bulkAdd(b);
  await db.snack_sales.bulkAdd(s);
};

/** Everything the money screens read, straight from the database. */
async function world() {
  const [bills, bookings, sales, tabEntries] = await Promise.all([
    db.bills.toArray(),
    db.turf_bookings.toArray(),
    db.snack_sales.toArray(),
    db.tab_entries.toArray(),
  ]);
  const src = {
    bills: bills as unknown as Bill[],
    bookings: bookings as unknown as TurfBooking[],
    sales: sales as unknown as SnackSale[],
    expenses: [],
    tabEntries: tabEntries as unknown as TabEntry[],
  } as Sources;
  return {
    src,
    outstanding: customerOutstanding(
      { name: "Ravi", phone: "9876543210" },
      {
        bills: src.bills,
        bookings: src.bookings,
        tabEntries: src.tabEntries ?? [],
      },
    ),
    stats: periodStats(src, () => true),
  };
}

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

describe("pending merge (Phase 1)", () => {
  it("merges with ZERO money collected: unpaid bill, due counted once everywhere", async () => {
    await seed([booking()], [sale()]);
    const bill = await merge([booking()], [sale()]);

    expect(bill.status).toBe("unpaid");
    expect(bill.amount_paid).toBe(0);
    expect(bill.total).toBe(1100);
    expect(bill.payment_mode).toBeNull();

    const w = await world();
    // Outstanding: the one bill line, nothing on the sources or the tab.
    expect(w.outstanding.total).toBe(1100);
    expect(w.outstanding.bills).toBe(1100);
    expect(w.outstanding.bookings).toBe(0);
    expect(w.outstanding.tab).toBe(0);
    // Dashboard + Reports read the same periodStats.
    expect(w.stats.dues).toBe(1100);
  });

  it("works when the owner types no name or phone (takes the first booking's)", async () => {
    await seed([booking()], [sale()]);
    const bill = await merge([booking()], [sale()], { name: "", phone: "" });
    expect(bill.customer_name).toBe("Ravi");
    expect(bill.customer_phone).toBe("9876543210");
  });

  it("falls back to Walk-in customer for a nameless snack-only merge", async () => {
    const s = sale({ customer_name: null });
    await seed([], [s]);
    const bill = await merge([], [s], { name: "", phone: null });
    expect(bill.customer_name).toBe(WALK_IN_NAME);
    expect(bill.status).toBe("unpaid");
  });

  it("advance only: partial, amount_paid is the real advance, due once", async () => {
    const b = booking({ advance_paid: 400 });
    await seed([b], [sale()]);
    const bill = await merge([b], [sale()]);

    expect(bill.status).toBe("partial");
    expect(bill.amount_paid).toBe(400);
    expect(bill.merged_breakdown?.turf_advance).toBe(400);
    const w = await world();
    expect(w.outstanding.total).toBe(700);
    expect(w.stats.dues).toBe(700);
  });

  it("snacks paid, turf unpaid: breakdown keeps them as separate lines", async () => {
    const s = sale({ payment_mode: "Cash" });
    await seed([booking()], [s]);
    const bill = await merge([booking()], [s]);

    expect(bill.status).toBe("partial");
    expect(bill.amount_paid).toBe(100);
    expect(bill.merged_breakdown?.turf_advance).toBe(0);
    expect(bill.merged_breakdown?.snacks[0]?.paid).toBe(100);
    expect((await world()).outstanding.total).toBe(1000);
  });

  it("a source already on the tab moves onto the bill: still counted once", async () => {
    await seed([booking()], [sale()]);
    // Snack billed On tab posts its charge to the tab ledger.
    await db.tab_entries.add({
      id: "te1",
      tab_id: "t1",
      customer_key: "p:9876543210",
      kind: "charge",
      business: "Snacks",
      amount: 100,
      note: null,
      ref_type: "snack_sale",
      ref_id: "ss1",
      source_ref_type: null,
      source_ref_id: null,
      entry_date: "2026-10-10",
      created_at: "2026-10-10T00:00:00.000Z",
    } as never);
    await merge([booking()], [sale()]);
    const w = await world();
    expect(w.outstanding.tab).toBe(0);
    expect(w.outstanding.total).toBe(1100);
    expect(w.stats.dues).toBe(1100);
  });

  it("copy/WhatsApp text of a zero-payment merged bill is plain ASCII and says PENDING", async () => {
    await seed([booking()], [sale()]);
    const bill = await merge([booking()], [sale()]);
    const text = billShareText(bill);
    expect(text).toContain("Status: PENDING");
    expect(text).toContain("Paid: Rs 0");
    expect(text).toContain("Rs 1,100");
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
  });

  it("merging the same record twice is refused", async () => {
    await seed([booking()], [sale()]);
    await merge([booking()], [sale()]);
    await expect(merge([booking()], [])).rejects.toThrow(
      /already on another bill/,
    );
    await expect(merge([], [sale()])).rejects.toThrow(
      /already on another bill/,
    );
    expect(await db.bills.count()).toBe(1);
  });

  it("paying the pending bill later settles it without moving the due twice", async () => {
    await seed([booking()], [sale()]);
    const bill = await merge([booking()], [sale()]);
    await collectBillPayment({
      bill,
      entries: [{ amount: 1100, mode: "UPI" }],
    });
    const w = await world();
    expect(w.outstanding.total).toBe(0);
    expect(w.stats.dues).toBe(0);
    const stored = await db.bills.get(bill.id);
    expect(stored?.status).toBe("paid");
    expect(billDue(stored as unknown as Bill, w.src.tabEntries ?? [])).toBe(0);
  });
});

describe("merge customer + candidate helpers", () => {
  it("typed values win; blanks come from the first picked record", () => {
    expect(
      resolveMergeCustomer({ name: "Sam", phone: "" }, [
        { name: "Ravi", phone: "9876543210" },
      ]),
    ).toEqual({ name: "Sam", phone: "9876543210" });
    expect(resolveMergeCustomer({}, [])).toEqual({
      name: WALK_IN_NAME,
      phone: null,
    });
  });

  it("flags a second customer but ignores nameless records", () => {
    expect(
      distinctMergeCustomers([
        { name: "Ravi", phone: "9876543210" },
        { name: null, phone: null },
        { name: "Ravi", phone: "98765 43210" },
      ]),
    ).toHaveLength(1);
    expect(
      distinctMergeCustomers([
        { name: "Ravi", phone: "9876543210" },
        { name: "Sam", phone: null },
      ]),
    ).toHaveLength(2);
  });

  it("groups by phone first, then name; anchor customer first", () => {
    const rows = [
      { id: 1, name: "Sam", phone: null },
      { id: 2, name: "Ravi K", phone: "9876543210" },
      { id: 3, name: "Walk", phone: null },
      { id: 4, name: null, phone: null },
    ];
    const anchor = "p:9876543210";
    expect(orderCandidates(rows, anchor, true).map((r) => r.id)).toEqual([
      2, 4,
    ]);
    expect(orderCandidates(rows, anchor, false).map((r) => r.id)).toEqual([
      2, 4, 1, 3,
    ]);
    expect(orderCandidates(rows, null, true)).toHaveLength(4);
  });
});
