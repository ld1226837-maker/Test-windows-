/**
 * "Recent bills" for the owner WhatsApp card: a merged list of turf bookings,
 * snack sales and invoices from the last three days, with a day filter, a sort
 * mode, and one short plain-text message per bill.
 *
 * Performance rules (the card sits in Settings, so it must stay cheap):
 *  - everything here is pure and is only called while the dropdown is open;
 *  - rows are filtered by day FIRST (a string compare per row, no money maths),
 *    then amounts are computed and the small remaining set is sorted;
 *  - message text is built only when a row's Send button is tapped.
 */
import { isCancelled } from "./bill-state";
import { dayKey } from "./analytics";
import {
  billGrossTotal,
  bookingGrossTotal,
  formatDMY,
  snackSaleGrossTotal,
  type Bill,
} from "./biz";
import { isFinancialBooking, isFinancialSale } from "./dues";
import type { PaymentRow } from "./localdb";
import type { SnackSale, TurfBooking } from "./ops";
import type { TabEntry } from "./tabs";
import { bookingPaymentBreakdown } from "./turf-payments";

export type OwnerBillKind = "turf" | "snack" | "invoice";
/** "all" = the three days together; "0" today, "1" yesterday, "2" two days ago. */
export type DayFilter = "all" | "0" | "1" | "2";
export type SortMode = "newest" | "oldest" | "high" | "low";

export const DAY_FILTERS: { value: DayFilter; label: string }[] = [
  { value: "all", label: "All 3" },
  { value: "0", label: "Today" },
  { value: "1", label: "Yesterday" },
  { value: "2", label: "2 days ago" },
];

export const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "high", label: "Amount: high to low" },
  { value: "low", label: "Amount: low to high" },
];

export const isDayFilter = (v: unknown): v is DayFilter =>
  v === "all" || v === "0" || v === "1" || v === "2";
export const isSortMode = (v: unknown): v is SortMode =>
  v === "newest" || v === "oldest" || v === "high" || v === "low";

export type OwnerBillRow = {
  key: string;
  kind: OwnerBillKind;
  id: string;
  no: string;
  name: string;
  amount: number;
  day: string;
  /** Position inside its own source list (the hooks already return newest first). */
  seq: number;
};

export type OwnerBillSource = {
  bookings: TurfBooking[];
  sales: SnackSale[];
  bills: Bill[];
};

const pad = (n: number) => String(n).padStart(2, "0");

