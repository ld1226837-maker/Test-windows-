import { describe, expect, it } from "vitest";
import { DATA_TABLES } from "./localdb";
import { findInvalidRows } from "./backup-validate";

describe("R18 backup completeness", () => {
  it("declares counters and calendar exceptions as backup data", () => {
    expect(DATA_TABLES).toContain("counters");
    expect(DATA_TABLES).toContain("calendar_event_exceptions");
  });
  it("rejects orphan recurring-event exceptions", () => {
    const bad: any = {
      customers: [],
      teams: [],
      team_players: [],
      calendar_events: [],
      calendar_event_exceptions: [
        {
          id: "x",
          event_id: "missing",
          occurrence_at: "2026-10-01T10:00:00.000Z",
          status: "done",
        },
      ],
      investments: [],
      counters: [],
    };
    expect(
      findInvalidRows(bad).some((x) => x.table === "calendar_event_exceptions"),
    ).toBe(true);
  });
});
