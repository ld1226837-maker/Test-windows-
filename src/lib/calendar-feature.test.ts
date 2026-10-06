import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./localdb";
import { saveCalendarOccurrenceAsOneOff } from "./calendar-events";

describe("calendar occurrence editing", () => {
  beforeEach(async () => {
    await db.calendar_events.clear();
    await db.calendar_event_exceptions.clear();
  });
  it("turns one recurring occurrence into an independent event and preserves the series", async () => {
    await db.calendar_events.put({
      id: "series",
      kind: "meeting",
      title: "Weekly",
      notes: null,
      start_at: "2026-10-01T10:00:00.000+05:30",
      end_at: "2026-10-01T11:00:00.000+05:30",
      all_day: false,
      remind_before_minutes: null,
      repeat: "weekly",
      status: "pending",
      color: "#2563eb",
      customer_id: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    });
    const one = await saveCalendarOccurrenceAsOneOff({
      id: "series@2026-10-08T04:30:00.000Z",
      kind: "meeting",
      title: "Weekly",
      notes: null,
      start_at: "2026-10-08T04:30:00.000Z",
      end_at: "2026-10-08T05:30:00.000Z",
      all_day: false,
      remind_before_minutes: null,
      repeat: "weekly",
      status: "pending",
      color: "#2563eb",
      customer_id: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    });
    expect(one.repeat).toBe("none");
    expect(await db.calendar_events.get("series")).toBeTruthy();
    expect(await db.calendar_events.get(one.id)).toMatchObject({
      repeat: "none",
      start_at: "2026-10-08T04:30:00.000Z",
    });
    expect(
      (
        await db.calendar_event_exceptions.get(
          "series@2026-10-08T04:30:00.000Z",
        )
      )?.status,
    ).toBe("cancelled");
  });
});
