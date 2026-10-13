import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Merge, ReceiptText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatDMY, money } from "@/lib/biz";
import { INVOICE_SECTIONS } from "@/lib/desktop";
import { isFinancialBooking, isFinancialSale } from "@/lib/dues";
import {
  buildMergedItems,
  distinctMergeCustomers,
  mergeCandidateKey,
  mergeIntoBill,
  orderCandidates,
  previewMerge,
  resolveMergeCustomer,
} from "@/lib/merge";
import { collectBillPayment } from "@/lib/collect";
import { planSplit, type SplitDraft } from "@/lib/split-payment";
import { usePrintSettings } from "@/lib/print";
import { printBillPdf } from "@/lib/receipt";
import { useSnackSales, useTurfBookings } from "@/lib/ops";
import { usePayments } from "@/lib/data";
import { useTabEntries } from "@/lib/tabs";
import { CustomerFields } from "./CustomerFields";
import { SplitPaymentFields } from "./SplitPaymentFields";
import { LayoutPart, LayoutParts } from "./LayoutSection";
import { errorMessage } from "@/lib/utils";

const EMPTY_DRAFT: SplitDraft = { cash: "", online: "", onlineMode: "UPI" };

/**
 * Merge recent turf bookings + snack bills into ONE bill saved in Bills.
 *
 * All the money math and every write lives in lib/merge.ts: this dialog only
 * picks the sources and shows what will happen. `previewMerge()` and
 * `mergeIntoBill()` share the same math function, so the summary line below
 * can never disagree with what is actually written.
 */
