import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHAIN_DAYS,
  buildDailyTable,
  buildDailyTableText,
  cashFlowIntegrityOk,
  countsText,
  headlineFigures,
  makeCashFlow,
  resolveOldCash,
  stepAmountText,
  warnIfCashFlowBroken,
  type DailyTableDay,
} from "./daily-table";

const DAY = "2026-11-04";
const YESTERDAY = "2026-11-03";

const booking = (o: Record<string, unknown>) =>
  ({
    id: "b",
    booking_no: "T-1",
    booking_date: DAY,
    customer_name: "Ravi",
    phone: null,
    slot_name: "Evening",
    hours: 1,
    rate_per_hour: 1200,
    total_amount: 0,
    advance_paid: 0,
    payment_mode: "Cash",
    status: "Completed",
    discount: 0,
    notes: null,
    start_time: "5:30 PM",
    end_time: "6:30 PM",
    courts: 1,
    court_ids: null,
    snacks: [],
    snacks_total: 0,
    turf_amount: 1200,
    ...o,
  }) as never;

let n = 0;
const pay = (parent_id: string, amount: number, mode: string, at: string) =>
  ({
    id: `p${++n}`,
    parent_type: "turf_booking",
    parent_id,
    amount,
    mode,
    received_at: at,
    created_at: `${at}T10:00:00.000Z`,
  }) as never;

const expense = (o: Record<string, unknown>) =>
  ({
    id: `e${++n}`,
    expense_no: null,
    business: "Turf",
    category: "Other",
    description: null,
    note: null,
    amount: 100,
    spent_at: DAY,
    receipt_path: null,
    payment_mode: "Cash",
    cash_part: null,
    ...o,
  }) as never;

const sale = (o: Record<string, unknown>) =>
  ({
    id: `s${++n}`,
    bill_no: "S-1",
    sale_date: DAY,
    customer_name: "Walk-in",
    items: [],
    total: 100,
    profit: 10,
    payment_mode: "Cash",
    notes: null,
    ...o,
  }) as never;

const empty = (o: Partial<DailyTableDay> = {}): DailyTableDay => ({
  date: DAY,
  bookings: [],
  sales: [],
  bills: [],
  payments: [],
  expenses: [],
  tabEntries: [],
  ...o,
});

/** A booking paid in full in cash on `date`. */
const cashDay = (date: string, amount: number, id = `c-${date}`) => ({
  bookings: [
    booking({
      id,
      booking_date: date,
      turf_amount: amount,
      advance_paid: amount,
    }),
  ],
  payments: [pay(id, amount, "Cash", date)],
});

/** Merges several partial days into one source. */
const merge = (...parts: Partial<DailyTableDay>[]): DailyTableDay =>
  parts.reduce<DailyTableDay>(
    (a, p) => ({
      ...a,
      ...p,
      bookings: [...a.bookings, ...(p.bookings ?? [])],
      payments: [...a.payments, ...(p.payments ?? [])],
      sales: [...a.sales, ...(p.sales ?? [])],
      expenses: [...a.expenses, ...(p.expenses ?? [])],
    }),
    empty(),
  );

const stepOf = (t: ReturnType<typeof buildDailyTable>, key: string) =>
  t.cash.steps.find((s) => s.key === key);

afterEach(() => vi.restoreAllMocks());

