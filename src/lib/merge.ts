/**
 * Merging turf bookings + snack sales into ONE bill, and putting everything
 * back when that bill is un-merged or deleted.
 *
 * The whole merge is a single Dexie transaction: the bill row, the
 * merged_into_bill_id flags and every ledger write land together or not at
 * all, so a failure can never leave a half-reversed tab.
 *
 * Money rules (see lib/dues.ts for the read side):
 * - Each source's *net remaining* tab charge is reversed against the exact
 *   amount that source put on the tab (never capped at the live tab balance),
 *   tagged `merge_reverse` + the source ref so it can be put back exactly.
 * - When "on tab" is ticked the merged bill posts ONE charge for the whole
 *   outstanding amount. Net effect on the tab is `outstanding - alreadyOnTab`,
 *   but as two traceable rows instead of one silently netted figure.
 * - The bill's `amount_paid` is what was actually COLLECTED on the sources —
 *   an "On tab" bill is not revenue received.
 */

import {
  hasCustomNumbering,
  nextCustomInvoiceNo,
  readAppSettings,
  taxBreakdown,
} from "./settings";
import {
  billGrossTotal,
  snackSaleGrossTotal,
  type Bill,
  type BillItem,
  type BillStatus,
  type Unit,
} from "./biz";
import { storedTurfAmount } from "./courts";
import { billCollected, bookingCashCollected, netTabAmountFor } from "./dues";
import { rupees } from "./money";
import type { MergedBreakdown } from "./merge-breakdown";
import {
  db,
  newId,
  nextInvoiceNo,
  nowIso,
  type BillRow,
  type PaymentRow,
  type SnackSaleRow,
  type TabEntryRow,
  type TurfBookingRow,
} from "./localdb";
import {
  TAB_PAYMENT_MODE,
  applySnackStockDelta,
  type SnackSaleItem,
  type SnackStockChange,
} from "./ops";
import { pendingAmount } from "./bill-state";
import { isCancelled, refundPatch, type MoneyDecision } from "./record-state";
import {
  effectivePaymentEntries,
  firstBatchRows,
  normalizeReceivedPaymentMode,
  removePaymentsForParents,
  type EffectivePaymentEntry,
} from "./payments";
import { modeBreakdown, type ModeBreakdown } from "./payment-breakdown";
import {
  TAB_REF_BILL,
  TAB_REF_MERGE_REVERSE,
  TAB_REF_SNACK_SALE,
  TAB_REF_TURF_BOOKING,
  tabKey,
  writeTabEntries,
  type TabEntry,
  type AddTabEntryInput,
} from "./tabs";

const num = (v: unknown) => Number(v) || 0;
/** Merged bills are whole rupees like every other amount (lib/money.ts). */
const round2 = rupees;

export type MergeInput = {
  name: string;
  phone: string | null;
  bookingIds: string[];
  saleIds: string[];
  items: BillItem[];
  subtotal: number;
  discount: number;
  total: number;
  /** Legacy switch: post the whole outstanding amount as ONE charge on the
   * customer's running tab instead of leaving it on the bill. Ignored when
   * `dueMode` is given. */
  putOnTab?: boolean;
  /**
   * What the owner chose in the dialog.
   * - "pending": generate the invoice with nothing more collected; the due
   *   stays on the BILL (status unpaid/partial) and shows in Outstanding once.
   * - "paid": same write; the dialog then records the money received now
   *   through collectBillPayment, so the receipt rows are the normal ones.
   * Either way the due lives in exactly one place (the bill).
   */
  dueMode?: "pending" | "paid";
};

/** Name used when neither the owner nor any picked record has one. */
export const WALK_IN_NAME = "Walk-in customer";

type CustomerHint = { name?: string | null; phone?: string | null };

/**
 * The customer a merged bill is issued to. What the owner typed wins; any
 * blank part is taken from the FIRST picked record that has a name or phone
 * (both from the same record, so a name is never paired with another
 * customer's number); no name anywhere falls back to "Walk-in customer".
 * Pure, shared by the dialog and mergeIntoBill.
 */
export function resolveMergeCustomer(
  typed: CustomerHint,
  picked: readonly CustomerHint[],
): { name: string; phone: string | null } {
  const first = picked.find((p) => p.name?.trim() || p.phone?.trim());
  const name = typed.name?.trim() || first?.name?.trim() || WALK_IN_NAME;
  const phone = typed.phone?.trim() || first?.phone?.trim() || null;
  return { name, phone };
}

/** True for a record that carries no customer identity at all. */
export const isNamelessCandidate = (c: CustomerHint) =>
  !c.name?.trim() && !(c.phone ?? "").replace(/\D/g, "");

/** Customer identity of a candidate: phone first, then name (lib/tabs.ts). */
export const mergeCandidateKey = (c: CustomerHint) =>
  tabKey(c.name ?? "", c.phone ?? null);

/**
 * Distinct customers among the picked records, in pick order. More than one
 * means the owner mixed two customers onto one bill (the dialog warns).
 */
export function distinctMergeCustomers(
  picked: readonly CustomerHint[],
): { key: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const c of picked) {
    // A record with no name and no phone belongs to nobody: it never counts
    // as a second customer.
    if (isNamelessCandidate(c)) continue;
    const key = mergeCandidateKey(c);
    if (!seen.has(key)) seen.set(key, c.name?.trim() || WALK_IN_NAME);
  }
  return [...seen].map(([key, name]) => ({ key, name }));
}

/**
 * Filter THEN order candidates: the anchor customer's records first (most
 * recent first is kept from the input order), everyone else after. With no
 * anchor the list is returned untouched. Filtering before sorting keeps the
 * cost proportional to the visible customer, not the whole year.
 */
