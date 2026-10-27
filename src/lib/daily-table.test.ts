import { describe, expect, it } from "vitest";
import {
  COLUMN_HEADERS,
  buildDailyTable,
  buildDailyTableText,
  formatCell,
  previousDay,
  rowCells,
  totalCells,
  type DailyTableDay,
} from "./daily-table";

const DAY = "2026-10-27";

const booking = (o: Record<string, unknown>) =>
  ({
    id: "b",
    booking_no: "T-1",
    booking_date: DAY,
    customer_name: "Ravi",
    phone: null,
    slot_name: "Evening",
    hours: 1,
    rate_per_hour: 1200,
    total_amount: 0,
    advance_paid: 0,
    payment_mode: "Cash",
    status: "Completed",
    discount: 0,
    notes: null,
    start_time: "5:30 PM",
    end_time: "6:30 PM",
    courts: 1,
    court_ids: null,
    snacks: [],
    snacks_total: 0,
    turf_amount: 1200,
    ...o,
  }) as never;

const T1 = "2026-10-27T10:00:00.000Z";
const T2 = "2026-10-27T13:00:00.000Z";
let n = 0;
const pay = (
  parent_id: string,
  amount: number,
  mode: string,
  created_at: string,
  parent_type = "turf_booking",
) =>
  ({
    id: `p${++n}`,
    parent_type,
    parent_id,
    amount,
    mode,
    received_at: DAY,
    created_at,
  }) as never;

const sale = (o: Record<string, unknown>) =>
  ({
    id: "s",
    bill_no: "S-1",
    sale_date: DAY,
    customer_name: "Walk-in",
    items: [],
    total: 100,
    profit: 10,
    payment_mode: "Cash",
    notes: null,
    ...o,
  }) as never;

const expense = (o: Record<string, unknown>) =>
  ({
    id: "e",
    expense_no: null,
    business: "Turf",
    category: "Other",
    description: null,
    note: null,
    amount: 100,
    spent_at: DAY,
    receipt_path: null,
    payment_mode: "Cash",
    cash_part: null,
    ...o,
  }) as never;

const day = (o: Partial<DailyTableDay> = {}): DailyTableDay => ({
  date: DAY,
  bookings: [],
  sales: [],
  bills: [],
  payments: [],
  expenses: [],
  tabEntries: [],
  ...o,
});

/** The four-booking worked example from the owner's brief. */
function workedExample(): DailyTableDay {
  return day({
    bookings: [
      // 5:30-6:30  Total 1200, advance 500, then 100 cash + 600 online
      booking({ id: "b1", advance_paid: 1200 }),
      // 6:30-8:00  Total 1800, no advance, 200 cash + 1600 online, extra 30 min
      booking({
        id: "b2",
        start_time: "6:30 PM",
        end_time: "8:00 PM",
        hours: 1.5,
        turf_amount: 1800,
        advance_paid: 1800,
        notes: "extra 30 min",
      }),
      // 9:00-10:30  Total 1800 after an 800 offer; 570 cash + 380 online, the
      // other 850 was put on the customer's tab.
      booking({
        id: "b3",
        start_time: "9:00 PM",
        end_time: "10:30 PM",
        hours: 1.5,
        turf_amount: 2600,
        discount: 800,
        advance_paid: 1800,
      }),
      // 11:00-12:00  Total 1200, advance 600, then 300 cash + 300 online
      booking({
        id: "b4",
        start_time: "11:00 PM",
        end_time: "12:00 AM",
        advance_paid: 1200,
      }),
    ],
    payments: [
      pay("b1", 500, "UPI", T1),
      pay("b1", 100, "Cash", T2),
      pay("b1", 600, "UPI", T2),
      pay("b2", 200, "Cash", T1),
      pay("b2", 1600, "UPI", T1),
      pay("b3", 570, "Cash", T1),
      pay("b3", 380, "UPI", T1),
      pay("b4", 600, "Cash", T1),
      pay("b4", 300, "Cash", T2),
      pay("b4", 300, "UPI", T2),
    ],
    tabEntries: [
      {
        id: "t1",
        tab_id: "tab",
        customer_key: "ravi",
        kind: "charge",
        business: "Turf",
        amount: 850,
        note: null,
        ref_type: "turf_booking",
        ref_id: "b3",
        entry_date: DAY,
        created_at: T1,
      } as never,
    ],
    savedOldCash: { [DAY]: 2300 },
  });
}

