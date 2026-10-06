import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  backfillInvestmentBillNumbers,
  db,
  nextInvestmentBillNo,
} from "./localdb";
import { sortInvestments } from "./investments";

describe("investment billing upgrade", () => {
  beforeEach(async () => {
    await db.investments.clear();
    await db.counters.clear();
  });
  it("issues a stable daily INVES bill sequence", async () => {
    const a = await nextInvestmentBillNo("2026-10-04");
    const b = await nextInvestmentBillNo("2026-10-04");
    expect(a).toMatch(/^INVES-\d{8}-001$/);
    expect(b).toMatch(/^INVES-\d{8}-002$/);
  });
  it("backfills legacy rows deterministically and never overwrites existing numbers", async () => {
    await db.investments.bulkPut([
      {
        id: "b",
        amount: 2,
        investment_date: "2026-10-01",
        note: null,
        payment_mode: null,
        receipt_path: null,
        created_at: "2026-10-01T02:00:00Z",
        updated_at: "2026-10-01T02:00:00Z",
      },
      {
        id: "a",
        amount: 1,
        investment_date: "2026-10-01",
        note: null,
        payment_mode: null,
        receipt_path: null,
        created_at: "2026-10-01T01:00:00Z",
        updated_at: "2026-10-01T01:00:00Z",
      },
      {
        id: "c",
        amount: 3,
        investment_date: "2026-10-01",
        note: null,
        payment_mode: null,
        receipt_path: null,
        bill_no: "INVES-20261001-007",
        created_at: "2026-10-01T03:00:00Z",
        updated_at: "2026-10-01T03:00:00Z",
      },
    ] as any);
    await backfillInvestmentBillNumbers();
    expect((await db.investments.get("a"))?.bill_no).toBe("INVES-20261001-001");
    expect((await db.investments.get("b"))?.bill_no).toBe("INVES-20261001-002");
    expect((await db.investments.get("c"))?.bill_no).toBe("INVES-20261001-007");
  });
  it("sorts by every supported investment field", () => {
    const rows = [
      {
        id: "1",
        amount: 20,
        investment_date: "2026-10-02",
        category: "Z",
        payment_mode: "Cash",
        bill_no: "INVES-20261002-002",
      },
      {
        id: "2",
        amount: 10,
        investment_date: "2026-10-01",
        category: "A",
        payment_mode: "UPI",
        bill_no: "INVES-20261001-001",
      },
    ] as any;
    expect(sortInvestments(rows, "amount", "asc")[0]?.id).toBe("2");
    expect(sortInvestments(rows, "category", "asc")[0]?.id).toBe("2");
    expect(sortInvestments(rows, "payment_mode", "asc")[0]?.id).toBe("1");
    expect(sortInvestments(rows, "bill_no", "asc")[0]?.id).toBe("2");
  });
});
