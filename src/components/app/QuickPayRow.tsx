import { useState, type ReactNode } from "react";
import { Banknote, Smartphone, IndianRupee, Split } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money, type Bill } from "@/lib/biz";
import {
  useCollectBillPayment,
  useCollectBookingPayment,
} from "@/lib/collect";
import { billDue, bookingDue } from "@/lib/dues";
import type { TurfBooking } from "@/lib/ops";
import { cleanAmountInput, rupees } from "@/lib/money";
import type { PaymentEntry } from "@/lib/payments";
import { useTabEntries } from "@/lib/tabs";

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

import { CollectPaymentDialog } from "./CollectPaymentDialog";
import { LayoutPart, LayoutParts } from "./LayoutSection";
import { errorMessage } from "@/lib/utils";

/**
 * One-tap payment shortcuts and partial payment entry for a single bill.
 * Every collection is recorded as real payment rows (lib/collect.ts), so a
 * bill can be paid part cash / part UPI and the cash drawer and the
 * Cash/Online split see exactly which part arrived in which mode.
 *
 * Used for merged bills too — collecting further money against a bill that
 * already carries over other records' merged-in payments works exactly the
 * same way (recordPayment just appends more rows), so there is no reason to
 * restrict a merged bill to cash-only the way this row used to.
 */
export function QuickPayRow({ bill }: { bill: Bill }) {
  const collect = useCollectBillPayment();
  const { data: tabEntries = [] } = useTabEntries();
  // What this bill still owes ON ITS OWN: anything already pushed onto the
  // customer's running tab (or a bill saved "On tab") belongs to the tab
  // ledger, so collecting it here too would take the same rupee twice.
  const due = billDue(bill, tabEntries);
  return (
    <QuickPayControls
      due={due}
      label={bill.invoice_no}
      onCollect={(entries) => collect.mutateAsync({ bill, tabEntries, entries })}
    />
  );
}

/** Layout & arrangement ids of the four turf quick-pay buttons — registered
 * in SECTION_PARTS["turf.bookings"] (lib/layout-parts.ts) so each can be
 * shown or hidden from Layout & arrangement. */
const TURF_PAY_PARTS = {
  cash: "turf.bookings.pay-cash",
  upi: "turf.bookings.pay-upi",
  split: "turf.bookings.pay-split",
  part: "turf.bookings.pay-part",
} as const;

/**
 * Same Paid · Cash / Paid · UPI / Split / Part payment controls for a turf
 * booking, shown on the booking card in the Turf section. Money goes through
 * collectBookingPayment (lib/collect.ts) — real payment rows — exactly like
 * the existing "Mark paid" button, so nothing here can drift from it.
 */
export function TurfQuickPayRow({ booking }: { booking: TurfBooking }) {
  const collect = useCollectBookingPayment();
  const { data: tabEntries = [] } = useTabEntries();
  const due = bookingDue(booking, tabEntries);
  return (
    <QuickPayControls
      due={due}
      label={booking.booking_no}
      description={booking.customer_name}
      confirmSummary
      parts={TURF_PAY_PARTS}
      onCollect={(entries) =>
        collect.mutateAsync({
          booking,
          tabEntries,
          entries,
          markCompleted: true,
        })
      }
    />
  );
}

/** Wraps a control in its Layout & arrangement part when it has an id. */
function Slot({
  id,
  children,
}: {
  id?: string | undefined;
  children: ReactNode;
}) {
  return id ? <LayoutPart id={id}>{children}</LayoutPart> : <>{children}</>;
}