describe("cash flow - worked example", () => {
  // Old cash 1000. Expenses: 300 cash, 200 UPI, 100 split 40 cash + 60 online.
  // Collected cash 2500.
  const t = buildDailyTable(
    merge(cashDay(DAY, 2500), {
      oldCashOverride: 1000,
      expenses: [
        expense({ amount: 300 }),
        expense({ amount: 200, payment_mode: "UPI" }),
        expense({ amount: 100, payment_mode: "UPI", cash_part: 40 }),
      ],
    }),
  );

  it("cash expenses 340, online 260 (information only), after 660, final 3160", () => {
    expect(t.cash).toMatchObject({
      oldCash: 1000,
      cashExpenses: 340,
      onlineExpenses: 260,
      cashAfterExpenses: 660,
      collectedCash: 2500,
      finalTotal: 3160,
    });
  });

  it("the steps come in the exact order with signed amounts and signs", () => {
    const steps = t.cash.steps.filter((s) => s.key !== "carriedForward");
    expect(steps.map((s) => s.key)).toEqual([
      "oldCash",
      "cashExpenses",
      "cashAfterExpenses",
      "collectedCash",
      "finalTotal",
    ]);
    expect(steps.map((s) => s.kind)).toEqual([
      "open",
      "less",
      "subtotal",
      "plus",
      "close",
    ]);
    expect(steps.map((s) => s.amount)).toEqual([1000, -340, 660, 2500, 3160]);
    expect(steps.map((s) => s.sign)).toEqual(["", "-", "", "+", ""]);
    expect(steps.map(stepAmountText)).toEqual([
      "1000",
      "-340",
      "660",
      "+2500",
      "3160",
    ]);
  });

  it("the running amounts add up: open + less + plus = close", () => {
    const s = (k: string) => stepOf(t, k)!.amount;
    expect(s("oldCash") + s("cashExpenses") + s("collectedCash")).toBe(
      s("finalTotal"),
    );
  });

  it("the text fallback lists the same lines in the same order", () => {
    const text = buildDailyTableText(t);
    const at = (x: string) => text.indexOf(x);
    const order = [
      "Old cash: Rs 1000",
      "- That day cash expenses: Rs 340",
      "= Cash after expenses (stored): Rs 660",
      "+ Collected cash: Rs 2500",
      "= FINAL TOTAL: Rs 3160",
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Online expenses (not deducted): Rs 260");
    expect(text).toContain("Cash expenses (deducted): Rs 340");
    expect(text).toContain(
      "Old cash - cash expenses = cash after expenses; + collected cash = final total.",
    );
  });
});

describe("cash flow - integrity guard", () => {
  it("finalTotal === oldCash - cashExpenses + collectedCash in every case", () => {
    const cases: DailyTableDay[] = [
      empty(),
      merge(cashDay(DAY, 777), { oldCashOverride: 50 }),
      merge(cashDay(DAY, 100), {
        oldCashOverride: 10,
        expenses: [expense({ amount: 9999 })],
      }),
      merge(cashDay(YESTERDAY, 800), cashDay(DAY, 300), {
        expenses: [
          expense({ amount: 120 }),
          expense({ amount: 80, spent_at: YESTERDAY }),
        ],
      }),
    ];
    for (const c of cases) {
      const { cash } = buildDailyTable(c);
      expect(cash.finalTotal).toBe(
        cash.oldCash - cash.cashExpenses + cash.collectedCash,
      );
      expect(cashFlowIntegrityOk(cash)).toBe(true);
    }
  });

  it("warns (dev only) when the rule is broken and stays quiet otherwise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = makeCashFlow({
      date: DAY,
      oldCash: 1000,
      cashExpenses: 340,
      collectedCash: 2500,
    });
    expect(warnIfCashFlowBroken(good)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(
      warnIfCashFlowBroken({ ...good, finalTotal: good.finalTotal + 1 }),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("cash flow - edge cases", () => {
  it("no expenses: nothing is subtracted", () => {
    const t = buildDailyTable(
      merge(cashDay(DAY, 500), { oldCashOverride: 200 }),
    );
    expect(t.cash).toMatchObject({
      cashExpenses: 0,
      onlineExpenses: 0,
      cashAfterExpenses: 200,
      finalTotal: 700,
    });
    expect(stepAmountText(stepOf(t, "cashExpenses")!)).toBe("0");
  });

  it("only online expenses: shown, never subtracted", () => {
    const t = buildDailyTable(
      merge(cashDay(DAY, 500), {
        oldCashOverride: 200,
        expenses: [
          expense({ amount: 400, payment_mode: "UPI" }),
          expense({ amount: 50, payment_mode: "Card", cash_part: 0 }),
        ],
      }),
    );
    expect(t.cash.cashExpenses).toBe(0);
    expect(t.cash.onlineExpenses).toBe(450);
    expect(t.cash.cashAfterExpenses).toBe(200);
    expect(t.cash.finalTotal).toBe(700);
    expect(t.expenseList.map((e) => e.tag)).toEqual(["ONLINE", "ONLINE"]);
  });

  it("cash expenses larger than old cash: negative balance, minus sign, final follows", () => {
    const t = buildDailyTable(
      merge(cashDay(DAY, 100), {
        oldCashOverride: 50,
        expenses: [expense({ amount: 300 })],
      }),
    );
    expect(t.cash.cashAfterExpenses).toBe(-250);
    expect(t.cash.finalTotal).toBe(-150);
    const st = stepOf(t, "cashAfterExpenses")!;
    expect(stepAmountText(st)).toBe("-250");
    expect(buildDailyTableText(t)).toContain(
      "= Cash after expenses (stored): Rs -250",
    );
  });

  it("an empty old cash falls back to the default; junk is 0", () => {
    const t = buildDailyTable(
      merge(cashDay(DAY, 500), { oldCashOverride: null }),
    );
    expect(t.cash.oldCash).toBe(0);
    expect(t.cash.oldCashIsDefault).toBe(true);
    expect(t.cash.finalTotal).toBe(500);
  });

  it("no bookings or sales: only the old cash and expenses move", () => {
    const t = buildDailyTable(
      empty({ oldCashOverride: 900, expenses: [expense({ amount: 150 })] }),
    );
    expect(t.rows).toEqual([]);
    expect(t.cash).toMatchObject({
      collectedCash: 0,
      cashAfterExpenses: 750,
      finalTotal: 750,
    });
  });

  it("legacy expenses without a payment mode count as cash", () => {
    const t = buildDailyTable(
      empty({
        oldCashOverride: 1000,
        expenses: [
          expense({ amount: 200, payment_mode: undefined }),
          expense({ amount: 100, payment_mode: null }),
        ],
      }),
    );
    expect(t.cash.cashExpenses).toBe(300);
    expect(t.cash.onlineExpenses).toBe(0);
    expect(t.expenseList.every((e) => e.tag === "CASH")).toBe(true);
    expect(t.cash.cashAfterExpenses).toBe(700);
  });

  it("a split expense is tagged CASH+ONLINE and only its cash part is deducted", () => {
    const t = buildDailyTable(
      empty({
        oldCashOverride: 100,
        expenses: [
          expense({ amount: 100, payment_mode: "UPI", cash_part: 40 }),
        ],
      }),
    );
    expect(t.expenseList[0]).toMatchObject({
      tag: "CASH+ONLINE",
      cash: 40,
      online: 60,
    });
    expect(t.cash.cashAfterExpenses).toBe(60);
  });

  it("cancelled bookings: collected cash logic is unchanged (kept advance is never CASH)", () => {
    const t = buildDailyTable(
      merge(cashDay(DAY, 400), {
        oldCashOverride: 0,
        bookings: [
          booking({
            id: "x",
            status: "Cancelled",
            advance_paid: 300,
            start_time: "9 PM",
            end_time: "10 PM",
          }),
        ],
      }),
    );
    expect(t.cash.collectedCash).toBe(t.totals.cash);
    expect(t.cash.collectedCash).toBe(400);
  });

  it("a day with only a snack sale", () => {
    const t = buildDailyTable(
      empty({ oldCashOverride: 10, sales: [sale({ total: 250 })] }),
    );
    expect(t.counts).toEqual({ bookings: 0, snackSales: 1 });
    expect(t.cash.collectedCash).toBe(250);
    expect(t.cash.finalTotal).toBe(260);
  });

  it("very large numbers stay exact whole rupees", () => {
    const big = 9_000_000_000;
    const t = buildDailyTable(
      merge(cashDay(DAY, 123_456_789), {
        oldCashOverride: big,
        expenses: [expense({ amount: 1_000_000_000 })],
      }),
    );
    expect(t.cash.cashAfterExpenses).toBe(8_000_000_000);
    expect(t.cash.finalTotal).toBe(8_123_456_789);
    expect(stepAmountText(stepOf(t, "finalTotal")!)).toBe("8123456789");
  });

  it("a settings file from before this change (no saved cash-after-expenses) works", () => {
    const t = buildDailyTable(
      merge(cashDay(YESTERDAY, 800), cashDay(DAY, 100), {
        savedOldCash: { [YESTERDAY]: 200 },
        savedCashAfterExpenses: undefined,
      }),
    );
    expect(t.cash.oldCash).toBe(1000);
    expect(t.cash.finalTotal).toBe(1100);
  });

  it("counts and headline figures come from the same cash flow", () => {
    const t = buildDailyTable(
      merge(cashDay(DAY, 500), {
        oldCashOverride: 100,
        sales: [sale({ total: 60 }), sale({ total: 40 })],
        expenses: [expense({ amount: 30 })],
      }),
    );
    expect(countsText(t.counts)).toBe("1 booking | 2 snack sales");
    expect(headlineFigures(t).map((h) => [h.label, h.value])).toEqual([
      ["COLLECTED CASH", "600"],
      ["CASH EXPENSES", "30"],
      ["FINAL TOTAL", "670"],
    ]);
  });
});

describe("day chain - previous day's FINAL TOTAL with the new formula", () => {
  it("uses old - expenses + collected of the previous day (not the removed remainingCash)", () => {
    const t = buildDailyTable(
      merge(cashDay(YESTERDAY, 500), cashDay(DAY, 100), {
        savedOldCash: { [YESTERDAY]: 100 },
        expenses: [expense({ amount: 300, spent_at: YESTERDAY })],
      }),
    );
    // 100 - 300 + 500 = 300
    expect(t.cash.oldCash).toBe(300);
    expect(t.cash.carriedForward).toMatchObject({
      date: YESTERDAY,
      amount: 300,
      used: true,
    });
  });

  it("order: typed, then saved for that date, then previous day, then 0", () => {
    const base = merge(cashDay(YESTERDAY, 500), cashDay(DAY, 0));
    expect(
      resolveOldCash({
        ...base,
        oldCashOverride: 7,
        savedOldCash: { [DAY]: 9 },
      }).value,
    ).toBe(7);
    expect(
      resolveOldCash({ ...base, savedOldCash: { [DAY]: 9 } }),
    ).toMatchObject({
      value: 9,
      source: "saved",
    });
    expect(resolveOldCash(base)).toMatchObject({
      value: 500,
      source: "previous",
    });
    expect(resolveOldCash(empty())).toMatchObject({ value: 0, source: "none" });
  });

  it("crosses a month boundary (31-10 -> 01-11)", () => {
    const t = buildDailyTable(
      merge(cashDay("2026-10-31", 900), cashDay("2026-11-01", 100), {
        date: "2026-11-01",
      }),
    );
    expect(t.cash.carriedForward.date).toBe("2026-10-31");
    expect(t.cash.oldCash).toBe(900);
    expect(t.cash.finalTotal).toBe(1000);
  });

  it("crosses a year boundary (31-12 -> 01-01)", () => {
    const t = buildDailyTable(
      merge(cashDay("2025-12-31", 640), cashDay("2026-01-01", 10), {
        date: "2026-01-01",
      }),
    );
    expect(t.cash.carriedForward.date).toBe("2025-12-31");
    expect(t.cash.oldCash).toBe(640);
  });

  it("a closed day in between carries the cash through", () => {
    const t = buildDailyTable(
      merge(cashDay("2026-11-01", 700), cashDay(DAY, 50)),
    );
    // 2 and 3 Nov have no records; the previous BUSINESS day is 1 Nov.
    expect(t.cash.carriedForward).toMatchObject({
      date: "2026-11-01",
      amount: 700,
    });
    expect(t.cash.oldCash).toBe(700);
    expect(stepOf(t, "carriedForward")!.hint).toContain("last business day's");
  });

  it("editing a past day flows into later defaults (computed, not a stale stored copy)", () => {
    const common = merge(cashDay(YESTERDAY, 500), cashDay(DAY, 0), {
      savedOldCash: { [YESTERDAY]: 0 },
      savedCashAfterExpenses: { [YESTERDAY]: 500 },
    });
    expect(buildDailyTable(common).cash.oldCash).toBe(500);
    const edited = {
      ...common,
      expenses: [expense({ amount: 120, spent_at: YESTERDAY })],
    };
    expect(buildDailyTable(edited).cash.oldCash).toBe(380);
  });

  it("a previous day without records uses its saved cash-after-expenses, labelled", () => {
    const t = buildDailyTable(
      merge(cashDay(DAY, 100), {
        savedCashAfterExpenses: { [YESTERDAY]: 640 },
      }),
    );
    expect(t.cash.oldCash).toBe(640);
    expect(t.cash.carriedForward.fromSaved).toBe(true);
    expect(stepOf(t, "carriedForward")!.hint).toContain("from saved value");
  });

  it("yesterday negative after expenses but positive final total", () => {
    const t = buildDailyTable(
      merge(cashDay(YESTERDAY, 1000), cashDay(DAY, 0), {
        savedOldCash: { [YESTERDAY]: 100 },
        expenses: [expense({ amount: 400, spent_at: YESTERDAY })],
      }),
    );
    // yesterday: 100 - 400 = -300 after expenses, + 1000 = 700 final
    expect(t.cash.carriedForward.amount).toBe(700);
    expect(t.cash.oldCash).toBe(700);
  });

  it("a negative final total is carried as a shortfall (and shown with a minus)", () => {
    const t = buildDailyTable(
      merge(cashDay(DAY, 0), {
        expenses: [expense({ amount: 250, spent_at: YESTERDAY })],
      }),
    );
    expect(t.cash.oldCash).toBe(-250);
    expect(t.cash.finalTotal).toBe(-250);
    expect(buildDailyTableText(t)).toContain(
      "Carried forward (03-11-2026): Rs -250",
    );
  });

  it("is depth limited: history older than MAX_CHAIN_DAYS is ignored", () => {
    const old = new Date(Date.UTC(2026, 10, 4 - MAX_CHAIN_DAYS - 5))
      .toISOString()
      .slice(0, 10);
    const t = buildDailyTable(merge(cashDay(old, 5000), cashDay(DAY, 10)));
    expect(t.cash.oldCash).toBe(0);
    expect(t.cash.carriedForward.date).toBeNull();
  });

  it("a 365-day run of days still resolves quickly", () => {
    const parts: Partial<DailyTableDay>[] = [];
    for (let i = 0; i < 300; i++) {
      const d = new Date(Date.UTC(2026, 10, 4 - 1 - i))
        .toISOString()
        .slice(0, 10);
      parts.push(cashDay(d, 10));
    }
    const t0 = Date.now();
    const t = buildDailyTable(merge(...parts, cashDay(DAY, 0)));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(t.cash.oldCash).toBe(3000);
  });
});

describe("carried forward line", () => {
  const history = (extra: Partial<DailyTableDay> = {}) =>
    merge(cashDay(YESTERDAY, 3160), cashDay(DAY, 100), extra);

  it("defaulted old cash: used, no difference line, amount === oldCash", () => {
    const t = buildDailyTable(history());
    const cf = t.cash.carriedForward;
    expect(cf).toMatchObject({ date: YESTERDAY, used: true, difference: 0 });
    expect(cf.amount).toBe(t.cash.oldCash);
    const st = t.cash.steps[0]!;
    expect(st).toMatchObject({ key: "carriedForward", kind: "info", sign: "" });
    expect(st.label).toBe("CARRIED FORWARD (03-11-2026)");
    expect(st.hint).toBe("Yesterday's final total, used as old cash");
    expect(st.note).toBeUndefined();
    expect(t.cash.steps[1]!.key).toBe("oldCash");
    expect(t.cash.steps[1]!.hint).toBe("from previous day's final total");
  });

  it("typed old cash MORE than yesterday: used=false, difference in plain words", () => {
    const t = buildDailyTable(history({ oldCashOverride: 3360 }));
    expect(t.cash.carriedForward).toMatchObject({
      used: false,
      difference: 200,
    });
    expect(t.cash.steps[0]!.note).toBe(
      "Typed old cash is Rs 200 more than yesterday's final total (Rs 3160)",
    );
    expect(t.cash.steps[1]!.hint).toBe("typed by you");
  });

  it("typed old cash LESS than yesterday", () => {
    const t = buildDailyTable(history({ oldCashOverride: 3000 }));
    expect(t.cash.carriedForward.difference).toBe(-160);
    expect(t.cash.steps[0]!.note).toBe(
      "Typed old cash is Rs 160 less than yesterday's final total (Rs 3160)",
    );
  });

  it("a saved (different) old cash behaves like a typed one", () => {
    const t = buildDailyTable(history({ savedOldCash: { [DAY]: 3000 } }));
    expect(t.cash.carriedForward.used).toBe(false);
    expect(t.cash.steps[0]!.note).toContain("less than");
  });

  it("typed old cash equal to yesterday's final total: no difference line", () => {
    const t = buildDailyTable(history({ oldCashOverride: 3160 }));
    expect(t.cash.carriedForward).toMatchObject({ used: false, difference: 0 });
    expect(t.cash.steps[0]!.note).toBeUndefined();
    expect(buildDailyTableText(t)).not.toContain("Typed old cash is");
  });

  it("first day with no history: the line is hidden", () => {
    const t = buildDailyTable(merge(cashDay(DAY, 100)));
    expect(t.cash.carriedForward).toEqual({
      date: null,
      amount: 0,
      used: false,
      fromSaved: false,
      difference: 0,
    });
    expect(t.cash.steps.map((s) => s.key)).not.toContain("carriedForward");
    expect(t.cash.steps[0]!.key).toBe("oldCash");
    expect(t.cash.steps[0]!.hint).toBe("no earlier day found, starts at 0");
    expect(buildDailyTableText(t)).not.toContain("Carried forward");
  });

  it("the text puts the carried line directly above Old cash", () => {
    const lines = buildDailyTableText(
      buildDailyTable(history({ oldCashOverride: 3360 })),
    ).split("\n");
    const i = lines.indexOf("Carried forward (03-11-2026): Rs 3160");
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toContain("Typed old cash is Rs 200 more than");
    expect(lines[i + 2]).toBe("Old cash: Rs 3360");
  });

  it("the final total is the same whether the line is shown or hidden", () => {
    const shown = buildDailyTable(history({ oldCashOverride: 500 }));
    const hidden = buildDailyTable(
      merge(cashDay(DAY, 100), { oldCashOverride: 500 }),
    );
    expect(shown.cash.steps.some((s) => s.key === "carriedForward")).toBe(true);
    expect(hidden.cash.steps.some((s) => s.key === "carriedForward")).toBe(
      false,
    );
    expect(shown.cash.finalTotal).toBe(hidden.cash.finalTotal);
    expect(shown.cash.cashAfterExpenses).toBe(hidden.cash.cashAfterExpenses);
  });
});
