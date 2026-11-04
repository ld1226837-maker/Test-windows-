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
 * CASH FLOW (one ordered list, `cash.steps`, that the picture, the text, the
 * panel and the dashboard preview all loop over - nothing hard-codes its own
 * cash lines):
 *
 *   OLD CASH  -  that day's CASH-only expenses  =  CASH AFTER EXPENSES (stored)
 *             +  COLLECTED CASH (added last)    =  FINAL TOTAL
 *
 * Online (UPI / Card) expenses are shown for information and never deducted.
 * CASH AFTER EXPENSES is NOT clamped at 0: a negative balance is printed with
 * a minus sign so the owner sees that expenses exceeded the old cash. A
 * CARRIED FORWARD line (the previous business day's final total) can sit above
 * OLD CASH for reference; it is informational and never part of the sum.
 *
 * Pure: no React, no storage, no clock.
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
  /** Part of it that left the cash drawer (what the cash flow subtracts). */
  cash: number;
  /** Part of it paid online (UPI / Card): shown, never subtracted. */
  online: number;
  /** Why it was or was not subtracted. */
  tag: "CASH" | "ONLINE" | "CASH+ONLINE";
};

export type DailyTableCounts = {
  /** Booking rows (booked, merged and kept-advance cancelled). */
  bookings: number;
  /** Financial snack sales of the day. */
  snackSales: number;
};

export type DailyTableTotals = {
  total: number;
  offer: number;
  advance: number;
  cash: number;
  online: number;
};

export type CashStepKind =
  "info" | "open" | "less" | "subtotal" | "plus" | "close";

export type CashStepKey =
  | "carriedForward"
  | "oldCash"
  | "cashExpenses"
  | "cashAfterExpenses"
  | "collectedCash"
  | "finalTotal";

/** One line of the cash flow, exactly as every surface shows it. */
export type CashStep = {
  key: CashStepKey;
  kind: CashStepKind;
  /** Upper-case label for the picture and the panel. */
  label: string;
  /** Signed whole rupees (a "less" step is negative). Negatives allowed. */
  amount: number;
  /** What the picture prints in front of the amount. */
  sign: "" | "-" | "+";
  /** Where the figure came from, e.g. "typed by you". */
  hint?: string;
  /** Second, plain-words line (the carried-forward difference). */
  note?: string;
  /** The same line for the plain-text summary ("Old cash: Rs 1000"). */
  text: string;
};

export type CarriedForward = {
  /** Previous business day "YYYY-MM-DD", null if there is none. */
  date: string | null;
  /** That day's FINAL TOTAL (signed whole rupees). */
  amount: number;
  /** True only when oldCash really came from this default. */
  used: boolean;
  /** True when that day had no records and its figure is the saved value. */
  fromSaved: boolean;
  /** oldCash - amount when the owner's value differs (0 when used). */
  difference: number;
};

export type CashFlow = {
  oldCash: number;
  /** True when oldCash came from the previous day / zero, not the owner. */
  oldCashIsDefault: boolean;
  /** Cash part of that day's expenses only. */
  cashExpenses: number;
  /** Online part of that day's expenses: shown, never subtracted. */
  onlineExpenses: number;
  /** oldCash - cashExpenses, NOT clamped at 0. This is what is stored. */
  cashAfterExpenses: number;
  /** Sum of the CASH column. */
  collectedCash: number;
  /** cashAfterExpenses + collectedCash. */
  finalTotal: number;
  carriedForward: CarriedForward;
  /** The steps in this exact order (carriedForward only when it has data). */
  steps: CashStep[];
};

export type DailyTable = {
  /** "YYYY-MM-DD". */
  date: string;
  rows: DailyTableRow[];
  totals: DailyTableTotals;
  /** How many bookings / snack sales the table covers. */
  counts: DailyTableCounts;
  cash: CashFlow;
  /** Every expense of the day, oldest first. */
  expenseList: DailyTableExpense[];
  /** Sum of the AMOUNT column of expenseList. */
  expenseTotal: number;
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
  /** Cash after expenses saved per day (signed), from app settings. */
  savedCashAfterExpenses?: Record<string, number> | null | undefined;
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
  counts: DailyTableCounts;
  /** Cash part of the day's expenses (what the cash flow subtracts). */
  cashExpenses: number;
  /** Online part of the day's expenses (never subtracted). */
  onlineExpenses: number;
  /** Sum of the CASH column. */
  collectedCash: number;
  expenseList: DailyTableExpense[];
  expenseTotal: number;
};

