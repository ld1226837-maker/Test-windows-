/**
 * Desktop-shell detection.
 *
 * The same codebase ships to the browser/PWA and to the Tauri desktop build.
 * `isDesktop()` is the single place that decides which one we're in, so every
 * "browser vs native" fork in the app (backup.ts, telegram-backup.ts,
 * receipt.ts, register-sw.ts) reads it from here instead of re-deriving it.
 *
 * Tauri v2 injects `window.__TAURI_INTERNALS__` into every webview at runtime
 * — that's the most reliable client-side signal (no build-time env var needed,
 * so a plain `vite build` output still runs correctly if it's ever loaded
 * inside a Tauri shell). We additionally check `window.__TAURI__` (present
 * when `app.withGlobalTauri` is enabled) as a fallback.
 */
export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w["__TAURI_INTERNALS__"] ?? w["__TAURI__"]);
}

/**
 * True inside the Android build of the Tauri shell specifically — a subset
 * of `isDesktop()`. Tauri's `__TAURI_INTERNALS__` global is injected on
 * Android too, but Android's scoped-storage rules mean several of the
 * "desktop" code paths that key off `isDesktop()` alone don't work there:
 * `saveToInvoicesFolder`'s `$DOCUMENT` fs-scope write, `tauri-plugin-dialog`'s
 * `save()` handing back a `content://` URI that `tauri-plugin-fs` can't
 * write to, and `tauri-plugin-opener`'s `openPath()` (Android only supports
 * opening URLs there, not local paths). Every call site that forks on one of
 * those needs `isDesktop() && !isAndroid()` for the "real desktop" branch and
 * an `isAndroid()` branch routed through `saveExportFile` below instead.
 *
 * No `@tauri-apps/plugin-os` dependency is installed to ask the platform
 * directly, so this reads the WebView's user-agent, which Android's system
 * WebView always includes "Android" in.
 */
export function isAndroid(): boolean {
  if (!isDesktop()) return false;
  if (typeof navigator === "undefined") return false;
  return /android/i.test(navigator.userAgent);
}

/**
 * Opens an external URL (e.g. a wa.me WhatsApp link) the right way for the
 * current shell.
 *
 * Browser/PWA: plain `window.open`.
 *
 * Desktop (Tauri v2 / WebView2): `window.open` is unreliable inside a Tauri
 * webview — depending on the platform webview it is either a no-op or spawns
 * a second, chrome-less webview window rendering the remote site inside the
 * app, which is not the intent. `@tauri-apps/plugin-opener`'s `openUrl()`
 * hands the URL to the OS default browser instead (the plugin is registered
 * in src-tauri/src/lib.rs and permitted in
 * src-tauri/capabilities/default.json, scoped to https/http links only).
 */
export async function openExternal(url: string): Promise<boolean> {
  const isWeb = /^https?:/i.test(url);
  if (!isDesktop()) {
    // Browser/PWA: tel:/sms: go through location, http(s) opens a tab.
    try {
      if (isWeb) window.open(url, "_blank", "noopener");
      else window.location.href = url;
      return true;
    } catch {
      return false;
    }
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return true;
  } catch (e) {
    // Most likely cause: the scheme isn't allowed in
    // src-tauri/capabilities/default.json (opener:allow-open-url) or no app
    // handles it. Surfaced in the console so it is diagnosable.
    console.error("openExternal failed for", url.split("?")[0], e);
    if (isWeb) {
      try {
        window.open(url, "_blank");
      } catch {
        /* nothing else we can do */
      }
    }
    return false;
  }
}

/**
 * Root folder name under Windows' Documents (and the equivalent on
 * macOS/Linux) that all of the app's user-visible desktop files live under
 * — `Documents/TurfApp/Invoices/...`, `Documents/TurfApp/Receipts/...` —
 * so everything the app writes is easy to find in Explorer instead of
 * buried in the hidden AppData folder.
 */
const APP_DOCS_FOLDER = "TurfApp";

