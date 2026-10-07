import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { normalizePlayerPhone } from "./teams";

describe("team player phone normalization", () => {
  it("normalizes common Indian formats", () => {
    expect(normalizePlayerPhone("98400 12345")).toBe("9840012345");
    expect(normalizePlayerPhone("+91-98400-12345")).toBe("9840012345");
    expect(normalizePlayerPhone("098400 12345")).toBe("9840012345");
  });
  it("rejects short, alphabetic, and non-mobile 10-digit values", () => {
    expect(() => normalizePlayerPhone("12345")).toThrow();
    expect(() => normalizePlayerPhone("abcdefgh")).toThrow();
    expect(() => normalizePlayerPhone("5123456789")).toThrow();
  });
  it("accepts Devanagari digits and canonicalizes them", () => {
    expect(normalizePlayerPhone("९८४००१२३४५")).toBe("9840012345");
  });
  it("keeps empty phone optional", () => {
    expect(normalizePlayerPhone(" ")).toBeNull();
  });
});

it("uses indexed team-phone duplicate detection", async () => {
  const { db } = await import("./localdb");
  const { hasDuplicateTeamPhone } = await import("./teams");
  await db.teams.put({
    id: "scale-team",
    customer_id: "scale-customer",
    name: "Scale",
    notes: null,
    created_at: "x",
    updated_at: "x",
    deleted_at: null,
  } as any);
  await db.team_players.put({
    id: "scale-player",
    team_id: "scale-team",
    name: "Player",
    phone: "9840012345",
    notes: null,
    created_at: "x",
    updated_at: "x",
  } as any);
  expect(await hasDuplicateTeamPhone("scale-team", "9840012345")).toBe(true);
  expect(
    await hasDuplicateTeamPhone("scale-team", "9840012345", "scale-player"),
  ).toBe(false);
  await db.team_players.delete("scale-player");
  await db.teams.delete("scale-team");
});