/**
 * The records grouped by business day ONCE per build, so walking back through
 * previous days (the carried-forward chain) costs O(records), not
 * O(days x records), and finished days are cached.
 */
type DayCtx = {
  src: DailyTableDay;
  tabEntries: TabEntry[];
  bookings: Map<string, TurfBooking[]>;
  sales: Map<string, SnackSale[]>;
  bills: Map<string, Bill[]>;
  expenses: Map<string, ExpenseV2[]>;
  payments: Map<string, PaymentRow[]>;
  parts: Map<string, DayParts>;
};

function pushTo<T>(m: Map<string, T[]>, k: string, v: T) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function makeCtx(src: DailyTableDay): DayCtx {
  const ctx: DayCtx = {
    src,
    tabEntries: src.tabEntries ?? [],
    bookings: new Map(),
    sales: new Map(),
    bills: new Map(),
    expenses: new Map(),
    payments: new Map(),
    parts: new Map(),
  };
  for (const b of src.bookings) pushTo(ctx.bookings, dayKey(b.booking_date), b);
  for (const s of src.sales) pushTo(ctx.sales, dayKey(s.sale_date), s);
  for (const b of src.bills) pushTo(ctx.bills, dayKey(b.bill_date), b);
  for (const e of src.expenses) pushTo(ctx.expenses, dayKey(e.spent_at), e);
  for (const r of src.payments)
    pushTo(ctx.payments, `${r.parent_type}:${r.parent_id}`, r);
  return ctx;
}

const paymentsOf = (ctx: DayCtx, type: string, id: string) =>
  ctx.payments.get(`${type}:${id}`) ?? [];

function computeDay(date: string, ctx: DayCtx): DayParts {
  const cached = ctx.parts.get(date);
  if (cached) return cached;
  const parts = computeDayUncached(date, ctx);
  ctx.parts.set(date, parts);
  return parts;
}

