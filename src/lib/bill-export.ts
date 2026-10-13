import { billPaidAmount, type Bill } from "./biz";
import { isCancelled } from "./bill-state";
import { billDue, billMovedToDues } from "./dues";
import type { TabEntry } from "./tabs";

export type BillExportStatusWord =
  "Cancelled" | "Moved to dues" | "Pending" | "Paid";

/**
 * The Paid / Balance / Status cells of a bill row in Excel/CSV. Reads the SAME
 * billDue() the Bills screen, Outstanding and the Dashboard use (net of money
 * moved to a running tab, 0 for a cancelled bill) and the one cancelled
 * meaning, instead of the raw stored status string.
 *
 *  - Cancelled     : Paid 0 and Balance 0, like Reports (billCollected) - a
 *                    void bill collected nothing, whatever amount_paid it kept.
 *  - Moved to dues : the balance now sits on the customer's tab (the Bills
 *                    screen's "Moved to dues"). Balance is 0 on the bill, but
 *                    the row is NOT "Paid" - the customer still owes it there.
 *  - Pending / Paid: by the bill's own due.
 */
export function billExportStatus(
  bill: Bill,
  tabEntries: TabEntry[] = [],
): { Paid: number; Balance: number; Status: BillExportStatusWord } {
  if (isCancelled(bill)) return { Paid: 0, Balance: 0, Status: "Cancelled" };
  const Paid = billPaidAmount(bill);
  if (billMovedToDues(bill, tabEntries))
    return { Paid, Balance: 0, Status: "Moved to dues" };
  const due = billDue(bill, tabEntries);
  return { Paid, Balance: due, Status: due > 0 ? "Pending" : "Paid" };
}
