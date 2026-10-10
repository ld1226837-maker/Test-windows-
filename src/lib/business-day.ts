import { localDateStr } from "@/lib/utils";
import { BUSINESS_DAY_START, parseMinutes } from "@/lib/time-slot-utils";

/** Previous calendar date of a "YYYY-MM-DD" string (no UTC/ISO conversion). */
export const previousDate = (date: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) - 86_400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

/**
 * One-time data upgrade: before the 6 AM–6 AM business day, a 12 AM–6 AM
 * booking was stored under its own calendar date. It now belongs to the
 * PREVIOUS date, so move any booking that starts before 6 AM back one day.
 * Rows that start at or after 6 AM, or have no usable start, are untouched.
 */
export function moveEarlyMorningToPreviousDay<
  T extends { booking_date?: unknown; start_time?: unknown },
>(row: T): T {
  const start = parseMinutes(
    typeof row.start_time === "string" ? row.start_time : null,
  );
  const date = typeof row.booking_date === "string" ? row.booking_date : "";
  if (start === null || start >= BUSINESS_DAY_START) return row;
  const prev = previousDate(date);
  return prev === date ? row : { ...row, booking_date: prev };
}

export { localDateStr };
