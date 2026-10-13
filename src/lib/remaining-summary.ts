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
/** Money received AFTER the advance (a later, separate collection). Printed
 * only when an advance was taken and a later payment exists, so the advance
 * and the balance are never mixed into one figure. */
export const BALANCE_PAID_LABEL = "Balance paid";

export type PaymentLine = {
  amount: number;
  mode: string;
  created_at: string;
  received_at?: string | undefined;
  /** Synthetic row for money the record shows as paid but no payment row
   * explains; printed without a date. */
  noDate?: boolean | undefined;
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
    .sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    );
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

/** The app only ever receives money as Cash, UPI or Card. Anything else on a
 * record ("Pending", "On tab", a different spelling) is shown as Cash, the
 * app's own rule for unknown modes (see normalizeReceivedPaymentMode). */
const canonMode = (m: unknown): string => {
  const k = String(m ?? "")
    .trim()
    .toLowerCase();
  if (k === "upi") return "UPI";
  if (k === "card") return "Card";
  return "Cash";
};

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
  /** Part of the balance that sits on the tab (defaults to all of
   * `remaining` when `onTab` is set). */
  onTabAmount?: number | undefined;
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
  /** Full split text ("UPI Rs 500 + Cash Rs 900") when 2+ modes were used. */
  modeLabel: string | null;
  /** Row printed right before "Paid": what was collected after the advance
   * (null unless an advance AND a later payment both exist). */
  balanceRow: Row | null;
  /** How the advance itself was received ("Cash Rs 300 + UPI Rs 200"), when
   * the advance was split across 2+ modes. */
  advanceDetail: string | null;
  /** Staged payment only (advance, then a later balance): how the ADVANCE was
   * received, e.g. "Cash Rs 300 + UPI Rs 200" or just "UPI". Null otherwise. */
  advanceModeText: string | null;
  /** Staged payment only: how the BALANCE was received, kept apart from the
   * advance (never added together). Null otherwise. */
  balanceModeText: string | null;
  /** Staged payment only: the balance amount collected after the advance. */
  balancePaid: number;
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
    modeLabel: null,
    balanceRow: null,
    advanceDetail: null,
    advanceModeText: null,
    balanceModeText: null,
    balancePaid: 0,
  };
  if (a.cancelled) return empty;

  // Stage 1 = the first collection (the advance), stage 2 = everything after
  // it (the balance). Kept apart so "Advance" never turns into "total paid".
  const groups = batches(completeRows(a));
  const staged = advances > 0 && groups.length >= 2;
  const balancePaid = staged ? sumOf(groups.slice(1).flat()) : 0;

  const showStaged = staged && balancePaid > 0;
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
    modeLabel: splitModeLabel(a),
    balanceRow:
      staged && balancePaid > 0
        ? { label: BALANCE_PAID_LABEL, value: a.fmt(balancePaid) }
        : null,
    advanceDetail:
      advances > 0 && groups[0] ? (modeDetail(groups[0], a.fmt) ?? null) : null,
    advanceModeText:
      showStaged && groups[0] ? modeText(groups[0], a.fmt) : null,
    balanceModeText: showStaged
      ? modeText(groups.slice(1).flat(), a.fmt)
      : null,
    balancePaid: showStaged ? balancePaid : 0,
  };
}

const sumOf = (rows: PaymentLine[]) =>
  r2(rows.reduce((n, r) => n + Number(r.amount), 0));

/** The payment rows on file, plus one undated row for any paid money they do
 * not explain (a settlement the rows missed), in the record's own mode. */
function completeRows(a: RemainingArgs): PaymentLine[] {
  const rows = (a.payments ?? []).filter((r) => Number(r.amount) > 0);
  const gap = r2(a.paid) - sumOf(rows);
  const raw = (a.fallbackMode ?? "").trim();
  const mode = canonMode(raw);
  if (gap > 0.5 && !/tab/i.test(raw)) {
    const d = rows.length === 0 ? (a.fallbackDate ?? "") : "";
    rows.push({
      amount: gap,
      mode,
      created_at: d || "~",
      received_at: d || undefined,
      noDate: !d,
    });
  }
  return rows;
}