/**
 * Which `BaseDirectory` + resolver pair backs `APP_DOCS_FOLDER` on this
 * shell. On Windows/macOS/Linux this is always the user's Documents folder
 * (matches the doc comment above — Explorer-visible, no scoped-storage
 * restrictions). On Android, `documentDir()`/`BaseDirectory.Document` is not
 * guaranteed to resolve to a writable, app-accessible location the same way
 * — Android's scoped-storage rules are the whole reason §3 of
 * docs/android-port-notes.md exists — so this falls back to the app's own
 * private storage (`BaseDirectory.AppLocalData`, no permission prompt
 * needed) if the Documents directory isn't usable. This has **not** been
 * verified on a physical Android device yet; do that before relying on it,
 * per docs/android-port-notes.md.
 *
 * Cached after the first successful resolution so every subsequent call
 * doesn't re-probe.
 */
let cachedAppDocsBase: {
  baseDir: import("@tauri-apps/plugin-fs").BaseDirectory;
  root: () => Promise<string>;
} | null = null;

async function resolveAppDocsBase() {
  if (cachedAppDocsBase) return cachedAppDocsBase;
  const { BaseDirectory } = await import("@tauri-apps/plugin-fs");
  const { documentDir, appLocalDataDir } = await import("@tauri-apps/api/path");
  if (isAndroid()) {
    // Android receipt source-of-truth is always app-private. Do not probe or
    // depend on Documents/SAF for internal receipt files: scoped-storage and
    // document-provider behaviour varies by device and can break persistence
    // after restart/update. User-visible exports use saveExportFile instead.
    cachedAppDocsBase = {
      baseDir: BaseDirectory.AppLocalData,
      root: appLocalDataDir,
    };
    return cachedAppDocsBase;
  }
  try {
    const root = await documentDir();
    cachedAppDocsBase = {
      baseDir: BaseDirectory.Document,
      root: async () => root,
    };
  } catch {
    cachedAppDocsBase = {
      baseDir: BaseDirectory.AppLocalData,
      root: appLocalDataDir,
    };
  }
  return cachedAppDocsBase;
}

/**
 * Writes bytes straight to `<AppDocsBase>/TurfApp/<relativePath>` — no
 * native Save dialog. `relativePath` may include subfolders (e.g.
 * `Receipts/2026-09-04/xxxx.jpg`); any missing parent folders are created
 * lazily, and only the ones actually needed (no folder tree is pre-created).
 * Returns the absolute path, mainly so the caller can `revealInFolder` it.
 */
export async function saveToAppDocuments(
  relativePath: string,
  bytes: Uint8Array,
): Promise<string> {
  const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
  const { join, dirname } = await import("@tauri-apps/api/path");
  const { baseDir, root } = await resolveAppDocsBase();
  const full = `${APP_DOCS_FOLDER}/${relativePath}`;
  const dir = await dirname(full);
  await mkdir(dir, { baseDir, recursive: true });
  await writeFile(full, bytes, { baseDir });
  return join(await root(), full);
}

/** Append bytes to `<AppDocsBase>/TurfApp/<relativePath>`, creating it on
 * first call (R7: streaming container sink - bounded memory at any size). */
export async function appendToAppDocument(
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
  const { dirname } = await import("@tauri-apps/api/path");
  const { baseDir } = await resolveAppDocsBase();
  const full = `${APP_DOCS_FOLDER}/${relativePath}`;
  const dir = await dirname(full);
  await mkdir(dir, { baseDir, recursive: true });
  await writeFile(full, bytes, { baseDir, append: true });
}

/** Atomically-ish moves a file inside app documents; used to publish streamed exports only after completion. */
export async function moveAppDocument(
  fromRelativePath: string,
  toRelativePath: string,
): Promise<void> {
  const { rename } = await import("@tauri-apps/plugin-fs");
  const { baseDir } = await resolveAppDocsBase();
  await rename(
    `${APP_DOCS_FOLDER}/${fromRelativePath}`,
    `${APP_DOCS_FOLDER}/${toRelativePath}`,
    {
      oldPathBaseDir: baseDir,
      newPathBaseDir: baseDir,
    },
  );
}

/** True if `<AppDocsBase>/TurfApp/<relativePath>` already exists. */
/** Internal migration/backup cleanup hook. Keeps the platform base-directory
 * resolution in one place instead of duplicating Android/Desktop rules. */
export async function getAppDocsBaseForInternalUse() {
  return resolveAppDocsBase();
}

