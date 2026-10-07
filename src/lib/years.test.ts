// @vitest-environment jsdom
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db, nowIso, type BillRow, type TurfBookingRow } from "./localdb";
import {
  countForYear,
  deleteYear,
  yearDeletionFingerprint,
  yearDeletionFingerprintFromSnapshot,
  rowsForArchiveYear,
  distinctYears,
  rowsForYear,
  YEAR_TABLES,
  yearOf,
  type YearTable,
} from "./years";
import { archiveYear, buildYearArchive, yearRowCount } from "./archive";
import { closeDay } from "./day-close";
import { sha256Hex } from "./receipts-share";

function billRow(over: Partial<BillRow> = {}): BillRow {
  return {
    id: "b1",
    invoice_no: "INV-1",
    customer_name: "Ravi",
    customer_phone: "9876543210",
    items: [],
    subtotal: 1000,
    discount: 0,
    total: 1000,
    amount_paid: 1000,
    status: "paid",
    payment_mode: "Cash",
    bill_date: "2025-06-01",
    created_at: "2025-06-01T10:00:00.000Z",
    ...over,
  };
}

function bookingRow(over: Partial<TurfBookingRow> = {}): TurfBookingRow {
  return {
    id: "bk1",
    booking_no: "BK-1",
    booking_date: "2025-06-01",
    customer_name: "Ravi",
    phone: "9876543210",
    slot_name: "Court 1",
    start_time: "10:00",
    end_time: "11:00",
    total_amount: 500,
    advance_paid: 500,
    status: "Confirmed",
    created_at: "2025-06-01T10:00:00.000Z",
    ...over,
  } as TurfBookingRow;
}

beforeEach(async () => {
  for (const name of Object.keys(YEAR_TABLES) as YearTable[])
    await db[name].clear();
  await db.customer_tabs.clear();
  await db.receipts.clear();
  await db.receipt_hashes.clear();
});

describe("yearOf", () => {
  it("reads a 4-digit year off the front of a date/timestamp string", () => {
    expect(yearOf("2025-06-01")).toBe(2025);
    expect(yearOf("2025-06-01T10:00:00.000Z")).toBe(2025);
  });
  it("returns 0 for anything that isn't a plausible year", () => {
    expect(yearOf(null)).toBe(0);
    expect(yearOf("")).toBe(0);
    expect(yearOf("abcd")).toBe(0);
  });
});

