/**
 * The ONE source of truth for "what is still owed".
 *
 * A rupee of due can live in exactly one of three places:
 *   1. a turf booking's unpaid balance (Turf tab),
 *   2. a bill's unpaid balance (Bills tab / merged bills),
 *   3. the customer's running tab ledger (Dues tab).
 *
 * Whenever an operator moves a due (turf "Put balance on tab", a snack bill
 * paid "On tab", or a merged bill) the ledger gets a charge and this module
 * subtracts that exact amount from the source record — so Turf, Snacks, Dues,
 * Bills, Customers and Reports can never disagree, and no rupee is counted
 * twice.
 */

import {
  balanceOf,
  billGrossTotal,
  bookingGrossTotal,
  bookingTaxable,
  snackSaleGrossTotal,
  type Bill,
  type TaxSnapshot,
} from "./biz";
import { rupees } from "./money";
import { isCancelled, pendingLabel } from "./record-state";
import { TAB_PAYMENT_MODE, type SnackSale, type TurfBooking } from "./ops";

import {
  TAB_REF_BILL,
  TAB_REF_MERGE_REVERSE,
  TAB_REF_SNACK_SALE,
  TAB_REF_TURF_BOOKING,
  tabKey,
  type TabEntry,
} from "./tabs";

const num = (v: unknown) => Number(v) || 0;
/** Every due is a whole rupee — see lib/money.ts for the single rule. */
const round2 = rupees;

/**
 * Net amount still sitting on a tab for one source record: charges made
 * against it minus any payments/reversals recorded against the same ref.
 * Never negative — an over-collection belongs to the tab, not to the record.
 */
const netTabIndexCache = new WeakMap<
  readonly TabEntry[],
  Map<string, number>
>();

function netTabIndex(entries: readonly TabEntry[]) {
  let index = netTabIndexCache.get(entries);
  if (index) return index;
  index = new Map<string, number>();
  for (const e of entries) {
    if (!e.ref_id) continue;
    const key = `${e.ref_type}:${e.ref_id}`;
    index.set(
      key,
      (index.get(key) ?? 0) +
        (e.kind === "charge" ? num(e.amount) : -num(e.amount)),
    );
  }
  netTabIndexCache.set(entries, index);
  return index;
}

export function netTabAmountFor(
  entries: TabEntry[],
  refType: string,
  refId: string | null | undefined,
) {
  if (!refId) return 0;
  return Math.max(
    0,
    round2(netTabIndex(entries).get(`${refType}:${refId}`) ?? 0),
  );
}

/**
 * True for a ledger row that is REAL money handed over against a running
 * tab (a payment recorded from the Dues tab / customer card / final
 * settlement). Bookkeeping reversals — a merge pulling a source charge off
 * the tab, an un-merge putting it back — are also stored as `payment` rows
 * but carry a `ref_type`, and no cash changed hands for them.
 */
export const isTabCashPayment = (e: Pick<TabEntry, "kind" | "ref_type">) =>
  e.kind === "payment" && !e.ref_type;

/**
 * The ONE place that decides whether a turf booking is still its own
 * financial record: not Cancelled, not No-show, and not merged into a bill
 * (a merged booking's money lives on that bill). Every revenue/dues/advance
 * sum in the app must filter through this instead of re-writing the clauses
 * inline.
 *
 * No-show was added to this exclusion (previously only Cancelled was
 * excluded — see ops.ts BOOKING_STATUSES history): a slot marked No-show was
 * never delivered, so it shouldn't count as earned revenue, and an unpaid
 * balance on it isn't a debt anyone is expected to come back and settle. A
 * business that wants to charge a no-show fee would need that as an
 * explicit, separate line item — not by leaving the full booking amount
 * sitting as an outstanding due indefinitely.
 *
 * Do NOT use it for non-money booking counts (e.g. "visits") — a merged or
 * no-show booking still happened as an event.
 */
export const isFinancialBooking = (
  b: Pick<TurfBooking, "status" | "merged_into_bill_id">,
) => !isCancelled(b) && !b.merged_into_bill_id;

/**
 * Snack sales rolled into a merged bill stay in the database (their tab
 * charges must keep a traceable parent) but stop being their own financial
 * record — mirror of `isFinancialBooking` for sales.
 *
 * A voided sale (`cancelled`, via `useVoidSnackSale`) is excluded the same
 * way — the items went back to stock and were never actually kept by the
 * customer, so it's not revenue and not a due, same reasoning Step 27 used
 * to add `"No-show"` to `isFinancialBooking` above.
 */