export async function appDocumentExists(
  relativePath: string,
): Promise<boolean> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  const { baseDir } = await resolveAppDocsBase();
  return exists(`${APP_DOCS_FOLDER}/${relativePath}`, { baseDir });
}

/**
 * Deletes `<AppDocsBase>/TurfApp/<relativePath>` if it exists. A no-op
 * (never throws) when the file is already gone, so callers cleaning up an
 * orphan (e.g. `deleteReceipt` in expenses.ts) don't need to check
 * `appDocumentExists` first — deleting something that isn't there and
 * deleting something that already went away between the check and the
 * call should both just succeed.
 */
export async function removeAppDocument(relativePath: string): Promise<void> {
  const { remove } = await import("@tauri-apps/plugin-fs");
  const { baseDir } = await resolveAppDocsBase();
  const full = `${APP_DOCS_FOLDER}/${relativePath}`;
  try {
    await remove(full, { baseDir });
  } catch {
    /* already gone, or never existed — either way, the caller's goal
       ("this file shouldn't be here") is already satisfied */
  }
}

/** Absolute path for `<AppDocsBase>/TurfApp/<relativePath>`, for opening/revealing. */
export async function appDocumentAbsPath(
  relativePath: string,
): Promise<string> {
  const { join } = await import("@tauri-apps/api/path");
  const { root } = await resolveAppDocsBase();
  return join(await root(), APP_DOCS_FOLDER, relativePath);
}

/**
 * Reads the raw bytes of `<AppDocsBase>/TurfApp/<relativePath>` back out.
 * Used anywhere the app needs to re-package a file it previously wrote
 * there (e.g. `buildFullBackup` in telegram-backup.ts, packing it into the
 * Telegram archive) rather than just opening it for the person to view.
 */
export async function readAppDocument(
  relativePath: string,
): Promise<Uint8Array> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const { baseDir } = await resolveAppDocsBase();
  return readFile(`${APP_DOCS_FOLDER}/${relativePath}`, { baseDir });
}

/**
 * Section subfolders under `Invoices/`, one per part of the app that
 * produces a saved document — so a person browsing Explorer sees
 * `Invoices/Turf/…`, `Invoices/Snacks/…`, etc. instead of every bill,
 * booking, expense export and merged invoice dumped into one flat list.
 * `saveToInvoicesFolder` accepts any of these (or a plain string, for
 * forward compatibility) as its optional `section` argument.
 */
export const INVOICE_SECTIONS = {
  turf: "Turf",
  snacks: "Snacks",
  bills: "Bills",
  merged: "Merged",
  expenses: "Expenses",
  investments: "Investments",
  reports: "Reports",
  dues: "Outstanding",
} as const;

export type InvoiceSection =
  (typeof INVOICE_SECTIONS)[keyof typeof INVOICE_SECTIONS];

/**
 * Writes bytes straight to the app's shared `Invoices/` folder under
 * `<AppDocsBase>/TurfApp/`. Bill/receipt PDF downloads, print copies, and
 * Excel exports all call this so they end up in the same top-level folder
 * instead of wherever the user happened to browse to last time. When
 * `section` is given, the file lands in that named subfolder (e.g.
 * `Invoices/Turf/…`) instead of directly under `Invoices/`, so each part
 * of the app keeps its own documents together. The folder is created
 * lazily on first write. Returns the absolute path, mainly so the caller
 * can `revealInFolder` it.
 */
export async function saveToInvoicesFolder(
  bytes: Uint8Array,
  filename: string,
  section?: InvoiceSection | (string & {}),
): Promise<string> {
  return saveToAppDocuments(
    `Invoices/${section ? `${section}/` : ""}${filename}`,
    bytes,
  );
}

/**
 * Highlights a just-saved file in Windows Explorer (or the OS's file
 * manager on other desktop platforms) so the person can see where an
 * auto-saved PDF/Excel file landed, since there's no Save dialog to close
 * on top of it anymore. Best-effort — silently no-ops if unsupported,
 * which is the expected outcome on Android (no Explorer-equivalent to
 * reveal a file in — `capabilities/mobile.json` doesn't grant this
 * permission at all, so the underlying plugin call fails immediately and
 * is swallowed here).
 */
