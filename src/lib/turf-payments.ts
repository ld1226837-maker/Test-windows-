import {
  bookingCashCollected,
  bookingDue,
  bookingForfeitedRevenue,
  bookingRefundableAdvance,
  isFinancialBooking,
} from "./dues";
import { formatDMY } from "./biz";
import { money, rupees } from "./money";
import { isOnlinePaymentMode } from "./ops";
import type { TurfBooking } from "./ops";
import type { TabEntry } from "./tabs";
import type { PaymentRow } from "./localdb";
import { normalizeReceivedPaymentMode } from "./payments";

/**
 * Display / export helpers for a turf booking's payment history: how much was
 * the ADVANCE (first collection), how much was the REMAINING collected later,
 * and how each part was paid (Cash / UPI / Card, split or not).
 *
 * DISPLAY AND EXPORT ONLY — nothing here writes data or feeds a calculation.
 * Every number is derived from the payment rows plus bookingCashCollected /
 * bookingDue (dues.ts), so the screen and the Excel can never disagree with
 * the rest of the app.
 */

/** Rows written in one collection are stamped within milliseconds of each
 * other (see sequentialTimestamps in localdb.ts); the same window is used by
 * receiptAdvanceAmount in payments.ts. */
const BATCH_MS = 1000;

export type TurfBookingKind =
  | "Turf only"
  | "Turf + snacks"
  | "Merged into bill";

export type RemainingStatus =
  | "Remaining paid"
  | "Part paid"
  | "Not paid"
  | "n/a";

export type PaymentSplitLabel =
  | "Cash only"
  | "UPI only"
  | "Card only"
  | "Online only"
  | "Split (Cash + Online)"
  | "Unpaid";

export type TurfPaymentLine = {
  amount: number;
  /** Normalised: Cash, UPI or Card. */
  mode: string;
  receivedAt: string;
  /** "Full payment" = the booking was settled by its one and only
   * collection (no advance, no later remaining), so calling it an
   * "Advance" would be wrong. Labelling only; amounts are unchanged. */
  stage: "Advance" | "Remaining" | "Full payment";
  /** True when this line was collected together with another mode. */
  split: boolean;
};

export type TurfPaymentBreakdown = {
  lines: TurfPaymentLine[];
  advance: number;
  remaining: number;
  remainingCash: number;
  remainingOnline: number;
  /** received_at of the latest remaining payment, or "". */
  remainingLastDate: string;
  totalCash: number;
  totalOnline: number;
  due: number;
  status: RemainingStatus;
  splitLabel: PaymentSplitLabel;
  /** "Cash ₹400 + UPI ₹300", "Cash ₹700", or "" when nothing was collected. */
  splitDetail: string;
  /** Two or more different modes were used on this booking. */
  splitUsed: boolean;
  kind: TurfBookingKind;
  /** "Advance ₹500 · Remaining paid ₹700 (...) on 12 Oct" style text, or "". */
  note: string;
};

/** "Turf only" when no snacks were sold with the booking, "Merged into bill"
 * once its money lives on a bill (snacks are shown there). Display only. */
export function turfBookingKind(
  b: Pick<TurfBooking, "snacks" | "snacks_total" | "merged_into_bill_id">,
): TurfBookingKind {
  if (b.merged_into_bill_id) return "Merged into bill";
  const hasSnacks =
    Number(b.snacks_total ?? 0) > 0 || (b.snacks ?? []).length > 0;
  return hasSnacks ? "Turf + snacks" : "Turf only";
}

/** Groups payment rows by turf booking id (rows of other parents ignored). */
export function groupBookingPayments(
  payments: PaymentRow[],
): Map<string, PaymentRow[]> {
  const map = new Map<string, PaymentRow[]>();
  for (const p of payments) {
    if (p.parent_type !== "turf_booking") continue;
    const list = map.get(p.parent_id);
    if (list) list.push(p);
    else map.set(p.parent_id, [p]);
  }
  return map;
}

type Row = { amount: number; mode: string; receivedAt: string; at: string };

function modeSummary(rows: { amount: number; mode: string }[]) {
  const byMode = new Map<string, number>();
  for (const r of rows) {
    if (!(r.amount > 0)) continue;
    byMode.set(r.mode, (byMode.get(r.mode) ?? 0) + r.amount);
  }
  return byMode;
}

