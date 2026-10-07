import { isAndroid } from "./desktop";

/**
 * Android's WebView only honours `getUserMedia` when the app already holds the
 * CAMERA runtime permission; the manifest entry by itself is not enough on
 * API 23+. The android-save plugin owns that prompt (`request_camera_permission`).
 *
 * Resolves `true` everywhere else, and also when the plugin command is
 * unavailable (older shell, desktop dev) so `getUserMedia` can still make the
 * final call and report its own error.
 */
export async function ensureCameraPermission(): Promise<boolean> {
  if (!isAndroid()) return true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ granted?: boolean }>(
      "plugin:android-save|request_camera_permission",
    );
    return result?.granted !== false;
  } catch {
    return true;
  }
}
