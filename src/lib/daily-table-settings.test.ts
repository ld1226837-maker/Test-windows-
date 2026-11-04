import { describe, expect, it } from "vitest";
import {
  DAILY_OLD_CASH_KEEP,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
} from "./settings";

describe("Daily Summary settings", () => {
  it("defaults: logo on, no saved old cash", () => {
    expect(DEFAULT_APP_SETTINGS.summaryImageLogo).toBe(true);
    expect(DEFAULT_APP_SETTINGS.dailyOldCash).toEqual({});
  });

  it("an old save without the new fields loads with the defaults", () => {
    const s = normalizeAppSettings({ whatsappOwner: "9876543210" });
    expect(s.summaryImageLogo).toBe(true);
    expect(s.dailyOldCash).toEqual({});
    expect(s.whatsappOwner).toBe("9876543210");
  });

  it("keeps good day entries, drops junk, rounds, and survives a round trip", () => {
    const s = normalizeAppSettings({
      summaryImageLogo: false,
      dailyOldCash: {
        "2026-10-27": 2300.4,
        "2026-10-26": -5,
        "not-a-day": 10,
        "2026-10-25": "abc",
      },
    });
    expect(s.summaryImageLogo).toBe(false);
    expect(s.dailyOldCash).toEqual({ "2026-10-27": 2300 });
    expect(normalizeAppSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("only the newest days are kept", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < DAILY_OLD_CASH_KEEP + 30; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      many[d.toISOString().slice(0, 10)] = i;
    }
    const kept = Object.keys(
      normalizeAppSettings({ dailyOldCash: many }).dailyOldCash,
    );
    expect(kept).toHaveLength(DAILY_OLD_CASH_KEEP);
    expect(kept).not.toContain("2026-01-01");
  });
});

describe("Daily Summary settings - cash after expenses", () => {
  it("defaults to {} and an old save without the key loads cleanly", () => {
    expect(DEFAULT_APP_SETTINGS.dailyCashAfterExpenses).toEqual({});
    expect(normalizeAppSettings({}).dailyCashAfterExpenses).toEqual({});
    expect(
      normalizeAppSettings({ dailyOldCash: { "2026-10-27": 5 } })
        .dailyCashAfterExpenses,
    ).toEqual({});
    expect(
      normalizeAppSettings({ dailyCashAfterExpenses: "junk" })
        .dailyCashAfterExpenses,
    ).toEqual({});
  });

  it("ALLOWS negatives, rounds, drops junk, and survives a round trip", () => {
    const s = normalizeAppSettings({
      dailyCashAfterExpenses: {
        "2026-10-27": 660.4,
        "2026-10-26": -250,
        "2026-10-25": -0.2,
        "bad-day": 5,
        "2026-10-24": "abc",
        "2026-10-23": null,
        "2026-10-22": true,
      },
    });
    expect(s.dailyCashAfterExpenses).toEqual({
      "2026-10-27": 660,
      "2026-10-26": -250,
      "2026-10-25": 0,
    });
    expect(Object.is(s.dailyCashAfterExpenses["2026-10-25"], 0)).toBe(true);
    expect(normalizeAppSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("only the newest days are kept", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < DAILY_OLD_CASH_KEEP + 20; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      many[d.toISOString().slice(0, 10)] = -i;
    }
    const kept = Object.keys(
      normalizeAppSettings({ dailyCashAfterExpenses: many })
        .dailyCashAfterExpenses,
    );
    expect(kept).toHaveLength(DAILY_OLD_CASH_KEEP);
    expect(kept).not.toContain("2026-01-01");
  });
});