/** Per-mode totals in first-seen order, e.g. [["UPI", 500], ["Cash", 900]]. */
function modeTotals(rows: PaymentLine[]): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = canonMode(r.mode);
    m.set(k, (m.get(k) ?? 0) + Number(r.amount));
  }
  return [...m].map(([k, v]) => [k, r2(v)]);
}

/** "Cash Rs 300 + UPI Rs 200" when the rows used 2+ modes, else null. */
function modeDetail(
  rows: PaymentLine[],
  fmt: (n: number) => string,
): string | null {
  const t = modeTotals(rows);
  return t.length > 1 ? t.map(([k, v]) => `${k} ${fmt(v)}`).join(" + ") : null;
}

/** "Cash Rs 300 + UPI Rs 200" when split, else the single mode ("UPI"). */
function modeText(
  rows: PaymentLine[],
  fmt: (n: number) => string,
): string | null {
  const t = modeTotals(rows);
  if (t.length === 0) return null;
  return t.length > 1
    ? t.map(([k, v]) => `${k} ${fmt(v)}`).join(" + ")
    : (t[0]?.[0] ?? null);
}

function splitModeLabel(a: RemainingArgs): string | null {
  const rows = batches(completeRows(a)).flat();
  const t = modeTotals(rows);
  return t.length > 1
    ? t.map(([k, v]) => `${k} ${a.fmt(v)}`).join(" + ")
    : null;
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
    return `${a.fmt(Math.min(remaining, a.onTabAmount ?? remaining))} moved to the customer's tab. ${tail}`;

  const groups = batches(completeRows(a));
  // "Rs 654 via Cash Rs 644 + UPI Rs 10 on 11-10-2026" - every mode of the
  // payment, with its amount when the payment was split.
  const part = (rows: PaymentLine[], lead = "") => {
    const t = modeTotals(rows);
    const m =
      t.length > 1
        ? t.map(([k, v]) => `${k} ${a.fmt(v)}`).join(" + ")
        : (t[0]?.[0] ?? "");
    const first = rows[0];
    const d = first?.noDate
      ? ""
      : date(first?.received_at || first?.created_at);
    return `${lead}${a.fmt(sumOf(rows))}${m ? ` via ${m}` : ""}${d ? ` on ${d}` : ""}`;
  };

  // An advance followed by later payment(s): say which is which, so the first
  // collection is never read as the whole amount (or the balance as advance).
  if (groups.length >= 2 && advances > 0)
    return `${groups
      .map((g, i) => part(g, i === 0 ? "Advance " : "Balance "))
      .join("; ")}. ${tail}`;
  if (groups.length >= 2)
    return `Received ${groups.map((g) => part(g)).join("; ")}. ${tail}`;
  if (groups.length === 1) {
    const label = remaining > 0 ? "Advance received" : "Received";
    return `${label} ${part(groups[0] as PaymentLine[])}. ${tail}`;
  }
  if (advances <= 0 && remaining > 0) return `No payment received yet. ${tail}`;
  return null;
}

/** Rows printed after "Paid" (Remaining, Cash/Online lines, Mode) and the
 * "Payable after advances" row, reused by the plain-text bill so the copied /
 * WhatsApp bill carries the same lines as the printed one. */
export function splitReceiptTotals(
  totals: { label: string; value: string }[],
): {
  payable: { label: string; value: string } | null;
  balance: { label: string; value: string } | null;
  afterPaid: { label: string; value: string }[];
} {
  const payable = totals.find((t) => t.label === PAYABLE_LABEL) ?? null;
  const balance = totals.find((t) => t.label === BALANCE_PAID_LABEL) ?? null;
  const paidAt = totals.findIndex((t) => t.label === "Paid");
  const statusAt = totals.findIndex((t) => t.label === "Status");
  const end = statusAt >= 0 ? statusAt : totals.length;
  return {
    payable,
    balance,
    afterPaid: paidAt >= 0 ? totals.slice(paidAt + 1, end) : [],
  };
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
