/**
 * Owner's daily ledger table: the ONE place the "Daily Summary" picture and its
 * text fallback read their numbers from, so the two can never disagree.
 *
 * Nothing here invents money rules. Every figure comes from a helper the rest
 * of the app already uses:
 *   TOTAL    bookingGrossTotal / billGrossTotal / snackSaleGrossTotal
 *   OFFER    the booking's (or bill's) discount, clamped to what it was taken off
 *   ADVANCE  the "Advance" payment lines of bookingPaymentBreakdown()
 *   CASH /   what came in at the counter on the day, i.e. the same
 *   ONLINE   "collected today without advance" rule as buildTurfDayFlowLines()
 *            in owner-bills.ts (balance lines + snack sales)
 *   EXPENSES expenseCashPart() (only the cash that left the drawer)
 *   CANCELLED isFinancialBooking() / bookingForfeitedRevenue()
 *
 * ADVANCE deliberately counts only lines whose stage is "Advance", NOT
 * bookingPaymentBreakdown().advance: that field also includes a "Full payment"
 * (one collection that cleared the booking), and owner-bills files such a line
 * under "without advance". Using `.advance` would show the same rupees in both
 * the ADVANCE and the CASH/ONLINE columns.
 *
 * Pure: no React, no storage, no clock. Every "remaining" figure is clamped at 0.
 */
import { dayKey } from "./analytics";
import { isCancelled } from "./bill-state";
import {
  billGrossTotal,
  billPaidAmount,
  bookingGrossTotal,
  bookingTaxable,
  formatDMY,
  snackSaleGrossTotal,
  type Bill,
} from "./biz";
import {
  bookingForfeitedRevenue,
  isFinancialBooking,
  isFinancialSale,
} from "./dues";
import type { PaymentRow } from "./localdb";
import { mergedBillBreakdown } from "./merge-breakdown";
import { expenseCashPart, rupees } from "./money";
import {
  TAB_PAYMENT_MODE,
  isOnlinePaymentMode,
  type ExpenseV2,
  type SnackSale,
  type TurfBooking,
} from "./ops";
import type { TabEntry } from "./tabs";
import { spanFromTimes } from "./slot-selection";
import {
  BUSINESS_DAY_END,
  BUSINESS_DAY_START,
  businessMinutes,
  minuteLabel,
  parseMinutes,
} from "./time-slot-utils";
import { bookingPaymentBreakdown } from "./turf-payments";

export type DailyTableRowKind = "booking" | "merged" | "cancelled" | "snacks";

export type DailyTableRow = {
  key: string;
  kind: DailyTableRowKind;
  /** "5:30-6:30" style label (or "Snacks" / the invoice number). */
  time: string;
  total: number;
  offer: number;
  advance: number;
  cash: number;
  online: number;
  notes: string;
  /** Customer name / phone shown under the time (empty for snacks). */
  customer?: string;
  phone?: string;
};

/** One expense of the day, listed under the table (DESCRIPTION / NOTES / AMOUNT). */
export type DailyTableExpense = {
  key: string;
  description: string;
  notes: string;
  /** Full amount of the expense (whole rupees). */
  amount: number;
  /** Part of it that left the cash drawer (what REMAINING CASH subtracts). */
  cash: number;
};

export type DailyTableTotals = {
  total: number;
  offer: number;
  advance: number;
  cash: number;
  online: number;
};

export type DailyTableCashBlock = {
  /** Sum of the CASH column. */
  specificCash: number;
  /** Cash-paid expenses of the day only. */
  expenses: number;
  /** specificCash - expenses, never below 0. */
  remainingCash: number;
};

export type DailyTable = {
  /** "YYYY-MM-DD". */
  date: string;
  rows: DailyTableRow[];
  totals: DailyTableTotals;
  cashBlock: DailyTableCashBlock;
  /** Every expense of the day, oldest first. */
  expenseList: DailyTableExpense[];
  /** Sum of the AMOUNT column of expenseList. */
  expenseTotal: number;
  /** Owner-typed (or defaulted) cash carried in from before. */
  oldCash: number;
  /** True when oldCash came from the previous day / zero, not from the owner. */
  oldCashIsDefault: boolean;
  /** remainingCash + oldCash. */
  finalTotal: number;
};