describe("buildDailyTable - worked example", () => {
  const t = buildDailyTable(workedExample());

  it("has one row per booking, in clock order, with the exact cells", () => {
    expect(t.rows.map(rowCells)).toEqual([
      ["5:30-6:30", "1200", "0", "500", "100", "600", "Advance paid"],
      ["6:30-8:00", "1800", "0", "0", "200", "1600", "extra 30 min"],
      ["9:00-10:30", "1800", "800", "0", "570", "380", "Offer 800"],
      ["11:00-12:00", "1200", "0", "600", "300", "300", "Advance paid"],
    ]);
  });

  it("ALL TOTAL is 6000 | 800 | 1100 | 1170 | 2880", () => {
    expect(t.totals).toEqual({
      total: 6000,
      offer: 800,
      advance: 1100,
      cash: 1170,
      online: 2880,
    });
    expect(totalCells(t.totals)).toEqual([
      "ALL TOTAL",
      "6000",
      "800",
      "1100",
      "1170",
      "2880",
      "",
    ]);
  });

  it("cash block and FINAL TOTAL: 1170, 0, 1170, old cash 2300, final 3470", () => {
    expect(t.cashBlock).toEqual({
      specificCash: 1170,
      expenses: 0,
      remainingCash: 1170,
    });
    expect(t.oldCash).toBe(2300);
    expect(t.oldCashIsDefault).toBe(false);
    expect(t.finalTotal).toBe(3470);
  });

  it("the text fallback matches the mockup layout and numbers", () => {
    const text = buildDailyTableText(t);
    expect(text).toContain("Daily Summary 27-10-2026");
    expect(text).toContain("ALL TOTAL");
    expect(text).toMatch(/ALL TOTAL\s+6000\s+800\s+1100\s+1170\s+2880/);
    expect(text).toContain("Specific cash: Rs 1170   Expenses: Rs 0");
    expect(text).toContain("Remaining cash: Rs 1170   Old cash: Rs 2300");
    expect(text).toContain("FINAL TOTAL: Rs 3470");
    expect(text).toContain("6:30-8:00: extra 30 min");
  });

  it("has the seven column headers in order", () => {
    expect([...COLUMN_HEADERS]).toEqual([
      "TIME",
      "TOTAL",
      "OFFER",
      "ADVANCE",
      "CASH",
      "ONLINE",
      "NOTES",
    ]);
  });
});

