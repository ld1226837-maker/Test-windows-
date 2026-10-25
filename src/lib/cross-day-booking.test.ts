import { describe, expect, it } from "vitest";
import {
  canEndAt,
  LAST_END,
  MAX_END,
  MAX_SPAN,
  MIDNIGHT,
  nextSelection,
  slotsForSpan,
  spanFromTimes,
} from "./slot-selection";
import {
  absInterval,
  assignCourts,
  buildCourtOccupancy,
  courtHourSegments,
} from "./courts";
import {
  BOOKING_END_LIMIT,
  businessMinutes,
  minuteLabel,
  parseMinutes,
  partWindow,
  PICKER_PARTS,
  rangeLabel,
} from "./time-slot-utils";

/**
 * CROSS-DAY / 24-HOUR BOOKING SCENARIOS
 *
 * The turf's business day runs 6 AM -> 6 AM. Minutes are counted from the
 * business date's 6 AM: 360 = 6 AM, 1440 = 12 AM, 1740 = 5 AM, 1800 = 6 AM
 * the next morning (= the NEXT business date's 6 AM, 360 there).
 *
 *  Scenario                               start   end    result
 *  S1  5–7 AM (the reported bug)          1740    1860   allowed
 *  S2  5:30–6:30 AM (30-min grid)         1770    1830   allowed
 *  S3  5–6 AM / 6–7 AM separately         unchanged
 *  S4  overnight 11 PM–1 AM               unchanged
 *  S5  24 h: 6 AM -> 6 AM                 360     1800   allowed
 *  S6  24 h: 7 PM -> 7 PM next evening    1140    2580   allowed
 *  S7  24 h: 5 AM -> 5 AM                 1740    3180   allowed
 *  S8  > 24 h (e.g. 25 h)                                refused
 *  S9  conflicts on this date / next date                refused / allowed edge
 *  S10 multi-court                                       per-court assignment
 *  S11 stored label round-trip (save + edit)             span survives
 */

const H = (h: number, m = 0) => h * 60 + m;
const set = (...n: number[]) => new Set(n);
const taps = (
  t: number[],
  interval: number,
  booked: Set<number>,
  start: number[] = [],
) => t.reduce((sel, m) => nextSelection(sel, m, interval, booked), start);

const D = "2026-10-10";
const D1 = "2026-10-11";
let seq = 0;
const mk = (
  date: string,
  start: string,
  end: string,
  hours: number,
  court_ids: string[] = ["c1"],
) => ({
  id: `x${++seq}`,
  booking_date: date,
  start_time: start,
  end_time: end,
  hours,
  courts: court_ids.length,
  court_ids,
  status: "Confirmed",
});

const AM5 = 1740; // 5 AM in business minutes
const AM6N = 1800; // 6 AM next morning
const AM7N = 1860; // 7 AM next morning

describe("S1 5 AM–7 AM (the reported bug)", () => {
  it("is allowed: tap 5 AM, then 7 AM (next day tab)", () => {
    const sel = taps([AM5, AM7N], 60, set());
    expect(sel).toEqual([AM5, AM6N]);
    expect(rangeLabel(sel, 60)).toBe("5 AM – 7 AM");
    expect(minuteLabel(sel[0]!)).toBe("5 AM");
    expect(minuteLabel(sel[sel.length - 1]! + 60)).toBe("7 AM");
  });
  it("canEndAt agrees", () => {
    expect(canEndAt([AM5], AM7N, 60, set())).toBe(true);
  });
  it("the stored labels rebuild the same selection (edit round-trip)", () => {
    const startM = parseMinutes("5 AM");
    const endM = parseMinutes("7 AM");
    const span = spanFromTimes(startM, endM, 2);
    expect(span).toBe(120);
    expect(slotsForSpan(businessMinutes(startM!), span, 60)).toEqual([
      AM5,
      AM6N,
    ]);
  });
  it("30-minute grid: 5:30–6:30 AM and 5–7 AM", () => {
    expect(taps([H(29, 30), H(30, 30)], 30, set())).toEqual([1770, 1800]);
    expect(taps([AM5, AM7N], 30, set())).toEqual([1740, 1770, 1800, 1830]);
  });
  it("5–6 AM and 6–7 AM on their own still work", () => {
    expect(taps([AM5, AM6N], 60, set())).toEqual([AM5]);
    expect(taps([H(6), H(7)], 60, set())).toEqual([H(6)]);
  });
  it("the next-day slots can never START a booking", () => {
    expect(taps([AM6N], 60, set())).toEqual([]);
    expect(taps([AM7N], 60, set())).toEqual([]);
  });
});