export type DailyTableDay = {
  /** "YYYY-MM-DD" business day to build. */
  date: string;
  bookings: TurfBooking[];
  sales: SnackSale[];
  bills: Bill[];
  payments: PaymentRow[];
  expenses: ExpenseV2[];
  tabEntries?: TabEntry[];
  /** Old cash saved per day ("YYYY-MM-DD" -> rupees), from app settings. */
  savedOldCash?: Record<string, number> | null | undefined;
  /** Value typed on screen right now; wins over the saved one. */
  oldCashOverride?: number | null | undefined;
};

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

const whole = (n: unknown) => Math.max(0, rupees(Number(n) || 0));

/** Collapses control characters / odd punctuation so canvas text stays plain. */
const clean = (s: string | null | undefined) =>
  String(s ?? "")
    .replace(/[\u00b7\u2022]/g, "|")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u20b9\s*/g, "Rs ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const shiftDate = (date: string, delta: number): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const t = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + delta));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
};

export const previousDay = (date: string) => shiftDate(date, -1);

function slotLabel(b: TurfBooking): string {
  const a = parseMinutes(b.start_time ?? null);
  const z = parseMinutes(b.end_time ?? null);
  // With AM/PM ("5:30 PM-6:30 PM", "5 AM-7 AM") so a late-night or next-day
  // slot cannot be misread.
  if (a !== null && z !== null) return `${minuteLabel(a)}-${minuteLabel(z)}`;
  return clean(b.slot_name) || "-";
}

/**
 * Note for a booking that runs past the 6 AM business-day cut-off into the next
 * day ("5-7 AM" starts in Late Night and ends the next morning; 7 PM -> 7 PM is
 * a 24 hr booking). Empty for an ordinary same-business-day slot.
 */
export function crossDayNote(b: {
  start_time?: string | null;
  end_time?: string | null;
}): string {
  const a = parseMinutes(b.start_time ?? null);
  const z = parseMinutes(b.end_time ?? null);
  if (a === null || z === null) return "";
  const span = spanFromTimes(a, z, 1);
  const end = businessMinutes(a) + span;
  if (end <= BUSINESS_DAY_END) return span === 1440 ? "24 hr booking" : "";
  const endAt = minuteLabel(z);
  return span === 1440
    ? `24 hr booking | ends next day ${endAt}`
    : `Ends next day ${endAt}`.trim();
}

/** Sort key inside the 6 AM - 6 AM business day (after-midnight slots last). */
function slotOrder(b: TurfBooking): number {
  const m = parseMinutes(b.start_time ?? null);
  if (m === null) return 99_999;
  return m < BUSINESS_DAY_START ? m + 1440 : m;
}

type Split = { cash: number; online: number };
const addSplit = (
  s: Split,
  mode: string | null | undefined,
  amount: number,
) => {
  const a = Number(amount) || 0;
  if (!(a > 0)) return;
  if (isOnlinePaymentMode(mode)) s.online += a;
  else s.cash += a;
};

/** Money-mode rows of a merged bill's remembered split ({mode, amount}[]). */
const addModes = (
  s: Split,
  list: { mode: string; amount: number }[] | undefined | null,
) => {
  for (const x of list ?? []) addSplit(s, x.mode, Number(x.amount));
};

/* ------------------------------------------------------------------ */
/* one day                                                              */
/* ------------------------------------------------------------------ */

type DayParts = {
  rows: DailyTableRow[];
  totals: DailyTableTotals;
  cashBlock: DailyTableCashBlock;
  expenseList: DailyTableExpense[];
  expenseTotal: number;
};

