// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const download = vi.fn(async () => ({ ok: true }));
vi.mock("./daily-table-image", () => ({
  loadLogo: async () => null,
  renderDailyTableImages: async () => [
    { blob: new Blob(["x"]), fileName: "x.png", width: 1, height: 1 },
  ],
}));
vi.mock("./daily-table-share", () => ({
  copyTableText: async () => true,
  defaultShareDeps: () => ({
    notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  }),
  downloadImage: (...a: unknown[]) => download(...(a as [])),
  sendToOwner: async () => ({ ok: true }),
  shareImage: async () => ({ ok: true }),
}));
vi.mock("./data", () => ({
  useBills: () => ({ data: [] }),
  usePayments: () => ({ data: [] }),
}));
vi.mock("./ops", () => ({
  useExpensesV2: () => ({ data: [] }),
  useSnackSales: () => ({ data: [] }),
  useTurfBookings: () => ({ data: [] }),
}));
vi.mock("./tabs", () => ({ useTabEntries: () => ({ data: [] }) }));

import { makeCashFlow, type DailyTable } from "./daily-table";
import {
  useDailyTableActions,
  withDayRecord,
  type SummaryAction,
} from "./daily-table-actions";
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  readAppSettings,
} from "./settings";
import { captureLocalSettings } from "./backup";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const table = (oldCash: number, cashExpenses: number): DailyTable => ({
  date: "2026-11-04",
  rows: [],
  totals: { total: 0, offer: 0, advance: 0, cash: 2500, online: 0 },
  counts: { bookings: 0, snackSales: 0 },
  expenseList: [],
  expenseTotal: 0,
  cash: makeCashFlow({
    date: "2026-11-04",
    oldCash,
    cashExpenses,
    collectedCash: 2500,
  }),
});

describe("withDayRecord", () => {
  it("records both figures in ONE new settings object", () => {
    const next = withDayRecord(DEFAULT_APP_SETTINGS, "2026-11-04", {
      oldCash: 1000,
      cashAfterExpenses: 660,
    })!;
    expect(next.dailyOldCash).toEqual({ "2026-11-04": 1000 });
    expect(next.dailyCashAfterExpenses).toEqual({ "2026-11-04": 660 });
    expect(next.whatsappOwner).toBe(DEFAULT_APP_SETTINGS.whatsappOwner);
  });

  it("returns null when nothing would change", () => {
    const s = withDayRecord(DEFAULT_APP_SETTINGS, "2026-11-04", {
      oldCash: 1000,
      cashAfterExpenses: 660,
    })!;
    expect(
      withDayRecord(s, "2026-11-04", { oldCash: 1000, cashAfterExpenses: 660 }),
    ).toBeNull();
    // a re-send after editing the day overwrites that date's stored value
    const edited = withDayRecord(s, "2026-11-04", {
      oldCash: 1000,
      cashAfterExpenses: 500,
    })!;
    expect(edited.dailyCashAfterExpenses["2026-11-04"]).toBe(500);
  });

  it("stores a negative cash after expenses, but not a negative old cash", () => {
    const next = withDayRecord(DEFAULT_APP_SETTINGS, "2026-11-04", {
      oldCash: -200,
      cashAfterExpenses: -450,
    })!;
    expect(next.dailyCashAfterExpenses["2026-11-04"]).toBe(-450);
    expect(next.dailyOldCash).toEqual({});
  });
});

describe("useDailyTableActions - stored value written once on send", () => {
  let root: Root | null = null;
  let run: ((a: SummaryAction, t: DailyTable) => Promise<boolean>) | null =
    null;

  function Probe() {
    run = useDailyTableActions().run;
    return null;
  }

  beforeEach(() => {
    window.localStorage.clear();
    download.mockClear();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
  });
  afterEach(() => {
    act(() => root?.unmount());
    vi.restoreAllMocks();
  });

  it("one save() writes old cash AND cash after expenses for that date", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    let ok = false;
    await act(async () => {
      ok = await run!("download", table(1000, 340));
    });
    expect(ok).toBe(true);
    const writes = set.mock.calls.filter(([k]) => k === "ks:app-settings");
    expect(writes).toHaveLength(1);
    const saved = JSON.parse(String(writes[0]![1]));
    expect(saved.dailyOldCash).toEqual({ "2026-11-04": 1000 });
    expect(saved.dailyCashAfterExpenses).toEqual({ "2026-11-04": 660 });
    expect(readAppSettings().dailyCashAfterExpenses["2026-11-04"]).toBe(660);
  });

  it("a storage failure never blocks sending", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    let ok = false;
    await act(async () => {
      ok = await run!("download", table(1000, 340));
    });
    expect(ok).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe("backup and restore carry the new key", () => {
  it("captureLocalSettings holds it and restoring it normalizes cleanly", () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "ks:app-settings",
      JSON.stringify({
        ...DEFAULT_APP_SETTINGS,
        dailyCashAfterExpenses: { "2026-11-03": -120, "2026-11-04": 660 },
      }),
    );
    const captured = captureLocalSettings();
    const restored = normalizeAppSettings(
      JSON.parse(captured["ks:app-settings"]!),
    );
    expect(restored.dailyCashAfterExpenses).toEqual({
      "2026-11-03": -120,
      "2026-11-04": 660,
    });
  });

  it("a backup from before this change restores with an empty map", () => {
    const { dailyCashAfterExpenses: _omit, ...old } = DEFAULT_APP_SETTINGS;
    void _omit;
    expect(normalizeAppSettings(old).dailyCashAfterExpenses).toEqual({});
  });
});
