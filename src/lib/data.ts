import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  billGrossTotal,
  type Bill,
  type BillItem,
  type BillStatus,
  type Expense,
  type HistoryEntry,
} from "./biz";
import { isFinancialBooking } from "./analytics";
import type { SnackSale, TurfBooking } from "./ops";
import {
  billDue,
  bookingDue,
  customerOutstanding,
  isFinancialSale,
} from "./dues";
import { tabBalanceOf, tabKey, type TabEntry } from "./tabs";
import { unmergeBill } from "./merge";
import { removePaymentsForParents } from "./payments";
import {
  db,
  newId,
  nowIso,
  sortBy,
  type BillRow,
  type ExpenseRow,
  type PaymentRow,
} from "./localdb";
import { rowsForYears, useYearWindow, type YearTable } from "./years";
import { normalizePlayerPhone } from "./teams";

/** Instant-paint cache: reads hydrate from localStorage, then refresh from IndexedDB. */
function cacheKey(name: string) {
  return `ks:cache:${name}`;
}
export function readCache<T>(name: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(cacheKey(name));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
/**
 * Big datasets are not mirrored to localStorage: serialising tens of thousands
 * of rows costs more than the instant-paint it buys (and blows the 5 MB quota).
 * IndexedDB stays the source of truth in that case.
 */
const CACHE_ROW_LIMIT = 1500;

export function writeCache(name: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    if (Array.isArray(value) && value.length > CACHE_ROW_LIMIT) {
      window.localStorage.removeItem(cacheKey(name));
      return;
    }
    window.localStorage.setItem(cacheKey(name), JSON.stringify(value));
  } catch {
    /* quota — ignore */
  }
}

export function useBills() {
  const { years } = useYearWindow();
  return useQuery({
    queryKey: ["bills", years],
    // Cached/empty seed is only a first paint: mark it stale so the real
    // IndexedDB read still runs on mount (router sets refetchOnMount).
    initialDataUpdatedAt: 0,
    initialData: () => readCache<Bill[]>(`bills:${years.join("-")}`, []),
    queryFn: async () => {
      const raw = await rowsForYears<BillRow>("bills" as YearTable, years);
      const rows = sortBy(raw, "bill_date", "desc");
      const bills = rows.map((b) => ({
        ...b,
        items: (b.items ?? []) as unknown as BillItem[],
        subtotal: Number(b.subtotal),
        discount: Number(b.discount),
        total: Number(b.total),
        amount_paid: Number(b.amount_paid),
        status: b.status as BillStatus,
      })) as Bill[];
      writeCache(`bills:${years.join("-")}`, bills);
      return bills;
    },
  });
}

/**
 * Real payment rows for the selected year window, keyed (and sorted) by
 * `received_at` — the day the money actually arrived — not any parent
 * record's own date. Feeds `Sources.payments` for `paymentSplit`/
 * `cashVsOnlineSplit` (lib/analytics.ts) so the cash drawer and reports
 * date each collection by when it was received.
 */
export function usePayments() {
  const { years } = useYearWindow();
  return useQuery({
    queryKey: ["payments", years],
    // Cached/empty seed is only a first paint: mark it stale so the real
    // IndexedDB read still runs on mount (router sets refetchOnMount).
    initialDataUpdatedAt: 0,
    initialData: () =>
      readCache<PaymentRow[]>(`payments:${years.join("-")}`, []),
    queryFn: async () => {
      const raw = await rowsForYears<PaymentRow>(
        "payments" as YearTable,
        years,
      );
      const rows = sortBy(raw, "received_at", "desc");
      writeCache(`payments:${years.join("-")}`, rows);
      return rows;
    },
  });
}

export function useHistory() {
  return useQuery({
    queryKey: ["history"],
    // Cached/empty seed is only a first paint: mark it stale so the real
    // IndexedDB read still runs on mount (router sets refetchOnMount).
    initialDataUpdatedAt: 0,
    initialData: () => readCache<HistoryEntry[]>("history", []),
    queryFn: async () => {
      const rows = sortBy(
        await db.history_entries.toArray(),
        "created_at",
        "desc",
      ).map((h) => ({
        ...h,
        rows: (h.rows ?? []) as unknown as BillItem[],
        total: Number(h.total),
      })) as HistoryEntry[];
      writeCache("history", rows);
      return rows;
    },
  });
}

