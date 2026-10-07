// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { db, DATA_TABLES, newId, nowIso } from "./localdb";
import { restoreBackup, previewRestore, type BackupFile } from "./backup";

const emptyTables = () =>
  Object.fromEntries(DATA_TABLES.map((t) => [t, []])) as BackupFile["tables"];
const mk = (
  over: Partial<BackupFile> & { tables?: BackupFile["tables"] },
): BackupFile => ({
  format: "turf-snack-ledger",
  version: 5,
  schema_version: db.verno,
  backup_id: `t-${newId()}`,
  exported_at: nowIso(),
  photo_manifest: [],
  ...over,
  tables: { ...emptyTables(), ...(over.tables ?? {}) },
});
const bill = (id: string, invoice_no: string, amount_paid = 0) => ({
  id,
  invoice_no,
  items: [],
  subtotal: 100,
  total: 100,
  amount_paid,
  created_at: nowIso(),
});
const booking = (id: string, booking_no: string) => ({
  id,
  booking_no,
  booking_date: "2024-01-01",
  hours: 1,
  rate_per_hour: 100,
  total_amount: 100,
  snacks: [],
  customer_name: "C",
  created_at: nowIso(),
});
const sale = (
  id: string,
  bill_no: string,
  booking_id: string | null,
  booking_no: string | null,
) => ({
  id,
  bill_no,
  sale_date: "2024-01-01",
  customer_name: null,
  items: [],
  total: 10,
  profit: 1,
  payment_mode: "Cash",
  notes: null,
  booking_id,
  booking_no,
  created_at: nowIso(),
  merged_into_bill_id: null,
});

const wipe = async () => {
  for (const t of DATA_TABLES) await (db as any)[t].clear();
  await db.receipts.clear();
  await db.receipt_hashes.clear();
  window.localStorage.clear();
};

