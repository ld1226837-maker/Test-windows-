import { useState } from "react";

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
import { toMoneyDecision, type MoneyDecision } from "@/lib/record-state";
import { LayoutPart, LayoutParts } from "./LayoutSection";

type Choice = "refund" | "keep";
type RefundMode = "Cash" | "UPI";

/**
 * The refund-or-keep question, shared by every cancel path (invoice, snack
 * bill, a paid bill moved back to unpaid): the owner either pays the money
 * back (a drawer outflow, never income) or keeps it (forfeited income).
 */
export function MoneyChoice({
  amount,
  choice,
  mode,
  onChoice,
  onMode,
  refundText = "Refund it - the money is paid back to the customer",
  keepText = "Keep it - counted as your income",
  idPrefix = "money",
}: {
  amount: number;
  choice: Choice | null;
  mode: RefundMode;
  onChoice: (c: Choice) => void;
  onMode: (m: RefundMode) => void;
  refundText?: string;
  keepText?: string;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <Label className="text-sm font-medium">
        {money(amount)} was already received. What happens to it?
      </Label>
      <RadioGroup
        value={choice ?? ""}
        onValueChange={(v) => onChoice(v as Choice)}
        className="gap-2"
      >
        <div className="flex items-start gap-2 text-sm">
          <RadioGroupItem
            id={`${idPrefix}-refund`}
            value="refund"
            className="mt-0.5"
          />
          <label htmlFor={`${idPrefix}-refund`} className="flex-1">
            {refundText}
          </label>
        </div>
        <div className="flex items-start gap-2 text-sm">
          <RadioGroupItem
            id={`${idPrefix}-keep`}
            value="keep"
            className="mt-0.5"
          />
          <label htmlFor={`${idPrefix}-keep`} className="flex-1">
            {keepText}
          </label>
        </div>
      </RadioGroup>
      {choice === "refund" && (
        <RadioGroup
          value={mode}
          onValueChange={(v) => onMode(v as RefundMode)}
          className="flex gap-4 pl-6"
          aria-label="Refund paid by"
        >
          {(["Cash", "UPI"] as const).map((m) => (
            <div key={m} className="flex items-center gap-2 text-sm">
              <RadioGroupItem id={`${idPrefix}-mode-${m}`} value={m} />
              <label htmlFor={`${idPrefix}-mode-${m}`}>Paid back by {m}</label>
            </div>
          ))}
        </RadioGroup>
      )}
    </div>
  );
}

/**
 * Pop-up for a single record that already received money (a snack bill being
 * voided, a paid bill being marked unpaid). The caller supplies the wording.
 */
export function MoneyDecisionDialog({
  open,
  onOpenChange,
  title,
  intro,
  amount,
  refundText,
  keepText,
  confirmLabel,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  intro: string;
  amount: number;
  refundText?: string;
  keepText?: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: (d: MoneyDecision) => void | Promise<void>;
}) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [mode, setMode] = useState<RefundMode>("Cash");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setChoice(null);
          setMode("Cash");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{intro}</DialogDescription>
        </DialogHeader>
        <LayoutParts surfaceId="surface.money-decision" className="space-y-4">
          <LayoutPart id="surface.money-decision.summary">
            <p className="text-sm text-muted-foreground">
              Nothing is deleted. The receipts stay on file either way.
            </p>
          </LayoutPart>
          <LayoutPart id="surface.money-decision.choice">
            <MoneyChoice
              amount={amount}
              choice={choice}
              mode={mode}
              onChoice={setChoice}
              onMode={setMode}
              {...(refundText ? { refundText } : {})}
              {...(keepText ? { keepText } : {})}
              idPrefix="md"
            />
          </LayoutPart>
          <LayoutPart id="surface.money-decision.actions">
            <DialogFooter>
              <Button
                className="h-12 w-full"
                disabled={!choice || busy}
                onClick={() =>
                  choice && onConfirm(toMoneyDecision(choice, mode))
                }
              >
                {confirmLabel}
              </Button>
            </DialogFooter>
          </LayoutPart>
        </LayoutParts>
      </DialogContent>
    </Dialog>
  );
}
