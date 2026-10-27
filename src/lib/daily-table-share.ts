/**
 * Sends, saves and shares the Daily Summary picture.
 *
 * Hard rule: a WhatsApp link (wa.me) cannot attach an image, and Android never
 * tells us whether the user pressed send. So nothing here ever says the picture
 * "was sent". After the share sheet / the paste step the toast is always
 * "Choose the owner in WhatsApp to send". Every path ends in a toast and none of
 * them throws: a failure leaves the data untouched and offers "Copy text instead".
 *
 * Platform routes (all injectable, so tests never touch a real device):
 *   Android  share sheet with the PNG (WhatsApp / WhatsApp Business straight
 *            away when the owner number is saved), Downloads via saveExportFile.
 *   Windows  save to Downloads + copy the image to the clipboard + open wa.me.
 *   Browser  Web Share with the file when the browser allows it, else download.
 */
import { toast } from "sonner";
import {
  bytesToBase64,
  isAndroid,
  isDesktop,
  openExternal,
  openPrivateAndroidFile,
  revealInFolder,
  saveExportFile,
  type ExportSaveResult,
} from "./desktop";
import type { RenderedImage } from "./daily-table-image";
import { waMeUrl, whatsappNumber } from "./phone";

export type SharePlatform = "android" | "desktop" | "web";

export const detectSharePlatform = (): SharePlatform =>
  isAndroid() ? "android" : isDesktop() ? "desktop" : "web";

export const PNG_MIME = "image/png";
export const WHATSAPP_PACKAGES = ["com.whatsapp", "com.whatsapp.w4b"];

export const TOAST_CHOOSE_OWNER = "Choose the owner in WhatsApp to send";
export const TOAST_COPIED_PASTE =
  "Image copied - press Ctrl+V in the chat and send";
export const TOAST_NO_OWNER = "Add the owner number in Settings";

export type ToastOptions = {
  description?: string | undefined;
  action?: { label: string; onClick: () => void } | undefined;
};
export type Notify = {
  success: (message: string, o?: ToastOptions) => void;
  info: (message: string, o?: ToastOptions) => void;
  error: (message: string, o?: ToastOptions) => void;
};

const sonnerNotify: Notify = {
  success: (m, o) => void toast.success(m, o),
  info: (m, o) => void toast.info(m, o),
  error: (m, o) => void toast.error(m, o),
};

export type NativeShareRequest = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  packages: string[];
  jid?: string | undefined;
  title?: string | undefined;
};
export type NativeShareResult = { via?: string; package?: string };

/** Android share sheet via the bundled android-save plugin. Throws on failure. */
export async function shareFileAndroid(
  req: NativeShareRequest,
): Promise<NativeShareResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativeShareResult>("plugin:android-save|share_file", {
    payload: {
      fileName: req.fileName,
      mimeType: req.mimeType,
      base64: bytesToBase64(req.bytes),
      packages: req.packages,
      jid: req.jid,
      title: req.title,
    },
  });
}

/** Windows/macOS/Linux: writes into the user's Downloads folder. Returns the path. */
export async function saveToDownloadsDesktop(
  bytes: Uint8Array,
  fileName: string,
): Promise<string> {
  const { downloadDir, join } = await import("@tauri-apps/api/path");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const path = await join(await downloadDir(), fileName);
  await writeFile(path, bytes);
  return path;
}

/** Copies a PNG to the system clipboard. Throws if the webview refuses. */
export async function copyImageToClipboard(blob: Blob): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof ClipboardItem === "undefined"
  )
    throw new Error("The clipboard cannot hold images here");
  await navigator.clipboard.write([new ClipboardItem({ [PNG_MIME]: blob })]);
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard)
    throw new Error("The clipboard is not available here");
  await navigator.clipboard.writeText(text);
}

