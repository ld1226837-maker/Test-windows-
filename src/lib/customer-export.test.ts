import { describe, expect, it } from "vitest";
import {
  customerNameContactsToCsv,
  customersToCsv,
  customersWithTeamsToCsv,
} from "./customer-export";

describe("customer export", () => {
  it("escapes CSV values safely", () => {
    const csv = customersToCsv([
      {
        ID: "1",
        Name: 'Arun, "A"',
        Phone: "9361115939",
        Visits: 4,
        Due: 1250,
        "On tab": 250,
      },
    ]);

    expect(csv).toContain('"Arun, ""A"""');
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});

it("exports name and contact only", () => {
  const csv = customerNameContactsToCsv([
    { Name: "தமிழ் Snacks", "Contact No": "9361115939" },
    { Name: 'Arun, "A"', "Contact No": "9876543210" },
  ]);

  expect(csv).toBe(
    'Name,Contact No\r\nதமிழ் Snacks,9361115939\r\n"Arun, ""A""",9876543210',
  );
  expect(csv).not.toContain("Visits");
  expect(csv).not.toContain("Due");
  expect(csv).not.toContain("ID");
});

describe("customer teams export", () => {
  it("normalizes Teams and Players into separate export rows", async () => {
    const { customerTeamsToExportRows, customerPlayersToExportRows } =
      await import("./customer-export");
    expect(
      customerTeamsToExportRows([
        { id: "t1", customer_id: "c1", name: "Champions", notes: null },
      ]),
    ).toEqual([
      { ID: "t1", "Customer ID": "c1", Name: "Champions", Notes: "" },
    ]);
    expect(
      customerPlayersToExportRows([
        {
          id: "p1",
          team_id: "t1",
          name: "José",
          phone: "9876543210",
          notes: null,
        },
      ]),
    ).toEqual([
      {
        ID: "p1",
        "Team ID": "t1",
        Name: "José",
        Phone: "9876543210",
        Notes: "",
      },
    ]);
  });
});

describe("customer teams CSV export", () => {
  it("includes Teams and Players sections with unicode and phone text", () => {
    const csv = customersWithTeamsToCsv(
      [
        {
          ID: "c1",
          Name: "தமிழ் FC",
          Phone: "9876543210",
          Visits: 1,
          Due: 0,
          "On tab": 0,
        },
      ],
      [{ ID: "t1", "Customer ID": "c1", Name: "Chennai ⭐", Notes: "" }],
      [
        {
          ID: "p1",
          "Team ID": "t1",
          Name: "ரவி",
          Phone: "9840012345",
          Notes: "",
        },
      ],
    );
    expect(csv).toContain("\r\nTeams\r\nID,Customer ID,Name,Notes");
    expect(csv).toContain("t1,c1,Chennai ⭐");
    expect(csv).toContain("\r\nPlayers\r\nID,Team ID,Name,Phone,Notes");
    expect(csv).toContain("p1,t1,ரவி,9840012345");
  });
});

it("filtered XLSX customer exports scope Teams and Players to selected customers", async () => {
  const source = await import("./customer-export");
  const text = source.exportCustomers.toString();
  expect(text).toContain("scopedCustomerIds");
  expect(text).toContain("scopedCustomerIds.has(team.customer_id)");
  expect(text).toContain("teamIds.has(player.team_id)");
});
