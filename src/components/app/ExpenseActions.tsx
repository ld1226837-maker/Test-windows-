import { useState } from "react";
import { Download, Printer, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { whatsappUrl } from "@/lib/biz";
import { INVOICE_SECTIONS } from "@/lib/desktop";
import { describeError } from "@/lib/error-capture";
import {
  expenseReceiptDoc,
  type ExpenseReceiptSource,
} from "@/lib/expense-receipt";
import {
  downloadReceipt,
  printReceipt,
  receiptText,
  shareReceipt,
} from "@/lib/receipt";

/** 44 px tall on touch screens (Android), a compact 36 px with a mouse. */
const BTN = "h-11 flex-1 gap-1.5 px-3 [@media(pointer:fine)]:sm:h-9";

/**
 * Print / PDF / Share for one expense. The receipt photo attached to the
 * expense (when there is one) is added after the receipt as the last page of
 * the printout, the saved PDF and the shared PDF alike.
 */
export function ExpenseActions({ e }: { e: ExpenseReceiptSource }) {
  const [busy, setBusy] = useState<"print" | "pdf" | "share" | null>(null);

  const run = async (
    kind: "print" | "pdf" | "share",
    failure: string,
    fn: () => Promise<unknown>,
  ) => {
    if (busy) return;
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast.error(failure, { description: describeError(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex w-full items-center gap-2">
      <Button
        variant="outline"
        className={BTN}
        aria-label="Print expense receipt"
        disabled={busy !== null}
        onClick={() =>
          run("print", "Couldn't print", () =>
            printReceipt(
              expenseReceiptDoc(e),
              undefined,
              INVOICE_SECTIONS.expenses,
            ),
          )
        }
      >
        <Printer className="size-4" />
        Print
      </Button>
      <Button
        variant="outline"
        className={BTN}
        aria-label="Create expense PDF"
        title={e.receipt_path ? "PDF with the receipt photo" : "PDF"}
        disabled={busy !== null}
        onClick={() =>
          run("pdf", "Couldn't create the expense PDF", () =>
            downloadReceipt(
              expenseReceiptDoc(e),
              undefined,
              INVOICE_SECTIONS.expenses,
            ),
          )
        }
      >
        <Download className="size-4" />
        {busy === "pdf" ? "Creating…" : "PDF"}
      </Button>
      <Button
        variant="outline"
        className={BTN}
        aria-label="Share expense on WhatsApp"
        title={
          e.receipt_path ? "Share the PDF with its photo" : "Share the PDF"
        }
        disabled={busy !== null}
        onClick={() =>
          run("share", "Couldn't share", async () => {
            const doc = expenseReceiptDoc(e);
            const res = await shareReceipt(
              doc,
              whatsappUrl(receiptText(doc), null),
              undefined,
              INVOICE_SECTIONS.expenses,
            );
            if (res === "fallback")
              toast.info("PDF saved — attach it in WhatsApp");
            // "cancelled" (share sheet dismissed, or a save failure that has
            // already shown its own error toast) deliberately says nothing.
          })
        }
      >
        <Share2 className="size-4" />
        Share
      </Button>
    </div>
  );
}
