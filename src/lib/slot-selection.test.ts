import { describe, expect, it } from "vitest";
import {
  canEndAt,
  MAX_END,
  MIDNIGHT,
  nextSelection,
  slotsForSpan,
  spanFromTimes,
} from "./slot-selection";
import {
  DAY_PARTS,
  minuteLabel,
  parseMinutes,
  SLOT_INTERVALS,
} from "./time-slot-utils";
import { allowedIntervalsFor, DEFAULT_SLOT_DURATIONS } from "./ops";

const H = (h: number, m = 0) => h * 60 + m;
const set = (...n: number[]) => new Set(n);

/** Replay taps like the UI does: each tap runs nextSelection on the result. */
const taps = (
  taps: number[],
  interval: number,
  booked: Set<number>,
  start: number[] = [],
) => taps.reduce((sel, m) => nextSelection(sel, m, interval, booked), start);

describe("A. adjacent to an existing booking (60-min, 7–8 PM booked)", () => {
  const booked = set(H(19));
  it("A1 tap 8 PM -> 8–9 PM", () =>
    expect(taps([H(20)], 60, booked)).toEqual([H(20)]));
  it("A2 tap 6 PM -> 6–7 PM", () =>
    expect(taps([H(18)], 60, booked)).toEqual([H(18)]));
  it("A3 6 PM then booked 7 PM as END -> stays 6–7 PM", () =>
    expect(taps([H(18), H(19)], 60, booked)).toEqual([H(18)]));
  it("A4 6 PM then 8 PM crosses booked 7 -> rejected, selection unchanged", () => {
    const first = taps([H(18)], 60, booked);
    const after = nextSelection(first, H(20), 60, booked);
    expect(after).toBe(first); // same reference = refused
    expect(after).toEqual([H(18)]);
  });
  it("A5 booked 7 PM cannot start a booking", () =>
    expect(taps([H(19)], 60, booked)).toEqual([]));
  it("A6 7–8 and 9–10 booked, tap 8 PM -> 8–9 only", () => {
    const b = set(H(19), H(21));
    expect(taps([H(20)], 60, b)).toEqual([H(20)]);
    // and it cannot be stretched over the booked 9 PM
    const one = taps([H(20)], 60, b);
    expect(nextSelection(one, H(22), 60, b)).toBe(one);
  });
  it("A7 tap 8 PM then 10 PM -> 8–10 PM", () =>
    expect(taps([H(20), H(22)], 60, booked)).toEqual([H(20), H(21)]));
  it("A8 8–9 free, 9–10 booked: 8 PM then booked 9 PM as END -> 8–9", () =>
    expect(taps([H(20), H(21)], 60, set(H(21)))).toEqual([H(20)]));
});

describe("B. midnight (24:00)", () => {
  it("B1 tap 11 PM -> 11 PM–12 AM, end label 12 AM", () => {
    const sel = taps([H(23)], 60, set());
    expect(sel).toEqual([H(23)]);
    expect(minuteLabel(Math.max(...sel) + 60)).toBe("12 AM");
  });
  it("B2 10 PM then End at 12 AM -> 2 slots, 2 hr", () => {
    const sel = taps([H(22), MIDNIGHT], 60, set());
    expect(sel).toEqual([H(22), H(23)]);
    expect((sel.length * 60) / 60).toBe(2);
  });
  it("B3 8 PM then End at 12 AM -> 4 hr", () =>
    expect(taps([H(20), MIDNIGHT], 60, set())).toHaveLength(4));
  it("B4 canEndAt is false with no start; 12 AM is a valid start (first Late Night slot) but clock minutes before 6 AM are not", () => {
    expect(canEndAt([], MIDNIGHT, 60, set())).toBe(false);
    expect(taps([MIDNIGHT], 60, set())).toEqual([MIDNIGHT]);
    expect(taps([0], 60, set())).toEqual([]); // clock 12 AM, not a business minute
    expect(taps([MAX_END], 60, set())).toEqual([]); // 6 AM next morning ends the day
  });
  it("B5 11 PM–12 AM booked: 10 PM allowed", () =>
    expect(taps([H(22)], 60, set(H(23)))).toEqual([H(22)]));
  it("B6 11 PM booked: 10 PM then End at 12 AM refused", () => {
    const b = set(H(23));
    const one = taps([H(22)], 60, b);
    expect(canEndAt(one, MIDNIGHT, 60, b)).toBe(false);
    expect(nextSelection(one, MIDNIGHT, 60, b)).toBe(one);
  });
  it("B7 10–11 PM booked: 11 PM -> 11 PM–12 AM", () =>
    expect(taps([H(23)], 60, set(H(22)))).toEqual([H(23)]));
  it("B8 10–11 PM booked: 9 PM then End at 12 AM refused", () => {
    const b = set(H(22));
    const one = taps([H(21)], 60, b);
    expect(nextSelection(one, MIDNIGHT, 60, b)).toBe(one);
  });
  it("B9 (helper) edit of 10 PM–12 AM reconstructs span 120, not -1320", () => {
    const span = spanFromTimes(parseMinutes("10 PM"), parseMinutes("12 AM"), 2);
    expect(span).toBe(120);
    expect(slotsForSpan(H(22), span, 60)).toEqual([H(22), H(23)]);
  });
  it("B9b edit of 11 PM–1 AM keeps the 12–1 AM slot at 1440 (no wrap to 0)", () => {
    const span = spanFromTimes(parseMinutes("11 PM"), parseMinutes("1 AM"), 2);
    expect(span).toBe(120);
    expect(slotsForSpan(H(23), span, 60)).toEqual([H(23), MIDNIGHT]);
  });
});

