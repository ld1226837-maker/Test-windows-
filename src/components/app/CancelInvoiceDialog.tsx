import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { money } from "@/lib/biz";
import { useVoidBill } from "@/lib/data";
import {
  cancelInvoiceEffects,
  previewCancelInvoice,
  type CancelInvoicePreview,
  type CancelScope,
} from "@/lib/merge";
import { errorMessage } from "@/lib/utils";
import { LayoutPart, LayoutParts } from "./LayoutSection";
import { toMoneyDecision } from "@/lib/record-state";
import { MoneyChoice } from "./MoneyDecisionDialog";

/**
 * Cancel an invoice. A merged invoice asks whether to cancel only the invoice
 * (its turf and snack bills come back as separate bills) or the invoice AND
 * its bills, shows what each does, and requires a confirm. Money already
 * received is never dropped silently: the owner refunds it or keeps it.
 * Reads nothing until opened (no extra listeners on the Bills screen).
 */
export function CancelInvoiceDialog({
  billId,
  onOpenChange,
}: {
  billId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const voidBill = useVoidBill();
  // The parent passes a fresh callback every render; the load effect must
  // only re-run when the invoice changes.
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;
  const [preview, setPreview] = useState<CancelInvoicePreview | null>(null);
  const [scope, setScope] = useState<CancelScope | null>(null);
  const [choice, setChoice] = useState<"refund" | "keep" | null>(null);
  const [mode, setMode] = useState<"Cash" | "UPI">("Cash");

  useEffect(() => {
    setPreview(null);
    setScope(null);
    setChoice(null);
    setMode("Cash");
    if (!billId) return;
    let live = true;
    previewCancelInvoice(billId)
      .then((p) => live && setPreview(p))
      .catch((e) => {
        toast.error(errorMessage(e));
        closeRef.current(false);
      });
    return () => {
      live = false;
    };
  }, [billId]);

  const effectiveScope: CancelScope | null = preview
    ? preview.merged
      ? scope
      : "invoice-only"
    : null;
  const effects =
    preview && effectiveScope
      ? cancelInvoiceEffects(preview, effectiveScope)
      : null;
  const ready =
    !!effects &&
    !effects.blocked &&
    (!effects.needsMoneyDecision || choice !== null) &&
    !voidBill.isPending;

  const confirm = () => {
    if (!billId || !preview || !effectiveScope || !effects) return;
    voidBill.mutate(
      {
        id: billId,
        scope: effectiveScope,
        ...(effects.needsMoneyDecision && choice
          ? { money: toMoneyDecision(choice, mode) }
          : {}),
      },
      {
        onSuccess: () => {
          toast.success(`${preview.invoiceNo} cancelled`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <Dialog open={billId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cancel {preview?.invoiceNo ?? "invoice"}?</DialogTitle>
          <DialogDescription>
            The record stays for history; it stops counting toward revenue and
            dues.
          </DialogDescription>
        </DialogHeader>
        {preview && (
          <LayoutParts surfaceId="surface.cancel-invoice" className="space-y-4">
            <LayoutPart id="surface.cancel-invoice.summary">
              <p className="text-sm text-muted-foreground">
                Total {money(preview.total)} · received{" "}
                {money(preview.collected)}
                {preview.merged &&
                  ` · ${preview.bookings.length} turf booking(s), ${preview.sales.length} snack bill(s)`}
              </p>
            </LayoutPart>
            <LayoutPart id="surface.cancel-invoice.scope">
              {preview.merged && (
                <RadioGroup
                  value={scope ?? ""}
                  onValueChange={(v) => setScope(v as CancelScope)}
                  className="gap-3"
                >
                  <div className="flex items-start gap-2 text-sm">
                    <RadioGroupItem
                      id="ci-only"
                      value="invoice-only"
                      className="mt-0.5"
                    />
                    <label htmlFor="ci-only" className="flex-1">
                      Cancel invoice only - bring the turf and snack bills back
                      as separate bills
                    </label>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <RadioGroupItem
                      id="ci-all"
                      value="invoice-and-sources"
                      className="mt-0.5"
                    />
                    <label htmlFor="ci-all" className="flex-1">
                      Cancel invoice and its turf and snack bills
                    </label>
                  </div>
                </RadioGroup>
              )}
            </LayoutPart>
            <LayoutPart id="surface.cancel-invoice.effects">
              {effects ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {effects.blocked && (
                    <li className="font-medium text-destructive">
                      {effects.blocked}
                    </li>
                  )}
                  {effects.sourcesReleased > 0 && (
                    <li>
                      {effects.sourcesReleased} bill(s) become separate bills
                      again and keep their own payments.
                    </li>
                  )}
                  {effects.tabDueRestored > 0 && (
                    <li>
                      {money(effects.tabDueRestored)} goes back on the
                      customer&apos;s tab against those bills.
                    </li>
                  )}
                  {effects.sourcesCancelled > 0 && (
                    <li>
                      {effects.sourcesCancelled} turf/snack bill(s) are
                      cancelled with the invoice.
                    </li>
                  )}
                  {effects.stockUnitsRestored > 0 && (
                    <li>
                      {effects.stockUnitsRestored} snack unit(s) go back into
                      stock.
                    </li>
                  )}
                  {effects.billTabReversed > 0 && (
                    <li>
                      {money(effects.billTabReversed)} is taken off the
                      customer&apos;s tab.
                    </li>
                  )}
                  {effects.needsMoneyDecision ? (
                    <li>
                      {money(effects.moneyAtStake)} already received is refunded
                      or kept - you choose below.
                    </li>
                  ) : (
                    <li>No money has to be refunded or kept.</li>
                  )}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Choose an option to see what it does.
                </p>
              )}
            </LayoutPart>
            <LayoutPart id="surface.cancel-invoice.money">
              {effects?.needsMoneyDecision && (
                <MoneyChoice
                  amount={effects.moneyAtStake}
                  choice={choice}
                  mode={mode}
                  onChoice={setChoice}
                  onMode={setMode}
                  idPrefix="ci-money"
                />
              )}
            </LayoutPart>
            <LayoutPart id="surface.cancel-invoice.actions">
              <DialogFooter>
                <Button
                  variant="destructive"
                  className="h-12 w-full"
                  disabled={!ready}
                  onClick={confirm}
                >
                  Confirm cancel
                </Button>
              </DialogFooter>
            </LayoutPart>
          </LayoutParts>
        )}
      </DialogContent>
    </Dialog>
  );
}