export function orderCandidates<T extends CustomerHint>(
  rows: readonly T[],
  anchorKey: string | null,
  onlyAnchor: boolean,
): T[] {
  if (!anchorKey) return [...rows];
  // A nameless record (a snack sale without a customer) cannot belong to
  // anyone else, so it stays with the anchor customer's candidates.
  const isMine = (r: T) =>
    isNamelessCandidate(r) || mergeCandidateKey(r) === anchorKey;
  const mine = rows.filter(isMine);
  if (onlyAnchor) return mine;
  const others = rows.filter((r) => !isMine(r));
  return [...mine, ...others];
}

export type MergePreview = {
  total: number;
  /** Money already received on the selected sources (advances, paid sales). */
  collected: number;
  /** Net amount those sources already put on the customer's tab. */
  alreadyOnTab: number;
  /** Still owed after the collections above. */
  outstanding: number;
  /** What the tab balance changes by when "on tab" is ticked. */
  tabDelta: number;
  /** How the already-collected money was received: Cash, Online and the
   * split text. Display only — derived from the same payment rows that
   * mergeIntoBill carries onto the bill, so preview and save agree. */
  received: ModeBreakdown;
  /** Of the turf money already collected: the advance (first collection) and
   * the balance paid after it, with each one's Cash / UPI split text. Display
   * only; `turfBalance` is 0 when there was no later payment. */
  turfAdvance: number;
  turfBalance: number;
  turfAdvanceSplit: string;
  turfBalanceSplit: string;
};

type Source =
  | {
      kind: typeof TAB_REF_TURF_BOOKING;
      id: string;
      label: string;
      collected: number;
    }
  | {
      kind: typeof TAB_REF_SNACK_SALE;
      id: string;
      label: string;
      collected: number;
    };

/**
 * Real cash collected on a booking — NOT just `advance_paid` at face value.
 *
 * "Put balance on tab" (TurfTab.tsx) zeroes out a booking's own due by
 * setting `advance_paid` to the FULL `total_amount`, even though only part of
 * that was ever collected in cash — the rest is a charge sitting on the
 * customer's tab. Reading `advance_paid` alone here would count that tab
 * charge as cash TWICE: once as "collected" and again as "already on tab",
 * making `outstanding` (and therefore the merged bill's status/amount_paid)
 * understate — or even zero out — a real due. Subtracting `onTab` undoes
 * exactly that inflation and leaves the genuine cash figure, whether it came
 * from the original advance or from later tab payments.
 */
const bookingCollected = (
  b: Pick<TurfBookingRow, "advance_paid">,
  onTab: number,
) => Math.max(0, num(b.advance_paid) - onTab);
const saleCollected = (
  s: Pick<SnackSaleRow, "payment_mode" | "total" | "tax_amount" | "tax_lines">,
) => (s.payment_mode === TAB_PAYMENT_MODE ? 0 : snackSaleGrossTotal(s));

/** Shared money math, used by both the dialog preview and the merge itself. */
export function mergeMath(
  total: number,
  sources: { collected: number; onTab: number }[],
): MergePreview {
  const collectedRaw = sources.reduce((s, x) => s + x.collected, 0);
  const collected = round2(Math.min(total, collectedRaw));
  const alreadyOnTab = round2(sources.reduce((s, x) => s + x.onTab, 0));
  const outstanding = round2(Math.max(0, total - collected));
  return {
    total: round2(total),
    collected,
    alreadyOnTab,
    outstanding,
    tabDelta: round2(outstanding - alreadyOnTab),
    received: modeBreakdown([]),
    turfAdvance: 0,
    turfBalance: 0,
    turfAdvanceSplit: "",
    turfBalanceSplit: "",
  };
}

type CarrySource = {
  id: string;
  mode: string | null;
  date: string;
  collected: number;
};

/**
 * The payment entries a merged bill inherits from its sources (real rows with
 * their own modes/dates, or one implied entry for a source with no rows).
 * ONE function shared by the dialog preview and mergeIntoBill.
 */
export function carriedPaymentEntries(
  bookings: CarrySource[],
  sales: CarrySource[],
  sourceRows: Parameters<typeof effectivePaymentEntries>[1],
): EffectivePaymentEntry[] {
  return effectivePaymentEntries(
    {
      turf_booking: bookings.map((b) => ({
        id: b.id,
        collected: b.collected,
        mode: b.mode,
        date: b.date,
      })),
      snack_sale: sales.map((x) => ({
        id: x.id,
        collected: x.collected,
        mode: x.mode,
        date: x.date,
      })),
    },
    sourceRows,
  );
}

/**
 * How the turf bookings' collected money splits into the ADVANCE (each
 * booking's first collection) and the BALANCE paid after it, with the Cash /
 * UPI split of each. Display only. Null when no booking has payment rows to
 * tell the stages apart (the whole amount then prints as before).
 */
export function turfAdvanceBalance(
  bookings: CarrySource[],
  sourceRows: PaymentRow[],
): {
  first: number;
  balance: number;
  firstModes: { mode: string; amount: number }[];
  balanceModes: { mode: string; amount: number }[];
  firstEntries: EffectivePaymentEntry[];
  balanceEntries: EffectivePaymentEntry[];
} | null {
  const firstE: EffectivePaymentEntry[] = [];
  const restE: EffectivePaymentEntry[] = [];
  let any = false;
  for (const b of bookings) {
    if (!(b.collected > 0)) continue;
    const rows = sourceRows.filter(
      (r) => r.parent_type === "turf_booking" && r.parent_id === b.id,
    );
    const firstRows = firstBatchRows(rows);
    if (firstRows.length === 0) {
      // No rows: nothing to tell the stages apart, all of it is the advance.
      firstE.push(
        ...effectivePaymentEntries(
          {
            turf_booking: [
              { id: b.id, collected: b.collected, mode: b.mode, date: b.date },
            ],
          },
          [],
        ),
      );
      continue;
    }
    any = true;
    const firstSum = Math.min(
      b.collected,
      firstRows.reduce((n, r) => n + Number(r.amount), 0),
    );
    // The first collection, capped at what the record says was collected.
    let left = firstSum;
    for (const r of firstRows) {
      const take = Math.min(left, Number(r.amount));
      if (take > 0)
        firstE.push({
          parent_type: "turf_booking",
          parent_id: b.id,
          amount: take,
          mode: normalizeReceivedPaymentMode(r.mode),
          received_at: r.received_at,
        });
      left -= take;
    }
    // Everything else collected on the booking is the balance, taken from the
    // later rows (reconciled to the amount the record says was collected).
    const ids = new Set(firstRows.map((r) => r.id));
    const laterTotal = rupees(b.collected - firstSum);
    if (laterTotal > 0)
      restE.push(
        ...effectivePaymentEntries(
          {
            turf_booking: [
              { id: b.id, collected: laterTotal, mode: b.mode, date: b.date },
            ],
          },
          rows.filter((r) => !ids.has(r.id)),
        ),
      );
  }
  if (!any) return null;
  const first = rupees(firstE.reduce((n, e) => n + e.amount, 0));
  const balance = rupees(restE.reduce((n, e) => n + e.amount, 0));
  return {
    first,
    balance,
    firstModes: modeBreakdown(firstE).modes,
    balanceModes: modeBreakdown(restE).modes,
    firstEntries: firstE,
    balanceEntries: restE,
  };
}

