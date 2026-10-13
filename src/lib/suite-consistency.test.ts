import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  duesAgeing,
  paymentSplit,
  periodStats,
  type Sources,
} from "./analytics";
import type { Bill } from "./biz";
import { isCancelled, isLive, pendingAmount } from "./bill-state";
import { voidSnackSale } from "./cancel-flows";
import {
  bookingDue,
  billDue,
  customerOutstanding,
  isFinancialBooking,
  pendingMoneyIndex,
} from "./dues";
import { db, type SnackSaleRow, type TurfBookingRow } from "./localdb";
import { mergePendingForCustomer } from "./merge";
import type { SnackSale, TurfBooking } from "./ops";
import type { TabEntry } from "./tabs";

const NOW = new Date().toISOString();

const booking = (o: Partial<TurfBookingRow>): TurfBookingRow =>
  ({
    id: "bk",
    booking_no: "B",
    booking_date: NOW,
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
    start_time: "6:00 PM",
    end_time: "7:00 PM",
    courts: 1,
    snacks: [],
    snacks_total: 0,
    turf_amount: 1000,
    merged_into_bill_id: null,
    created_at: NOW,
    ...o,
  }) as TurfBookingRow;

const sale = (o: Partial<SnackSaleRow>): SnackSaleRow =>
  ({
    id: "ss",
    bill_no: "S",
    sale_date: NOW,
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
    booking_id: null,
    booking_no: null,
    merged_into_bill_id: null,
    created_at: NOW,
    ...o,
  }) as SnackSaleRow;

const tabEntry = (saleId: string, amount: number) =>
  ({
    id: `te-${saleId}`,
    tab_id: "t1",
    customer_key: "p:9876543210",
    kind: "charge",
    business: "Snacks",
    amount,
    note: null,
    ref_type: "snack_sale",
    ref_id: saleId,
    source_ref_type: null,
    source_ref_id: null,
    entry_date: NOW.slice(0, 10),
    created_at: NOW,
  }) as never;

async function snap() {
  const [bills, bookings, sales, tabEntries, payments] = await Promise.all([
    db.bills.toArray(),
    db.turf_bookings.toArray(),
    db.snack_sales.toArray(),
    db.tab_entries.toArray(),
    db.payments.toArray(),
  ]);
  return {
    bills: bills as unknown as Bill[],
    bookings: bookings as unknown as TurfBooking[],
    sales: sales as unknown as SnackSale[],
    expenses: [],
    tabEntries: tabEntries as unknown as TabEntry[],
    payments,
  } as unknown as Sources;
}

beforeEach(async () => {
  await Promise.all([
    db.bills.clear(),
    db.turf_bookings.clear(),
    db.snack_sales.clear(),
    db.snack_items.clear(),
    db.snack_stock_history.clear(),
    db.tab_entries.clear(),
    db.customer_tabs.clear(),
    db.payments.clear(),
  ]);
  await db.customer_tabs.add({
    id: "t1",
    customer_key: "p:9876543210",
    customer_name: "Ravi",
    phone: "9876543210",
    status: "open",
    opened_at: NOW,
    closed_at: null,
    created_at: NOW,
  } as never);
});

