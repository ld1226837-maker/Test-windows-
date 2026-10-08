/**
 * One place that places calls and opens WhatsApp chats, used by EVERY
 * section (customer sheet, teams, dues, bills…) on both the Android and the
 * Windows build.
 *
 * Why this exists: inside the Tauri WebView a plain `<a href="tel:…">` or
 * `<a target="_blank" href="https://wa.me/…">` is silently ignored (Android
 * WebView doesn't hand non-http schemes to the OS, WebView2 blocks
 * navigation), so every Call / WhatsApp button must go through the opener
 * plugin via `openExternal()` and be allowed in
 * src-tauri/capabilities/default.json (`tel:*`, `https://wa.me/**`).
 *
 * Fallbacks (nothing ever fails silently):
 *  - Invalid / missing number  -> clear toast.
 *  - Windows Call (most PCs have no tel: handler) -> copy the number and say
 *    so, with an "Open dialer" action for PCs that do have Phone Link/Teams.
 *  - Launch failure anywhere  -> copy the number and say so.
 *  - WhatsApp: https://wa.me/<91…> opens WhatsApp or WhatsApp Business on
 *    Android (chooser if both) and WhatsApp Desktop / Web on Windows.
 */
import { toast } from "sonner";
import { copyText } from "./biz";
import { isAndroid, isDesktop, openExternal } from "./desktop";
import { parsePhone, telUrl, waMeUrl, whatsappNumber } from "./phone";

export { parsePhone, telUrl, waMeUrl, whatsappNumber } from "./phone";

async function copyNumberToast(display: string, why: string) {
  const ok = await copyText(display);
  toast.info(ok ? `${why} Number ${display} copied.` : `${why} ${display}`);
}

/** Start a phone call (opens the dialer). Resolves true when launched. */
export async function callNumber(raw?: string | null): Promise<boolean> {
  const p = parsePhone(raw);
  const url = telUrl(raw);
  if (!p || !url) {
    toast.error(
      raw?.trim()
        ? "This phone number isn't valid — expected a 10-digit Indian mobile"
        : "No phone number on file for this customer",
    );
    return false;
  }
  // Windows desktop: there is usually no tel: handler, so don't pop the
  // OS "get an app" dialog — copy the number and offer to try the dialer.
  if (isDesktop() && !isAndroid()) {
    const ok = await copyText(p.display);
    toast.info(
      ok
        ? `Number ${p.display} copied — dial it from your phone`
        : `Dial ${p.display} from your phone`,
      {
        action: { label: "Open dialer", onClick: () => void openExternal(url) },
      },
    );
    return true;
  }
  const opened = await openExternal(url);
  if (!opened) {
    await copyNumberToast(p.display, "Couldn't open the dialer.");
  }
  return opened;
}

/** Open a WhatsApp chat (optionally prefilled). Resolves true when launched. */
export async function openWhatsApp(
  raw?: string | null,
  text?: string,
): Promise<boolean> {
  const p = parsePhone(raw);
  if (!p) {
    toast.error(
      raw?.trim()
        ? "This phone number isn't valid — expected a 10-digit Indian mobile"
        : "No phone number on file for this customer",
    );
    return false;
  }
  if (!whatsappNumber(raw)) {
    toast.error(`${p.display} is a landline — WhatsApp needs a mobile number`);
    return false;
  }
  const opened = await openExternal(waMeUrl(raw, text));
  if (!opened) {
    await copyNumberToast(p.display, "Couldn't open WhatsApp.");
  }
  return opened;
}