/** The shared one-tap payment controls (see QuickPayRow / TurfQuickPayRow). */
export function QuickPayControls({
  due,
  label,
  description,
  onCollect,
  confirmSummary = false,
  parts,
}: {
  /** What this record still owes on its own. */
  due: number;
  /** Invoice / booking number shown in the confirm text and dialog title. */
  label: string;
  description?: string | undefined;
  onCollect: (entries: PaymentEntry[]) => Promise<unknown>;
  /** When true EVERY way of paying (Cash, UPI, Split, Part payment) ends in
   * the "Confirm payment" pop-up (surface.turf-pay-confirm) before anything
   * is recorded. Bills keep their original flow. */
  confirmSummary?: boolean;
  /** Layout & arrangement part ids for the four controls (turf only). */
  parts?: { cash: string; upi: string; split: string; part: string };
}) {
  const [part, setPart] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ amount: number } | null>(null);
  // Legacy one-tap confirm (bills): full Cash / UPI only.
  const [confirmFull, setConfirmFull] = useState<null | "Cash" | "UPI">(null);
  // Summary confirm (turf): the exact entries about to be recorded.
  const [pending, setPending] = useState<PaymentEntry[] | null>(null);

  const record = async (entries: PaymentEntry[]) => {
    const total = entries.reduce((s, e) => s + e.amount, 0);
    await onCollect(entries);
    const modes = [...new Set(entries.map((e) => e.mode))].join(" + ");
    toast.success(
      total >= due
        ? `Paid via ${modes}`
        : `Recorded ${money(total)} via ${modes} · Due ${money(Math.max(0, due - total))}`,
    );
  };

  const payEntries = async (entries: PaymentEntry[]) => {
    if (busy) return;
    setBusy(true);
    try {
      await record(entries);
      setPart("");
    } catch (e) {
      toast.error(errorMessage(e, "Could not record payment"));
    } finally {
      setBusy(false);
    }
  };

  const payFull = (mode: "Cash" | "UPI") =>
    payEntries([{ amount: due, mode }]);

  const askFull = (mode: "Cash" | "UPI") => {
    if (confirmSummary) setPending([{ amount: due, mode }]);
    else setConfirmFull(mode);
  };

  const payPart = async () => {
    if (busy) return;
    // Whole rupee — matches every other payable amount in the app (see
    // money.ts); the field is free-text, so a typed "50.5" would otherwise
    // save a fractional amount.
    const amt = rupees(Number(part));
    if (!amt || amt <= 0) {
      toast.error("Enter an amount");
      return;
    }
    const applied = Math.min(amt, due);
    // Ask how it was paid — cash, online, or a mix.
    setDialog({ amount: applied });
  };

  const pendingTotal = (pending ?? []).reduce((s, e) => s + e.amount, 0);
  const dueAfter = Math.max(0, due - pendingTotal);

  return (
    <div className="space-y-2">
      {due > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <Slot id={parts?.cash}>
            <Button
              className="lift h-12"
              disabled={busy}
              onClick={() => askFull("Cash")}
            >
              <Banknote className="size-4" /> Paid · Cash
            </Button>
          </Slot>
          <Slot id={parts?.upi}>
            <Button
              className="lift h-12"
              variant="secondary"
              disabled={busy}
              onClick={() => askFull("UPI")}
            >
              <Smartphone className="size-4" /> Paid · UPI
            </Button>
          </Slot>
        </div>
      )}
      {due > 0 && (
        <Slot id={parts?.split}>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center text-primary"
            disabled={busy}
            onClick={() => setDialog({ amount: due })}
          >
            <Split className="size-4" /> Split cash + online
          </Button>
        </Slot>
      )}
      {due > 0 && (
        <Slot id={parts?.part}>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <IndianRupee className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-12 pl-9"
                type="text"
                inputMode="decimal"
                placeholder={`Part payment (due ${due})`}
                value={part}
                onChange={(e) => setPart(cleanAmountInput(e.target.value))}
              />
            </div>
            <Button
              variant="outline"
              className="h-12"
              disabled={busy}
              onClick={payPart}
            >
              Record
            </Button>
          </div>
        </Slot>
      )}
      <AlertDialog
        open={confirmFull !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmFull(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm payment</AlertDialogTitle>
            <AlertDialogDescription>
              Record {money(due)} for {label} as paid in {confirmFull}
              ? This writes payment rows and updates reports.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const m = confirmFull;
                setConfirmFull(null);
                if (m) void payFull(m);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {confirmSummary && (
        <AlertDialog
          open={pending !== null}
          onOpenChange={(o) => {
            if (!o && !busy) setPending(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm payment</AlertDialogTitle>
            </AlertDialogHeader>
            <LayoutParts
              surfaceId="surface.turf-pay-confirm"
              className="space-y-3"
            >
              <LayoutPart id="surface.turf-pay-confirm.summary">
                <AlertDialogDescription asChild>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <p>
                      Record{" "}
                      <span className="font-medium text-foreground">
                        {money(pendingTotal)}
                      </span>{" "}
                      for {label}
                      {description ? ` · ${description}` : ""}?
                    </p>
                    <ul>
                      {(pending ?? []).map((e, i) => (
                        <li key={i}>
                          {e.mode} · {money(e.amount)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </AlertDialogDescription>
              </LayoutPart>
              <LayoutPart id="surface.turf-pay-confirm.due-after">
                <p className="text-sm text-muted-foreground">
                  {dueAfter > 0
                    ? `Still due after this: ${money(dueAfter)}`
                    : "This clears the booking — it will be marked paid."}{" "}
                  This writes payment rows and updates reports.
                </p>
              </LayoutPart>
              <LayoutPart id="surface.turf-pay-confirm.actions">
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={busy}
                    onClick={(e) => {
                      e.preventDefault();
                      const entries = pending;
                      if (!entries) return;
                      void payEntries(entries).finally(() => setPending(null));
                    }}
                  >
                    Confirm
                  </AlertDialogAction>
                </AlertDialogFooter>
              </LayoutPart>
            </LayoutParts>
          </AlertDialogContent>
        </AlertDialog>
      )}
      <CollectPaymentDialog
        open={dialog !== null}
        onOpenChange={(o) => {
          if (!o) setDialog(null);
        }}
        title={`Collect for ${label}`}
        description={description}
        due={due}
        initialAmount={dialog?.amount ?? due}
        onConfirm={async (entries) => {
          if (confirmSummary) {
            // Hand the chosen split to the confirm pop-up; nothing is
            // recorded until the person confirms there.
            setPending(entries);
            return;
          }
          await record(entries);
          setPart("");
        }}
      />
    </div>
  );
}
