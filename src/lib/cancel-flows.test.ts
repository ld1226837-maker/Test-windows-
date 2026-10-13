import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  drawerCashOn,
  paymentSplit,
  periodStats,
  type Sources,
} from "./analytics";
import type { Bill } from "./biz";
import { voidSnackSale } from "./cancel-flows";
import { customerOutstanding } from "./dues";
import { db, type SnackSaleRow, type TurfBookingRow } from "./localdb";
import { buildMergedItems, cancelInvoice, mergeIntoBill } from "./merge";
import type { SnackSale, TurfBooking } from "./ops";
import type { TabEntry } from "./tabs";
import { updateBillStatus } from "./data";

const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
// IST day key of NOW (the app keys days in Asia/Kolkata)
const dayOf = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(iso),
  );
const DAY = dayOf(NOW);

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
    start_time: "18:00",
    end_time: "19:00",
    courts: 1,
    snacks: [],
    snacks_total: 0,
    turf_amount: 1000,
    merged_into_bill_id: null,
    created_at: NOW,
    ...o,
  }) as TurfBookingRow;

const sale = (o: Partial<SnackSaleRow> = {}): SnackSaleRow =>
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
    payment_mode: "Cash",
    notes: null,
    booking_id: null,
    booking_no: null,
    merged_into_bill_id: null,
    created_at: NOW,
    ...o,
  }) as SnackSaleRow;

const plainBill = (o: Record<string, unknown> = {}) =>
  ({
    id: "inv1",
    invoice_no: "INV-1",
    bill_date: NOW,
    customer_name: "Ravi",
    customer_phone: "9876543210",
    items: [{ name: "Coaching", qty: 1, price: 500, amount: 500 }],
    subtotal: 500,
    discount: 0,
    total: 500,
    tax_amount: 0,
    amount_paid: 500,
    status: "paid",
    payment_mode: "Cash",
    created_at: NOW,
    ...o,
  }) as never;

const payRow = (
  parent_type: string,
  parent_id: string,
  amount: number,
  mode = "Cash",
) =>
  ({
    id: `pay-${parent_id}-${amount}`,
    parent_type,
    parent_id,
    amount,
    mode,
    received_at: NOW,
    created_at: NOW,
  }) as never;

async function snap() {
  const [bills, bookings, sales, tabEntries, payments, expenses] =
    await Promise.all([
      db.bills.toArray(),
      db.turf_bookings.toArray(),
      db.snack_sales.toArray(),
      db.tab_entries.toArray(),
      db.payments.toArray(),
      Promise.resolve([]),
    ]);
  const src = {
    bills: bills as unknown as Bill[],
    bookings: bookings as unknown as TurfBooking[],
    sales: sales as unknown as SnackSale[],
    expenses,
    tabEntries: tabEntries as unknown as TabEntry[],
    payments,
  } as unknown as Sources;
  const inDay = (iso: string) => dayOf(iso) === DAY;
  const split = paymentSplit(src, inDay);
  const stats = periodStats(src, inDay);
  const out = customerOutstanding(
    { name: "Ravi", phone: "9876543210" },
    {
      bills: src.bills,
      bookings: src.bookings,
      tabEntries: src.tabEntries ?? [],
    },
  );
  const cash = split.find((p) => p.name === "Cash")?.value ?? 0;
  const splitTotal = split.reduce((n, p) => n + p.value, 0);
  return {
    src,
    cash,
    splitTotal,
    drawer: drawerCashOn(src, DAY),
    outstanding: out.total,
    stats,
  };
}

