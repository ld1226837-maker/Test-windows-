import Dexie from "dexie";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  db,
  type BillRow,
  type TurfBookingRow,
  type SnackSaleRow,
  type PaymentRow,
} from "./localdb";
import { isDesktop, removeAppDocument } from "./desktop";
import { sha256Hex } from "./receipts-share";
import { readStoredReceiptBytes } from "./backup";

/**
 * Year handling for the ledger.
 *
 * Every dated table is already indexed by its date column, so a year is fetched
 * with an indexed range query instead of loading the whole table — this is what
 * keeps the app responsive at 100k+ rows.
 */

/** Dated tables and the date column each one is filtered/indexed by. */
export const YEAR_TABLES = {
  bills: "bill_date",
  expenses: "spent_at",
  turf_bookings: "booking_date",
  snack_sales: "sale_date",
  history_entries: "created_at",
  snack_stock_history: "created_at",
  tab_entries: "entry_date",
  day_closes: "day",
  day_close_history: "amended_at",
  // Keyed by received_at (not a parent record's own date) so a payment
  // archives with the year the money actually arrived in. A payment can
  // never be received before its parent exists, so this is always the
  // same year as the parent or later — the parent can't already have been
  // archived out while a live payment against it remains (see
  // lib/archive.ts's oldest-year-first order).
  payments: "received_at",
  investments: "investment_date",
} as const;

export type YearTable = keyof typeof YEAR_TABLES;

/** How many years of data stay inside the app. Older years get archived out. */
export const RETAINED_YEARS = 3;

export const currentYear = () => new Date().getFullYear();

export const yearOf = (value: unknown) => {
  const s = String(value ?? "");
  const n = Number(s.slice(0, 4));
  return Number.isFinite(n) && n > 1900 ? n : 0;
};

export const yearStart = (year: number) => `${year}-01-01`;
export const yearEndExclusive = (year: number) => `${year + 1}-01-01`;