describe("deleteYear", () => {
  it("removes only the target year's rows, across every dated table, and leaves other years untouched", async () => {
    await db.bills.add(billRow({ id: "b-2025", bill_date: "2025-06-01" }));
    await db.bills.add(billRow({ id: "b-2026", bill_date: "2026-01-05" }));
    await db.turf_bookings.add(
      bookingRow({ id: "bk-2025", booking_date: "2025-12-31" }),
    );
    await db.turf_bookings.add(
      bookingRow({ id: "bk-2026", booking_date: "2026-01-01" }),
    );

    const removed = await deleteYear(2025);

    expect(removed).toBe(2);
    expect(await db.bills.get("b-2025")).toBeUndefined();
    expect(await db.bills.get("b-2026")).toBeDefined();
    expect(await db.turf_bookings.get("bk-2025")).toBeUndefined();
    expect(await db.turf_bookings.get("bk-2026")).toBeDefined();
  });

  it("is a no-op (0 removed) for a year with no data in any table", async () => {
    expect(await deleteYear(1999)).toBe(0);
  });

  it("aborts instead of deleting rows when the archived year changed after snapshot", async () => {
    await db.bills.add(
      billRow({ id: "b-race", bill_date: "2025-06-01", amount_paid: 100 }),
    );
    const fingerprint = await yearDeletionFingerprint(2025);

    await db.bills.update("b-race", { amount_paid: 75 });

    await expect(deleteYear(2025, fingerprint)).rejects.toThrow(/stale/i);
    expect(await db.bills.get("b-race")).toBeDefined();
  });

  it("aborts when receipt bytes change after the archive snapshot, even if size and stored hash stay unchanged", async () => {
    const path = "Receipts/2025/race.jpg";
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([9, 8, 7, 6]);
    await db.expenses.add(
      billRow({
        id: "b-receipt-race",
        bill_date: "2025-06-01",
        receipt_path: path,
      } as any) as any,
    );
    await db.receipts.put({
      path,
      blob: new Blob([first]),
      size: first.length,
      created_at: nowIso(),
    } as any);
    const snapshotTables: Record<string, unknown> = {};
    for (const name of Object.keys(YEAR_TABLES))
      snapshotTables[name] = await rowsForArchiveYear(name as any, 2025);
    const expected = await yearDeletionFingerprintFromSnapshot(snapshotTables, {
      [path]: {
        size: first.length,
        sha256: await sha256Hex(first),
        created_at: (await db.receipts.get(path))!.created_at,
      },
    });
    // Simulate an in-place photo replacement that did not update the legacy
    // capture-time hash row. The deletion guard must compare actual bytes.
    await db.receipts.put({
      path,
      blob: new Blob([second]),
      size: second.length,
      created_at: (await db.receipts.get(path))!.created_at,
    } as any);
    await expect(deleteYear(2025, expected)).rejects.toThrow(/stale/i);
    expect(await db.expenses.get("b-receipt-race")).toBeDefined();
  });

  it("aborts when a new row or payment appears after the archive snapshot", async () => {
    await db.bills.add(billRow({ id: "b-race-2", bill_date: "2025-06-01" }));
    const fingerprint = await yearDeletionFingerprint(2025);

    await db.payments.add({
      id: "p-race-2",
      parent_type: "bill",
      parent_id: "b-race-2",
      amount: 10,
      mode: "Cash",
      received_at: "2025-06-02",
      created_at: "2025-06-02T10:00:00.000Z",
    } as any);

    await expect(deleteYear(2025, fingerprint)).rejects.toThrow(/stale/i);
    expect(await db.bills.get("b-race-2")).toBeDefined();
    expect(await db.payments.get("p-race-2")).toBeDefined();
  });

  it("deletes only after the expected fingerprint still matches", async () => {
    await db.bills.add(billRow({ id: "b-safe", bill_date: "2025-06-01" }));
    const fingerprint = await yearDeletionFingerprint(2025);
    await expect(deleteYear(2025, fingerprint)).resolves.toBe(1);
    expect(await db.bills.get("b-safe")).toBeUndefined();
  });
});

describe("distinctYears / countForYear / rowsForYear", () => {
  it("agree on which years exist and how many rows each holds", async () => {
    await db.bills.add(billRow({ id: "b-2025", bill_date: "2025-06-01" }));
    await db.bills.add(billRow({ id: "b-2025-2", bill_date: "2025-11-01" }));
    await db.bills.add(billRow({ id: "b-2026", bill_date: "2026-01-05" }));

    expect(await distinctYears()).toEqual([2025, 2026]);
    expect(await countForYear("bills", 2025)).toBe(2);
    expect(await countForYear("bills", 2026)).toBe(1);
    expect((await rowsForYear("bills", 2025)).length).toBe(2);
  });
});

describe("archiveYear — current-year rejection", () => {
  it("refuses to archive the current year, before touching Telegram/files/DB", async () => {
    const thisYear = new Date().getFullYear();
    await db.bills.add(
      billRow({ id: "b-current", bill_date: `${thisYear}-06-01` }),
    );

    await expect(archiveYear(thisYear)).rejects.toThrow(/current year/i);

    // Nothing was touched: the row is still there.
    expect(await db.bills.get("b-current")).toBeDefined();
  });
});