function computeDayUncached(date: string, ctx: DayCtx): DayParts {
  const tabEntries = ctx.tabEntries;
  const rows: (DailyTableRow & { order: number })[] = [];

  // --- bookings played on the day -------------------------------------
  for (const b of ctx.bookings.get(date) ?? []) {
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

    const own = paymentsOf(ctx, "turf_booking", b.id);
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
  for (const bill of ctx.bills.get(date) ?? []) {
    const bd = bill.merged_breakdown;
    if (!bd || isCancelled(bill)) continue;
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
  for (const s of ctx.sales.get(date) ?? []) {
    if (!isFinancialSale(s)) continue;
    const gross = snackSaleGrossTotal(s);
    snackTotal += gross;
    snackCount += 1;
    const mine = paymentsOf(ctx, "snack_sale", s.id);
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

  const dayExpenses = [...(ctx.expenses.get(date) ?? [])].sort(
    (x, y) =>
      String(x.spent_at).localeCompare(String(y.spent_at)) ||
      x.id.localeCompare(y.id),
  );
  let cashExpenses = 0;
  let onlineExpenses = 0;
  const expenseList: DailyTableExpense[] = dayExpenses.map((e) => {
    const amount = whole(e.amount);
    const cash = Math.min(amount, whole(expenseCashPart(e)));
    const online = amount - cash;
    cashExpenses += cash;
    onlineExpenses += online;
    return {
      key: `expense:${e.id}`,
      description: clean(e.description) || clean(e.category) || "Expense",
      notes: [
        clean(e.note),
        cash > 0 && cash < amount ? `Cash part ${cash}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
      amount,
      cash,
      online,
      tag: online === 0 ? "CASH" : cash === 0 ? "ONLINE" : "CASH+ONLINE",
    };
  });
  return {
    rows: out,
    totals,
    counts: {
      bookings: out.filter((r) => r.kind !== "snacks").length,
      snackSales: snackCount,
    },
    cashExpenses,
    onlineExpenses,
    collectedCash: totals.cash,
    expenseList,
    expenseTotal: expenseList.reduce((n, e) => n + e.amount, 0),
  };
}

/* ------------------------------------------------------------------ */
/* public                                                               */
/* ------------------------------------------------------------------ */

/** How far back the carried-forward chain looks for an earlier business day. */
export const MAX_CHAIN_DAYS = 366;

const has = (map: Record<string, number> | null | undefined, k: string) =>
  !!map && map[k] !== undefined && Number.isFinite(Number(map[k]));

/** Signed whole rupees (whole() clamps at 0; cash after expenses must not). */
const signed = (n: unknown) => rupees(Number(n) || 0) || 0;

type DayFinal = { final: number; fromSaved: boolean };

/** A day with records, or with a figure saved for it, is a "business day". */
function dayHasData(date: string, ctx: DayCtx): boolean {
  const { savedOldCash: o, savedCashAfterExpenses: a } = ctx.src;
  if (has(o, date) || has(a, date)) return true;
  const touched =
    ctx.bookings.has(date) ||
    ctx.sales.has(date) ||
    ctx.bills.has(date) ||
    ctx.expenses.has(date);
  if (!touched) return false;
  const p = computeDay(date, ctx);
  return p.rows.length > 0 || p.expenseList.length > 0;
}

/** True when a day's figure is fixed by saved data, so the walk can stop. */
function isAnchored(date: string, ctx: DayCtx): boolean {
  const p = computeDay(date, ctx);
  const records = p.rows.length > 0 || p.expenseList.length > 0;
  return (
    has(ctx.src.savedOldCash, date) ||
    (!records && has(ctx.src.savedCashAfterExpenses, date))
  );
}

/**
 * FINAL TOTAL of one earlier day, with the NEW formula:
 * old cash - cash expenses + collected cash.
 *
 * `inherited` is that day's old cash when the owner never saved one for it (the
 * chain's own value). A day WITH records is always recomputed from them, never
 * read from a stale stored copy, so editing a past day flows into the later
 * days' defaults. A day with NO records (archived data) falls back to the
 * stored cash-after-expenses plus whatever collected cash can be derived.
 */
function finalOfDay(date: string, inherited: number, ctx: DayCtx): DayFinal {
  const p = computeDay(date, ctx);
  const records = p.rows.length > 0 || p.expenseList.length > 0;
  const { savedOldCash, savedCashAfterExpenses } = ctx.src;
  if (!records && has(savedCashAfterExpenses, date)) {
    return {
      final: signed(savedCashAfterExpenses![date]) + p.collectedCash,
      fromSaved: true,
    };
  }
  const old = has(savedOldCash, date) ? whole(savedOldCash![date]) : inherited;
  return { final: old - p.cashExpenses + p.collectedCash, fromSaved: false };
}

/**
 * The previous business day and its FINAL TOTAL, or null when there is no
 * earlier data. Walks back over quiet days (closed days carry the cash
 * through) at most MAX_CHAIN_DAYS days from `date`, then falls back to none:
 * the chain can never run away.
 */
function carriedFrom(
  date: string,
  ctx: DayCtx,
): { date: string; amount: number; fromSaved: boolean } | null {
  const days: string[] = [];
  let cursor = date;
  let used = 0;
  for (;;) {
    let found: string | null = null;
    for (let k = 1; used + k <= MAX_CHAIN_DAYS; k++) {
      const d = shiftDate(cursor, -k);
      if (dayHasData(d, ctx)) {
        found = d;
        used += k;
        break;
      }
    }
    if (!found) break;
    days.push(found);
    if (isAnchored(found, ctx)) break;
    cursor = found;
  }
  if (days.length === 0) return null;
  // Roll forward from the oldest day (0 old cash before any known data).
  let old = 0;
  let last: DayFinal = { final: 0, fromSaved: false };
  for (let i = days.length - 1; i >= 0; i--) {
    last = finalOfDay(days[i]!, old, ctx);
    old = last.final;
  }
  return { date: days[0]!, amount: last.final, fromSaved: last.fromSaved };
}

export type OldCashSource = "typed" | "saved" | "previous" | "none";

function resolveOld(
  ctx: DayCtx,
  prev: ReturnType<typeof carriedFrom>,
): { value: number; isDefault: boolean; source: OldCashSource } {
  const src = ctx.src;
  if (src.oldCashOverride !== undefined && src.oldCashOverride !== null) {
    return {
      value: whole(src.oldCashOverride),
      isDefault: false,
      source: "typed",
    };
  }
  if (has(src.savedOldCash, src.date)) {
    return {
      value: whole(src.savedOldCash![src.date]),
      isDefault: false,
      source: "saved",
    };
  }
  // The default may be negative (a shortfall carried over); owner input never is.
  return prev
    ? { value: prev.amount, isDefault: true, source: "previous" }
    : { value: 0, isDefault: true, source: "none" };
}

/**
 * Old cash for `date`, in this order: what the owner typed on screen, else what
 * was saved for that day, else the previous business day's FINAL TOTAL (new
 * formula, depth limited to MAX_CHAIN_DAYS), else 0.
 */
export function resolveOldCash(src: DailyTableDay): {
  value: number;
  isDefault: boolean;
  source: OldCashSource;
} {
  const ctx = makeCtx(src);
  return resolveOld(ctx, carriedFrom(src.date, ctx));
}

/* ---- cash flow --------------------------------------------------------- */

/** Whole rupees as plain digits (matches the owner's paper ledger). */
export const formatCell = (n: number): string =>
  String(Math.round(Number(n) || 0));

export const CASH_LABELS = {
  oldCash: "OLD CASH (Rs)",
  cashExpenses: "THAT DAY CASH EXPENSES (Rs)",
  cashAfterExpenses: "CASH AFTER EXPENSES (Rs)",
  collectedCash: "COLLECTED CASH (Rs)",
  finalTotal: "FINAL TOTAL (Rs)",
  caption:
    "Old cash - cash expenses = cash after expenses; + collected cash = final total.",
} as const;

/** "DD-MM-YYYY" for the title and the file name. */
export const tableDateText = (date: string) => formatDMY(date);

export const carriedForwardLabel = (date: string) =>
  `CARRIED FORWARD (${tableDateText(date)})`;

/** What a step prints: "-340", "+2500", "660", "-120" (zero has no sign). */
export function stepAmountText(step: CashStep): string {
  if (step.kind === "less" || step.kind === "plus") {
    const v = Math.abs(step.amount);
    return v === 0 ? "0" : `${step.sign}${formatCell(v)}`;
  }
  return formatCell(step.amount);
}

/** True for a balance line that is below zero (printed in red-ish ink). */
export const isNegativeBalance = (step: CashStep): boolean =>
  step.kind !== "less" && step.kind !== "plus" && step.amount < 0;

/** Spoken word for the sign, so plus / minus never rely on colour. */
export const STEP_WORD: Record<CashStepKind, string> = {
  info: "Carried forward, for information",
  open: "Starting with",
  less: "Minus",
  subtotal: "Equals",
  plus: "Plus",
  close: "Equals",
};

const dmy = (d: string) => tableDateText(d);

export type CashFlowInput = {
  /** The business day being built ("YYYY-MM-DD"). */
  date: string;
  oldCash: number;
  /** Where oldCash came from (default "typed"). */
  source?: OldCashSource;
  cashExpenses: number;
  onlineExpenses?: number;
  collectedCash: number;
  /** The previous business day and its final total, if any. */
  carried?: { date: string; amount: number; fromSaved?: boolean } | null;
};

/**
 * The ONE place the cash formula lives: old cash, minus cash-only expenses,
 * record that, add the collected cash last. buildDailyTable uses it; tests use
 * it to make fixtures without a day of records.
 */
export function makeCashFlow(input: CashFlowInput): CashFlow {
  const date = input.date;
  const source = input.source ?? "typed";
  const old = {
    value: input.oldCash,
    isDefault: source === "previous" || source === "none",
    source,
  };
  const prev = input.carried
    ? {
        date: input.carried.date,
        amount: input.carried.amount,
        fromSaved: Boolean(input.carried.fromSaved),
      }
    : null;
  const parts = {
    cashExpenses: input.cashExpenses,
    onlineExpenses: input.onlineExpenses ?? 0,
    collectedCash: input.collectedCash,
  };
  const oldCash = old.value;
  const cashExpenses = parts.cashExpenses;
  const collectedCash = parts.collectedCash;
  // (1) old cash, (2) minus cash-only expenses, (3) record that value,
  // (4) add the collected cash last.
  const cashAfterExpenses = oldCash - cashExpenses;
  const finalTotal = cashAfterExpenses + collectedCash;

  const used = old.isDefault && prev !== null;
  const difference = prev && !used ? oldCash - prev.amount : 0;
  const when =
    prev && prev.date === previousDay(date)
      ? "yesterday's"
      : "the last business day's";
  const Cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const savedTag = prev?.fromSaved ? " (from saved value)" : "";

  const carriedForward: CarriedForward = {
    date: prev ? prev.date : null,
    amount: prev ? prev.amount : 0,
    used,
    fromSaved: prev ? prev.fromSaved : false,
    difference,
  };

  const steps: CashStep[] = [];
  if (prev) {
    const diffNote =
      difference !== 0
        ? `Typed old cash is Rs ${formatCell(Math.abs(difference))} ${
            difference > 0 ? "more" : "less"
          } than ${when} final total (Rs ${formatCell(prev.amount)})`
        : "";
    steps.push({
      key: "carriedForward",
      kind: "info",
      label: carriedForwardLabel(prev.date),
      amount: prev.amount,
      sign: "",
      hint: used
        ? `${Cap(when)} final total, used as old cash${savedTag}`
        : `${Cap(when)} final total, for reference${savedTag}`,
      ...(diffNote ? { note: diffNote } : {}),
      text: `Carried forward (${dmy(prev.date)}): Rs ${formatCell(prev.amount)}`,
    });
  }
  const oldHint =
    old.source === "previous"
      ? when === "yesterday's"
        ? "from previous day's final total"
        : "from the last business day's final total"
      : old.source === "none"
        ? "no earlier day found, starts at 0"
        : "typed by you";
  steps.push(
    {
      key: "oldCash",
      kind: "open",
      label: CASH_LABELS.oldCash,
      amount: oldCash,
      sign: "",
      hint: oldHint,
      text: `Old cash: Rs ${formatCell(oldCash)}`,
    },
    {
      key: "cashExpenses",
      kind: "less",
      label: CASH_LABELS.cashExpenses,
      amount: -cashExpenses,
      sign: "-",
      text: `- That day cash expenses: Rs ${formatCell(cashExpenses)}`,
    },
    {
      key: "cashAfterExpenses",
      kind: "subtotal",
      label: CASH_LABELS.cashAfterExpenses,
      amount: cashAfterExpenses,
      sign: "",
      hint: "stored",
      text: `= Cash after expenses (stored): Rs ${formatCell(cashAfterExpenses)}`,
    },
    {
      key: "collectedCash",
      kind: "plus",
      label: CASH_LABELS.collectedCash,
      amount: collectedCash,
      sign: "+",
      text: `+ Collected cash: Rs ${formatCell(collectedCash)}`,
    },
    {
      key: "finalTotal",
      kind: "close",
      label: CASH_LABELS.finalTotal,
      amount: finalTotal,
      sign: "",
      text: `= FINAL TOTAL: Rs ${formatCell(finalTotal)}`,
    },
  );

  return {
    oldCash,
    oldCashIsDefault: old.isDefault,
    cashExpenses,
    onlineExpenses: parts.onlineExpenses,
    cashAfterExpenses,
    collectedCash,
    finalTotal,
    carriedForward,
    steps,
  };
}

/** finalTotal === oldCash - cashExpenses + collectedCash, always. */
export function cashFlowIntegrityOk(
  c: Pick<
    CashFlow,
    | "oldCash"
    | "cashExpenses"
    | "collectedCash"
    | "cashAfterExpenses"
    | "finalTotal"
  >,
): boolean {
  return (
    c.cashAfterExpenses === c.oldCash - c.cashExpenses &&
    c.finalTotal === c.oldCash - c.cashExpenses + c.collectedCash
  );
}

const isDevBuild = (): boolean => {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
};

/**
 * Dev-only guard: console.warn when finalTotal !== oldCash - cashExpenses +
 * collectedCash. Returns true when the rule is broken (never in practice).
 */
export function warnIfCashFlowBroken(cash: CashFlow): boolean {
  if (cashFlowIntegrityOk(cash)) return false;
  if (isDevBuild())
    console.warn(
      "[daily-table] cash flow integrity broken: finalTotal must equal " +
        "oldCash - cashExpenses + collectedCash",
      cash,
    );
  return true;
}

/** Builds the whole table for one business day. */
export function buildDailyTable(day: DailyTableDay): DailyTable {
  const ctx = makeCtx(day);
  const parts = computeDay(day.date, ctx);
  const prev = carriedFrom(day.date, ctx);
  const old = resolveOld(ctx, prev);
  const cash = makeCashFlow({
    date: day.date,
    oldCash: old.value,
    source: old.source,
    cashExpenses: parts.cashExpenses,
    onlineExpenses: parts.onlineExpenses,
    collectedCash: parts.collectedCash,
    carried: prev,
  });
  warnIfCashFlowBroken(cash);
  return {
    date: day.date,
    rows: parts.rows,
    totals: parts.totals,
    counts: parts.counts,
    cash,
    expenseList: parts.expenseList,
    expenseTotal: parts.expenseTotal,
  };
}

/* ------------------------------------------------------------------ */
/* shared formatting (image + panel + text use the same strings)        */
/* ------------------------------------------------------------------ */

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

export const TABLE_TITLE = "BOOKINGS & SALES";

/** "5 bookings | 3 snack sales" next to the table title. */
export const countsText = (c: DailyTableCounts): string =>
  `${c.bookings} ${c.bookings === 1 ? "booking" : "bookings"} | ${c.snackSales} ${
    c.snackSales === 1 ? "snack sale" : "snack sales"
  }`;

export type HeadlineFigure = {
  key: "collectedCash" | "cashExpenses" | "finalTotal";
  label: string;
  value: string;
  negative: boolean;
};

/** The three big figures of the header strip. */
export const headlineFigures = (t: DailyTable): HeadlineFigure[] => [
  {
    key: "collectedCash",
    label: "COLLECTED CASH",
    value: formatCell(t.cash.collectedCash),
    negative: false,
  },
  {
    key: "cashExpenses",
    label: "CASH EXPENSES",
    value: formatCell(t.cash.cashExpenses),
    negative: false,
  },
  {
    key: "finalTotal",
    label: "FINAL TOTAL",
    value: formatCell(t.cash.finalTotal),
    negative: t.cash.finalTotal < 0,
  },
];

export const EXPENSE_HEADERS = ["DESCRIPTION", "NOTES", "AMOUNT"] as const;

/** Header of the CASH / ONLINE tag column of the expenses in the picture. */
export const EXPENSE_PAID_HEADER = "PAID";

export const EXPENSE_LABELS = {
  total: "TOTAL EXPENSES",
  cash: "Cash expenses (deducted)",
  online: "Online expenses (not deducted)",
} as const;

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
    headlineFigures(table)
      .map(
        (h) =>
          `${h.label.charAt(0)}${h.label.slice(1).toLowerCase()}: Rs ${h.value}`,
      )
      .join(" | "),
    countsText(table.counts),
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
  out.push(`Expenses (${table.expenseList.length}):`);
  if (table.expenseList.length === 0) out.push("  (none)");
  for (const e of table.expenseList)
    out.push(
      `  ${e.description}${e.notes ? ` (${e.notes})` : ""}: Rs ${formatCell(e.amount)} [${e.tag}]`,
    );
  if (table.expenseList.length > 0)
    out.push(`  Total expenses: Rs ${formatCell(table.expenseTotal)}`);
  out.push(
    `  ${EXPENSE_LABELS.cash}: Rs ${formatCell(table.cash.cashExpenses)}`,
    `  ${EXPENSE_LABELS.online}: Rs ${formatCell(table.cash.onlineExpenses)}`,
    "Cash flow:",
  );
  for (const s of table.cash.steps) {
    out.push(s.text);
    if (s.note) out.push(`  ${s.note}`);
  }
  out.push(CASH_LABELS.caption);
  return out.join("\n");
}
