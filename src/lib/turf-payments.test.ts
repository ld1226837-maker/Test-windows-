import { describe, expect, it } from "vitest";

import type { PaymentRow } from "./localdb";
import type { TurfBooking } from "./ops";
import {
  bookingPaymentBreakdown,
  groupBookingPayments,
  splitLabelFor,
  turfBookingExportColumns,
  turfBookingKind,
  turfPaymentsSheetRows,
} from "./turf-payments";

function booking(over: Partial<TurfBooking> = {}): TurfBooking {
  return {
    id: "k1",
    booking_no: "B-1",
    booking_date: "2026-09-01",
    customer_name: "Ravi",
    phone: "9876543210",
    slot_name: "Evening",
    hours: 1,
    rate_per_hour: 1000,
    total_amount: 1000,
    advance_paid: 0,
    payment_mode: "Cash",
    status: "Confirmed",
    discount: 0,
    notes: null,
    start_time: "18:00",
    end_time: "19:00",
    courts: 1,
    snacks: [],
    snacks_total: 0,
    turf_amount: 1000,
    merged_into_bill_id: null,
    ...over,
  };
}

let seq = 0;
function pay(
  amount: number,
  mode: string,
  createdAt: string,
  receivedAt = createdAt.slice(0, 10),
): PaymentRow {
  seq += 1;
  return {
    id: `p${seq}`,
    parent_type: "turf_booking",
    parent_id: "k1",
    amount,
    mode,
    received_at: receivedAt,
    created_at: createdAt,
  };
}

describe("turfBookingKind", () => {
  it("is Turf only without snacks, Merged into bill once merged", () => {
    expect(turfBookingKind(booking())).toBe("Turf only");
    expect(turfBookingKind(booking({ snacks_total: 50 }))).toBe(
      "Turf + snacks",
    );
    expect(turfBookingKind(booking({ merged_into_bill_id: "b1" }))).toBe(
      "Merged into bill",
    );
  });
});

describe("splitLabelFor", () => {
  it("labels single and mixed modes", () => {
    expect(splitLabelFor([])).toBe("Unpaid");
    expect(splitLabelFor([{ amount: 5, mode: "Cash" }])).toBe("Cash only");
    expect(splitLabelFor([{ amount: 5, mode: "UPI" }])).toBe("UPI only");
    expect(splitLabelFor([{ amount: 5, mode: "Card" }])).toBe("Card only");
    expect(
      splitLabelFor([
        { amount: 5, mode: "Cash" },
        { amount: 5, mode: "UPI" },
      ]),
    ).toBe("Split (Cash + Online)");
  });
});

describe("bookingPaymentBreakdown", () => {
  it("advance only: nothing remaining", () => {
    const b = booking({ advance_paid: 400 });
    const bp = bookingPaymentBreakdown(b, [
      pay(400, "Cash", "2026-09-01T10:00:00.000Z"),
    ]);
    expect(bp.advance).toBe(400);
    expect(bp.remaining).toBe(0);
    expect(bp.due).toBe(600);
    expect(bp.status).toBe("Not paid");
    expect(bp.note).toBe("");
  });

  it("advance + later remaining in Cash and UPI", () => {
    const b = booking({ advance_paid: 1000 });
    const rows = [
      pay(400, "Cash", "2026-09-01T10:00:00.000Z"),
      pay(300, "Cash", "2026-09-03T10:00:00.000Z", "2026-09-03"),
      pay(300, "UPI", "2026-09-03T10:00:00.001Z", "2026-09-03"),
    ];
    const bp = bookingPaymentBreakdown(b, rows);
    expect(bp.advance).toBe(400);
    expect(bp.remaining).toBe(600);
    expect(bp.remainingCash).toBe(300);
    expect(bp.remainingOnline).toBe(300);
    expect(bp.totalCash).toBe(700);
    expect(bp.totalOnline).toBe(300);
    expect(bp.status).toBe("Remaining paid");
    expect(bp.splitLabel).toBe("Split (Cash + Online)");
    expect(bp.splitUsed).toBe(true);
    expect(bp.splitDetail).toContain("Cash");
    expect(bp.splitDetail).toContain("UPI");
    // The two same-collection rows are flagged as split, the advance is not.
    expect(bp.lines.map((l) => l.split)).toEqual([false, true, true]);
    expect(bp.lines.map((l) => l.stage)).toEqual([
      "Advance",
      "Remaining",
      "Remaining",
    ]);
    expect(bp.remainingLastDate).toBe("2026-09-03");
  });

  it("part-paid remaining keeps the rest as due", () => {
    const b = booking({ advance_paid: 700 });
    const bp = bookingPaymentBreakdown(b, [
      pay(400, "Cash", "2026-09-01T10:00:00.000Z"),
      pay(300, "UPI", "2026-09-02T10:00:00.000Z", "2026-09-02"),
    ]);
    expect(bp.remaining).toBe(300);
    expect(bp.due).toBe(300);
    expect(bp.status).toBe("Part paid");
    expect(bp.note).toContain("Still due");
  });

  it("legacy booking with no rows gets one implied advance", () => {
    const b = booking({ advance_paid: 500, payment_mode: "UPI" });
    const bp = bookingPaymentBreakdown(b, []);
    expect(bp.advance).toBe(500);
    expect(bp.remaining).toBe(0);
    expect(bp.totalOnline).toBe(500);
    expect(bp.splitLabel).toBe("UPI only");
  });

  it("nothing collected: Unpaid and no lines", () => {
    const bp = bookingPaymentBreakdown(booking(), []);
    expect(bp.lines).toEqual([]);
    expect(bp.splitLabel).toBe("Unpaid");
    expect(bp.status).toBe("n/a");
  });

  it("merged booking reports zeros", () => {
    const b = booking({ advance_paid: 500, merged_into_bill_id: "bill1" });
    const bp = bookingPaymentBreakdown(b, [
      pay(500, "Cash", "2026-09-01T10:00:00.000Z"),
    ]);
    expect(bp.advance).toBe(0);
    expect(bp.totalCash).toBe(0);
    expect(bp.kind).toBe("Merged into bill");
  });
});

