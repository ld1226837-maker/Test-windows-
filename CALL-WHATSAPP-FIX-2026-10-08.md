# Call / WhatsApp fix — 2026-10-08 (Android + Windows trees)

## Root causes (confirmed in code)
1. **Customer sheet buttons were plain `<a>` links** (`CustomerDetailDialog.tsx`): `tel:` and `target=_blank` wa.me anchors are ignored by the Tauri Android WebView / blocked by WebView2 — nothing happened on tap.
2. **Opener permission only allowed `https://wa.me/**`** (`src-tauri/capabilities/default.json`), so `tel:` could never be opened via `openExternal()` (Teams list Call button also failed) and `api.whatsapp.com` was blocked.
3. **Phone handling wasn't India-aware**: `tel:` got bare digits (no `+91`), `0`-prefixed / `+91` / landline numbers weren't normalised, no validation, and failures were silent (`openExternal` swallowed errors).
4. **Android 11+ package visibility**: no `<queries>` for tel/https/WhatsApp (`com.whatsapp`, `com.whatsapp.w4b`).

## Changes (identical in both trees)
- NEW `src/lib/phone.ts` — pure Indian-aware parser (+91, 0-prefix, 0091, spaces/dashes, hidden marks, Devanagari/Tamil digits, 6–9 mobile rule, landlines, foreign numbers kept).
- NEW `src/lib/contact.ts` — `callNumber()` / `openWhatsApp()` with toasts and fallbacks (Windows Call → copy number + "Open dialer"; any launch failure → copy number).
- `src/lib/desktop.ts` — `openExternal` handles non-http schemes, logs the real error, only falls back to `window.open` for http(s).
- `src/lib/biz.ts`, `src/lib/customer-actions.ts` — URL builders delegate to `phone.ts`.
- `CustomerDetailDialog.tsx`, `CustomerTeams.tsx`, `DashboardTab.tsx` (dues reminder) — use the shared helper.
- `capabilities/default.json` — allow `tel:*`, `sms:*`, `mailto:*`, `https://wa.me/**`, `https://wa.me/*`, `https://api.whatsapp.com/**` (Windows keeps `upi://**`).
- `plugins/android-save/.../AndroidManifest.xml` — `<queries>` for DIAL/VIEW tel, smsto, https, `com.whatsapp`, `com.whatsapp.w4b`.
- NEW `src/lib/phone.test.ts`.

## Verified here
- Phone normaliser: all India cases pass (run with tsx).
- Syntax check of edited files: clean.
- NOT run: `npm test`, `tsc`, Gradle/Tauri builds (sandbox has no npm network).

## Please run
`npm run typecheck && npm test`, then on a device:
- Android: tap Call (dialer opens with +91…), WhatsApp (opens WhatsApp / Business / browser).
- Windows installed build: Call → number copied toast; WhatsApp → browser opens wa.me → WhatsApp Desktop/Web.
If a tap still fails, check `console.error("openExternal failed…")` — it names the blocked URL.

## Known remaining
- `UpiPayDialog` uses `upi://` — Android capability file has no `upi://**` entry (Windows has). Not touched here.
- `ExpensesTab` `window.open(receipt blob)` is a separate receipt-viewer path, not Call/WhatsApp.