export function useSaveHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      rows: BillItem[];
      total: number;
      note?: string;
    }) => {
      await db.history_entries.add({
        id: newId(),
        rows: payload.rows,
        total: payload.total,
        note: payload.note ?? null,
        created_at: nowIso(),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["history"] }),
  });
}

export function useDeleteHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id?: string) => {
      if (id) await db.history_entries.delete(id);
      else await db.history_entries.clear();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["history"] }),
  });
}

export function useUpdateBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      status,
      amount_paid,
      payment_mode,
    }: {
      id: string;
      status: BillStatus;
      amount_paid: number;
      payment_mode?: string | null;
    }) => {
      if (status === "partial") {
        const current = await db.bills.get(id);
        if (!current) throw new Error("Bill not found");
        const gross = billGrossTotal(current as unknown as Bill);
        if (!(amount_paid > 0 && amount_paid < gross)) {
          throw new Error(
            "A partially paid bill must have an amount paid between zero and its total.",
          );
        }
      }
      // A bill moved back to unpaid must lose its old payment mode, otherwise
      // the receipt keeps claiming "Paid by UPI" on a bill with nothing paid —
      // and a bill paid again by a different mode would keep the stale one.
      const modePatch =
        status === "unpaid"
          ? { payment_mode: null }
          : payment_mode === undefined
            ? {}
            : { payment_mode };
      await db.transaction("rw", db.bills, db.payments, async () => {
        await db.bills.update(id, { status, amount_paid, ...modePatch });
        // Back to unpaid means the money was never (or is no longer)
        // received: its receipts go too, or a later payment would pile onto
        // stale rows and the split would show cash that isn't there.
        if (status === "unpaid") await removePaymentsForParents("bill", [id]);
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

export function useDeleteBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Deleting a merged bill must put every due back exactly where it came
      // from: sources released, the bill's own tab charge reversed, each
      // source's `merge_reverse` row re-charged. unmergeBill() does all of
      // that in one transaction (see lib/merge.ts) — a plain delete used to
      // orphan the sources and make the money vanish from the reports.
      await unmergeBill(id, { deleteBill: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["turf_bookings"] });
      qc.invalidateQueries({ queryKey: ["snack_sales"] });
      qc.invalidateQueries({ queryKey: ["tab_entries"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["team_players"] });
      qc.invalidateQueries({ queryKey: ["customer_tabs"] });
      // These flows remove the bill's payment rows via unmergeBill (F-13):
      // the payment split and drawer must refresh too.
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

/**
 * Voids a bill instead of deleting it: any merged sources get their dues
 * back exactly like an un-merge, and the bill itself flips to
 * `status: "cancelled"` — a historical record with no live due and no
 * revenue (see billDue/billCollected in dues.ts), distinct from
 * `useDeleteBill`, which removes the row entirely.
 */
export function useVoidBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await unmergeBill(id, { cancel: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["turf_bookings"] });
      qc.invalidateQueries({ queryKey: ["snack_sales"] });
      qc.invalidateQueries({ queryKey: ["tab_entries"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["team_players"] });
      qc.invalidateQueries({ queryKey: ["customer_tabs"] });
      // These flows remove the bill's payment rows via unmergeBill (F-13):
      // the payment split and drawer must refresh too.
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

/** Un-merges a bill but keeps it (its dues go back to the source records). */
export function useUnmergeBill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await unmergeBill(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["turf_bookings"] });
      qc.invalidateQueries({ queryKey: ["snack_sales"] });
      qc.invalidateQueries({ queryKey: ["tab_entries"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["team_players"] });
      qc.invalidateQueries({ queryKey: ["customer_tabs"] });
      // These flows remove the bill's payment rows via unmergeBill (F-13):
      // the payment split and drawer must refresh too.
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

export function useAddExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      category: string;
      note: string;
      amount: number;
    }) => {
      const now = nowIso();
      await db.expenses.add({
        id: newId(),
        expense_no: null,
        business: "Shared",
        category: payload.category,
        description: null,
        note: payload.note || null,
        amount: payload.amount,
        spent_at: now,
        receipt_path: null,
        created_at: now,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expenses_v2"] });
    },
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await db.expenses.delete(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expenses_v2"] });
    },
  });
}

export type CustomerRec = { id: string; name: string; phone: string | null };

const normName = (v: string | null | undefined) =>
  (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const normPhone = (v: string | null | undefined) =>
  (v ?? "").replace(/\D/g, "").slice(-10);

/** Identity key: phone wins when present, otherwise the normalised name. */
function customerKey(c: { name: string; phone: string | null }) {
  const p = normPhone(c.phone);
  return p ? `p:${p}` : `n:${normName(c.name)}`;
}

// Exported so other modules matching a bill/booking/sale back to a customer
// (e.g. the dashboard export's lifetime-spend rollup) use the exact same
// identity rules as the merge/dedupe logic above, instead of a second,
// possibly-drifting copy of "what counts as the same customer".
export { normName, normPhone, customerKey };

export type CustomerLifetime = {
  id: string;
  name: string;
  phone: string | null;
  bookingsCount: number;
  totalSpend: number;
  /** Revenue from standalone Bills matched to this customer. */
  billsSpend: number;
  /** Revenue from this customer's still-standalone turf bookings — i.e.
   *  isFinancialBooking() ones only. A booking merged into a bill has its
   *  value counted in billsSpend instead (excluded here to avoid
   *  double-counting); a Cancelled booking was never real revenue. */
  turfSpend: number;
  /** Revenue from snack sales matched to this customer. */
  snacksSpend: number;
  /** Average value per turf booking (all bookings, merged or not — this is
   *  a per-booking stat, not a cash total, so merge status doesn't matter). */
  avgBookingValue: number;
  /** Sum of bookingDue() (dues.ts) across this customer's unmerged turf
   *  bookings — tax-inclusive, tab-aware, the same figure the Turf tab, Dues
   *  tab and Dashboard show for the same booking. A booking merged into a
   *  bill is settled through that bill instead, matching the app-wide
   *  "Outstanding turf dues" convention. */
  outstandingTurfDues: number;
  /** Sum of billDue() across this customer's bills (tax-inclusive, tab-aware). */
  outstandingBillDues: number;
  /** This customer's running-tab balance (charges minus payments, never negative). */
  outstandingTab: number;
  /** Everything still owed: turf dues + bill dues + running tab — the same
   *  total customerOutstanding() (dues.ts) shows in the customer dialog. */
  outstandingTotal: number;
  /** ISO date of the earliest bill/booking/sale matched to this customer. */
  firstActivity: string | null;
  /** ISO date of the most recent bill/booking/sale matched to this customer. */
  lastActivity: string | null;
};

/**
 * Phone-first identity: when BOTH the saved customer and the record carry a
 * phone number, only the numbers are compared — two different people who
 * happen to share a name must never collapse into one row. Name matching is
 * the fallback only when at least one side has no phone at all.
 */
export function matchesCustomer(
  c: { name: string; phone: string | null },
  name: string | null | undefined,
  phone?: string | null,
) {
  const cPhone = normPhone(c.phone);
  const rPhone = normPhone(phone);
  if (cPhone && rPhone) return cPhone === rPhone;
  return normName(name) === normName(c.name);
}

/**
 * Looks up a phone number for a record type that doesn't store its own
 * (e.g. `SnackSale`, which only has `customer_name`) by exact saved-name
 * match — deliberately conservative: only returns something when exactly
 * one saved customer's name matches (their phone, which may itself be
 * null if they have none on file). Zero matches, more than one match, or
 * a matched customer with no saved phone, all return `null` rather than
 * guessing — `whatsappUrl()` already degrades gracefully for a
 * missing/invalid phone by opening WhatsApp's own contact picker instead
 * of silently messaging the wrong person, so `null` here is a safe,
 * ordinary outcome, not an error case to handle specially.
 */
export function customerPhoneForName(
  customers: CustomerRec[],
  name: string | null | undefined,
): string | null {
  const target = normName(name);
  if (!target) return null;
  const matches = customers.filter((c) => normName(c.name) === target);
  return matches.length === 1 ? matches[0]!.phone : null;
}

/**
 * Rolls up lifetime turf-booking count, total spend (bills + unmerged
 * bookings + snack sales) and everything still owed (turf dues + bill dues
 * + running tab) per saved customer, matched by the phone-first /
 * name-fallback identity rule in `matchesCustomer` — the same rule
 * `useMergeCustomers` uses when re-tagging records — kept as one function
 * so every screen agrees on "same customer or not".
 */
export function customerLifetimeStats(
  customers: CustomerRec[],
  data: {
    bills: (Pick<
      Bill,
      "customer_name" | "customer_phone" | "total" | "bill_date"
    > &
      Partial<
        Pick<
          Bill,
          | "id"
          | "status"
          | "amount_paid"
          | "payment_mode"
          | "tax_amount"
          | "tax_lines"
        >
      >)[];
    bookings: {
      id: string;
      customer_name: string;
      phone: string | null;
      total_amount: number;
      advance_paid: number;
      booking_date: string;
      status: string;
      merged_into_bill_id?: string | null;
      turf_amount: number;
      hours: number;
      rate_per_hour: number;
      courts: number;
      snacks_total?: number;
      discount?: number;
      tax_amount?: number;
      tax_lines?: { label: string; value: number }[];
    }[];
    sales: {
      customer_name: string | null;
      phone?: string | null;
      total: number;
      sale_date: string;
      merged_into_bill_id?: string | null;
      cancelled?: boolean;
    }[];
    tabEntries?: TabEntry[];
  },
): CustomerLifetime[] {
  // Index customers once according to the exact matchesCustomer rule:
  // records with a phone match phone-bearing customers by phone, while
  // phone-less customers fall back to name; records without a phone match by
  // name. This turns the old customers × rows scan into O(customers + rows).
  const byPhone = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  const byNameNoPhone = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string, i: number) => {
    if (!key) return;
    const xs = map.get(key);
    if (xs) xs.push(i);
    else map.set(key, [i]);
  };
  customers.forEach((c, i) => {
    const name = normName(c.name);
    const phone = normPhone(c.phone);
    push(byName, name, i);
    if (phone) push(byPhone, phone, i);
    else push(byNameNoPhone, name, i);
  });

  const matchIndexes = (
    name: string | null | undefined,
    phone: string | null | undefined,
  ) => {
    const p = normPhone(phone);
    if (p) {
      const result = [
        ...(byPhone.get(p) ?? []),
        ...(byNameNoPhone.get(normName(name)) ?? []),
      ];
      return result.length <= 1 ? result : [...new Set(result)];
    }
    return byName.get(normName(name)) ?? [];
  };

  const entriesByCustomerKey = new Map<string, TabEntry[]>();
  for (const e of data.tabEntries ?? []) {
    const xs = entriesByCustomerKey.get(e.customer_key);
    if (xs) xs.push(e);
    else entriesByCustomerKey.set(e.customer_key, [e]);
  }

  type Acc = CustomerLifetime;
  const acc: Acc[] = customers.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    bookingsCount: 0,
    totalSpend: 0,
    billsSpend: 0,
    turfSpend: 0,
    snacksSpend: 0,
    avgBookingValue: 0,
    outstandingTurfDues: 0,
    outstandingBillDues: 0,
    outstandingTab: 0,
    outstandingTotal: 0,
    firstActivity: null,
    lastActivity: null,
  }));
  const bump = (a: Acc, iso: string) => {
    if (!a.firstActivity || iso < a.firstActivity) a.firstActivity = iso;
    if (!a.lastActivity || iso > a.lastActivity) a.lastActivity = iso;
  };

  for (const b of data.bills) {
    for (const i of matchIndexes(b.customer_name, b.customer_phone)) {
      const a = acc[i]!;
      if (b.status !== "cancelled") a.billsSpend += Number(b.total) || 0;
      if (b.id && b.status) {
        const key = tabKey(customers[i]!.name, customers[i]!.phone);
        a.outstandingBillDues += billDue(
          b as Bill,
          entriesByCustomerKey.get(key) ?? [],
        );
      }
      bump(a, b.bill_date);
    }
  }
  for (const b of data.bookings) {
    for (const i of matchIndexes(b.customer_name, b.phone)) {
      const a = acc[i]!;
      a.bookingsCount += 1;
      a.avgBookingValue += Number(b.total_amount) || 0;
      if (isFinancialBooking(b)) {
        a.turfSpend += Number(b.total_amount) || 0;
        const key = tabKey(customers[i]!.name, customers[i]!.phone);
        a.outstandingTurfDues += bookingDue(
          b,
          entriesByCustomerKey.get(key) ?? [],
        );
      }
      bump(a, b.booking_date);
    }
  }
  for (const x of data.sales) {
    for (const i of matchIndexes(x.customer_name, x.phone)) {
      const a = acc[i]!;
      if (isFinancialSale(x)) a.snacksSpend += Number(x.total) || 0;
      bump(a, x.sale_date);
    }
  }
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i]!;
    const key = tabKey(customers[i]!.name, customers[i]!.phone);
    a.avgBookingValue =
      a.bookingsCount > 0 ? a.avgBookingValue / a.bookingsCount : 0;
    a.outstandingTab = Math.max(
      0,
      tabBalanceOf(entriesByCustomerKey.get(key) ?? []),
    );
    a.totalSpend = a.billsSpend + a.turfSpend + a.snacksSpend;
    a.outstandingTotal =
      a.outstandingTurfDues + a.outstandingBillDues + a.outstandingTab;
  }
  return acc;
}

