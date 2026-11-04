import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression: on Android, tauri-plugin-fs defaults to requireLiteralLeadingDot
 * = true, so the fs scope `$APPDATA/TurfApp/**` does NOT match dot-prefixed
 * names. Restore stages files in `Exports/.restore-*` and
 * `Receipts/.restore-staging`, so without this setting every restore failed
 * with "forbidden path: .../TurfApp/Exports/.restore-...".
 */
describe("tauri.conf.json fs plugin", () => {
  const conf = JSON.parse(
    readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
  ) as { plugins?: { fs?: { requireLiteralLeadingDot?: boolean } } };

  it("lets the app use its own dot-prefixed restore/partial folders", () => {
    expect(conf.plugins?.fs?.requireLiteralLeadingDot).toBe(false);
  });
});

/**
 * Regression: receipt photos (expenses, investments, bills) are shown through
 * `URL.createObjectURL()`, i.e. `blob:` image URLs. If the CSP's img-src does
 * not allow `blob:` the WebView refuses them and every receipt renders as a
 * broken image.
 */
describe("tauri.conf.json CSP", () => {
  const conf = JSON.parse(
    readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
  ) as { app?: { security?: { csp?: string } } };

  it("allows blob: and data: images so receipt previews can render", () => {
    const csp = conf.app?.security?.csp ?? "";
    const img =
      csp.split(";").find((d) => d.trim().startsWith("img-src")) ?? "";
    expect(img.split(/\s+/)).toEqual(
      expect.arrayContaining(["blob:", "data:"]),
    );
  });
});