const modeParts = (entries: EffectivePaymentEntry[], parent: string) =>
  modeBreakdown(entries.filter((e) => e.parent_id === parent)).modes;

/**
 * A merged bill's tax, computed exactly the way a normal bill's is: on the
 * post-discount taxable amount, one rounding per tax line, CGST/SGST split
 * equally. Merge math (outstanding, tab charge) runs on `gross` so the amount
 * posted to the customer's tab is the same tax-inclusive figure the printed
 * invoice shows as Balance due — never the bare pre-tax total.
 */
export function mergeTax(
  total: number,
  s: Parameters<typeof taxBreakdown>[1] = readAppSettings(),
) {
  const taxable = round2(total);
  const { taxAmount, lines } = taxBreakdown(taxable, s);
  return { taxable, taxAmount, taxLines: lines, gross: taxable + taxAmount };
}

/** Preview figures for the merge dialog (no writes). */
export function previewMerge(args: {
  total: number;
  /** Tax settings; defaults to the ones in effect right now. */
  settings?: Parameters<typeof taxBreakdown>[1];
  bookings: {
    id: string;
    advance_paid: number;
    payment_mode?: string | null;
    booking_date?: string;
  }[];
  sales: {
    id: string;
    total: number;
    payment_mode: string;
    sale_date?: string | undefined;
    tax_amount?: number | undefined;
    tax_lines?: SnackSaleRow["tax_lines"] | undefined;
  }[];
  tabEntries: TabEntryRow[];
  /** Payment rows on file (usePayments). Optional: without them the
   * received split falls back to each source's own mode, like the save. */
  payments?: Parameters<typeof effectivePaymentEntries>[1];
}): MergePreview {
  const base = mergeMath(
    mergeTax(args.total, args.settings ?? readAppSettings()).gross,
    [
      ...args.bookings.map((b) => {
        const onTab = netTabAmountFor(
          args.tabEntries,
          TAB_REF_TURF_BOOKING,
          b.id,
        );
        return { collected: bookingCollected(b, onTab), onTab };
      }),
      ...args.sales.map((s) => ({
        collected: saleCollected(s as never),
        onTab: netTabAmountFor(args.tabEntries, TAB_REF_SNACK_SALE, s.id),
      })),
    ],
  );
  // Same carried-over entries mergeIntoBill writes, so the split shown before
  // merging is exactly the split the saved bill will have.
  const collectedOf = (id: string, kind: "b" | "s") => {
    if (kind === "b") {
      const b = args.bookings.find((x) => x.id === id)!;
      return bookingCollected(
        b,
        netTabAmountFor(args.tabEntries, TAB_REF_TURF_BOOKING, id),
      );
    }
    const s = args.sales.find((x) => x.id === id)!;
    return saleCollected(s as never);
  };
  const entries = carriedPaymentEntries(
    args.bookings.map((b) => ({
      id: b.id,
      mode: b.payment_mode ?? null,
      date: b.booking_date ?? "",
      collected: collectedOf(b.id, "b"),
    })),
    args.sales.map((s) => ({
      id: s.id,
      mode: s.payment_mode,
      date: s.sale_date ?? "",
      collected: collectedOf(s.id, "s"),
    })),
    args.payments ?? [],
  );
  const stages = turfAdvanceBalance(
    args.bookings.map((b) => ({
      id: b.id,
      mode: b.payment_mode ?? null,
      date: b.booking_date ?? "",
      collected: collectedOf(b.id, "b"),
    })),
    (args.payments ?? []).filter((p) => p.parent_type === "turf_booking"),
  );
  return {
    ...base,
    received: modeBreakdown(entries),
    turfAdvance: stages?.first ?? 0,
    turfBalance: stages?.balance ?? 0,
    turfAdvanceSplit: stages ? modeBreakdown(stages.firstEntries).detail : "",
    turfBalanceSplit: stages ? modeBreakdown(stages.balanceEntries).detail : "",
  };
}

type MergeableBooking = {
  id: string;
  booking_no: string;
  slot_name: string;
  hours: number;
  rate_per_hour: number;
  turf_amount: number;
  total_amount: number;
  discount: number;
  courts?: number;
};
type MergeableSaleItem = {
  item_name: string;
  qty: number;
  unit_price: number;
  amount: number;
};
type MergeableSale = { items: MergeableSaleItem[] };

export type MergedItemsResult = {
  items: BillItem[];
  /** Sum of every booking's pre-discount turf gross + every snack item — the
   * merged bill's "Subtotal" line, before the discount below is taken off. */
  subtotal: number;
  /** Sum of each selected booking's own discount, pulled back in so a merged
   * bill can't overcharge for an offer that was already applied. */
  discount: number;
  /** subtotal − discount, never negative. */
  total: number;
};