function computeDay(date: string, src: DailyTableDay): DayParts {
  const tabEntries = src.tabEntries ?? [];
  const rows: (DailyTableRow & { order: number })[] = [];

  // --- bookings played on the day -------------------------------------
  for (const b of src.bookings) {
    if (dayKey(b.booking_date) !== date) continue;

    // Merged into a bill: that bill is listed below instead (no double count).
    if (b.merged_into_bill_id) continue;

    if (!isFinancialBooking(b)) {
      // Cancelled / No-show: only a KEPT advance is income (never a refundable
      // one). It was received earlier, so it sits in ADVANCE and never in CASH.
      const kept = whole(bookingForfeitedRevenue(b, tabEntries));
      if (kept <= 0) continue;
      rows.push({
        key: `booking:${b.id}`,
        kind: "cancelled",
        time: slotLabel(b),
        total: kept,
        offer: 0,
        advance: kept,
        cash: 0,
        online: 0,
        customer: clean(b.customer_name),
        phone: clean(b.phone),
        notes: [
          /no-show/i.test(b.status)
            ? "No-show - advance kept"
            : "Cancelled - advance kept",
          crossDayNote(b),
          clean(b.notes),
        ]
          .filter(Boolean)
          .join(" | "),
        order: slotOrder(b),
      });
      continue;
    }

    const own = src.payments.filter(
      (r) => r.parent_type === "turf_booking" && r.parent_id === b.id,
    );
    const bd = bookingPaymentBreakdown(b, own, tabEntries);
    let advance = 0;
    const counter: Split = { cash: 0, online: 0 };
    for (const l of bd.lines) {
      if (l.stage === "Advance") advance += l.amount;
      else addSplit(counter, l.mode, l.amount);
    }

    const subtotal = bookingTaxable({ ...b, discount: 0 });
    rows.push({
      key: `booking:${b.id}`,
      kind: "booking",
      time: slotLabel(b),
      total: whole(bookingGrossTotal(b)),
      offer: Math.min(whole(b.discount), whole(subtotal)),
      advance: whole(advance),
      cash: whole(counter.cash),
      online: whole(counter.online),
      customer: clean(b.customer_name),
      phone: clean(b.phone),
      notes: [
        advance > 0 ? "Advance paid" : "",
        whole(b.discount) > 0 &&
        Math.min(whole(b.discount), whole(subtotal)) > 0
          ? `Offer ${Math.min(whole(b.discount), whole(subtotal))}`
          : "",
        crossDayNote(b),
        clean(b.notes),
      ]
        .filter(Boolean)
        .join(" | "),
      order: slotOrder(b),
    });
  }

  // --- merged invoices dated the day (their own advance / balance split) --
  for (const bill of src.bills) {
    const bd = bill.merged_breakdown;
    if (!bd || isCancelled(bill) || dayKey(bill.bill_date) !== date) continue;
    const view = mergedBillBreakdown({
      breakdown: bd,
      paid: billPaidAmount(bill),
      grandTotal: billGrossTotal(bill),
      itemCount: (bill.items ?? []).length,
    });
    if (!view) continue;
    const counter: Split = { cash: 0, online: 0 };
    addModes(counter, bd.turf_balance_modes);
    for (const sn of bd.snacks) addModes(counter, sn.modes);
    const adv: Split = { cash: 0, online: 0 };
    addModes(adv, bd.turf_first_modes ?? bd.turf_modes);
    rows.push({
      key: `bill:${bill.id}`,
      kind: "merged",
      time: clean(bill.invoice_no) || "Bill",
      total: whole(billGrossTotal(bill)),
      offer: Math.min(whole(bill.discount), whole(bill.subtotal)),
      // A bill merged before the per-mode split existed has no modes, but the
      // advance amount is still known.
      advance: whole(adv.cash + adv.online || view.advancePaid),
      cash: whole(counter.cash),
      online: whole(counter.online),
      customer: clean(bill.customer_name),
      phone: clean(bill.customer_phone),
      notes: "Merged bill",
      order: 100_000,
    });
  }

  rows.sort((a, c) => a.order - c.order || a.key.localeCompare(c.key));

  // --- counter + booking-linked snack sales: one "Snacks" row ------------
  // Every financial snack sale of the day appears here once, whichever way it
  // was sold, and a sale rolled into a merged bill is excluded by
  // isFinancialSale (its money is on the merged bill row above).
  const snack: Split = { cash: 0, online: 0 };
  let snackTotal = 0;
  let snackCount = 0;
  for (const s of src.sales) {
    if (dayKey(s.sale_date) !== date || !isFinancialSale(s)) continue;
    const gross = snackSaleGrossTotal(s);
    snackTotal += gross;
    snackCount += 1;
    const mine = src.payments.filter(
      (r) => r.parent_type === "snack_sale" && r.parent_id === s.id,
    );
    if (mine.length > 0) {
      for (const r of mine) addSplit(snack, r.mode, Number(r.amount));
    } else if ((s.payment_mode ?? "") !== TAB_PAYMENT_MODE) {
      addSplit(snack, s.payment_mode, gross);
    }
  }
  if (snackCount > 0) {
    rows.push({
      key: "snacks",
      kind: "snacks",
      time: "Snacks",
      total: whole(snackTotal),
      offer: 0,
      advance: 0,
      cash: whole(snack.cash),
      online: whole(snack.online),
      notes: snackCount === 1 ? "1 sale" : `${snackCount} sales`,
      order: 200_000,
    });
  }

  const out: DailyTableRow[] = rows.map((r) => {
    const { order, ...rest } = r;
    void order;
    return rest;
  });

  const totals: DailyTableTotals = {
    total: 0,
    offer: 0,
    advance: 0,
    cash: 0,
    online: 0,
  };
  for (const r of out) {
    totals.total += r.total;
    totals.offer += r.offer;
    totals.advance += r.advance;
    totals.cash += r.cash;
    totals.online += r.online;
  }

  let expenses = 0;
  const dayExpenses = src.expenses
    .filter((e) => dayKey(e.spent_at) === date)
    .sort(
      (x, y) =>
        String(x.spent_at).localeCompare(String(y.spent_at)) ||
        x.id.localeCompare(y.id),
    );
  const expenseList: DailyTableExpense[] = dayExpenses.map((e) => {
    const amount = whole(e.amount);
    const cash = whole(expenseCashPart(e));
    expenses += expenseCashPart(e);
    return {
      key: `expense:${e.id}`,
      description: clean(e.description) || clean(e.category) || "Expense",
      notes: [clean(e.note), cash < amount ? `Cash part ${cash}` : ""]
        .filter(Boolean)
        .join(" | "),
      amount,
      cash,
    };
  });
  expenses = whole(expenses);
  const specificCash = totals.cash;
  return {
    rows: out,
    totals,
    cashBlock: {
      specificCash,
      expenses,
      remainingCash: Math.max(0, specificCash - expenses),
    },
    expenseList,
    expenseTotal: expenseList.reduce((n, e) => n + e.amount, 0),
  };
}