/** Stable JSON used for destructive-operation race detection. */
function stableYearValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableYearValue).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableYearValue((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Fingerprints exactly the rows/photos that deleteYear(year) would remove.
 * The fingerprint is deliberately order-independent so harmless IndexedDB
 * iteration order changes do not abort an archive.
 */
export async function yearDeletionFingerprintFromSnapshot(
  tables: Record<string, unknown>,
  receipts: Record<string, unknown>,
): Promise<string> {
  const normalizedTables: Record<string, unknown> = {};
  for (const name of Object.keys(YEAR_TABLES)) {
    const rows = Array.isArray(tables[name]) ? (tables[name] as unknown[]) : [];
    normalizedTables[name] = rows.map(stableYearValue).sort();
  }
  return sha256Hex(
    new TextEncoder().encode(
      stableYearValue({ tables: normalizedTables, receipts }),
    ),
  );
}

export async function yearDeletionFingerprint(year: number): Promise<string> {
  const tables: Record<string, unknown> = {};
  for (const name of Object.keys(YEAR_TABLES) as YearTable[]) {
    const rows = await rowsForArchiveYear(name, year);
    tables[name] = [...rows].map(stableYearValue).sort();
  }

  const expenses = await rowsForYear<{ receipt_path: string | null }>(
    "expenses",
    year,
  );
  const investments = await rowsForYear<{ receipt_path: string | null }>(
    "investments",
    year,
  );
  const bills = await rowsForYear<{ receipt_path: string | null }>(
    "bills",
    year,
  );
  const paths = [
    ...new Set(
      [
        ...expenses.map((e) => e.receipt_path),
        ...investments.map((e) => e.receipt_path),
        ...bills.map((e) => e.receipt_path),
      ].filter((p): p is string => !!p),
    ),
  ].sort();

  const receipts: Record<string, unknown> = {};
  for (const path of paths) {
    const photo = await db.receipts.get(path);
    const hash = await db.receipt_hashes.get(path);
    let size = photo?.size ?? photo?.blob?.size ?? null;
    let actualSha: string | null = null;
    try {
      const bytes = await readStoredReceiptBytes(path);
      size = bytes.length;
      actualSha = await sha256Hex(bytes);
    } catch {
      // A missing/unreadable photo deliberately fingerprints differently from
      // a valid archive snapshot, so destructive deletion aborts.
    }
    receipts[path] = {
      size,
      sha256: actualSha ?? hash?.sha256 ?? null,
      created_at: photo?.created_at ?? null,
    };
  }

  return yearDeletionFingerprintFromSnapshot(tables, receipts);
}

/** All rows of one dated table for one year, via the date index. */
export async function rowsForYear<T = Record<string, unknown>>(
  name: YearTable,
  year: number,
): Promise<T[]> {
  const field = YEAR_TABLES[name];
  const tbl = db[name] as unknown as {
    where: (f: string) => {
      between: (
        a: string,
        b: string,
        ia: boolean,
        ib: boolean,
      ) => { toArray: () => Promise<T[]> };
    };
  };
  return tbl
    .where(field)
    .between(yearStart(year), yearEndExclusive(year), true, false)
    .toArray();
}

/** Rows that belong in a year archive. Payments follow both sides of their
 * lifecycle: money received in the target year, or money received later for a
 * parent record dated in the target year. The latter prevents an old bill from
 * being archived while its later collection is left behind as an orphan. */
export async function rowsForArchiveYear<T = Record<string, unknown>>(
  name: YearTable,
  year: number,
): Promise<T[]> {
  if (name !== "payments") return rowsForYear<T>(name, year);

  const [received, bills, bookings, sales] = await Promise.all([
    db.payments
      .where("received_at")
      .between(yearStart(year), yearEndExclusive(year), true, false)
      .toArray(),
    rowsForYear<BillRow>("bills", year),
    rowsForYear<TurfBookingRow>("turf_bookings", year),
    rowsForYear<SnackSaleRow>("snack_sales", year),
  ]);
  const parentIds = new Set<string>([
    ...bills.map((r) => `bill:${r.id}`),
    ...bookings.map((r) => `turf_booking:${r.id}`),
    ...sales.map((r) => `snack_sale:${r.id}`),
  ]);
  const ids = [
    ...new Set([
      ...bills.map((r) => r.id),
      ...bookings.map((r) => r.id),
      ...sales.map((r) => r.id),
    ]),
  ];
  const parentPayments = ids.length
    ? await db.payments.where("parent_id").anyOf(ids).toArray()
    : [];
  const out = new Map<string, PaymentRow>();
  for (const p of [...received, ...parentPayments]) {
    if (
      yearOf(p.received_at) === year ||
      parentIds.has(`${p.parent_type}:${p.parent_id}`)
    )
      out.set(p.id, p);
  }
  return [...out.values()] as T[];
}

/** Rows for a set of years (used by the screens, which show the selected year). */
export async function rowsForYears<T = Record<string, unknown>>(
  name: YearTable,
  years: number[] | "all",
): Promise<T[]> {
  if (years === "all")
    return await (
      db[name] as never as { toArray: () => Promise<T[]> }
    ).toArray();
  const out: T[] = [];
  for (const y of years) out.push(...(await rowsForYear<T>(name, y)));
  return out;
}

export async function countForYear(name: YearTable, year: number) {
  const field = YEAR_TABLES[name];
  const tbl = db[name] as unknown as {
    where: (f: string) => {
      between: (
        a: string,
        b: string,
        ia: boolean,
        ib: boolean,
      ) => { count: () => Promise<number> };
    };
  };
  return tbl
    .where(field)
    .between(yearStart(year), yearEndExclusive(year), true, false)
    .count();
}

/** Distinct years present across every dated table, ascending. */
export async function distinctYears(): Promise<number[]> {
  const found = new Set<number>();
  for (const [name, field] of Object.entries(YEAR_TABLES) as [
    YearTable,
    string,
  ][]) {
    const tbl = db[name] as unknown as {
      orderBy: (f: string) => {
        eachUniqueKey?: (cb: (k: unknown) => void) => Promise<void>;
        keys: () => Promise<unknown[]>;
      };
    };
    try {
      const keys = await tbl.orderBy(field).keys();
      for (const k of keys) {
        const y = yearOf(k);
        if (y) found.add(y);
      }
    } catch {
      /* table missing/empty — skip */
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Deletes every row of one year from the dated tables. Returns rows removed. */
export async function deleteYear(year: number, expectedFingerprint?: string) {
  let removed = 0;

  // Tab entries are part of the year archive, but an open tab may still use
  // those historical entries to derive its live balance. Archiving them would
  // silently change money owed, so require the tab to be closed first.
  const targetEntries = await rowsForYear<{
    id: string;
    tab_id: string;
    entry_date: string;
  }>("tab_entries", year);
  if (targetEntries.length) {
    const tabIds = new Set(targetEntries.map((e) => e.tab_id));
    for (const tabId of tabIds) {
      const tab = await db.customer_tabs.get(tabId);
      if (tab?.status === "open") {
        throw new Error(
          `Can't archive ${year}: customer tab ${tab.customer_name || tab.customer_key} is still open and has entries from that year. Settle/close the tab first.`,
        );
      }
    }
  }

  // Receipt photos are not independently dated. They are archived with the
  // expense rows that reference them. A path must not be shared by an expense
  // outside the target year; otherwise deleting it would damage live data.
  const expenses = await rowsForYear<{ receipt_path: string | null }>(
    "expenses",
    year,
  );
  const investments = await rowsForYear<{ receipt_path: string | null }>(
    "investments",
    year,
  );
  const receiptPaths = new Set(
    [
      ...expenses.map((e) => e.receipt_path),
      ...investments.map((e) => e.receipt_path),
    ].filter((p): p is string => !!p),
  );
  if (receiptPaths.size) {
    const allExpenses = await db.expenses.toArray();
    const allInvestments = await db.investments.toArray();
    const allBills = await db.bills.toArray();
    for (const path of receiptPaths) {
      const sharedExpense = allExpenses.some(
        (e) => e.receipt_path === path && yearOf(e.spent_at) !== year,
      );
      const sharedInvestment = allInvestments.some(
        (e) => e.receipt_path === path && yearOf(e.investment_date) !== year,
      );
      const sharedBill = allBills.some(
        (e) => e.receipt_path === path && yearOf(e.bill_date) !== year,
      );
      if (sharedExpense || sharedInvestment || sharedBill)
        throw new Error(
          `Can't archive ${year}: receipt ${path} is referenced by another year's expense, investment, or bill.`,
        );
    }
  }

  const tables = (Object.keys(YEAR_TABLES) as YearTable[]).map((t) => db[t]);
  let receiptPathsInTransaction: string[] = [];
  let yearPaymentsInTransaction: { id: string }[] = [];

  // All destructive preconditions and the fingerprint comparison happen
  // inside the same write transaction as the deletes. The previous version
  // checked the fingerprint before opening the transaction, leaving a race
  // window in which a payment/edit/receipt replacement could land after the
  // check but before the delete.
  await db.transaction(
    "rw",
    [...tables, db.customer_tabs, db.receipts, db.receipt_hashes],
    async () => {
      const targetEntriesInTransaction = await rowsForYear<{
        id: string;
        tab_id: string;
        entry_date: string;
      }>("tab_entries", year);
      if (targetEntriesInTransaction.length) {
        const tabIds = new Set(targetEntriesInTransaction.map((e) => e.tab_id));
        for (const tabId of tabIds) {
          const tab = await db.customer_tabs.get(tabId);
          if (tab?.status === "open") {
            throw new Error(
              `Can't archive ${year}: customer tab ${tab.customer_name || tab.customer_key} is still open and has entries from that year. Settle/close the tab first.`,
            );
          }
        }
      }

      const txExpenses = await rowsForYear<{ receipt_path: string | null }>(
        "expenses",
        year,
      );
      const txInvestments = await rowsForYear<{ receipt_path: string | null }>(
        "investments",
        year,
      );
      const txBills = await rowsForYear<{ receipt_path: string | null }>(
        "bills",
        year,
      );
      const txReceiptPaths = [
        ...new Set(
          [
            ...txExpenses.map((e) => e.receipt_path),
            ...txInvestments.map((e) => e.receipt_path),
            ...txBills.map((e) => e.receipt_path),
          ].filter((p): p is string => !!p),
        ),
      ].sort();
      for (const path of txReceiptPaths) {
        const sharedExpense = await db.expenses
          .filter((e) => e.receipt_path === path && yearOf(e.spent_at) !== year)
          .first();
        const sharedInvestment = await db.investments
          .filter(
            (e) =>
              e.receipt_path === path && yearOf(e.investment_date) !== year,
          )
          .first();
        const sharedBill = await db.bills
          .filter(
            (e) => e.receipt_path === path && yearOf(e.bill_date) !== year,
          )
          .first();
        if (sharedExpense || sharedInvestment || sharedBill) {
          throw new Error(
            `Can't archive ${year}: receipt ${path} is referenced by another year's expense, investment, or bill.`,
          );
        }
      }

      // This read is intentionally inside the write transaction. IndexedDB
      // serializes competing writes, so the fingerprint and the destructive
      // deletes now observe one consistent transaction snapshot.
      if (expectedFingerprint) {
        // WebCrypto is not an IndexedDB request. Keep the Dexie transaction
        // alive explicitly while the SHA-256 promise resolves; otherwise a
        // long fingerprint can let the transaction auto-commit before the
        // destructive deletes below, reopening the race this guard closes.
        const actualFingerprint = await Dexie.waitFor(
          yearDeletionFingerprint(year),
        );
        if (actualFingerprint !== expectedFingerprint) {
          throw new Error(
            `Archive ${year} is stale: the year's data changed after the archive snapshot. Nothing was deleted; create the archive again.`,
          );
        }
      }

      receiptPathsInTransaction = txReceiptPaths;
      yearPaymentsInTransaction = await rowsForArchiveYear<{ id: string }>(
        "payments",
        year,
      );

      for (const [name, field] of Object.entries(YEAR_TABLES) as [
        YearTable,
        string,
      ][]) {
        if (name === "payments") {
          if (yearPaymentsInTransaction.length) {
            await db.payments.bulkDelete(
              yearPaymentsInTransaction.map((p) => p.id),
            );
            removed += yearPaymentsInTransaction.length;
          }
          continue;
        }
        const tbl = db[name] as unknown as {
          where: (f: string) => {
            between: (
              a: string,
              b: string,
              ia: boolean,
              ib: boolean,
            ) => { delete: () => Promise<number> };
          };
        };
        removed += await tbl
          .where(field)
          .between(yearStart(year), yearEndExclusive(year), true, false)
          .delete();
      }
      for (const path of receiptPathsInTransaction) {
        removed += await db.receipts
          .delete(path)
          .then(() => 1)
          .catch(() => 0);
        removed += await db.receipt_hashes
          .delete(path)
          .then(() => 1)
          .catch(() => 0);
      }
    },
  );
  // Only after the transaction committed: remove the archived photos' files
  // from disk (desktop/Android keep the bytes there, not in IndexedDB).
  if (isDesktop()) {
    for (const path of receiptPathsInTransaction) await removeAppDocument(path);
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* Selected year (shared across screens)                               */
/* ------------------------------------------------------------------ */

const KEY = "ks:selected-year";
const EVENT = "ks:selected-year-changed";

export function readSelectedYear(): number {
  if (typeof window === "undefined") return currentYear();
  const raw = window.localStorage.getItem(KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 1900 ? n : currentYear();
}

export function writeSelectedYear(year: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, String(year));
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * The year the screens are showing. It follows the calendar automatically: when
 * a new year begins the app simply switches to it, no action needed. Stored
 * selections from older years are kept until the user changes them.
 */
export function useSelectedYear() {
  const [year, setYear] = useState<number>(() => readSelectedYear());
  const autoCorrected = useRef(false);

  useEffect(() => {
    const sync = () => setYear(readSelectedYear());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // The starting year (from localStorage, or this calendar year by default)
  // can point at a year the ledger has nothing in — e.g. after restoring a
  // backup dated in an earlier year, or opening a profile whose data was
  // seeded for a different year — which silently renders every screen empty
  // with no clue why. Once, on load, if that year has no data but another
  // year does, jump to the most recent year that actually has data. This only
  // runs on mount: a deliberate later selection of an empty year (planning
  // ahead for next year, say) is left alone.
  useEffect(() => {
    if (autoCorrected.current) return;
    let alive = true;
    distinctYears().then((years) => {
      if (!alive || autoCorrected.current) return;
      autoCorrected.current = true;
      if (years.length === 0 || years.includes(year)) return;
      const latest = years[years.length - 1];
      if (latest === undefined) return;
      writeSelectedYear(latest);
      toast.info(`Showing ${latest} — no data for ${year}`);
    });
    return () => {
      alive = false;
    };
    // Deliberately mount-only: re-running on every `year` change would also
    // fire after the user picks an empty year on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [year, writeSelectedYear] as const;
}

/** Years that should appear in the picker: everything in the db plus this year. */
export function useAvailableYears() {
  const [years, setYears] = useState<number[]>([currentYear()]);
  useEffect(() => {
    let alive = true;
    distinctYears().then((list) => {
      if (!alive) return;
      const all = new Set([...list, currentYear()]);
      setYears([...all].sort((a, b) => b - a));
    });
    return () => {
      alive = false;
    };
  }, []);
  return years;
}

/**
 * Years the screens load for a selection. During January the previous year is
 * included too, so "yesterday"/last-month comparisons still work right after a
 * year rollover.
 */
export function yearsWindow(selected: number) {
  const now = new Date();
  return selected === now.getFullYear() && now.getMonth() === 0
    ? [selected - 1, selected]
    : [selected];
}

/** React helper: the year window currently being displayed. */
export function useYearWindow() {
  const [year] = useSelectedYear();
  return { year, years: yearsWindow(year) };
}
