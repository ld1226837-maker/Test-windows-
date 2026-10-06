import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { db, DATA_TABLES, newId, nowIso } from "./localdb";
import { restoreBackup, type BackupFile } from "./backup";
import { restoreFullBackup } from "./telegram-backup";
import JSZip from "jszip";
import { sha256Hex } from "./receipts-share";

const clear = async () => {
  for (const name of [
    "snack_sales",
    "expenses",
    "investments",
    "customers",
    "receipts",
    "receipt_hashes",
    "app_settings",
  ]) {
    await (db as any)[name].clear();
  }
};

describe("data migration edge scenarios", () => {
  beforeEach(clear);

  it("backfills merged_into_bill_id when restoring a pre-v5 backup", async () => {
    const row = {
      id: newId(),
      bill_no: "SB-20240101-0001",
      sale_date: "2024-01-01",
      customer_name: null,
      items: [],
      total: 100,
      profit: 50,
      payment_mode: "Cash",
      notes: null,
      booking_id: null,
      booking_no: null,
      created_at: nowIso(),
    };
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      schema_version: 4,
      exported_at: nowIso(),
      tables: { snack_sales: [row] },
    };
    await restoreBackup(backup, "merge");
    expect(
      ((await db.snack_sales.get(row.id)) as any).merged_into_bill_id,
    ).toBeNull();
  });

  it("rejects a legacy merge when the same receipt path contains different bytes", async () => {
    const path = `Receipts/2024-01-01/${newId()}.jpg`;
    const local = new Uint8Array([1, 2, 3]);
    const incoming = new Uint8Array([9, 8, 7]);
    await db.receipts.put({
      path,
      blob: new Blob([local]),
      created_at: nowIso(),
    });
    await expect(
      restoreBackup(
        {
          format: "turf-snack-ledger",
          version: 2,
          schema_version: 4,
          exported_at: nowIso(),
          tables: {
            expenses: [
              {
                id: newId(),
                expense_no: "TX-20240101-0001",
                business: "Test",
                category: "Test",
                description: "x",
                note: null,
                amount: 10,
                spent_at: "2024-01-01",
                receipt_path: path,
                created_at: nowIso(),
              },
            ],
          },
          photos: [
            {
              path,
              data: btoa(String.fromCharCode(...incoming)),
              created_at: nowIso(),
            },
          ],
        },
        "merge",
      ),
    ).rejects.toThrow(/different bytes/);
  });

  it("restores investment receipt photos from a full backup", async () => {
    const path = `Receipts/2024-01-02/${newId()}.jpg`;
    const bytes = new Uint8Array([11, 22, 33, 44]);
    const investmentId = newId();
    const backup = {
      format: "turf-snack-ledger-full",
      version: 1,
      created_at: nowIso(),
      device_label: "test",
      tables: {
        ...Object.fromEntries(DATA_TABLES.map((t) => [t, []])),
        investments: [
          {
            id: investmentId,
            amount: 100,
            investment_date: "2024-01-02",
            description: "Test",
            receipt_path: path,
            created_at: nowIso(),
            updated_at: nowIso(),
            deleted_at: null,
          },
        ],
        receipts: [{ path, created_at: nowIso() }],
      },
      files: [{ path, sha256: await sha256Hex(bytes), expense_id: undefined }],
    };
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(backup));
    zip.file(path, bytes);
    await restoreFullBackup(
      await zip.generateAsync({ type: "uint8array" }),
      "replace",
    );
    const restored = await db.receipts.get(path);
    expect(restored).toBeTruthy();
    expect(
      new Uint8Array(await (restored!.blob as Blob).arrayBuffer()),
    ).toEqual(bytes);
  });

  it("rejects malformed schema_version instead of treating it as an old backup", async () => {
    await expect(
      restoreBackup(
        {
          format: "turf-snack-ledger",
          version: 5,
          schema_version: "oops" as any,
          exported_at: nowIso(),
          tables: {},
        },
        "merge",
      ),
    ).rejects.toThrow(/schema version/);
  });
});

describe("deep migration regressions", () => {
  beforeEach(clear);

  it("does not attempt to merge or restore derived counters", async () => {
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      schema_version: 16,
      backup_id: `counter-${newId()}`,
      exported_at: nowIso(),
      tables: Object.fromEntries([
        ...(
          [
            "customers",
            "bills",
            "expenses",
            "history_entries",
            "turf_rates",
            "snack_items",
            "snack_stock_history",
            "turf_bookings",
            "snack_sales",
            "snack_combos",
            "expense_budgets",
            "recurring_expenses",
            "customer_tabs",
            "tab_entries",
            "app_settings",
            "day_closes",
            "day_close_history",
            "payments",
            "investments",
            "teams",
            "team_players",
            "calendar_events",
            "calendar_event_exceptions",
          ] as const
        ).map((t) => [t, []]),
        ["counters", [{ key: "invoice", value: 999999, updated_at: nowIso() }]],
      ]),
    };
    await restoreBackup(backup, "merge");
    const counter = await db.counters.get("invoice");
    expect(counter?.value).not.toBe(999999);
  });
});
