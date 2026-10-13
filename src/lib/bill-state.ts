/**
 * Single source of truth for a record's lifecycle state, shared by Turf,
 * Snacks, Bills, Customers, Outstanding, Reports, the Dashboard, exports and
 * WhatsApp text. No screen may compare status strings itself.
 *
 *   isCancelled(r)    cancelled booking, No-show booking, voided snack sale,
 *                     cancelled bill (one meaning everywhere)
 *   isLive(r)         not cancelled
 *   pendingAmount(r)  money still owed on a LIVE, un-merged record: its own
 *                     unpaid balance PLUS anything moved onto the customer's
 *                     tab against it. Per-record display figure: totals (Dues,
 *                     Dashboard, Reports) still come from customerOutstanding /
 *                     periodStats, which never add a tab charge twice.
 *   isPending(r)      pendingAmount(r) > 0
 *
 * One badge, one wording: pendingLabel(amount) -> "Pending Rs X".
 */

import { billDue, bookingDue, netTabAmountFor, type DueBooking } from "./dues";
import { snackSaleGrossTotal, type Bill } from "./biz";
import { rupees } from "./money";
import type { SnackSale, TurfBooking } from "./ops";
import { TAB_PAYMENT_MODE } from "./ops";
import {
  TAB_REF_BILL,
  TAB_REF_SNACK_SALE,
  TAB_REF_TURF_BOOKING,
  type TabEntry,
} from "./tabs";

export { isCancelled, isLive, pendingLabel } from "./record-state";
import { isCancelled } from "./record-state";

export type PendingRecord = Bill | TurfBooking | SnackSale | DueBooking;

export type PendingContext = {
  /** The customer tab ledger. Without it a snack sale billed "On tab" is
   * assumed to still owe its whole total. */
  tabEntries?: TabEntry[];
};

type Kind = "bill" | "booking" | "sale";

function kindOf(r: object): Kind {
  // A snack sale can carry a `booking_no` (the booking it was sold against), so
  // `bill_no` - which only sales have - must be checked before `booking_no`.
  if ("invoice_no" in r) return "bill";
  if ("bill_no" in r) return "sale";
  return "booking";
}

/** Money still owed on one record (0 for a cancelled or merged one). */
export function pendingAmount(
  record: PendingRecord,
  ctx: PendingContext = {},
): number {
  const entries = ctx.tabEntries ?? [];
  if (isCancelled(record)) return 0;
  const merged = (record as { merged_into_bill_id?: string | null })
    .merged_into_bill_id;
  if (merged) return 0;
  switch (kindOf(record)) {
    case "bill": {
      const bill = record as Bill;
      return rupees(
        billDue(bill, entries) +
          netTabAmountFor(entries, TAB_REF_BILL, bill.id),
      );
    }
    case "booking": {
      const b = record as TurfBooking;
      return rupees(
        bookingDue(b, entries) +
          netTabAmountFor(entries, TAB_REF_TURF_BOOKING, b.id),
      );
    }
    default: {
      const s = record as SnackSale;
      if (ctx.tabEntries === undefined)
        return (s.payment_mode ?? "") === TAB_PAYMENT_MODE
          ? rupees(snackSaleGrossTotal(s))
          : 0;
      return netTabAmountFor(entries, TAB_REF_SNACK_SALE, s.id);
    }
  }
}

export const isPending = (record: PendingRecord, ctx: PendingContext = {}) =>
  pendingAmount(record, ctx) > 0;
