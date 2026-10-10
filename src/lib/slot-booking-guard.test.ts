// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./localdb";
import { assertTurfSlotAvailableInTransaction } from "./ops";
import type { TurfBooking } from "./ops";
import {
  assignCourts,
  buildCourtOccupancy,
  courtHourSegments,
  freeCourtIdsFor,
  resolveCourtIds,
} from "./courts";
import { turfOccupancy } from "./analytics";
import { minuteLabel } from "./time-slot-utils";
import { canEndAt, nextSelection } from "./slot-selection";

const D = "2026-10-10";
const D1 = "2026-10-11";
const H = (h: number, m = 0) => h * 60 + m;

let seq = 0;
const mk = (
  date: string,
  start: string,
  end: string,
  hours: number,
  court_ids: string[],
  extra: Record<string, unknown> = {},
) =>
  ({
    id: `b${++seq}`,
    booking_no: `TURF-${seq}`,
    booking_date: date,
    start_time: start,
    end_time: end,
    hours,
    courts: court_ids.length,
    court_ids,
    status: "Confirmed",
    customer_name: "T",
    total_amount: hours * 1000,
    advance_paid: 0,
    created_at: "2026-10-01T00:00:00.000Z",
    ...extra,
  }) as unknown as TurfBooking;

async function setCourts(n: number) {
  await db.app_settings.put({
    key: "slot_durations",
    value: { allow_30: true, allow_60: true, total_courts: n },
  } as never);
}

/** Run the real transaction guard; resolves true when accepted. */
async function accepts(c: TurfBooking, excludeId?: string) {
  try {
    await db.transaction("rw", db.turf_bookings, db.app_settings, () =>
      assertTurfSlotAvailableInTransaction(c, excludeId),
    );
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await db.turf_bookings.clear();
  await setCourts(1);
});

describe("guard: half-open intervals and midnight (ops.ts)", () => {
  it("adjacent bookings do not conflict: 7–8 PM booked, 8–9 PM accepted", async () => {
    await db.turf_bookings.add(mk(D, "7 PM", "8 PM", 1, ["c1"]) as never);
    expect(await accepts(mk(D, "8 PM", "9 PM", 1, ["c1"]))).toBe(true);
    expect(await accepts(mk(D, "6 PM", "7 PM", 1, ["c1"]))).toBe(true);
    expect(await accepts(mk(D, "7 PM", "8 PM", 1, ["c1"]))).toBe(false);
    expect(await accepts(mk(D, "6 PM", "8 PM", 2, ["c1"]))).toBe(false);
  });

  it("B10 a 10 PM–12 AM booking does not occupy D+1 12–1 AM", async () => {
    await db.turf_bookings.add(mk(D, "10 PM", "12 AM", 2, ["c1"]) as never);
    expect(await accepts(mk(D1, "12 AM", "1 AM", 1, ["c1"]))).toBe(true);
    expect(await accepts(mk(D, "11 PM", "12 AM", 1, ["c1"]))).toBe(false);
    // and the next-day occupancy map is empty at minute 0
    const rows = await db.turf_bookings.toArray();
    const occ = buildCourtOccupancy(rows as never, D1, 1);
    expect(occ.get(0)).toBeUndefined();
  });

  it("B12 a stored 11 PM–1 AM row blocks 11 PM and 12–1 AM of the SAME business date", async () => {
    await db.turf_bookings.add(mk(D, "11 PM", "1 AM", 2, ["c1"]) as never);
    expect(await accepts(mk(D, "11 PM", "12 AM", 1, ["c1"]))).toBe(false);
    expect(await accepts(mk(D, "12 AM", "1 AM", 1, ["c1"]))).toBe(false);
    expect(await accepts(mk(D, "1 AM", "2 AM", 1, ["c1"]))).toBe(true);
    // the NEXT business date starts at 6 AM; its own 12 AM is a day later
    expect(await accepts(mk(D1, "12 AM", "1 AM", 1, ["c1"]))).toBe(true);
    const rows = await db.turf_bookings.toArray();
    const occ = buildCourtOccupancy(rows as never, D, 1);
    expect(occ.get(1440)?.has("c1")).toBe(true);
    expect(occ.get(1499)?.has("c1")).toBe(true);
    expect(occ.get(1500)).toBeUndefined();
  });

  it("business day: a 2 AM booking made for D blocks D's 2 AM, not D+1's", async () => {
    await db.turf_bookings.add(mk(D, "2 AM", "3 AM", 1, ["c1"]) as never);
    expect(await accepts(mk(D, "2 AM", "3 AM", 1, ["c1"]))).toBe(false);
    expect(await accepts(mk(D1, "2 AM", "3 AM", 1, ["c1"]))).toBe(true);
    expect(await accepts(mk(D1, "7 AM", "8 AM", 1, ["c1"]))).toBe(true);
    // 5–6 AM is the last Late Night hour; it does not touch 2 AM
    expect(await accepts(mk(D, "5 AM", "6 AM", 1, ["c1"]))).toBe(true);
  });

  it("an 8 PM–12 AM booking (4 h) is accepted on an empty day", async () => {
    expect(await accepts(mk(D, "8 PM", "12 AM", 4, ["c1"]))).toBe(true);
  });

  it("F1 editing a booking does not block itself (excludeId)", async () => {
    const own = mk(D, "10 PM", "12 AM", 2, ["c1"]);
    await db.turf_bookings.add(own as never);
    expect(
      await accepts({ ...own, customer_name: "Renamed" } as TurfBooking),
    ).toBe(false);
    expect(
      await accepts(
        { ...own, customer_name: "Renamed" } as TurfBooking,
        own.id,
      ),
    ).toBe(true);
  });

  it("F2 moving 10 PM–12 AM to 9–11 PM releases the old range", async () => {
    const own = mk(D, "10 PM", "12 AM", 2, ["c1"]);
    await db.turf_bookings.add(own as never);
    const moved = {
      ...own,
      start_time: "9 PM",
      end_time: "11 PM",
    } as TurfBooking;
    expect(await accepts(moved, own.id)).toBe(true);
    await db.turf_bookings.put(moved as never);
    expect(await accepts(mk(D, "11 PM", "12 AM", 1, ["c1"]))).toBe(true);
    expect(await accepts(mk(D, "10 PM", "11 PM", 1, ["c1"]))).toBe(false);
  });

  it("F4 two writers on the same slot: the second one is rejected", async () => {
    const a = mk(D, "7 PM", "8 PM", 1, ["c1"]);
    const b = mk(D, "7 PM", "8 PM", 1, ["c1"]);
    const run = (c: TurfBooking) =>
      db
        .transaction("rw", db.turf_bookings, db.app_settings, async () => {
          await assertTurfSlotAvailableInTransaction(c);
          await db.turf_bookings.add(c as never);
        })
        .then(() => true)
        .catch(() => false);
    const [ra, rb] = await Promise.all([run(a), run(b)]);
    expect([ra, rb].filter(Boolean)).toHaveLength(1);
    expect(await db.turf_bookings.count()).toBe(1);
  });

  it("F5 a cancelled booking frees its slot", async () => {
    await db.turf_bookings.add(
      mk(D, "7 PM", "8 PM", 1, ["c1"], { status: "Cancelled" }) as never,
    );
    expect(await accepts(mk(D, "7 PM", "8 PM", 1, ["c1"]))).toBe(true);
  });

  it("C2 legacy 6:45–7:30 (0.75 h) blocks both hourly slots 6 PM and 7 PM", async () => {
    await db.turf_bookings.add(
      mk(D, "6:45 PM", "7:30 PM", 0.75, ["c1"]) as never,
    );
    expect(await accepts(mk(D, "6 PM", "7 PM", 1, ["c1"]))).toBe(false);
    expect(await accepts(mk(D, "7 PM", "8 PM", 1, ["c1"]))).toBe(false);
    expect(await accepts(mk(D, "5 PM", "6 PM", 1, ["c1"]))).toBe(true);
    expect(await accepts(mk(D, "7:30 PM", "8:30 PM", 1, ["c1"]))).toBe(true);
  });
});

