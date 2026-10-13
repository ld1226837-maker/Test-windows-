/**
 * Voiding a snack sale with the shared refund-or-keep model.
 *
 * (Cancelling an invoice lives in lib/merge.ts; both write the same optional
 * refund fields - see "Refund model" in lib/dues.ts.)
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { snackSaleGrossTotal } from "./biz";
import { netTabAmountFor } from "./dues";
import { VOID_QUERY_KEYS } from "./data";
import { db } from "./localdb";
import { rupees } from "./money";
import {
  TAB_PAYMENT_MODE,
  applySnackStockDelta,
  type SnackSaleItem,
  type SnackStockChange,
} from "./ops";
import { isCancelled, refundPatch, type MoneyDecision } from "./record-state";
import { TAB_REF_SNACK_SALE, writeTabEntries } from "./tabs";

/** Money already received on a sale (an "On tab" sale received nothing). */
export function saleMoneyAtStake(
  sale: Parameters<typeof snackSaleGrossTotal>[0] & {
    payment_mode?: string | null | undefined;
  },
): number {
  return sale.payment_mode === TAB_PAYMENT_MODE
    ? 0
    : rupees(snackSaleGrossTotal(sale));
}

/**
 * Voids a snack sale: stock goes back on the shelf, a charge it left on the
 * customer's tab is reversed (it used to be refused), and money already
 * received follows the owner's decision. Payment rows are never deleted.
 */
export async function voidSnackSale(
  id: string,
  money?: MoneyDecision,
): Promise<SnackStockChange[]> {
  const stockChanges: SnackStockChange[] = [];
  await db.transaction(
    "rw",
    [
      db.snack_sales,
      db.snack_items,
      db.snack_stock_history,
      db.tab_entries,
      db.customer_tabs,
      db.payments,
    ],
    async () => {
      const sale = await db.snack_sales.get(id);
      if (!sale) throw new Error("Snack bill not found");
      if (sale.merged_into_bill_id)
        throw new Error("Already merged into a bill");
      if (isCancelled(sale)) throw new Error("Already cancelled");

      const held = saleMoneyAtStake(sale);
      if (held > 0 && !money)
        throw new Error(
          `Rs ${held} was already received on ${sale.bill_no}. Choose whether to refund it or keep it.`,
        );

      const timestamp = new Date().toISOString();
      const stockRows = await db.snack_items.toArray();
      for (const line of (sale.items ?? []) as SnackSaleItem[])
        await applySnackStockDelta(
          line,
          line.qty,
          timestamp,
          stockRows,
          stockChanges,
          "sale_reversal",
        );

      // A sale billed "On tab" left a charge on the customer's running tab:
      // reverse what is still owed on it (bookkeeping row, not cash).
      const entries = await db.tab_entries.where("ref_id").equals(id).toArray();
      const onTab = netTabAmountFor(entries, TAB_REF_SNACK_SALE, id);
      // Reverse on the SAME tab the charge was posted to (a sale row does not
      // store the phone, the tab does).
      const charge = entries.find(
        (e) => e.kind === "charge" && e.ref_type === TAB_REF_SNACK_SALE,
      );
      const tab = charge
        ? await db.customer_tabs.get(charge.tab_id)
        : undefined;
      const name =
        tab?.customer_name?.trim() || sale.customer_name?.trim() || "";
      if (onTab > 0 && name)
        await writeTabEntries([
          {
            name,
            phone: tab?.phone ?? null,
            kind: "payment" as const,
            business: "Snacks",
            amount: onTab,
            note: `Voided ${sale.bill_no}`,
            ref_type: TAB_REF_SNACK_SALE,
            ref_id: id,
          },
        ]);

      await db.snack_sales.update(id, {
        cancelled: true,
        ...(held > 0 && money ? refundPatch(money, timestamp) : {}),
      });
    },
  );
  return stockChanges;
}

export function useVoidSnackSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string | { id: string; money?: MoneyDecision }) =>
      typeof input === "string"
        ? voidSnackSale(input)
        : voidSnackSale(input.id, input.money),
    onSuccess: () => {
      for (const key of VOID_QUERY_KEYS)
        qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