/** Invariants every cancel path must keep, whatever the outcome. */
function assertConsistent(w: Awaited<ReturnType<typeof snap>>) {
  // Reports/Dashboard collected equals the Cash/UPI split (one source).
  expect(w.splitTotal).toBe(w.stats.collected - w.stats.tabCollected);
  // Dues on the Dashboard and Reports equal what Outstanding lists.
  expect(w.stats.dues).toBe(w.outstanding);
  // The drawer cash is the split's cash less refunds, never invented.
  expect(w.drawer.cashCollected).toBe(w.cash);
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

describe("cancel a paid invoice", () => {
  beforeEach(async () => {
    await db.bills.add(plainBill());
    await db.payments.add(payRow("bill", "inv1", 500));
  });

  it("refuses to cancel without a refund-or-keep decision, and changes nothing", async () => {
    await expect(cancelInvoice("inv1")).rejects.toThrow(/refund it or keep it/);
    expect((await db.bills.get("inv1"))?.status).toBe("paid");
    expect(await db.payments.count()).toBe(1);
  });

  it("KEEP: forfeited income, receipts kept, no outflow, nothing owed", async () => {
    const before = await snap();
    expect(before.cash).toBe(500);
    await cancelInvoice("inv1", { money: { decision: "keep" } });
    const w = await snap();
    expect(await db.payments.count()).toBe(1); // never deleted silently
    expect(w.stats.forfeitedRevenue).toBe(500);
    expect(w.stats.revenue).toBe(500); // kept money is income
    expect(w.stats.refundableAdvance).toBe(0);
    expect(w.cash).toBe(500);
    expect(w.drawer.cashRefunds).toBe(0);
    expect(w.drawer.expected).toBe(500);
    expect(w.outstanding).toBe(0);
    expect(w.stats.dues).toBe(0);
    assertConsistent(w);
  });

  it("REFUND (cash): income removed, one drawer outflow, receipts kept", async () => {
    await cancelInvoice("inv1", { money: { decision: "refund" } });
    const w = await snap();
    expect(await db.payments.count()).toBe(1);
    const row = await db.bills.get("inv1");
    expect(row).toMatchObject({
      status: "cancelled",
      is_refundable: true,
      amount_paid: 500,
      refund_mode: "Cash",
    });
    expect(w.stats.revenue).toBe(0);
    expect(w.stats.forfeitedRevenue).toBe(0);
    expect(w.stats.refundableAdvance).toBe(0); // already paid back
    expect(w.drawer.cashRefunds).toBe(500); // counted once
    expect(w.outstanding).toBe(0);
    assertConsistent(w);
  });

  it("F-DRAWER: cash received and refunded the same day nets the drawer to 0", async () => {
    await cancelInvoice("inv1", { money: { decision: "refund" } });
    const w = await snap();
    expect(w.cash).toBe(500); // the receipt stays on the day it arrived
    expect(w.drawer.cashRefunds).toBe(500); // the refund is its own outflow
    expect(w.drawer.expected).toBe(0);
  });

  it("REFUND by UPI never touches the cash drawer outflow", async () => {
    await cancelInvoice("inv1", {
      money: { decision: "refund", refund_mode: "UPI" },
    });
    expect((await snap()).drawer.cashRefunds).toBe(0);
  });

  it("cancelling twice is refused", async () => {
    await cancelInvoice("inv1", { money: { decision: "keep" } });
    await expect(
      cancelInvoice("inv1", { money: { decision: "keep" } }),
    ).rejects.toThrow(/already cancelled/);
  });
});

describe("cancel an unpaid invoice: nothing to refund, no question", () => {
  it("cancels with no decision and no due remains", async () => {
    await db.bills.add(
      plainBill({ status: "unpaid", amount_paid: 0, payment_mode: null }),
    );
    expect((await snap()).outstanding).toBe(500);
    await cancelInvoice("inv1");
    const w = await snap();
    expect(w.outstanding).toBe(0);
    expect(w.stats.dues).toBe(0);
    expect(w.stats.revenue).toBe(0);
    assertConsistent(w);
  });
});

describe("cancel a MERGED invoice", () => {
  const seedMerged = async () => {
    // turf 1000 with 400 advance + snack 100 paid cash
    await db.turf_bookings.add(booking({ advance_paid: 400 }));
    await db.payments.add(payRow("turf_booking", "bk1", 400));
    await db.snack_sales.add(sale());
    await db.payments.add(payRow("snack_sale", "ss1", 100));
    await db.snack_items.add({
      id: "it1",
      item_name: "Chips",
      stock_quantity: 10,
      low_stock_threshold: 2,
      is_active: true,
    } as never);
    const built = buildMergedItems(
      [booking({ advance_paid: 400 })] as never,
      [sale()] as never,
    );
    return mergeIntoBill({
      name: "Ravi",
      phone: "9876543210",
      bookingIds: ["bk1"],
      saleIds: ["ss1"],
      items: built.items,
      subtotal: built.subtotal,
      discount: built.discount,
      total: built.total,
      dueMode: "pending",
    });
  };

  it("(a) invoice only: sources come back as separate live bills; dues restored once", async () => {
    const bill = await seedMerged();
    const before = await snap();
    expect(before.outstanding).toBe(600); // 1100 - 400 - 100
    await cancelInvoice(bill.id, { scope: "invoice-only" });
    const w = await snap();
    expect((await db.bills.get(bill.id))?.status).toBe("cancelled");
    expect((await db.turf_bookings.get("bk1"))?.merged_into_bill_id).toBeNull();
    expect((await db.snack_sales.get("ss1"))?.merged_into_bill_id).toBeNull();
    expect((await db.turf_bookings.get("bk1"))?.status).toBe("Confirmed");
    expect((await db.snack_sales.get("ss1"))?.cancelled).toBeFalsy();
    expect(w.outstanding).toBe(600); // the same rupees, now on the booking
    expect(w.stats.dues).toBe(600);
    expect(w.cash).toBe(500); // the sources' own receipts, counted once
    assertConsistent(w);
  });

  it("(b) invoice and sources, REFUND: all cancelled, stock back, one outflow, no dues", async () => {
    const bill = await seedMerged();
    // the bill carried the receipts of its sources (500 collected)
    expect((await db.bills.get(bill.id))?.amount_paid).toBe(500);
    await expect(
      cancelInvoice(bill.id, { scope: "invoice-and-sources" }),
    ).rejects.toThrow(/refund it or keep it/);
    const { stockChanges } = await cancelInvoice(bill.id, {
      scope: "invoice-and-sources",
      money: { decision: "refund" },
    });
    const w = await snap();
    expect((await db.turf_bookings.get("bk1"))?.status).toBe("Cancelled");
    expect((await db.snack_sales.get("ss1"))?.cancelled).toBe(true);
    expect(stockChanges).toHaveLength(1);
    expect((await db.snack_items.get("it1"))?.stock_quantity).toBe(12);
    expect(w.outstanding).toBe(0);
    expect(w.stats.dues).toBe(0);
    expect(w.stats.revenue).toBe(0);
    expect(w.drawer.cashRefunds).toBe(500); // once, not per source
    assertConsistent(w);
  });

  it("(b) invoice and sources, KEEP: money counted once as income", async () => {
    const bill = await seedMerged();
    await cancelInvoice(bill.id, {
      scope: "invoice-and-sources",
      money: { decision: "keep" },
    });
    const w = await snap();
    expect(w.stats.forfeitedRevenue).toBe(500); // not 1000 (no double count)
    expect(w.cash).toBe(500);
    expect(w.drawer.cashRefunds).toBe(0);
    expect(w.outstanding).toBe(0);
    assertConsistent(w);
  });
});

describe("void a snack sale", () => {
  const withItem = () =>
    db.snack_items.add({
      id: "it1",
      item_name: "Chips",
      stock_quantity: 10,
      low_stock_threshold: 2,
      is_active: true,
    } as never);

  it("a paid sale needs a decision; KEEP counts it as income once", async () => {
    await db.snack_sales.add(sale());
    await db.payments.add(payRow("snack_sale", "ss1", 100));
    await withItem();
    await expect(voidSnackSale("ss1")).rejects.toThrow(/refund it or keep it/);
    await voidSnackSale("ss1", { decision: "keep" });
    const w = await snap();
    expect((await db.snack_items.get("it1"))?.stock_quantity).toBe(12);
    expect(await db.payments.count()).toBe(1);
    expect(w.stats.forfeitedRevenue).toBe(100);
    expect(w.cash).toBe(100);
    assertConsistent(w);
  });

  it("REFUND (cash): one outflow, no income", async () => {
    await db.snack_sales.add(sale());
    await db.payments.add(payRow("snack_sale", "ss1", 100));
    await voidSnackSale("ss1", { decision: "refund" });
    const w = await snap();
    expect(w.stats.revenue).toBe(0);
    expect(w.drawer.cashRefunds).toBe(100);
    assertConsistent(w);
  });

  it("an On-tab sale can now be voided: its tab charge is reversed, no question", async () => {
    await db.snack_sales.add(sale({ payment_mode: "On tab" }));
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
      entry_date: TODAY,
      created_at: NOW,
    } as never);
    await voidSnackSale("ss1");
    const w = await snap();
    const tab = (await db.tab_entries.toArray()) as unknown as TabEntry[];
    const net = tab.reduce(
      (n, e) => n + (e.kind === "charge" ? e.amount : -e.amount),
      0,
    );
    expect(net).toBe(0);
    expect(w.stats.revenue).toBe(0);
    expect(w.stats.collected).toBe(0); // the reversal is not cash
    assertConsistent(w);
  });

  it("a merged or already voided sale cannot be voided", async () => {
    await db.snack_sales.add(sale({ merged_into_bill_id: "x" }));
    await expect(voidSnackSale("ss1")).rejects.toThrow(/merged/);
    await db.snack_sales.clear();
    await db.snack_sales.add(sale({ cancelled: true }));
    await expect(voidSnackSale("ss1")).rejects.toThrow(/Already cancelled/);
  });
});

