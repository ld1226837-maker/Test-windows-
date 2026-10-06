import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Paperclip,
  X,
  FileText,
  Pencil,
  Plus,
  Search,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  RotateCw,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { moneyDecimal, cleanAmountInput, decimalRupees } from "@/lib/money";
import { formatDMY } from "@/lib/biz";
import {
  useDeleteInvestment,
  useInvestmentTotals,
  useInvestments,
  useSaveInvestment,
  investmentInvoice,
  investmentReceiptDoc,
  addInvestmentPhoto,
  exportInvestmentsToExcel,
  sortInvestments,
  INVESTMENT_CATEGORIES,
  INVESTMENT_PAYMENT_MODES,
  type InvestmentSortDirection,
  type InvestmentSortKey,
} from "@/lib/investments";
import { deleteReceipt, openReceipt, receiptPreviewUrl } from "@/lib/expenses";
import type { InvestmentRow } from "@/lib/localdb";
import { localDateStr, errorMessage } from "@/lib/utils";
import { INVOICE_SECTIONS, isAndroid, saveExportFile } from "@/lib/desktop";
import { readReceiptBytes } from "@/lib/receipt-storage";
import {
  LayoutPart,
  LayoutParts,
  LayoutSection,
  LayoutSections,
} from "./LayoutSection";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { InvestmentActions } from "./InvestmentActions";

const MAX_PHOTO_MB = 10;

/** One investment row. Memoized so typing in the add/edit form (or moving a
 * filter) doesn't re-render every visible row — only rows whose data or
 * handlers actually changed. */
