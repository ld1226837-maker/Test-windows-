/**
 * Windows/desktop print path.
 *
 * Inside the Tauri shell (WebView2) the old approach — dropping the receipt
 * PDF into a hidden iframe and calling `contentWindow.print()` — does not
 * work: WebView2's built-in PDF viewer refuses a programmatic print from the
 * embedding page, so `print()` either no-ops or throws. `printReceipt` then
 * fell through to its "open the saved file" fallback, which is exactly the
 * behaviour people reported: clicking Print opened the PDF in Edge/Acrobat
 * (an external viewer) instead of showing the Windows printer dialog.
 *
 * The fix is to never ask the webview to print a PDF document. Each PDF page
 * is rasterised to a canvas with pdf.js and printed as a plain HTML page of
 * `<img>` tags at the exact page size. Printing ordinary HTML is fully
 * supported by WebView2, so `print()` opens the real Windows print dialog
 * (printer picker, copies, paper, "Microsoft Print to PDF") every time.
 *
 * Rendering happens at ~300 dpi, so thermal receipts and A4 letterheads stay
 * crisp; text is raster rather than vector, which is invisible at that
 * density on any physical printer.
 */

/** Target render density. 72 pt = 1 in, so scale = dpi / 72. */
const PRINT_DPI = 300;
const MAX_CANVAS_PX = 12_000; // guard against absurdly long roll receipts

type RenderedPage = { dataUrl: string; widthPt: number; heightPt: number };

async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist");
  // Bundled by Vite as a real asset URL (same origin), so it satisfies the
  // app's `script-src 'self'` CSP and works offline in the installed app.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;
  return pdfjs;
}

/** Rasterises every page of `bytes` at print density. */
async function renderPages(bytes: Uint8Array): Promise<RenderedPage[]> {
  const pdfjs = await loadPdfJs();
  // pdf.js takes ownership of the buffer it is handed, so pass a copy —
  // the caller still needs its bytes for the on-disk save.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages: RenderedPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        PRINT_DPI / 72,
        MAX_CANVAS_PX / Math.max(base.width, base.height),
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas is unavailable");
      // White paper behind the artwork — a PDF page has no background of its
      // own, and a transparent PNG prints as black on some drivers.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      pages.push({
        dataUrl: canvas.toDataURL("image/png"),
        widthPt: base.width,
        heightPt: base.height,
      });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  if (!pages.length) throw new Error("The receipt has no pages to print");
  return pages;
}

/** One printable HTML document holding every page image, `copies` times. */
function buildPrintDocument(pages: RenderedPage[], copies: number): string {
  const sheets: string[] = [];
  for (let copy = 0; copy < copies; copy++) {
    for (const page of pages) {
      sheets.push(
        `<div class="sheet" style="width:${page.widthPt}pt;height:${page.heightPt}pt">` +
          `<img src="${page.dataUrl}" alt="">` +
          `</div>`,
      );
    }
  }
  // A single @page size keeps the driver on the right paper. Every page this
  // app produces in one job shares its width; roll receipts also share height.
  const first = pages[0]!;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  @page { size: ${first.widthPt}pt ${first.heightPt}pt; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .sheet { page-break-after: always; break-after: page; overflow: hidden; }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  img { display: block; width: 100%; height: 100%; }
</style></head><body>${sheets.join("")}</body></html>`;
}

/**
 * Rasterises the PDF and opens the OS print dialog for it.
 * Resolves `true` once the print job has been handed to the OS, `false` if
 * the webview refused — the caller then falls back to opening the saved file.
 */
export async function printPdfBytesAsImages(
  bytes: Uint8Array,
  copies = 1,
): Promise<boolean> {
  const pages = await renderPages(bytes);
  const html = buildPrintDocument(
    pages,
    Math.max(1, Math.min(5, Math.round(copies || 1))),
  );

  return new Promise<boolean>((resolve) => {
    const frame = document.createElement("iframe");
    let finished = false;
    const finish = (printed: boolean) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      // Left in the DOM briefly: removing it while the print dialog is still
      // open cancels the job on some Windows drivers.
      window.setTimeout(() => frame.remove(), 1_000);
      resolve(printed);
    };
    const timeout = window.setTimeout(() => finish(false), 30_000);
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;left:-10000px;top:-10000px;width:800px;height:1000px;border:0";
    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        if (!win) throw new Error("Print frame is unavailable");
        win.addEventListener("afterprint", () => finish(true), { once: true });
        // Images are inline data URLs, but the layout still needs one frame
        // to settle before the print snapshot is taken.
        window.setTimeout(() => {
          try {
            win.focus();
            win.print();
            window.setTimeout(() => finish(true), 500);
          } catch {
            finish(false);
          }
        }, 100);
      } catch {
        finish(false);
      }
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}