describe("S4 overnight bookings are unchanged", () => {
  it("11 PM–1 AM", () =>
    expect(taps([H(23), MIDNIGHT + 60], 60, set())).toEqual([H(23), MIDNIGHT]));
  it("12 AM–6 AM", () =>
    expect(taps([MIDNIGHT, MAX_END], 60, set())).toHaveLength(6));
});

describe("S5–S7 24-hour bookings", () => {
  it("S5 6 AM -> 6 AM next morning is exactly 24 h", () => {
    const sel = taps([H(6), MAX_END], 60, set());
    expect(sel).toHaveLength(24);
    expect(canEndAt([H(6)], MAX_END, 60, set())).toBe(true);
    expect(spanFromTimes(360, 360, 24)).toBe(1440);
  });
  it("S6 7 PM -> 7 PM the next evening is 24 h and crosses the cut-off", () => {
    const end = H(19) + MAX_SPAN;
    expect(end).toBe(2580);
    const sel = taps([H(19), end], 60, set());
    expect(sel).toHaveLength(24);
    expect(minuteLabel(sel[sel.length - 1]! + 60)).toBe("7 PM");
  });
  it("S7 5 AM -> 5 AM (latest possible 24 h) is allowed", () => {
    const end = AM5 + MAX_SPAN;
    expect(end).toBe(3180);
    expect(end).toBeLessThanOrEqual(LAST_END);
    expect(taps([AM5, end], 60, set())).toHaveLength(24);
    expect(spanFromTimes(parseMinutes("5 AM"), parseMinutes("5 AM"), 24)).toBe(
      1440,
    );
  });
  it("S5b 30-min grid 24 h = 48 slots", () =>
    expect(taps([H(6), MAX_END], 30, set())).toHaveLength(48));
});

describe("S8 longer than 24 h is refused", () => {
  it("6 AM -> 7 AM next morning (25 h)", () => {
    expect(canEndAt([H(6)], MAX_END + 60, 60, set())).toBe(false);
    const one = taps([H(6)], 60, set());
    expect(nextSelection(one, MAX_END + 60, 60, set())).toBe(one);
  });
  it("7 PM -> 8 PM next evening (25 h)", () => {
    expect(canEndAt([H(19)], H(19) + MAX_SPAN + 60, 60, set())).toBe(false);
  });
  it("one minute grid step past 24 h from 5:30 AM on 30-min grid", () => {
    expect(canEndAt([1770], 1770 + MAX_SPAN, 30, set())).toBe(true);
    expect(canEndAt([1770], 1770 + MAX_SPAN + 30, 30, set())).toBe(false);
  });
  it("nothing may end past the absolute limit", () => {
    expect(BOOKING_END_LIMIT).toBe(LAST_END);
    expect(canEndAt([AM5], LAST_END + 60, 60, set())).toBe(false);
  });
  it("the Next Day picker tab covers 6 AM … BOOKING_END_LIMIT", () => {
    const next = PICKER_PARTS.find((p) => p.id === "nextday")!;
    expect(partWindow(next)).toEqual([1800, BOOKING_END_LIMIT]);
  });
});

describe("S9 conflicts with bookings already on file", () => {
  it("next date's 6–7 AM booked: 5–7 AM refused, 5–6 AM fine", () => {
    const booked = set(AM6N); // D+1 6 AM slot, shown at 1800 on date D
    const one = taps([AM5], 60, booked);
    expect(nextSelection(one, AM7N, 60, booked)).toBe(one); // refused
    expect(canEndAt(one, AM6N, 60, booked)).toBe(true); // half-open edge
  });
  it("a next-date booking starting at 7 AM does not block 5–7 AM", () => {
    expect(canEndAt([AM5], AM7N, 60, set(AM7N))).toBe(true);
  });
  it("this date's 5–6 AM booked: 5–7 AM cannot start there", () => {
    expect(taps([AM5, AM7N], 60, set(AM5))).toEqual([]);
  });
  it("a 24 h booking is blocked by any booked slot inside it", () => {
    const booked = set(H(23));
    expect(canEndAt([H(19)], H(19) + MAX_SPAN, 60, booked)).toBe(false);
    expect(canEndAt([H(19)], H(23), 60, booked)).toBe(true);
  });
});

