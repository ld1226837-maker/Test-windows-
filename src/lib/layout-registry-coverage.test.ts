import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT_REGISTRY } from "./layout-prefs";
import { SECTION_PARTS } from "./layout-parts";

const APP_DIR = join(__dirname, "..", "components", "app");
const SRC = readdirSync(APP_DIR)
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
  .map((f) => readFileSync(join(APP_DIR, f), "utf8"))
  .join("\n");

describe("layout registry covers what the tabs render", () => {
  const sectionIds = new Set(
    LAYOUT_REGISTRY.flatMap((t) => t.sections.map((s) => s.id)),
  );
  const partIds = new Set(
    Object.values(SECTION_PARTS).flatMap((l) => l.map((p) => p.id)),
  );

  it("every <LayoutSection id> is registered (an unregistered one never renders)", () => {
    const rendered = [...SRC.matchAll(/<LayoutSection\s+id="([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(rendered.filter((id) => !sectionIds.has(id))).toEqual([]);
  });

  it("every <LayoutPart id> is registered", () => {
    const rendered = [...SRC.matchAll(/<LayoutPart\s+id="([^"]+)"/g)]
      .map((m) => m[1] ?? "")
      .filter((id) => !id.startsWith("surface."));
    expect(rendered.filter((id) => !partIds.has(id))).toEqual([]);
  });

  it("R23 additions are registered", () => {
    expect(sectionIds.has("settings.receipt-storage")).toBe(true);
    expect(partIds.has("money.add-expense.payment-mode")).toBe(true);
    expect(partIds.has("investments.summary.list")).toBe(true);
    expect(partIds.has("investments.summary.total")).toBe(true);
  });
});
