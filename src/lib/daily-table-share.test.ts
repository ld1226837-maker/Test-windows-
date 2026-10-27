import { describe, expect, it, vi } from "vitest";
import {
  TOAST_CHOOSE_OWNER,
  TOAST_COPIED_PASTE,
  TOAST_NO_OWNER,
  WHATSAPP_PACKAGES,
  copyTableText,
  downloadImage,
  sendToOwner,
  shareImage,
  type ShareDeps,
} from "./daily-table-share";
import { runSummaryAction } from "./daily-table-actions";
import type { RenderedImage } from "./daily-table-image";
import { DEFAULT_APP_SETTINGS } from "./settings";
import type { DailyTable } from "./daily-table";

const img = (name = "Daily-Summary-27-10-2026.png"): RenderedImage => ({
  blob: new Blob(["png"], { type: "image/png" }),
  fileName: name,
  width: 2160,
  height: 1200,
});

function deps(over: Partial<ShareDeps> = {}) {
  const notify = { success: vi.fn(), info: vi.fn(), error: vi.fn() };
  const d: ShareDeps = {
    platform: "android",
    notify,
    shareAndroid: vi.fn(async () => ({ via: "package" })),
    saveAndroid: vi.fn(async () => ({ saved: true, path: "content://x" })),
    openAndroidFile: vi.fn(async () => undefined),
    saveDesktop: vi.fn(async (_b, name) => `C:\\Users\\o\\Downloads\\${name}`),
    reveal: vi.fn(async () => undefined),
    copyImage: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => true),
    webShare: vi.fn(async () => false),
    webDownload: vi.fn(),
    ...over,
  };
  return { d, notify };
}

const messages = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => c[0]);