/**
 * Builds the merged bill's line items plus subtotal/discount/total from the
 * picked turf bookings + snack bills. Shared by the dialog's live preview and
 * the actual save, so the number shown before merging can never disagree with
 * what gets written.
 *
 * `turf_amount` is every booking's pre-discount gross under the current
 * schema. A row restored from a backup taken before that field existed has it
 * as 0/undefined; `storedTurfAmount()` rebuilds exactly that case as
 * `hours × rate_per_hour × courts`, the ONE legacy rule shared with
 * receipts, exports, booking tax/dues and analytics (see
 * docs/calculation-rules.md §5b). Falling back to `total_amount` would be
 * wrong here, since total_amount is already NET of the booking's discount
 * and the discount gets pulled back in again below.
 */
export function buildMergedItems(
  bookings: MergeableBooking[],
  sales: MergeableSale[],
): MergedItemsResult {
  const items: BillItem[] = [];
  for (const b of bookings) {
    // Older rows use zero when turf_amount was not present; storedTurfAmount
    // rebuilds them with the shared legacy rule (hours × rate × courts).
    // Current rows carry the positive pre-discount turf_amount directly.
    const turfGross = storedTurfAmount(b);
    const hours = Math.max(1, Number(b.hours) || 1);
    const courts = Math.max(
      1,
      Math.round(
        Number((b as MergeableBooking & { courts?: number }).courts) || 1,
      ),
    );
    const qty = hours * courts;
    const rate = qty > 0 ? round2(turfGross / qty) : turfGross;
    // A merged line must satisfy qty × rate = total. Qty is court-hours so
    // the stored per-court hourly rate remains meaningful, while the label
    // makes the court multiplier explicit to the customer.
    items.push({
      item: `Turf · ${b.slot_name} (${b.booking_no}) · ${courts} court${courts === 1 ? "" : "s"}`,
      qty,
      rate,
      total: round2(qty * rate),
      unit: "hr" as Unit,
    });
  }
  for (const sale of sales)
    for (const it of sale.items)
      items.push({
        item: it.item_name,
        qty: it.qty,
        rate: it.unit_price,
        total: it.amount,
        unit: "pcs" as Unit,
      });

  const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
  const discount = round2(
    bookings.reduce((s, b) => s + (Number(b.discount) || 0), 0),
  );
  const total = round2(Math.max(0, subtotal - discount));
  return { items, subtotal, discount, total };
}

async function issueInvoiceNo() {
  const appSettings = readAppSettings();
  if (hasCustomNumbering(appSettings)) {
    const existing = await db.bills.orderBy("invoice_no").keys();
    return nextCustomInvoiceNo(existing as string[], appSettings);
  }
  return nextInvoiceNo();
}

/**
 * Creates the merged bill and re-points every source due at it, in one
 * transaction. Refuses to merge a record that is already on another bill.
 */
