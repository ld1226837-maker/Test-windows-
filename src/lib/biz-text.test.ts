import { describe, expect, it } from "vitest";
import { billText, type Bill } from "./biz";

const base: Bill = {
  id: "b1",
  invoice_no: "INV-1",
  customer_name: "Ravi",
  customer_phone: null,
  items: [{ item: "Chips", qty: 10, unit: "kg", rate: 100, total: 1000 }],
  subtotal: 1000,
  discount: 0,
  total: 1000,
  amount_paid: 0,
  status: "unpaid",
  bill_date: "2026-09-01",
};

describe("billText()", () => {
  it("prints taxable amount and each frozen tax line when tax was charged (audit O1)", () => {
    const text = billText({
      ...base,
      tax_amount: 180,
      tax_lines: [
        { label: "CGST 9%", value: 90 },
        { label: "SGST 9%", value: 90 },
      ],
    });
    const lines = text.split("\n");
    expect(lines).toContain("Taxable amount: ₹1,000");
    expect(lines).toContain("CGST 9%: ₹90");
    expect(lines).toContain("SGST 9%: ₹90");
    expect(lines).toContain("Payable: ₹1,180");
    // tax rows sit between Subtotal and Payable
    expect(lines.indexOf("CGST 9%: ₹90")).toBeGreaterThan(
      lines.indexOf("Subtotal: ₹1,000"),
    );
    expect(lines.indexOf("CGST 9%: ₹90")).toBeLessThan(
      lines.indexOf("Payable: ₹1,180"),
    );
  });

  it("omits tax rows when the bill carries no tax", () => {
    const text = billText({ ...base, tax_amount: 0, tax_lines: [] });
    expect(text).not.toMatch(/Taxable amount/);
    expect(text).toContain("Payable: ₹1,000");
  });

  it("adds payable-after-advances, remaining, full-split mode and the note when given", () => {
    const text = billText(
      {
        ...base,
        tax_amount: 0,
        tax_lines: [],
        amount_paid: 1000,
        status: "paid",
      },
      {
        payable: { label: "Payable after advances", value: "₹500" },
        afterPaid: [
          { label: "Remaining to be paid", value: "₹0" },
          { label: "Mode", value: "UPI ₹500 + Cash ₹500" },
        ],
        note: "Received ₹500 via UPI; ₹500 via Cash. Remaining ₹0 - settled in full.",
      },
    );
    const lines = text.split("\n");
    expect(lines).toContain("Payable after advances: ₹500");
    expect(lines).toContain("Mode: UPI ₹500 + Cash ₹500");
    expect(lines.filter((l) => l.startsWith("Remaining to be paid"))).toEqual([
      "Remaining to be paid: ₹0",
    ]);
    expect(lines.indexOf("Paid: ₹1,000")).toBeLessThan(
      lines.indexOf("Mode: UPI ₹500 + Cash ₹500"),
    );
    expect(lines[lines.length - 1]).toMatch(/^Note: Received/);
  });

  it("puts Advance collected just above Paid when given", () => {
    const lines = billText(
      {
        ...base,
        tax_amount: 0,
        tax_lines: [],
        amount_paid: 1000,
        status: "paid",
      },
      { advance: "₹500 (UPI ₹300 + Cash ₹200)", afterPaid: [] },
    ).split("\n");
    const i = lines.indexOf("Advance collected: ₹500 (UPI ₹300 + Cash ₹200)");
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe("Paid: ₹1,000");
  });
});
