import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  drawerCashOn,
  paymentSplit,
  periodStats,
  type Sources,
} from "./analytics";
import type { Bill } from "./biz";
import { pendingLabel } from "./bill-state";
import { cancelInvoice, mergePendingForCustomer } from "./merge";
import { collectBillPayment } from "./collect";
import { customerOutstanding, saleStateLabel } from "./dues";
import { db, type SnackSaleRow, type TurfBookingRow } from "./localdb";
import type { SnackSale, TurfBooking } from "./ops";
import { paymentStateLabel } from "./payment-status";
import type { TabEntry } from "./tabs";

const NOW = new Date().toISOString();
const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
}).format(new Date(NOW));
const dayOf = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(iso),
  );

const booking = (o: Partial<TurfBookingRow> = {}): TurfBookingRow =>
  ({
    id: "bk1",
    booking_no: "B-1",
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

const onTabSale = (o: Partial<SnackSaleRow> = {}): SnackSaleRow =>
  ({
    id: "ss1",
    bill_no: "S-1",
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

const seedTab = async (saleId = "ss1", amount = 100) => {
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
  await db.tab_entries.add({
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
  } as never);
};

async function snap() {
  const [bills, bookings, sales, tabEntries, payments] = await Promise.all([
    db.bills.toArray(),
    db.turf_bookings.toArray(),
    db.snack_sales.toArray(),
    db.tab_entries.toArray(),
    db.payments.toArray(),
  ]);
  const src = {
    bills: bills as unknown as Bill[],
    bookings: bookings as unknown as TurfBooking[],
    sales: sales as unknown as SnackSale[],
    expenses: [],
    tabEntries: tabEntries as unknown as TabEntry[],
    payments,
  } as unknown as Sources;
  const inDay = (iso: string) => dayOf(iso) === DAY;
  const split = paymentSplit(src, inDay);
  const val = (n: string) => split.find((p) => p.name === n)?.value ?? 0;
  return {
    src,
    cash: val("Cash"),
    online: split
      .filter((p) => p.name !== "Cash")
      .reduce((n, p) => n + p.value, 0),
    drawer: drawerCashOn(src, DAY),
    stats: periodStats(src, inDay),
    outstanding: customerOutstanding(
      { name: "Ravi", phone: "9876543210" },
      {
        bills: src.bills,
        bookings: src.bookings,
        tabEntries: src.tabEntries ?? [],
      },
    ).total,
  };
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
});

describe("one-tap merge from Outstanding", () => {
  it("merges the customer's pending booking + pending snack bill into ONE pending invoice", async () => {
    await db.turf_bookings.add(booking());
    await db.snack_sales.add(onTabSale());
    await seedTab();
    expect((await snap()).outstanding).toBe(1100);

    const bill = await mergePendingForCustomer({
      name: "Ravi",
      phone: "9876543210",
    });
    expect(bill.status).toBe("unpaid");
    expect(bill.total).toBe(1100);
    expect((await db.turf_bookings.get("bk1"))?.merged_into_bill_id).toBe(
      bill.id,
    );
    expect((await db.snack_sales.get("ss1"))?.merged_into_bill_id).toBe(
      bill.id,
    );
    const w = await snap();
    expect(w.outstanding).toBe(1100); // the same rupees, counted once
    expect(w.stats.dues).toBe(1100);
  });

  it("does not drag a fully paid booking onto the invoice", async () => {
    await db.turf_bookings.add(booking({ advance_paid: 1000 }));
    await db.snack_sales.add(onTabSale());
    await seedTab();
    await expect(
      mergePendingForCustomer({ name: "Ravi", phone: "9876543210" }),
    ).rejects.toThrow(/pending turf booking and a pending snack bill/);
    expect(await db.bills.count()).toBe(0);
  });

  it("needs both kinds; another customer's records are left alone", async () => {
    await db.turf_bookings.bulkAdd([
      booking(),
      booking({
        id: "bk2",
        booking_no: "B-2",
        customer_name: "Sam",
        phone: "9000000000",
      }),
    ]);
    await db.snack_sales.add(onTabSale());
    await seedTab();
    const bill = await mergePendingForCustomer({
      name: "Ravi",
      phone: "9876543210",
    });
    expect((await db.turf_bookings.get("bk2"))?.merged_into_bill_id).toBeNull();
    expect(bill.total).toBe(1100);
  });
});

describe("collecting on a merged invoice", () => {
  const mergedInvoice = async () => {
    await db.turf_bookings.add(booking());
    await db.snack_sales.add(onTabSale());
    await seedTab();
    return mergePendingForCustomer({ name: "Ravi", phone: "9876543210" });
  };

  it("a part payment is counted once and also lands on the source booking", async () => {
    const bill = await mergedInvoice();
    await collectBillPayment({
      bill,
      entries: [{ amount: 600, mode: "UPI" }],
    });
    const w = await snap();
    expect(w.online).toBe(600); // split sees it once
    expect(w.cash).toBe(0);
    expect(w.drawer.expected).toBe(0); // UPI never reaches the cash drawer
    expect(w.outstanding).toBe(500);
    expect(w.stats.dues).toBe(500);
    // the source booking carries the payment (history), still excluded from totals
    expect((await db.turf_bookings.get("bk1"))?.advance_paid).toBe(600);
    expect(
      (await db.payments.toArray()).filter((p) => p.parent_id === "bk1"),
    ).toHaveLength(1);
  });

  it("cancel invoice only: bills come back already carrying the payment; nothing lost or doubled", async () => {
    const bill = await mergedInvoice();
    await collectBillPayment({
      bill,
      entries: [{ amount: 600, mode: "UPI" }],
    });
    await cancelInvoice(bill.id, { scope: "invoice-only" });
    const w = await snap();
    expect(w.online).toBe(600); // now counted from the booking, still once
    expect(w.outstanding).toBe(500); // 400 on the booking + 100 back on the tab
    // periodStats.dues is the turf + bill part; the running tab (100) is the rest
    expect(w.stats.dues).toBe(400);
  });

  it("money the bills cannot carry blocks invoice-only; invoice-and-bills handles it", async () => {
    const bill = await mergedInvoice();
    await collectBillPayment({
      bill,
      entries: [{ amount: 1100, mode: "UPI" }],
    });
    await expect(
      cancelInvoice(bill.id, { scope: "invoice-only" }),
    ).rejects.toThrow(/paid directly on this invoice/);
    expect((await db.bills.get(bill.id))?.status).toBe("paid"); // untouched
    await cancelInvoice(bill.id, {
      scope: "invoice-and-sources",
      money: { decision: "refund", refund_mode: "UPI" },
    });
    const w = await snap();
    expect(w.outstanding).toBe(0);
    expect(w.drawer.cashRefunds).toBe(0); // UPI refund is not a cash outflow
    expect(w.stats.revenue).toBe(0);
  });
});

describe("one wording for money still owed", () => {
  it("badges on every screen read the same: Pending Rs X", () => {
    expect(pendingLabel(1100)).toBe("Pending Rs 1,100");
    expect(paymentStateLabel("unpaid", 1100)).toBe("Pending Rs 1,100");
    expect(paymentStateLabel("partial", 1100)).toBe("Pending Rs 1,100");
    expect(paymentStateLabel("moved", 1100)).toBe("Pending Rs 1,100");
    expect(
      saleStateLabel(
        { payment_mode: "On tab", merged_into_bill_id: null, cancelled: false },
        null,
        1100,
      ),
    ).toBe("Pending Rs 1,100");
    expect(paymentStateLabel("paid")).toBe("Paid");
    expect(paymentStateLabel("cancelled")).toBe("Cancelled");
  });
});
