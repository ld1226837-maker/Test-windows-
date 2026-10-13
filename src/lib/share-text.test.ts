import { describe, expect, it } from "vitest";

import type { ReceiptDoc } from "./receipt";
import {
  buildShareText,
  isLongForWhatsApp,
  type ShareOptions,
} from "./share-text";

const rs = (n: number) =>
  `${n < 0 ? "-" : ""}Rs ${Math.abs(n).toLocaleString("en-IN")}`;
const opts = (style: "whatsapp" | "plain", over: Partial<ShareOptions> = {}) =>
  ({
    style,
    shopName: "Chennai Soccer & Sports School",
    showPhone: true,
    footerLine: "Thank you!",
    formatAmount: rs,
    ...over,
  }) satisfies ShareOptions;

const bookingDoc = (over: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  kind: "Bill",
  docNo: "TURF-20261011-0003",
  dateText: "11-10-2026",
  customer: "Ravi",
  phone: "9812345610",
  lines: [
    { label: "Turf 1 hr", sub: "1 hr x Rs 1,400", qty: "1 hr", amount: 1400 },
    { label: "Advance paid", amount: -500 },
  ],
  totals: [
    { label: "Turf", value: "Rs 1,400" },
    { label: "GRAND TOTAL", value: "Rs 1,400", strong: true },
    { label: "Payable after advances", value: "Rs 900" },
    { label: "Paid", value: "Rs 1,400" },
    { label: "Remaining to be paid", value: "Rs 0" },
    { label: "Mode", value: "UPI Rs 500 + Cash Rs 900" },
    { label: "Status", value: "Completed" },
  ],
  note: "Received Rs 500 via UPI on 11-10-2026; Rs 900 via Cash. Remaining Rs 0 - settled in full.",
  textAdvance: "Rs 500 via UPI",
  fileName: "x",
  ...over,
});