export async function mergeIntoBill(input: MergeInput): Promise<Bill> {
  if (input.bookingIds.length + input.saleIds.length === 0)
    throw new Error("Select at least one turf booking or snack bill");

  return db.transaction(
    "rw",
    [
      db.bills,
      db.counters,
      db.turf_bookings,
      db.snack_sales,
      db.customer_tabs,
      db.tab_entries,
      db.payments,
    ],
    async () => {
      const bookings: TurfBookingRow[] = [];
      for (const id of input.bookingIds) {
        const row = await db.turf_bookings.get(id);
        if (!row) throw new Error("A selected booking no longer exists");
        if (row.merged_into_bill_id)
          throw new Error(
            `Booking ${row.booking_no} is already on another bill`,
          );
        bookings.push(row);
      }
      const sales: SnackSaleRow[] = [];
      for (const id of input.saleIds) {
        const row = await db.snack_sales.get(id);
        if (!row) throw new Error("A selected snack bill no longer exists");
        if (row.merged_into_bill_id)
          throw new Error(
            `Snack bill ${row.bill_no} is already on another bill`,
          );
        sales.push(row);
      }

      // A merge never needs a typed name: blank parts come from the first
      // picked record, then "Walk-in customer" (resolveMergeCustomer).
      const { name, phone } = resolveMergeCustomer(input, [
        ...bookings.map((b) => ({ name: b.customer_name, phone: b.phone })),
        ...sales.map((s) => ({ name: s.customer_name, phone: null })),
      ]);
      const putOnTab = input.dueMode ? false : Boolean(input.putOnTab);

      const ledger = await db.tab_entries
        .where("ref_id")
        .anyOf([...bookings.map((b) => b.id), ...sales.map((s) => s.id)])
        .toArray();
      const sources: (Source & { onTab: number })[] = [
        ...bookings.map((b) => {
          const onTab = netTabAmountFor(ledger, TAB_REF_TURF_BOOKING, b.id);
          return {
            kind: TAB_REF_TURF_BOOKING as typeof TAB_REF_TURF_BOOKING,
            id: b.id,
            label: b.booking_no,
            collected: bookingCollected(b, onTab),
            onTab,
          };
        }),
        ...sales.map((s) => ({
          kind: TAB_REF_SNACK_SALE as typeof TAB_REF_SNACK_SALE,
          id: s.id,
          label: s.bill_no,
          collected: saleCollected(s),
          onTab: netTabAmountFor(ledger, TAB_REF_SNACK_SALE, s.id),
        })),
      ];

      // Tax frozen at creation (see mergeTax / lib/biz.ts billGrossTotal), and
      // the merge math runs on the tax-INCLUSIVE gross so the tab charge in
      // step 2 matches the invoice's Balance due exactly.
      const tax = mergeTax(input.total);
      const math = mergeMath(tax.gross, sources);
      const billId = newId();
      // How the sources' money was received (Cash / UPI / Card per source).
      // Computed up here so the display-only breakdown below can remember it.
      const collectedBy = new Map(sources.map((x) => [x.id, x.collected]));
      const bookingIdSet = new Set(bookings.map((b) => b.id));
      const saleIdSet = new Set(sales.map((x) => x.id));
      const sourceRows = await db.payments
        .filter(
          (r) =>
            (r.parent_type === "turf_booking" &&
              bookingIdSet.has(r.parent_id)) ||
            (r.parent_type === "snack_sale" && saleIdSet.has(r.parent_id)),
        )
        .toArray();
      const carried = carriedPaymentEntries(
        bookings.map((b) => ({
          id: b.id,
          collected: collectedBy.get(b.id) ?? 0,
          mode: b.payment_mode,
          date: b.booking_date,
        })),
        sales.map((x) => ({
          id: x.id,
          collected: collectedBy.get(x.id) ?? 0,
          mode: x.payment_mode,
          date: x.sale_date,
        })),
        sourceRows,
      );
      const turfModes = modeBreakdown(
        carried.filter((e) => bookingIdSet.has(e.parent_id)),
      ).modes;
      // Split each booking's money into the advance (first collection) and the
      // balance paid after it, so the merged bill does not call a settled
      // balance "advance". Display only.
      const turfStages = turfAdvanceBalance(
        bookings.map((b) => ({
          id: b.id,
          collected: collectedBy.get(b.id) ?? 0,
          mode: b.payment_mode,
          date: b.booking_date,
        })),
        sourceRows,
      );

      const status: BillStatus =
        math.collected >= math.total && math.total > 0
          ? "paid"
          : math.collected > 0
            ? "partial"
            : "unpaid";

      // Display-only: remembers which items are turf vs which snack bill, and
      // how much of each was already collected, so receipts can print a
      // separate Snacks block and a "Snacks paid" line. Never read by any
      // money calculation. Skipped (legacy printing) if the caller's items do
      // not follow the turf-first / snack-after order buildMergedItems makes.
      const snackItemCount = sales.reduce((n, x) => n + x.items.length, 0);
      const merged_breakdown: MergedBreakdown | null =
        input.items.length === bookings.length + snackItemCount
          ? {
              v: 1,
              turf_items: bookings.length,
              turf_advance: round2(
                sources
                  .filter((x) => x.kind === TAB_REF_TURF_BOOKING)
                  .reduce((n, x) => n + x.collected, 0),
              ),
              ...(turfModes.length > 0 ? { turf_modes: turfModes } : {}),
              ...(turfStages
                ? {
                    turf_first: turfStages.first,
                    turf_first_modes: turfStages.firstModes,
                    ...(turfStages.balanceModes.length > 0
                      ? { turf_balance_modes: turfStages.balanceModes }
                      : {}),
                  }
                : {}),
              snacks: sales.map((x) => ({
                bill_no: x.bill_no,
                items: x.items.length,
                amount: round2(
                  (x.items as { amount?: number }[]).reduce(
                    (n, it) => n + (Number(it.amount) || 0),
                    0,
                  ),
                ),
                paid: round2(saleCollected(x)),
                ...(modeParts(carried, x.id).length > 0
                  ? { modes: modeParts(carried, x.id) }
                  : {}),
              })),
            }
          : null;

      const row: BillRow = {
        id: billId,
        invoice_no: await issueInvoiceNo(),
        customer_name: name,
        customer_phone: phone,
        items: input.items as unknown as unknown[],
        subtotal: round2(input.subtotal),
        discount: round2(input.discount),
        total: tax.taxable,
        tax_amount: tax.taxAmount,
        tax_lines: tax.taxLines,
        // Only money genuinely received. The rest, on an "On tab" bill, is a
        // tab charge — never counted here as collected revenue.
        amount_paid: math.collected,
        status,
        payment_mode: putOnTab ? TAB_PAYMENT_MODE : null,
        merged_breakdown,
        bill_date: nowIso(),
        created_at: nowIso(),
      };
      await db.bills.add(row);

      // The money the sources already collected carries over to the bill with
      // its real split and received dates (COPIED, not moved: the sources keep
      // their own rows so an un-merge that restores them still has them, and
      // they are excluded from reports while merged, so nothing is counted
      // twice). Without this the bill would show the whole amount as one
      // lump received today.
      if (carried.length > 0) {
        await db.payments.bulkAdd(
          carried.map((e) => ({
            id: newId(),
            parent_type: "bill" as const,
            parent_id: billId,
            amount: e.amount,
            mode: e.mode,
            received_at: e.received_at,
            created_at: nowIso(),
          })),
        );
      }

      const bill: Bill = {
        ...row,
        items: input.items,
        status: row.status as BillStatus,
      };

      // 1. Pull each source's exact remaining charge off the tab, tagged so an
      //    un-merge can put it back.
      const writes: AddTabEntryInput[] = sources
        .filter((s) => s.onTab > 0)
        .map((s) => ({
          name,
          phone,
          kind: "payment" as const,
          business: "Shared",
          amount: s.onTab,
          note: `Moved to bill ${row.invoice_no} (${s.label})`,
          ref_type: TAB_REF_MERGE_REVERSE,
          ref_id: billId,
          source_ref_type: s.kind,
          source_ref_id: s.id,
        }));

      // 2. The merged bill carries the whole outstanding amount when the
      //    operator puts it on the tab.
      if (putOnTab && math.outstanding > 0) {
        writes.push({
          name,
          phone,
          kind: "charge",
          business: "Shared",
          amount: math.outstanding,
          note: `Merged bill ${row.invoice_no}`,
          ref_type: TAB_REF_BILL,
          ref_id: billId,
        });
      }
      await writeTabEntries(writes);

      // 3. Sources keep existing but stop being their own financial record.
      for (const b of bookings)
        await db.turf_bookings.update(b.id, { merged_into_bill_id: billId });
      for (const s of sales)
        await db.snack_sales.update(s.id, { merged_into_bill_id: billId });

      return bill;
    },
  );
}