describe("export helpers", () => {
  it("turfBookingExportColumns keeps cash + online equal to collected", () => {
    const b = booking({ advance_paid: 1000 });
    const cols = turfBookingExportColumns(b, [
      pay(400, "Cash", "2026-09-01T10:00:00.000Z"),
      pay(600, "UPI", "2026-09-03T10:00:00.000Z", "2026-09-03"),
    ]);
    expect(cols["Booking type"]).toBe("Turf only");
    expect(cols["Advance (first payment)"]).toBe(400);
    expect(cols["Remaining collected"]).toBe(600);
    expect(cols["Remaining collected - Online"]).toBe(600);
    expect(cols["Remaining status"]).toBe("Remaining paid");
    expect(cols["Payment split"]).toBe("Split (Cash + Online)");
    expect(cols["Split pay used"]).toBe("Yes");
    expect(
      Number(cols["Total collected - Cash"]) +
        Number(cols["Total collected - Online"]),
    ).toBe(1000);
  });

  it("Turf payments sheet adds up to the bookings sheet totals", () => {
    const b = booking({ advance_paid: 1000 });
    const rows = [
      pay(400, "Cash", "2026-09-01T10:00:00.000Z"),
      pay(300, "Cash", "2026-09-03T10:00:00.000Z", "2026-09-03"),
      pay(300, "UPI", "2026-09-03T10:00:00.001Z", "2026-09-03"),
    ];
    const byBooking = groupBookingPayments(rows);
    const sheet = turfPaymentsSheetRows([b], byBooking);
    const cols = turfBookingExportColumns(b, rows);
    const sheetTotal = sheet.reduce((s, r) => s + Number(r.Amount), 0);
    expect(sheetTotal).toBe(
      Number(cols["Total collected - Cash"]) +
        Number(cols["Total collected - Online"]),
    );
    expect(sheet.map((r) => r["Payment stage"])).toEqual([
      "Advance",
      "Remaining",
      "Remaining",
    ]);
    expect(sheet.map((r) => r["Split pay"])).toEqual(["No", "Yes", "Yes"]);
  });
});

describe("cancelled / no-show bookings match analytics", () => {
  it("a cancelled booking that kept its advance still reports it as collected", () => {
    const b = booking({
      status: "Cancelled",
      advance_paid: 300,
      is_refundable: false,
    });
    const rows = [pay(300, "UPI", "2026-09-01T10:00:00.000Z")];
    const cols = turfBookingExportColumns(b, rows);
    // analytics counts bookingForfeitedRevenue (300) as collected, so the
    // Excel columns must show the same rupees, not 0.
    expect(cols["Total collected - Online"]).toBe(300);
    expect(cols["Total collected - Cash"]).toBe(0);
    expect(cols["Advance (first payment)"]).toBe(300);
    expect(cols["Remaining status"]).toBe("n/a");
  });

  it("a cancelled booking already refunded reports nothing collected", () => {
    const b = booking({
      status: "Cancelled",
      advance_paid: 300,
      is_refundable: true,
      refunded_at: "2026-09-02",
    });
    const rows = [pay(300, "Cash", "2026-09-01T10:00:00.000Z")];
    const cols = turfBookingExportColumns(b, rows);
    expect(cols["Total collected - Cash"]).toBe(0);
    expect(cols["Advance (first payment)"]).toBe(0);
  });

  it("a booking merged into a bill still reports zeros", () => {
    const b = booking({ advance_paid: 300, merged_into_bill_id: "bill1" });
    const rows = [pay(300, "Cash", "2026-09-01T10:00:00.000Z")];
    const cols = turfBookingExportColumns(b, rows);
    expect(cols["Total collected - Cash"]).toBe(0);
    expect(cols["Payment split"]).toBe("n/a");
  });
});

describe("full payment in one collection", () => {
  it("a booking paid in full by one collection is a Full payment, not an Advance", () => {
    const b = booking({ advance_paid: 1000, status: "Completed" });
    const rows = [pay(1000, "UPI", "2026-09-03T10:00:00.000Z", "2026-09-03")];
    const sheet = turfPaymentsSheetRows([b], groupBookingPayments(rows));
    expect(sheet.map((r) => r["Payment stage"])).toEqual(["Full payment"]);
    const bp = bookingPaymentBreakdown(b, rows);
    // amounts are unchanged: still the first (and only) collection
    expect(bp.advance).toBe(1000);
    expect(bp.remaining).toBe(0);
  });

  it("an advance followed by a later remaining keeps Advance / Remaining", () => {
    const b = booking({ advance_paid: 1000, status: "Completed" });
    const rows = [
      pay(400, "Cash", "2026-09-01T10:00:00.000Z"),
      pay(600, "UPI", "2026-09-03T10:00:00.000Z", "2026-09-03"),
    ];
    const sheet = turfPaymentsSheetRows([b], groupBookingPayments(rows));
    expect(sheet.map((r) => r["Payment stage"])).toEqual(["Advance", "Remaining"]);
  });
});

