/**
 * Pure tap logic for the turf slot picker (no React, no storage).
 *
 * MODEL
 *  - `selected` holds the START minute of every covered slot, contiguous and
 *    ascending, on one `interval` grid (30 or 60).
 *  - First tap = start slot. Second tap = END boundary (exclusive): tapping
 *    8 PM after 6 PM selects 6–8 PM, never the 8 PM slot itself.
 *  - Minutes are BUSINESS-DAY minutes: the turf's day runs 6 AM -> 6 AM, so
 *    360 = 6 AM, 1440 = 12 AM, 1500 = 1 AM and 1800 = 6 AM the next morning.
 *    The 12-6 AM slots after a night belong to the PREVIOUS date (a 2 AM
 *    booking made for Saturday night is stored under Saturday).
 *  - Intervals are half-open `[start, end)`: a booking ending at 8 PM does
 *    not block the slot starting at 8 PM.
 *  - `booked` holds start minutes that cannot be used INSIDE a booking
 *    (Late Night slots are 1440+). A booked slot may still be tapped
 *    as an END, because an end is exclusive.
 */

import { BUSINESS_DAY_END, BUSINESS_DAY_START } from "@/lib/time-slot-utils";

/** 12 AM (the turn of the calendar day) in business-day minutes. */
export const MIDNIGHT = 1440;
/** Earliest start of a booking: 6 AM. */
export const MIN_START = BUSINESS_DAY_START;
/** Latest end of a booking: 6 AM the next morning (end of Late Night). */
export const MAX_END = BUSINESS_DAY_END;

/** Slot start minutes covering [start, end) on the `interval` grid. */
export const slotsBetween = (
  start: number,
  end: number,
  interval: number,
): number[] => {
  const out: number[] = [];
  for (let x = start; x < end; x += interval) out.push(x);
  return out;
};

/**
 * Can the current selection be closed at `end` (exclusive)? True when the end
 * is after the start, lands exactly on the grid, is not past `MAX_END`, and
 * every slot in [start, end) is free. `end` itself may be booked.
 */
export function canEndAt(
  selected: readonly number[],
  end: number,
  interval: number,
  booked: ReadonlySet<number> | readonly number[],
): boolean {
  if (selected.length === 0) return false;
  const start = Math.min(...selected);
  if (start < MIN_START || end <= start || end > MAX_END) return false;
  if ((end - start) % interval !== 0) return false;
  const isBooked = (m: number) =>
    Array.isArray(booked)
      ? (booked as readonly number[]).includes(m)
      : (booked as ReadonlySet<number>).has(m);
  for (let x = start; x < end; x += interval) if (isBooked(x)) return false;
  return true;
}

/**
 * Selection after a tap on `tapped`. Returns `prev` (same reference) when the
 * tap is not allowed, so callers can tell "rejected" from "changed".
 *
 *  - Tap on a selected slot: that slot becomes the end (slots from it onward
 *    are dropped); tapping the first slot clears the selection. The result is
 *    always contiguous, so `hours === selected.length × interval / 60` and
 *    `end_time === minuteLabel(last + interval)` always hold.
 *  - Nothing selected: the tap starts a booking. A booked slot, or a minute
 *    outside the business day (before 6 AM / at 6 AM next morning), can never
 *    be a start. 12 AM is a normal slot — the first of Late Night.
 *  - Otherwise the tap is the END boundary, accepted only via `canEndAt`.
 *    Tapping before the start re-aims a lone start (two-point range) or, with
 *    several slots selected, restarts at the tapped slot.
 */
export function nextSelection(
  prev: readonly number[],
  tapped: number,
  interval: number,
  booked: ReadonlySet<number> | readonly number[],
): number[] {
  const prevArr = prev as number[];
  const isBooked = (m: number) =>
    Array.isArray(booked)
      ? (booked as readonly number[]).includes(m)
      : (booked as ReadonlySet<number>).has(m);

  if (prev.includes(tapped)) {
    const sorted = [...prev].sort((a, b) => a - b);
    return sorted.filter((x) => x < tapped);
  }

  const canStart = (m: number) => m >= MIN_START && m < MAX_END && !isBooked(m);

  if (prev.length === 0) return canStart(tapped) ? [tapped] : prevArr;

  const start = Math.min(...prev);
  if (tapped > start) {
    return canEndAt(prev, tapped, interval, booked)
      ? slotsBetween(start, tapped, interval)
      : prevArr;
  }

  // Tapped before the current start.
  if (prev.length === 1) {
    return canEndAt([tapped], start, interval, booked) && canStart(tapped)
      ? slotsBetween(tapped, start, interval)
      : prevArr;
  }
  return canStart(tapped) ? [tapped] : prevArr;
}

/** Rebuild `selected` from a stored booking: absolute minutes, no wrap-around. */
export function slotsForSpan(
  startMin: number,
  spanMin: number,
  interval: number,
): number[] {
  return slotsBetween(startMin, startMin + spanMin, interval);
}

/**
 * Length in minutes of a stored booking. `end_time` "12 AM" parses to 0, so an
 * end at or before the start means "the following day" (+1440): 10 PM–12 AM
 * is 120, never −1320. Falls back to `hours` when a time is unparseable.
 */
export function spanFromTimes(
  startMin: number | null,
  endMin: number | null,
  hours: number,
): number {
  if (startMin !== null && endMin !== null)
    return endMin > startMin ? endMin - startMin : endMin + 1440 - startMin;
  return Math.max(1, Math.round((hours || 1) * 60));
}
