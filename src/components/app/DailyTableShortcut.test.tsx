// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const run = vi.fn(async (_action: string, _table: unknown) => true);
const build = vi.fn((date: string, override?: number | null) => ({
  date,
  oldCash: override ?? 2300,
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
    expect(run.mock.calls[0]![1]).toMatchObject({ oldCash: 1500 });
  });

  it("leaving old cash untouched sends with the suggested figure (no override)", () => {
    mount();
    click(byText("Send table summary"));
    click(byText("Enter old cash and send"));
    click(byText("Send to owner"));
    expect(run).toHaveBeenCalledTimes(1);
    // nothing typed -> no override, so the suggested (saved / carried) figure is used
    expect(run.mock.calls[0]![1]).toMatchObject({ oldCash: 2300 });
  });

  it("parseOldCash handles commas, blanks and negatives", () => {
    expect(parseOldCash("1,170")).toBe(1170);
    expect(parseOldCash("")).toBeNull();
    expect(parseOldCash("-50")).toBe(50);
    expect(parseOldCash("abc")).toBeNull();
  });
});