describe("schema migrations", () => {
  const storesByVersion: Record<number, Record<string, string>> = {
    1: {
      customers: "id, name, phone, created_at",
      bills:
        "id, invoice_no, bill_date, customer_name, customer_phone, created_at",
      expenses: "id, spent_at, category, business, created_at",
      history_entries: "id, created_at",
      turf_rates: "id, slot_name, created_at",
      snack_items: "id, item_name, created_at",
      turf_bookings:
        "id, booking_no, booking_date, customer_name, phone, created_at",
      snack_sales: "id, bill_no, sale_date, customer_name, created_at",
      snack_combos: "id, name, created_at",
      expense_budgets: "id, month",
      recurring_expenses: "id, created_at",
      receipts: "path",
    },
    4: {
      customers: "id, name, phone, created_at",
      bills:
        "id, invoice_no, bill_date, customer_name, customer_phone, created_at",
      expenses: "id, spent_at, category, business, created_at",
      history_entries: "id, created_at",
      turf_rates: "id, slot_name, created_at",
      snack_items: "id, item_name, created_at",
      snack_stock_history: "id, item_id, created_at",
      turf_bookings:
        "id, booking_no, booking_date, customer_name, phone, created_at",
      snack_sales: "id, bill_no, sale_date, customer_name, created_at",
      snack_combos: "id, name, created_at",
      expense_budgets: "id, month",
      recurring_expenses: "id, created_at",
      receipts: "path",
      counters: "key",
      customer_tabs: "id, customer_key, status, created_at",
      tab_entries: "id, tab_id, customer_key, kind, created_at",
    },
    7: {
      customers: "id, name, phone, created_at",
      bills:
        "id, invoice_no, bill_date, customer_name, customer_phone, created_at",
      expenses: "id, spent_at, category, business, created_at",
      history_entries: "id, created_at",
      turf_rates: "id, slot_name, created_at",
      snack_items: "id, item_name, created_at",
      snack_stock_history: "id, item_id, created_at",
      turf_bookings:
        "id, booking_no, booking_date, customer_name, phone, created_at",
      snack_sales: "id, bill_no, sale_date, customer_name, created_at",
      snack_combos: "id, name, created_at",
      expense_budgets: "id, month",
      recurring_expenses: "id, created_at",
      receipts: "path",
      counters: "key",
      customer_tabs: "id, customer_key, status, created_at",
      tab_entries: "id, tab_id, customer_key, kind, ref_id, created_at",
      app_settings: "key",
      receipt_hashes: "path",
    },
    9: {
      customers: "id, name, phone, created_at",
      bills:
        "id, invoice_no, bill_date, customer_name, customer_phone, created_at",
      expenses: "id, spent_at, category, business, created_at",
      history_entries: "id, created_at",
      turf_rates: "id, slot_name, created_at",
      snack_items: "id, item_name, created_at",
      snack_stock_history: "id, item_id, created_at",
      turf_bookings:
        "id, booking_no, booking_date, customer_name, phone, created_at",
      snack_sales: "id, bill_no, sale_date, customer_name, created_at",
      snack_combos: "id, name, created_at",
      expense_budgets: "id, month",
      recurring_expenses: "id, created_at",
      receipts: "path",
      counters: "key",
      customer_tabs: "id, customer_key, status, created_at",
      tab_entries: "id, tab_id, customer_key, kind, ref_id, created_at",
      app_settings: "key",
      receipt_hashes: "path",
      day_closes: "id, day, created_at",
      day_close_history: "id, day, amended_at",
    },
  };

  for (const startVersion of [1, 4, 7, 9]) {
    it(`upgrades a v${startVersion} database without losing rows`, async () => {
      db.close();
      await Dexie.delete("turf-ledger");
      const old = new Dexie("turf-ledger");
      old.version(startVersion).stores(storesByVersion[startVersion]!);
      await old.open();
      await old.table("customers").add({
        id: "legacy-c",
        name: "Legacy",
        phone: null,
        created_at: "2025-01-01",
      });
      await old.table("snack_sales").add({
        id: "legacy-s",
        bill_no: "SB-1",
        sale_date: "2025-01-02",
        customer_name: "Legacy",
        items: [],
        total: 100,
        profit: 20,
        payment_mode: "Cash",
        notes: null,
        booking_id: null,
        booking_no: null,
        created_at: "2025-01-02",
      });
      if (startVersion >= 4)
        await old
          .table("counters")
          .put({ key: "invoice:2025", value: 7, updated_at: "2025-01-02" });
      await old.close();
      await db.open();

      expect(await db.customers.get("legacy-c")).toBeDefined();
      const sale = await db.snack_sales.get("legacy-s");
      expect(sale).toBeDefined();
      expect(sale?.merged_into_bill_id).toBeNull();
      if (startVersion >= 4)
        expect(await db.counters.get("invoice:2025")).toMatchObject({
          value: 7,
        });
      else expect(await db.counters.count()).toBe(0);
      expect(await db.payments.count()).toBe(0);
      expect(await db.day_closes.count()).toBe(0);
      expect(await db.day_close_history.count()).toBe(0);
      expect(await db.receipt_hashes.count()).toBe(0);
    });
  }
});

