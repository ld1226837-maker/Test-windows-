import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { Bill } from "./biz";
import { netTabAmountFor } from "./dues";
import { db } from "./localdb";
import { rupees } from "./money";
import type { PaymentEntry } from "./payments";
import { TAB_REF_BILL, ensureTab, tabBalanceOf, writeTabEntries } from "./tabs";

/**
 * Collect the balance a MERGED bill put on the customer's tab, straight from
 * the bill. It records the SAME kind of row the Outstanding screen records —
 * a customer-level tab payment carrying its own mode (Cash / UPI / Card),
 * one row per part of a split — so revenue, the drawer and the Cash/Online
 * split see it exactly as if it had been collected from Outstanding. Nothing
 * is double counted and no money rule changes.
 */
export async function collectMergedBillDue(input: {
  bill: Bill;
  entries: PaymentEntry[];
}) {
  const { bill } = input;
  const name = bill.customer_name.trim();
  const parts = input.entries
    .map((e) => ({ amount: rupees(e.amount), mode: e.mode }))
    .filter((e) => e.amount > 0);
  const total = parts.reduce((s, e) => s + e.amount, 0);
  if (total <= 0) throw new Error("Enter an amount to collect");
  return db.transaction("rw", db.customer_tabs, db.tab_entries, async () => {
    const tabId = await ensureTab(name, bill.customer_phone ?? null);
    const ledger = await db.tab_entries.where("tab_id").equals(tabId).toArray();
    const billOnTab = netTabAmountFor(ledger, TAB_REF_BILL, bill.id);
    const maxDue = Math.min(billOnTab, tabBalanceOf(ledger));
    if (total > maxDue) {
      throw new Error(`That is more than the ₹${maxDue} owed on this bill`);
    }
    await writeTabEntries(
      parts.map((p) => ({
        name,
        phone: bill.customer_phone ?? null,
        kind: "payment" as const,
        business: "Shared",
        amount: p.amount,
        note: `Collected on merged bill ${bill.invoice_no}`,
        payment_mode: p.mode,
      })),
    );
    return { collected: total, balanceAfter: tabBalanceOf(ledger) - total };
  });
}

export function useCollectMergedBillDue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: collectMergedBillDue,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tab_entries"] });
      qc.invalidateQueries({ queryKey: ["customer_tabs"] });
      qc.invalidateQueries({ queryKey: ["bills"] });
    },
  });
}