describe("buildShareText()", () => {
  it("WhatsApp booking: golden output", () => {
    expect(buildShareText(bookingDoc(), opts("whatsapp"))).toBe(
      [
        "*Chennai Soccer & Sports School*",
        "Bill TURF-20261011-0003 | 11-10-2026",
        "Customer: Ravi",
        "Phone: 9812345610",
        "",
        "*Items*",
        "1. Turf 1 hr - 1 hr x Rs 1,400 = Rs 1,400",
        "",
        "*Amount*",
        "Turf: Rs 1,400",
        "*Grand total: Rs 1,400*",
        "",
        "*Payment*",
        "Payable after advances: Rs 900",
        "Advance collected: Rs 500 via UPI",
        "Paid: Rs 1,400",
        "*Remaining to be paid: Rs 0*",
        "Mode: UPI Rs 500 + Cash Rs 900",
        "Status: Completed",
        "",
        "Received Rs 500 via UPI on 11-10-2026; Rs 900 via Cash. Remaining Rs 0 - settled in full.",
        "",
        "Thank you!",
      ].join("\n"),
    );
  });

  it("plain (Copy) carries the same lines with no markup", () => {
    const wa = buildShareText(bookingDoc(), opts("whatsapp"));
    const plain = buildShareText(bookingDoc(), opts("plain"));
    expect(plain).not.toContain("*");
    expect(wa.replace(/\*/g, "")).toBe(plain);
  });

  it("merged bill: split Mode shows amounts, snacks paid sits in Payment", () => {
    const doc = bookingDoc({
      lines: [
        { label: "Turf 1 hr", amount: 1400 },
        { label: "Snacks - Tea", sub: "x Rs 10", qty: 2, amount: 20 },
        { label: "Advance paid", amount: -500 },
        { label: "Snacks paid", amount: -20 },
      ],
      totals: [
        { label: "GRAND TOTAL", value: "Rs 1,420", strong: true },
        { label: "Payable after advances", value: "Rs 900" },
        { label: "Paid", value: "Rs 1,420" },
        { label: "Remaining to be paid", value: "Rs 0" },
        { label: "Mode", value: "Split (Cash + UPI)" },
      ],
      textMode: "Cash Rs 900 + UPI Rs 520",
      textAdvance: "Rs 500 (Cash Rs 300 + UPI Rs 200)",
    });
    const t = buildShareText(doc, opts("plain"));
    expect(t).toContain("2. Snacks - Tea - 2 x Rs 10 = Rs 20");
    expect(t).toContain("Mode: Cash Rs 900 + UPI Rs 520");
    expect(t).not.toContain("Split (");
    expect(t).toContain("Advance collected: Rs 500 (Cash Rs 300 + UPI Rs 200)");
    expect(t).toContain("Snacks paid: Rs 20");
    expect(t).not.toMatch(/-Rs 20|-Rs 500/);
  });

  it("no advance: no Advance collected line; cancelled: no Remaining row", () => {
    const t = buildShareText(
      bookingDoc({
        textAdvance: undefined,
        note: null,
        totals: [
          { label: "GRAND TOTAL", value: "Rs 1,400", strong: true },
          { label: "Status", value: "Cancelled" },
        ],
      }),
      opts("plain"),
    );
    expect(t).not.toMatch(/Advance collected|Remaining/);
  });

  it("payment receipt (no grand total) uses a Payment section", () => {
    const t = buildShareText(
      bookingDoc({
        kind: "Payment",
        lines: [{ label: "TURF-1", amount: 900 }],
        totals: [
          { label: "Amount received", value: "Rs 900", strong: true },
          { label: "Mode", value: "Cash" },
          { label: "Balance remaining", value: "Rs 0" },
        ],
        textAdvance: undefined,
      }),
      opts("plain"),
    );
    expect(t).toContain("Payment\nAmount received: Rs 900\nMode: Cash");
  });

  it("neutralises WhatsApp markup in names, items and notes", () => {
    const t = buildShareText(
      bookingDoc({
        customer: "Ravi_Kumar*",
        lines: [{ label: "*Big* ~deal~ `x`", amount: 10 }],
        note: "> _hi_ & #1 100% a+b",
      }),
      opts("whatsapp"),
    );
    expect(t).toContain("Customer: Ravi Kumar");
    expect(t).toContain("1. Big -deal- 'x' = Rs 10");
    expect(t).toContain("hi & #1 100% a+b");
    expect(t).not.toMatch(/_|~|`/);
  });

  it("keeps Tamil names and survives a wa.me encode / decode round trip", () => {
    const t = buildShareText(
      bookingDoc({ customer: "முருகன் & Sons #1 100% a+b" }),
      opts("whatsapp"),
    );
    expect(t).toContain("Customer: முருகன் & Sons #1 100% a+b");
    expect(decodeURIComponent(encodeURIComponent(t))).toBe(t);
  });

  it("emits only safe characters and clean spacing", () => {
    const t = buildShareText(
      bookingDoc({
        customer: "A\tB  C",
        note: "paid ₹500 — thanks · ok × 2\r\n\r\n\r\nbye",
        lines: [{ label: "Item\u00a0one", amount: 10 }],
      }),
      opts("whatsapp"),
    );
    expect(t).not.toMatch(/[₹\t\r\u00a0·×—]/);
    expect(t).not.toMatch(/\n\n\n/);
    expect(t).not.toMatch(/^ | $/m);
    expect(t).not.toMatch(/undefined|null|NaN/);
    expect(t.endsWith("\n")).toBe(false);
  });

  it("expense / investment vouchers keep heading, fields and amount", () => {
    const doc: ReceiptDoc = {
      kind: "Expense",
      title: "Expense voucher",
      docNo: "EXP-1",
      dateText: "11-10-2026",
      lines: [],
      details: [
        { label: "Voucher no", value: "EXP-1" },
        { label: "Paid to", value: "Ravi_Stores" },
      ],
      totals: [{ label: "Amount", value: "Rs 250", strong: true }],
      note: null,
      fileName: "x",
    };
    expect(buildShareText(doc, opts("whatsapp"))).toBe(
      [
        "*Chennai Soccer & Sports School*",
        "*EXPENSE VOUCHER*",
        "Voucher no: EXP-1",
        "Paid to: Ravi Stores",
        "*Amount: Rs 250*",
      ].join("\n"),
    );
  });

  it("flags very long messages for WhatsApp", () => {
    expect(isLongForWhatsApp("x".repeat(100))).toBe(false);
    expect(isLongForWhatsApp("முருகன்".repeat(400))).toBe(true);
  });
});