/**
 * Customer-directory due index with the exact matchesCustomer identity rule.
 * Unlike customerOutstandingIndex(), this deliberately does not key records
 * by tabKey because the directory allows name fallback when only one side has
 * a phone number. Each source row is assigned once per matching saved customer
 * and customerOutstanding() then remains the single due formula.
 */
export function customerOutstandingByCustomer(
  customers: readonly { id: string; name: string; phone?: string | null }[],
  src: { bills?: Bill[]; bookings?: TurfBooking[]; tabEntries?: TabEntry[] },
) {
  const byPhone = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  const byNameNoPhone = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string, i: number) => {
    if (!key) return;
    const xs = map.get(key);
    if (xs) xs.push(i);
    else map.set(key, [i]);
  };
  customers.forEach((c, i) => {
    const name = normName(c.name);
    const phone = normPhone(c.phone);
    push(byName, name, i);
    if (phone) push(byPhone, phone, i);
    else push(byNameNoPhone, name, i);
  });
  const matches = (
    name: string | null | undefined,
    phone: string | null | undefined,
  ) => {
    const p = normPhone(phone);
    if (p)
      return [
        ...(byPhone.get(p) ?? []),
        ...(byNameNoPhone.get(normName(name)) ?? []),
      ];
    return byName.get(normName(name)) ?? [];
  };
  const bills = customers.map(() => [] as Bill[]);
  const bookings = customers.map(() => [] as TurfBooking[]);
  for (const b of src.bills ?? [])
    for (const i of matches(b.customer_name, b.customer_phone))
      bills[i]!.push(b);
  for (const b of src.bookings ?? [])
    for (const i of matches(b.customer_name, b.phone)) bookings[i]!.push(b);
  const entriesByKey = new Map<string, TabEntry[]>();
  for (const e of src.tabEntries ?? []) {
    const xs = entriesByKey.get(e.customer_key);
    if (xs) xs.push(e);
    else entriesByKey.set(e.customer_key, [e]);
  }
  const result = new Map<string, ReturnType<typeof customerOutstanding>>();
  customers.forEach((c, i) => {
    const key = tabKey(c.name, c.phone ?? null);
    result.set(
      c.id,
      customerOutstanding(
        { name: c.name, phone: c.phone ?? null },
        {
          bills: bills[i]!,
          bookings: bookings[i]!,
          tabEntries: entriesByKey.get(key) ?? [],
          // PF-06/D3: pin the documented matchesCustomer rule (phone if both
          // have one, else name) — customerOutstanding's default matcher is
          // phone-strict and silently diverged for phoneless records.
          match: (n, p) =>
            matchesCustomer(
              { name: c.name, phone: c.phone ?? null },
              n ?? "",
              p ?? null,
            ),
        },
      ),
    );
  });
  return result;
}

