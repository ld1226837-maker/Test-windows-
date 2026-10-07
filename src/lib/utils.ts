import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Readable text for any caught value. Tauri plugin/native errors are plain
 * strings (no `.message`), so `(e as Error).message` rendered as an empty
 * toast. Always returns a non-empty string.
 */
export function errorMessage(
  e: unknown,
  fallback = "Something went wrong",
): string {
  if (typeof e === "string") return e.trim() || fallback;
  if (e instanceof Error) return e.message?.trim() || fallback;
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return fallback;
}

/**
 * IST calendar date as "YYYY-MM-DD" (fixed +5:30 offset, matching
 * analytics.ts monthKey/dayKey — the app is IST-only everywhere).
 *
 * `new Date().toISOString().slice(0, 10)` is a common but wrong pattern for
 * "today": toISOString() always renders in UTC, so for IST (UTC+5:30) it
 * returns yesterday's date for the first ~5.5 hours after local midnight.
 * Use this helper anywhere a plain calendar-date string is needed.
 */
export function localDateStr(d: Date = new Date()): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const year = ist.getUTCFullYear();
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** IST timestamp "YYYY-MM-DD-HH-mm-ss" for backup/archive filenames. */
export function istTimestampKey(d: Date = new Date()): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}-${p(ist.getUTCHours())}-${p(ist.getUTCMinutes())}-${p(ist.getUTCSeconds())}`;
}