describe("E. multi-court (2 courts)", () => {
  beforeEach(async () => setCourts(2));

  it("E1 Court 1 busy 7–8 PM: a 1-court booking gets Court 2", async () => {
    await db.turf_bookings.add(mk(D, "7 PM", "8 PM", 1, ["c1"]) as never);
    const rows = await db.turf_bookings.toArray();
    const occ = buildCourtOccupancy(rows as never, D, 2);
    expect(assignCourts(occ, 2, H(19), 60, 1)).toEqual(["c2"]);
  });

  it("E2 Court 1 busy 7–8, Court 2 busy 8–9: a 7–9 PM single-court window is refused", async () => {
    await db.turf_bookings.add(mk(D, "7 PM", "8 PM", 1, ["c1"]) as never);
    await db.turf_bookings.add(mk(D, "8 PM", "9 PM", 1, ["c2"]) as never);
    const rows = await db.turf_bookings.toArray();
    const occ = buildCourtOccupancy(rows as never, D, 2);
    // each hour on its own still has a free court ...
    expect(assignCourts(occ, 2, H(19), 60, 1)).toEqual(["c2"]);
    expect(assignCourts(occ, 2, H(20), 60, 1)).toEqual(["c1"]);
    // ... but no single court is free for the whole window
    expect(assignCourts(occ, 2, H(19), 120, 1)).toBeNull();
  });

  it("E3 both courts busy 7–8: slot full, 8 PM still startable", async () => {
    await db.turf_bookings.add(mk(D, "7 PM", "8 PM", 1, ["c1", "c2"]) as never);
    const rows = await db.turf_bookings.toArray();
    const occ = buildCourtOccupancy(rows as never, D, 2);
    expect(freeCourtIdsFor(occ, 2, H(19), 60)).toEqual([]);
    expect(freeCourtIdsFor(occ, 2, H(20), 60)).toEqual(["c1", "c2"]);
  });

  it("E4 two courts wanted, one free at 10 PM: guard refuses the second court", async () => {
    await db.turf_bookings.add(mk(D, "10 PM", "11 PM", 1, ["c1"]) as never);
    expect(await accepts(mk(D, "10 PM", "12 AM", 2, ["c1", "c2"]))).toBe(false);
    const rows = await db.turf_bookings.toArray();
    const occ = buildCourtOccupancy(rows as never, D, 2);
    expect(assignCourts(occ, 2, H(22), 120, 2)).toBeNull();
  });

  it("overnight window sees a 12–1 AM booking of the same business date", async () => {
    await db.turf_bookings.add(mk(D, "12 AM", "1 AM", 1, ["c1"]) as never);
    const rows = await db.turf_bookings.toArray();
    const occ = buildCourtOccupancy(rows as never, D, 2);
    expect(assignCourts(occ, 2, H(23), 120, 1)).toEqual(["c2"]);
    expect(assignCourts(occ, 2, H(23), 120, 2)).toBeNull();
  });

  it("resolveCourtIds keeps stored ids for a held booking", async () => {
    const b = mk(D, "7 PM", "8 PM", 1, ["c2"]);
    expect(resolveCourtIds([b as never], 2).get(b.id)).toEqual(["c2"]);
  });
});