describe("sendToOwner - Android", () => {
  it("opens the share sheet with the PNG, straight into WhatsApp when the owner number is saved", async () => {
    const { d, notify } = deps();
    const res = await sendToOwner({ images: [img()], owner: "98765 43210" }, d);
    expect(res).toEqual({ ok: true, route: "android-share" });
    const req = (d.shareAndroid as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(req).toMatchObject({
      fileName: "Daily-Summary-27-10-2026.png",
      mimeType: "image/png",
      packages: WHATSAPP_PACKAGES,
      jid: "919876543210@s.whatsapp.net",
    });
    expect(req.bytes).toBeInstanceOf(Uint8Array);
    expect(messages(notify.info)).toContain(TOAST_CHOOSE_OWNER);
  });

  it("never claims the image was sent", async () => {
    const { d, notify } = deps();
    await sendToOwner({ images: [img()], owner: "9876543210" }, d);
    const all = [...notify.info.mock.calls, ...notify.success.mock.calls]
      .map((c) => String(c[0]).toLowerCase())
      .join(" ");
    expect(all).not.toMatch(/\bsent\b(?! *$)|was sent|has been sent/);
    expect(all).toContain("to send");
  });

  it("without an owner number it still shares (chooser) and shows the add-number toast", async () => {
    const openSettings = vi.fn();
    const { d, notify } = deps();
    const res = await sendToOwner(
      { images: [img()], owner: "", openSettings },
      d,
    );
    expect(res.ok).toBe(true);
    const req = (d.shareAndroid as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(req.packages).toEqual([]);
    expect(req.jid).toBeUndefined();
    expect(messages(notify.info)).toContain(TOAST_NO_OWNER);
    const action = notify.info.mock.calls.find(
      (c) => c[0] === TOAST_NO_OWNER,
    )![1].action;
    action.onClick();
    expect(openSettings).toHaveBeenCalled();
  });

  it("a share failure ends in an error toast whose action copies the text", async () => {
    const copyText = vi.fn();
    const { d, notify } = deps({
      shareAndroid: vi.fn(async () => {
        throw new Error("plugin missing");
      }),
    });
    const res = await sendToOwner(
      { images: [img()], owner: "9876543210", copyText },
      d,
    );
    expect(res).toEqual({ ok: false, route: "failed" });
    const [title, opts] = notify.error.mock.calls[0]!;
    expect(title).toBe("Couldn't share the image");
    expect(opts.description).toContain("plugin missing");
    expect(opts.action.label).toBe("Copy text instead");
    opts.action.onClick();
    await Promise.resolve();
    expect(copyText).toHaveBeenCalled();
  });

  it("extra parts are kept in Downloads", async () => {
    const { d } = deps();
    await sendToOwner(
      { images: [img("a-1.png"), img("a-2.png")], owner: "9876543210" },
      d,
    );
    expect(d.saveAndroid).toHaveBeenCalledTimes(1);
    expect((d.saveAndroid as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(
      "a-2.png",
    );
  });
});

describe("sendToOwner - Windows", () => {
  it("saves to Downloads, copies the image, opens wa.me, and tells the user to paste", async () => {
    const { d, notify } = deps({ platform: "desktop" });
    const image = img();
    const res = await sendToOwner({ images: [image], owner: "98765 43210" }, d);
    expect(res).toEqual({ ok: true, route: "desktop-clipboard" });
    expect(d.saveDesktop).toHaveBeenCalledTimes(1);
    expect(d.copyImage).toHaveBeenCalledWith(image.blob);
    expect(d.openUrl).toHaveBeenCalledWith("https://wa.me/919876543210");
    expect(messages(notify.success)).toContain(TOAST_COPIED_PASTE);
    expect(messages(notify.info)).toContain(TOAST_CHOOSE_OWNER);
  });

  it("does not open wa.me without a number but still saves and copies", async () => {
    const { d, notify } = deps({ platform: "desktop" });
    await sendToOwner({ images: [img()], owner: "" }, d);
    expect(d.openUrl).not.toHaveBeenCalled();
    expect(d.copyImage).toHaveBeenCalled();
    expect(messages(notify.info)).toContain(TOAST_NO_OWNER);
  });

  it("a clipboard refusal keeps the saved file and says where it is", async () => {
    const { d, notify } = deps({
      platform: "desktop",
      copyImage: vi.fn(async () => {
        throw new Error("denied");
      }),
    });
    const res = await sendToOwner({ images: [img()], owner: "9876543210" }, d);
    expect(res.ok).toBe(true);
    const [title, o] = notify.error.mock.calls[0]!;
    expect(title).toBe("Couldn't copy the image");
    expect(o.description).toContain("Downloads");
  });

  it("a failed wa.me open is reported, not hidden", async () => {
    const { d, notify } = deps({
      platform: "desktop",
      openUrl: vi.fn(async () => false),
    });
    await sendToOwner({ images: [img()], owner: "9876543210" }, d);
    expect(messages(notify.error)).toContain(
      "Couldn't open WhatsApp automatically",
    );
  });
});

describe("downloadImage", () => {
  it("Android: saves via saveExportFile with a toast naming the file and an Open button", async () => {
    const { d, notify } = deps();
    const res = await downloadImage({ images: [img()], owner: "" }, d);
    expect(res.ok).toBe(true);
    expect(d.saveAndroid).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "Daily-Summary-27-10-2026.png",
      "image/png",
    );
    const [title, o] = notify.success.mock.calls[0]!;
    expect(title).toContain("Daily-Summary-27-10-2026.png");
    expect(o.action.label).toBe("Open");
    o.action.onClick();
    expect(d.openAndroidFile).toHaveBeenCalled();
  });

  it("Android: a refused save is an error toast", async () => {
    const { d, notify } = deps({
      saveAndroid: vi.fn(async () => ({
        saved: false,
        error: "Storage permission was denied.",
      })),
    });
    const res = await downloadImage({ images: [img()], owner: "" }, d);
    expect(res.ok).toBe(false);
    expect(notify.error.mock.calls[0]![1].description).toContain("permission");
  });

  it("Windows: writes to Downloads and offers Show in folder", async () => {
    const { d, notify } = deps({ platform: "desktop" });
    await downloadImage({ images: [img()], owner: "" }, d);
    const o = notify.success.mock.calls[0]![1];
    o.action.onClick();
    expect(d.reveal).toHaveBeenCalledWith(
      "C:\\Users\\o\\Downloads\\Daily-Summary-27-10-2026.png",
    );
  });
});

describe("shareImage", () => {
  it("Android: generic chooser, no package", async () => {
    const { d } = deps();
    await shareImage({ images: [img()], owner: "9876543210" }, d);
    expect(
      (d.shareAndroid as ReturnType<typeof vi.fn>).mock.calls[0]![0].packages,
    ).toEqual([]);
  });
  it("Windows without a share sheet: saves and copies", async () => {
    const { d, notify } = deps({ platform: "desktop" });
    const res = await shareImage({ images: [img()], owner: "" }, d);
    expect(res.route).toBe("desktop-clipboard");
    expect(d.saveDesktop).toHaveBeenCalled();
    expect(d.copyImage).toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalled();
  });
});

describe("copy text and the render-failure fallback", () => {
  it("copyTableText toasts success and failure", async () => {
    const notify = { success: vi.fn(), info: vi.fn(), error: vi.fn() };
    expect(await copyTableText("x", notify, async () => undefined)).toBe(true);
    expect(notify.success).toHaveBeenCalled();
    expect(
      await copyTableText("x", notify, async () => {
        throw new Error("no clipboard");
      }),
    ).toBe(false);
    expect(notify.error).toHaveBeenCalled();
  });

  const tbl: DailyTable = {
    date: "2026-10-27",
    rows: [],
    totals: { total: 0, offer: 0, advance: 0, cash: 0, online: 0 },
    cashBlock: { specificCash: 0, expenses: 0, remainingCash: 0 },
    expenseList: [],
    expenseTotal: 0,
    oldCash: 0,
    oldCashIsDefault: true,
    finalTotal: 0,
  };

  it("when rendering fails: error toast with Copy text instead, nothing shared, nothing remembered", async () => {
    const { d, notify } = deps();
    const remember = vi.fn();
    const ok = await runSummaryAction({
      action: "send",
      table: tbl,
      settings: DEFAULT_APP_SETTINGS,
      rememberOldCash: remember,
      deps: d,
      render: async () => {
        throw new Error("Canvas 2D is not available");
      },
    });
    expect(ok).toBe(false);
    expect(d.shareAndroid).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    const [title, o] = notify.error.mock.calls[0]!;
    expect(title).toBe("Couldn't make the summary image");
    expect(o.action.label).toBe("Copy text instead");
  });

  it("a good run remembers the old cash for that day and reports the phases", async () => {
    const { d } = deps();
    const remember = vi.fn();
    const phases: string[] = [];
    const ok = await runSummaryAction({
      action: "send",
      table: { ...tbl, oldCash: 2300 },
      settings: { ...DEFAULT_APP_SETTINGS, whatsappOwner: "9876543210" },
      rememberOldCash: remember,
      onPhase: (p) => phases.push(p),
      deps: d,
      render: async () => [img()],
    });
    expect(ok).toBe(true);
    expect(remember).toHaveBeenCalledWith("2026-10-27", 2300);
    expect(phases).toEqual(["rendering", "sharing", "idle"]);
  });
});