const InvestmentListRow = memo(function InvestmentListRow({
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
  return (
    <div className="flex flex-col gap-2 border-b py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="min-w-0 sm:flex-1">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          <span className="font-mono text-xs">
            {r.bill_no || "No bill number"}
          </span>
          <span>·</span>
          <span>{moneyDecimal(r.amount)}</span>
          <span>·</span>
          <span>{r.note || "Business investment"}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatDMY(r.investment_date.slice(0, 10))} · {r.category || "—"} ·{" "}
          {r.payment_mode || "—"}
          {r.receipt_path ? " · receipt attached" : ""}
        </div>
      </div>
      <InvestmentActions
        r={r}
        onEdit={onEdit}
        onShowReceipt={onShowReceipt}
        onDelete={onDelete}
      />
    </div>
  );
});
export function InvestmentsTab() {
  const { data = [] } = useInvestments();
  const totals = useInvestmentTotals();
  const save = useSaveInvestment();
  const del = useDeleteInvestment();
  const [editing, setEditing] = useState<Partial<InvestmentRow> | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(localDateStr());
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState("");
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [viewerInvestmentId, setViewerInvestmentId] = useState<string | null>(
    null,
  );
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [limit, setLimit] = useState(100);
  const [sortKey, setSortKey] = useState<InvestmentSortKey>("date");
  const [sortDir, setSortDir] = useState<InvestmentSortDirection>("desc");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterMode, setFilterMode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [viewerBillNo, setViewerBillNo] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  useEffect(
    () => () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    },
    [photoUrl],
  );
  const [pickAfterOpen, setPickAfterOpen] = useState(false);
  // "Replace" in the receipt viewer opens the form first; the hidden file
  // input only exists once the form dialog has mounted, so open the picker
  // from an effect + frame instead of a bare setTimeout.
  useEffect(() => {
    if (!formOpen || !pickAfterOpen) return;
    setPickAfterOpen(false);
    const id = requestAnimationFrame(() => inputRef.current?.click());
    return () => cancelAnimationFrame(id);
  }, [formOpen, pickAfterOpen]);
  const reset = () => {
    setEditing(null);
    setAmount("");
    setDate(localDateStr());
    setCategory("");
    setNote("");
    setMode("");
    setReceiptPath(null);
    setPhoto(null);
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(null);
  };
  const openNew = () => {
    reset();
    setFormOpen(true);
  };
  const openEdit = (r: InvestmentRow) => {
    reset();
    setEditing(r);
    setAmount(String(r.amount));
    setDate(r.investment_date);
    setCategory(r.category || "");
    setNote(r.note || "");
    setMode(r.payment_mode || "");
    setReceiptPath(r.receipt_path ?? null);
    setFormOpen(true);
  };
  const choosePhoto = (f: File) => {
    if (f.size > MAX_PHOTO_MB * 1024 * 1024) {
      toast.error(`Receipt photo must be ${MAX_PHOTO_MB} MB or smaller.`);
      return;
    }
    if (!f.type.startsWith("image/")) {
      toast.error("Please choose an image receipt.");
      return;
    }
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhoto(f);
    setPhotoUrl(URL.createObjectURL(f));
  };
  const submit = async () => {
    let uploadedPath: string | null = null;
    try {
      const parsed = decimalRupees(amount);
      if (!category) throw new Error("Category is required");
      if (!mode) throw new Error("Payment method is required");
      let path = receiptPath;
      if (photo) {
        setUploading(true);
        path = await addInvestmentPhoto(photo, date);
        uploadedPath = path;
        setReceiptPath(path);
      }
      const row = await save.mutateAsync({
        ...(editing?.id ? { id: editing.id } : {}),
        amount: parsed,
        investment_date: date,
        note: note.trim() || null,
        category,
        payment_mode: mode,
        receipt_path: path ?? null,
      });
      if (
        photo &&
        path &&
        editing?.receipt_path &&
        editing.receipt_path !== path
      )
        await deleteReceipt(editing.receipt_path);
      uploadedPath = null;
      setFormOpen(false);
      reset();
      toast.success(`Investment ${row.bill_no} saved`);
    } catch (e) {
      if (uploadedPath) await deleteReceipt(uploadedPath).catch(() => {});
      toast.error(errorMessage(e, "Could not save investment"));
    } finally {
      setUploading(false);
    }
  };
  const categoryOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...INVESTMENT_CATEGORIES,
          ...data.map((r) => r.category).filter((x): x is string => !!x),
        ]),
      ).sort(),
    [data],
  );
  const paymentOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...INVESTMENT_PAYMENT_MODES,
          ...data.map((r) => r.payment_mode).filter((x): x is string => !!x),
        ]),
      ).sort(),
    [data],
  );
  // Stable handler identities for the memoized rows. The latest closures are
  // kept in a ref (updated after every render) so the callbacks themselves
  // never change and rows only re-render when their own data changes.
  const rowHandlers = useRef({
    edit: (_r: InvestmentRow) => {},
    receipt: (_r: InvestmentRow) => {},
    remove: (_r: InvestmentRow) => {},
  });
  useEffect(() => {
    rowHandlers.current = {
      edit: openEdit,
      receipt: (r) =>
        void showReceipt(r.receipt_path as string, r.bill_no || "", r.id),
      remove: (r) => del.mutate(r),
    };
  });
  const onEditRow = useCallback(
    (r: InvestmentRow) => rowHandlers.current.edit(r),
    [],
  );
  const onShowReceiptRow = useCallback(
    (r: InvestmentRow) => rowHandlers.current.receipt(r),
    [],
  );
  const onDeleteRow = useCallback(
    (r: InvestmentRow) => rowHandlers.current.remove(r),
    [],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const f = data.filter(
      (r) =>
        (!q ||
          [r.bill_no, r.note, r.category, r.payment_mode, r.id].some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(q),
          )) &&
        (!from || r.investment_date >= from) &&
        (!to || r.investment_date <= to) &&
        (!minAmount || r.amount >= Number(minAmount)) &&
        (!maxAmount || r.amount <= Number(maxAmount)) &&
        (!filterCategory || r.category === filterCategory) &&
        (!filterMode || r.payment_mode === filterMode),
    );
    return sortInvestments(f, sortKey, sortDir);
  }, [
    data,
    search,
    from,
    to,
    minAmount,
    maxAmount,
    filterCategory,
    filterMode,
    sortKey,
    sortDir,
  ]);
  const hasFilters = !!(
    search ||
    from ||
    to ||
    minAmount ||
    maxAmount ||
    filterCategory ||
    filterMode
  );
  const clearFilters = () => {
    setSearch("");
    setFrom("");
    setTo("");
    setMinAmount("");
    setMaxAmount("");
    setFilterCategory("");
    setFilterMode("");
  };
  const showReceipt = async (
    path: string,
    billNo = "",
    investmentId: string | null = null,
  ) => {
    try {
      const url = await receiptPreviewUrl(path);
      if (!url)
        throw new Error(
          "Investment receipt photo is unavailable on this device.",
        );
      setViewer(url);
      setViewerPath(path);
      setViewerBillNo(billNo);
      setViewerInvestmentId(investmentId);
      setZoom(1);
      setRotation(0);
    } catch (e) {
      toast.error(errorMessage(e, "Could not open receipt"));
    }
  };
  const closeViewer = () => {
    if (viewer) URL.revokeObjectURL(viewer);
    setViewer(null);
    setViewerPath(null);
    setViewerInvestmentId(null);
    setViewerBillNo("");
    setZoom(1);
    setRotation(0);
  };
  const activeExport = filtered.slice() as InvestmentRow[];
  return (
    <div className="space-y-6">
      <LayoutSections tabId="investments" className="space-y-6">
        <LayoutSection id="investments.summary">
          <Card>
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>Investments</CardTitle>
              <LayoutParts
                sectionId="investments.summary"
                className="flex min-w-0 max-w-full flex-wrap gap-2"
              >
                <LayoutPart id="investments.summary.export">
                  <Button
                    variant="outline"
                    onClick={() => void exportInvestmentsToExcel(activeExport)}
                  >
                    <Download className="mr-1 size-4" />
                    Export Excel
                  </Button>
                </LayoutPart>
                <LayoutPart id="investments.summary.add">
                  <Button onClick={openNew}>
                    <Plus className="mr-1 size-4" />
                    Add investment
                  </Button>
                </LayoutPart>
              </LayoutParts>
            </CardHeader>
            <CardContent className="space-y-4">
              <LayoutPart id="investments.summary.total">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border p-3">
                    <div className="micro-label">Selected period</div>
                    <div className="stat-value">
                      {moneyDecimal(totals.period)}
                    </div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="micro-label">All time</div>
                    <div className="stat-value">
                      {moneyDecimal(totals.allTime)}
                    </div>
                  </div>
                </div>
              </LayoutPart>
              <div className="rounded-xl border p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <Search className="size-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search bill number or purpose"
                    aria-label="Search bill number or purpose"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={clearFilters}
                    disabled={!hasFilters}
                  >
                    <RotateCcw className="mr-1 size-3" />
                    Reset
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="grid gap-1">
                    <Label htmlFor="inv-f-from-date">From date</Label>
                    <Input
                      id="inv-f-from-date"
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="inv-f-to-date">To date</Label>
                    <Input
                      id="inv-f-to-date"
                      type="date"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="inv-f-minimum-amount">Minimum amount</Label>
                    <Input
                      id="inv-f-minimum-amount"
                      inputMode="decimal"
                      value={minAmount}
                      onChange={(e) =>
                        setMinAmount(cleanAmountInput(e.target.value))
                      }
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="inv-f-maximum-amount">Maximum amount</Label>
                    <Input
                      id="inv-f-maximum-amount"
                      inputMode="decimal"
                      value={maxAmount}
                      onChange={(e) =>
                        setMaxAmount(cleanAmountInput(e.target.value))
                      }
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="inv-f-category">Category</Label>
                    <select
                      id="inv-f-category"
                      className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
                      value={filterCategory}
                      onChange={(e) => setFilterCategory(e.target.value)}
                    >
                      <option value="">All categories</option>
                      {categoryOptions.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="inv-f-payment-method">Payment method</Label>
                    <select
                      id="inv-f-payment-method"
                      className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
                      value={filterMode}
                      onChange={(e) => setFilterMode(e.target.value)}
                    >
                      <option value="">All methods</option>
                      {paymentOptions.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="inv-f-sort-by">Sort by</Label>
                    <select
                      id="inv-f-sort-by"
                      className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
                      value={sortKey}
                      onChange={(e) =>
                        setSortKey(e.target.value as InvestmentSortKey)
                      }
                    >
                      <option value="date">Date</option>
                      <option value="amount">Amount</option>
                      <option value="category">Category</option>
                      <option value="payment_mode">Payment method</option>
                      <option value="bill_no">Bill number</option>
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label id="inv-f-order">Order</Label>
                    <Button
                      aria-labelledby="inv-f-order"
                      variant="outline"
                      onClick={() =>
                        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
                      }
                    >
                      {sortDir === "asc" ? "Ascending ↑" : "Descending ↓"}
                    </Button>
                  </div>
                </div>
                {hasFilters ? (
                  <div className="text-xs text-muted-foreground">
                    Active filters · {filtered.length} matching investment
                    {filtered.length === 1 ? "" : "s"}
                  </div>
                ) : null}
              </div>
              <LayoutPart id="investments.summary.list" className="space-y-4">
                {filtered.slice(0, limit).map((r) => (
                  <InvestmentListRow
                    key={r.id}
                    r={r}
                    onEdit={onEditRow}
                    onShowReceipt={onShowReceiptRow}
                    onDelete={onDeleteRow}
                  />
                ))}

                {filtered.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No investments match the current filters.
                  </p>
                ) : null}
                {filtered.length > limit ? (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setLimit((n) => n + 100)}
                  >
                    Show 100 more investments
                  </Button>
                ) : null}
              </LayoutPart>
            </CardContent>
          </Card>
        </LayoutSection>
      </LayoutSections>
      <Dialog
        open={formOpen}
        onOpenChange={(v) => {
          setFormOpen(v);
          if (!v) reset();
        }}
      >
        <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0">
          <DialogHeader className="border-b px-5 pb-3 pt-5">
            <DialogTitle>
              {editing?.id ? "Edit investment" : "Add investment"}
            </DialogTitle>
            <DialogDescription>
              Bill number is generated once and stays stable even if the
              investment date is edited.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="inv-d-bill-number">Bill number</Label>
                <Input
                  id="inv-d-bill-number"
                  value={editing?.bill_no || "Generated on save"}
                  readOnly
                  className="bg-muted"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inv-d-amount">Amount</Label>
                <Input
                  id="inv-d-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(cleanAmountInput(e.target.value))}
                  placeholder="0.00"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inv-d-investment-date">Investment date</Label>
                <Input
                  id="inv-d-investment-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inv-d-category-purpose-type">
                  Category / purpose type
                </Label>
                <select
                  id="inv-d-category-purpose-type"
                  className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">Select category</option>
                  {INVESTMENT_CATEGORIES.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                  {category &&
                  !(INVESTMENT_CATEGORIES as readonly string[]).includes(
                    category,
                  ) ? (
                    <option value={category}>{category} (existing)</option>
                  ) : null}
                </select>
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="inv-d-purpose-details">Purpose / details</Label>
                <Textarea
                  id="inv-d-purpose-details"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What was this investment for?"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="inv-d-payment-method">Payment method</Label>
                <select
                  id="inv-d-payment-method"
                  className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="">Select payment method</option>
                  {INVESTMENT_PAYMENT_MODES.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                  {mode &&
                  !(INVESTMENT_PAYMENT_MODES as readonly string[]).includes(
                    mode,
                  ) ? (
                    <option value={mode}>{mode} (existing)</option>
                  ) : null}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label>Receipt photo</Label>
                <input
                  id="inv-d-receipt-photo"
                  ref={inputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) choosePhoto(f);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => inputRef.current?.click()}
                >
                  <Paperclip className="mr-2 size-4" />
                  Choose photo
                </Button>
              </div>
              <div className="sm:col-span-2">
                {photoUrl ? (
                  <div className="flex items-center gap-3 rounded-lg border p-2">
                    <img
                      src={photoUrl}
                      alt="Selected receipt thumbnail"
                      className="size-20 rounded object-cover"
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="truncate font-medium">{photo?.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Ready to attach ·{" "}
                        {photo ? Math.round(photo.size / 1024) : 0} KB
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Remove selected photo"
                      aria-label="Remove selected photo"
                      onClick={() => {
                        if (photoUrl) URL.revokeObjectURL(photoUrl);
                        setPhotoUrl(null);
                        setPhoto(null);
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : receiptPath ? (
                  <div className="flex items-center gap-3 rounded-lg border p-2">
                    <div className="size-20 overflow-hidden rounded bg-muted">
                      <ReceiptThumb path={receiptPath} />
                    </div>
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">Receipt attached</div>
                      <div className="text-xs text-muted-foreground">
                        {receiptPath}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void showReceipt(
                          receiptPath,
                          editing?.bill_no || "",
                          editing?.id || null,
                        )
                      }
                    >
                      View
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Replace receipt"
                      aria-label="Replace receipt"
                      onClick={() => inputRef.current?.click()}
                    >
                      <Paperclip className="size-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Remove receipt"
                          aria-label="Remove receipt"
                        >
                          <X className="size-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove receipt?</AlertDialogTitle>
                          <AlertDialogDescription>
                            The attached receipt photo will be removed from this
                            investment. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => {
                              setReceiptPath(null);
                            }}
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                    No receipt attached. Images are validated and limited to{" "}
                    {MAX_PHOTO_MB} MB.
                  </div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter className="border-t bg-background px-5 py-3">
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={save.isPending || uploading}
            >
              {uploading
                ? "Uploading…"
                : save.isPending
                  ? "Saving…"
                  : editing?.id
                    ? "Save changes"
                    : "Save investment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!viewer} onOpenChange={(v) => !v && closeViewer()}>
        <DialogContent className="max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle>
              Investment receipt {viewerBillNo ? `· ${viewerBillNo}` : ""}
            </DialogTitle>
            <DialogDescription>
              Zoom, pan, rotate, replace, remove, and use the platform viewer or
              Downloads flow.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 overflow-auto bg-muted/30 p-4">
            <img
              src={viewer || ""}
              alt={`Investment receipt ${viewerBillNo}`}
              className="m-auto max-w-none object-contain transition-transform"
              style={{
                // Zoom by size (not transform: scale) so the scroll area
                // grows with the image and every edge can be panned to;
                // `m-auto` centres it only while it still fits.
                width: `${zoom * 100}%`,
                maxHeight: zoom === 1 ? "60dvh" : undefined,
                transform: `rotate(${rotation}deg)`,
              }}
            />
          </div>
          <DialogFooter className="flex-row flex-wrap justify-end gap-2 border-t px-4 py-3 sm:space-x-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
            >
              <ZoomIn className="mr-1 size-4" />
              Zoom in
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
            >
              <ZoomOut className="mr-1 size-4" />
              Zoom out
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRotation((r) => r + 90)}
            >
              <RotateCw className="mr-1 size-4" />
              Rotate
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (viewerPath)
                  void openReceipt(viewerPath).catch((e) =>
                    toast.error(errorMessage(e)),
                  );
              }}
            >
              <ExternalLink className="mr-1 size-4" />
              Open with device
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (viewerPath)
                  void readReceiptBytes(viewerPath)
                    .then(async (b) => {
                      if (!b) throw new Error("Receipt is unavailable");
                      const bb = b as Uint8Array<ArrayBuffer>;
                      if (isAndroid()) {
                        await saveExportFile(
                          bb,
                          viewerPath.split("/").pop() ||
                            "investment-receipt.jpg",
                          "image/jpeg",
                        );
                        return;
                      }
                      await openReceipt(viewerPath);
                    })
                    .catch((e) => toast.error(errorMessage(e)));
              }}
            >
              Download
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const row = viewerInvestmentId
                  ? data.find((x) => x.id === viewerInvestmentId)
                  : null;
                if (row) {
                  openEdit(row);
                  setReceiptPath(null);
                }
                closeViewer();
              }}
            >
              <X className="mr-1 size-4" />
              Remove
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const row = viewerInvestmentId
                  ? data.find((x) => x.id === viewerInvestmentId)
                  : null;
                closeViewer();
                if (row) {
                  openEdit(row);
                  setPickAfterOpen(true);
                }
              }}
            >
              <Paperclip className="mr-1 size-4" />
              Replace
            </Button>
            <Button onClick={closeViewer}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function ReceiptThumb({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    void receiptPreviewUrl(path).then((x) => {
      created = x;
      if (alive) setUrl(x);
      else if (x) URL.revokeObjectURL(x);
    });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [path]);
  return url ? (
    <img src={url} alt="Receipt thumbnail" className="size-full object-cover" />
  ) : (
    <div className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
      Unavailable
    </div>
  );
}