export const isFinancialSale = (
  s: Pick<SnackSale, "merged_into_bill_id" | "cancelled">,
) => !s.merged_into_bill_id && !isCancelled(s);

/** Structural shape `bookingDue` needs — narrower than the full `TurfBooking`
 * so callers with a partial/projected booking (e.g. `customerLifetimeStats`
 * in data.ts) can still route through the one shared "what's still owed"
 * formula instead of re-deriving it by hand. Mirrors the same pattern
 * `bookingTaxable`/`isFinancialBooking` already use. */
export type DueBooking = Pick<TurfBooking, "id" | "status" | "advance_paid"> &
  Partial<Pick<TurfBooking, "merged_into_bill_id">> &
  Parameters<typeof bookingTaxable>[0] &
  TaxSnapshot;

/** Money still owed on a turf booking itself (0 once merged / on the tab).
 * Optional `settings` passes through to bookingGrossTotal() for callers
 * (like periodStats()) aggregating under an explicit settings object rather
 * than the live app settings — see bookingGrossTotal()'s doc comment. */
export function bookingDue(
  b: DueBooking,
  entries: TabEntry[] = [],
  settings?: Parameters<typeof bookingGrossTotal>[1],
) {
  if (!isFinancialBooking(b)) return 0;
  // Tax-inclusive, exactly like billDue() via billGrossTotal(): what the
  // booking's receipt printed as Grand Total, less what was collected.
  const raw = bookingGrossTotal(b, settings) - num(b.advance_paid);
  const onTab = netTabAmountFor(entries, TAB_REF_TURF_BOOKING, b.id);
  return Math.max(0, round2(raw - onTab));
}

/**
 * REAL cash handed over against a booking — never `advance_paid` at face value.
 *
 * "Put balance on tab" (TurfTab) settles a booking by writing
 * `advance_paid = bookingGrossTotal(b)` while posting the remainder as a tab
 * charge. Reading `advance_paid` as collected money would count that rupee
 * twice: once here, and again as a tab payment when the customer actually pays
 * the tab down. Subtracting whatever the tab still owns for this booking
 * undoes exactly that inflation.
 *
 * Every "collected / received / paid" figure for a booking (analytics,
 * payment split, merges, screens) must go through this.
 */
export function bookingCashCollected(
  b: Pick<TurfBooking, "id" | "advance_paid">,
  entries: TabEntry[] = [],
) {
  const onTab = netTabAmountFor(entries, TAB_REF_TURF_BOOKING, b.id);
  return Math.max(0, round2(num(b.advance_paid) - onTab));
}

/**
 * True when a cancelled booking's advance is kept by the business rather
 * than owed back to the customer. This is the ONE flag
 * `bookingForfeitedRevenue`/`bookingRefundableAdvance` below read to decide
 * which of the two — mutually exclusive — calculations a cancelled
 * booking's advance falls into.
 *
 * `is_refundable` is a user choice made at cancellation time (see the
 * cancel dialogs in TurfTab). `undefined` covers every booking cancelled
 * before that field existed — those are treated as non-refundable so the
 * app's original behaviour (every cancelled booking's advance was
 * forfeited, no exceptions) doesn't silently change for old data.
 */
const isForfeited = (b: Pick<TurfBooking, "is_refundable">) =>
  b.is_refundable !== true;

/**
 * The advance kept on a booking the operator cancelled AND marked
 * non-refundable — money the customer already handed over that the
 * business is not giving back.
 *
 * `isFinancialBooking()` above deliberately excludes every `"Cancelled"`
 * booking from revenue/dues/collected, on the reasoning that a cancelled
 * slot was never delivered. That's right for the amount the booking was
 * NEVER PAID — there is no due to chase on a slot that isn't happening.
 * But it also silently dropped an advance the customer already paid and
 * isn't getting back: that rupee is real, already-collected income, not a
 * void one. This is the one crack in `isFinancialBooking`'s "cancelled =
 * void" rule — everywhere else, "cancelled" and "nothing collected" were
 * the same thing; a forfeited advance is cancelled AND collected.
 *
 * Returns 0 for anything that isn't `"Cancelled"`, for a cancelled booking
 * with nothing paid (a cancellation with no money on it is a pure void,
 * same as before), and — as of the `is_refundable` toggle — for a
 * cancelled booking the operator explicitly marked refundable: that money
 * is owed back to the customer, see `bookingRefundableAdvance` instead, a
 * SEPARATE calculation that this function never overlaps with (a given
 * cancelled booking's advance is either forfeited revenue XOR a refundable
 * liability, never both, never split between the two).
 *
 * Deliberately narrower than `isFinancialBooking`'s other exclusion,
 * `"No-show"`: a no-show fee needs its own explicit charge (see that
 * function's doc comment) — this does NOT extend the same treatment to a
 * no-show's advance, only to an actually-cancelled booking's.
 *
 * Callers (periodStats, paymentSplit) key this to the day the money was
 * actually received, via `effectivePaymentEntries` — same as any other
 * payment — not to `booking_date`: unlike a delivered booking (where the
 * service happened on booking_date regardless of when it was paid), a
 * cancelled booking's earning event IS the moment the money stopped being
 * refundable, which in practice is whenever it was collected.
 */
