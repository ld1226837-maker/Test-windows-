import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT_REGISTRY } from "./layout-prefs";
import { SECTION_PARTS, SURFACE_REGISTRY } from "./layout-parts";

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
  it("every pop-up surface that renders parts is registered, with all its parts", () => {
    const surfaces = new Map(
      SURFACE_REGISTRY.map((sf) => [
        sf.surfaceId,
        new Set(sf.parts.map((x) => x.id)),
      ]),
    );
    const usedSurfaces = [...SRC.matchAll(/surfaceId="([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(usedSurfaces.filter((id) => !surfaces.has(id))).toEqual([]);
    const usedParts = [...SRC.matchAll(/<LayoutPart\s+id="(surface\.[^"]+)"/g)]
      .map((m) => m[1] ?? "")
      .filter((id) => ![...surfaces.values()].some((set) => set.has(id)));
    expect(usedParts).toEqual([]);
  });

  it("the Telegram connection-test pop-up is registered", () => {
    expect(
      SURFACE_REGISTRY.some((sf) => sf.surfaceId === "surface.connection-test"),
    ).toBe(true);
  });

  it("every registered pop-up part is rendered (except surfaces known to be unwired)", () => {
    // `surface.booking-extras` is registered for an Extras pop-up that does not
    // exist yet (booking step 3 is an inline section). Remove it from this list
    // when that pop-up is built.
    const NOT_YET_WIRED = ["surface.booking-extras"];
    const missing = SURFACE_REGISTRY.filter(
      (sf) => !NOT_YET_WIRED.includes(sf.surfaceId),
    ).flatMap((sf) =>
      sf.parts
        .map((x) => x.id)
        .filter((id) => !SRC.includes(`<LayoutPart id="${id}"`)),
    );
    expect(missing).toEqual([]);
    const unusedSurfaces = SURFACE_REGISTRY.filter(
      (sf) =>
        !NOT_YET_WIRED.includes(sf.surfaceId) &&
        !SRC.includes(`surfaceId="${sf.surfaceId}"`),
    ).map((sf) => sf.surfaceId);
    expect(unusedSurfaces).toEqual([]);
  });

  describe("every Telegram backup pop-up is registered and wired", () => {
    const TELEGRAM_SURFACES = [
      "surface.restore-passphrase",
      "surface.connection-test",
      "surface.restore-confirm",
      "surface.telegram-qr",
      "surface.scan-confirm",
      "surface.qr-scanner",
    ];
    const read = (f: string) => readFileSync(join(APP_DIR, f), "utf8");
    // Pop-ups = <Dialog>/<AlertDialog> openings (Collapsible etc. don't count).
    const popups = (src: string) =>
      (src.match(/<(?:Alert)?Dialog[\s>]/g) ?? []).length;
    const surfaceUses = (src: string) =>
      (src.match(/surfaceId="surface\./g) ?? []).length;

    it.each([
      "TelegramBackupCard.tsx",
      "QrScannerDialog.tsx",
      "ConnectionTestDialog.tsx",
      "RestorePassphrasePrompt.tsx",
    ])("%s: each pop-up declares a surfaceId", (file) => {
      const src = read(file);
      expect(popups(src)).toBeGreaterThan(0);
      expect(surfaceUses(src)).toBe(popups(src));
    });

    it("all six surfaces are in SURFACE_REGISTRY", () => {
      const ids = SURFACE_REGISTRY.map((sf) => sf.surfaceId);
      expect(TELEGRAM_SURFACES.filter((id) => !ids.includes(id))).toEqual([]);
    });

    it("every registered part of those surfaces is actually rendered", () => {
      const missing = SURFACE_REGISTRY.filter((sf) =>
        TELEGRAM_SURFACES.includes(sf.surfaceId),
      ).flatMap((sf) =>
        sf.parts
          .map((x) => x.id)
          .filter((id) => !SRC.includes(`<LayoutPart id="${id}"`)),
      );
      expect(missing).toEqual([]);
    });

    it("parts that guard destructive or secret-bearing content cannot be hidden", () => {
      const locked = (surfaceId: string, partId: string) =>
        SURFACE_REGISTRY.find((sf) => sf.surfaceId === surfaceId)?.parts.find(
          (x) => x.id === partId,
        )?.locked;
      expect(
        locked("surface.restore-confirm", "surface.restore-confirm.summary"),
      ).toBe(true);
      expect(
        locked("surface.restore-confirm", "surface.restore-confirm.actions"),
      ).toBe(true);
      expect(
        locked("surface.telegram-qr", "surface.telegram-qr.instructions"),
      ).toBe(true);
      expect(
        locked("surface.scan-confirm", "surface.scan-confirm.details"),
      ).toBe(true);
    });
  });
});
