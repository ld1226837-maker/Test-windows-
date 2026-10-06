import { useState } from "react";
import {
  Copy,
  FileText,
  MoreVertical,
  Paperclip,
  Pencil,
  Printer,
  Share2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copyText, whatsappUrl } from "@/lib/biz";
import { describeError } from "@/lib/error-capture";
import { investmentInvoice, investmentReceiptDoc } from "@/lib/investments";
import type { InvestmentRow } from "@/lib/localdb";
import { printReceipt, receiptText, shareReceipt } from "@/lib/receipt";
import { INVOICE_SECTIONS } from "@/lib/desktop";

/** 44 px tall on touch screens (Android), a compact 36 px with a mouse. */
const BTN = "h-11 gap-1.5 px-3 [@media(pointer:fine)]:sm:h-9";
const ITEM = "min-h-11 gap-2 text-sm [@media(pointer:fine)]:min-h-9";

/**
 * The action row of one investment record.
 *
 * Replaces seven mixed, wrapping icon buttons (edit / photo / delete next to
 * each other, three outline icons from the shared receipt row, then a lone
 * PDF icon) with a short, stable layout:
 *
 *   [ Edit ] [ PDF ] [ Print ]  [ ⋮ ]
 *
 * - The three things done most — edit, PDF (with the receipt photo) and print
 *   — are labelled buttons that share the row width equally on a phone, so
 *   nothing is a tiny unlabeled icon.
 * - Everything occasional lives in the ⋮ menu: View receipt photo, WhatsApp,
 *   Copy, and — last, separated and red — Delete, which still asks to confirm.
 *   Delete is no longer one tap away from Edit.
 */
export function InvestmentActions({
  r,
  onEdit,
  onShowReceipt,
  onDelete,
}: {
  r: InvestmentRow;
  onEdit: (r: InvestmentRow) => void;
  onShowReceipt: (r: InvestmentRow) => void;
  onDelete: (r: InvestmentRow) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"pdf" | "print" | null>(null);

  const run = async (kind: "pdf" | "print", fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error(
        kind === "pdf"
          ? "Couldn't create the investment PDF"
          : "Couldn't print",
        { description: describeError(e) },
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
      <Button
        variant="outline"
        className={`${BTN} flex-1 sm:flex-none`}
        aria-label="Edit investment"
        onClick={() => onEdit(r)}
      >
        <Pencil className="size-4" />
        Edit
      </Button>
      <Button
        variant="outline"
        className={`${BTN} flex-1 sm:flex-none`}
        aria-label="Create investment PDF"
        title={r.receipt_path ? "PDF with the receipt photo" : "PDF"}
        disabled={busy !== null}
        onClick={() => run("pdf", () => investmentInvoice(r))}
      >
        <FileText className="size-4" />
        {busy === "pdf" ? "Creating…" : "PDF"}
      </Button>
      <Button
        variant="outline"
        className={`${BTN} flex-1 sm:flex-none`}
        aria-label="Print investment statement"
        disabled={busy !== null}
        onClick={() =>
          run("print", () =>
            printReceipt(
              investmentReceiptDoc(r),
              undefined,
              INVOICE_SECTIONS.investments,
            ),
          )
        }
      >
        <Printer className="size-4" />
        Print
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 shrink-0 [@media(pointer:fine)]:sm:h-9 [@media(pointer:fine)]:sm:w-9"
            aria-label="More actions"
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {r.receipt_path ? (
            <DropdownMenuItem
              className={ITEM}
              onSelect={() => onShowReceipt(r)}
            >
              <Paperclip className="size-4" />
              View receipt photo
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className={ITEM}
            onSelect={async () => {
              // Shares the receipt PDF — with the attached photo as its last
              // page — through the phone's share sheet (WhatsApp included).
              // Only when no PDF can be shared at all does it fall back to
              // opening WhatsApp with the receipt text.
              try {
                const doc = investmentReceiptDoc(r);
                const url = whatsappUrl(receiptText(doc), null);
                const res = await shareReceipt(
                  doc,
                  url,
                  undefined,
                  INVOICE_SECTIONS.investments,
                );
                if (res === "fallback")
                  toast.info("PDF saved — attach it in WhatsApp");
              } catch (e) {
                toast.error("Couldn't share", {
                  description: describeError(e),
                });
              }
            }}
          >
            <Share2 className="size-4" />
            Share PDF (WhatsApp)
          </DropdownMenuItem>
          <DropdownMenuItem
            className={ITEM}
            onSelect={async () => {
              if (await copyText(receiptText(investmentReceiptDoc(r))))
                toast.success("Copied");
              else toast.error("Copy failed");
            }}
          >
            <Copy className="size-4" />
            Copy details
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={`${ITEM} text-destructive focus:text-destructive`}
            onSelect={() => setConfirming(true)}
          >
            <Trash2 className="size-4" />
            Delete investment
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete investment?</AlertDialogTitle>
            <AlertDialogDescription>
              {r.bill_no ?? "This investment"} will be removed and excluded from
              totals.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDelete(r)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