/** F-9: an advance is kept by the business for a cancelled non-refundable
 * booking, or for ANY no-show booking (the slot was never delivered). */
const isForfeitedBooking = (
  b: Pick<TurfBooking, "status" | "is_refundable" | "merged_into_bill_id">,
): boolean => isCancelled(b) && !b.merged_into_bill_id && isForfeited(b);

export function bookingForfeitedRevenue(
  b: Pick<
    TurfBooking,
    "id" | "status" | "advance_paid" | "is_refundable" | "merged_into_bill_id"
  >,
  entries: TabEntry[] = [],
): number {
  // F-9 (owner decision 2026-09): a No-show booking whose customer paid an
  // advance keeps it, exactly like a cancelled non-refundable one. The slot
  // itself stays out of play revenue/utilisation (isFinancialBooking), only
  // the advance becomes forfeited income, dated by when it was received.
  if (!isForfeitedBooking(b)) return 0;
  return Math.max(0, round2(bookingCashCollected(b, entries)));
}

/**
 * The advance sitting on a booking the operator cancelled AND explicitly
 * marked refundable — money the business still owes back to the customer.
 *
 * This is the mirror image of `bookingForfeitedRevenue` above, kept as its
 * own separate function/code path rather than a branch inside one
 * function, on purpose: the two figures are used for fundamentally
 * different things downstream (one is revenue already in hand, the other
 * is a liability still to pay out) and mixing them into a single return
 * value would make it too easy for a future caller to add this into
 * `revenue`/`collected` by mistake. Nothing in analytics.ts folds this
 * into revenue, netRevenue, collected, or dues today — it is surfaced
 * separately (`PeriodStats.refundableAdvance`) purely as an
 * operator-facing "money you still owe out" figure.
 *
 * Returns 0 for anything that isn't `"Cancelled"`, for a cancelled booking
 * with nothing paid, and for a cancelled booking that is non-refundable
 * (`is_refundable !== true`) — see `bookingForfeitedRevenue` for that case.
 */
export function bookingRefundableAdvance(
  b: Pick<
    TurfBooking,
    | "id"
    | "status"
    | "advance_paid"
    | "is_refundable"
    | "refunded_at"
    | "merged_into_bill_id"
  >,
  entries: TabEntry[] = [],
): number {
  // K4: once the refund has actually been paid back, the liability is gone.
  // A cancelled No-show can be refunded too (one cancelled model); money on a
  // merged source lives on its bill, never here.
  if (
    !isCancelled(b) ||
    b.merged_into_bill_id ||
    isForfeited(b) ||
    b.refunded_at
  )
    return 0;
  return Math.max(0, round2(bookingCashCollected(b, entries)));
}

/** K4: refundable advance already refunded back to the customer. This is an
 * outflow on the refund day — never a P&L expense, because the advance was
 * never income. Tracked so the cash drawer sees the money leaving. */
export function bookingRefundOutflow(
  b: Pick<
    TurfBooking,
    | "id"
    | "status"
    | "advance_paid"
    | "is_refundable"
    | "refunded_at"
    | "merged_into_bill_id"
  >,
  entries: TabEntry[] = [],
): number {
  if (
    !isCancelled(b) ||
    b.merged_into_bill_id ||
    isForfeited(b) ||
    !b.refunded_at
  )
    return 0;
  return Math.max(0, round2(bookingCashCollected(b, entries)));
}

/** Cash part of a refund (drawer correction, K4). A refund recorded without a
 * mode is treated as Cash. */
export function bookingRefundCashOut(
  b: Pick<
    TurfBooking,
    | "id"
    | "status"
    | "advance_paid"
    | "is_refundable"
    | "refunded_at"
    | "refund_mode"
    | "merged_into_bill_id"
  >,
  entries: TabEntry[] = [],
): number {
  if ((b.refund_mode ?? "Cash") !== "Cash") return 0;
  return bookingRefundOutflow(b, entries);
}

/**
 * True when a booking's balance now lives on the customer's running tab: the
 * booking itself owes nothing, payment happens on the Dues tab, and the row
 * stays visible but greyed out (mirror of `billMovedToDues`).
 */
