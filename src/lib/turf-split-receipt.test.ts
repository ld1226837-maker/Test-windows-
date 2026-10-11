import { afterEach, describe, expect, it } from "vitest";

import { advanceOfRows, setReceiptPayments } from "./payments";
import { bookingReceipt, receiptText } from "./receipt";
import { mergedBillBreakdown } from "./merge-breakdown";
import { turfAdvanceBalance } from "./merge";
import type { TurfBooking } from "./ops";

const row = (amount: number, mode: string, at: string, parent = "b1") => ({
  id: `${parent}-${mode}-${at}`,
  parent_type: "turf_booking" as const,
  parent_id: parent,
  amount,
  mode,
  received_at: at,
  created_at: at,
});

const ADV = ["2026-10-11T08:00:00.000Z", "2026-10-11T08:00:00.001Z"] as const;
const BAL = ["2026-10-11T12:00:00.000Z", "2026-10-11T12:00:00.001Z"] as const;

const booking = (over: Partial<TurfBooking> = {}): TurfBooking => ({
  id: "b1",
  booking_no: "TURF-20261011-0003",
  booking_date: "2026-10-11",
  customer_name: "Amir Parpia",
  phone: "6369170362",
  slot_name: "Weekends",
  hours: 3,
  rate_per_hour: 1400,
  total_amount: 4000,
  advance_paid: 4000,
  payment_mode: "UPI",
  status: "Completed",
  discount: 200,
  notes: "Team 12",
  start_time: "12 PM",
  end_time: "3 PM",
  courts: 1,
  court_ids: null,
  snacks: [],
  snacks_total: 0,
  turf_amount: 4200,
  ...over,
});

const t = (doc: ReturnType<typeof bookingReceipt>, label: string) =>
  doc.totals.find((x) => x.label === label)?.value;

const advanceRows = () => [row(300, "Cash", ADV[0]), row(200, "UPI", ADV[1])];
const balanceRows = () => [row(450, "Cash", BAL[0]), row(3050, "UPI", BAL[1])];

afterEach(() => setReceiptPayments([]));

