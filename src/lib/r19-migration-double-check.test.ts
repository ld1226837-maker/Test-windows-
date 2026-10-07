// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, DATA_TABLES, table, newId, nowIso } from "./localdb";
import {
  BACKUP_TABLES,
  buildBackup,
  decodeBackupBytes,
  parseBackup,
  restoreBackup,
  serializeBackupBytes,
  type BackupFile,
} from "./backup";

const emptyBackup = (): BackupFile => ({
  format: "turf-snack-ledger",
  version: 5,
  backup_id: `r19-${newId()}`,
  exported_at: nowIso(),
  tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
  photo_manifest: [],
});

async function clearAll() {
  for (const t of DATA_TABLES) await table(t).clear();
  await db.receipts.clear();
  await db.receipt_hashes.clear();
}

describe("R19 migration double-check", () => {
  beforeEach(clearAll);

  it("backup covers every data table the database defines", async () => {
    const backup = await buildBackup();
    for (const t of DATA_TABLES)
      expect(Object.keys(backup.tables)).toContain(t);
    // every Dexie data table (except receipt blobs/hashes) is in DATA_TABLES
    const dexieTables = db.tables.map((t) => t.name).sort();
    const missing = dexieTables.filter(
      (n) =>
        !(DATA_TABLES as readonly string[]).includes(n) &&
        n !== "receipts" &&
        n !== "receipt_hashes",
    );
    expect(missing).toEqual([]);
  });

  it("merge never leaves two investments with the same bill number", async () => {
    const t = "2026-10-05T00:00:00Z";
    await db.investments.put({
      id: "local-1",
      bill_no: "INVES-20261005-001",
      amount: 800,
      investment_date: "2026-10-05",
      category: "Equipment",
      note: "Local",
      payment_mode: "Cash",
      receipt_path: null,
      created_at: t,
      updated_at: t,
      deleted_at: null,
    });
    const incoming = emptyBackup();
    incoming.tables["investments"] = [
      {
        id: "remote-1",
        bill_no: "INVES-20261005-001",
        amount: 10000,
        investment_date: "2026-10-05",
        category: "Infrastructure",
        note: "Remote",
        payment_mode: "UPI",
        receipt_path: null,
        created_at: t,
        updated_at: t,
        deleted_at: null,
      },
    ];
    await restoreBackup(incoming, "merge");
    const rows = await db.investments.toArray();
    expect(rows).toHaveLength(2);
    const numbers = rows.map((r) => r.bill_no);
    expect(new Set(numbers).size).toBe(2);
    expect((await db.investments.get("local-1"))?.bill_no).toBe(
      "INVES-20261005-001",
    );
    expect((await db.investments.get("remote-1"))?.bill_no).toBe(
      "INVES-20261005-002",
    );
  });

  it("replace round-trip keeps investments, teams and players byte-for-byte", async () => {
    const t = "2026-10-05T00:00:00Z";
    await db.customers.put({
      id: "c1",
      name: "Arun",
      phone: "9876543210",
      created_at: t,
    });
    await db.teams.put({
      id: "t1",
      customer_id: "c1",
      name: "Lions",
      notes: "Sunday",
      created_at: t,
      updated_at: t,
      deleted_at: null,
    });
    await db.team_players.put({
      id: "p1",
      team_id: "t1",
      name: "Ali",
      phone: "9000000002",
      notes: "GK",
      created_at: t,
      updated_at: t,
    });
    await db.investments.put({
      id: "i1",
      bill_no: "INVES-20261005-001",
      amount: 10000,
      investment_date: "2026-10-05",
      category: "Equipment",
      note: "Nets",
      payment_mode: "UPI",
      receipt_path: null,
      created_at: t,
      updated_at: t,
      deleted_at: null,
    });
    const before = {
      teams: await db.teams.toArray(),
      players: await db.team_players.toArray(),
      investments: await db.investments.toArray(),
    };
    const bytes = await serializeBackupBytes(await buildBackup());
    await clearAll();
    const decoded = parseBackup(await decodeBackupBytes(bytes));
    await restoreBackup(decoded, "replace");
    expect(await db.teams.toArray()).toEqual(before.teams);
    expect(await db.team_players.toArray()).toEqual(before.players);
    expect(await db.investments.toArray()).toEqual(before.investments);
  });
});