function shiftDay(key: string, delta: number): string {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** [today, yesterday, two days ago] as plain IST calendar-day keys. */
export function lastThreeDays(
  now: Date = new Date(),
): [string, string, string] {
  const today = dayKey(now);
  return [today, shiftDay(today, -1), shiftDay(today, -2)];
}

const KIND_RANK: Record<OwnerBillKind, number> = {
  turf: 0,
  snack: 1,
  invoice: 2,
};

const newestFirst = (a: OwnerBillRow, b: OwnerBillRow) =>
  a.day < b.day
    ? 1
    : a.day > b.day
      ? -1
      : a.seq - b.seq || KIND_RANK[a.kind] - KIND_RANK[b.kind];

const SORTERS: Record<SortMode, (a: OwnerBillRow, b: OwnerBillRow) => number> =
  {
    newest: newestFirst,
    oldest: (a, b) => newestFirst(b, a),
    high: (a, b) => b.amount - a.amount || newestFirst(a, b),
    low: (a, b) => a.amount - b.amount || newestFirst(a, b),
  };

/**
 * Bills from the last three days, filtered then sorted. Cancelled / no-show
 * bookings, voided snack sales and cancelled invoices are left out, as are
 * bookings and sales that were rolled into a merged invoice (that invoice is
 * listed instead) — the same rules the rest of the app uses for "real" bills.
 */
export function buildRecentBillRows(
  src: OwnerBillSource,
  opts: { day: DayFilter; sort: SortMode; now?: Date },
): OwnerBillRow[] {
  const days = lastThreeDays(opts.now);
  const want = new Set<string>(
    opts.day === "all" ? days : [days[Number(opts.day)] as string],
  );
  const rows: OwnerBillRow[] = [];

  src.bookings.forEach((b, seq) => {
    const day = dayKey(b.booking_date);
    if (!want.has(day) || !isFinancialBooking(b)) return;
    rows.push({
      key: `turf:${b.id}`,
      kind: "turf",
      id: b.id,
      no: b.booking_no,
      name: b.customer_name,
      amount: bookingGrossTotal(b),
      day,
      seq,
    });
  });
  src.sales.forEach((s, seq) => {
    const day = dayKey(s.sale_date);
    if (!want.has(day) || !isFinancialSale(s)) return;
    rows.push({
      key: `snack:${s.id}`,
      kind: "snack",
      id: s.id,
      no: s.bill_no,
      name: s.customer_name || "Walk-in",
      amount: snackSaleGrossTotal(s),
      day,
      seq,
    });
  });
  src.bills.forEach((b, seq) => {
    const day = dayKey(b.bill_date);
    if (!want.has(day) || isCancelled(b)) return;
    rows.push({
      key: `invoice:${b.id}`,
      kind: "invoice",
      id: b.id,
      no: b.invoice_no,
      name: b.customer_name,
      amount: billGrossTotal(b),
      day,
      seq,
    });
  });

  return rows.sort(SORTERS[opts.sort]);
}

/* ------------------------------------------------------------------ */
/* Message text (plain ASCII, built only when Send is tapped)           */
/* ------------------------------------------------------------------ */

const rs = (n: number) =>
  `Rs ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

const MODE_ORDER = ["Cash", "UPI", "Card"];

type ModeTotals = Map<string, number>;

function addMode(map: ModeTotals, mode: string, amount: number) {
  if (!(amount > 0)) return;
  const key = mode === "UPI" || mode === "Card" ? mode : "Cash";
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** "(Cash 422 + UPI 122)", "(UPI)" for one mode, "" when nothing was taken. */
function splitText(map: ModeTotals): string {
  const parts = MODE_ORDER.filter((m) => (map.get(m) ?? 0) > 0);
  if (parts.length === 0) return "";
  if (parts.length === 1) return `(${parts[0]})`;
  return `(${parts
    .map(
      (m) => `${m} ${Math.round(map.get(m) as number).toLocaleString("en-IN")}`,
    )
    .join(" + ")})`;
}

/** "Cash 766 | UPI 1,362" — only the modes that actually took money. */
function flowText(map: ModeTotals): string {
  return MODE_ORDER.filter((m) => (map.get(m) ?? 0) > 0)
    .map(
      (m) => `${m} ${Math.round(map.get(m) as number).toLocaleString("en-IN")}`,
    )
    .join(" | ");
}

const sumMap = (map: ModeTotals) => {
  let t = 0;
  for (const v of map.values()) t += v;
  return t;
};

const durationText = (hours: number) => {
  const mins = Math.round((Number(hours) || 0) * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h} hr ${m} min`;
  if (h > 0) return `${h} hr`;
  return `${m} min`;
};

const clean = (s: string | null | undefined) =>
  String(s ?? "")
    .replace(/[\u00b7\u2022]/g, "|")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u20b9\s*/g, "Rs ")
    .replace(/[\r\t]/g, " ")
    .trim();

function modeMapFromRows(
  rows: PaymentRow[],
  parentType: PaymentRow["parent_type"],
  parentId: string,
  fallbackMode: string | null | undefined,
  fallbackAmount: number,
): ModeTotals {
  const map: ModeTotals = new Map();
  for (const r of rows) {
    if (r.parent_type === parentType && r.parent_id === parentId)
      addMode(map, r.mode, Number(r.amount));
  }
  if (map.size === 0 && fallbackAmount > 0)
    addMode(map, String(fallbackMode ?? "Cash"), fallbackAmount);
  return map;
}

export type OwnerTextContext = OwnerBillSource & {
  payments: PaymentRow[];
  tabEntries: TabEntry[];
};