describe("turf booking: advance split vs balance split (TURF-20261011-0003)", () => {
  it("Arrived (advance only) prints the advance and Rs 3,500 still to pay", () => {
    setReceiptPayments(advanceRows());
    const doc = bookingReceipt(
      booking({ advance_paid: 500, status: "Arrived" }),
    );
    expect(t(doc, "Payable after advances")).toBe("Rs 3,500");
    expect(t(doc, "Balance paid")).toBeUndefined();
    expect(t(doc, "Paid")).toBe("Rs 500");
    expect(t(doc, "Remaining to be paid")).toBe("Rs 3,500");
    expect(t(doc, "Mode")).toBe("Cash Rs 300 + UPI Rs 200");
    expect(doc.note).toContain(
      "Advance received Rs 500 via Cash Rs 300 + UPI Rs 200",
    );
    expect(doc.note).toContain("Remaining Rs 3,500.");
  });

  it("Completed prints advance and balance separately, and the combined mode", () => {
    setReceiptPayments([...advanceRows(), ...balanceRows()]);
    const doc = bookingReceipt(booking());
    const adv = doc.lines.find((l) => l.label === "Advance paid");
    expect(adv?.amount).toBe(-500);
    expect(adv?.sub).toBe("Cash Rs 300 + UPI Rs 200");
    expect(t(doc, "Payable after advances")).toBe("Rs 3,500");
    expect(t(doc, "Balance paid")).toBe("Rs 3,500");
    expect(t(doc, "Paid")).toBe("Rs 4,000");
    expect(t(doc, "Remaining to be paid")).toBe("Rs 0");
    // Advance and balance each have their own mode line, never added together.
    expect(t(doc, "Mode")).toBeUndefined();
    expect(t(doc, "Advance mode")).toBe("Cash Rs 300 + UPI Rs 200");
    expect(t(doc, "Balance mode")).toBe("Cash Rs 450 + UPI Rs 3,050");
    const bal = doc.lines.find((l) => l.label === "Balance paid");
    expect(bal?.amount).toBe(-3500);
    expect(bal?.sub).toBe("Cash Rs 450 + UPI Rs 3,050");
    expect(doc.note).toContain(
      "Advance Rs 500 via Cash Rs 300 + UPI Rs 200 on 11-10-2026; Balance Rs 3,500 via Cash Rs 450 + UPI Rs 3,050 on 11-10-2026. Remaining Rs 0 - settled in full.",
    );
    // Balance paid sits between "Payable after advances" and "Paid".
    const labels = doc.totals.map((x) => x.label);
    expect(labels.indexOf("Balance paid")).toBe(
      labels.indexOf("Payable after advances") + 1,
    );
    expect(labels.indexOf("Paid")).toBe(labels.indexOf("Balance paid") + 1);
  });

  it("the WhatsApp / copy text matches the bill: only Paid and the Note after the total", () => {
    setReceiptPayments([...advanceRows(), ...balanceRows()]);
    const text = receiptText(bookingReceipt(booking()));
    expect(text).toContain("Paid: Rs 4,000");
    expect(text).toContain("Advance Rs 500 via Cash Rs 300 + UPI Rs 200");
    for (const gone of [
      "Advance collected",
      "Balance paid",
      "Advance mode",
      "Balance mode",
      "Payable after advances",
      "Remaining to be paid",
    ])
      expect(text).not.toContain(gone);
  });

  it("a booking paid in one go prints no Advance / Balance lines", () => {
    setReceiptPayments([row(4000, "UPI", BAL[0])]);
    const doc = bookingReceipt(booking({ payment_mode: "UPI" }));
    expect(doc.lines.some((l) => l.label === "Advance paid")).toBe(true); // legacy: paid is shown as before
    expect(t(doc, "Balance paid")).toBeUndefined();
    expect(t(doc, "Remaining to be paid")).toBe("Rs 0");
  });

  it("advanceOfRows is the first collection only", () => {
    expect(advanceOfRows([...advanceRows(), ...balanceRows()], 4000)).toBe(500);
    expect(advanceOfRows([], 123)).toBe(123);
  });
});

describe("merged bill: advance vs balance of the turf booking", () => {
  const bookings = [
    { id: "b1", collected: 4000, mode: "Cash", date: "2026-10-11" },
  ];

  it("splits the turf money into advance and balance with their modes", () => {
    const st = turfAdvanceBalance(bookings, [
      ...advanceRows(),
      ...balanceRows(),
    ] as never);
    expect(st?.first).toBe(500);
    expect(st?.balance).toBe(3500);
    expect(st?.firstModes).toEqual([
      { mode: "Cash", amount: 300 },
      { mode: "UPI", amount: 200 },
    ]);
    expect(st?.balanceModes).toEqual([
      { mode: "Cash", amount: 450 },
      { mode: "UPI", amount: 3050 },
    ]);
  });

  it("returns null without payment rows (legacy prints as before)", () => {
    expect(turfAdvanceBalance(bookings, [])).toBeNull();
  });

  it("view: advance and balance never exceed what was paid and sum to it", () => {
    const v = mergedBillBreakdown({
      breakdown: {
        v: 1,
        turf_items: 1,
        turf_advance: 4000,
        turf_first: 500,
        snacks: [],
      },
      paid: 4000,
      grandTotal: 4000,
      itemCount: 1,
    });
    expect(v?.advancePaid).toBe(500);
    expect(v?.turfBalancePaid).toBe(3500);
    expect((v?.advancePaid ?? 0) + (v?.turfBalancePaid ?? 0)).toBe(4000);
  });

  it("view: an older merged bill (no turf_first) is unchanged", () => {
    const v = mergedBillBreakdown({
      breakdown: { v: 1, turf_items: 1, turf_advance: 500, snacks: [] },
      paid: 500,
      grandTotal: 4000,
      itemCount: 1,
    });
    expect(v?.advancePaid).toBe(500);
    expect(v?.turfBalancePaid).toBe(0);
    expect(v?.balanceDue).toBe(3500);
  });
});
