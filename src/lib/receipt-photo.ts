import type { jsPDF } from "jspdf";
import { sniffImageMimeType } from "./image";
import { isRollPaper, readPrintSettings, type PrintSettings } from "./print";

/**
 * Appends a record's attached receipt photo to the END of a receipt PDF, so
 * Print / PDF / Share of an expense or an investment carries its photo after
 * the receipt itself.
 *
 * The photo page is sized to the receipt it follows rather than to a fixed
 * A4 box (the old investment-only code drew a 178 mm wide image, which ran
 * off an 80 mm thermal roll):
 *  - roll paper (thermal): same roll width, the page grows to fit the photo
 *    (capped, so a freak aspect ratio can't make a metre-long page);
 *  - sheet paper (A4/A5/Letter): same sheet size, photo scaled to fit.
 */

/** Printable gutter around the photo, in mm. */
const ROLL_MARGIN_MM = 3;
const SHEET_MARGIN_MM = 12;
/** A roll page never grows beyond this; a taller photo is scaled down. */
const MAX_ROLL_PAGE_MM = 420;

export type PhotoPlacement = {
  pageW: number;
  pageH: number;
  x: number;
  y: number;
  drawW: number;
  drawH: number;
};

/**
 * Pure layout maths for one photo page (all lengths in mm). `headerH` is the
 * room kept at the top for the "Attached receipt" caption.
 */
export function planPhotoPage(args: {
  roll: boolean;
  /** Width (and, for sheets, height) of the receipt page being followed. */
  pageW: number;
  pageH: number;
  imgW: number;
  imgH: number;
  headerH: number;
}): PhotoPlacement {
  const { roll, pageW, pageH, imgW, imgH, headerH } = args;
  const margin = roll ? ROLL_MARGIN_MM : SHEET_MARGIN_MM;
  const aspect = imgH / imgW;
  const areaW = Math.max(1, pageW - margin * 2);

  if (roll) {
    const maxDrawH = MAX_ROLL_PAGE_MM - headerH - margin * 2;
    let drawW = areaW;
    let drawH = drawW * aspect;
    if (drawH > maxDrawH) {
      drawH = maxDrawH;
      drawW = drawH / aspect;
    }
    return {
      pageW,
      pageH: headerH + drawH + margin * 2,
      x: (pageW - drawW) / 2,
      y: headerH + margin,
      drawW,
      drawH,
    };
  }

  const areaH = Math.max(1, pageH - headerH - margin * 2);
  const scale = Math.min(areaW / imgW, areaH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  return {
    pageW,
    pageH,
    x: (pageW - drawW) / 2,
    y: headerH + margin,
    drawW,
    drawH,
  };
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${mime};base64,${btoa(binary)}`;
}

async function decodeSize(
  blob: Blob,
): Promise<{ width: number; height: number; bitmap: ImageBitmap | null }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height, bitmap };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    const dims = await new Promise<{ width: number; height: number }>(
      (resolve, reject) => {
        img.onload = () =>
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () =>
          reject(new Error("The attached photo could not be decoded"));
        img.src = url;
      },
    );
    return { ...dims, bitmap: null };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** jsPDF embeds JPEG and PNG directly; anything else (WebP, GIF, HEIC the
 * webview can decode) is re-encoded to JPEG through a canvas first. */
async function toEmbeddable(
  bytes: Uint8Array,
  mime: string,
  blob: Blob,
  bitmap: ImageBitmap | null,
  width: number,
  height: number,
): Promise<{ data: string; format: "JPEG" | "PNG" }> {
  if (mime === "image/jpeg")
    return { data: bytesToDataUrl(bytes, mime), format: "JPEG" };
  if (mime === "image/png")
    return { data: bytesToDataUrl(bytes, mime), format: "PNG" };
  const source = bitmap ?? (await createImageBitmap(blob));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The attached photo could not be prepared");
  // JPEG has no alpha — paint white first so transparency doesn't go black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return { data: canvas.toDataURL("image/jpeg", 0.85), format: "JPEG" };
}

/** Thrown when the record points at a photo that isn't on this device. */
export class ReceiptPhotoUnavailableError extends Error {
  constructor() {
    super("The attached receipt photo is not available on this device");
    this.name = "ReceiptPhotoUnavailableError";
  }
}

/**
 * Reads the stored photo at `path` and adds it as the last page of `pdf`.
 * Everything that can fail (read, decode, re-encode) happens BEFORE the page
 * is added, and a failure while drawing removes the page again, so a failed
 * attempt never leaves a stray blank page behind in the printout.
 * Resolves the number of pages added (always 1).
 */
export async function appendReceiptPhotoPages(
  pdf: jsPDF,
  path: string,
  label: string,
  settings: PrintSettings = readPrintSettings(),
): Promise<number> {
  const { readReceiptBytes } = await import("./receipt-storage");
  const bytes = await readReceiptBytes(path);
  if (!bytes || bytes.length === 0) throw new ReceiptPhotoUnavailableError();

  const mime = sniffImageMimeType(bytes);
  if (!mime) throw new Error("The attached file is not a readable image");
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
  const { width, height, bitmap } = await decodeSize(blob);
  if (!(width > 0 && height > 0))
    throw new Error("The attached photo has no size");

  try {
    const { data, format } = await toEmbeddable(
      bytes,
      mime,
      blob,
      bitmap,
      width,
      height,
    );

    // Size the photo page from the receipt page it follows (the current page
    // before we add ours).
    const size = pdf.internal.pageSize;
    const roll = isRollPaper(settings.paper);
    const headerH = roll ? 6 : 10;
    const place = planPhotoPage({
      roll,
      pageW: size.getWidth(),
      pageH: size.getHeight(),
      imgW: width,
      imgH: height,
      headerH,
    });

    const before = pdf.getNumberOfPages();
    pdf.addPage(
      [place.pageW, place.pageH],
      place.pageW > place.pageH ? "l" : "p",
    );
    try {
      pdf.setTextColor(0, 0, 0);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(roll ? 7 : 11);
      const caption = pdf.splitTextToSize(
        label ? `Attached receipt - ${label}` : "Attached receipt",
        Math.max(
          10,
          place.pageW - (roll ? ROLL_MARGIN_MM : SHEET_MARGIN_MM) * 2,
        ),
      ) as string[];
      pdf.text(
        caption.slice(0, 1),
        roll ? ROLL_MARGIN_MM : SHEET_MARGIN_MM,
        (roll ? ROLL_MARGIN_MM : SHEET_MARGIN_MM) + (roll ? 2.5 : 4),
      );
      pdf.addImage(
        data,
        format,
        place.x,
        place.y,
        place.drawW,
        place.drawH,
        undefined,
        "FAST",
      );
    } catch (e) {
      if (pdf.getNumberOfPages() > before) pdf.deletePage(before + 1);
      throw e;
    }
    return 1;
  } finally {
    bitmap?.close?.();
  }
}
