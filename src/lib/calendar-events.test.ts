import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  occurrenceAt,
  latestOccurrenceOnOrBefore,
  occurrencesBetween,
} from "./calendar-events";

describe("calendar repeat occurrences", () => {
  it("clamps Jan 31 to Feb end without losing the 31st anchor", () => {
    const d = occurrenceAt(
      "2026-01-31T09:00:00+05:30",
      "monthly",
      new Date("2026-02-01T00:00:00+05:30"),
    );
    expect(d.toISOString()).toBe("2026-02-28T03:30:00.000Z");
  });
  it("keeps yearly Feb 29 on Feb 28 in non-leap years", () => {
    const d = occurrenceAt(
      "2024-02-29T09:00:00+05:30",
      "yearly",
      new Date("2025-01-01T00:00:00+05:30"),
    );
    expect(d.toISOString()).toBe("2025-02-28T03:30:00.000Z");
  });
  it("does not materialize outside the requested window", () => {
    const row: any = {
      start_at: "2026-01-01T09:00:00+05:30",
      repeat: "weekly",
      end_at: null,
    };
    const xs = occurrencesBetween(
      row,
      new Date("2026-01-15T00:00:00+05:30"),
      new Date("2026-02-01T00:00:00+05:30"),
    );
    expect(xs.length).toBe(3);
  });
  it("handles leap day and keeps the stored +05:30 wall clock", () => {
    const d = occurrenceAt(
      "2024-02-29T23:15:00+05:30",
      "yearly",
      new Date("2025-01-01T00:00:00+05:30"),
    );
    expect(d.toISOString()).toBe("2025-02-28T17:45:00.000Z");
  });
  it("includes a recurring multi-day occurrence that starts before the window", () => {
    const row: any = {
      start_at: "2026-01-05T23:00:00+05:30",
      end_at: "2026-01-06T02:00:00+05:30",
      repeat: "weekly",
    };
    const xs = occurrencesBetween(
      row,
      new Date("2026-01-06T00:00:00+05:30"),
      new Date("2026-01-06T23:59:59+05:30"),
    );
    expect(xs.length).toBe(1);
  });
});

it("preserves multi-day duration for recurring occurrences", () => {
  const row: any = {
    start_at: "2026-01-10T09:00:00+05:30",
    end_at: "2026-01-12T09:00:00+05:30",
    repeat: "monthly",
  };
  const xs = occurrencesBetween(
    row,
    new Date("2026-02-01T00:00:00+05:30"),
    new Date("2026-02-28T23:59:59+05:30"),
  );
  expect(xs).toHaveLength(1);
  const duration =
    new Date("2026-01-12T09:00:00+05:30").getTime() -
    new Date("2026-01-10T09:00:00+05:30").getTime();
  expect(duration).toBe(2 * 24 * 60 * 60 * 1000);
});

it("keeps an all-day monthly Jan 31 event on month-end dates", () => {
  const base = "2027-01-31T00:00:00+05:30";
  const from = new Date("2027-01-31T00:00:00+05:30");
  const to = new Date("2027-05-01T23:59:59+05:30");
  const xs = occurrencesBetween(
    { start_at: base, end_at: null, repeat: "monthly" } as any,
    from,
    to,
  );
  expect(xs.map((d) => d.toISOString())).toEqual([
    "2027-01-30T18:30:00.000Z",
    "2027-02-27T18:30:00.000Z",
    "2027-03-30T18:30:00.000Z",
    "2027-04-29T18:30:00.000Z",
  ]);
});

it("keeps Feb 29 yearly recurrence on Feb 28 in non-leap years", () => {
  const base = "2028-02-29T00:00:00+05:30";
  const from = new Date("2028-02-29T00:00:00+05:30");
  const to = new Date("2030-03-01T23:59:59+05:30");
  const xs = occurrencesBetween(
    { start_at: base, end_at: null, repeat: "yearly" } as any,
    from,
    to,
  );
  expect(xs.map((d) => d.toISOString())).toEqual([
    "2028-02-28T18:30:00.000Z",
    // Feb 28 00:00 IST == Feb 27 18:30 UTC
    "2029-02-27T18:30:00.000Z",
    "2030-02-27T18:30:00.000Z",
  ]);
});

it("can resolve the latest occurrence of an old recurring reminder", () => {
  const bound = new Date("2026-10-01T00:00:00+05:30");
  const d = latestOccurrenceOnOrBefore(
    new Date("2020-01-31T09:00:00+05:30"),
    "monthly",
    bound,
  );
  expect(d).not.toBeNull();
  expect(d!.getTime()).toBeLessThanOrEqual(bound.getTime());
  // Latest monthly occurrence before Oct 1 IST is Sep 30 09:00 IST (31st clamped).
  expect(d!.toISOString()).toBe("2026-09-30T03:30:00.000Z");
});
