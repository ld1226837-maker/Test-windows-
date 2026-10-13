import { useState } from "react";
import { HandCoins } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { Bill } from "@/lib/biz";
import { useCollectMergedBillDue } from "@/lib/merged-collect";
import { money } from "@/lib/money";
import type { PaymentEntry } from "@/lib/payments";
import { errorMessage } from "@/lib/utils";

import { CollectPaymentDialog } from "./CollectPaymentDialog";

/**
 * Action button that takes the place of the old "collect it from Outstanding"
 * note on a merged bill whose balance sits on the customer's tab. Opens the
 * usual Cash / UPI / split collection pop-up.
 */
export function MergedBillCollectButton({
  bill,
  due,
}: {
  bill: Bill;
  /** What this bill still has on the tab (netTabAmountFor). */
  due: number;
}) {
  const [open, setOpen] = useState(false);
  const collect = useCollectMergedBillDue();
  if (!(due > 0)) return null;

  const confirm = async (entries: PaymentEntry[]) => {
    try {
      const r = await collect.mutateAsync({ bill, entries });
      toast.success(`${money(r.collected)} collected on ${bill.invoice_no}`);
      setOpen(false);
    } catch (e) {
      toast.error(errorMessage(e, "Could not record payment"));
    }
  };

  return (
    <>
      <Button
        variant="outline"
        className="h-12 w-full"
        disabled={collect.isPending}
        onClick={() => setOpen(true)}
      >
        <HandCoins className="size-4" /> Collect {money(due)} due
      </Button>
      <CollectPaymentDialog
        open={open}
        onOpenChange={setOpen}
        title={`Collect on ${bill.invoice_no}`}
        description={`${bill.customer_name} · ${money(due)} is on the tab for this merged bill.`}
        due={due}
        onConfirm={confirm}
      />
    </>
  );
}