/** One-pass visit counts using the same identity semantics as customerLifetimeStats. */
export function customerVisitCounts(
  customers: CustomerRec[],
  data: {
    bills: Pick<Bill, "customer_name" | "customer_phone">[];
    bookings: TurfBooking[];
    sales: SnackSale[];
  },
): Map<string, number> {
  const byPhone = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  const byNameNoPhone = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string, i: number) => {
    if (!key) return;
    const xs = map.get(key);
    if (xs) xs.push(i);
    else map.set(key, [i]);
  };
  customers.forEach((c, i) => {
    const name = normName(c.name),
      phone = normPhone(c.phone);
    push(byName, name, i);
    if (phone) push(byPhone, phone, i);
    else push(byNameNoPhone, name, i);
  });
  const match = (
    name: string | null | undefined,
    phone: string | null | undefined,
  ) => {
    const p = normPhone(phone);
    return p
      ? [
          ...(byPhone.get(p) ?? []),
          ...(byNameNoPhone.get(normName(name)) ?? []),
        ]
      : (byName.get(normName(name)) ?? []);
  };
  const counts = new Array<number>(customers.length).fill(0);
  for (const b of data.bills)
    for (const i of match(b.customer_name, b.customer_phone)) counts[i]!++;
  for (const b of data.bookings) {
    if (!isFinancialBooking(b)) continue;
    for (const i of match(b.customer_name, b.phone)) counts[i]!++;
  }
  for (const x of data.sales) {
    if (!isFinancialSale(x)) continue;
    // Preserve CustomerDirectoryCard's legacy semantics: snack sales are
    // matched by saved customer name only because the original card passed
    // null for the sale phone field.
    for (const i of match(x.customer_name, null)) counts[i]!++;
  }
  return new Map(customers.map((c, i) => [c.id, counts[i] ?? 0]));
}