describe("year archive coverage", () => {
  it("has an IndexedDB entry_date index for tab-year filtering", async () => {
    await db.tab_entries.add({
      id: "index-check",
      tab_id: "tab",
      customer_key: "n:ravi",
      kind: "charge",
      business: "Turf",
      amount: 1,
      note: null,
      ref_type: null,
      ref_id: null,
      entry_date: "2025-01-02",
      created_at: "2025-01-02T00:00:00.000Z",
    });
    expect(await rowsForYear("tab_entries", 2025)).toHaveLength(1);
  });

  it("archives every year-owned ledger table plus receipt blobs/hashes", async () => {
    const year = 2025;
    await db.snack_stock_history.add({
      id: "sh-1",
      item_id: "snack-1",
      item_name: "Water",
      delta: -1,
      previous_quantity: 5,
      new_quantity: 4,
      created_at: "2025-05-02T10:00:00.000Z",
    });
    await db.tab_entries.add({
      id: "te-1",
      tab_id: "tab-1",
      customer_key: "n:ravi",
      kind: "charge",
      business: "Snacks",
      amount: 100,
      note: null,
      ref_type: "snack_sale",
      ref_id: "s1",
      entry_date: "2025-05-03",
      created_at: "2025-05-03T10:00:00.000Z",
    });
    await db.customer_tabs.add({
      id: "tab-1",
      customer_key: "n:ravi",
      customer_name: "Ravi",
      phone: null,
      status: "closed",
      opened_at: "2025-05-01T10:00:00.000Z",
      closed_at: "2025-05-04T10:00:00.000Z",
      created_at: "2025-05-01T10:00:00.000Z",
    });
    await db.day_closes.add({
      id: "dc-1",
      day: "2025-05-05",
      expected_in_drawer: 500,
      counted_cash: 500,
      variance: 0,
      note: null,
      closed_at: "2025-05-05T18:00:00.000Z",
      created_at: "2025-05-05T18:00:00.000Z",
    });
    await db.day_close_history.add({
      id: "dch-1",
      day: "2025-05-05",
      previous_expected_in_drawer: 400,
      previous_counted_cash: 390,
      previous_variance: -10,
      previous_note: "old",
      previous_closed_at: "2025-05-05T17:00:00.000Z",
      amended_at: "2025-05-05T18:00:00.000Z",
    });
    await db.bills.add(billRow({ id: "b-1", bill_date: "2025-05-01" }));
    await db.payments.add({
      id: "pay-1",
      parent_type: "bill",
      parent_id: "b-1",
      amount: 100,
      mode: "Cash",
      received_at: "2025-05-06",
      created_at: "2025-05-06T10:00:00.000Z",
    });
    await db.payments.add({
      id: "pay-late",
      parent_type: "bill",
      parent_id: "b-1",
      amount: 50,
      mode: "UPI",
      received_at: "2026-01-03",
      created_at: "2026-01-03T10:00:00.000Z",
    });
    const blob = new Blob(["receipt"], { type: "image/jpeg" });
    await db.receipts.put({
      path: "Receipts/2025/r.jpg",
      blob,
      created_at: "2025-05-07T10:00:00.000Z",
    });
    await db.receipt_hashes.put({
      path: "Receipts/2025/r.jpg",
      sha256: await sha256Hex(new Uint8Array(await blob.arrayBuffer())),
      created_at: "2025-05-07T10:00:00.000Z",
    });
    await db.expenses.add({
      id: "e-1",
      expense_no: "TX-1",
      business: "Turf",
      category: "Other",
      description: null,
      note: null,
      amount: 50,
      spent_at: "2025-05-07T10:00:00.000Z",
      receipt_path: "Receipts/2025/r.jpg",
      created_at: "2025-05-07T10:00:00.000Z",
    });

    const archive = await buildYearArchive(year);
    // R4: year archives are version 3 - photos travel in a manifest +
    // download container (serializeBackupBytes), not inline base64.
    expect(archive.version).toBe(3);
    expect(archive.tables["snack_stock_history"]).toHaveLength(1);
    expect(archive.tables["tab_entries"]).toHaveLength(1);
    expect(archive.tables["day_closes"]).toHaveLength(1);
    expect(archive.tables["day_close_history"]).toHaveLength(1);
    expect(archive.tables["payments"]).toHaveLength(2);
    expect(archive.photos).toBeUndefined();
    expect(archive.photo_manifest).toHaveLength(1);
    expect(archive.photo_manifest?.[0]?.path).toBe("Receipts/2025/r.jpg");
    expect(archive.receipt_hashes).toHaveLength(1);
    expect(await yearRowCount(year)).toBe(10);

    const removed = await deleteYear(year);
    expect(removed).toBe(10);
    expect(await db.snack_stock_history.get("sh-1")).toBeUndefined();
    expect(await db.tab_entries.get("te-1")).toBeUndefined();
    expect(await db.day_closes.get("dc-1")).toBeUndefined();
    expect(await db.day_close_history.get("dch-1")).toBeUndefined();
    expect(await db.payments.get("pay-1")).toBeUndefined();
    expect(await db.payments.get("pay-late")).toBeUndefined();
    expect(await db.receipts.get("Receipts/2025/r.jpg")).toBeUndefined();
    expect(await db.receipt_hashes.get("Receipts/2025/r.jpg")).toBeUndefined();
  });

  it("refuses to delete year entries belonging to an open tab", async () => {
    await db.customer_tabs.add({
      id: "tab-open",
      customer_key: "n:ravi",
      customer_name: "Ravi",
      phone: null,
      status: "open",
      opened_at: "2025-01-01T00:00:00.000Z",
      closed_at: null,
      created_at: "2025-01-01T00:00:00.000Z",
    });
    await db.tab_entries.add({
      id: "te-open",
      tab_id: "tab-open",
      customer_key: "n:ravi",
      kind: "charge",
      business: "Turf",
      amount: 100,
      note: null,
      ref_type: "bill",
      ref_id: "b",
      entry_date: "2025-06-01",
      created_at: "2025-06-01T00:00:00.000Z",
    });
    await expect(deleteYear(2025)).rejects.toThrow(/still open/i);
    expect(await db.tab_entries.get("te-open")).toBeDefined();
  });
});

