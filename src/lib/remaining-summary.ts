/**
 * Display-only "how much is still left to pay" lines for bills, bookings,
 * snack bills and payment receipts.
 *
 * Everything is for the ONE record being printed (never the customer's whole
 * dues). Nothing here changes a rupee of any calculation. Grand total, advances and
 * paid are computed by lib/biz.ts / lib/dues.ts / lib/payments.ts exactly as
 * before; this module only turns those already-computed numbers into printable
 * rows and a one-line payment note.
 *
 * It is pure (no db / settings imports) so receipts, the on-screen summaries
 * and the plain-text WhatsApp bill can share it.
 */

/** Printed in place of the old "Balance due" row. Same value, always shown. */
export const REMAINING_LABEL = "Remaining to be paid";
/** Grand total minus advances: what was due at the counter. */
export const PAYABLE_LABEL = "Payable after advances";

export type PaymentLine = {
  amount: number;
  mode: string;
  created_at: string;
  received_at?: string | undefined;
};

type Row = { label: string; value: string; strong?: boolean };

const r2 = (n: unknown) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isFinite(v) ? v : 0;
};

/** One receipt (or one split receipt) is written in a single transaction, so
 * its parts are stamped within milliseconds of each other. */
const BATCH_MS = 1000;

function batches(rows: PaymentLine[]): PaymentLine[][] {
  const sorted = rows
    .filter((r) => Number(r.amount) > 0)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const out: PaymentLine[][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const t = Date.parse(r.created_at);
    const t0 = last && last[0] ? Date.parse(last[0].created_at) : NaN;
    if (last && Number.isFinite(t) && Number.isFinite(t0) && t - t0 <= BATCH_MS)
      last.push(r);
    else out.push([r]);
  }
  return out;
}

const modesOf = (rows: PaymentLine[]) =>
  Array.from(new Set(rows.map((r) => r.mode).filter(Boolean))).join(" + ");

export type RemainingArgs = {
  /** Tax-inclusive grand total, as already printed. */
  grandTotal: number;
  /** Money received up front (turf advance + snacks already paid). */
  advances: number;
  /** Total received so far (the existing "Paid" figure). */
  paid: number;
  fmt: (n: number) => string;
  /** A cancelled record prints no remaining figure. */
  cancelled?: boolean | undefined;
  /** Balance moved onto the customer's running tab. */
  onTab?: boolean | undefined;
  /** Payment rows on file for the record, when there are any. */
  payments?: PaymentLine[] | undefined;
  /** Used only when there are no payment rows. */
  fallbackMode?: string | null | undefined;
  fallbackDate?: string | null | undefined;
  fmtDate?: ((iso: string) => string) | undefined;
};

export type RemainingView = {
  payable: number;
  remaining: number;
  /** Row to print right before "Paid" (null when no advance was taken). */
  payableRow: Row | null;
  /** Rows to print right after "Paid" (replaces the old "Balance due"). */
  remainingRows: Row[];
  /** One-line note for the receipt, or null. */
  note: string | null;
};

export function remainingSummary(a: RemainingArgs): RemainingView {
  const grand = r2(a.grandTotal);
  const advances = Math.min(Math.max(0, r2(a.advances)), grand);
  const payable = Math.max(0, r2(grand - advances));
  const remaining = Math.max(0, r2(grand - Math.max(0, r2(a.paid))));
  const empty: RemainingView = {
    payable,
    remaining,
    payableRow: null,
    remainingRows: [],
    note: null,
  };
  if (a.cancelled) return empty;

  const payableRow: Row | null =
    advances > 0 ? { label: PAYABLE_LABEL, value: a.fmt(payable) } : null;
  const remainingRows: Row[] = [
    { label: REMAINING_LABEL, value: a.fmt(remaining), strong: false },
  ];

  return {
    payable,
    remaining,
    payableRow,
    remainingRows,
    note: paymentNote(a, remaining, advances),
  };
}

function paymentNote(
  a: RemainingArgs,
  remaining: number,
  advances: number,
): string | null {
  const date = (iso?: string | null) =>
    iso ? (a.fmtDate ? a.fmtDate(iso) : iso.slice(0, 10)) : "";
  const tail =
    remaining > 0
      ? `Remaining ${a.fmt(remaining)}.`
      : `Remaining ${a.fmt(0)} - settled in full.`;

  if (a.onTab && remaining > 0)
    return `${a.fmt(remaining)} moved to the customer's tab. ${tail}`;

  const groups = batches(a.payments ?? []);
  const sum = (rows: PaymentLine[]) =>
    r2(rows.reduce((n, r) => n + Number(r.amount), 0));
  const when = (rows: PaymentLine[]) =>
    date(rows[0]?.received_at || rows[0]?.created_at);
  const part = (label: string, rows: PaymentLine[]) => {
    const d = when(rows);
    const m = modesOf(rows);
    return `${label} ${a.fmt(sum(rows))}${m ? ` via ${m}` : ""}${d ? ` on ${d}` : ""}.`;
  };

  if (groups.length >= 2) {
    // First batch = the advance; the newest batch = the latest payment.
    const latest = groups[groups.length - 1];
    if (latest) return `${part("Received", latest)} ${tail}`;
  }
  if (groups.length === 1) {
    const only = groups[0] as PaymentLine[];
    const label = remaining > 0 ? "Advance received" : "Received";
    return `${part(label, only)} ${tail}`;
  }

  // No payment rows on file: older records keep working from what they have.
  const paid = r2(a.paid);
  if (paid > 0) {
    const m = a.fallbackMode ? ` via ${a.fallbackMode}` : "";
    const d = date(a.fallbackDate);
    const label = remaining > 0 ? "Advance received" : "Received";
    return `${label} ${a.fmt(paid)}${m}${d ? ` on ${d}` : ""}. ${tail}`;
  }
  if (advances <= 0 && remaining > 0) return `No payment received yet. ${tail}`;
  return null;
}

/** Joins the receipt's own note (typed by the user) with the payment note. */
export function joinNotes(
  ...parts: (string | null | undefined)[]
): string | null {
  const out = parts.map((p) => (p ?? "").trim()).filter(Boolean);
  return out.length ? out.join("\n") : null;
}

/** The PDF fonts cannot draw the rupee sign: it prints as wide, spaced-out
 * glyphs that overflow the row. Receipts use "Rs " instead. */
export const pdfSafeText = (s: string) => s.replace(/\u20b9\s*/g, "Rs ");