export function MergeBillDialog() {
  const [open, setOpen] = useState(false);
  const { data: bookings = [] } = useTurfBookings();
  const { data: sales = [] } = useSnackSales();
  const { data: tabEntries = [] } = useTabEntries();
  const { data: payments = [] } = usePayments();
  const { settings: printSettings } = usePrintSettings();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [turfIds, setTurfIds] = useState<string[]>([]);
  const [snackIds, setSnackIds] = useState<string[]>([]);
  // "pending": customer pays later. "paid": money is received now.
  const [dueMode, setDueMode] = useState<"pending" | "paid">("pending");
  const [draft, setDraft] = useState<SplitDraft>(EMPTY_DRAFT);
  // Each candidate list reveals 5 more on its own.
  const [turfShown, setTurfShown] = useState(5);
  const [snackShown, setSnackShown] = useState(5);
  // The customer of the FIRST ticked item: candidates default to theirs.
  const [anchor, setAnchor] = useState<{
    name: string;
    phone: string | null;
  } | null>(null);
  const [allCustomers, setAllCustomers] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggle = (
    ids: string[],
    set: (v: string[]) => void,
    id: string,
    who: { name: string | null; phone: string | null },
  ) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    set(next);
    // First tick sets the anchor; unticking everything clears it.
    const none =
      next.length === 0 &&
      (ids === turfIds ? snackIds.length === 0 : turfIds.length === 0);
    if (none) setAnchor(null);
    else if (!anchor && !ids.includes(id))
      setAnchor({ name: who.name ?? "", phone: who.phone });
  };

  // Already-merged rows are hidden: they are no longer their own financial
  // record, and lib/merge.ts refuses to merge them a second time anyway.
  const openBookings = useMemo(
    () => bookings.filter(isFinancialBooking),
    [bookings],
  );
  const openSales = useMemo(() => sales.filter(isFinancialSale), [sales]);

  // Filter by customer BEFORE the lists are sliced to what is shown.
  const anchorKey = anchor ? mergeCandidateKey(anchor) : null;
  const bookingRows = useMemo(
    () =>
      orderCandidates(
        openBookings.map((b) => ({ ...b, name: b.customer_name })),
        anchorKey,
        !allCustomers,
      ),
    [openBookings, anchorKey, allCustomers],
  );
  const saleRows = useMemo(
    () =>
      orderCandidates(
        openSales.map((s) => ({ ...s, name: s.customer_name, phone: null })),
        anchorKey,
        !allCustomers,
      ),
    [openSales, anchorKey, allCustomers],
  );

  const pickedBookings = useMemo(
    () => openBookings.filter((b) => turfIds.includes(b.id)),
    [openBookings, turfIds],
  );
  const pickedSales = useMemo(
    () => openSales.filter((s) => snackIds.includes(s.id)),
    [openSales, snackIds],
  );

  const customersPicked = useMemo(
    () =>
      distinctMergeCustomers([
        ...pickedBookings.map((b) => ({
          name: b.customer_name,
          phone: b.phone,
        })),
        ...pickedSales.map((s) => ({ name: s.customer_name, phone: null })),
      ]),
    [pickedBookings, pickedSales],
  );
  // Name/phone used when the owner types nothing: the first ticked item's.
  const resolved = useMemo(
    () =>
      resolveMergeCustomer({ name, phone }, [
        ...(anchor ? [anchor] : []),
        ...pickedBookings.map((b) => ({
          name: b.customer_name,
          phone: b.phone,
        })),
        ...pickedSales.map((s) => ({ name: s.customer_name, phone: null })),
      ]),
    [name, phone, anchor, pickedBookings, pickedSales],
  );

  // All the item-building + subtotal/discount/total math lives in
  // lib/merge.ts and is shared with the actual save (mergeIntoBill), so this
  // preview can never disagree with what gets written.
  const {
    items,
    subtotal: grossTotal,
    discount: mergedDiscount,
    total,
  } = useMemo(
    () => buildMergedItems(pickedBookings, pickedSales),
    [pickedBookings, pickedSales],
  );

  const preview = useMemo(
    () =>
      previewMerge({
        total,
        bookings: pickedBookings.map((b) => ({
          id: b.id,
          advance_paid: Number(b.advance_paid) || 0,
          payment_mode: b.payment_mode,
          booking_date: b.booking_date,
        })),
        sales: pickedSales.map((s) => ({
          id: s.id,
          total: Number(s.total) || 0,
          payment_mode: s.payment_mode,
          sale_date: s.sale_date,
          tax_amount: s.tax_amount,
          tax_lines: s.tax_lines,
        })),
        tabEntries,
        payments,
      }),
    [total, pickedBookings, pickedSales, tabEntries, payments],
  );

  const reset = () => {
    setName("");
    setPhone("");
    setTurfIds([]);
    setSnackIds([]);
    setDueMode("pending");
    setDraft(EMPTY_DRAFT);
    setTurfShown(5);
    setSnackShown(5);
    setAnchor(null);
    setAllCustomers(false);
    setSaving(false);
  };

  const save = async () => {
    if (items.length === 0) {
      toast.error("Select at least one turf booking or snack bill");
      return;
    }
    // A pending merge needs no money and no typed name. "Paid" must say how
    // much was received now, or the owner should pick Pending instead.
    let received: ReturnType<typeof planSplit> | null = null;
    if (dueMode === "paid" && preview.outstanding > 0) {
      received = planSplit(preview.outstanding, draft);
      if (!received.ok || received.total <= 0) {
        toast.error(
          received.ok || received.total > 0
            ? "Enter the amount received now, or choose Pending"
            : received.error,
        );
        return;
      }
    }
    setSaving(true);
    try {
      const bill = await mergeIntoBill({
        name: resolved.name,
        phone: resolved.phone,
        bookingIds: pickedBookings.map((b) => b.id),
        saleIds: pickedSales.map((s) => s.id),
        items,
        subtotal: grossTotal,
        discount: mergedDiscount,
        total,
        dueMode,
      });
      let paidNow = 0;
      let payError = "";
      if (received?.ok) {
        try {
          await collectBillPayment({ bill, entries: received.entries });
          paidNow = received.total;
        } catch (e) {
          payError = errorMessage(e);
        }
      }
      for (const key of [
        "bills",
        "turf_bookings",
        "snack_sales",
        "tab_entries",
        "customer_tabs",
        "payments",
      ])
        qc.invalidateQueries({ queryKey: [key] });
      const stillOwed = Math.max(0, preview.outstanding - paidNow);
      if (payError)
        toast.error(
          `Bill ${bill.invoice_no} saved as Pending ${money(preview.outstanding)}, but the payment was not recorded: ${payError}`,
        );
      else
        toast.success(
          stillOwed > 0
            ? `Bill ${bill.invoice_no} saved \u00b7 Pending ${money(stillOwed)}`
            : `Bill ${bill.invoice_no} saved \u00b7 fully paid`,
        );
      if (printSettings.autoPrint) printBillPdf(bill, INVOICE_SECTIONS.merged);
      setOpen(false);
      reset();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Start every merge from a clean sheet: leftover name/phone and ticked
        // bookings from an abandoned merge would otherwise be silently reused.
        if (next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="h-12 w-full">
          <Merge className="size-4" /> Merge turf + snacks bill
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge into one bill</DialogTitle>
        </DialogHeader>

        <LayoutParts surfaceId="surface.merge-bill" className="space-y-4">
          <LayoutPart id="surface.merge-bill.explainer">
            <DialogDescription>
              Pick turf bookings and snack bills, then generate a single bill
              saved here. Nothing has to be paid first: choose Pending and the
              customer pays later.
            </DialogDescription>
          </LayoutPart>
          <LayoutPart id="surface.merge-bill.customer">
            <CustomerFields
              name={name}
              phone={phone}
              onChange={({ name: n, phone: p }) => {
                setName(n);
                setPhone(p);
              }}
            />
          </LayoutPart>
          <LayoutPart id="surface.merge-bill.candidates">
            <div className="space-y-4">
              {anchor && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={allCustomers}
                    onCheckedChange={(v) => setAllCustomers(Boolean(v))}
                  />
                  Show every customer, not only {anchor.name || "this customer"}
                </label>
              )}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Turf bookings
                </Label>
                {bookingRows.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Nothing left to merge.
                  </p>
                )}
                {bookingRows.slice(0, turfShown).map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={turfIds.includes(b.id)}
                      onCheckedChange={() =>
                        toggle(turfIds, setTurfIds, b.id, {
                          name: b.customer_name,
                          phone: b.phone,
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {b.booking_no} · {b.customer_name} ·{" "}
                      {formatDMY(b.booking_date)}
                    </span>
                    <span className="font-medium">{money(b.total_amount)}</span>
                  </label>
                ))}
                {bookingRows.length > turfShown && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setTurfShown((n) => n + 5)}
                  >
                    Show 5 more bookings
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Snack bills
                </Label>
                {saleRows.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Nothing left to merge.
                  </p>
                )}
                {saleRows.slice(0, snackShown).map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={snackIds.includes(s.id)}
                      onCheckedChange={() =>
                        toggle(snackIds, setSnackIds, s.id, {
                          name: s.customer_name,
                          phone: null,
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {s.bill_no}
                      {s.customer_name ? ` · ${s.customer_name}` : ""} ·{" "}
                      {formatDMY(s.sale_date)}
                    </span>
                    <span className="font-medium">{money(s.total)}</span>
                  </label>
                ))}
                {saleRows.length > snackShown && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setSnackShown((n) => n + 5)}
                  >
                    Show 5 more snack bills
                  </Button>
                )}
              </div>
            </div>
          </LayoutPart>
          <LayoutPart id="surface.merge-bill.warning">
            {customersPicked.length > 1 && (
              <p
                role="alert"
                className="rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                These belong to different customers (
                {customersPicked.map((c) => c.name).join(", ")}). One bill goes
                to one customer, so untick the others unless that is intended.
              </p>
            )}
          </LayoutPart>
          <LayoutPart id="surface.merge-bill.due-mode">
            <div className="space-y-3 rounded-2xl border p-3">
              <Label className="text-sm font-medium">Generate bill as</Label>
              <RadioGroup
                value={dueMode}
                onValueChange={(v) => setDueMode(v as "pending" | "paid")}
                className="gap-2"
              >
                <div className="flex items-start gap-2 text-sm">
                  <RadioGroupItem
                    id="merge-due-pending"
                    value="pending"
                    className="mt-0.5"
                  />
                  <label htmlFor="merge-due-pending" className="flex-1">
                    Pending (customer pays later)
                    <span className="block text-xs text-muted-foreground">
                      An UNPAID invoice. Only money already collected on the
                      bookings and bills counts as paid; the rest shows once as
                      Pending in Outstanding.
                    </span>
                  </label>
                </div>
                <div className="flex items-start gap-2 text-sm">
                  <RadioGroupItem
                    id="merge-due-paid"
                    value="paid"
                    className="mt-0.5"
                  />
                  <label htmlFor="merge-due-paid" className="flex-1">
                    Paid / partly paid
                    <span className="block text-xs text-muted-foreground">
                      The customer pays now. Enter what was received.
                    </span>
                  </label>
                </div>
              </RadioGroup>
              {dueMode === "paid" && preview.outstanding > 0 && (
                <SplitPaymentFields
                  due={preview.outstanding}
                  value={draft}
                  onChange={setDraft}
                />
              )}
            </div>
          </LayoutPart>
          <LayoutPart id="surface.merge-bill.preview">
            {items.length > 0 && (
              <p className="rounded-2xl border p-3 text-xs text-muted-foreground">
                Bill for {resolved.name} · {money(preview.total)} total ·{" "}
                {money(preview.collected)} already collected
                {preview.turfBalance > 0 && (
                  <>
                    {" "}
                    (turf advance {money(preview.turfAdvance)}
                    {preview.turfAdvanceSplit
                      ? ` [${preview.turfAdvanceSplit}]`
                      : ""}{" "}
                    + turf balance {money(preview.turfBalance)}
                    {preview.turfBalanceSplit
                      ? ` [${preview.turfBalanceSplit}]`
                      : ""}
                    )
                  </>
                )}
                {preview.received.total > 0 && (
                  <>
                    {" "}
                    (Cash {money(preview.received.cash)} · Online{" "}
                    {money(preview.received.online)}
                    {preview.received.split
                      ? ` · Split ${preview.received.split}`
                      : ""}
                    )
                  </>
                )}{" "}
                · Pending {money(preview.outstanding)}
                {preview.alreadyOnTab > 0 && (
                  <>
                    {" "}
                    · {money(preview.alreadyOnTab)} of it was on the tab and
                    moves onto this bill
                  </>
                )}
              </p>
            )}
          </LayoutPart>
          <LayoutPart id="surface.merge-bill.actions">
            <DialogFooter>
              <Button className="h-12 w-full" onClick={save} disabled={saving}>
                <ReceiptText className="size-5" /> Generate bill ·{" "}
                {money(total)}
              </Button>
            </DialogFooter>
          </LayoutPart>
        </LayoutParts>
      </DialogContent>
    </Dialog>
  );
}
