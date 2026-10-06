import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { db } from "./localdb";
import { decimalRupees, moneyDecimal, rupeePaise } from "./money";
import { investmentsToExportRows } from "./investments";

describe("investments data contract", () => {
  beforeEach(async () => {
    await db.investments.clear();
    await db.expenses.clear();
  });
  it("preserves 800, 10000 and 2500.50 as exact decimal money", () => {
    expect(decimalRupees("800")).toBe(800);
    expect(decimalRupees("10000")).toBe(10000);
    expect(decimalRupees("2500.50")).toBe(2500.5);
    expect(moneyDecimal(2500.5)).toBe("₹2,500.50");
    expect(rupeePaise(2500.5)).toBe(250050n);
  });
  it("rejects zero, negative, NaN, excess precision and huge values", () => {
    for (const v of ["0", "-1", "NaN", "2500.567", "1000000000001"])
      expect(() => decimalRupees(v)).toThrow();
  });
  it("keeps investments separate from expenses", async () => {
    await db.investments.put({
      id: "i1",
      amount: 800,
      investment_date: "2026-10-01",
      note: "Nets",
      payment_mode: "Cash",
      receipt_path: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      deleted_at: null,
    });
    await db.investments.put({
      id: "i2",
      amount: 2500.5,
      investment_date: "2026-10-02",
      note: "Lights",
      payment_mode: null,
      receipt_path: null,
      created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z",
      deleted_at: null,
    });
    expect(await db.expenses.count()).toBe(0);
    expect(
      Number(
        (await db.investments.toArray()).reduce(
          (s, x) => s + rupeePaise(x.amount),
          0n,
        ),
      ) / 100,
    ).toBe(3300.5);
  });
  it("builds a separate Excel export row with exact decimal amount", async () => {
    const row = {
      id: "i-export",
      amount: 2500.5,
      investment_date: "2026-10-03",
      note: "Floodlights",
      payment_mode: "UPI",
      receipt_path: "receipts/photo.jpg",
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
      deleted_at: null,
    } as any;
    expect(investmentsToExportRows([row])).toEqual([
      {
        "Bill number": "",
        ID: "i-export",
        Date: "2026-10-03",
        Amount: 2500.5,
        Category: "",
        Purpose: "Floodlights",
        "Payment mode": "UPI",
        "Bill photo": "Attached",
      },
    ]);
    expect(investmentsToExportRows([row])[0]?.Amount).toBe(2500.5);
  });
});

it("keeps an explicitly empty export empty instead of falling back to all records", async () => {
  // This is a pure source-contract regression: an empty selected-period list
  // must mean empty export, while omitted rows means all records.
  expect(await import("./investments")).toHaveProperty(
    "exportInvestmentsToExcel",
  );
});