describe("S9b occupancy / court maths across the 6 AM cut-off", () => {
  it("5–7 AM on D occupies D's 5–6 AM and D+1's 6–7 AM", () => {
    const b = mk(D, "5 AM", "7 AM", 2);
    expect(absInterval(b as never)).toEqual([
      Math.round(Date.UTC(2026, 9, 10) / 86_400_000) * 1440 + AM5,
      Math.round(Date.UTC(2026, 9, 10) / 86_400_000) * 1440 + AM5 + 120,
    ]);
    expect(courtHourSegments(b as never)).toEqual([
      { dayOffset: 0, from: AM5, to: 1800, n: 1 },
      { dayOffset: 1, from: 360, to: 420, n: 1 },
    ]);
  });
  it("viewing D+1: the booking blocks D+1's 6–7 AM only", () => {
    const rows = [mk(D, "5 AM", "7 AM", 2)];
    const occ = buildCourtOccupancy(rows as never, D1, 1);
    expect(assignCourts(occ, 1, H(6), 60, 1)).toBeNull();
    expect(assignCourts(occ, 1, H(7), 60, 1)).toEqual(["c1"]);
  });
  it("viewing D: the booking blocks 5–6 AM (1740) and the Next Day 6–7 AM (1800)", () => {
    const rows = [mk(D, "5 AM", "7 AM", 2)];
    const occ = buildCourtOccupancy(rows as never, D, 1);
    expect(assignCourts(occ, 1, AM5, 60, 1)).toBeNull();
    expect(assignCourts(occ, 1, AM6N, 60, 1)).toBeNull();
    expect(assignCourts(occ, 1, AM7N, 60, 1)).toEqual(["c1"]);
  });
  it("a booking already made on D+1 at 6 AM is visible from D (key 1800)", () => {
    const rows = [mk(D1, "6 AM", "8 AM", 2)];
    const occ = buildCourtOccupancy(rows as never, D, 1);
    expect(assignCourts(occ, 1, AM5, 60, 1)).toEqual(["c1"]);
    expect(assignCourts(occ, 1, AM6N, 60, 1)).toBeNull();
  });
  it("24 h booking from 6 AM stays on one date (single segment)", () => {
    expect(courtHourSegments(mk(D, "6 AM", "6 AM", 24) as never)).toEqual([
      { dayOffset: 0, from: 360, to: 1800, n: 1 },
    ]);
  });
  it("24 h booking from 7 PM spills 7 AM-ish into the next date", () => {
    expect(courtHourSegments(mk(D, "7 PM", "7 PM", 24) as never)).toEqual([
      { dayOffset: 0, from: H(19), to: 1800, n: 1 },
      { dayOffset: 1, from: 360, to: H(19), n: 1 },
    ]);
  });
  it("24 h booking the whole time even sees a booking 20 h later (beyond the old 48 h key cut)", () => {
    const rows = [mk(D, "7 PM", "7 PM", 24), mk(D1, "2 PM", "3 PM", 1, ["c2"])];
    const occ = buildCourtOccupancy(rows as never, D, 2);
    // D+1 2 PM = key 1440 + 840 + ... business-minute 1800 + (14*60-360) = 2280
    expect(assignCourts(occ, 2, 2280, 60, 1)).toBeNull(); // c1 held by the 24 h, c2 by the 2 PM one
  });
  it("multi-court: two 5–7 AM bookings fit on 2 courts, a third does not", () => {
    const rows = [
      mk(D, "5 AM", "7 AM", 2, ["c1"]),
      mk(D, "5 AM", "7 AM", 2, ["c2"]),
    ];
    const occ = buildCourtOccupancy(rows as never, D, 2);
    expect(assignCourts(occ, 2, AM5, 120, 1)).toBeNull();
    const one = buildCourtOccupancy([rows[0]!] as never, D, 2);
    expect(assignCourts(one, 2, AM5, 120, 1)).toEqual(["c2"]);
  });
  it("a cancelled booking does not block", () => {
    const b = { ...mk(D, "5 AM", "7 AM", 2), status: "Cancelled" };
    const occ = buildCourtOccupancy([b] as never, D1, 1);
    expect(assignCourts(occ, 1, H(6), 60, 1)).toEqual(["c1"]);
  });
});

describe("S11 label round-trips for every cross-day shape", () => {
  const cases: [string, number, number, number][] = [
    ["5 AM", AM5, AM7N, 120],
    ["5:30 AM", 1770, 1830, 60],
    ["11 PM", H(23), MIDNIGHT + 60, 120],
    ["6 AM", H(6), MAX_END, 1440],
    ["7 PM", H(19), H(19) + MAX_SPAN, 1440],
    ["5 AM", AM5, AM5 + MAX_SPAN, 1440],
  ];
  for (const [label, s, e, span] of cases)
    it(`${label} for ${span / 60} h`, () => {
      const endLabel = minuteLabel(e);
      const sM = parseMinutes(label)!;
      const eM = parseMinutes(endLabel)!;
      expect(spanFromTimes(sM, eM, span / 60)).toBe(span);
      const iv = span % 60 === 0 ? 60 : 30;
      expect(slotsForSpan(businessMinutes(sM), span, iv)).toHaveLength(
        span / iv,
      );
      expect(businessMinutes(sM)).toBe(s);
    });
});