export async function revealInFolder(absPath: string): Promise<void> {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(absPath);
  } catch {
    /* best-effort only */
  }
}

/** Chunked byte→base64 encode. A plain `String.fromCharCode(...bytes)` blows
 * the call-stack argument limit on large files (multi-page PDFs, receipts
 * `.zip` archives); this stays well under it regardless of file size.
 * Exported so backup.ts can embed receipt photos inline in the single-file
 * `.db` backup (see buildBackup()/restoreBackup() there). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Inverse of `bytesToBase64`. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type ExportSaveResult = {
  saved: boolean;
  path?: string;
  /**
   * Why the save failed, in a form that can go straight into a toast
   * description. Previously every failure collapsed into a bare
   * `{ saved: false }`, so an out-of-space write, a revoked storage
   * permission and "the plugin isn't there at all" were indistinguishable
   * to the person looking at a generic "couldn't save" message.
   */
  error?: string;
};

/** Turns whatever the Tauri invoke rejected with into a readable sentence. */
export function describeSaveError(e: unknown): string {
  const raw =
    typeof e === "string"
      ? e
      : e instanceof Error
        ? e.message
        : e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e ?? "");
  const text = raw.trim();
  if (!text) return "The device refused the save and gave no reason.";
  if (/not found|unknown command|plugin/i.test(text))
    return "This device's file-saving support is unavailable.";
  if (/permission|denied/i.test(text)) return "Storage permission was denied.";
  if (/space|quota/i.test(text))
    return "Not enough free storage on the device.";
  return text;
}

/**
 * Saves an exported file (bill/report PDF, Excel workbook, backup/archive
 * `.db` or `.zip`) into the device's public Downloads folder on Android, via
 * the bundled `android-save` Tauri plugin (see
 * `src-tauri/plugins/android-save`). This exists because, on Android, both
 * of the desktop app's other save strategies fail:
 *   - `saveToInvoicesFolder`'s direct write into the `$DOCUMENT` fs scope
 *     (used by PDF/Excel exports) doesn't land anywhere the user can find —
 *     Android's scoped-storage rules don't treat that scope as public.
 *   - `tauri-plugin-dialog`'s `save()` + `tauri-plugin-fs`'s `writeFile()`
 *     (used by backup/archive exports) hands back a `content://` URI that
 *     `tauri-plugin-fs` cannot write to, silently producing a 0-byte file.
 * The native plugin instead writes through `MediaStore` (API 29+) or a
 * direct write to the public Downloads dir on older Android, which is the
 * only route that reliably works — see that plugin's own doc comment for
 * detail. On any failure (including the plugin being unavailable, which is
 * how it behaves on non-Android targets) this resolves `{ saved: false }`
 * rather than throwing, so callers can show a plain "couldn't save" message
 * instead of the misleading download/print/share flows that used to run
 * unconditionally under `isDesktop()`.
 *
 * There is no native picker involved (unlike the desktop Save-As dialog), so
 * there's no "user cancelled" outcome here — only saved or not.
 */
export async function saveExportFile(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  openAfterSave = false,
): Promise<ExportSaveResult> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ uri: string; bytesWritten: number }>(
      "plugin:android-save|save_to_downloads",
      {
        payload: {
          fileName: filename,
          mimeType,
          base64: bytesToBase64(bytes),
          openAfterSave,
        },
      },
    );
    if (!result?.bytesWritten)
      return {
        saved: false,
        error: "The file was created but nothing was written to it.",
      };
    return { saved: true, path: result.uri };
  } catch (e) {
    return { saved: false, error: describeSaveError(e) };
  }
}

export async function openPrivateAndroidFile(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<{ uri: string; bytesWritten: number }>(
    "plugin:android-save|open_private_file",
    {
      payload: {
        fileName: filename,
        mimeType,
        base64: bytesToBase64(bytes),
        openAfterSave: true,
      },
    },
  );
  if (!result?.bytesWritten)
    throw new Error("Could not open the receipt securely");
}

export type AndroidExportStream = {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<{ saved: boolean; path?: string; error?: string }>;
  abort(): Promise<void>;
};

