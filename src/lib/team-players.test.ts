import { describe, expect, it } from "vitest";
import { initialsOf, parsePlayerLines, teamNameExists } from "./team-players";

describe("parsePlayerLines", () => {
  it("accepts name + phone, name only, and tab/semicolon separators", () => {
    const r = parsePlayerLines(
      "Ravi, 9876543210\nSuresh\nKumar\t+91 98765 43211\nArun; 09876543212\n\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.players).toEqual([
      { name: "Ravi", phone: "9876543210" },
      { name: "Suresh", phone: null },
      { name: "Kumar", phone: "9876543211" },
      { name: "Arun", phone: "9876543212" },
    ]);
  });
  it("reports bad phones and missing names per line, keeps the good ones", () => {
    const r = parsePlayerLines("Ravi, 12345\n, 9876543210\nMani, 9876543210");
    expect(r.players).toEqual([{ name: "Mani", phone: "9876543210" }]);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2]);
    expect(r.errors[1]!.message).toMatch(/name/i);
  });
  it("flags a phone repeated inside the same paste", () => {
    const r = parsePlayerLines("A, 9876543210\nB, 9876543210");
    expect(r.players).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(2);
  });
});

describe("teamNameExists / initialsOf", () => {
  const teams = [{ id: "1", name: "Chennai Lions" }];
  it("matches case-insensitively and can exclude the team being renamed", () => {
    expect(teamNameExists(teams, "  chennai lions ")).toBe(true);
    expect(teamNameExists(teams, "Chennai Lions", "1")).toBe(false);
    expect(teamNameExists(teams, "")).toBe(false);
  });
  it("builds initials", () => {
    expect(initialsOf("Ravi Kumar")).toBe("RK");
    expect(initialsOf("ravi")).toBe("R");
    expect(initialsOf("  ")).toBe("?");
  });
});