/* ------------------------------------------------------------------ */
/* public                                                               */
/* ------------------------------------------------------------------ */

const hasSaved = (map: Record<string, number> | null | undefined, k: string) =>
  !!map && Number.isFinite(Number(map[k])) && map[k] !== undefined;

/**
 * Old cash for `date`: what the owner typed on screen, else what was saved for
 * that day, else the PREVIOUS day's FINAL TOTAL (its remaining cash plus the old
 * cash saved for it), else 0.
 */
export function resolveOldCash(src: DailyTableDay): {
  value: number;
  isDefault: boolean;
} {
  if (src.oldCashOverride !== undefined && src.oldCashOverride !== null) {
    return { value: whole(src.oldCashOverride), isDefault: false };
  }
  if (hasSaved(src.savedOldCash, src.date)) {
    return { value: whole(src.savedOldCash![src.date]), isDefault: false };
  }
  const prev = previousDay(src.date);
  const prevDay = computeDay(prev, { ...src, date: prev });
  const prevOld = hasSaved(src.savedOldCash, prev)
    ? whole(src.savedOldCash![prev])
    : 0;
  return {
    value: prevDay.cashBlock.remainingCash + prevOld,
    isDefault: true,
  };
}

/** Builds the whole table for one business day. */
export function buildDailyTable(day: DailyTableDay): DailyTable {
  const parts = computeDay(day.date, day);
  const old = resolveOldCash(day);
  return {
    date: day.date,
    rows: parts.rows,
    totals: parts.totals,
    cashBlock: parts.cashBlock,
    expenseList: parts.expenseList,
    expenseTotal: parts.expenseTotal,
    oldCash: old.value,
    oldCashIsDefault: old.isDefault,
    finalTotal: parts.cashBlock.remainingCash + old.value,
  };
}

