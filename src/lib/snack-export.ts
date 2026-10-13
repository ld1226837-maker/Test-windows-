import { isCancelled } from "./bill-state";
import { rupees } from "./money";
import type { SnackSale } from "./ops";

type Line = SnackSale["items"][number];

/**
 * Status / Amount / Profit cells of one snack-sale item row in Excel. A voided
 * sale is shown as "Cancelled" and contributes 0 to Amount and Profit, so a
 * SUM over the sheet equals the Reports snack revenue (cancelled sales never
 * count there). Money really received (Paid columns) is untouched.
 */
export function snackExportLine(sale: SnackSale, line: Line) {
  const dead = isCancelled(sale);
  return {
    Status: dead ? "Cancelled" : "Active",
    Amount: dead ? 0 : line.amount,
    Profit: dead ? 0 : rupees(line.amount - line.qty * line.cost_price),
  };
}