export function splitLabelFor(
  rows: { amount: number; mode: string }[],
): PaymentSplitLabel {
  const byMode = modeSummary(rows);
  if (byMode.size === 0) return "Unpaid";
  let cash = 0;
  let online = 0;
  for (const [mode, amt] of byMode) {
    if (isOnlinePaymentMode(mode)) online += amt;
    else cash += amt;
  }
  if (cash > 0 && online > 0) return "Split (Cash + Online)";
  if (cash > 0) return "Cash only";
  const modes = [...byMode.keys()];
  if (modes.length === 1 && modes[0] === "UPI") return "UPI only";
  if (modes.length === 1 && modes[0] === "Card") return "Card only";
  return "Online only";
}

/**
 * Splits one booking's money into advance (first collection) and remaining
 * (every later collection).
 *
 * `rows` are the booking's real payment rows. A booking with none yet (old
 * data) gets one implied row from its own collected amount, exactly like
 * effectivePaymentEntries in payments.ts. When the rows disagree with the
 * real cash collected (a balance moved to the customer's tab inflates
 * advance_paid), the newest rows give back the excess and a shortfall is
 * counted as part of the advance, again mirroring effectivePaymentEntries.
 */
export function bookingPaymentBreakdown(
  b: TurfBooking,
  rows: PaymentRow[],
  tabEntries: TabEntry[] = [],
): TurfPaymentBreakdown {
  const financial = isFinancialBooking(b);
  // Money that actually arrived. A cancelled / no-show booking is not
  // "financial" (no revenue, no due) but analytics still counts its forfeited
  // advance as income and its not-yet-refunded advance as drawer cash
  // (collectionEntriesFor in analytics.ts), so the Excel must show the same
  // rupees or "Total collected" would disagree with the Dashboard. A booking
  // merged into a bill keeps its money on the bill, so it stays 0 here.
  const collected = financial
    ? bookingCashCollected(b, tabEntries)
    : b.merged_into_bill_id
      ? 0
      : rupees(
          bookingForfeitedRevenue(b, tabEntries) +
            bookingRefundableAdvance(b, tabEntries),
        );
  const due = financial ? bookingDue(b, tabEntries) : 0;

  const real: Row[] = rows
    .filter((r) => Number(r.amount) > 0)
    .slice()
    .sort((a, c) => a.created_at.localeCompare(c.created_at))
    .map((r) => ({
      amount: Number(r.amount),
      mode: normalizeReceivedPaymentMode(r.mode),
      receivedAt: r.received_at,
      at: r.created_at,
    }));

  let list: Row[] = real;
  if (collected > 0) {
    const rowsTotal = real.reduce((s, r) => s + r.amount, 0);
    const diff = rupees(collected - rowsTotal);
    if (real.length === 0) {
      list = [
        {
          amount: collected,
          mode: normalizeReceivedPaymentMode(b.payment_mode),
          receivedAt: b.booking_date,
          at: b.booking_date,
        },
      ];
    } else if (diff < 0) {
      let excess = -diff;
      list = real.map((r) => ({ ...r }));
      for (let i = list.length - 1; i >= 0 && excess > 0; i--) {
        const row = list[i]!;
        const cut = Math.min(row.amount, excess);
        row.amount -= cut;
        excess -= cut;
      }
      list = list.filter((r) => r.amount > 0);
    } else if (diff > 0) {
      list = [
        {
          amount: diff,
          mode: normalizeReceivedPaymentMode(b.payment_mode),
          receivedAt: b.booking_date,
          at: real[0]!.at,
        },
        ...real,
      ];
    }
  } else {
    list = [];
  }

  // Group into collections: rows stamped within BATCH_MS of the batch start.
  const batches: Row[][] = [];
  for (const r of list) {
    const last = batches[batches.length - 1];
    const t0 = last ? Date.parse(last[0]!.at) : NaN;
    const t = Date.parse(r.at);
    if (last && Number.isFinite(t0) && Number.isFinite(t) && t - t0 <= BATCH_MS)
      last.push(r);
    else batches.push([r]);
  }

  const lines: TurfPaymentLine[] = [];
  // One collection that clears the whole booking is a full payment, not an
  // advance (e.g. a quick-pay on a booking that had nothing paid yet).
  const paidInOne = financial && batches.length === 1 && due <= 0;
  batches.forEach((batch, i) => {
    const split = new Set(batch.map((r) => r.mode)).size > 1;
    for (const r of batch) {
      lines.push({
        amount: r.amount,
        mode: r.mode,
        receivedAt: r.receivedAt,
        stage: i === 0 ? (paidInOne ? "Full payment" : "Advance") : "Remaining",
        split,
      });
    }
  });

  const advanceLines = lines.filter((l) => l.stage !== "Remaining");
  const remainingLines = lines.filter((l) => l.stage === "Remaining");
  const sum = (xs: { amount: number }[]) =>
    rupees(xs.reduce((s, x) => s + x.amount, 0));
  const advance = sum(advanceLines);
  const remaining = sum(remainingLines);

  const cashOf = (xs: TurfPaymentLine[]) =>
    sum(xs.filter((l) => !isOnlinePaymentMode(l.mode)));
  const onlineOf = (xs: TurfPaymentLine[]) =>
    sum(xs.filter((l) => isOnlinePaymentMode(l.mode)));

  const remainingLastDate = remainingLines.reduce(
    (latest, l) => (l.receivedAt > latest ? l.receivedAt : latest),
    "",
  );

  let status: RemainingStatus = "n/a";
  if (financial) {
    if (remaining > 0 && due <= 0) status = "Remaining paid";
    else if (remaining > 0) status = "Part paid";
    else if (advance > 0 && due > 0) status = "Not paid";
  }

  const byMode = modeSummary(lines);
  const splitDetail = [...byMode]
    .map(([mode, amt]) => `${mode} ${money(amt)}`)
    .join(" + ");

  let note = "";
  if (remaining > 0) {
    const rem = modeSummary(remainingLines);
    const remDetail =
      rem.size > 1
        ? ` (${[...rem].map(([m, a]) => `${m} ${money(a)}`).join(" + ")})`
        : rem.size === 1
          ? ` (${[...rem.keys()][0]})`
          : "";
    const onDate = remainingLastDate
      ? ` on ${formatDMY(remainingLastDate)}`
      : "";
    note =
      due <= 0
        ? `Advance ${money(advance)} · Remaining paid ${money(remaining)}${remDetail}${onDate}`
        : `Advance ${money(advance)} · Remaining paid so far ${money(remaining)}${remDetail} · Still due ${money(due)}`;
  }

  return {
    lines,
    advance,
    remaining,
    remainingCash: cashOf(remainingLines),
    remainingOnline: onlineOf(remainingLines),
    remainingLastDate,
    totalCash: cashOf(lines),
    totalOnline: onlineOf(lines),
    due,
    status,
    splitLabel: splitLabelFor(lines),
    splitDetail,
    splitUsed: byMode.size > 1,
    kind: turfBookingKind(b),
    note,
  };
}