describe("suite consistency: every surface reads the same pending money", () => {
  it("dashboard dues = outstanding = ageing = per-record pending, with dead records excluded", async () => {
    await db.turf_bookings.bulkAdd([
      booking({ id: "live", booking_no: "B-1", total_amount: 1000 }),
      booking({
        id: "part",
        booking_no: "B-2",
        customer_name: "Meena",
        phone: "9000000002",
        advance_paid: 400,
      }),
      booking({
        id: "noshow",
        booking_no: "B-3",
        customer_name: "Sam",
        phone: "9000000003",
        status: "No-show",
        advance_paid: 300,
      }),
      booking({
        id: "cxl",
        booking_no: "B-4",
        customer_name: "Zed",
        phone: "9000000004",
        status: "Cancelled",
      }),
    ]);
    await db.snack_sales.bulkAdd([
      sale({ id: "s-live", bill_no: "S-1" }),
      sale({ id: "s-void", bill_no: "S-2" }),
    ]);
    await db.tab_entries.bulkAdd([
      tabEntry("s-live", 100),
      tabEntry("s-void", 100),
    ]);
    await voidSnackSale("s-void", { decision: "keep" });

    const src = await snap();
    const all = () => true;
    const stats = periodStats(src, all);

    // 1. Per-record pending (the one definition).
    const turfPending = src.bookings.reduce(
      (n, b) => n + pendingAmount(b, { tabEntries: src.tabEntries ?? [] }),
      0,
    );
    expect(turfPending).toBe(1000 + 600);

    // 2. Ageing buckets add up to the same turf pending.
    const ageing = duesAgeing(src.bookings, Date.now(), src.tabEntries ?? []);
    expect(ageing.reduce((n, r) => n + r.amount, 0)).toBe(turfPending);

    // 3. No-show / cancelled never count as live or owed.
    for (const id of ["noshow", "cxl"]) {
      const b = src.bookings.find((x) => x.id === id)!;
      expect(isCancelled(b)).toBe(true);
      expect(isLive(b)).toBe(false);
      expect(isFinancialBooking(b)).toBe(false);
      expect(bookingDue(b, src.tabEntries ?? [])).toBe(0);
    }

    // 4. Outstanding per customer sums to the dashboard dues card.
    const customers = [
      { name: "Ravi", phone: "9876543210" },
      { name: "Meena", phone: "9000000002" },
      { name: "Sam", phone: "9000000003" },
      { name: "Zed", phone: "9000000004" },
    ];
    const outstanding = customers.reduce(
      (n, c) =>
        n +
        customerOutstanding(c, {
          bills: src.bills,
          bookings: src.bookings,
          tabEntries: src.tabEntries ?? [],
        }).total,
      0,
    );
    // Ravi: 1000 booking + 100 live tab sale (the voided one is reversed).
    expect(outstanding).toBe(1000 + 600 + 100);
    // The Dashboard card and the Outstanding screen use ONE function.
    const pending = pendingMoneyIndex({
      bills: src.bills,
      bookings: src.bookings,
      tabEntries: src.tabEntries ?? [],
    });
    expect(pending.total).toBe(outstanding);
    expect(pending.rows.map((r) => r.name).sort()).toEqual(["Meena", "Ravi"]);
    // periodStats().dues is the per-period bill+turf figure: it excludes
    // running-tab money by design, and the gap is exactly the tab part.
    expect(pending.total - stats.dues).toBe(
      pending.rows.reduce((n, r) => n + r.dues.tab, 0),
    );
  });

  it("a merged pending invoice is owed once on every surface", async () => {
    await db.turf_bookings.add(booking({ id: "live", booking_no: "B-1" }));
    await db.snack_sales.add(sale({ id: "s-live", bill_no: "S-1" }));
    await db.tab_entries.add(tabEntry("s-live", 100));

    const bill = await mergePendingForCustomer({
      name: "Ravi",
      phone: "9876543210",
    });
    const src = await snap();
    const stats = periodStats(src, () => true);
    const split = paymentSplit(src, () => true);
    const o = customerOutstanding(
      { name: "Ravi", phone: "9876543210" },
      {
        bills: src.bills,
        bookings: src.bookings,
        tabEntries: src.tabEntries ?? [],
      },
    );

    expect(
      billDue(
        src.bills.find((b) => b.id === bill.id)!,
        src.tabEntries ?? [],
      ),
    ).toBe(1100);
    expect(o.total).toBe(1100);
    expect(stats.dues).toBe(1100);
    expect(stats.billsDues).toBe(1100);
    expect(split.reduce((n, p) => n + p.value, 0)).toBe(0);
    expect(
      duesAgeing(src.bookings, Date.now(), src.tabEntries ?? []).reduce(
        (n, r) => n + r.amount,
        0,
      ),
    ).toBe(0);
  });
});

describe("exports read the same bill balance as the screens", () => {
  it("billExportStatus: pending, tab-moved, paid and cancelled bills", async () => {
    const { billExportStatus } = await import("./bill-export");
    const base = {
      id: "b1",
      invoice_no: "INV-1",
      customer_name: "Ravi",
      customer_phone: "9876543210",
      bill_date: NOW,
      subtotal: 1000,
      discount: 0,
      total: 1000,
      amount_paid: 0,
      status: "unpaid",
      payment_mode: null,
      items: [],
    } as unknown as Bill;
    expect(billExportStatus(base, [])).toEqual({
      Paid: 0,
      Balance: 1000,
      Status: "Pending",
    });
    expect(
      billExportStatus({ ...base, status: "paid", amount_paid: 1000 }, []),
    ).toEqual({ Paid: 1000, Balance: 0, Status: "Paid" });
    // A cancelled bill collected nothing, whatever amount_paid it kept.
    expect(
      billExportStatus({ ...base, status: "cancelled", amount_paid: 400 }, []),
    ).toEqual({ Paid: 0, Balance: 0, Status: "Cancelled" });
    // Balance moved to the running tab: the bill itself no longer owes it.
    const moved = [
      {
        id: "te",
        tab_id: "t1",
        customer_key: "p:9876543210",
        kind: "charge",
        business: "Bills",
        amount: 1000,
        ref_type: "bill",
        ref_id: "b1",
      },
    ] as unknown as TabEntry[];
    expect(billExportStatus(base, moved).Balance).toBe(0);
    // ...but it is not "Paid": the customer still owes it on the tab.
    expect(billExportStatus(base, moved).Status).toBe("Moved to dues");
  });
});

describe("snack export", () => {
  it("a voided sale exports as Cancelled with 0 Amount/Profit", async () => {
    const { snackExportLine } = await import("./snack-export");
    const live = sale({ id: "x" }) as unknown as SnackSale;
    const line = live.items[0]!;
    expect(snackExportLine(live, line)).toEqual({
      Status: "Active",
      Amount: 100,
      Profit: 40,
    });
    const dead = { ...live, cancelled: true } as SnackSale;
    expect(snackExportLine(dead, line)).toEqual({
      Status: "Cancelled",
      Amount: 0,
      Profit: 0,
    });
  });
});
