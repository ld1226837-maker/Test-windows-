import { Moon, MoonStar, Sunrise, Sun, Sunset } from "lucide-react";
import { localDateStr } from "@/lib/utils";

export const DAY_PARTS = [
  // Earliest hours of the calendar day — previously unbookable since the
  // day-part list jumped straight from midnight to Morning at 6 AM.
  { id: "latenight", label: "Late Night", icon: MoonStar, from: 0, to: 6 },
  { id: "morning", label: "Morning", icon: Sunrise, from: 6, to: 12 },
  { id: "afternoon", label: "Afternoon", icon: Sun, from: 12, to: 16 },
  { id: "evening", label: "Evening", icon: Sunset, from: 16, to: 20 },
  // Night runs through to midnight — last slot ends at 12:00 AM, which is
  // where Late Night (above) picks back up for the same calendar date.
  { id: "night", label: "Night", icon: Moon, from: 20, to: 24 },
] as const;

export type DayPartId = (typeof DAY_PARTS)[number]["id"];

/* ------------------------------------------------------------------------ *
 * BUSINESS DAY
 *
 * The turf's day runs 6 AM -> 6 AM. The 12 AM-6 AM slots that follow a night
 * belong to the PREVIOUS date: a 2 AM booking made for Saturday night is
 * stored with booking_date = Saturday, start_time "2 AM". Minutes inside a
 * business day are therefore counted from 6 AM: 360 … 1440 (12 AM) … 1800
 * (6 AM the next morning). A stored start before 6 AM is read as 1440 + it.
 * ------------------------------------------------------------------------ */

/** First minute of the business day (6 AM). */
export const BUSINESS_DAY_START = 360;
/** One past the last minute of the business day (6 AM the next morning). */
export const BUSINESS_DAY_END = 1800;

/** Clock minutes (0–1439) -> minutes inside the business day (360–1799). */
export const businessMinutes = (clock: number) =>
  clock < BUSINESS_DAY_START ? clock + 1440 : clock;

/** The business date "now" belongs to (before 6 AM it is still yesterday). */
export const businessDateOf = (now: Date = new Date()) =>
  localDateStr(new Date(now.getTime() - BUSINESS_DAY_START * 60_000));

/** A day part's slot window in business-day minutes (Late Night is last). */
export const partWindow = (p: { id: string; from: number; to: number }) =>
  p.id === "latenight"
    ? ([1440 + p.from * 60, 1440 + p.to * 60] as const)
    : ([p.from * 60, p.to * 60] as const);

/** Day parts in business-day order: Morning … Night, then Late Night. */
export const PICKER_PARTS = [
  ...DAY_PARTS.filter((p) => p.id !== "latenight"),
  ...DAY_PARTS.filter((p) => p.id === "latenight"),
] as const;

export const SLOT_INTERVALS = [30, 60] as const;

/** Formats minutes-from-midnight as "6:30 PM". Pass `alwaysMinutes` to keep ":00". */
export const minuteLabel = (mins: number, alwaysMinutes = false) => {
  const m = ((mins % 1440) + 1440) % 1440;
  const hour24 = Math.floor(m / 60);
  const minute = m % 60;
  const suffix = hour24 < 12 ? "AM" : "PM";
  const base = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute === 0 && !alwaysMinutes
    ? `${base} ${suffix}`
    : `${base}:${String(minute).padStart(2, "0")} ${suffix}`;
};

/** Kept for compatibility — whole-hour label. */
export const hourLabel = (h: number) => minuteLabel(h * 60);

/** Parses "6 PM" / "6:30 PM" back to minutes-from-midnight. Returns null if unparseable. */
export const parseMinutes = (label: string | null) => {
  if (!label) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(label.trim());
  if (!m) return null;
  const hourToken = Number(m[1]);
  const minuteToken = m[2] !== undefined ? Number(m[2]) : 0;
  // A 12-hour label's hour must be 1–12 and minute 0–59; without this, strings
  // like "25 PM" or "6:99 AM" matched the regex shape and silently produced
  // garbage minute values instead of being rejected.
  if (hourToken < 1 || hourToken > 12 || minuteToken > 59) return null;
  const base = hourToken % 12;
  const hour = m[3]!.toUpperCase() === "PM" ? base + 12 : base;
  return hour * 60 + minuteToken;
};

export const rangeLabel = (slots: number[], interval = 60) => {
  if (slots.length === 0) return "";
  const sorted = [...slots].sort((a, b) => a - b);
  const alwaysMinutes = interval < 60;
  return `${minuteLabel(sorted[0]!, alwaysMinutes)} – ${minuteLabel(sorted[sorted.length - 1]! + interval, alwaysMinutes)}`;
};

/** "1 hr 30 min" from minutes. */
export const durationLabel = (totalMins: number) => {
  const hrs = Math.floor(totalMins / 60);
  const rem = totalMins % 60;
  if (hrs > 0 && rem > 0) return `${hrs} hr ${rem} min`;
  if (hrs > 0) return `${hrs} hr`;
  return `${rem} min`;
};

/** "1 hr 30 min" from fractional hours. */
export const hoursLabel = (hours: number) =>
  durationLabel(Math.round(hours * 60));

/**
 * Which way a touch gesture swiped, or null if it wasn't a deliberate
 * horizontal swipe. Needs > 50px sideways AND clearly more sideways than
 * vertical travel, so a diagonal page scroll that starts on the slot grid
 * isn't mistaken for a swipe.
 */
export const swipeDirection = (dx: number, dy: number): 1 | -1 | null => {
  if (Math.abs(dx) <= 50 || Math.abs(dx) <= Math.abs(dy) * 2) return null;
  return dx < 0 ? 1 : -1;
};