/**
 * Puts a merged bill's dues back exactly where they came from: sources are
 * released, the bill's own tab charge is reversed, and every `merge_reverse`
 * row is re-charged against its original source.
 */
export async function unmergeBill(
  billId: string,
  options: { deleteBill?: boolean; cancel?: boolean } = {},
) {
  await db.transaction(
    "rw",
    [
      db.bills,
      db.turf_bookings,
      db.snack_sales,
      db.customer_tabs,
      db.tab_entries,
      db.payments,
    ],
    async () => {
      const bill = await db.bills.get(billId);
      const invoiceNo = bill?.invoice_no ?? "bill";
      const name = bill?.customer_name?.trim() ?? "";
      const phone = bill?.customer_phone ?? null;

      const bookings = await db.turf_bookings
        .where("merged_into_bill_id")
        .equals(billId)
        .toArray();
      const sales = await db.snack_sales
        .where("merged_into_bill_id")
        .equals(billId)
        .toArray();
      for (const b of bookings)
        await db.turf_bookings.update(b.id, { merged_into_bill_id: null });
      for (const s of sales)
        await db.snack_sales.update(s.id, { merged_into_bill_id: null });

      // Only rows touching this bill and the source records being restored are
      // needed. `ref_id` is indexed, so unmerge no longer scans the whole
      // customer-tab ledger inside the long-running write transaction.
      const billEntries = await db.tab_entries
        .where("ref_id")
        .equals(billId)
        .toArray();
      const reversals = billEntries.filter(
        (e) =>
          e.ref_type === TAB_REF_MERGE_REVERSE &&
          e.ref_id === billId &&
          e.kind === "payment",
      );
      const sourceRefIds = [
        ...new Set(
          reversals
            .map((e) => e.source_ref_id)
            .filter((id): id is string => !!id),
        ),
      ];
      const sourceEntries = sourceRefIds.length
        ? await db.tab_entries.where("ref_id").anyOf(sourceRefIds).toArray()
        : [];
      const ledger = [...billEntries, ...sourceEntries];
      const writes: AddTabEntryInput[] = [];

      // The bill's own charge goes away with the bill.
      const billOnTab = netTabAmountFor(ledger, TAB_REF_BILL, billId);
      if (billOnTab > 0 && name) {
        writes.push({
          name,
          phone,
          kind: "payment" as const,
          business: "Shared",
          amount: billOnTab,
          note: `Un-merged ${invoiceNo}`,
          ref_type: TAB_REF_BILL,
          ref_id: billId,
        });
      }

      // Each reversed source charge comes back, once, against its own record.
      for (const e of reversals) {
        const restored = netTabAmountFor(
          ledger,
          e.source_ref_type ?? "",
          e.source_ref_id,
        );
        // Only restore what isn't already back on the tab (guards a repeat un-merge).
        const amount = round2(num(e.amount) - restored);
        if (amount <= 0 || !name) continue;
        writes.push({
          name,
          phone,
          kind: "charge" as const,
          business:
            e.source_ref_type === TAB_REF_SNACK_SALE ? "Snacks" : "Turf",
          amount,
          note: `Restored from ${invoiceNo}`,
          ref_type: e.source_ref_type ?? null,
          ref_id: e.source_ref_id ?? null,
        });
      }
      if (writes.length) await writeTabEntries(writes);

      // The merge_reverse rows have served their purpose; dropping them keeps
      // the ledger readable and makes a second un-merge a no-op.
      if (reversals.length)
        await db.tab_entries.bulkDelete(reversals.map((r) => r.id));

      // A deleted or voided bill takes its own receipts with it, so the cash
      // drawer and the Cash/Online split stop counting money that no longer
      // belongs to any live record. (A plain un-merge keeps the bill and the
      // cash it really collected, so its rows stay.)
      if (options.deleteBill || options.cancel) {
        await removePaymentsForParents("bill", [billId]);
      }

      if (options.deleteBill) {
        await db.bills.delete(billId);
      } else if (options.cancel) {
        // Void, not delete: the row stays as a historical record (its
        // invoice number is never reused) but `status: "cancelled"` makes
        // every money calculation treat it as carrying no due and no
        // revenue — see the early-return checks in dues.ts's
        // billDue/billCollected/billMovedToDues and biz.ts's balanceOf.
        // `payment_mode` is cleared rather than reused for the
        // TAB_PAYMENT_MODE zero-due trick below: a cancelled bill isn't
        // "on tab", it's void, and the receipt/list views should stop
        // showing a stale "Paid via ___" line for it.
        await db.bills.update(billId, {
          status: "cancelled",
          payment_mode: null,
        });
      } else if (bill) {
        // The merged bill is deliberately non-collectable while it owns the
        // sources (`payment_mode: On tab`). Its bill payment rows are copies
        // of the source receipts, not independent cash. Once the sources are
        // restored by a plain un-merge those copied rows must be removed, or
        // the same receipt is counted once on the source and once on the
        // historical bill. The source rows are the authoritative history.
        await removePaymentsForParents("bill", [billId]);
        await db.bills.update(billId, {
          amount_paid: 0,
          status: "unpaid",
          payment_mode: TAB_PAYMENT_MODE,
        });
      }
    },
  );
}

/** True when this bill was produced by a merge (it owns source records). */
export async function isMergedBill(billId: string) {
  const booking = await db.turf_bookings
    .where("merged_into_bill_id")
    .equals(billId)
    .first();
  if (booking) return true;
  const sale = await db.snack_sales
    .where("merged_into_bill_id")
    .equals(billId)
    .first();
  return Boolean(sale);
}

/** Gross (tax-inclusive) amount of a merged bill, for display. */
export const mergedBillGross = (bill: Bill) => billGrossTotal(bill);

// ---------------------------------------------------------------------------
// Cancelling an invoice
// ---------------------------------------------------------------------------