describe("buildDailyTable - rows", () => {
  it("zero-advance booking paid in one go shows ADVANCE 0 (not Full payment as advance)", () => {
    const t = buildDailyTable(
      day({
        bookings: [booking({ id: "z", advance_paid: 1200 })],
        payments: [pay("z", 1200, "Cash", T1)],
      }),
    );
    expect(t.rows[0]).toMatchObject({
      total: 1200,
      advance: 0,
      cash: 1200,
      online: 0,
    });
  });

  it("split Cash + UPI lands in CASH and ONLINE", () => {
    const t = buildDailyTable(
      day({
        bookings: [booking({ id: "s", advance_paid: 1200 })],
        payments: [pay("s", 700, "Cash", T1), pay("s", 500, "UPI", T1)],
      }),
    );
    expect(t.rows[0]).toMatchObject({ cash: 700, online: 500 });
  });

  it("an offer larger than the total is clamped and never negative", () => {
    const t = buildDailyTable(
      day({
        bookings: [
          booking({
            id: "o",
            turf_amount: 500,
            hours: 1,
            rate_per_hour: 500,
            discount: 900,
          }),
        ],
      }),
    );
    expect(t.rows[0]!.offer).toBe(500);
    expect(t.rows[0]!.total).toBeGreaterThanOrEqual(0);
    expect(t.totals.total).toBeGreaterThanOrEqual(0);
  });

  it("a cancelled booking shows only its KEPT advance, never in CASH", () => {
    const t = buildDailyTable(
      day({
        bookings: [
          booking({
            id: "c",
            status: "Cancelled",
            advance_paid: 300,
            is_refundable: false,
          }),
          booking({
            id: "r",
            status: "Cancelled",
            advance_paid: 400,
            is_refundable: true,
            start_time: "8:00 PM",
            end_time: "9:00 PM",
          }),
          booking({ id: "x", status: "Cancelled", advance_paid: 0 }),
        ],
        payments: [pay("c", 300, "Cash", T1)],
      }),
    );
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      kind: "cancelled",
      total: 300,
      advance: 300,
      cash: 0,
      online: 0,
    });
    expect(t.rows[0]!.notes).toContain("Cancelled");
    expect(t.cashBlock.specificCash).toBe(0);
  });

  it("a booking merged into a bill appears once, through the bill", () => {
    const merged = booking({
      id: "m",
      merged_into_bill_id: "bill1",
      advance_paid: 1200,
    });
    const bill = {
      id: "bill1",
      invoice_no: "INV-0007",
      customer_name: "Ravi",
      customer_phone: null,
      items: [
        { item: "Turf", rate: 1200, qty: 1, total: 1200 },
        { item: "Tea", rate: 100, qty: 1, total: 100 },
      ],
      subtotal: 1300,
      discount: 0,
      total: 1300,
      amount_paid: 1300,
      status: "paid",
      payment_mode: "Cash",
      bill_date: DAY,
      merged_breakdown: {
        v: 1,
        turf_items: 1,
        turf_advance: 1200,
        turf_first: 500,
        turf_first_modes: [{ mode: "UPI", amount: 500 }],
        turf_balance_modes: [{ mode: "Cash", amount: 700 }],
        snacks: [
          {
            bill_no: "S-9",
            items: 1,
            amount: 100,
            paid: 100,
            modes: [{ mode: "UPI", amount: 100 }],
          },
        ],
      },
    } as never;
    const mergedSale = sale({
      id: "ms",
      merged_into_bill_id: "bill1",
      total: 100,
    });
    const t = buildDailyTable(
      day({
        bookings: [merged],
        bills: [bill],
        sales: [mergedSale],
        payments: [pay("m", 1200, "Cash", T1)],
      }),
    );
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      kind: "merged",
      time: "INV-0007",
      total: 1300,
      advance: 500,
      cash: 700,
      online: 100,
    });
    expect(t.totals.total).toBe(1300);
  });

  it("counter and booking-linked snack sales make ONE Snacks row, voided ones are left out", () => {
    const t = buildDailyTable(
      day({
        sales: [
          sale({ id: "s1", total: 100 }),
          sale({ id: "s2", total: 250, payment_mode: "UPI", booking_id: "x" }),
          sale({ id: "s3", total: 999, cancelled: true }),
          sale({ id: "s4", total: 80, payment_mode: "On tab" }),
        ],
        payments: [],
      }),
    );
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      kind: "snacks",
      time: "Snacks",
      total: 430,
      cash: 100,
      online: 250,
    });
  });

  it("sales and bookings of OTHER days are ignored", () => {
    const t = buildDailyTable(
      day({
        bookings: [booking({ id: "o", booking_date: "2026-10-26" })],
        sales: [sale({ id: "o", sale_date: "2026-10-28" })],
      }),
    );
    expect(t.rows).toHaveLength(0);
  });

  it("late-night slots sort after evening ones (6 AM - 6 AM business day)", () => {
    const t = buildDailyTable(
      day({
        bookings: [
          booking({ id: "late", start_time: "1 AM", end_time: "2 AM" }),
          booking({ id: "eve", start_time: "7 PM", end_time: "8 PM" }),
          booking({ id: "morn", start_time: "7 AM", end_time: "8 AM" }),
        ],
      }),
    );
    expect(t.rows.map((r) => r.time)).toEqual([
      "7:00-8:00",
      "7:00-8:00",
      "1:00-2:00",
    ]);
    expect(t.rows.map((r) => r.key)).toEqual([
      "booking:morn",
      "booking:eve",
      "booking:late",
    ]);
  });
});

