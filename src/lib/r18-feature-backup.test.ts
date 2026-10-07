// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./localdb";
import {
  buildBackup,
  restoreBackup,
  serializeBackupBytes,
  decodeBackupBytes,
  parseBackup,
} from "./backup";
import { findInvalidRows } from "./backup-validate";

describe("R18 backup coverage", () => {
  beforeEach(async () => {
    for (const t of [
      db.investments,
      db.teams,
      db.team_players,
      db.calendar_events,
      db.calendar_event_exceptions,
      db.counters,
      db.customers,
      db.expenses,
      db.bills,
      db.receipts,
      db.receipt_hashes,
    ])
      await t.clear();
  });
  it("round-trips investments, teams, players and events", async () => {
    await db.customers.put({
      id: "c1",
      name: "Unicode टीम",
      phone: "9876543210",
      created_at: "2026-10-01T00:00:00Z",
    });
    const photoPath = "Receipts/2026-10-01/investment-photo.png";
    const photoBytes = new Uint8Array([1, 2, 3, 4, 5]);
    await db.receipts.put({
      path: photoPath,
      blob: new Blob([photoBytes], { type: "image/png" }),
      size: photoBytes.length,
      created_at: "2026-10-01T00:00:00Z",
    });
    await db.investments.put({
      id: "i1",
      bill_no: "INVES-20261001-001",
      amount: 800,
      investment_date: "2026-10-01",
      category: "Equipment",
      note: "Nets",
      payment_mode: "Cash",
      receipt_path: photoPath,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      deleted_at: null,
    });
    await db.investments.put({
      id: "i2",
      bill_no: "INVES-20261002-001",
      amount: 10000,
      investment_date: "2026-10-02",
      category: "Infrastructure",
      note: "Floodlights",
      payment_mode: "UPI",
      receipt_path: null,
      created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z",
      deleted_at: null,
    });
    await db.teams.put({
      id: "t1",
      customer_id: "c1",
      name: "Champions",
      notes: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      deleted_at: null,
    });
    await db.team_players.put({
      id: "p1",
      team_id: "t1",
      name: "José खिलाड़ी",
      phone: "+91 98765 43210",
      notes: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    await db.calendar_events.put({
      id: "e1",
      kind: "reminder",
      title: "Meet team",
      notes: null,
      start_at: "2026-10-03T09:00:00+05:30",
      end_at: null,
      all_day: false,
      remind_before_minutes: 15,
      repeat: "weekly",
      status: "pending",
      color: null,
      customer_id: "c1",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    await db.calendar_event_exceptions.put({
      id: "e1@2026-10-10T03:30:00.000Z",
      event_id: "e1",
      occurrence_at: "2026-10-10T03:30:00.000Z",
      status: "done",
      snooze_until: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    await db.counters.put({
      key: "invoice:2026-10-01",
      value: 42,
      updated_at: "2026-10-01T00:00:00Z",
    });
    const backup = await buildBackup();
    expect(backup.version).toBe(5);
    expect(backup.schema_version).toBeGreaterThanOrEqual(16);
    expect(findInvalidRows(backup.tables)).toEqual([]);
    // Capture the serialized container BEFORE clearing tables: v5 serialize
    // re-reads photo bytes from the database (backup.ts re-reads each
    // photo_manifest entry at write time), so clearing receipts first makes
    // the export throw "Receipt photo missing from this device".
    const container = await serializeBackupBytes(backup);
    const inv = await db.investments.toArray(),
      teams = await db.teams.toArray(),
      players = await db.team_players.toArray(),
      events = await db.calendar_events.toArray(),
      exceptions = await db.calendar_event_exceptions.toArray(),
      counters = await db.counters.toArray();
    await db.investments.clear();
    await db.teams.clear();
    await db.team_players.clear();
    await db.calendar_events.clear();
    await db.calendar_event_exceptions.clear();
    await db.counters.clear();
    await db.customers.clear();
    await db.receipts.clear();
    const roundTripped = parseBackup(await decodeBackupBytes(container));
    await restoreBackup(roundTripped, "replace");
    expect(await db.investments.toArray()).toEqual(inv);
    expect(await db.teams.toArray()).toEqual(teams);
    expect(await db.team_players.toArray()).toEqual(players);
    expect(await db.calendar_events.toArray()).toEqual(events);
    expect(await db.calendar_event_exceptions.toArray()).toEqual(exceptions);
    // Counters are derived state, not backup state: resyncCounters()
    // unconditionally rebuilds the four per-day sequence counters from the
    // restored rows (localdb.ts). The manually seeded counter is therefore
    // not expected to survive — pin the derived contract, format-independent.
    const counterKeys = (await db.counters.toArray())
      .map((c) => c.key.split(":")[0])
      .sort();
    expect(counterKeys).toEqual([
      "expense",
      "investment_bill",
      "invoice",
      "snack_bill",
      "turf_booking",
    ]);
    expect(
      new Uint8Array(
        await (await db.receipts.get(photoPath))!.blob!.arrayBuffer(),
      ),
    ).toEqual(photoBytes);
  });
  it("rejects broken team foreign keys before writes", () => {
    const bad: any = {
      customers: [],
      teams: [{ id: "t", customer_id: "missing", name: "T" }],
      team_players: [],
      calendar_events: [],
      investments: [],
    };
    expect(findInvalidRows(bad).some((x) => x.table === "teams")).toBe(true);
  });
});
