import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./localdb";
import { mergeCustomersAtomic, useDeleteCustomer } from "./data";

describe("customer teams merge/delete", () => {
  beforeEach(async () => {
    await db.customers.clear();
    await db.teams.clear();
    await db.team_players.clear();
    await db.bills.clear();
    await db.turf_bookings.clear();
    await db.snack_sales.clear();
    await db.customer_tabs.clear();
    await db.tab_entries.clear();
  });
  it("moves teams and dedupes players on merge", async () => {
    const a: any = { id: "a", name: "Keep", phone: "9876543210" },
      b: any = { id: "b", name: "Absorb", phone: "9876543211" };
    await db.customers.bulkAdd([
      { ...a, created_at: "x" },
      { ...b, created_at: "x" },
    ]);
    await db.teams.bulkAdd([
      {
        id: "ta",
        customer_id: "a",
        name: "Team",
        notes: null,
        created_at: "x",
        updated_at: "x",
      },
      {
        id: "tb",
        customer_id: "b",
        name: "Team",
        notes: null,
        created_at: "x",
        updated_at: "x",
      },
    ] as any);
    await db.team_players.bulkAdd([
      {
        id: "pa",
        team_id: "ta",
        name: "A",
        phone: "9876543210",
        notes: null,
        created_at: "x",
        updated_at: "x",
      },
      {
        id: "pb",
        team_id: "tb",
        name: "B",
        phone: "9876543210",
        notes: null,
        created_at: "x",
        updated_at: "x",
      },
    ] as any);
    await mergeCustomersAtomic({
      keep: a,
      absorb: [b],
      finalName: "Keep",
      finalPhone: "9876543210",
    });
    expect(await db.customers.get("b")).toBeUndefined();
    expect((await db.teams.toArray()).length).toBe(1);
    expect((await db.team_players.toArray()).length).toBe(1);
  });
});
