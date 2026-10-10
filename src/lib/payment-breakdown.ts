import { money } from "./money";
import { cashOnlineSplit } from "./payments";

/**
 * Display-only "how was this paid" summary, built from payment rows.
 *
 * Nothing here changes a rupee of any calculation: it only re-groups money
 * that was already collected (payment rows) into Cash vs Online and a split
 * label, using the SAME Cash-vs-Online rule as the drawer, reports and
 * expenses (`isOnlinePaymentMode`, via `cashOnlineSplit`).
 */

export type ModeAmount = { mode: string; amount: number };

export type ModeBreakdown = {
  /** Total money in the rows (cash + online). */
  total: number;
  cash: number;
  online: number;
  /** Per-mode totals, in first-seen order (e.g. Cash, UPI). */
  modes: ModeAmount[];
  /** Names of the online modes used, e.g. "UPI" or "UPI + Card"; "" if none. */
  onlineModes: string;
  /** "Cash ₹700 + UPI ₹300" — only when two or more modes were used. */
  split: string | null;
  /** "Cash ₹700" / "Cash ₹700 + UPI ₹300", or "" when nothing was received. */
  detail: string;
};

export function modeBreakdown(
  rows: { amount: number; mode: string | null | undefined }[],
): ModeBreakdown {
  const byMode = new Map<string, number>();
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    if (!(amount > 0)) continue;
    const mode = r.mode || "Cash";
    byMode.set(mode, (byMode.get(mode) ?? 0) + amount);
  }
  // Cash always first, so "Cash ₹700 + UPI ₹300" reads the same everywhere.
  const modes: ModeAmount[] = [...byMode]
    .map(([mode, amount]) => ({ mode, amount }))
    .sort((a, b) => Number(b.mode === "Cash") - Number(a.mode === "Cash"));
  const { cash, online } = cashOnlineSplit(modes);
  const detail = modes.map((m) => `${m.mode} ${money(m.amount)}`).join(" + ");
  const onlineModes = modes
    .filter((m) => cashOnlineSplit([m]).online > 0)
    .map((m) => m.mode)
    .join(" + ");
  return {
    total: cash + online,
    cash,
    online,
    modes,
    onlineModes,
    split: modes.length > 1 ? detail : null,
    detail,
  };
}

/** Same grouping from already-aggregated per-mode amounts. */
export const modeBreakdownOf = (modes: ModeAmount[] | null | undefined) =>
  modeBreakdown(modes ?? []);

/**
 * Receipt / summary lines: "Cash received", "Online received (UPI)" and, when
 * more than one mode was used, "Split payment". Empty when nothing was
 * received. `fmt` lets receipts use their own currency formatter.
 */
export function modeLines(
  b: ModeBreakdown,
  fmt: (n: number) => string = money,
): { label: string; value: string }[] {
  if (!(b.total > 0)) return [];
  return [
    ...(b.cash > 0 ? [{ label: "Cash received", value: fmt(b.cash) }] : []),
    ...(b.online > 0
      ? [
          {
            label: `Online received (${b.onlineModes || "Online"})`,
            value: fmt(b.online),
          },
        ]
      : []),
    ...(b.split ? [{ label: "Split payment", value: b.split }] : []),
  ];
}

/** Flat columns for Excel exports: Cash / Online amounts and the split text. */
export function modeExportColumns(b: ModeBreakdown) {
  return {
    "Paid - Cash": b.cash,
    "Paid - Online": b.online,
    "Split detail": b.split ?? "",
  };
}
