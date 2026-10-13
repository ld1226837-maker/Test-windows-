/**
 * The ONE meaning of "cancelled" for turf bookings, snack sales and bills.
 *
 * This file has NO imports on purpose: lib/dues.ts needs these predicates and
 * lib/bill-state.ts (the public face, which also computes pending amounts)
 * needs dues.ts, so the shared core lives here to keep the graph acyclic.
 * Import from "./bill-state" everywhere else.
 *
 *   turf booking : status "Cancelled" or "No-show"
 *   snack sale   : cancelled === true
 *   bill         : status "cancelled"
 */

export type StatefulRecord = {
  status?: string | null | undefined;
  cancelled?: boolean | null | undefined;
};

const DEAD_STATUSES = new Set(["cancelled", "no-show"]);

/** True for a cancelled, voided or no-show record. */
export function isCancelled(r: StatefulRecord): boolean {
  if (r.cancelled === true) return true;
  return DEAD_STATUSES.has(String(r.status ?? "").toLowerCase());
}

/** True for a record that still counts: anything not cancelled/no-show. */
export const isLive = (r: StatefulRecord): boolean => !isCancelled(r);

/**
 * What the owner decided about money already received on a record that is
 * being cancelled/voided:
 *  - "refund": it is paid back to the customer NOW (a drawer outflow today,
 *    never income),
 *  - "keep": the owner keeps it (forfeited: income on the day it arrived).
 */
export type MoneyDecision =
  { decision: "refund"; refund_mode?: "Cash" | "UPI" } | { decision: "keep" };

/** The optional refund fields written onto the cancelled record. */
export function refundPatch(d: MoneyDecision, nowIso: string) {
  return d.decision === "refund"
    ? {
        is_refundable: true as const,
        refunded_at: nowIso,
        refund_mode: d.refund_mode ?? ("Cash" as const),
      }
    : {
        is_refundable: false as const,
        refunded_at: null,
        refund_mode: null,
      };
}

/** Builds the decision from the pop-up's two radio groups. */
export const toMoneyDecision = (
  choice: "refund" | "keep",
  mode: "Cash" | "UPI",
): MoneyDecision =>
  choice === "refund"
    ? { decision: "refund", refund_mode: mode }
    : { decision: "keep" };

/**
 * The one on-screen wording for money still owed: "Pending Rs 1,100". Plain
 * ASCII so it is also safe in WhatsApp text and exports. (Printed statements
 * keep their own "Remaining to be paid" line label.)
 */
export const pendingLabel = (amount: number): string =>
  `Pending Rs ${Math.round(Math.max(0, amount)).toLocaleString("en-IN")}`;