/** Money columns added by turfBookingExportColumns (for `moneyColumns`). */
export const TURF_EXPORT_MONEY_COLUMNS = [
  "Advance (first payment)",
  "Remaining collected",
  "Remaining collected - Cash",
  "Remaining collected - Online",
  "Total collected - Cash",
  "Total collected - Online",
] as const;

/**
 * The extra Excel columns for one booking on the "Turf bookings" sheet —
 * appended AFTER the existing columns so nothing already there moves. A
 * booking merged into a bill reports zeros / "n/a", the same convention the
 * sheet's other money columns use, so a plain SUM() never double counts.
 */
export function turfBookingExportColumns(
  b: TurfBooking,
  rows: PaymentRow[],
  tabEntries: TabEntry[] = [],
): Record<string, string | number> {
  const bp = bookingPaymentBreakdown(b, rows, tabEntries);
  const merged = !!b.merged_into_bill_id;
  return {
    "Booking type": bp.kind,
    "Advance (first payment)": bp.advance,
    "Remaining collected": bp.remaining,
    "Remaining collected - Cash": bp.remainingCash,
    "Remaining collected - Online": bp.remainingOnline,
    "Remaining collected on": bp.remainingLastDate
      ? formatDMY(bp.remainingLastDate)
      : "",
    "Remaining status": bp.status,
    "Total collected - Cash": bp.totalCash,
    "Total collected - Online": bp.totalOnline,
    "Payment split": merged ? "n/a" : bp.splitLabel,
    "Split detail": bp.splitDetail,
    "Split pay used": bp.splitUsed ? "Yes" : "No",
  };
}

/** One row per payment of every turf booking — the "Turf payments" sheet. */
export function turfPaymentsSheetRows(
  bookings: TurfBooking[],
  byBooking: Map<string, PaymentRow[]>,
  tabEntries: TabEntry[] = [],
): Record<string, string | number>[] {
  const out: Record<string, string | number>[] = [];
  for (const b of bookings) {
    const bp = bookingPaymentBreakdown(b, byBooking.get(b.id) ?? [], tabEntries);
    for (const l of bp.lines) {
      out.push({
        "Booking ID": b.booking_no,
        Customer: b.customer_name,
        Phone: b.phone ?? "",
        "Payment date": l.receivedAt ? formatDMY(l.receivedAt) : "",
        Mode: l.mode,
        Amount: l.amount,
        "Payment stage": l.stage,
        "Split pay": l.split ? "Yes" : "No",
        "Booking type": bp.kind,
      });
    }
  }
  return out;
}