/* ------------------------------------------------------------------ */
/* shared formatting (image + text use the same strings)                */
/* ------------------------------------------------------------------ */

/** Whole rupees as plain digits (matches the owner's paper ledger), no currency symbol. */
export const formatCell = (n: number): string =>
  String(Math.round(Number(n) || 0));

export const COLUMN_HEADERS = [
  "TIME",
  "TOTAL",
  "OFFER",
  "ADVANCE",
  "CASH",
  "ONLINE",
  "NOTES",
] as const;

/** The seven cell strings of one row, in column order. */
export const rowCells = (r: DailyTableRow): string[] => [
  r.time,
  formatCell(r.total),
  formatCell(r.offer),
  formatCell(r.advance),
  formatCell(r.cash),
  formatCell(r.online),
  r.notes,
];

/** The ALL TOTAL row's cell strings (NOTES left empty). */
export const totalCells = (t: DailyTableTotals): string[] => [
  "ALL TOTAL",
  formatCell(t.total),
  formatCell(t.offer),
  formatCell(t.advance),
  formatCell(t.cash),
  formatCell(t.online),
  "",
];

export const EXPENSE_HEADERS = ["DESCRIPTION", "NOTES", "AMOUNT"] as const;

export const CASH_LABELS = {
  specificCash: "SPECIFIC CASH TOTAL (Rs)",
  expenses: "THAT DAY EXPENSES (Rs)",
  remainingCash: "REMAINING CASH (Rs)",
  oldCash: "MANUAL ENTRY OF OLD CASH (Rs)",
  finalTotal: "FINAL TOTAL (Rs)",
} as const;

/** "DD-MM-YYYY" for the title and the file name. */
export const tableDateText = (date: string) => formatDMY(date);

/**
 * Plain monospace text version of the same table (fallback when the picture
 * cannot be made). Reads only from the DailyTable, like the image.
 */
export function buildDailyTableText(
  table: DailyTable,
  _businessName?: string,
): string {
  void _businessName;
  const head = ["Time", "Total", "Offr", "Adv", "Cash", "Onln"];
  const widths = [11, 5, 5, 5, 5, 5];
  const line = (cells: string[]) =>
    cells
      .slice(0, 6)
      .map((c, i) => (i === 0 ? c.padEnd(widths[0]!) : c.padStart(widths[i]!)))
      .join(" ");
  const out: string[] = [
    `Daily Summary ${tableDateText(table.date)}`,
    line(head),
  ];
  if (table.rows.length === 0) out.push("(no bookings or sales)");
  for (const r of table.rows) out.push(line(rowCells(r)));
  out.push(line(totalCells(table.totals)));
  for (const r of table.rows)
    if (r.customer)
      out.push(`  ${r.time} - ${r.customer}${r.phone ? ` ${r.phone}` : ""}`);
  for (const r of table.rows)
    if (r.notes && r.kind !== "snacks") out.push(`  ${r.time}: ${r.notes}`);
  const c = table.cashBlock;
  out.push(`Expenses (${table.expenseList.length}):`);
  if (table.expenseList.length === 0) out.push("  (none)");
  for (const e of table.expenseList)
    out.push(
      `  ${e.description}${e.notes ? ` (${e.notes})` : ""}: Rs ${formatCell(e.amount)}`,
    );
  if (table.expenseList.length > 0)
    out.push(`  Total expenses: Rs ${formatCell(table.expenseTotal)}`);
  out.push(
    `Specific cash: Rs ${formatCell(c.specificCash)}   Expenses: Rs ${formatCell(c.expenses)}`,
    `Remaining cash: Rs ${formatCell(c.remainingCash)}   Old cash: Rs ${formatCell(table.oldCash)}`,
    `FINAL TOTAL: Rs ${formatCell(table.finalTotal)}`,
  );
  return out.join("\n");
}
