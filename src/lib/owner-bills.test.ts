import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildOwnerBillText,
  buildRecentBillRows,
  lastThreeDays,
} from "./owner-bills";

const NOW = new Date("2026-10-12T06:00:00.000Z"); // 11:30 IST on 12-10-2026

const booking = (o: Record<string, unknown>) =>
  ({
    id: "b",
    booking_no: "TURF-1",
    booking_date: "2026-10-12",
    customer_name: "Fhb",
    phone: "9087654321",
    slot_name: "Weekday",
    hours: 2,
    rate_per_hour: 1200,
    total_amount: 1878,
    advance_paid: 1878,
    payment_mode: "Cash",
    status: "Completed",
    discount: 522,
    notes: null,
    start_time: "4 PM",
    end_time: "6 PM",
    courts: 1,
    court_ids: null,
    snacks: [],
    snacks_total: 0,
    turf_amount: 2400,
    ...o,
  }) as never;

const sale = (o: Record<string, unknown>) =>
  ({
    id: "s",
    bill_no: "S-1",
    sale_date: "2026-10-12",
    customer_name: "Ravi",
    items: [
      { item_name: "Tea", qty: 2, unit_price: 10, cost_price: 5, amount: 20 },
    ],
    total: 20,
    profit: 10,
    payment_mode: "Cash",
    notes: null,
    ...o,
  }) as never;

const bill = (o: Record<string, unknown>) =>
  ({
    id: "i",
    invoice_no: "INV-1",
    customer_name: "Kumar",
    customer_phone: null,
    items: [],
    subtotal: 4200,
    discount: 0,
    total: 4200,
    amount_paid: 4200,
    status: "paid",
    payment_mode: "UPI",
    bill_date: "2026-10-12",
    ...o,
  }) as never;

describe("lastThreeDays", () => {
  it("is today, yesterday and the day before (IST day keys)", () => {
    expect(lastThreeDays(NOW)).toEqual([
      "2026-10-12",
      "2026-10-11",
      "2026-10-10",
    ]);
  });
  it("crosses a month boundary", () => {
    expect(lastThreeDays(new Date("2026-11-01T06:00:00.000Z"))).toEqual([
      "2026-11-01",
      "2026-10-31",
      "2026-10-30",
    ]);
  });
});

describe("buildRecentBillRows", () => {
  const src = {
    bookings: [
      booking({
        id: "b1",
        booking_no: "T-1",
        booking_date: "2026-10-12",
        total_amount: 1878,
        turf_amount: 2400,
      }),
      booking({ id: "b2", booking_no: "T-2", booking_date: "2026-10-09" }),
      booking({
        id: "b3",
        booking_no: "T-3",
        booking_date: "2026-10-11",
        status: "Cancelled",
      }),
      booking({
        id: "b4",
        booking_no: "T-4",
        booking_date: "2026-10-11",
        merged_into_bill_id: "x",
      }),
    ],
    sales: [
      sale({ id: "s1", bill_no: "S-1", sale_date: "2026-10-11", total: 250 }),
      sale({
        id: "s2",
        bill_no: "S-2",
        sale_date: "2026-10-12",
        cancelled: true,
      }),
    ],
    bills: [
      bill({
        id: "i1",
        invoice_no: "I-1",
        bill_date: "2026-10-10",
        total: 4200,
        subtotal: 4200,
      }),
      bill({
        id: "i2",
        invoice_no: "I-2",
        bill_date: "2026-10-12",
        status: "cancelled",
      }),
    ],
  };
  const ids = (r: { id: string }[]) => r.map((x) => x.id);

  it("keeps only the last three days and drops cancelled / merged / voided", () => {
    const rows = buildRecentBillRows(src, {
      day: "all",
      sort: "newest",
      now: NOW,
    });
    expect(ids(rows)).toEqual(["b1", "s1", "i1"]);
  });
  it("day chips pick one day", () => {
    expect(
      ids(buildRecentBillRows(src, { day: "0", sort: "newest", now: NOW })),
    ).toEqual(["b1"]);
    expect(
      ids(buildRecentBillRows(src, { day: "1", sort: "newest", now: NOW })),
    ).toEqual(["s1"]);
    expect(
      ids(buildRecentBillRows(src, { day: "2", sort: "newest", now: NOW })),
    ).toEqual(["i1"]);
  });
  it("sorts newest, oldest, amount high and amount low", () => {
    const run = (sort: "newest" | "oldest" | "high" | "low") =>
      ids(buildRecentBillRows(src, { day: "all", sort, now: NOW }));
    expect(run("newest")).toEqual(["b1", "s1", "i1"]);
    expect(run("oldest")).toEqual(["i1", "s1", "b1"]);
    expect(run("high")).toEqual(["i1", "b1", "s1"]);
    expect(run("low")).toEqual(["s1", "b1", "i1"]);
  });
  it("mixes the three sources", () => {
    const kinds = buildRecentBillRows(src, {
      day: "all",
      sort: "newest",
      now: NOW,
    }).map((r) => r.kind);
    expect(kinds).toEqual(["turf", "snack", "invoice"]);
  });
});