/** Collapse duplicate rows, keeping the richest record (one with a phone) per identity. */
function dedupeCustomers(rows: CustomerRec[]) {
  const byKey = new Map<string, CustomerRec>();
  const dupIds: string[] = [];
  for (const c of rows) {
    const key = customerKey(c);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      continue;
    }
    // keep whichever has a phone number; drop the other
    if (!normPhone(existing.phone) && normPhone(c.phone)) {
      dupIds.push(existing.id);
      byKey.set(key, c);
    } else {
      dupIds.push(c.id);
    }
  }
  return { unique: [...byKey.values()], dupIds };
}

async function loadCustomers(): Promise<CustomerRec[]> {
  const rows = sortBy(await db.customers.toArray(), "created_at", "desc");
  return rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone }));
}

/** Directory of saved customers — powers two-way name/phone autofill. */
export function useCustomers() {
  return useQuery({
    queryKey: ["customers"],
    // Cached/empty seed is only a first paint: mark it stale so the real
    // IndexedDB read still runs on mount (router sets refetchOnMount).
    initialDataUpdatedAt: 0,
    initialData: () => readCache<CustomerRec[]>("customers", []),
    queryFn: async () => {
      const { unique } = dedupeCustomers(await loadCustomers());
      writeCache("customers", unique);
      return unique;
    },
  });
}