describe("closeDay atomic amendment", () => {
  it("rolls back the day close when history cannot be written", async () => {
    await db.day_closes.add({
      id: "dc-existing",
      day: "2025-05-10",
      expected_in_drawer: 500,
      counted_cash: 500,
      variance: 0,
      note: "original",
      closed_at: "2025-05-10T18:00:00.000Z",
      created_at: "2025-05-10T18:00:00.000Z",
    });
    const put = vi
      .spyOn(db.day_close_history, "put")
      .mockRejectedValueOnce(new Error("history failed"));
    await expect(
      closeDay({ day: "2025-05-10", expectedInDrawer: 600, countedCash: 590 }),
    ).rejects.toThrow("history failed");
    put.mockRestore();
    expect(await db.day_closes.get("dc-existing")).toMatchObject({
      counted_cash: 500,
      note: "original",
    });
    expect(
      await db.day_close_history.where("day").equals("2025-05-10").count(),
    ).toBe(0);
  });
});

describe("deep archive migration safety", () => {
  it("includes referenced customer tabs in a year archive without changing live-tab deletion semantics", async () => {
    await db.customer_tabs.clear();
    await db.tab_entries.clear();
    const tabId = "archive-tab-deep";
    await db.customer_tabs.put({
      id: tabId,
      customer_key: "n:test",
      customer_name: "Test",
      phone: null,
      status: "closed",
      opened_at: "2025-01-01T00:00:00.000Z",
      closed_at: "2025-12-31T00:00:00.000Z",
      created_at: "2025-01-01T00:00:00.000Z",
    });
    await db.tab_entries.put({
      id: "archive-entry-deep",
      tab_id: tabId,
      customer_key: "n:test",
      kind: "charge",
      business: "Turf",
      amount: 100,
      note: null,
      ref_type: null,
      ref_id: null,
      entry_date: "2025-06-01",
      created_at: "2025-06-01T00:00:00.000Z",
    });
    const archive = await buildYearArchive(2025);
    expect(archive.year).toBe(2025);
    expect(archive.tables["customer_tabs"]).toHaveLength(1);
    expect(archive.tables["customer_tabs"]?.[0]?.["id"]).toBe(tabId);
  });

  it("archives bill receipt photos and protects shared bill receipts", async () => {
    const year = 2025;
    const path = `Receipts/${year}/bill-receipt.jpg`;
    const bytes = new Uint8Array([1, 3, 5, 7]);
    await db.bills.put({
      id: "bill-photo-year",
      invoice_no: "INV-BILL-YEAR",
      customer_name: "Bill Photo",
      customer_phone: null,
      items: [],
      subtotal: 100,
      discount: 0,
      total: 100,
      amount_paid: 100,
      status: "paid",
      payment_mode: "Cash",
      bill_date: `${year}-06-01T10:00:00.000Z`,
      created_at: `${year}-06-01T10:00:00.000Z`,
      receipt_path: path,
    } as never);
    await db.receipts.put({
      path,
      blob: new Blob([bytes]),
      size: bytes.length,
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path,
      sha256: await sha256Hex(bytes),
      created_at: nowIso(),
    });

    const archive = await buildYearArchive(year);
    expect(archive.photo_manifest?.map((p) => p.path)).toContain(path);
    expect(archive.receipt_hashes?.map((h) => h.path)).toContain(path);
    expect(await yearRowCount(year)).toBe(3);

    const removed = await deleteYear(year);
    expect(removed).toBe(3);
    expect(await db.bills.get("bill-photo-year")).toBeUndefined();
    expect(await db.receipts.get(path)).toBeUndefined();
    expect(await db.receipt_hashes.get(path)).toBeUndefined();
  });

  it("refuses to build an archive when a referenced receipt is missing", async () => {
    await db.expenses.clear();
    await db.investments.clear();
    await db.expenses.put({
      id: "missing-photo-exp",
      expense_no: "TX-1",
      business: "Turf",
      category: "Other",
      description: null,
      note: null,
      amount: 10,
      spent_at: "2025-05-01",
      receipt_path: "Receipts/2025/missing.jpg",
      created_at: "2025-05-01T00:00:00.000Z",
    });
    await expect(buildYearArchive(2025)).rejects.toThrow(/photo is missing/i);
  });
});