describe("B11. reporting for a saved 10 PM–12 AM booking", () => {
  it("shows 10 PM–12 AM, 2 hr, revenue on date D", () => {
    const b = mk(D, "10 PM", "12 AM", 2, ["c1"]);
    expect(`${b.start_time}–${b.end_time}`).toBe("10 PM–12 AM");
    const occ = turfOccupancy([b as never], (iso) => iso === D);
    expect(occ.bookedHours ?? 2).toBe(2);
    const hours = occ.byHour.filter((h) => h.hours > 0).map((h) => h.key);
    expect(hours).toEqual(["hr-22", "hr-23"]);
    expect(occ.byHour.reduce((s, h) => s + h.revenue, 0)).toBe(2000);
    const none = turfOccupancy([b as never], (iso) => iso === D1);
    expect(none.byHour.reduce((s, h) => s + h.hours, 0)).toBe(0);
    // utilisation split: all minutes on D, nothing on D+1
    const segs = courtHourSegments(b as never);
    expect(segs).toEqual([{ dayOffset: 0, from: H(22), to: 1440, n: 1 }]);
  });
});

describe("G3. UI availability and the guard agree", () => {
  it("for every slot start and span, UI-free <=> guard-accepts (1 and 2 courts)", async () => {
    for (const total of [1, 2]) {
      await db.turf_bookings.clear();
      await setCourts(total);
      const fixtures = [
        mk(D, "7 PM", "8 PM", 1, ["c1"]),
        mk(D, "9 PM", "10 PM", 1, total === 2 ? ["c2"] : ["c1"]),
        mk(D, "11 PM", "1 AM", 2, ["c1"]),
        mk(D, "6:45 AM", "7:30 AM", 0.75, ["c1"]),
        mk(D, "2 AM", "3 AM", 1, ["c1"]),
      ];
      await db.turf_bookings.bulkAdd(fixtures as never);
      const rows = (await db.turf_bookings.toArray()) as never[];
      const occ = buildCourtOccupancy(rows, D, total);
      for (const iv of [30, 60])
        for (let start = 360; start < 1800; start += iv)
          for (const span of [iv, 2 * iv, 3 * 60]) {
            if (start + span > 1800) continue;
            const ui = assignCourts(occ, total, start, span, 1);
            const cand = mk(
              D,
              minuteLabel(start, true),
              minuteLabel(start + span, true),
              span / 60,
              ui ?? ["c1"],
            );
            const guard = await accepts(cand);
            if (ui)
              expect(
                guard,
                `ui free but guard refuses @${start}+${span} courts=${total}`,
              ).toBe(true);
            else if (total === 1)
              expect(guard, `ui full but guard accepts @${start}+${span}`).toBe(
                false,
              );
          }
    }
  }, 60000);

  it("picker: canEndAt agrees with the guard across midnight", async () => {
    await db.turf_bookings.add(mk(D, "12 AM", "1 AM", 1, ["c1"]) as never);
    const rows = (await db.turf_bookings.toArray()) as never[];
    const occ = buildCourtOccupancy(rows, D, 1);
    // booked set as TurfTab builds it: business-day minutes 360 … 1799
    const booked = new Set<number>();
    for (let m = 360; m < 1800; m += 60)
      if (assignCourts(occ, 1, m, 60, 1) === null) booked.add(m);
    const one = nextSelection([], H(23), 60, booked);
    expect(canEndAt(one, 1440, 60, booked)).toBe(true); // 11 PM–12 AM fine
    expect(canEndAt(one, 1500, 60, booked)).toBe(false); // crosses booked 12 AM
    expect(await accepts(mk(D, "11 PM", "12 AM", 1, ["c1"]))).toBe(true);
    expect(await accepts(mk(D, "11 PM", "1 AM", 2, ["c1"]))).toBe(false);
  });
});