export type SaveCustomerResult = "created" | "duplicate" | "updated";

export function useSaveCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      name: string;
      phone?: string | null;
    }): Promise<SaveCustomerResult> => {
      const name = payload.name.trim();
      const phone = (payload.phone ?? "").replace(/\D/g, "") || null;
      if (!name) throw new Error("Customer needs a name");

      const rows = await loadCustomers();
      const match =
        (phone
          ? rows.find((c) => normPhone(c.phone) === normPhone(phone))
          : undefined) ??
        (phone
          ? rows.find(
              (c) => normName(c.name) === normName(name) && !normPhone(c.phone),
            )
          : rows.find((c) => normName(c.name) === normName(name)));

      if (match) {
        const needsPhone = phone && !normPhone(match.phone);
        const needsName = name && normName(match.name) !== normName(name);
        if (!needsPhone && !needsName) return "duplicate";
        await db.customers.update(match.id, {
          name: needsName ? name : match.name,
          phone: needsPhone ? phone : match.phone,
        });
        return "updated";
      }

      await db.customers.add({
        id: newId(),
        name,
        phone,
        created_at: nowIso(),
      });
      return "created";
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

/**
 * Direct, id-based edit — for the Customers tab's explicit "Edit" action.
 * Deliberately separate from `useSaveCustomer` above: that hook's job is
 * name/phone-based upsert (autofill from Turf/Snacks/Bills, where there's no
 * customer id yet to key off of), so passing it an edited name *and* phone
 * for an existing row risks its match logic finding a different row (or
 * none) instead of updating this one in place. This hook always updates the
 * exact row `id` points at, and only refuses if the new phone collides with
 * a *different* saved customer.
 */
export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      name: string;
      phone?: string | null;
    }) => {
      const name = payload.name.trim();
      if (!name) throw new Error("Customer needs a name");
      const phone = (payload.phone ?? "").replace(/\D/g, "") || null;

      if (phone) {
        const rows = await loadCustomers();
        const clash = rows.find(
          (c) => c.id !== payload.id && normPhone(c.phone) === normPhone(phone),
        );
        if (clash) throw new Error(`Phone already saved for "${clash.name}"`);
      }

      await db.customers.update(payload.id, { name, phone });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

/** One-tap cleanup: permanently delete duplicate customer rows already stored. */
export function useCleanupDuplicateCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const { dupIds } = dedupeCustomers(await loadCustomers());
      if (!dupIds.length) return 0;
      await db.customers.bulkDelete(dupIds);
      return dupIds.length;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await db.transaction(
        "rw",
        [db.customers, db.teams, db.team_players, db.calendar_events],
        async () => {
          const teams = await db.teams
            .where("customer_id")
            .equals(id)
            .toArray();
          await db.team_players.bulkDelete(
            (
              await Promise.all(
                teams.map((t) =>
                  db.team_players.where("team_id").equals(t.id).primaryKeys(),
                ),
              )
            ).flat() as string[],
          );
          await db.teams.bulkDelete(teams.map((t) => t.id));
          await db.calendar_events
            .where("customer_id")
            .equals(id)
            .modify({ customer_id: null, updated_at: nowIso() });
          await db.customers.delete(id);
        },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["team_players"] });
    },
  });
}

