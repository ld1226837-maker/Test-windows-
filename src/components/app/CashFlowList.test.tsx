// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildDailyTable,
  buildDailyTableText,
  stepAmountText,
  type DailyTable,
  type DailyTableDay,
} from "@/lib/daily-table";
import { CashFlowList } from "./CashFlowList";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const day = (o: Partial<DailyTableDay>): DailyTableDay => ({
  date: "2026-11-04",
  bookings: [],
  sales: [],
  bills: [],
  payments: [],
  expenses: [],
  tabEntries: [],
  ...o,
});
const expense = (amount: number, spent_at = "2026-11-04") =>
  ({
    id: `e${amount}${spent_at}`,
    category: "Other",
    description: null,
    note: null,
    amount,
    spent_at,
    payment_mode: "Cash",
    cash_part: null,
  }) as never;

let root: Root | null = null;
let host: HTMLElement | null = null;
const mount = (table: DailyTable) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<CashFlowList table={table} />));
  return host;
};
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("CashFlowList", () => {
  const withHistory = buildDailyTable(
    day({
      oldCashOverride: 1000,
      expenses: [expense(340), expense(5, "2026-11-03")],
      savedCashAfterExpenses: { "2026-11-03": 3160 },
    }),
  );

  it("is a labelled section with an ordered list, one item per step", () => {
    const el = mount(withHistory);
    expect(el.querySelector('section[aria-label="Cash flow"]')).toBeTruthy();
    const items = Array.from(el.querySelectorAll("ol > li"));
    expect(items.map((li) => li.getAttribute("data-step"))).toEqual(
      withHistory.cash.steps.map((s) => s.key),
    );
  });

  it("shows the same label and amount strings as the model, with spoken sign words", () => {
    const el = mount(withHistory);
    for (const st of withHistory.cash.steps) {
      const li = el.querySelector(`[data-step="${st.key}"]`)!;
      expect(li.textContent).toContain(st.label);
      expect(li.textContent).toContain(stepAmountText(st));
    }
    const less = el.querySelector('[data-step="cashExpenses"]')!;
    expect(less.querySelector(".sr-only")?.textContent).toContain("Minus");
    expect(
      el.querySelector('[data-step="collectedCash"] .sr-only')?.textContent,
    ).toContain("Plus");
    expect(
      el.querySelector('[data-step="finalTotal"] .sr-only')?.textContent,
    ).toContain("Equals");
  });

  it("the carried-forward string is identical here and in the text summary", () => {
    const el = mount(withHistory);
    const cf = withHistory.cash.steps[0]!;
    expect(cf.key).toBe("carriedForward");
    expect(el.textContent).toContain("CARRIED FORWARD (03-11-2026)");
    expect(el.textContent).toContain(cf.hint!);
    expect(buildDailyTableText(withHistory)).toContain(
      `Carried forward (03-11-2026): Rs ${stepAmountText(cf)}`,
    );
  });

  it("a negative balance shows a minus sign AND is flagged, not colour alone", () => {
    const neg = buildDailyTable(
      day({ oldCashOverride: 50, expenses: [expense(300)] }),
    );
    const el = mount(neg);
    const after = el.querySelector('[data-step="cashAfterExpenses"]')!;
    expect(after.textContent).toContain("-250");
    expect(after.querySelector('[data-negative="true"]')).toBeTruthy();
    expect(
      el.querySelector('[data-step="cashExpenses"] [data-negative]'),
    ).toBeNull();
  });

  it("the caption explains the flow in words", () => {
    const el = mount(withHistory);
    expect(el.textContent).toContain(
      "Old cash - cash expenses = cash after expenses; + collected cash = final total.",
    );
  });
});