describe("buildOwnerBillText", () => {
  const row = (t: string, o: Record<string, unknown>) =>
    (t === "p" ? o : o) as never;
  const pay = (
    id: string,
    parent_id: string,
    amount: number,
    mode: string,
    at: string,
    type = "turf_booking",
  ) =>
    ({
      id,
      parent_type: type,
      parent_id,
      amount,
      mode,
      received_at: at,
      created_at: at,
    }) as never;

  it("turf + snacks, fully paid: both cash-flow summaries", () => {
    const b = booking({ id: "b1" });
    const s = sale({
      id: "s1",
      booking_id: "b1",
      total: 250,
      payment_mode: "UPI",
    });
    const payments = [
      pay("p1", "b1", 422, "Cash", "2026-10-12T08:00:00.000Z"),
      pay("p2", "b1", 122, "UPI", "2026-10-12T08:00:00.001Z"),
      pay("p3", "b1", 344, "Cash", "2026-10-12T12:00:00.000Z"),
      pay("p4", "b1", 990, "UPI", "2026-10-12T12:00:00.001Z"),
    ];
    const text = buildOwnerBillText(row("x", { kind: "turf", id: "b1" }), {
      bookings: [b],
      sales: [s],
      bills: [],
      payments,
      tabEntries: [],
    });
    expect(text.split("\n")[0]).toBe("12-10-2026 | 4 PM-6 PM | 2 hr");
    expect(text).toContain("Fhb | 9087654321");
    expect(text).toContain("Turf: Rs 1,878");
    expect(text).toContain("Advance: Rs 544 (Cash 422 + UPI 122)");
    expect(text).toContain("Remaining: Rs 1,334 (Cash 344 + UPI 990)");
    expect(text).toContain("Snacks: Rs 250 (UPI)");
    expect(text).toContain("Turf Rs 1,878 + Snacks Rs 250 = Rs 2,128");
    expect(text).toContain("With advance: Rs 2,128 | Cash 766 | UPI 1,362");
    expect(text).toContain("Without advance: Rs 1,584 | Cash 344 | UPI 1,240");
    expect(text).not.toContain("Pending");
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
  });

  it("turf only with a pending balance", () => {
    const b = booking({
      id: "b2",
      total_amount: 3100,
      turf_amount: 3600,
      discount: 500,
      advance_paid: 500,
      hours: 3,
      start_time: "12 PM",
      end_time: "3 PM",
    });
    const payments = [
      pay("p1", "b2", 300, "Cash", "2026-10-12T08:00:00.000Z"),
      pay("p2", "b2", 200, "UPI", "2026-10-12T08:00:00.001Z"),
    ];
    const text = buildOwnerBillText(row("x", { kind: "turf", id: "b2" }), {
      bookings: [b],
      sales: [],
      bills: [],
      payments,
      tabEntries: [],
    });
    expect(text).toContain("Advance: Rs 500 (Cash 300 + UPI 200)");
    expect(text).toContain("Remaining: Rs 2,600 (pending)");
    expect(text).toContain("With advance: Rs 500 | Cash 300 | UPI 200");
    expect(text).toContain("Without advance: Rs 0");
    expect(text).toContain("Pending: Rs 2,600");
    expect(text).not.toContain("Snacks");
  });

  it("snack bill and invoice texts", () => {
    const s = sale({ id: "s1", total: 20, payment_mode: "UPI" });
    const i = bill({ id: "i1" });
    const ctx = {
      bookings: [],
      sales: [s],
      bills: [i],
      payments: [],
      tabEntries: [],
    };
    const st = buildOwnerBillText(row("x", { kind: "snack", id: "s1" }), ctx);
    expect(st).toContain("Tea x 2 = Rs 20");
    expect(st).toContain("Total: Rs 20 (UPI)");
    const it = buildOwnerBillText(row("x", { kind: "invoice", id: "i1" }), ctx);
    expect(it).toContain("12-10-2026 | INV-1 | Kumar");
    expect(it).toContain("Paid: Rs 4,200 (UPI)");
    expect(it).not.toContain("Due");
  });

  it("returns an empty string when the bill is gone", () => {
    expect(
      buildOwnerBillText(row("x", { kind: "turf", id: "nope" }), {
        bookings: [],
        sales: [],
        bills: [],
        payments: [],
        tabEntries: [],
      }),
    ).toBe("");
  });
});

describe("performance", () => {
  it("builds the 3-day list from 15,000 bills in well under 50 ms", () => {
    const day = (i: number) => {
      const d = new Date(Date.UTC(2026, 9, 12) - (i % 365) * 86400000);
      return d.toISOString().slice(0, 10);
    };
    const bookings = Array.from({ length: 5000 }, (_, i) =>
      booking({ id: `b${i}`, booking_date: day(i) }),
    );
    const sales = Array.from({ length: 5000 }, (_, i) =>
      sale({ id: `s${i}`, sale_date: day(i) }),
    );
    const bills = Array.from({ length: 5000 }, (_, i) =>
      bill({ id: `i${i}`, bill_date: day(i) }),
    );
    buildRecentBillRows(
      { bookings, sales, bills },
      { day: "all", sort: "high", now: NOW },
    );
    const t0 = performance.now();
    const rows = buildRecentBillRows(
      { bookings, sales, bills },
      { day: "all", sort: "high", now: NOW },
    );
    const ms = performance.now() - t0;
    expect(rows.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });

  it("the card builds the list only while the dropdown is open", () => {
    const src = readFileSync(
      join(__dirname, "..", "components", "app", "WhatsAppSummaryCard.tsx"),
      "utf8",
    );
    expect(src).toMatch(/return open \? <OpenBillList/);
    const first = src.indexOf("buildRecentBillRows(");
    expect(first).toBeGreaterThan(src.indexOf("function OpenBillList"));
    expect(src.split("buildRecentBillRows(").length - 1).toBe(1);
    // the owner number must not be a dependency of the sort/list memo
    expect(src).not.toMatch(/useMemo\([\s\S]{0,200}whatsappOwner/);
  });
});