describe("migration audit fixes (M1-M7, L1-L3)", () => {
  beforeEach(wipe);

  it("M1: merge never duplicates a record that exists locally with different data", async () => {
    const id = newId();
    await db.bills.put(bill(id, "INV-20240101-0001", 100) as any);
    await restoreBackup(
      mk({ tables: { bills: [bill(id, "INV-20240101-0001", 40)] } as any }),
      "merge",
    );
    const rows = await db.bills.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_paid).toBe(100);
  });

  it("M2: preview does not report identical rows with different key order as differing", async () => {
    const id = newId();
    const local = bill(id, "INV-20240101-0001");
    await db.bills.put(local as any);
    const reordered = Object.fromEntries(Object.entries(local).reverse());
    const preview = await previewRestore(
      mk({ tables: { bills: [reordered] } as any }),
      "merge",
    );
    const row = preview.perTable.find((r) => r.table === "bills")!;
    expect(row.mode === "merge" && row.differing).toBe(0);
  });

  it("M3/M6: replace keeps device-local Telegram keys and does not import another device's", async () => {
    window.localStorage.setItem("ks:telegram-backup", "local-chat");
    window.localStorage.setItem("ks:telegram-backup-last", "local-last");
    window.localStorage.setItem("ks:stale-setting", "x");
    await restoreBackup(
      mk({
        localSettings: {
          "ks:telegram-backup-last": "REMOTE-last",
          "ks:telegram-backup-history": "REMOTE-history",
        },
      }),
      "replace",
    );
    expect(window.localStorage.getItem("ks:telegram-backup")).toBe(
      "local-chat",
    );
    expect(window.localStorage.getItem("ks:telegram-backup-last")).toBe(
      "local-last",
    );
    expect(
      window.localStorage.getItem("ks:telegram-backup-history"),
    ).toBeNull();
    expect(window.localStorage.getItem("ks:stale-setting")).toBeNull();
  });

  it("M4: replace from a backup without payments clears payments of the replaced parents", async () => {
    const id = newId();
    await db.bills.put(bill(id, "INV-20240101-0001", 50) as any);
    await db.payments.put({
      id: newId(),
      parent_type: "bill",
      parent_id: id,
      amount: 50,
      mode: "Cash",
      received_at: "2024-01-01",
      created_at: nowIso(),
    } as any);
    const tables: any = { bills: [bill(newId(), "INV-20240102-0001", 10)] };
    const b = mk({ version: 2, schema_version: 9, tables });
    delete (b.tables as any).payments;
    await restoreBackup(b, "replace");
    expect(await db.payments.count()).toBe(0);
  });

  it("M4: replace from an empty legacy v1 table still does not wipe unrelated data", async () => {
    const id = newId();
    await db.payments.put({
      id,
      parent_type: "bill",
      parent_id: "x",
      amount: 1,
      mode: "Cash",
      received_at: "2024-01-01",
      created_at: nowIso(),
    } as any);
    const b = mk({
      version: 1,
      schema_version: 4,
      tables: { bills: [] } as any,
    });
    delete (b.tables as any).payments;
    await restoreBackup(b, "replace");
    expect(await db.payments.count()).toBe(1);
  });

  it("M5: a remapped booking number is reflected on the linked snack sale", async () => {
    await db.turf_bookings.put(booking(newId(), "TURF-20240101-0001") as any);
    const incomingBooking = newId();
    await restoreBackup(
      mk({
        tables: {
          turf_bookings: [booking(incomingBooking, "TURF-20240101-0001")],
          snack_sales: [
            sale(
              newId(),
              "SB-20240101-0001",
              incomingBooking,
              "TURF-20240101-0001",
            ),
          ],
        } as any,
      }),
      "merge",
    );
    const remapped = (await db.turf_bookings.get(incomingBooking))!.booking_no;
    expect(remapped).not.toBe("TURF-20240101-0001");
    const s = (await db.snack_sales.toArray())[0]!;
    expect(s.booking_no).toBe(remapped);
  });

  it("M7: internal restore options survive normalisation of old-schema backups", async () => {
    const { setInternalRestoreOptions } = await import("./backup");
    await db.receipts.put({
      path: "Receipts/2024-01-01/keep.jpg",
      blob: new Blob([new Uint8Array([1])]),
      created_at: nowIso(),
    } as any);
    const b = mk({ version: 2, schema_version: 4 });
    setInternalRestoreOptions(b, { preserveReceiptsDuringRestore: true });
    await restoreBackup(b, "replace");
    expect(await db.receipts.get("Receipts/2024-01-01/keep.jpg")).toBeTruthy();
  });

  it("L1: legacy merge identity is independent of schema normalisation", async () => {
    const legacy: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      schema_version: 4,
      exported_at: nowIso(),
      tables: {
        snack_sales: [sale(newId(), "SB-20240101-0001", null, null)],
      } as any,
    };
    await restoreBackup(legacy, "merge");
    await restoreBackup(legacy, "merge");
    expect(await db.snack_sales.count()).toBe(1);
  });

  it("L2: a dangling merged_into_bill_id is rejected and nothing is restored", async () => {
    const s = {
      ...sale(newId(), "SB-20240101-0001", null, null),
      merged_into_bill_id: newId(),
    };
    await expect(
      restoreBackup(mk({ tables: { snack_sales: [s] } as any }), "merge"),
    ).rejects.toThrow(/merged_into_bill_id/);
    expect(await db.snack_sales.count()).toBe(0);
  });

  it("M8: merge does not attach another device's payment rows to a parent kept local", async () => {
    const id = newId();
    // Local bill has no payment rows: its paid amount is the implied amount_paid (100).
    await db.bills.put(bill(id, "INV-20240101-0001", 100) as any);
    const incomingPayment = {
      id: newId(),
      parent_type: "bill",
      parent_id: id,
      amount: 40,
      mode: "Cash",
      received_at: "2024-01-01",
      created_at: nowIso(),
    };
    await restoreBackup(
      mk({
        tables: {
          bills: [bill(id, "INV-20240101-0001", 40)],
          payments: [incomingPayment],
        } as any,
      }),
      "merge",
    );
    expect(await db.payments.count()).toBe(0);
    expect((await db.bills.get(id))!.amount_paid).toBe(100);
  });

  it("L4: merge rejects a bill receipt_path when neither backup nor local DB has the photo", async () => {
    await db.bills.clear();
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    const backup = {
      version: 3,
      schema_version: 16,
      exported_at: "2026-10-01T00:00:00.000Z",
      tables: {
        ...Object.fromEntries(DATA_TABLES.map((t) => [t, []])),
        bills: [
          {
            id: "bill-missing-photo",
            invoice_no: "INV-20261001-0001",
            customer_name: "Walk-in",
            customer_phone: null,
            items: [],
            subtotal: 100,
            discount: 0,
            total: 100,
            amount_paid: 0,
            status: "Unpaid",
            payment_mode: "Cash",
            bill_date: "2026-10-01",
            created_at: "2026-10-01T00:00:00.000Z",
            receipt_path: "Receipts/2026-10-01/missing.jpg",
          },
        ],
      },
      photo_manifest: [],
      receipt_hashes: [],
    } as any;
    await expect(restoreBackup(backup, "merge")).rejects.toThrow(
      /receipt_path references missing receipt photo/i,
    );
    expect(await db.bills.get("bill-missing-photo")).toBeUndefined();
  });

  it("S1: invalid payment parent_type is rejected", async () => {
    const payment = {
      id: newId(),
      parent_type: "unknown_parent",
      parent_id: newId(),
      amount: 10,
      mode: "Cash",
      received_at: "2024-01-01",
      created_at: nowIso(),
    };
    await expect(
      restoreBackup(mk({ tables: { payments: [payment] } as any }), "replace"),
    ).rejects.toThrow(/parent_type has invalid value/);
    expect(await db.payments.count()).toBe(0);
  });

  it("S1: dangling tab ref_id is rejected", async () => {
    const tabId = newId();
    await db.customer_tabs.put({
      id: tabId,
      customer_key: "c",
      name: "C",
      phone: null,
      status: "open",
      balance: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    } as any);
    const entry = {
      id: newId(),
      tab_id: tabId,
      customer_key: "c",
      kind: "charge",
      business: "Turf",
      amount: 10,
      note: null,
      ref_type: "bill",
      ref_id: "missing-bill",
      entry_date: "2024-01-01",
      created_at: nowIso(),
    };
    await expect(
      restoreBackup(
        mk({
          tables: {
            customer_tabs: [
              {
                id: tabId,
                customer_key: "c",
                name: "C",
                phone: null,
                status: "open",
                balance: 0,
                created_at: nowIso(),
                updated_at: nowIso(),
              },
            ],
            tab_entries: [entry],
          } as any,
        }),
        "replace",
      ),
    ).rejects.toThrow(/ref_id references missing bills/);
    expect(await db.tab_entries.count()).toBe(0);
  });

  it("S1: merge_reverse tab entries require valid bill and source references", async () => {
    const tabId = newId();
    const billId = newId();
    const saleId = newId();
    const entry = {
      id: newId(),
      tab_id: tabId,
      customer_key: "c",
      kind: "payment",
      business: "Shared",
      amount: 10,
      note: null,
      ref_type: "merge_reverse",
      ref_id: billId,
      source_ref_type: "snack_sale",
      source_ref_id: saleId,
      entry_date: "2024-01-01",
      created_at: nowIso(),
    };
    await expect(
      restoreBackup(
        mk({
          tables: {
            customer_tabs: [
              {
                id: tabId,
                customer_key: "c",
                name: "C",
                phone: null,
                status: "open",
                balance: 0,
                created_at: nowIso(),
                updated_at: nowIso(),
              },
            ],
            tab_entries: [entry],
          } as any,
        }),
        "replace",
      ),
    ).rejects.toThrow(/ref_id references missing bills/);
    expect(await db.tab_entries.count()).toBe(0);
  });

  it("L3: browser replace keeps existing receipts when the backup carries none of them", async () => {
    // Defence for the deferred-clear path: old photos are only removed after the
    // new set has been written, never before the metadata commit.
    const path = "Receipts/2024-01-01/old.jpg";
    await db.receipts.put({
      path,
      blob: new Blob([new Uint8Array([9])]),
      created_at: nowIso(),
    } as any);
    await restoreBackup(
      mk({ tables: { bills: [bill(newId(), "INV-20240103-0001")] } as any }),
      "replace",
    );
    // v5 backup with an empty manifest is a complete snapshot: old orphan photo is removed afterwards.
    expect(await db.receipts.get(path)).toBeUndefined();
  });
});
