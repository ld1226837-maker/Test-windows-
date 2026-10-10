/**
 * Display-only breakdown of a MERGED bill (one turf booking + snack bills).
 *
 * Nothing here changes a rupee of any calculation: grand total, paid and
 * balance due are still computed by lib/biz.ts / lib/dues.ts. This module only
 * decides how an already-computed `paid` figure is SPLIT for printing:
 *
 *   Advance paid = turf booking advance only
 *   Snacks paid  = paid part of the merged snack bills (omitted when 0)
 *
 * It is pure (no db / settings imports) so the on-screen preview, the saved
 * bill, thermal + A4/A5 receipts and exports can all share it.
 *
 * `MergedBreakdown` is written once by `mergeIntoBill` and stored on the bill
 * row. Bills saved before it existed simply have no breakdown: callers must
 * then print exactly as they always did (this function returns null).
 */

export type MergedSnackPart = {
  /** Snack bill number, e.g. "SNK-0012" (may be empty). */
  bill_no: string;
  /** How many of the bill's items belong to this snack bill. */
  items: number;
  /** Sum of that snack bill's item totals. */
  amount: number;
  /** Money already collected on that snack bill (0 when it was on tab). */
  paid: number;
};

export type MergedBreakdown = {
  v: 1;
  /** The first `turf_items` bill items are turf lines; snack items follow. */
  turf_items: number;
  /** Turf booking advance actually collected (never includes snack money). */
  turf_advance: number;
  snacks: MergedSnackPart[];
};

export type MergedLineGroup =
  | { kind: "turf"; start: number; end: number }
  | { kind: "snack"; start: number; end: number; bill_no: string };

export type MergedBillView = {
  /** Positive rupees; print as a negative line. */
  advancePaid: number;
  /** Positive rupees; print as a negative line, omit when 0. */
  snacksPaid: number;
  /** grandTotal − paid, never negative. */
  balanceDue: number;
  /** Index ranges into bill.items, in print order (turf first, then snacks). */
  groups: MergedLineGroup[];
};

const whole = (n: unknown) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? v : 0;
};

/**
 * @returns null when there is no (valid) breakdown — the caller must then
 * print the legacy way. A breakdown that does not match the bill's item count
 * is treated as missing rather than risk mislabelling lines.
 */
export function mergedBillBreakdown(args: {
  breakdown?: MergedBreakdown | null | undefined;
  /** Total paid so far (billPaidAmount). */
  paid: number;
  /** Tax-inclusive grand total (billGrossTotal). */
  grandTotal: number;
  itemCount: number;
}): MergedBillView | null {
  const bd = args.breakdown;
  if (!bd || bd.v !== 1 || !Array.isArray(bd.snacks)) return null;
  const turfItems = Math.max(0, Math.floor(Number(bd.turf_items) || 0));
  const snackItems = bd.snacks.reduce(
    (s, x) => s + Math.max(0, Math.floor(Number(x.items) || 0)),
    0,
  );
  if (turfItems + snackItems !== args.itemCount) return null;

  const paid = Math.max(0, whole(args.paid));
  const snackPaidTotal = bd.snacks.reduce(
    (s, x) => s + Math.max(0, whole(x.paid)),
    0,
  );
  const snacksPaid = Math.min(paid, snackPaidTotal);
  const advancePaid = Math.min(
    Math.max(0, whole(bd.turf_advance)),
    Math.max(0, paid - snacksPaid),
  );

  const groups: MergedLineGroup[] = [];
  if (turfItems > 0) groups.push({ kind: "turf", start: 0, end: turfItems });
  let at = turfItems;
  for (const sn of bd.snacks) {
    const n = Math.max(0, Math.floor(Number(sn.items) || 0));
    if (n === 0) continue;
    groups.push({ kind: "snack", start: at, end: at + n, bill_no: sn.bill_no });
    at += n;
  }

  return {
    advancePaid,
    snacksPaid,
    balanceDue: Math.max(0, whole(args.grandTotal) - paid),
    groups,
  };
}
