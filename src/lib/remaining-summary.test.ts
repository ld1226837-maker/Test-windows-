import { describe, expect, it } from "vitest";
import {
  PAYABLE_LABEL,
  REMAINING_LABEL,
  joinNotes,
  remainingSummary,
} from "./remaining-summary";

const fmt = (n: number) => `Rs ${n.toLocaleString("en-IN")}`;
const row = (mode: string, amount: number, at: string) => ({
  mode,
  amount,
  created_at: at,
  received_at: at.slice(0, 10),
});

describe("remainingSummary (display only)", () => {
  it("worked example: 2,894 total, 644 + 10 advances, settled by UPI", () => {
    const v = remainingSummary({
      grandTotal: 2894,
      advances: 654,
      paid: 2894,
      fmt,
      payments: [
        row("Cash", 644, "2026-10-09T10:00:00.000Z"),
        row("UPI", 10, "2026-10-09T10:00:00.200Z"),
        row("UPI", 2240, "2026-10-10T12:00:00.000Z"),
      ],
      fmtDate: (d) => d.slice(0, 10),
    });
    expect(v.payable).toBe(2240);
    expect(v.remaining).toBe(0);
    expect(v.payableRow).toEqual({ label: PAYABLE_LABEL, value: "Rs 2,240" });
    expect(v.remainingRows[0]).toMatchObject({
      label: REMAINING_LABEL,
      value: "Rs 0",
    });
    expect(v.note).toBe(
      "Received Rs 2,240 via UPI on 2026-10-10. Remaining Rs 0 - settled in full.",
    );
  });

  it("advance only: remaining is grand total minus advance", () => {
    const v = remainingSummary({
      grandTotal: 2894,
      advances: 654,
      paid: 654,
      fmt,
      payments: [row("UPI", 654, "2026-10-09T10:00:00.000Z")],
      fmtDate: (d) => d.slice(0, 10),
    });
    expect(v.remaining).toBe(2240);
    expect(v.note).toBe(
      "Advance received Rs 654 via UPI on 2026-10-09. Remaining Rs 2,240.",
    );
  });

  it("never negative when over-paid, and advance is capped at the total", () => {
    const v = remainingSummary({
      grandTotal: 1200,
      advances: 1500,
      paid: 1500,
      fmt,
    });
    expect(v.remaining).toBe(0);
    expect(v.payable).toBe(0);
  });

  it("no advance: no 'Payable after advances' row, remaining is still shown", () => {
    const v = remainingSummary({ grandTotal: 500, advances: 0, paid: 0, fmt });
    expect(v.payableRow).toBeNull();
    expect(v.remainingRows[0]?.value).toBe("Rs 500");
    expect(v.note).toBe("No payment received yet. Remaining Rs 500.");
  });

  it("legacy record with no payment rows falls back to the record's mode", () => {
    const v = remainingSummary({
      grandTotal: 1000,
      advances: 400,
      paid: 400,
      fmt,
      fallbackMode: "Cash",
      fallbackDate: "2026-10-01",
      fmtDate: (d) => d,
    });
    expect(v.note).toBe(
      "Advance received Rs 400 via Cash on 2026-10-01. Remaining Rs 600.",
    );
  });

  it("on-tab balance and cancelled records", () => {
    expect(
      remainingSummary({
        grandTotal: 45,
        advances: 0,
        paid: 0,
        fmt,
        onTab: true,
      }).note,
    ).toContain("moved to the customer's tab");
    const c = remainingSummary({
      grandTotal: 45,
      advances: 0,
      paid: 0,
      fmt,
      cancelled: true,
    });
    expect(c.remainingRows).toEqual([]);
    expect(c.note).toBeNull();
  });

  it("joinNotes keeps the user's note and appends the payment note", () => {
    expect(joinNotes("Bring bibs", "Remaining Rs 0.")).toBe(
      "Bring bibs\nRemaining Rs 0.",
    );
    expect(joinNotes(null, "x")).toBe("x");
    expect(joinNotes(null, "")).toBeNull();
  });
});
