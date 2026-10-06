# Fixes applied to Android-App (this also builds the Windows desktop .exe)

## 1. Broken UPI header icon (build-breaking)

`src/lib/receipt-premium.ts` imported `drawAppStrip`, `drawUpiMark`, `resolveApps`
from `./receipt-upi` — none of these exist in this project's `receipt-upi.ts`
(it only exports `drawUpiPanel` / `estimateUpiPanelHeight`, from a newer
image-based-logo refactor). This is a TypeScript compile error, and even if
bypassed, the premium A4/A5/80mm/58mm/50mm receipts would never draw the
UPI/GPay/PhonePe/Paytm/BHIM wordmarks in the header.

Fix: replaced `receipt-premium.ts` with the corrected version (ported from
the Windows-App project, which already uses the shared `drawUpiPanel` API).
Verified against this project's own `receipt-premium.test.ts`, which already
expected the new `addImage`-based wordmark behaviour.

## 2. Print button didn't work on Windows

This project's `tauri.conf.json` targets `nsis` (a Windows installer), but
`printReceipt()` on desktop only had the old hidden-iframe
`contentWindow.print()` path. WebView2 (the Windows Tauri runtime) refuses a
programmatic print of its own PDF viewer, so this silently failed or fell
back to opening an external PDF viewer instead of the Windows print dialog.

Fix: ported `src/lib/print-raster.ts` from the Windows-App project (rasterises
the PDF to images with pdf.js, then prints them as plain HTML — which
WebView2 _can_ print), and wired it into `printReceipt()` in `receipt.ts`
ahead of the old iframe path (kept as a fallback). Added `pdfjs-dist` to
`package.json`.

## 3. Housekeeping

Removed a stray `src/lib/receipt.ts.orig` backup file that had been left in
the repo.

## Recommended next step

Run `npm install && npm run build` (or `tsc --noEmit`) — this will confirm
the TypeScript compile error is gone, and running the existing test suite
(`receipt-premium.test.ts`) will confirm the UPI wordmarks render as
expected.
