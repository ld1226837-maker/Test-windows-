// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { db, newId, nowIso } from "./localdb";
import { restoreBackup, BACKUP_TABLES, type BackupFile } from "./backup";
import { moveEarlyMorningToPreviousDay, previousDate } from "./business-day";
import {
  BUSINESS_DAY_END,
  BUSINESS_DAY_START,
  businessDateOf,
  businessMinutes,
  partWindow,
  PICKER_PARTS,
} from "./time-slot-utils";

describe("business day 6 AM – 6 AM (helpers)", () => {
  it("maps clock minutes into business-day minutes", () => {
    expect(businessMinutes(360)).toBe(360); // 6 AM
    expect(businessMinutes(1380)).toBe(1380); // 11 PM
    expect(businessMinutes(0)).toBe(1440); // 12 AM = after this date's night
    expect(businessMinutes(120)).toBe(1560); // 2 AM
    expect(businessMinutes(359)).toBe(1799); // 5:59 AM
    expect(BUSINESS_DAY_END - BUSINESS_DAY_START).toBe(1440);
  });

  it("before 6 AM the business date is still yesterday", () => {
    expect(businessDateOf(new Date("2026-10-10T02:00:00"))).toBe("2026-10-09");
    expect(businessDateOf(new Date("2026-10-10T05:59:00"))).toBe("2026-10-09");
    expect(businessDateOf(new Date("2026-10-10T06:00:00"))).toBe("2026-10-10");
    expect(businessDateOf(new Date("2026-10-10T23:59:00"))).toBe("2026-10-10");
  });

  it("picker parts run Morning … Night, Late Night last, tiling 360–1800", () => {
    expect(PICKER_PARTS.map((p) => p.id)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "night",
      "latenight",
    ]);
    const wins = PICKER_PARTS.map((p) => partWindow(p));
    expect(wins[0]![0]).toBe(360);
    expect(wins[wins.length - 1]![1]).toBe(1800);
    for (let i = 1; i < wins.length; i++)
      expect(wins[i]![0]).toBe(wins[i - 1]![1]); // no gap, no overlap
  });

  it("previousDate crosses month and year boundaries", () => {
    expect(previousDate("2026-10-01")).toBe("2026-09-30");
    expect(previousDate("2026-01-01")).toBe("2025-12-31");
    expect(previousDate("2028-03-01")).toBe("2028-02-29");
  });
});

describe("moveEarlyMorningToPreviousDay (migration rule)", () => {
  const row = (start: string | null) => ({
    booking_date: "2026-10-10",
    start_time: start,
  });
  it("moves 12 AM – 5:59 AM starts back one date", () => {
    for (const t of ["12 AM", "12:30 AM", "2 AM", "5:30 AM"])
      expect(moveEarlyMorningToPreviousDay(row(t)).booking_date).toBe(
        "2026-10-09",
      );
  });
  it("leaves 6 AM onwards, unparseable and missing starts alone", () => {
    for (const t of ["6 AM", "11 PM", "12 PM", "7:30 PM", null, "garbage"]) {
      const r = row(t);
      expect(moveEarlyMorningToPreviousDay(r)).toBe(r);
    }
  });
});

describe("one-time data upgrade (Dexie v19 -> v20)", () => {
  it("moves existing 12–6 AM bookings to the previous date, nothing else", async () => {
    // Build a raw v19 database (Dexie multiplies the version by 10) using the
    // real table layouts, with rows saved the OLD way, then let Dexie upgrade.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("turf-ledger", 190);
      req.onupgradeneeded = () => {
        const idb = req.result;
        for (const t of db.tables) {
          const kp = t.schema.primKey.keyPath;
          const store = kp
            ? idb.createObjectStore(t.name, { keyPath: kp as string })
            : idb.createObjectStore(t.name);
          for (const ix of t.schema.indexes)
            store.createIndex(ix.name, ix.keyPath as string | string[], {
              unique: !!ix.unique,
              multiEntry: !!ix.multi,
            });
        }
        const tx = req.transaction!;
        const bookings = tx.objectStore("turf_bookings");
        const mk = (id: string, date: string, start: string) => ({
          id,
          booking_no: id,
          booking_date: date,
          start_time: start,
          end_time: start,
          hours: 1,
          customer_name: "T",
          created_at: "2026-10-01T00:00:00.000Z",
        });
        bookings.add(mk("early", "2026-10-11", "2 AM"));
        bookings.add(mk("midnight", "2026-10-11", "12 AM"));
        bookings.add(mk("night", "2026-10-10", "11 PM"));
        bookings.add(mk("morning", "2026-10-10", "6 AM"));
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    const dates = Object.fromEntries(
      (await db.turf_bookings.toArray()).map((b) => [b.id, b.booking_date]),
    );
    expect(db.verno).toBe(20);
    expect(dates).toEqual({
      early: "2026-10-10", // 2 AM on the 11th = after the 10th's night
      midnight: "2026-10-10",
      night: "2026-10-10", // unchanged
      morning: "2026-10-10", // unchanged
    });
  });
});

describe("restoring an older backup applies the same rule", () => {
  const backupWith = (schema: number, rows: Record<string, unknown>[]) => {
    const b: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      backup_id: `bd-${newId()}`,
      schema_version: schema,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    };
    b.tables["turf_bookings"] = rows;
    return b;
  };
  const row = (id: string, date: string, start: string) => ({
    id,
    booking_no: `TURF-${id}`,
    booking_date: date,
    customer_name: "T",
    slot_name: "Weekdays",
    start_time: start,
    end_time: "3 AM",
    hours: 1,
    courts: 1,
    court_ids: ["c1"],
    rate_per_hour: 1000,
    total_amount: 1000,
    advance_paid: 0,
    payment_mode: "Cash",
    status: "Confirmed",
    snacks: [],
    snacks_total: 0,
    created_at: nowIso(),
  });

  it("v19 backup: a 2 AM booking moves back a day; v20 backup is untouched", async () => {
    await restoreBackup(
      backupWith(19, [
        row("old-early", "2026-10-11", "2 AM"),
        row("old-eve", "2026-10-11", "7 PM"),
      ]),
      "replace",
    );
    let got = Object.fromEntries(
      (await db.turf_bookings.toArray()).map((b) => [b.id, b.booking_date]),
    );
    expect(got).toEqual({
      "old-early": "2026-10-10",
      "old-eve": "2026-10-11",
    });

    await restoreBackup(
      backupWith(db.verno, [row("new-early", "2026-10-11", "2 AM")]),
      "replace",
    );
    got = Object.fromEntries(
      (await db.turf_bookings.toArray()).map((b) => [b.id, b.booking_date]),
    );
    expect(got).toEqual({ "new-early": "2026-10-11" });
  });
});
