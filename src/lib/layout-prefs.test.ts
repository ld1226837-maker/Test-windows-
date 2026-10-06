import { describe, expect, it } from "vitest";
import {
  LAYOUT_REGISTRY,
  getDefaultLayout,
  migrateSettingsOrder,
  normalizeLayout,
  sectionKind,
  sectionLabel,
  tabLabel,
} from "./layout-prefs";

describe("section kinds", () => {
  it("returns the registry kind when set", () => {
    expect(sectionKind("home.trend-14d")).toBe("chart");
    expect(sectionKind("turf.new-booking")).toBe("form");
  });

  it("defaults unknown ids to panel", () => {
    expect(sectionKind("nope.missing")).toBe("panel");
  });

  it("keeps labels and tab labels resolvable", () => {
    expect(sectionLabel("settings.layout")).toBe("Layout & arrangement");
    expect(tabLabel("money")).toBe("Expenses");
    expect(tabLabel("customers")).toBe("Customers");
    expect(tabLabel("nope")).toBe("nope");
  });
});

describe("normalizeLayout after the registry change", () => {
  const settingsOrder = [
    "settings.telegram",
    "settings.backup",
    "settings.turf-rates",
    "settings.snack-items",
    "settings.billing",
    "settings.bills-printing",
    "settings.whatsapp",
    "settings.snack-combos",
    "settings.monthly-report",
    "settings.theme",
    "settings.layout",
    "settings.archive",
    "settings.loadtest",
    "settings.receipt-storage",
    "settings.danger-zone",
  ];

  it("ships Settings in usage-priority order with Data Safety first", () => {
    const settings = getDefaultLayout().tabs.find(
      (tab) => tab.tabId === "settings",
    );
    expect(settings?.sections.map((section) => section.id)).toEqual(
      settingsOrder,
    );
  });

  it("migrates an old Settings order without changing visibility", () => {
    const layout = getDefaultLayout();
    const settings = layout.tabs.find((tab) => tab.tabId === "settings");
    if (!settings) throw new Error("Settings tab missing");
    settings.sections.reverse().forEach((section, order) => {
      section.order = order;
    });
    const hidden = settings.sections.find(
      (section) => section.id === "settings.theme",
    );
    if (!hidden) throw new Error("Theme section missing");
    hidden.visible = false;

    const migrated = migrateSettingsOrder(layout);
    const migratedSettings = migrated.tabs.find(
      (tab) => tab.tabId === "settings",
    );
    expect(migratedSettings?.sections.map((section) => section.id)).toEqual(
      settingsOrder,
    );
    expect(
      migratedSettings?.sections.find(
        (section) => section.id === "settings.theme",
      )?.visible,
    ).toBe(false);
  });

  it("round-trips a stored layout without dropping anything", () => {
    const base = getDefaultLayout();
    const stored = JSON.parse(JSON.stringify(base));
    stored.tabs[0].sections[0].visible = false;
    stored.density = "compact";
    const out = normalizeLayout(stored);
    expect(out.density).toBe("compact");
    expect(out.tabs).toHaveLength(LAYOUT_REGISTRY.length);
    expect(out.tabs[0]?.sections[0]?.visible).toBe(false);
  });

  it("never stores a kind field on section state", () => {
    const out = normalizeLayout(getDefaultLayout());
    expect(Object.keys(out.tabs[0]!.sections[0]!).sort()).toEqual([
      "id",
      "order",
      "parts",
      "visible",
    ]);
  });

  it("forces the settings tab and layout section visible", () => {
    const out = normalizeLayout({
      density: "comfortable",
      tabs: [
        {
          tabId: "settings",
          visible: false,
          order: 0,
          sections: [{ id: "settings.layout", visible: false, order: 0 }],
        },
      ],
    });
    const settings = out.tabs.find((t) => t.tabId === "settings");
    if (!settings) throw new Error("Settings tab missing");
    expect(settings.visible).toBe(true);
    expect(
      settings.sections.find((s) => s.id === "settings.layout")?.visible,
    ).toBe(true);
  });
});

describe("R18 layout additions", () => {
  it("appends new sections/tabs without losing old stored state", () => {
    const old = getDefaultLayout();
    old.tabs = old.tabs.filter((t) => t.tabId !== "investments");
    const customers = old.tabs.find((t) => t.tabId === "customers")!;
    customers.sections = customers.sections.filter(
      (s) => s.id !== "customers.teams",
    );
    const home = old.tabs.find((t) => t.tabId === "home")!;
    home.sections = home.sections.filter((s) => s.id !== "home.calendar");
    customers.visible = false;
    customers.sections[0]!.visible = false;
    const out = normalizeLayout(old);
    expect(out.tabs.find((t) => t.tabId === "customers")?.visible).toBe(false);
    expect(
      out.tabs
        .find((t) => t.tabId === "customers")
        ?.sections.find((s) => s.id === "customers.teams"),
    ).toBeTruthy();
    expect(
      out.tabs
        .find((t) => t.tabId === "home")
        ?.sections.find((s) => s.id === "home.calendar"),
    ).toBeTruthy();
    expect(out.tabs.find((t) => t.tabId === "investments")).toBeTruthy();
  });
  it("preserves existing relative order while appending newly registered sections", () => {
    const old = getDefaultLayout();
    const home = old.tabs.find((t) => t.tabId === "home")!;
    home.sections = home.sections.filter((s) => s.id !== "home.calendar");
    const original = home.sections.map((s) => s.id);
    const out = normalizeLayout(old);
    const restored = out.tabs
      .find((t) => t.tabId === "home")!
      .sections.map((s) => s.id);
    expect(restored.filter((id) => original.includes(id))).toEqual(original);
    expect(restored.indexOf("home.calendar")).toBeGreaterThan(
      restored.length - 2,
    );
  });

  it("recovers from malformed/duplicate section state without crashing", () => {
    const out = normalizeLayout({
      tabs: [
        {
          tabId: "home",
          visible: true,
          order: 0,
          sections: [
            { id: "home.today-numbers", visible: false, order: 0 },
            { id: "home.today-numbers", visible: true, order: 0 },
            { id: "unknown", visible: true, order: 1 },
          ],
        },
      ],
      density: "bad",
      surfaces: [],
    } as any);
    const home = out.tabs.find((t) => t.tabId === "home")!;
    expect(new Set(home.sections.map((s) => s.id)).size).toBe(
      home.sections.length,
    );
    expect(home.sections.some((s) => s.id === "home.calendar")).toBe(true);
    expect(out.density).toBe("comfortable");
  });
});
