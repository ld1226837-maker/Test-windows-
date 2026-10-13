import { describe, expect, it } from "vitest";
import {
  PAYABLE_LABEL,
  pdfSafeText,
  REMAINING_LABEL,
  joinNotes,
  remainingSummary,
  splitReceiptTotals,
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
      "Advance Rs 654 via Cash Rs 644 + UPI Rs 10 on 2026-10-09; Balance Rs 2,240 via UPI on 2026-10-10. Remaining Rs 0 - settled in full.",
    );
  });

  it("shows a settlement the payment rows missed, and the full split mode", () => {
    const v = remainingSummary({
      grandTotal: 1400,
      advances: 500,
      paid: 1400,
      fmt,
      payments: [row("UPI", 500, "2026-10-11T09:00:00.000Z")],
      fallbackMode: "Cash",
      fallbackDate: "2026-10-11",
      fmtDate: (d) => d.slice(0, 10),
    });
    expect(v.note).toBe(
      "Advance Rs 500 via UPI on 2026-10-11; Balance Rs 900 via Cash. Remaining Rs 0 - settled in full.",
    );
    expect(v.modeLabel).toBe("UPI Rs 500 + Cash Rs 900");
  });

  it("no split label when only one mode was used", () => {
    const v = remainingSummary({
      grandTotal: 500,
      advances: 0,
      paid: 500,
      fmt,
      payments: [row("UPI", 500, "2026-10-11T09:00:00.000Z")],
    });
    expect(v.modeLabel).toBeNull();
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

describe("pdfSafeText", () => {
  it("replaces the rupee sign so PDF rows never overflow", () => {
    expect(pdfSafeText("Cash \u20b9500 + UPI \u20b91,110")).toBe(
      "Cash Rs 500 + UPI Rs 1,110",
    );
    expect(pdfSafeText("Rs 5")).toBe("Rs 5");
  });
});

describe("missing settlement and mode names", () => {
  const fmt = (n: number) => `Rs ${n}`;
  const fmtDate = (iso: string) =>
    `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  const upi500 = [
    { amount: 500, mode: "UPI", created_at: "2026-10-11T10:00:00.000Z" },
  ];

  it("shows the unrecorded Cash settlement next to the UPI advance", () => {
    const v = remainingSummary({
      grandTotal: 1400,
      advances: 500,
      paid: 1400,
      fmt,
      fmtDate,
      payments: upi500,
      fallbackMode: "Cash",
      fallbackDate: "2026-10-11",
    });
    expect(v.note).toBe(
      "Advance Rs 500 via UPI on 11-10-2026; Balance Rs 900 via Cash. Remaining Rs 0 - settled in full.",
    );
    expect(v.modeLabel).toBe("UPI Rs 500 + Cash Rs 900");
  });

  it("treats a Pending / unknown record mode as Cash, never prints it", () => {
    const v = remainingSummary({
      grandTotal: 1400,
      advances: 500,
      paid: 1400,
      fmt,
      fmtDate,
      payments: upi500,
      fallbackMode: "Pending",
      fallbackDate: "2026-10-11",
    });
    expect(v.note).toContain("Rs 900 via Cash");
    expect(v.note).not.toMatch(/Pending/);
    expect(v.modeLabel).toBe("UPI Rs 500 + Cash Rs 900");
  });

  it("merges differently spelled modes into one", () => {
    const v = remainingSummary({
      grandTotal: 1400,
      advances: 500,
      paid: 1400,
      fmt,
      fmtDate,
      payments: [
        { amount: 500, mode: "Cash", created_at: "2026-10-11T10:00:00.000Z" },
      ],
      fallbackMode: "cash",
      fallbackDate: "2026-10-11",
    });
    expect(v.modeLabel).toBeNull();
    expect(v.note).not.toMatch(/cash/);
  });

  it("adds nothing for a bill moved to the customer's tab", () => {
    const v = remainingSummary({
      grandTotal: 1400,
      advances: 500,
      paid: 500,
      fmt,
      fmtDate,
      onTab: true,
      payments: upi500,
      fallbackMode: "On tab",
    });
    expect(v.note).toBe(
      "Rs 900 moved to the customer's tab. Remaining Rs 900.",
    );
    expect(v.modeLabel).toBeNull();
  });
});

describe("splitReceiptTotals()", () => {
  it("returns the payable row and the rows between Paid and Status", () => {
    const r = splitReceiptTotals([
      { label: "GRAND TOTAL", value: "Rs 1400" },
      { label: "Payable after advances", value: "Rs 900" },
      { label: "Paid", value: "Rs 1400" },
      { label: "Remaining to be paid", value: "Rs 0" },
      { label: "Mode", value: "UPI Rs 500 + Cash Rs 900" },
      { label: "Status", value: "PAID" },
    ]);
    expect(r.payable?.value).toBe("Rs 900");
    expect(r.afterPaid.map((x) => x.label)).toEqual([
      "Remaining to be paid",
      "Mode",
    ]);
  });
});