/**
 * Android-only streaming Downloads writer. Each chunk is base64 encoded only
 * for the bridge call; the complete backup is never converted to one base64
 * string. The native plugin keeps the MediaStore item pending until finish().
 */
export async function beginAndroidExportStream(
  filename: string,
  mimeType: string,
): Promise<AndroidExportStream> {
  const { invoke } = await import("@tauri-apps/api/core");
  // Remove only our own MediaStore items that were left IS_PENDING after a
  // process death. This is deliberately best-effort and runs before each
  // stream so a crashed previous export cannot accumulate forever.
  await invoke("plugin:android-save|cleanup_pending_exports").catch(() => {});
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const result = await invoke<{ sessionId: string }>(
      "plugin:android-save|start_stream_save",
      { payload: { sessionId, fileName: filename, mimeType } },
    );
    const id = result?.sessionId || sessionId;
    let finished = false;
    return {
      write: async (chunk) => {
        if (finished)
          throw new Error("Android export stream is already closed");
        await invoke("plugin:android-save|append_stream_save", {
          payload: { sessionId: id, base64: bytesToBase64(chunk) },
        });
      },
      finish: async () => {
        if (finished)
          return {
            saved: false,
            error: "Android export stream is already closed",
          };
        finished = true;
        try {
          const r = await invoke<{
            saved?: boolean;
            path?: string | null;
            error?: string | null;
          }>("plugin:android-save|finish_stream_save", {
            payload: { sessionId: id },
          });
          // The command only resolves after the native side published the
          // file (failures reject), so a returned path means success even
          // if an older native build dropped the `saved` flag.
          const saved = r?.saved ?? Boolean(r?.path);
          return {
            saved,
            ...(r?.path ? { path: r.path } : {}),
            ...(!saved && r?.error ? { error: r.error } : {}),
          };
        } catch (e) {
          return { saved: false, error: describeSaveError(e) };
        }
      },
      abort: async () => {
        if (finished) return;
        finished = true;
        try {
          await invoke("plugin:android-save|abort_stream_save", {
            payload: { sessionId: id },
          });
        } catch {
          /* best-effort: failure here is non-fatal */
        }
      },
    };
  } catch (e) {
    throw new Error(describeSaveError(e));
  }
}

export type PrintResult = {
  printed: boolean;
  /** Readable reason the phone refused, for a toast description. */
  error?: string;
};

/**
 * Hands a generated PDF to Android's own print framework via the bundled
 * `android-save` plugin (`printPdf` → `PrintManager`), which opens the system
 * print dialog: printer picker, copies, page range, "Save as PDF", plus any
 * Wi-Fi/Bluetooth/cloud print service installed on the phone.
 *
 * This replaces the old Android print route — "write the PDF to Downloads,
 * then fire an ACTION_VIEW intent and hope a PDF viewer with a Print action
 * is installed". On newer Android, package visibility rules mean that intent
 * frequently resolves to nothing, so the Print button silently did nothing.
 * `PrintManager` is part of the OS, so it is always available.
 *
 * Never throws: on any failure (including running on a non-Android target,
 * where the plugin command doesn't exist) it resolves `{ printed: false }`
 * with a reason, so the caller can fall back to the old save-and-open route
 * instead of leaving the person with a dead button.
 */
export async function printPdfFile(
  bytes: Uint8Array,
  filename: string,
): Promise<PrintResult> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin:android-save|print_pdf", {
      payload: {
        fileName: filename,
        base64: bytesToBase64(bytes),
      },
    });
    return { printed: true };
  } catch (e) {
    return { printed: false, error: describePrintError(e) };
  }
}

/** Turns whatever the print invoke rejected with into a readable sentence. */
export function describePrintError(e: unknown): string {
  const raw =
    typeof e === "string"
      ? e
      : e instanceof Error
        ? e.message
        : e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e ?? "");
  const text = raw.trim();
  if (!text) return "The phone refused the print job and gave no reason.";
  if (/no printing support|print_service|PRINT_SERVICE/i.test(text))
    return "This phone has no printing support built in.";
  if (/not found|unknown command|plugin/i.test(text))
    return "This app build doesn't include printing support.";
  if (/empty/i.test(text)) return "There was nothing to print.";
  return text;
}