/** Browser: Web Share with files if supported (returns false when it is not). */
async function webShareFiles(images: RenderedImage[]): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.share) return false;
  const files = images.map(
    (i) => new File([i.blob], i.fileName, { type: PNG_MIME }),
  );
  if (navigator.canShare && !navigator.canShare({ files })) return false;
  await navigator.share({ files, title: "Daily Summary" });
  return true;
}

/** Browser: plain download through a temporary link. */
function webDownload(image: RenderedImage) {
  const url = URL.createObjectURL(image.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = image.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type ShareDeps = {
  platform: SharePlatform;
  notify: Notify;
  shareAndroid: (req: NativeShareRequest) => Promise<NativeShareResult>;
  saveAndroid: (
    bytes: Uint8Array,
    fileName: string,
    mime: string,
  ) => Promise<ExportSaveResult>;
  openAndroidFile: (
    bytes: Uint8Array,
    fileName: string,
    mime: string,
  ) => Promise<void>;
  saveDesktop: (bytes: Uint8Array, fileName: string) => Promise<string>;
  reveal: (path: string) => Promise<void>;
  copyImage: (blob: Blob) => Promise<void>;
  openUrl: (url: string) => Promise<boolean>;
  webShare: (images: RenderedImage[]) => Promise<boolean>;
  webDownload: (image: RenderedImage) => void;
};

export const defaultShareDeps = (): ShareDeps => ({
  platform: detectSharePlatform(),
  notify: sonnerNotify,
  shareAndroid: shareFileAndroid,
  saveAndroid: (bytes, fileName, mime) => saveExportFile(bytes, fileName, mime),
  openAndroidFile: openPrivateAndroidFile,
  saveDesktop: saveToDownloadsDesktop,
  reveal: revealInFolder,
  copyImage: copyImageToClipboard,
  openUrl: openExternal,
  webShare: webShareFiles,
  webDownload,
});

export type ShareContext = {
  images: RenderedImage[];
  /** Owner's WhatsApp number as typed in Settings ("" when not saved). */
  owner: string;
  /** Plain-text version of the same table, offered when the picture fails. */
  copyText?: (() => Promise<void> | void) | undefined;
  /** Opens Settings (used by the "add the owner number" toast link). */
  openSettings?: (() => void) | undefined;
};

export type ShareOutcome = {
  ok: boolean;
  /** Where the picture ended up, for tests and callers. */
  route:
    "android-share" | "desktop-clipboard" | "web-share" | "download" | "failed";
};

const describe = (e: unknown): string => {
  const t =
    typeof e === "string"
      ? e
      : e instanceof Error
        ? e.message
        : e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : "";
  return t.trim() || "The device did not say why.";
};

const toBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** Error toast that always offers the text version when we have one. */
function fail(
  deps: ShareDeps,
  ctx: ShareContext,
  title: string,
  e: unknown,
): ShareOutcome {
  const action = ctx.copyText
    ? {
        label: "Copy text instead",
        onClick: () => {
          void Promise.resolve()
            .then(() => ctx.copyText?.())
            .catch(() => undefined);
        },
      }
    : undefined;
  deps.notify.error(title, { description: describe(e), action });
  return { ok: false, route: "failed" };
}

const noOwnerToast = (deps: ShareDeps, ctx: ShareContext) =>
  deps.notify.info(TOAST_NO_OWNER, {
    action: ctx.openSettings
      ? { label: "Open Settings", onClick: ctx.openSettings }
      : undefined,
  });

/** Parts after the first cannot ride one share sheet: keep them in Downloads. */
async function keepExtraPartsAndroid(deps: ShareDeps, images: RenderedImage[]) {
  for (const extra of images.slice(1)) {
    const res = await deps.saveAndroid(
      await toBytes(extra.blob),
      extra.fileName,
      PNG_MIME,
    );
    if (!res.saved)
      throw new Error(res.error || `Could not save ${extra.fileName}`);
  }
  if (images.length > 1)
    deps.notify.info(`Part 1 of ${images.length} is in the share sheet`, {
      description: "The other parts were saved to Downloads.",
    });
}

/* ------------------------------------------------------------------ */
/* a) Send to owner                                                     */
/* ------------------------------------------------------------------ */

export async function sendToOwner(
  ctx: ShareContext,
  deps: ShareDeps = defaultShareDeps(),
): Promise<ShareOutcome> {
  const first = ctx.images[0];
  if (!first) return fail(deps, ctx, "Nothing to send", "No image was made.");
  const digits = whatsappNumber(ctx.owner);
  try {
    if (deps.platform === "android") {
      const bytes = await toBytes(first.blob);
      await deps.shareAndroid({
        fileName: first.fileName,
        mimeType: PNG_MIME,
        bytes,
        // With a saved number go straight into WhatsApp (then WhatsApp
        // Business); without one show the normal chooser.
        packages: digits ? WHATSAPP_PACKAGES : [],
        jid: digits ? `${digits}@s.whatsapp.net` : undefined,
        title: "Send Daily Summary",
      });
      await keepExtraPartsAndroid(deps, ctx.images);
      if (!digits) noOwnerToast(deps, ctx);
      deps.notify.info(TOAST_CHOOSE_OWNER);
      return { ok: true, route: "android-share" };
    }

    if (deps.platform === "desktop") {
      let savedAt = "";
      const saveNote: string[] = [];
      for (const img of ctx.images) {
        try {
          savedAt = await deps.saveDesktop(
            await toBytes(img.blob),
            img.fileName,
          );
        } catch (e) {
          saveNote.push(describe(e));
        }
      }
      try {
        await deps.copyImage(first.blob);
        deps.notify.success(TOAST_COPIED_PASTE, {
          description:
            ctx.images.length > 1
              ? `Part 1 of ${ctx.images.length} copied; every part is in Downloads.`
              : savedAt
                ? "Also saved to Downloads."
                : undefined,
        });
      } catch (e) {
        deps.notify.error("Couldn't copy the image", {
          description: savedAt
            ? `It is saved in Downloads (${first.fileName}); attach it in WhatsApp.`
            : describe(e),
          action:
            savedAt && deps.reveal
              ? {
                  label: "Show in folder",
                  onClick: () => void deps.reveal(savedAt),
                }
              : undefined,
        });
      }
      if (digits) {
        const opened = await deps.openUrl(waMeUrl(ctx.owner));
        if (opened) deps.notify.info(TOAST_CHOOSE_OWNER);
        else
          deps.notify.error("Couldn't open WhatsApp automatically", {
            description: "Open the owner's chat yourself and paste the image.",
          });
      } else {
        noOwnerToast(deps, ctx);
      }
      return { ok: true, route: "desktop-clipboard" };
    }

    // Browser / PWA
    if (await deps.webShare(ctx.images)) {
      deps.notify.info(TOAST_CHOOSE_OWNER);
      if (!digits) noOwnerToast(deps, ctx);
      return { ok: true, route: "web-share" };
    }
    ctx.images.forEach((i) => deps.webDownload(i));
    deps.notify.info("Image downloaded", {
      description: "Attach it in WhatsApp to send.",
    });
    if (!digits) noOwnerToast(deps, ctx);
    return { ok: true, route: "download" };
  } catch (e) {
    return fail(deps, ctx, "Couldn't share the image", e);
  }
}

/* ------------------------------------------------------------------ */
/* b) Download image                                                    */
/* ------------------------------------------------------------------ */

export async function downloadImage(
  ctx: ShareContext,
  deps: ShareDeps = defaultShareDeps(),
): Promise<ShareOutcome> {
  if (ctx.images.length === 0)
    return fail(deps, ctx, "Nothing to save", "No image was made.");
  try {
    if (deps.platform === "android") {
      for (const img of ctx.images) {
        const bytes = await toBytes(img.blob);
        const res = await deps.saveAndroid(bytes, img.fileName, PNG_MIME);
        if (!res.saved)
          return fail(
            deps,
            ctx,
            "Couldn't save the image",
            res.error || "The device refused the save.",
          );
        deps.notify.success(`Saved ${img.fileName}`, {
          description: "It is in your Downloads folder.",
          action: {
            label: "Open",
            onClick: () => {
              void deps
                .openAndroidFile(bytes, img.fileName, PNG_MIME)
                .catch(() =>
                  deps.notify.error("Couldn't open the image", {
                    description: "Find it in your Downloads folder.",
                  }),
                );
            },
          },
        });
      }
      return { ok: true, route: "download" };
    }
    if (deps.platform === "desktop") {
      for (const img of ctx.images) {
        const path = await deps.saveDesktop(
          await toBytes(img.blob),
          img.fileName,
        );
        deps.notify.success(`Saved ${img.fileName}`, {
          description: "It is in your Downloads folder.",
          action: {
            label: "Show in folder",
            onClick: () => void deps.reveal(path),
          },
        });
      }
      return { ok: true, route: "download" };
    }
    ctx.images.forEach((i) => deps.webDownload(i));
    deps.notify.success(`Saved ${ctx.images[0]!.fileName}`);
    return { ok: true, route: "download" };
  } catch (e) {
    return fail(deps, ctx, "Couldn't save the image", e);
  }
}

/* ------------------------------------------------------------------ */
/* c) Share... (any other app)                                          */
/* ------------------------------------------------------------------ */

export async function shareImage(
  ctx: ShareContext,
  deps: ShareDeps = defaultShareDeps(),
): Promise<ShareOutcome> {
  const first = ctx.images[0];
  if (!first) return fail(deps, ctx, "Nothing to share", "No image was made.");
  try {
    if (deps.platform === "android") {
      await deps.shareAndroid({
        fileName: first.fileName,
        mimeType: PNG_MIME,
        bytes: await toBytes(first.blob),
        packages: [],
        title: "Share Daily Summary",
      });
      await keepExtraPartsAndroid(deps, ctx.images);
      return { ok: true, route: "android-share" };
    }
    if (await deps.webShare(ctx.images))
      return { ok: true, route: "web-share" };

    // No share sheet (typical on a PC): save it and put it on the clipboard so
    // it can be pasted into Telegram, e-mail or any other app.
    if (deps.platform === "desktop") {
      let path = "";
      for (const img of ctx.images)
        path = await deps.saveDesktop(await toBytes(img.blob), img.fileName);
      let copied = true;
      try {
        await deps.copyImage(first.blob);
      } catch {
        copied = false;
      }
      deps.notify.success(
        copied
          ? "Image saved and copied - paste it into the other app"
          : `Saved ${first.fileName}`,
        {
          description: "It is in your Downloads folder.",
          action: {
            label: "Show in folder",
            onClick: () => void deps.reveal(path),
          },
        },
      );
      return { ok: true, route: "desktop-clipboard" };
    }
    ctx.images.forEach((i) => deps.webDownload(i));
    deps.notify.info("Image downloaded", {
      description: "Attach it in the app you want to share with.",
    });
    return { ok: true, route: "download" };
  } catch (e) {
    return fail(deps, ctx, "Couldn't share the image", e);
  }
}

/* ------------------------------------------------------------------ */
/* d) Copy text (fallback)                                              */
/* ------------------------------------------------------------------ */

export async function copyTableText(
  text: string,
  notify: Notify = sonnerNotify,
  write: (t: string) => Promise<void> = copyTextToClipboard,
): Promise<boolean> {
  try {
    await write(text);
    notify.success("Summary text copied", {
      description: "Paste it into any chat.",
    });
    return true;
  } catch (e) {
    notify.error("Couldn't copy the text", { description: describe(e) });
    return false;
  }
}
