import { describe, expect, it } from "vitest";
import {
  buildPaymentModeLookup,
  modeColumnsFromEntries,
} from "./payment-columns";
import type { PaymentRow } from "./localdb";

let n = 0;
const pay = (
  parent_type: PaymentRow["parent_type"],
  parent_id: string,
  amount: number,
  mode: string,
): PaymentRow => ({
  id: `p${n++}`,
  parent_type,
  parent_id,
  amount,
  mode,
  received_at: "2026-10-01",
  created_at: `2026-10-01T10:00:00.${String(n).padStart(3, "0")}Z`,
});

describe("modeColumnsFromEntries", () => {
  it("cash only", () => {
    const c = modeColumnsFromEntries([{ amount: 500, mode: "Cash" }]);
    expect(c["Paid - Cash"]).toBe(500);
    expect(c["Paid - Online"]).toBe(0);
    expect(c["Payment type"]).toBe("Cash");
    expect(c["Split detail"]).toBe("Cash");
  });

  it("online only (UPI)", () => {
    const c = modeColumnsFromEntries([{ amount: 500, mode: "UPI" }]);
    expect(c["Paid - Cash"]).toBe(0);
    expect(c["Paid - Online"]).toBe(500);
    expect(c["Payment type"]).toBe("Online");
    expect(c["Split detail"]).toBe("UPI");
  });

  it("split cash + online keeps both amounts", () => {
    const c = modeColumnsFromEntries([
      { amount: 400, mode: "Cash" },
      { amount: 300, mode: "UPI" },
    ]);
    expect(c["Paid - Cash"]).toBe(400);
    expect(c["Paid - Online"]).toBe(300);
    expect(c["Payment type"]).toBe("Split (Cash + Online)");
    expect(c["Split detail"]).toContain("Cash");
    expect(c["Split detail"]).toContain("UPI");
  });

  it("nothing paid", () => {
    const c = modeColumnsFromEntries([]);
    expect(c["Payment type"]).toBe("Not paid");
    expect(c["Paid - Cash"] + c["Paid - Online"]).toBe(0);
  });
});

describe("buildPaymentModeLookup", () => {
  it("uses real rows per record and never mixes records", () => {
    const rows = [
      pay("bill", "b1", 600, "Cash"),
      pay("bill", "b1", 400, "UPI"),
      pay("bill", "b2", 250, "UPI"),
    ];
    const look = buildPaymentModeLookup(
      "bill",
      [
        { id: "b1", collected: 1000, mode: "Cash", date: "2026-10-01" },
        { id: "b2", collected: 250, mode: "UPI", date: "2026-10-01" },
        { id: "b3", collected: 0, mode: null, date: "2026-10-01" },
      ],
      rows,
    );
    expect(look("b1")["Paid - Cash"]).toBe(600);
    expect(look("b1")["Paid - Online"]).toBe(400);
    expect(look("b1")["Payment type"]).toBe("Split (Cash + Online)");
    expect(look("b2")["Payment type"]).toBe("Online");
    expect(look("b3")["Payment type"]).toBe("Not paid");
  });

  it("an older record with no payment rows falls back to its own mode", () => {
    const look = buildPaymentModeLookup(
      "snack_sale",
      [{ id: "s1", collected: 120, mode: "UPI", date: "2026-10-01" }],
      [],
    );
    expect(look("s1")["Paid - Online"]).toBe(120);
    expect(look("s1")["Payment type"]).toBe("Online");
  });

  it("rows that don't add up to the collected figure are reconciled like analytics", () => {
    const look = buildPaymentModeLookup(
      "turf_booking",
      [{ id: "k1", collected: 1000, mode: "Cash", date: "2026-10-01" }],
      [pay("turf_booking", "k1", 300, "UPI")],
    );
    const c = look("k1");
    expect(c["Paid - Cash"] + c["Paid - Online"]).toBe(1000);
    expect(c["Paid - Online"]).toBe(300);
  });
});