/**
 * Manual merge: pick a "keep" customer and one or more "absorb" customers.
 * Every bill / turf booking / snack sale recorded under an absorbed customer's
 * old name+phone is re-pointed to the kept identity, then the absorbed
 * customer rows are deleted.
 */
export type MergeCustomersInput = {
  keep: CustomerRec;
  absorb: CustomerRec[];
  finalName: string;
  finalPhone: string | null;
};

/**
 * Re-tags every record owned by absorbed customers as one atomic operation.
 * Customer tabs/entries are part of the identity too: leaving their old
 * customer_key behind makes an absorbed customer's running balance disappear
 * from the merged customer. The transaction covers every store touched so a
 * failure halfway through cannot split one person's history across identities.
 */
export async function mergeCustomersAtomic(payload: MergeCustomersInput) {
  const finalName = payload.finalName.trim();
  const finalPhone = payload.finalPhone
    ? payload.finalPhone.replace(/\D/g, "")
    : null;
  if (!finalName) throw new Error("Merged customer needs a name");

  await db.transaction(
    "rw",
    [
      db.customers,
      db.bills,
      db.turf_bookings,
      db.snack_sales,
      db.customer_tabs,
      db.tab_entries,
      db.teams,
      db.team_players,
      db.calendar_events,
    ],
    async () => {
      const finalKey = tabKey(finalName, finalPhone);

      // Load the mutable tables ONCE, before the per-customer loop: the loop
      // only rewrites customer fields, never adds/removes rows, so each
      // absorb iteration can match against this single in-memory snapshot.
      // (Previously every absorbed customer re-scanned all three tables
      // inside one long-lived rw transaction — O(N x table) work and
      // long-task auto-commit risk at load-test scale.)
      const bills = await db.bills.toArray();
      const bookings = await db.turf_bookings.toArray();
      const sales = await db.snack_sales.toArray();

      for (const c of payload.absorb) {
        const nameMatch = normName(c.name);
        const oldKey = tabKey(c.name, c.phone);

        const billWrites = bills
          .filter((b) => matchesCustomer(c, b.customer_name, b.customer_phone))
          .map((b) => ({
            key: b.id,
            changes: { customer_name: finalName, customer_phone: finalPhone },
          }));
        if (billWrites.length) await db.bills.bulkUpdate(billWrites);

        const bookingWrites = bookings
          .filter((b) => matchesCustomer(c, b.customer_name, b.phone))
          .map((b) => ({
            key: b.id,
            changes: { customer_name: finalName, phone: finalPhone },
          }));
        if (bookingWrites.length)
          await db.turf_bookings.bulkUpdate(bookingWrites);

        // Snack sales have no phone field, so name-only matching is correct here.
        const saleWrites = sales
          .filter((s) => normName(s.customer_name as string) === nameMatch)
          .map((s) => ({ key: s.id, changes: { customer_name: finalName } }));
        if (saleWrites.length) await db.snack_sales.bulkUpdate(saleWrites);

        if (oldKey !== finalKey) {
          const tabs = await db.customer_tabs
            .where("customer_key")
            .equals(oldKey)
            .toArray();
          if (tabs.length)
            await db.customer_tabs.bulkUpdate(
              tabs.map((tab) => ({
                key: tab.id,
                changes: {
                  customer_key: finalKey,
                  customer_name: finalName,
                  phone: finalPhone,
                },
              })),
            );
          const entries = await db.tab_entries
            .where("customer_key")
            .equals(oldKey)
            .toArray();
          if (entries.length)
            await db.tab_entries.bulkUpdate(
              entries.map((entry) => ({
                key: entry.id,
                changes: { customer_key: finalKey },
              })),
            );
        }
      }

      const absorbIds = payload.absorb.map((c) => c.id);
      const calendarEvents = await db.calendar_events
        .where("customer_id")
        .anyOf(absorbIds)
        .toArray();
      if (calendarEvents.length)
        await db.calendar_events.bulkUpdate(
          calendarEvents.map((event) => ({
            key: event.id,
            changes: { customer_id: payload.keep.id, updated_at: nowIso() },
          })),
        );
      const survivingTeams = await db.teams
        .where("customer_id")
        .anyOf(absorbIds)
        .toArray();
      const existingTeams = await db.teams
        .where("customer_id")
        .equals(payload.keep.id)
        .toArray();
      const teamNames = new Set(
        existingTeams.map((t) => t.name.trim().toLowerCase()),
      );
      for (const team of survivingTeams) {
        if (teamNames.has(team.name.trim().toLowerCase())) {
          const target = existingTeams.find(
            (t) =>
              t.name.trim().toLowerCase() === team.name.trim().toLowerCase(),
          )!;
          const players = await db.team_players
            .where("team_id")
            .equals(team.id)
            .toArray();
          const targetPlayers = await db.team_players
            .where("team_id")
            .equals(target.id)
            .toArray();
          const existingPhones = new Set(
            targetPlayers
              .map((p) => {
                try {
                  return normalizePlayerPhone(p.phone);
                } catch {
                  return p.phone;
                }
              })
              .filter(Boolean),
          );
          const existingNames = new Set(
            targetPlayers.map((p) => p.name.trim().toLowerCase()),
          );
          for (const player of players) {
            const normalizedPhone = player.phone
              ? (() => {
                  try {
                    return normalizePlayerPhone(player.phone);
                  } catch {
                    return player.phone;
                  }
                })()
              : null;
            const duplicate = normalizedPhone
              ? existingPhones.has(normalizedPhone)
              : existingNames.has(player.name.trim().toLowerCase());
            if (!duplicate) {
              await db.team_players.update(player.id, {
                team_id: target.id,
                phone: normalizedPhone,
                updated_at: nowIso(),
              });
              if (normalizedPhone) existingPhones.add(normalizedPhone);
              existingNames.add(player.name.trim().toLowerCase());
            } else await db.team_players.delete(player.id);
          }
          await db.teams.delete(team.id);
        } else {
          await db.teams.update(team.id, {
            customer_id: payload.keep.id,
            updated_at: nowIso(),
          });
          teamNames.add(team.name.trim().toLowerCase());
        }
      }

      await db.customers.update(payload.keep.id, {
        name: finalName,
        phone: finalPhone,
      });

      if (absorbIds.length) await db.customers.bulkDelete(absorbIds);
    },
  );
}

export function useMergeCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: mergeCustomersAtomic,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["turf_bookings"] });
      qc.invalidateQueries({ queryKey: ["snack_sales"] });
      qc.invalidateQueries({ queryKey: ["customer_tabs"] });
      qc.invalidateQueries({ queryKey: ["tab_entries"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["team_players"] });
    },
  });
}
