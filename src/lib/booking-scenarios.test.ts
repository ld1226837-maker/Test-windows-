/**
 * Booking SCENARIO matrix for the calendar-day model (see
 * docs/BOOKING-SCENARIOS-TEST-PLAN.md). Minutes are clock minutes of the
 * booking's own date; a booking past midnight spills onto the next date.
 */
import { describe, expect, it } from "vitest";
import {
  buildOccupancy,
  courtHourSegments,
  freeCourtsFor,
  selectionFits,
  windowFits,
  type CourtBooking,
} from "./courts";
import { minuteLabel, parseMinutes, rangeLabel } from "./time-slot-utils";

const H = (h: number, m = 0) => h * 60 + m;
const D = "2026-10-10";
const N = "2026-10-11";
const bk = (
  date: string,
  start: string,
  end: string,
  hours: number,
  courts = 1,
  id = Math.random().toString(36).slice(2),
): CourtBooking => ({
  id,
  booking_date: date,
  start_time: start,
  end_time: end,
  hours,
  courts,
  status: "Confirmed",
});

describe("S1 same-day bookings", () => {
  it("6–8 AM blocks exactly those two hours", () => {
    const occ = buildOccupancy([bk(D, "6 AM", "8 AM", 2)], D);
    expect(windowFits(occ, 1, H(6), 120, 1)).toBe(false);
    expect(windowFits(occ, 1, H(5), 60, 1)).toBe(true);
    expect(windowFits(occ, 1, H(8), 60, 1)).toBe(true);
  });
  it("back-to-back 5–6 AM then 6–7 AM both fit", () => {
    const occ = buildOccupancy([bk(D, "5 AM", "6 AM", 1)], D);
    expect(windowFits(occ, 1, H(6), 60, 1)).toBe(true);
  });
});

describe("S2 24-hour checks", () => {
  it("12 AM → 12 AM (24 h) fills the whole date and nothing of the next", () => {
    const b = bk(D, "12 AM", "12 AM", 24);
    const onD = buildOccupancy([b], D);
    for (let m = 0; m < 1440; m += 60)
      expect(windowFits(onD, 1, m, 60, 1)).toBe(false);
    expect(buildOccupancy([b], N).size).toBe(0);
  });
  it("6 AM → 6 AM next morning (24 h) fills 6 AM–12 AM here and 12–6 AM next date", () => {
    const b = bk(D, "6 AM", "6 AM", 24);
    expect(windowFits(buildOccupancy([b], D), 1, H(6), 60, 1)).toBe(false);
    const onN = buildOccupancy([b], N);
    expect(windowFits(onN, 1, 0, 360, 1)).toBe(false);
    expect(windowFits(onN, 1, H(6), 60, 1)).toBe(true);
  });
  it("every hour of a 24 h day can be booked alone when empty", () => {
    const occ = buildOccupancy([], D);
    for (let m = 0; m < 1440; m += 60)
      expect(windowFits(occ, 1, m, 60, 1)).toBe(true);
  });
});

describe("S3 cross-day (past midnight)", () => {
  it("10 PM → 2 AM spills 0–120 onto the next date", () => {
    const b = bk(D, "10 PM", "2 AM", 4);
    expect(windowFits(buildOccupancy([b], D), 1, H(22), 120, 1)).toBe(false);
    const onN = buildOccupancy([b], N);
    expect(windowFits(onN, 1, 0, 120, 1)).toBe(false);
    expect(windowFits(onN, 1, H(2), 60, 1)).toBe(true);
  });
  it("a next-date 1 AM booking is blocked by the previous night's spill", () => {
    const night = bk(D, "11 PM", "1 AM", 2);
    const occ = buildOccupancy([night], N);
    expect(selectionFits(occ, 1, [H(0), H(1)], 60, 1)).toBe(false);
    expect(selectionFits(occ, 1, [H(1)], 60, 1)).toBe(true);
  });
  it("end exactly at the next booking's start is fine", () => {
    const night = bk(D, "11 PM", "1 AM", 2);
    expect(windowFits(buildOccupancy([night], N), 1, H(1), 60, 1)).toBe(true);
  });
});

describe("S4 5 AM → 7 AM", () => {
  it("stays on one date (no seam in the calendar-day model) and round-trips labels", () => {
    const b = bk(D, "5 AM", "7 AM", 2);
    const occ = buildOccupancy([b], D);
    expect(windowFits(occ, 1, H(5), 120, 1)).toBe(false);
    expect(windowFits(occ, 1, H(4), 60, 1)).toBe(true);
    expect(windowFits(occ, 1, H(7), 60, 1)).toBe(true);
    expect(rangeLabel([H(5), H(6)], 60)).toBe("5 AM – 7 AM");
    expect(parseMinutes("7 AM")! - parseMinutes("5 AM")!).toBe(120);
    expect(minuteLabel(H(5))).toBe("5 AM");
  });
  it("overlap with a 6–7 AM booking is detected from either side", () => {
    const six = bk(D, "6 AM", "7 AM", 1);
    expect(windowFits(buildOccupancy([six], D), 1, H(5), 120, 1)).toBe(false);
    const five = bk(D, "5 AM", "7 AM", 2);
    expect(windowFits(buildOccupancy([five], D), 1, H(6), 60, 1)).toBe(false);
  });
  it("2 courts: one busy 6–7 AM leaves 1 free; a 2-court 5–7 AM is refused", () => {
    const occ = buildOccupancy([bk(D, "6 AM", "7 AM", 1)], D);
    expect(freeCourtsFor(occ, 2, H(5), 120)).toBe(1);
    expect(windowFits(occ, 2, H(5), 120, 2)).toBe(false);
    expect(windowFits(occ, 2, H(5), 120, 1)).toBe(true);
  });
});

describe("S5 utilisation segments", () => {
  it("5–7 AM is one segment", () => {
    expect(courtHourSegments(bk(D, "5 AM", "7 AM", 2))).toEqual([
      { dayOffset: 0, from: 300, to: 420, n: 1 },
    ]);
  });
  it("10 PM–2 AM splits across the two dates", () => {
    expect(courtHourSegments(bk(D, "10 PM", "2 AM", 4))).toEqual([
      { dayOffset: 0, from: 1320, to: 1440, n: 1 },
      { dayOffset: 1, from: 0, to: 120, n: 1 },
    ]);
  });
});