describe("mark a bill unpaid after money was received", () => {
  it("needs an explicit refund; records it; never a silent delete; once only", async () => {
    await db.bills.add(plainBill({ status: "partial", amount_paid: 200 }));
    await db.payments.add(payRow("bill", "inv1", 200));
    await expect(
      updateBillStatus({ id: "inv1", status: "unpaid", amount_paid: 0 }),
    ).rejects.toThrow(/Refund it to mark the bill unpaid/);
    expect((await db.bills.get("inv1"))?.status).toBe("partial");
    expect(await db.payments.count()).toBe(1);

    await updateBillStatus({
      id: "inv1",
      status: "unpaid",
      amount_paid: 0,
      refund: {},
    });
    const row = await db.bills.get("inv1");
    expect(row).toMatchObject({
      status: "unpaid",
      amount_paid: 0,
      refund_amount: 200,
      refund_mode: "Cash",
    });
    expect(row?.refunded_at).toBeTruthy();
    const w = await snap();
    // Its receipts are removed (so a later payment cannot pile onto stale
    // rows), which already takes the cash out of the drawer: no second
    // deduction as a refund outflow.
    expect(w.drawer.cashRefunds).toBe(0);
    expect(w.drawer.expected).toBe(0);
    expect(w.outstanding).toBe(500);
    assertConsistent(w);
  });

  it("with nothing received it just changes status", async () => {
    await db.bills.add(
      plainBill({ status: "unpaid", amount_paid: 0, payment_mode: null }),
    );
    await updateBillStatus({ id: "inv1", status: "unpaid", amount_paid: 0 });
    expect((await db.bills.get("inv1"))?.status).toBe("unpaid");
  });
});

describe("legacy data keeps its numbers", () => {
  it("a bill/sale cancelled before this model (no is_refundable) holds nothing", async () => {
    await db.bills.add(
      plainBill({ status: "cancelled", amount_paid: 500, payment_mode: null }),
    );
    await db.snack_sales.add(sale({ cancelled: true }));
    const w = await snap();
    expect(w.stats.revenue).toBe(0);
    expect(w.stats.forfeitedRevenue).toBe(0);
    expect(w.stats.collected).toBe(0);
    expect(w.outstanding).toBe(0);
  });
});
