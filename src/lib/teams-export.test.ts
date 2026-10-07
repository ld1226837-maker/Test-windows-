import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./localdb";
import {
  buildTeamExportRows,
  loadTeamExportRows,
  teamNameContactRows,
  teamNameContactsToCsv,
  teamsToCsv,
} from "./teams-export";

const customers = [
  { id: "c1", name: "Arun", phone: "9876543210" },
  { id: "c2", name: "Bala", phone: null },
];
const teams = [
  { id: "t1", customer_id: "c1", name: "Lions", notes: "Sunday" },
  { id: "t2", customer_id: "c2", name: "Tigers", notes: null },
  {
    id: "t3",
    customer_id: "c1",
    name: "Gone",
    notes: null,
    deleted_at: "2026-10-01T00:00:00Z",
  },
];
const players = [
  { id: "p1", team_id: "t1", name: "Zed", phone: "9000000001", notes: null },
  { id: "p2", team_id: "t1", name: "Ali", phone: "9000000002", notes: "GK" },
];

describe("teams export", () => {
  it("builds one flat row per player and keeps empty teams", () => {
    const rows = buildTeamExportRows(customers, teams, players);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.Player)).toEqual(["Ali", "Zed", ""]);
    expect(rows[2]!.Team).toBe("Tigers");
    expect(rows.some((r) => r.Team === "Gone")).toBe(false);
  });
  it("limits to selected customers", () => {
    const rows = buildTeamExportRows(
      customers,
      teams,
      players,
      new Set(["c2"]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.Customer).toBe("Bala");
  });
  it("name-contact keeps only players", () => {
    const nc = teamNameContactRows(
      buildTeamExportRows(customers, teams, players),
    );
    expect(nc).toEqual([
      { Team: "Lions", Player: "Ali", "Contact No": "9000000002" },
      { Team: "Lions", Player: "Zed", "Contact No": "9000000001" },
    ]);
    expect(teamNameContactsToCsv(nc).split("\r\n")[0]).toBe(
      "Team,Player,Contact No",
    );
  });
  it("escapes CSV and neutralises formulas", () => {
    const csv = teamsToCsv(
      buildTeamExportRows(
        [{ id: "c1", name: "=cmd", phone: null }],
        [{ id: "t1", customer_id: "c1", name: 'A, "B"', notes: null }],
        [],
      ),
    );
    expect(csv).toContain("'=cmd");
    expect(csv).toContain('"A, ""B"""');
  });
  it("loads from the database, skipping soft-deleted teams", async () => {
    await db.customers.clear();
    await db.teams.clear();
    await db.team_players.clear();
    const now = "2026-10-05T00:00:00Z";
    await db.customers.put({
      id: "c1",
      name: "Arun",
      phone: "9876543210",
      created_at: now,
    });
    await db.teams.bulkPut([
      {
        id: "t1",
        customer_id: "c1",
        name: "Lions",
        notes: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: "t2",
        customer_id: "c1",
        name: "Old",
        notes: null,
        created_at: now,
        updated_at: now,
        deleted_at: now,
      },
    ]);
    await db.team_players.put({
      id: "p1",
      team_id: "t1",
      name: "Ali",
      phone: "9000000002",
      notes: null,
      created_at: now,
      updated_at: now,
    });
    const rows = await loadTeamExportRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["Player phone"]).toBe("9000000002");
  });
});