describe("C. intervals", () => {
  it("C1 30-min: 7:00–8:00 booked, tap 8:00 PM -> 8:00–8:30", () =>
    expect(taps([H(20)], 30, set(H(19), H(19, 30)))).toEqual([H(20)]));
  it("C4 30-min: 11 PM then End at 12 AM -> 2 slots", () =>
    expect(taps([H(23), MIDNIGHT], 30, set())).toEqual([H(23), H(23, 30)]));
  it("C3/C6 only 30 and 60 exist; every day part tiles with both", () => {
    expect([...SLOT_INTERVALS]).toEqual([30, 60]);
    for (const iv of SLOT_INTERVALS)
      for (const p of DAY_PARTS) {
        expect((p.from * 60) % iv).toBe(0);
        expect((p.to * 60) % iv).toBe(0);
      }
    // 12 AM lands exactly on the grid for any start on either grid
    for (const iv of SLOT_INTERVALS)
      for (let m = 0; m < MIDNIGHT; m += iv)
        expect((MIDNIGHT - m) % iv).toBe(0);
  });
  it("15/45 are never offered, even if an old settings row enabled them", () => {
    expect(allowedIntervalsFor(DEFAULT_SLOT_DURATIONS)).toEqual([30, 60]);
    const legacy = {
      allow_15: true,
      allow_45: true,
      allow_30: false,
      allow_60: false,
      total_courts: 1,
    } as never;
    expect(allowedIntervalsFor(legacy)).toEqual([60]);
    expect(
      allowedIntervalsFor({ ...(legacy as object), allow_30: true } as never),
    ).toEqual([30]);
  });
  it("a 45-minute end is refused (off-grid)", () =>
    expect(canEndAt([H(18)], H(18, 45), 60, set())).toBe(false));
});

describe("D. day-part boundaries", () => {
  it("D1 7 PM (Evening) then 9 PM (Night) -> 7–9 PM", () =>
    expect(taps([H(19), H(21)], 60, set())).toEqual([H(19), H(20)]));
  it("D2 8–9 PM booked: 7 PM then 10 PM rejected", () => {
    const b = set(H(20));
    const one = taps([H(19)], 60, b);
    expect(nextSelection(one, H(22), 60, b)).toBe(one);
  });
  it("D4 Late Night: 12 AM then 6 AM -> 12–6 AM, saved under the PREVIOUS date's night", () => {
    const sel = taps([MIDNIGHT, MAX_END], 60, set());
    expect(sel).toEqual([1440, 1500, 1560, 1620, 1680, 1740]);
    expect(minuteLabel(sel[0]!)).toBe("12 AM");
    expect(minuteLabel(sel[sel.length - 1]! + 60)).toBe("6 AM");
  });
  it("D5 10 PM then 3 AM -> 5 hr on one business date", () => {
    const sel = taps([H(22), 1440 + 180], 60, set());
    expect(sel).toHaveLength(5);
    expect(minuteLabel(sel[0]!)).toBe("10 PM");
    expect(minuteLabel(sel[sel.length - 1]! + 60)).toBe("3 AM");
  });
});

describe("overnight (owner's patch: end up to 6 AM next day)", () => {
  it("11 PM then 1 AM next day -> [23:00, 24:00], end label 1 AM", () => {
    const sel = taps([H(23), MIDNIGHT + 60], 60, set());
    expect(sel).toEqual([H(23), MIDNIGHT]);
    expect(minuteLabel(Math.max(...sel) + 60)).toBe("1 AM");
  });
  it("blocked by a booked next-day slot inside the span", () => {
    const b = set(MIDNIGHT); // 12–1 AM next day booked
    const one = taps([H(23)], 60, b);
    expect(nextSelection(one, MIDNIGHT + 60, 60, b)).toBe(one);
    // ending exactly at 12 AM is still fine (half-open)
    expect(canEndAt(one, MIDNIGHT, 60, b)).toBe(true);
  });
  it("cannot run past 6 AM next day", () => {
    expect(canEndAt([H(23)], MAX_END, 60, set())).toBe(true);
    expect(canEndAt([H(23)], MAX_END + 60, 60, set())).toBe(false);
  });
});

describe("G. regression guards", () => {
  it("G1 a booked slot never ends up in the selection (exhaustive 2-tap)", () => {
    for (const iv of SLOT_INTERVALS) {
      const booked = set(H(10), H(19), H(21), H(23), MIDNIGHT, MIDNIGHT + 60);
      const starts = [] as number[];
      for (let m = 360; m < MAX_END; m += iv) starts.push(m);
      const ends = [
        ...starts,
        ...Array.from({ length: 1440 / iv + 1 }, (_, i) => 360 + i * iv),
      ];
      for (const a of starts)
        for (const b of ends) {
          const sel = taps([a, b], iv, booked);
          expect(sel.some((x) => booked.has(x))).toBe(false);
        }
    }
  });
  it("G2 selection stays contiguous: hours and end_time derive from it", () => {
    const sel = taps([H(18), H(21)], 60, set()); // 6–9 PM
    // tapping a middle slot truncates instead of leaving a hole
    const cut = nextSelection(sel, H(19), 60, set());
    expect(cut).toEqual([H(18)]);
    for (const s of [sel, cut]) {
      const sorted = [...s].sort((a, b) => a - b);
      sorted.forEach((x, i) => expect(x).toBe(sorted[0]! + i * 60));
      expect(minuteLabel(sorted[sorted.length - 1]! + 60)).toBe(
        minuteLabel(sorted[0]! + sorted.length * 60),
      );
    }
  });
  it("tapping the first selected slot clears; tapping before a lone start re-aims", () => {
    expect(nextSelection([H(18), H(19)], H(18), 60, set())).toEqual([]);
    expect(taps([H(20), H(18)], 60, set())).toEqual([H(18), H(19)]);
  });
});