/**
 * What cancelling a MERGED invoice does to the bills it was built from:
 *  - "invoice-only": the invoice is cancelled and the turf booking / snack
 *    bills come back as separate live bills (their dues restored, nothing is
 *    refunded because the sources keep their own money);
 *  - "invoice-and-sources": the invoice AND its turf booking / snack bills are
 *    cancelled (snack stock goes back on the shelf) and the money already
 *    received follows the refund-or-keep decision.
 * A plain (never merged) invoice has no sources, so the scope is irrelevant.
 */
export type CancelScope = "invoice-only" | "invoice-and-sources";

export type CancelInvoicePreview = {
  invoiceNo: string;
  merged: boolean;
  /** Tax-inclusive invoice total. */
  total: number;
  /** Money really received on the invoice so far. */
  collected: number;
  bookings: { id: string; no: string; total: number }[];
  sales: { id: string; no: string; total: number; units: number }[];
  /** invoice-and-sources: snack units that go back into stock. */
  stockUnits: number;
  /** The invoice's own charge on the customer's tab, which is reversed. */
  billOnTab: number;
  /** Money paid on the invoice that none of its turf/snack bills carries
   * (e.g. a snack part paid after the merge). It has no bill to go back to. */
  billOnlyMoney: number;
  /** invoice-only: due that returns to the customer's tab on the sources. */
  tabRestored: number;
};

/** Read-only numbers for the cancel dialog; writes nothing. */
export async function previewCancelInvoice(
  billId: string,
): Promise<CancelInvoicePreview> {
  const bill = await db.bills.get(billId);
  if (!bill) throw new Error("Invoice not found");
  const [bookings, sales, billEntries] = await Promise.all([
    db.turf_bookings.where("merged_into_bill_id").equals(billId).toArray(),
    db.snack_sales.where("merged_into_bill_id").equals(billId).toArray(),
    db.tab_entries.where("ref_id").equals(billId).toArray(),
  ]);
  const reversals = billEntries.filter(
    (e) =>
      e.ref_type === TAB_REF_MERGE_REVERSE &&
      e.ref_id === billId &&
      e.kind === "payment",
  );
  const sourceIds = [
    ...new Set(
      reversals.map((e) => e.source_ref_id).filter((x): x is string => !!x),
    ),
  ];
  const sourceEntries = sourceIds.length
    ? await db.tab_entries.where("ref_id").anyOf(sourceIds).toArray()
    : [];
  const ledger = [...billEntries, ...sourceEntries];
  let tabRestored = 0;
  for (const e of reversals) {
    const back = netTabAmountFor(
      ledger,
      e.source_ref_type ?? "",
      e.source_ref_id,
    );
    tabRestored += Math.max(0, round2(num(e.amount) - back));
  }
  const units = (items: unknown) =>
    ((items ?? []) as SnackSaleItem[]).reduce((n, l) => n + num(l.qty), 0);
  const collected = billCollected(bill as unknown as Bill);
  const carried =
    bookings.reduce((n, b) => n + bookingCashCollected(b as never, ledger), 0) +
    sales.reduce(
      (n, s) => n + (s.payment_mode === TAB_PAYMENT_MODE ? 0 : num(s.total)),
      0,
    );
  return {
    invoiceNo: bill.invoice_no,
    billOnlyMoney:
      bookings.length + sales.length > 0
        ? Math.max(0, round2(collected - carried))
        : 0,
    merged: bookings.length + sales.length > 0,
    total: billGrossTotal(bill as unknown as Bill),
    collected: billCollected(bill as unknown as Bill),
    bookings: bookings.map((b) => ({
      id: b.id,
      no: b.booking_no,
      total: num(b.total_amount),
    })),
    sales: sales.map((s) => ({
      id: s.id,
      no: s.bill_no,
      total: num(s.total),
      units: units(s.items),
    })),
    stockUnits: sales.reduce((n, s) => n + units(s.items), 0),
    billOnTab: netTabAmountFor(ledger, TAB_REF_BILL, billId),
    tabRestored: round2(tabRestored),
  };
}

/**
 * Cancels an invoice (merged or plain). Money already received is never
 * deleted silently: when something was collected the caller MUST pass the
 * owner's refund-or-keep decision, which is stored on the invoice as the
 * shared refund fields (is_refundable / refunded_at / refund_mode) and keeps
 * its payment rows so the Cash/UPI split and the drawer stay honest.
 *
 * For a merged invoice with scope "invoice-only" the legacy un-merge path
 * runs (sources come back as separate bills and keep their own money).
 */