describe("buildDailyTable - cash block and old cash", () => {
  const cashDay = (extra: Partial<DailyTableDay> = {}) =>
    day({
      bookings: [booking({ id: "c", turf_amount: 1000, advance_paid: 1000 })],
      payments: [pay("c", 1000, "Cash", T1)],
      ...extra,
    });

  it("subtracts only the CASH part of expenses", () => {
    const t = buildDailyTable(
      cashDay({
        expenses: [
          expense({ id: "e1", amount: 300 }),
          expense({
            id: "e2",
            amount: 500,
            payment_mode: "UPI",
            cash_part: 120,
          }),
          expense({ id: "e3", amount: 900, payment_mode: "UPI" }),
          expense({ id: "e4", amount: 700, spent_at: "2026-10-26" }),
        ],
      }),
    );
    expect(t.cashBlock).toEqual({
      specificCash: 1000,
      expenses: 420,
      remainingCash: 580,
    });
  });

  it("remaining cash is never negative", () => {
    const t = buildDailyTable(
      cashDay({ expenses: [expense({ amount: 5000 })], oldCashOverride: 100 }),
    );
    expect(t.cashBlock.remainingCash).toBe(0);
    expect(t.finalTotal).toBe(100);
  });

  it("old cash defaults to 0 with no history", () => {
    const t = buildDailyTable(cashDay());
    expect(t.oldCash).toBe(0);
    expect(t.oldCashIsDefault).toBe(true);
    expect(t.finalTotal).toBe(1000);
  });

  it("old cash defaults to the previous day's FINAL TOTAL", () => {
    const yesterday = "2026-10-26";
    const t = buildDailyTable(
      cashDay({
        bookings: [
          booking({ id: "c", turf_amount: 1000, advance_paid: 1000 }),
          booking({
            id: "y",
            booking_date: yesterday,
            turf_amount: 800,
            advance_paid: 800,
          }),
        ],
        payments: [pay("c", 1000, "Cash", T1), pay("y", 800, "Cash", T1)],
        expenses: [expense({ id: "ey", amount: 300, spent_at: yesterday })],
        savedOldCash: { [yesterday]: 200 },
      }),
    );
    // yesterday: cash 800 - expenses 300 = 500 remaining, + 200 old = 700 final
    expect(t.oldCash).toBe(700);
    expect(t.oldCashIsDefault).toBe(true);
    expect(t.finalTotal).toBe(1700);
  });

  it("a saved value, then a typed override, win over the default", () => {
    const saved = buildDailyTable(cashDay({ savedOldCash: { [DAY]: 450 } }));
    expect(saved.oldCash).toBe(450);
    expect(saved.oldCashIsDefault).toBe(false);
    const typed = buildDailyTable(
      cashDay({ savedOldCash: { [DAY]: 450 }, oldCashOverride: 90 }),
    );
    expect(typed.oldCash).toBe(90);
    expect(typed.finalTotal).toBe(1090);
  });

  it("a negative or junk old cash is treated as 0", () => {
    expect(buildDailyTable(cashDay({ oldCashOverride: -50 })).oldCash).toBe(0);
  });

  it("an empty day is a valid table of zeros", () => {
    const t = buildDailyTable(day());
    expect(t.rows).toEqual([]);
    expect(t.totals).toEqual({
      total: 0,
      offer: 0,
      advance: 0,
      cash: 0,
      online: 0,
    });
    expect(t.cashBlock).toEqual({
      specificCash: 0,
      expenses: 0,
      remainingCash: 0,
    });
    expect(t.finalTotal).toBe(0);
    expect(buildDailyTableText(t)).toContain("(no bookings or sales)");
  });

  it("is pure: the same input gives the same table and the input is untouched", () => {
    const d = workedExample();
    const before = JSON.stringify(d);
    expect(buildDailyTable(d)).toEqual(buildDailyTable(d));
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("helpers", () => {
  it("previousDay crosses month and year ends", () => {
    expect(previousDay("2026-11-01")).toBe("2026-10-31");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
  });
  it("formatCell is whole rupees as plain digits", () => {
    expect(formatCell(1170)).toBe("1170");
    expect(formatCell(123456.4)).toBe("123456");
    expect(formatCell(0)).toBe("0");
    expect(formatCell(NaN)).toBe("0");
  });
});