export function bookingMovedToDues(
  b: Pick<TurfBooking, "id" | "status" | "merged_into_bill_id">,
  entries: TabEntry[] = [],
) {
  if (b.merged_into_bill_id) return false;
  return netTabAmountFor(entries, TAB_REF_TURF_BOOKING, b.id) > 0;
}

/**
 * True when a snack sale's money sits on the running tab (billed "On tab", or
 * a charge posted against the sale) rather than collected at the counter.
 */
export function saleMovedToDues(
  s: Pick<SnackSale, "id" | "payment_mode" | "merged_into_bill_id">,
  entries: TabEntry[] = [],
) {
  if (s.merged_into_bill_id) return false;
  return (
    (s.payment_mode ?? "") === TAB_PAYMENT_MODE ||
    netTabAmountFor(entries, TAB_REF_SNACK_SALE, s.id) > 0
  );
}

/**
 * Money still owed on a bill itself.
 *
 * A bill saved as "On tab" is owned by the running tab — its remainder is
 * already a tab charge, so the bill's own due is 0 and the money is counted
 * exactly once. Any other bill owes `total - amount_paid`, less anything that
 * was separately pushed onto the tab against it.
 */
export function billDue(bill: Bill, entries: TabEntry[] = []) {
  // A cancelled bill is a void record, not an unpaid one — see BillStatus
  // in biz.ts. Its sources (if any) already got their own dues back via
  // unmergeBill(id, { cancel: true }), so counting a due here too would
  // double the same money.
  if (isCancelled(bill)) return 0;
  if ((bill.payment_mode ?? "") === TAB_PAYMENT_MODE) return 0;
  const onTab = netTabAmountFor(entries, TAB_REF_BILL, bill.id);
  return Math.max(0, round2(balanceOf(bill) - onTab));
}

/**
 * True when a bill's remaining balance has been moved onto the customer's
 * running tab — the bill itself owes nothing (`billDue` is 0) but money is
 * still outstanding on the tab. Such bills stay in the Bills list greyed
 * out; payment happens from the Dues tab.
 */
export function billMovedToDues(bill: Bill, entries: TabEntry[] = []) {
  if (isCancelled(bill)) return false;
  return balanceOf(bill) > 0 && billDue(bill, entries) === 0;
}

/**
 * A snack sale never carries a due of its own: it is either paid at the
 * counter or billed "On tab", in which case the tab ledger owns the money.
 */
export const snackSaleDue = () => 0;

/* ---------- due numbers ---------- */

