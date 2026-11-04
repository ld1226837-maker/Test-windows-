// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const run = vi.fn(async (_action: string, _table: unknown) => true);
const build = vi.fn((date: string, override?: number | null) => ({
  date,
  rows: [],
  totals: { total: 0, offer: 0, advance: 0, cash: 2500, online: 0 },
  counts: { bookings: 0, snackSales: 0 },
  expenseList: [],
  expenseTotal: 0,
  // Old cash 2300 unless typed; cash expenses 340, collected cash 2500.
  cash: makeCashFlow({
    date,
    oldCash: override ?? 2300,
    source: override == null ? "previous" : "typed",
    cashExpenses: 340,
    onlineExpenses: 260,
    collectedCash: 2500,
    carried: { date: "2026-10-26", amount: 2300 },
  }),
}));
const goToTab = vi.fn();

vi.mock("@/lib/nav", () => ({ goToTab: (...a: unknown[]) => goToTab(...a) }));
vi.mock("@/lib/daily-table-actions", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/daily-table-actions")
  >("@/lib/daily-table-actions");
  return {
    ...actual,
    useDailyTableSource: () => ({ build }),
    useDailyTableActions: () => ({ run, busy: false, phase: "idle" }),
  };
});

import { DailyTableShortcut } from "./DailyTableShortcut";
import { parseOldCash } from "@/lib/daily-table-actions";
import { makeCashFlow } from "@/lib/daily-table";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const mount = () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<DailyTableShortcut />));
};
const byText = (t: string) =>
  Array.from(document.body.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(t),
  ) as HTMLButtonElement | undefined;
const click = (el: Element | undefined) => {
  expect(el).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const setValue = (input: HTMLInputElement, v: string) => {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    set.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  run.mockClear();
  build.mockClear();
  goToTab.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

describe("DailyTableShortcut", () => {
  it("a tap shows two options and sends nothing yet", () => {
    mount();
    click(byText("Send table summary"));
    expect(byText("Go to Settings")).toBeTruthy();
    expect(byText("Enter old cash and send")).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    expect(goToTab).not.toHaveBeenCalled();
  });

  it("option 1 opens Settings directly", () => {
    mount();
    click(byText("Send table summary"));
    click(byText("Go to Settings"));
    expect(goToTab).toHaveBeenCalledWith("settings");
    expect(run).not.toHaveBeenCalled();
  });

  it("option 2 pre-fills the old cash and sends the typed figure", () => {
    mount();
    click(byText("Send table summary"));
    click(byText("Enter old cash and send"));
    const input = document.body.querySelector(
      'input[aria-label="Old cash"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("2300");
    setValue(input, "1,500");
    click(byText("Send to owner"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe("send");
    // run() receives the table built with the typed old cash.
    expect(run.mock.calls[0]![1]).toMatchObject({
      cash: { oldCash: 1500 },
    });
  });

  it("leaving old cash untouched sends with the suggested figure (no override)", () => {
    mount();
    click(byText("Send table summary"));
    click(byText("Enter old cash and send"));
    click(byText("Send to owner"));
    expect(run).toHaveBeenCalledTimes(1);
    // nothing typed -> no override, so the suggested (saved / carried) figure is used
    expect(run.mock.calls[0]![1]).toMatchObject({
      cash: { oldCash: 2300 },
    });
  });

  const steps = () =>
    Array.from(document.body.querySelectorAll("[data-step]")).map((el) => ({
      key: el.getAttribute("data-step"),
      text: el.textContent ?? "",
    }));

  it("the preview lists the cash flow steps in order, with plus / minus spelled out", () => {
    mount();
    click(byText("Send table summary"));
    click(byText("Enter old cash and send"));
    expect(steps().map((x) => x.key)).toEqual([
      "carriedForward",
      "oldCash",
      "cashExpenses",
      "cashAfterExpenses",
      "collectedCash",
      "finalTotal",
    ]);
    const list = document.body.querySelector("ol")!;
    expect(list.tagName).toBe("OL");
    const byKey = Object.fromEntries(steps().map((x) => [x.key, x.text]));
    expect(byKey["carriedForward"]).toContain("CARRIED FORWARD (26-10-2026)");
    expect(byKey["cashExpenses"]).toContain("Minus");
    expect(byKey["cashExpenses"]).toContain("-340");
    expect(byKey["collectedCash"]).toContain("Plus");
    expect(byKey["collectedCash"]).toContain("+2500");
    expect(byKey["finalTotal"]).toContain("Equals");
    expect(byKey["finalTotal"]).toContain("4460"); // 2300 - 340 + 2500
  });

  it("editing the old-cash field updates every figure at once", () => {
    mount();
    click(byText("Send table summary"));
    click(byText("Enter old cash and send"));
    const input = document.body.querySelector(
      'input[aria-label="Old cash"]',
    ) as HTMLInputElement;
    setValue(input, "1,000");
    const byKey = Object.fromEntries(steps().map((x) => [x.key, x.text]));
    expect(byKey["oldCash"]).toContain("1000");
    expect(byKey["cashAfterExpenses"]).toContain("660");
    expect(byKey["finalTotal"]).toContain("3160");
    // the typed value differs from yesterday's total, said in plain words
    expect(byKey["carriedForward"]).toContain("less than");
  });

  it("parseOldCash handles commas, blanks and negatives", () => {
    expect(parseOldCash("1,170")).toBe(1170);
    expect(parseOldCash("")).toBeNull();
    expect(parseOldCash("-50")).toBe(50);
    expect(parseOldCash("abc")).toBeNull();
  });
});