export async function cancelInvoice(
  billId: string,
  options: { scope?: CancelScope; money?: MoneyDecision } = {},
): Promise<{ stockChanges: SnackStockChange[] }> {
  const scope = options.scope ?? "invoice-only";
  const bill = await db.bills.get(billId);
  if (!bill) throw new Error("Invoice not found");
  if (isCancelled(bill))
    throw new Error(`${bill.invoice_no} is already cancelled`);

  if (scope === "invoice-only" && (await isMergedBill(billId))) {
    // Never lose money silently: a payment the bills do not carry would vanish
    // with the invoice's receipts.
    const preview = await previewCancelInvoice(billId);
    if (preview.billOnlyMoney > 0)
      throw new Error(billOnlyBlockMessage(preview.billOnlyMoney));
    await unmergeBill(billId, { cancel: true });
    return { stockChanges: [] };
  }

  const collected = billCollected(bill as unknown as Bill);
  if (collected > 0 && !options.money) {
    throw new Error(
      `Rs ${collected} was already received on ${bill.invoice_no}. Choose whether to refund it or keep it.`,
    );
  }

  const stockChanges: SnackStockChange[] = [];
  await db.transaction(
    "rw",
    [
      db.bills,
      db.turf_bookings,
      db.snack_sales,
      db.snack_items,
      db.snack_stock_history,
      db.customer_tabs,
      db.tab_entries,
      db.payments,
    ],
    async () => {
      const now = new Date().toISOString();
      const name = bill.customer_name?.trim() ?? "";

      // The sources of a merged invoice are cancelled with it. They stay
      // linked to the invoice (their money lives on it, never on them).
      const bookings = await db.turf_bookings
        .where("merged_into_bill_id")
        .equals(billId)
        .toArray();
      for (const b of bookings)
        await db.turf_bookings.update(b.id, { status: "Cancelled" });
      const sales = await db.snack_sales
        .where("merged_into_bill_id")
        .equals(billId)
        .toArray();
      if (sales.length > 0) {
        const stockRows = await db.snack_items.toArray();
        for (const sale of sales) {
          if (isCancelled(sale)) continue;
          for (const line of (sale.items ?? []) as SnackSaleItem[])
            await applySnackStockDelta(
              line,
              line.qty,
              now,
              stockRows,
              stockChanges,
              "sale_reversal",
            );
          await db.snack_sales.update(sale.id, { cancelled: true });
        }
      }

      // The invoice's own charge on the customer's tab goes away with it.
      const billEntries = await db.tab_entries
        .where("ref_id")
        .equals(billId)
        .toArray();
      const billOnTab = netTabAmountFor(billEntries, TAB_REF_BILL, billId);
      if (billOnTab > 0 && name) {
        await writeTabEntries([
          {
            name,
            phone: bill.customer_phone ?? null,
            kind: "payment" as const,
            business: "Shared",
            amount: billOnTab,
            note: `Cancelled ${bill.invoice_no}`,
            ref_type: TAB_REF_BILL,
            ref_id: billId,
          },
        ]);
      }

      if (collected > 0 && options.money) {
        // Freeze what was really received so the held amount is known after
        // the status flips; payment rows are kept (never deleted).
        await db.bills.update(billId, {
          status: "cancelled",
          amount_paid: collected,
          ...refundPatch(options.money, now),
        });
      } else {
        await db.bills.update(billId, {
          status: "cancelled",
          payment_mode: null,
        });
      }
    },
  );
  return { stockChanges };
}

const billOnlyBlockMessage = (amount: number) =>
  `Rs ${amount} was paid directly on this invoice and has no turf or snack bill to go back to. Cancel the invoice and its bills instead, then refund or keep that money.`;

/** What a given cancel choice will do, for the dialog (pure, testable). */
export type CancelEffects = {
  /** Why "invoice only" cannot be used right now, or null. */
  blocked: string | null;
  /** Money was received and the cancel keeps/refunds it: the owner must pick. */
  needsMoneyDecision: boolean;
  moneyAtStake: number;
  /** Bills released as separate live bills (invoice-only). */
  sourcesReleased: number;
  /** Turf bookings + snack bills cancelled with the invoice. */
  sourcesCancelled: number;
  stockUnitsRestored: number;
  /** Due that returns to the customer's tab on the released bills. */
  tabDueRestored: number;
  /** The invoice's own charge removed from the customer's tab. */
  billTabReversed: number;
};

export function cancelInvoiceEffects(
  p: CancelInvoicePreview,
  scope: CancelScope,
): CancelEffects {
  const sources = p.bookings.length + p.sales.length;
  const releasing = p.merged && scope === "invoice-only";
  return {
    blocked:
      releasing && p.billOnlyMoney > 0
        ? billOnlyBlockMessage(p.billOnlyMoney)
        : null,
    // Released sources keep their own money, so nothing is refunded or kept.
    needsMoneyDecision: p.collected > 0 && !releasing,
    moneyAtStake: releasing ? 0 : p.collected,
    sourcesReleased: releasing ? sources : 0,
    sourcesCancelled: p.merged && !releasing ? sources : 0,
    stockUnitsRestored: p.merged && !releasing ? p.stockUnits : 0,
    tabDueRestored: releasing ? p.tabRestored : 0,
    billTabReversed: p.billOnTab,
  };
}

// ---------------------------------------------------------------------------
// One-tap merge from the Outstanding screen
// ---------------------------------------------------------------------------

/**
 * Merges everything one customer owes on a live turf booking AND on a live
 * snack bill into a single PENDING invoice (nothing has to be paid first).
 * Candidates are matched by the customer's tab identity (phone first, then
 * name): bookings by their own name/phone, snack sales by the customer their
 * tab charge was posted to. Only records that really owe money are taken, so
 * a paid booking is never dragged onto the invoice.
 *
 * Throws when the customer does not have both a pending booking and a pending
 * snack bill (nothing to merge).
 */
export async function mergePendingForCustomer(who: {
  name: string;
  phone: string | null;
}): Promise<Bill> {
  const key = tabKey(who.name, who.phone);
  const [bookingRows, saleRows, entries] = await Promise.all([
    db.turf_bookings.toArray(),
    db.snack_sales.toArray(),
    db.tab_entries.toArray(),
  ]);
  const ledger = entries as unknown as TabEntry[];

  const bookings = bookingRows.filter(
    (b) =>
      mergeCandidateKey({ name: b.customer_name, phone: b.phone }) === key &&
      pendingAmount(b as never, { tabEntries: ledger }) > 0,
  );
  const chargedTo = new Map<string, string>();
  for (const e of entries)
    if (e.kind === "charge" && e.ref_type === TAB_REF_SNACK_SALE && e.ref_id)
      chargedTo.set(e.ref_id, e.customer_key);
  const sales = saleRows.filter(
    (s) =>
      chargedTo.get(s.id) === key &&
      pendingAmount(s as never, { tabEntries: ledger }) > 0,
  );
  if (bookings.length === 0 || sales.length === 0)
    throw new Error(
      "Needs a pending turf booking and a pending snack bill for the same customer",
    );

  const built = buildMergedItems(bookings as never, sales as never);
  return mergeIntoBill({
    name: who.name,
    phone: who.phone,
    bookingIds: bookings.map((b) => b.id),
    saleIds: sales.map((s) => s.id),
    items: built.items,
    subtotal: built.subtotal,
    discount: built.discount,
    total: built.total,
    dueMode: "pending",
  });
}