/** DDMMYY stamp from an ISO date ("2026-09-05" → "050926"). */
const ddmmyy = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}${m[2]}${m[1]!.slice(2)}` : "000000";
};

/** Earliest date a charge hit the tab for one source record — its "moved to dues" date. */
export function tabChargeDateFor(
  entries: TabEntry[],
  refType: string,
  refId: string | null | undefined,
) {
  if (!refId) return null;
  let first: string | null = null;
  for (const e of entries) {
    if (e.ref_type !== refType || e.ref_id !== refId || e.kind !== "charge")
      continue;
    if (!first || e.entry_date < first) first = e.entry_date;
  }
  return first;
}

/**
 * Due number for a record whose balance moved onto a customer's tab:
 * `D-<move date DDMMYY>-<original number>`, e.g. `D-050926-INV-0007`.
 * Derived on display from the ledger + record, never stored, so existing
 * data needs no migration.
 */
export function dueNoFor(originalNo: string, dateISO: string) {
  return `D-${ddmmyy(dateISO)}-${originalNo}`;
}

/**
 * Due number for a source record (bill/booking/sale). Uses the earliest tab
 * charge against it as the move date, falling back to the record's own date
 * (e.g. a bill created directly "On tab" never gets a bill-referenced charge).
 */
export function dueNoForRef(
  entries: TabEntry[],
  refType: string,
  refId: string | null | undefined,
  originalNo: string,
  fallbackDate: string,
) {
  return dueNoFor(
    originalNo,
    tabChargeDateFor(entries, refType, refId) ?? fallbackDate,
  );
}

export type DueLine = {
  kind: "tab" | "booking" | "bill";
  label: string;
  amount: number;
  date: string;
  /** Record id for "booking"/"bill" lines, so a screen can act on this exact
   * record (collect a payment, mark paid) instead of only displaying it.
   * Absent for "tab" lines — those are collected via the tab entry APIs. */
  id?: string;
};

export type CustomerDues = {
  tab: number;
  bookings: number;
  bills: number;
  total: number;
  lines: DueLine[];
};

/**
 * Everything one customer owes, with the contributing rows so any screen can
 * show the breakdown instead of re-deriving it.
 */
export function customerOutstanding(
  customer: { name: string; phone?: string | null },
  src: {
    bills?: Bill[];
    bookings?: TurfBooking[];
    tabEntries?: TabEntry[];
    tabBalance?: number;
    /**
     * Optional record matcher. Defaults to tab-identity (phone, else name).
     * Screens that group by display name pass their own name comparison so a
     * record saved without a phone still lands on the right customer.
     */
    match?: (
      name: string | null | undefined,
      phone: string | null | undefined,
    ) => boolean;
  },
): CustomerDues {
  const key = tabKey(customer.name, customer.phone ?? null);
  const belongs =
    src.match ??
    ((n: string | null | undefined, p: string | null | undefined) =>
      tabKey(n, p) === key);
  const entries = (src.tabEntries ?? []).filter((e) => e.customer_key === key);

  // An over-collected tab is credit, not a negative due: clamp at 0 so it can
  // never cancel out a real booking/bill due elsewhere in the total.
  const tab = Math.max(
    0,
    src.tabBalance ??
      round2(
        entries.reduce(
          (s, e) => s + (e.kind === "charge" ? num(e.amount) : -num(e.amount)),
          0,
        ),
      ),
  );

  const lines: DueLine[] = [];
  if (tab > 0)
    lines.push({ kind: "tab", label: "Running tab", amount: tab, date: "" });

  let bookings = 0;
  for (const b of src.bookings ?? []) {
    if (!belongs(b.customer_name, b.phone)) continue;
    const due = bookingDue(b, entries);
    if (due <= 0) continue;
    bookings += due;
    lines.push({
      kind: "booking",
      label: `Booking ${b.booking_no}`,
      amount: due,
      date: b.booking_date,
      id: b.id,
    });
  }

  let bills = 0;
  for (const bill of src.bills ?? []) {
    if (!belongs(bill.customer_name, bill.customer_phone)) continue;
    const due = billDue(bill, entries);
    if (due <= 0) continue;
    bills += due;
    lines.push({
      kind: "bill",
      label: `Bill ${bill.invoice_no}`,
      amount: due,
      date: bill.bill_date,
      id: bill.id,
    });
  }

  return {
    tab: round2(tab),
    bookings: round2(bookings),
    bills: round2(bills),
    total: round2(tab + bookings + bills),
    lines,
  };
}

/** One customer who owes something, as the Outstanding screen lists them. */
export type PendingIdentity = {
  key: string;
  name: string;
  phone: string | null;
  dues: CustomerDues;
};

/**
 * EVERY customer who owes money, and the grand total - the one function behind
 * the Outstanding screen and the Dashboard "Pending dues" card, so the two can
 * never disagree. Identities come from saved customers, open tabs AND the
 * owners of pending bookings/bills, so a walk-in who was never saved as a
 * contact is still listed. A running-tab key with no name falls back to the
 * phone/name encoded in the key, so its money is never dropped from the list.
 */
export function pendingMoneyIndex(src: {
  customers?: readonly { name: string; phone?: string | null }[];
  tabs?: readonly {
    customer_key: string;
    customer_name?: string | null;
    phone?: string | null;
  }[];
  bills?: Bill[];
  bookings?: TurfBooking[];
  tabEntries?: TabEntry[];
}): { rows: PendingIdentity[]; total: number } {
  const identities = new Map<string, { name: string; phone: string | null }>();
  for (const c of src.customers ?? [])
    identities.set(tabKey(c.name, c.phone ?? null), {
      name: c.name,
      phone: c.phone ?? null,
    });
  for (const t of src.tabs ?? []) {
    if (identities.has(t.customer_key) || !t.customer_name) continue;
    identities.set(t.customer_key, {
      name: t.customer_name,
      phone: t.phone ?? null,
    });
  }
  for (const b of src.bookings ?? []) {
    const key = tabKey(b.customer_name, b.phone ?? null);
    if (!identities.has(key) && b.customer_name)
      identities.set(key, { name: b.customer_name, phone: b.phone ?? null });
  }
  for (const b of src.bills ?? []) {
    const key = tabKey(b.customer_name, b.customer_phone ?? null);
    if (!identities.has(key) && b.customer_name)
      identities.set(key, {
        name: b.customer_name,
        phone: b.customer_phone ?? null,
      });
  }
  for (const e of src.tabEntries ?? []) {
    if (identities.has(e.customer_key)) continue;
    const raw = e.customer_key.slice(2);
    const isPhone = e.customer_key.startsWith("p:");
    identities.set(e.customer_key, {
      name: raw || "Customer",
      phone: isPhone ? raw : null,
    });
  }
  const index = customerOutstandingIndex([...identities.values()], {
    bills: src.bills ?? [],
    bookings: src.bookings ?? [],
    tabEntries: src.tabEntries ?? [],
  });
  const rows: PendingIdentity[] = [];
  let total = 0;
  for (const [key, who] of identities) {
    const dues = index.get(tabKey(who.name, who.phone));
    if (!dues || dues.total <= 0) continue;
    rows.push({ key, name: who.name, phone: who.phone, dues });
    total += dues.total;
  }
  return { rows, total: round2(total) };
}

/**
 * Money actually received against a bill.
 *
 * An "On tab" bill is stored with `amount_paid` = what was really collected on
 * the source records, and the remainder sits on the tab — so "On tab" is never
 * treated as a payment method and revenue is never inflated.
 */
/**
 * Computes dues for many customers after grouping the source rows once. This
 * keeps customer lists from repeatedly scanning the entire year of bills,
 * bookings and tab entries. Keys use the same phone-first identity as the
 * normal customerOutstanding() default matcher.
 */
export function customerOutstandingIndex(
  customers: readonly { name: string; phone?: string | null }[],
  src: { bills?: Bill[]; bookings?: TurfBooking[]; tabEntries?: TabEntry[] },
) {
  const billsByKey = new Map<string, Bill[]>();
  const bookingsByKey = new Map<string, TurfBooking[]>();
  const entriesByKey = new Map<string, TabEntry[]>();
  for (const bill of src.bills ?? []) {
    const key = tabKey(bill.customer_name, bill.customer_phone ?? null);
    const rows = billsByKey.get(key);
    if (rows) rows.push(bill);
    else billsByKey.set(key, [bill]);
  }
  for (const booking of src.bookings ?? []) {
    const key = tabKey(booking.customer_name, booking.phone ?? null);
    const rows = bookingsByKey.get(key);
    if (rows) rows.push(booking);
    else bookingsByKey.set(key, [booking]);
  }
  for (const entry of src.tabEntries ?? []) {
    const rows = entriesByKey.get(entry.customer_key);
    if (rows) rows.push(entry);
    else entriesByKey.set(entry.customer_key, [entry]);
  }
  const result = new Map<string, CustomerDues>();
  for (const customer of customers) {
    const key = tabKey(customer.name, customer.phone ?? null);
    result.set(
      key,
      customerOutstanding(customer, {
        bills: billsByKey.get(key) ?? [],
        bookings: bookingsByKey.get(key) ?? [],
        tabEntries: entriesByKey.get(key) ?? [],
      }),
    );
  }
  return result;
}

export function billCollected(
  bill: Bill,
  settings?: Parameters<typeof billGrossTotal>[1],
) {
  // A void bill never counts as revenue, even if it shows an old
  // `amount_paid` left over from before it was cancelled (kept only for
  // the historical record — see BillStatus in biz.ts).
  if (isCancelled(bill)) return 0;
  if ((bill.payment_mode ?? "") === TAB_PAYMENT_MODE)
    return Math.max(0, rupees(bill.amount_paid));
  // A bill marked paid has a zero balance, so its collected amount is the full
  // gross total (tax included) regardless of what `amount_paid` was left at.
  return bill.status === "paid"
    ? round2(billGrossTotal(bill, settings))
    : rupees(bill.amount_paid);
}

/** Money actually received for a snack sale (an "On tab" sale collects
 * nothing). Optional `settings`, same reason as bookingDue(). */
export function snackSaleCollected(
  s: Pick<
    SnackSale,
    "payment_mode" | "total" | "tax_amount" | "tax_lines" | "cancelled"
  >,
  settings?: Parameters<typeof snackSaleGrossTotal>[1],
) {
  // A voided sale never counts as revenue, even if it shows an old
  // `payment_mode` left over from before it was cancelled — mirror of
  // billCollected()'s `status === "cancelled"` early return.
  if (isCancelled(s)) return 0;
  return s.payment_mode === TAB_PAYMENT_MODE
    ? 0
    : snackSaleGrossTotal(s, settings);
}

/** Human label for a snack sale's tab/merge/void state (used by the Snacks
 * list). Cancelled is checked first: a voided sale's old `payment_mode`
 * (e.g. "On tab") is stale and shouldn't still be advertised as owing. */
export function saleStateLabel(
  s: Pick<SnackSale, "merged_into_bill_id" | "payment_mode" | "cancelled">,
  invoiceNo?: string | null,
  /** What is still owed on the sale (tab balance); shown as "Pending Rs X". */
  pending?: number,
) {
  if (isCancelled(s)) return "Cancelled";
  if (s.merged_into_bill_id)
    return invoiceNo ? `Merged into ${invoiceNo}` : "Merged into bill";
  if (s.payment_mode === TAB_PAYMENT_MODE)
    return pending === undefined ? "Pending" : pendingLabel(pending);
  return null;
}

/** Human label for a booking's merge state (used by the Turf list). Money
 * still owed - including a balance moved onto the tab - is the Pending badge
 * (paymentStateLabel), so there is no second "On tab" chip. */
export function bookingStateLabel(
  b: Pick<TurfBooking, "id" | "merged_into_bill_id">,
  _entries: TabEntry[] = [],
  invoiceNo?: string | null,
) {
  if (b.merged_into_bill_id)
    return invoiceNo ? `Merged into ${invoiceNo}` : "Merged into bill";
  return null;
}

export type LedgerGroup = {
  key: string;
  /** Human label naming the source record ("Booking B-12", "Manual due"). */
  label: string;
  /** Due number (D-<moved date>-<original no>) for record-backed lines. */
  dueNo: string | null;
  refType: string | null;
  refId: string | null;
  charged: number;
  paid: number;
  /** Still sitting on the tab for this source (never negative). */
  net: number;
  /** Most recent activity date for the group. */
  date: string;
};

/**
 * Group one customer's tab ledger into one line per source record, so the Dues
 * tab can show WHERE a balance came from instead of a flat list of entries.
 *
 * Loose payments (no ref) and manual dues collapse into their own lines; a
 * `merge_reverse` entry is netted against the source it was pulled off, which
 * is exactly why a merged booking/sale disappears from the tab breakdown.
 */
export function groupTabLedger(
  entries: TabEntry[],
  src: {
    bills?: Pick<Bill, "id" | "invoice_no">[];
    bookings?: Pick<TurfBooking, "id" | "booking_no">[];
    sales?: Pick<SnackSale, "id" | "bill_no">[];
  } = {},
): LedgerGroup[] {
  const billNo = new Map((src.bills ?? []).map((b) => [b.id, b.invoice_no]));
  const bookingNo = new Map(
    (src.bookings ?? []).map((b) => [b.id, b.booking_no]),
  );
  const saleNo = new Map((src.sales ?? []).map((s) => [s.id, s.bill_no]));

  const noFor = (refType: string | null, refId: string | null) => {
    if (refType === TAB_REF_TURF_BOOKING)
      return bookingNo.get(refId ?? "") ?? null;
    if (refType === TAB_REF_SNACK_SALE) return saleNo.get(refId ?? "") ?? null;
    if (refType === TAB_REF_BILL) return billNo.get(refId ?? "") ?? null;
    return null;
  };

  const labelFor = (
    refType: string | null,
    refId: string | null,
    note: string | null,
  ) => {
    if (refType === TAB_REF_TURF_BOOKING)
      return `Booking ${bookingNo.get(refId ?? "") ?? "(removed)"}`;
    if (refType === TAB_REF_SNACK_SALE)
      return `Snack bill ${saleNo.get(refId ?? "") ?? "(removed)"}`;
    if (refType === TAB_REF_BILL)
      return `Bill ${billNo.get(refId ?? "") ?? "(removed)"}`;
    return note?.trim() || "Manual entry";
  };

  const groups = new Map<string, LedgerGroup>();
  for (const e of entries) {
    // A merge reversal belongs to the source it cancels, not to a line of its own.
    const refType =
      e.ref_type === TAB_REF_MERGE_REVERSE
        ? (e.source_ref_type ?? null)
        : (e.ref_type ?? null);
    const refId =
      e.ref_type === TAB_REF_MERGE_REVERSE
        ? (e.source_ref_id ?? null)
        : (e.ref_id ?? null);
    const key = refType && refId ? `${refType}:${refId}` : `free:${e.kind}`;
    const g = groups.get(key) ?? {
      key,
      label:
        refType && refId
          ? labelFor(refType, refId, e.note)
          : e.kind === "payment"
            ? "Payments received"
            : "Manual dues",
      dueNo: null,
      refType,
      refId,
      charged: 0,
      paid: 0,
      net: 0,
      date: "",
    };
    if (e.kind === "charge") g.charged = round2(g.charged + num(e.amount));
    else g.paid = round2(g.paid + num(e.amount));
    g.net = round2(g.charged - g.paid);
    if (e.entry_date > g.date) g.date = e.entry_date;
    groups.set(key, g);
  }

  // Stamp record-backed groups with their due number once the full group is
  // known (the move date is the earliest charge against that source).
  for (const g of groups.values()) {
    const originalNo = noFor(g.refType, g.refId);
    if (originalNo && g.refType && g.refId) {
      g.dueNo = dueNoForRef(entries, g.refType, g.refId, originalNo, g.date);
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.net - a.net || b.date.localeCompare(a.date),
  );
}

// ---------------------------------------------------------------------------
// Refund model for invoices and snack sales (mirror of the turf-booking one).
//
// A bill/sale cancelled AFTER money arrived records the owner's choice in the
// optional `is_refundable` field: `true` = owed back (liability, never income),
// `false` = kept (forfeited, income on the day it arrived). `undefined` is
// every legacy cancelled record and means "nothing was kept" - exactly how a
// cancelled bill/sale always counted - so old data and backups keep their
// numbers. Payment rows are never deleted by this model.
// ---------------------------------------------------------------------------

type RefundShape = {
  is_refundable?: boolean | undefined;
  refunded_at?: string | null | undefined;
  refund_mode?: "Cash" | "UPI" | null | undefined;
  refund_amount?: number | undefined;
};

/** Money a cancelled bill still holds because the owner decided what to do
 * with it. The cancel flow freezes `amount_paid` to what was really received. */
export function billHeldMoney(
  bill: Pick<Bill, "status" | "amount_paid"> & RefundShape,
): number {
  if (!isCancelled(bill) || bill.is_refundable === undefined) return 0;
  return Math.max(0, rupees(bill.amount_paid));
}

export const billForfeitedRevenue = (
  bill: Pick<Bill, "status" | "amount_paid"> & RefundShape,
) => (bill.is_refundable === false ? billHeldMoney(bill) : 0);

export const billRefundableAmount = (
  bill: Pick<Bill, "status" | "amount_paid"> & RefundShape,
) =>
  bill.is_refundable === true && !bill.refunded_at ? billHeldMoney(bill) : 0;

/** Money already paid back on a bill: the whole held amount for a cancelled
 * bill, or `refund_amount` for a live bill moved back to unpaid. */
export function billRefundOutflow(
  bill: Pick<Bill, "status" | "amount_paid"> & RefundShape,
): number {
  if (!bill.refunded_at) return 0;
  if (bill.refund_amount !== undefined)
    return Math.max(0, rupees(bill.refund_amount));
  return bill.is_refundable === true ? billHeldMoney(bill) : 0;
}

export const billRefundCashOut = (
  bill: Pick<Bill, "status" | "amount_paid"> & RefundShape,
) => ((bill.refund_mode ?? "Cash") === "Cash" ? billRefundOutflow(bill) : 0);

/** Money a voided snack sale still holds (a paid sale only; "On tab" owed
 * nothing in hand). */
export function saleHeldMoney(
  s: Pick<
    SnackSale,
    | "payment_mode"
    | "total"
    | "tax_amount"
    | "tax_lines"
    | "cancelled"
    | "merged_into_bill_id"
  > &
    RefundShape,
  settings?: Parameters<typeof snackSaleGrossTotal>[1],
): number {
  // Money on a merged source lives on its bill, never on the source itself.
  if (s.merged_into_bill_id) return 0;
  if (!isCancelled(s) || s.is_refundable === undefined) return 0;
  if (s.payment_mode === TAB_PAYMENT_MODE) return 0;
  return Math.max(0, round2(snackSaleGrossTotal(s, settings)));
}

export const saleForfeitedRevenue = (
  s: Parameters<typeof saleHeldMoney>[0],
  settings?: Parameters<typeof snackSaleGrossTotal>[1],
) => (s.is_refundable === false ? saleHeldMoney(s, settings) : 0);

export const saleRefundableAmount = (
  s: Parameters<typeof saleHeldMoney>[0],
  settings?: Parameters<typeof snackSaleGrossTotal>[1],
) =>
  s.is_refundable === true && !s.refunded_at ? saleHeldMoney(s, settings) : 0;

export function saleRefundOutflow(
  s: Parameters<typeof saleHeldMoney>[0],
  settings?: Parameters<typeof snackSaleGrossTotal>[1],
): number {
  if (!s.refunded_at) return 0;
  if (s.refund_amount !== undefined)
    return Math.max(0, rupees(s.refund_amount));
  return s.is_refundable === true ? saleHeldMoney(s, settings) : 0;
}

export const saleRefundCashOut = (
  s: Parameters<typeof saleHeldMoney>[0],
  settings?: Parameters<typeof snackSaleGrossTotal>[1],
) =>
  (s.refund_mode ?? "Cash") === "Cash" ? saleRefundOutflow(s, settings) : 0;