function turfText(b: TurfBooking, ctx: OwnerTextContext): string {
  const own = ctx.payments.filter(
    (r) => r.parent_type === "turf_booking" && r.parent_id === b.id,
  );
  const bd = bookingPaymentBreakdown(b, own, ctx.tabEntries);
  const turfTotal = bookingGrossTotal(b);

  const advance: ModeTotals = new Map();
  const balance: ModeTotals = new Map();
  for (const l of bd.lines) {
    addMode(l.stage === "Advance" ? advance : balance, l.mode, l.amount);
  }

  // Snacks sold with this booking (their own bill, their own mode).
  const snackSales = ctx.sales.filter(
    (s) => s.booking_id === b.id && isFinancialSale(s),
  );
  let snackTotal = 0;
  const snackFlow: ModeTotals = new Map();
  const snackLines: string[] = [];
  for (const s of snackSales) {
    const amt = snackSaleGrossTotal(s);
    snackTotal += amt;
    const modes = modeMapFromRows(
      ctx.payments,
      "snack_sale",
      s.id,
      s.payment_mode,
      amt,
    );
    for (const [m, v] of modes) addMode(snackFlow, m, v);
    snackLines.push(
      `Snacks: ${rs(amt)} ${splitText(modes) || `(${clean(s.payment_mode)})`}`.trim(),
    );
  }

  const slot =
    b.start_time && b.end_time
      ? `${clean(b.start_time)}-${clean(b.end_time)}`
      : clean(b.slot_name);
  const courts = b.courts ?? 1;
  const lines: string[] = [
    `${formatDMY(b.booking_date)} | ${slot} | ${durationText(b.hours)}${courts > 1 ? `, ${courts} courts` : ""}`,
    `${clean(b.customer_name)} | ${clean(b.phone) || "-"}`,
    "",
    `Turf: ${rs(turfTotal)}`,
  ];
  if (sumMap(advance) > 0)
    lines.push(`Advance: ${rs(sumMap(advance))} ${splitText(advance)}`.trim());
  if (sumMap(balance) > 0)
    lines.push(
      `Remaining: ${rs(sumMap(balance))} ${splitText(balance)}`.trim(),
    );
  else if (bd.due > 0) lines.push(`Remaining: ${rs(bd.due)} (pending)`);
  if (snackLines.length) lines.push("", ...snackLines);

  // Cash flow. "With advance" is everything collected; "Without advance" is
  // only what came in at settlement (balance + snacks), because the advance
  // was received earlier.
  const withAdv: ModeTotals = new Map();
  const withoutAdv: ModeTotals = new Map();
  for (const [m, v] of advance) addMode(withAdv, m, v);
  for (const [m, v] of balance) {
    addMode(withAdv, m, v);
    addMode(withoutAdv, m, v);
  }
  for (const [m, v] of snackFlow) {
    addMode(withAdv, m, v);
    addMode(withoutAdv, m, v);
  }
  const flowLine = (label: string, map: ModeTotals) => {
    const total = sumMap(map);
    const flow = flowText(map);
    return `${label}: ${rs(total)}${flow ? ` | ${flow}` : ""}`;
  };

  lines.push(
    "",
    "Summary",
    snackSales.length
      ? `Turf ${rs(turfTotal)} + Snacks ${rs(snackTotal)} = ${rs(turfTotal + snackTotal)}`
      : `Turf ${rs(turfTotal)}`,
    flowLine("With advance", withAdv),
    flowLine("Without advance", withoutAdv),
  );
  if (bd.due > 0) lines.push(`Pending: ${rs(bd.due)}`);
  return lines.join("\n");
}

function snackText(s: SnackSale, ctx: OwnerTextContext): string {
  const total = snackSaleGrossTotal(s);
  const modes = modeMapFromRows(
    ctx.payments,
    "snack_sale",
    s.id,
    s.payment_mode,
    total,
  );
  const lines = [
    `${formatDMY(s.sale_date)} | ${clean(s.customer_name) || "Walk-in"}`,
    `Snacks bill ${clean(s.bill_no)}`,
    "",
    ...(s.items ?? []).map(
      (i) => `${clean(i.item_name)} x ${i.qty} = ${rs(i.amount)}`,
    ),
    "",
    `Total: ${rs(total)} ${splitText(modes) || `(${clean(s.payment_mode)})`}`.trim(),
  ];
  return lines.join("\n");
}

function invoiceText(b: Bill, ctx: OwnerTextContext): string {
  const total = billGrossTotal(b);
  const paid = Math.min(Number(b.amount_paid) || 0, total);
  const modes = modeMapFromRows(
    ctx.payments,
    "bill",
    b.id,
    b.payment_mode,
    paid,
  );
  const due = Math.max(0, Math.round(total - (Number(b.amount_paid) || 0)));
  const lines = [
    `${formatDMY(b.bill_date)} | ${clean(b.invoice_no)} | ${clean(b.customer_name)}`,
    "",
    `Total: ${rs(total)}`,
    `Paid: ${rs(paid)} ${splitText(modes)}`.trim(),
  ];
  if (due > 0) lines.push(`Due: ${rs(due)}`);
  return lines.join("\n");
}

/** Owner message for one listed bill, or "" if the record is no longer there. */
export function buildOwnerBillText(
  row: Pick<OwnerBillRow, "kind" | "id">,
  ctx: OwnerTextContext,
): string {
  if (row.kind === "turf") {
    const b = ctx.bookings.find((x) => x.id === row.id);
    return b ? turfText(b, ctx) : "";
  }
  if (row.kind === "snack") {
    const s = ctx.sales.find((x) => x.id === row.id);
    return s ? snackText(s, ctx) : "";
  }
  const b = ctx.bills.find((x) => x.id === row.id);
  return b ? invoiceText(b, ctx) : "";
}
