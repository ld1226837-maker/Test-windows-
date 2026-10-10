import { jsPDF } from "jspdf";
import { courtsLabel, storedTurfAmount } from "@/lib/courts";
import { toast } from "sonner";
import {
  BUSINESS_NAME,
  billGrossTotal,
  bookingGrossTotal,
  bookingTaxable,
  snackSaleGrossTotal,
  taxLinesWithFallback,
  billPaidAmount,
  billTaxLines,
  formatDMY,
  money,
  UNIT_SHORT,
  type Bill,
} from "./biz";
import {
  isAndroid,
  isDesktop,
  openExternal,
  printPdfFile,
  revealInFolder,
  saveExportFile,
  saveToInvoicesFolder,
  type InvoiceSection,
} from "./desktop";
import { readCache } from "./data";
import { rupees } from "./money";
import { safeFilePart } from "./file-names";
import type { SnackSale, TurfBooking } from "./ops";
import {
  paperInfo,
  paperWidthMm,
  readPrintSettings,
  type PrintSettings,
} from "./print";
import { printPdfBytesAsImages } from "./print-raster";
import { buildPremiumReceiptPdf } from "./receipt-premium";
import { receiptAdvanceAmount, receiptModeLabel } from "./payments";
import { mergedBillBreakdown } from "./merge-breakdown";
import { readAppSettings } from "./settings";

/** PDF-safe money: helvetica has no rupee glyph, and receipts drop paise.
 *  Handles negative amounts (used for the "Advance paid" / "Offer" line
 *  items, which are shown as deductions) as "-Rs 500" rather than the
 *  confusing "Rs -500". */
const pmoney = (n: number, symbol = readPrintSettings().currencySymbol) => {
  const v = rupees(n);
  const sym = (symbol || "Rs").trim();
  const prefix = sym ? `${sym} ` : "";
  return (v < 0 ? "-" : "") + prefix + Math.abs(v).toLocaleString("en-IN");
};

/** jsPDF's addImage wants an explicit format string matching the data URL's
 * actual encoding — branding images may be PNG (small crisp logos/headers)
 * or JPEG (large photo-like backgrounds, kept small via lossy compression). */
const imgFormat = (dataUrl: string): "PNG" | "JPEG" =>
  dataUrl.startsWith("data:image/jpeg") ? "JPEG" : "PNG";

/** `qty` is shown in its own column on the item table when present; `sub`
 * (e.g. a rate breakdown like "1 hr x Rs 1200") still prints as a smaller
 * line under the item label either way. */
export type ReceiptLine = {
  label: string;
  sub?: string;
  amount?: number;
  qty?: number | string;
  /** Pre-formatted amount (e.g. paise-exact "Rs 1,25,000.50"); printed in
   * place of `amount` when set. */
  amountText?: string;
};
export type ReceiptTotal = { label: string; value: string; strong?: boolean };

export type ReceiptDoc = {
  kind: string;
  docNo: string;
  dateText: string;
  customer?: string | null;
  phone?: string | null;
  /** Customer email, shown in the Bill To block when the record has one. */
  email?: string | null;
  lines: ReceiptLine[];
  totals: ReceiptTotal[];
  note?: string | null;
  balanceDue?: number;
  fileName: string;
  /** Stored path of the photo attached to the record (expenses, investments).
   * When set, Print / PDF / Share append that photo as the LAST page. */
  photoPath?: string | null;
  /** Document family. Unset means a sales bill / booking / snack receipt. */
  variant?: "sales" | "expense" | "investment";
  /** Heading printed in capitals instead of `kind` ("EXPENSE VOUCHER"). */
  title?: string;
  /** Ordered label/value block. When present it replaces the Bill To / Date /
   * No. block AND the item table (expense and investment documents are not
   * sales invoices), and only the `strong` totals row is printed below it. */
  details?: ReceiptTotal[];
};

/** Line-height multipliers for the "compact / normal / relaxed" line-spacing
 * setting, applied on top of the paper's base line height. */
const LINE_SPACING_SCALE: Record<PrintSettings["lineSpacing"], number> = {
  compact: 0.85,
  normal: 1,
  relaxed: 1.2,
};

/** Text darkness for the "light / normal / dark" density setting. Lower is
 * darker (0 = pure black); mirrors a thermal printer's darkness dial. */
const DENSITY_SHADE: Record<PrintSettings["density"], number> = {
  light: 90,
  normal: 30,
  dark: 0,
};

/** Builds a receipt PDF sized for the printer selected in Settings.
 *
 * When Settings has the "premium" template style on, this first tries the
 * boxed/two-tone letterhead layout in receipt-premium.ts — it only covers
 * A4/A5/80mm/58mm/50mm paper, so any other paper (Letter, 76mm, a custom
 * roll width) silently falls through to the classic renderer below, same as
 * if "classic" had been selected. */
export function buildReceiptPdf(
  doc: ReceiptDoc,
  s: PrintSettings = readPrintSettings(),
): jsPDF {
  // The premium letterhead layouts are sales-invoice designs (Bill To card,
  // item table); voucher/statement documents use the classic renderer's
  // detail layout with the same logo/banner/shop header.
  if (s.templateStyle === "premium" && !doc.details) {
    const premium = buildPremiumReceiptPdf(doc, s);
    if (premium) return premium;
  }
  const paper = paperInfo(s.paper);
  const width = paperWidthMm(s);
  const wide = paper.kind === "sheet";
  const scale = s.fontScale || 1;
  const spacing = LINE_SPACING_SCALE[s.lineSpacing] || 1;
  const shade = DENSITY_SHADE[s.density] ?? 30;
  const lineH = (wide ? 6 : 5) * scale * spacing;

  // Full-bleed A4 background takes priority on A4 sheets — it carries the
  // header AND footer artwork, so nothing else (banner/logo/text header) is
  // drawn on top of it. Roll header artwork plays the same role for thermal
  // rolls, replacing the small square logo + text header. Plain banner stays
  // available for A5/letter sheets that don't have a matching full-page asset.
  const showBranding = s.showLogo;
  // Full-page background and roll-header artwork bake a "BILL" title into the
  // image, so they are only used for sales documents. Vouchers/statements get
  // the banner, logo or text header instead.
  const salesArtwork = !doc.details;
  const showFullBackground =
    showBranding && wide && paper.id === "a4" && !!s.background && salesArtwork;
  const showRollHeader =
    showBranding && !wide && !!s.rollHeader && salesArtwork;
  const showBanner = showBranding && wide && !!s.banner && !showFullBackground;
  const showLogo =
    showBranding &&
    !!s.logo &&
    !showBanner &&
    !showFullBackground &&
    !showRollHeader;
  const extraBrandH = !wide && showLogo ? 18 : 0;

  // 0 = automatic: 12 mm on sheets, 5 mm on rolls. Clamped so a large custom
  // margin can never eat the whole printable width. The designed A4 letterhead
  // reads better with a slightly wider gutter than the plain-text header.
  const marginX =
    s.marginMm > 0
      ? Math.min(s.marginMm, width / 3)
      : wide
        ? showFullBackground
          ? 20
          : 12
        : 5;

  // The roll-header artwork is scaled to the printable width, same inset as
  // everything else on the receipt, so its drawn height depends on the
  // paper's own width and has to be known before the page height is fixed.
  const rollHeaderMaxW = width - marginX * 2;
  const rollHeaderNaturalH =
    showRollHeader && s.rollHeader
      ? rollHeaderMaxW * (s.rollHeader.height / s.rollHeader.width)
      : 0;
  const MAX_ROLL_HEADER_HEIGHT_MM = 45;
  // Share of the roll artwork above its baked-in rule + 'BILL' title.
  const ROLL_ART_VISIBLE_FRACTION = 0.84;
  const rollHeaderH = Math.min(rollHeaderNaturalH, MAX_ROLL_HEADER_HEIGHT_MM);
  const rollHeaderDrawW =
    showRollHeader &&
    s.rollHeader &&
    rollHeaderNaturalH > MAX_ROLL_HEADER_HEIGHT_MM
      ? rollHeaderH * (s.rollHeader.width / s.rollHeader.height)
      : rollHeaderMaxW;
  // Extra blank feed at the very bottom so a thermal auto-cutter doesn't
  // slice through the last printed line. Sheets ignore this — they're cut
  // to size already.
  const cutFeedMm = wide ? 0 : Math.max(0, Math.min(40, s.cutFeedMm || 0));

  // Previously this estimated the page height up front (address line-wrap
  // guesses, a flat per-item line count, etc.) and built the PDF straight to
  // that guess. Any mismatch between the guess and what actually gets drawn
  // shows up as a permanent blank gap at the bottom of the roll — worse the
  // longer the bill, since guesses compound (a slightly-off address-wrap
  // estimate, GSTIN/FSSAI lines not being budgeted, the 0.6mm-per-row
  // rounding in every left()/row()/field()/itemRow() call, etc.). Sheet
  // paper doesn't have this problem (A4/A5/Letter are already a fixed
  // physical size), but roll paper's whole point is a page exactly as long
  // as the receipt — so instead of estimating, `renderBody` below is run
  // once on a generously tall scratch page purely to measure the real final
  // `y`, then run again on a page built to that exact measured height. Two
  // passes of the same deterministic drawing code, not two different
  // formulas, so there is nothing left to under- or over-shoot.
  const renderBody = (pdf: jsPDF, pageHeightMm: number): number => {
    let y = wide ? 16 : 10;

    // Body font sizes (doc-info block, item rows, totals) scale with the paper
    // kind the same way the header text does, so a sheet printout doesn't end
    // up with a big title sitting over cramped, thermal-sized body copy. Ratio
    // matches the header/footer scale-up (roughly 1.25x sheet vs roll).
    const bodyFont = wide ? 10 : 8;
    const noteFont = wide ? 8 : 7;

    const center = (text: string, size: number, bold = false) => {
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(size * scale);
      pdf.text(text, width / 2, y, { align: "center" });
      y += lineH;
    };
    // Centered title that wraps to multiple lines (and shrinks a little if it
    // still doesn't fit on one) instead of running off the page edges — used
    // for the shop name, which varies a lot in length.
    const centerFit = (text: string, size: number, bold = true) => {
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      const maxW = width - marginX * 2;
      let fitSize = size;
      pdf.setFontSize(fitSize * scale);
      while (fitSize > size * 0.7 && pdf.getTextWidth(text) > maxW) {
        fitSize -= 0.5;
        pdf.setFontSize(fitSize * scale);
      }
      const lines = pdf.splitTextToSize(text, maxW) as string[];
      for (const line of lines) center(line, fitSize, bold);
    };
    // Shrinks `text` (with the CURRENT font/size already applied) down to fit
    // `maxW` mm by dropping trailing characters and adding "…", instead of
    // letting it run past the printable edge or into a neighbouring column.
    // Must be called only after pdf.setFont/setFontSize for this text, since
    // getTextWidth measures against whatever font is currently active.
    const fitToWidth = (text: string, maxW: number) => {
      const safeMaxW = Math.max(4, maxW);
      if (pdf.getTextWidth(text) <= safeMaxW) return text;
      let t = text;
      while (t.length > 1 && pdf.getTextWidth(`${t}…`) > safeMaxW)
        t = t.slice(0, -1);
      return `${t}…`;
    };
    const left = (text: string, size = bodyFont, bold = false) => {
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(size * scale);
      // Every `left()` caller (the item sub-line, the note) prints across the
      // full printable width with nothing after it, so clip instead of letting
      // a long line run off the sheet/roll edge.
      pdf.text(fitToWidth(text, width - marginX * 2), marginX, y);
      y += lineH - 0.6;
    };
    const row = (l: string, r: string, bold = false) => {
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(bodyFont * scale);
      // A long label (e.g. a custom tax name) could otherwise run straight
      // into the right-aligned value — clamp it to whatever room is actually
      // left once the value's own width is measured, same guard itemRow()
      // already applies to item labels vs. the qty/amount columns.
      const rW = pdf.getTextWidth(r);
      const maxLabelW = Math.max(6, width - marginX * 2 - rW - 1.5);
      pdf.text(fitToWidth(l, maxLabelW), marginX, y);
      pdf.text(r, width - marginX, y, { align: "right" });
      y += lineH - 0.6;
    };
    const rule = () => {
      pdf.setDrawColor(120);
      pdf.line(marginX, y - 3, width - marginX, y - 3);
      y += 1.5;
    };
    // Dashed divider — used around the shop header block, matching the
    // "- - - -" break in the reference receipt template.
    const dashedRule = () => {
      pdf.setDrawColor(120);
      pdf.setLineDashPattern([wide ? 1.5 : 1, wide ? 1.2 : 0.8], 0);
      pdf.line(marginX, y - 3, width - marginX, y - 3);
      pdf.setLineDashPattern([], 0);
      y += 1.5;
    };
    // "Label : value" row with the value column starting at a fixed x, so the
    // colons line up top-to-bottom regardless of label length (helvetica isn't
    // monospaced, so padding label strings with spaces wouldn't align).
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(bodyFont * scale);
    const labelColW = Math.min(
      (width - marginX * 2) * 0.5,
      Math.max(
        wide ? 24 : 17,
        ...(doc.details
          ? doc.details.map((d) => d.label)
          : ["Bill To", "Phone", "Email", "Date", `${doc.kind} No.`]
        ).map((l) => pdf.getTextWidth(l) + 2.5),
      ),
    );
    const field = (
      label: string,
      value: string,
      size = bodyFont,
      bold = false,
    ) => {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(size * scale);
      pdf.text(label, marginX, y);
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      // Long values (a long customer name/email, or a due number like
      // "D-050926-INV-0007") previously had nothing stopping them running
      // past the paper's right edge, worst on narrow rolls — clip with an
      // ellipsis the same way every other value-drawing helper here does.
      const availW = Math.max(6, width - marginX - (marginX + labelColW));
      pdf.text(fitToWidth(`: ${value}`, availW), marginX + labelColW, y);
      y += lineH - 0.6;
    };
    // Item table columns: "#" | item (+ optional smaller sub-line) | qty | amount.
    // Measure the real quantity and amount strings before setting the columns.
    // A fixed offset works only until a larger text setting, a long quantity
    // ("12 courts"), or a large total is selected; after that it makes the
    // numeric columns overlap on thermal rolls. Every paper type now reserves
    // exactly what its own widest row needs.
    const noColW = (wide ? 9 : 7) * scale;
    const tableGap = Math.max(1.5, scale * (wide ? 1.8 : 1.2));
    const contentW = width - marginX * 2;
    const moneyText = (value: number) => pmoney(value, s.currencySymbol);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(bodyFont * scale);
    const itemQtys = [
      "QTY",
      ...doc.lines.map((line) =>
        line.qty === undefined ? "" : String(line.qty),
      ),
    ];
    const amountHeader = wide ? "AMOUNT" : "AMT";
    const itemAmounts = [
      amountHeader,
      ...doc.lines.map(
        (line) => line.amountText ?? moneyText(line.amount ?? 0),
      ),
    ];
    const widest = (values: string[]) =>
      Math.max(...values.map((value) => pdf.getTextWidth(value)));
    const qtyColW = Math.min(
      contentW * (wide ? 0.24 : 0.35),
      Math.max(7 * scale, widest(itemQtys)),
    );
    // Reserve exactly what the amount text needs. This used to be capped at
    // a fixed proportion of contentW (0.34/0.6), but on narrow rolls
    // (50/58mm) with a larger font scale or a longer currency prefix, the
    // real amount text could be wider than that proportion — fitToWidth()
    // then silently chopped digits off the end ("Rs 1,25…") instead of
    // reserving the space. Only fall back to a smaller width when there
    // truly isn't room even for the compact (amount-on-its-own-line)
    // layout below, so normal prices are never clipped.
    const amountColW = Math.min(
      Math.max(contentW - noColW - 6, 12 * scale),
      Math.max(12 * scale, widest(itemAmounts)),
    );
    const numericW = qtyColW + amountColW + tableGap;
    const normalLabelW = contentW - noColW - numericW - tableGap;
    // On a 50 mm roll with extra-large text, the four-column arrangement has
    // no readable label column. Keep the same information but place qty and
    // amount on a second, aligned line instead of allowing any overlap.
    const compactThermalTable = !wide && normalLabelW < 10 * scale;
    const itemRow = (
      no: string,
      label: string,
      qty: string,
      amount: string,
      bold = false,
    ) => {
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(bodyFont * scale);
      const amountText = fitToWidth(amount, amountColW);
      const qtyText = fitToWidth(qty, qtyColW);
      const qtyX = width - marginX - amountColW - tableGap;
      const labelMaxW = compactThermalTable
        ? Math.max(10, contentW - noColW - tableGap)
        : Math.max(6, normalLabelW);
      // Wrap the label onto up to 2 lines instead of clipping mid-text —
      // clipping used to cut booking time ranges ("06:00-07:…") in half on
      // narrow 80 mm rolls. Only a label that still overflows 2 full lines
      // falls back to the ellipsis.
      const wrapped = pdf.splitTextToSize(label, labelMaxW) as string[];
      const labelLines =
        wrapped.length <= 2
          ? wrapped
          : [
              wrapped[0] ?? "",
              fitToWidth(wrapped.slice(1).join(" "), labelMaxW),
            ];
      pdf.text(no, marginX, y);
      pdf.text(labelLines[0] ?? "", marginX + noColW, y);
      if (!compactThermalTable) {
        pdf.text(qtyText, qtyX, y, { align: "right" });
        pdf.text(amountText, width - marginX, y, { align: "right" });
      }
      y += lineH - 0.6;
      for (let li = 1; li < labelLines.length; li++) {
        pdf.text(labelLines[li] ?? "", marginX + noColW, y);
        y += lineH - 0.6;
      }
      if (compactThermalTable) {
        const compactQtyW = Math.max(
          6,
          contentW - pdf.getTextWidth(amountText) - tableGap,
        );
        pdf.text(fitToWidth(qtyText, compactQtyW), marginX, y);
        pdf.text(amountText, width - marginX, y, { align: "right" });
        y += lineH - 0.6;
      }
    };

    // Sheet-only (A5/A4/Letter) bordered item table — thermal rolls keep the
    // plain itemRow() above unchanged (bordered fills don't suit POS paper or
    // ink, and matches how real receipts look). Sheets get the header-shaded,
    // row-ruled table that invoice generators (Zoho/QuickBooks/FreshBooks/
    // Wave-style) use: right-aligned numeric columns, a tinted header row, and
    // a light zebra tint on alternating rows so long item lists stay scannable.
    // Reuses the same column geometry (noColW/qtyColW) as itemRow so the
    // header and totals block below stay aligned with the columns above them.
    const TABLE_HEADER_FILL: [number, number, number] = [223, 240, 231];
    const TABLE_HEADER_TEXT: [number, number, number] = [21, 105, 60];
    const TABLE_ZEBRA_FILL: [number, number, number] = [246, 248, 247];
    const TABLE_RULE = 205;
    const sheetItemTable = (lines: ReceiptLine[]) => {
      const qtyX = width - marginX - amountColW - tableGap;
      const labelX = marginX + noColW;
      const labelColW = Math.max(10, qtyX - qtyColW - tableGap - labelX);
      const rowLineH = lineH - 0.6;
      // Every band (the header, then each item row) is laid out the same
      // way: `topPad` mm from the band's top edge up to its first text
      // baseline, `bottomPad` mm from its last baseline down to its bottom
      // edge. Each band's bottom edge is used, unmodified, as the next
      // band's top edge (`nextBaseline` below) — so the shaded header, the
      // alternating row tints and the divider rules always stack with zero
      // gap and zero overlap, instead of being computed independently and
      // risking one band's fill painting over the previous band's rule.
      //
      // jsPDF's setFontSize is always in POINTS regardless of the document's
      // "mm" unit, so topPad/bottomPad must be derived from the real font
      // size instead of being flat constants — otherwise they silently stop
      // matching the text the moment the font size or the font-scale setting
      // changes. Helvetica's cap height is ~0.72em and its descender depth is
      // ~0.21em; converting bodyFont*scale from pt to mm (×0.3528) and adding
      // a small buffer keeps the shaded band tall enough to fully contain the
      // text at any paper/font-scale combination, instead of letting the tops
      // of capital letters (ITEM/QTY/AMOUNT, tall item names) poke out past
      // the band's edge into the rule or row above it.
      const fontMm = bodyFont * scale * 0.3528;
      const topPad = fontMm * 0.8;
      const bottomPad = fontMm * 0.4;

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(bodyFont * scale);
      // Wrap each label to at most 2 lines against the real column width
      // (rather than the full-page fitToWidth clipping itemRow uses) so a long
      // item name reads in full instead of ending in "…" whenever two short
      // lines would do.
      const rows = lines.map((it) => ({
        it,
        labelLines: (
          pdf.splitTextToSize(it.label || "", labelColW) as string[]
        ).slice(0, 2),
      }));

      // Header band.
      const headerBaseline = y;
      const headerTop = headerBaseline - topPad;
      const headerBottom = headerBaseline + bottomPad;
      pdf.setFillColor(...TABLE_HEADER_FILL);
      pdf.rect(
        marginX,
        headerTop,
        width - marginX * 2,
        headerBottom - headerTop,
        "F",
      );
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(bodyFont * scale);
      pdf.setTextColor(...TABLE_HEADER_TEXT);
      pdf.text("#", marginX + 1, headerBaseline);
      pdf.text("ITEM", labelX, headerBaseline);
      pdf.text("QTY", qtyX, headerBaseline, { align: "right" });
      pdf.text("AMOUNT", width - marginX, headerBaseline, { align: "right" });
      pdf.setTextColor(shade);
      pdf.setDrawColor(TABLE_RULE);
      pdf.line(marginX, headerBottom, width - marginX, headerBottom);

      // Baseline the next band (first item row, then each row after) will
      // draw its first line of text on.
      let nextBaseline = headerBottom + topPad;

      rows.forEach(({ it, labelLines }, i) => {
        const lineCount = Math.max(1, labelLines.length);
        const firstBaseline = nextBaseline;
        const lastLabelBaseline = firstBaseline + (lineCount - 1) * rowLineH;
        // The optional smaller "sub" line (e.g. a rate breakdown) sits closer
        // to the line above it than a full row-height gap, matching how it's
        // drawn on thermal receipts today.
        const subBaseline = it.sub ? lastLabelBaseline + rowLineH * 0.85 : null;
        const lastBaseline = subBaseline ?? lastLabelBaseline;
        const bandTop = firstBaseline - topPad;
        const bandBottom = lastBaseline + bottomPad;

        if (i % 2 === 1) {
          pdf.setFillColor(...TABLE_ZEBRA_FILL);
          pdf.rect(
            marginX,
            bandTop,
            width - marginX * 2,
            bandBottom - bandTop,
            "F",
          );
        }

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(bodyFont * scale);
        pdf.setTextColor(shade);
        pdf.text(String(i + 1), marginX + 1, firstBaseline);
        labelLines.forEach((line, li) =>
          pdf.text(line, labelX, firstBaseline + li * rowLineH),
        );
        const qty = it.qty !== undefined ? String(it.qty) : "";
        pdf.text(fitToWidth(qty, qtyColW), qtyX, firstBaseline, {
          align: "right",
        });
        pdf.text(
          fitToWidth(it.amountText ?? moneyText(it.amount ?? 0), amountColW),
          width - marginX,
          firstBaseline,
          { align: "right" },
        );
        if (it.sub && subBaseline !== null) {
          pdf.setFontSize((wide ? 9 : 7) * scale);
          pdf.text(fitToWidth(`   ${it.sub}`, labelColW), labelX, subBaseline);
          pdf.setFontSize(bodyFont * scale);
        }

        pdf.setDrawColor(TABLE_RULE);
        pdf.line(marginX, bandBottom, width - marginX, bandBottom);
        nextBaseline = bandBottom + topPad;
      });

      // Hand off exactly like itemRow's loop does: `y` left at the next fresh
      // baseline, so the caller's own `y += 1; rule();` right after this call
      // lands in the gap below the table's own closing rule instead of
      // through the last row's text.
      y = nextBaseline;
    };

    if (showFullBackground && s.background) {
      // Full-bleed: covers the entire page, corner to corner. The artwork
      // already carries the logo, business name, tagline, address, phone and
      // footer band, so everything below skips straight to the blank zone the
      // letterhead was designed to leave for the bill's own content.
      pdf.addImage(
        s.background.dataUrl,
        imgFormat(s.background.dataUrl),
        0,
        0,
        width,
        pageHeightMm,
      );
      y = s.a4ContentTopMm;
    } else if (showBanner && s.banner) {
      const maxW = width - marginX * 2;
      const maxH = 28;
      let drawW = maxW;
      let drawH = drawW * (s.banner.height / s.banner.width);
      if (drawH > maxH) {
        drawH = maxH;
        drawW = drawH * (s.banner.width / s.banner.height);
      }
      pdf.addImage(
        s.banner.dataUrl,
        imgFormat(s.banner.dataUrl),
        (width - drawW) / 2,
        y,
        drawW,
        drawH,
      );
      y += drawH + 3;
    } else if (showLogo && s.logo) {
      const drawH = wide ? 20 : 14;
      const drawW = drawH * (s.logo.width / s.logo.height);
      pdf.addImage(
        s.logo.dataUrl,
        imgFormat(s.logo.dataUrl),
        (width - drawW) / 2,
        y,
        drawW,
        drawH,
      );
      // Logo artwork (crest + wings) commonly has little internal bottom
      // padding, so give the title below it real breathing room rather than
      // the couple of mm used elsewhere.
      // The shop name below is drawn from its baseline, so its capitals rise
      // about 0.72 em above `y`. A fixed gap let them climb into the crest's
      // wings once the text-size setting was raised; derive the clearance from
      // the real name size (with a floor of the old gap) instead.
      const nameCapMm = (wide ? 16 : 12) * scale * 0.3528 * 0.72;
      y += drawH + Math.max(wide ? 6 : 4, nameCapMm + 2.5);
    } else if (showRollHeader && s.rollHeader) {
      // Same left/right inset as the rest of the receipt, not full-bleed —
      // the artwork already has its own internal padding, so this keeps it
      // flush with the item table and totals below it.
      const drawY = 3;
      // The bundled artwork bakes in a dashed rule and a 'BILL' title below
      // its contact lines. This layout prints the real document title (BOOKING /
      // PAYMENT / ...) itself, so only the top 84% of the artwork is shown
      // (same clip the premium layout uses) — otherwise every booking, payment
      // and statement printed as 'BILL'.
      const visH = rollHeaderH * ROLL_ART_VISIBLE_FRACTION;
      pdf.saveGraphicsState();
      pdf.rect(0, drawY, width, visH, null);
      pdf.clip();
      pdf.discardPath();
      pdf.addImage(
        s.rollHeader.dataUrl,
        imgFormat(s.rollHeader.dataUrl),
        (width - rollHeaderDrawW) / 2,
        drawY,
        rollHeaderDrawW,
        rollHeaderH,
      );
      pdf.restoreGraphicsState();
      // Keep a real blank band between the artwork's final small contact
      // line and the SAMPLE/BILL title below it. On 80 mm Android/WebView
      // renders the artwork's tiny glyphs can extend below their nominal
      // image box, making them visually overlap the title when the gap is
      // only 2 mm. This changes spacing only; the existing 80 mm design is
      // otherwise unchanged.
      y = drawY + visH + 3;
    }

    // The banner/full-page background/roll-header artwork already carries the
    // business name, tagline, address and phone visually — skip the redundant
    // text so the header doesn't repeat itself. GSTIN/FSSAI are dynamic (set
    // in App Settings, not baked into any artwork) so they always still print
    // when set.
    pdf.setTextColor(21, 105, 60);
    if (!showBanner && !showFullBackground && !showRollHeader)
      centerFit(
        (s.shopName || BUSINESS_NAME).toUpperCase(),
        wide ? 16 : 12,
        true,
      );
    pdf.setTextColor(shade);
    if (!showFullBackground && !showRollHeader) {
      if (s.headerLine) center(s.headerLine, wide ? 9 : 7);
      if (s.shopAddress.trim()) {
        // Wrap the address to the printable width so long addresses don't run
        // off the edge of a narrow thermal roll.
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize((wide ? 9 : 7) * scale);
        for (const line of pdf.splitTextToSize(
          s.shopAddress.trim(),
          width - marginX * 2,
        ) as string[]) {
          center(line, wide ? 9 : 7);
        }
      }
      if (s.shopPhone.trim()) center(`Ph: ${s.shopPhone.trim()}`, wide ? 9 : 7);
      if (s.shopEmail.trim()) center(s.shopEmail.trim(), wide ? 9 : 7);
    }
    const app = readAppSettings();
    // Each registration line prints only when its own toggle is on, independent
    // of the GST-on-bills toggle — a business can hold either registration
    // without charging GST on a particular sale.
    if (app.gstinEnabled && app.gstin)
      center(`GSTIN: ${app.gstin}`, wide ? 8 : 6);
    if (app.fssaiEnabled && app.fssaiNumber)
      center(`FSSAI: ${app.fssaiNumber}`, wide ? 8 : 6);
    // Thermal 80 mm headers need a real clearance zone before the BILL title.
    // A long/wrapped address plus phone/email can otherwise leave the last
    // header baseline visually touching the dashed divider/title on Android
    // WebView/PDF viewers (the font rasterizer has a larger apparent
    // descender than jsPDF's nominal line box). Keep the clearance after all
    // dynamic header rows have been emitted, so it scales with the actual
    // content rather than relying on a fixed address-line estimate.
    if (!wide && !showRollHeader) y += 4;
    y += 1;
    // The roll-header/full-background artwork already bakes in a dashed rule
    // and the "BILL"-style title, so only draw them here for the plain-text
    // header and banner cases, which don't carry a title of their own.
    if (!showFullBackground) {
      dashedRule();
      // The title's capitals rise ~0.72 em above its baseline, so a flat 1 mm
      // here left them almost touching the dashed divider (worst in phone PDF
      // viewers). Give the title real clearance below the divider.
      y += wide ? 2.5 : 2;
      centerFit((doc.title ?? doc.kind).toUpperCase(), wide ? 14 : 11, true);
      rule();
    } else {
      rule();
    }
    y += 0.5;
    if (doc.details) {
      // Voucher / statement: one ordered field block, long values wrapped
      // (not clipped) in the value column, then the amount bar.
      const valueX = marginX + labelColW;
      const valueW = Math.max(6, width - marginX - valueX);
      for (const d of doc.details) {
        pdf.setFont("helvetica", "bold");
        // The label column is capped at half the paper width, so on a narrow
        // roll with a larger text size a label such as "Statement No." was
        // wider than its column and ran into the value (the ": " vanished).
        // Shrink just that label until it fits, never below 5 pt.
        let labelPt = bodyFont * scale;
        pdf.setFontSize(labelPt);
        while (pdf.getTextWidth(d.label) > labelColW - 1.5 && labelPt > 5) {
          labelPt -= 0.25;
          pdf.setFontSize(labelPt);
        }
        pdf.text(d.label, marginX, y);
        pdf.setFontSize(bodyFont * scale);
        pdf.setFont("helvetica", d.strong ? "bold" : "normal");
        // Wrap the value on its own and draw the ": " separately, so on a
        // narrow roll the colon can never be stranded on a line by itself.
        const sepW = pdf.getTextWidth(": ");
        const wrapped = pdf.splitTextToSize(
          d.value,
          Math.max(6, valueW - sepW),
        ) as string[];
        const shown =
          wrapped.length <= 3
            ? wrapped
            : [
                wrapped[0] ?? "",
                wrapped[1] ?? "",
                fitToWidth(
                  wrapped.slice(2).join(" "),
                  Math.max(6, valueW - sepW),
                ),
              ];
        shown.forEach((line, i) => {
          pdf.text(
            i === 0 ? `: ${line}` : line,
            i === 0 ? valueX : valueX + sepW,
            y,
          );
          y += lineH - 0.6;
        });
      }
      y += 1;
      rule();
      for (const t of doc.totals) if (t.strong) row(t.label, t.value, true);
    } else {
      if (doc.customer) field("Bill To", doc.customer);
      if (doc.phone && s.showPhone) field("Phone", doc.phone);
      if (doc.email) field("Email", doc.email);
      field("Date", doc.dateText);
      field(`${doc.kind} No.`, doc.docNo);
      y += 1;
      rule();
      if (wide) {
        // A5/A4/Letter: bordered, header-shaded table (see sheetItemTable above).
        y += 1;
        sheetItemTable(doc.lines);
      } else {
        // Thermal rolls: plain ruled columns, unchanged from before.
        itemRow("#", "ITEM", "QTY", amountHeader, true);
        y += 1;
        doc.lines.forEach((it, i) => {
          itemRow(
            String(i + 1),
            it.label,
            it.qty !== undefined ? String(it.qty) : "",
            it.amountText ?? pmoney(it.amount ?? 0, s.currencySymbol),
          );
          if (it.sub) left(`   ${it.sub}`, wide ? 9 : 7, false);
        });
      }
      y += 1;
      rule();
      // Status reads in capitals on every document type (bills store it in
      // lower case, bookings in title case), matching the premium badge.
      for (const t of doc.totals)
        row(
          t.label,
          t.label === "Status" ? t.value.toUpperCase() : t.value,
          t.strong,
        );
    }
    if (doc.note) {
      y += 1;
      left(`Note: ${doc.note}`, noteFont);
    }
    y += 2;
    // The full-page background's own footer band (address/phone/location,
    // baked into the artwork ~271mm down the A4 page) would collide with a
    // second footer line drawn in the default text color, so it's skipped
    // there; the roll-header case has plain paper below it and is unaffected.
    if (!showFullBackground) {
      rule();
      if (s.footerLine && !doc.details) center(s.footerLine, wide ? 10 : 8);
    }
    if (cutFeedMm) y += cutFeedMm;
    return y;
  };

  if (wide) {
    // Sheets (A5/A4/Letter) are already a fixed physical page size.
    const height = paper.heightMm!;
    const pdf = new jsPDF({ unit: "mm", format: [width, height] });
    renderBody(pdf, height);
    return pdf;
  }

  // Roll paper: draw once on a generously tall scratch page purely to
  // measure the real final y, then draw again on a page built to exactly
  // that height. See the comment above renderBody for why this replaced an
  // upfront size estimate.
  const SCRATCH_HEIGHT_MM = 3000; // comfortably taller than any realistic bill
  const scratchPdf = new jsPDF({
    unit: "mm",
    format: [width, SCRATCH_HEIGHT_MM],
  });
  const measuredY = renderBody(scratchPdf, SCRATCH_HEIGHT_MM);
  // Small trailing buffer so the last rule/text's descenders aren't flush
  // with the physical paper edge — independent of, and on top of, whatever
  // cutFeedMm the user configured for their auto-cutter (already folded
  // into measuredY above).
  const BOTTOM_SAFETY_MM = 2;
  const height = measuredY + BOTTOM_SAFETY_MM;
  const pdf = new jsPDF({ unit: "mm", format: [width, height] });
  renderBody(pdf, height);
  return pdf;
}

/**
 * `buildReceiptPdf` plus, when the record has an attached photo
 * (`doc.photoPath` — expenses and investments), that photo as the last
 * page(s). Every Print / PDF / Share path builds its PDF through this so the
 * photo always follows the receipt.
 *
 * A photo that can't be read must not stop the receipt itself from printing
 * or sharing, so by default that case warns and carries on without it;
 * `strict` makes it throw instead (used by the explicit "PDF" export, which
 * promises the photo is in the file).
 */
export async function buildReceiptPdfWithPhoto(
  doc: ReceiptDoc,
  s: PrintSettings = readPrintSettings(),
  opts: { strict?: boolean } = {},
): Promise<jsPDF> {
  const pdf = buildReceiptPdf(doc, s);
  if (!doc.photoPath) return pdf;
  try {
    const { appendReceiptPhotoPages } = await import("./receipt-photo");
    await appendReceiptPhotoPages(pdf, doc.photoPath, doc.docNo, s);
  } catch (e) {
    if (opts.strict) throw e;
    toast.warning("Receipt photo not added", {
      description: `${e instanceof Error ? e.message : String(e)} The receipt itself is unaffected.`,
    });
  }
  return pdf;
}

/**
 * Saves the receipt PDF. In the browser/PWA this is jsPDF's own Blob-download
 * `save()`. In the desktop shell it writes straight into the app's shared
 * `Invoices/` folder (see `saveToInvoicesFolder` in desktop.ts) and reveals
 * the file in Explorer — no Save dialog, so every bill PDF lands in one
 * predictable place instead of scattered across whatever folder the user
 * last browsed to. Kept async so both branches share one call site;
 * existing unawaited callers (`downloadBillPdf`, print/share fallbacks below)
 * keep working unchanged.
 *
 * Returns `false` when the save genuinely failed (currently only reachable
 * on Android, via `saveExportFile`) so callers can skip a false-positive
 * "saved"/"shared" message instead of always assuming success.
 */
export async function downloadReceipt(
  doc: ReceiptDoc,
  s: PrintSettings = readPrintSettings(),
  section?: InvoiceSection,
): Promise<boolean> {
  const pdf = await buildReceiptPdfWithPhoto(doc, s);

  // Checked before the generic isDesktop() branch: Android satisfies
  // isDesktop() too, but the $DOCUMENT fs-scope write below isn't reliably
  // visible to the user there (see saveExportFile's doc comment).
  if (isAndroid()) {
    const bytes = pdf.output("arraybuffer") as ArrayBuffer;
    const result = await saveExportFile(
      new Uint8Array(bytes),
      `${doc.fileName}.pdf`,
      "application/pdf",
    );
    if (result.saved) {
      toast.success("PDF saved to Downloads", {
        description: `${doc.fileName}.pdf`,
      });
    } else {
      toast.error("Couldn't save PDF", {
        description: result.error ?? `${doc.fileName}.pdf`,
      });
    }
    return result.saved;
  }

  if (isDesktop()) {
    const bytes = pdf.output("arraybuffer") as ArrayBuffer;
    const abs = await saveToInvoicesFolder(
      new Uint8Array(bytes),
      `${doc.fileName}.pdf`,
      section,
    );
    await revealInFolder(abs);
    toast.success("PDF saved", { description: `${doc.fileName}.pdf` });
    return true;
  }
  pdf.save(`${doc.fileName}.pdf`);
  toast.success("PDF downloaded", { description: `${doc.fileName}.pdf` });
  return true;
}

/**
 * Opens a receipt for a visual layout check without starting a print job.
 * Android WebView cannot reliably open a blob URL in a new tab, so use the
 * native PDF viewer there. The viewer also gives the person a dependable
 * fallback route to Print or Share the generated receipt.
 */
export async function previewReceipt(
  doc: ReceiptDoc,
  s: PrintSettings = readPrintSettings(),
): Promise<boolean> {
  const pdf = await buildReceiptPdfWithPhoto(doc, s);

  if (isAndroid()) {
    const bytes = pdf.output("arraybuffer") as ArrayBuffer;
    const result = await saveExportFile(
      new Uint8Array(bytes),
      `${doc.fileName}.pdf`,
      "application/pdf",
      true,
    );
    if (result.saved) {
      toast.success("Preview opened", {
        description: "The receipt PDF was saved to Downloads.",
      });
    } else {
      toast.error("Couldn't open preview", {
        description: result.error ?? `${doc.fileName}.pdf`,
      });
    }
    return result.saved;
  }

  const url = pdf.output("bloburl") as unknown as string;
  const preview = window.open(url, "_blank", "noopener");
  if (!preview) {
    toast.error("Couldn't open preview", {
      description: "Allow pop-ups for the app, then try again.",
    });
    return false;
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** Prints one loaded PDF frame and removes it before the next copy starts. */
function printPdfFrame(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    let finished = false;
    const finish = (printed: boolean) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(loadTimeout);
      frame.remove();
      resolve(printed);
    };
    const loadTimeout = window.setTimeout(() => finish(false), 20_000);
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.onload = () => {
      try {
        const printWindow = frame.contentWindow;
        if (!printWindow) throw new Error("Print frame is unavailable");
        printWindow.addEventListener("afterprint", () => finish(true), {
          once: true,
        });
        printWindow.focus();
        printWindow.print();
        // Some embedded PDF viewers omit afterprint; returning from print()
        // means the native pipeline has accepted the job.
        window.setTimeout(() => finish(true), 250);
      } catch {
        finish(false);
      }
    };
    frame.src = url;
    document.body.appendChild(frame);
  });
}

/**
 * Opens the print dialog with the receipt, honouring the copies setting.
 *
 * Android cannot print a PDF from a hidden WebView iframe: calling
 * `contentWindow.print()` there is a no-op on many Android System WebView
 * versions. Every in-app receipt button reaches this function, so route that
 * platform through Android's own print framework instead (`printPdfFile` →
 * the `android-save` plugin's `PrintManager` command), which opens the system
 * print dialog: printer picker, copies, page range, "Save as PDF", and any
 * Wi-Fi/Bluetooth/cloud print service on the phone.
 *
 * That replaced the previous Android route — save the PDF to Downloads and
 * fire an ACTION_VIEW intent at whatever PDF viewer is installed — which on
 * newer Android often resolved to nothing, so the button appeared dead. That
 * route is kept as the fallback for the rare case where the print dialog
 * itself can't be opened, with the reason surfaced in the toast rather than
 * failing quietly.
 *
 * Unmodified for the desktop build: Tauri's Windows runtime is WebView2
 * (full Chromium/Edge engine), so `contentWindow.print()` on the hidden
 * iframe below opens the same native Windows print dialog it would in any
 * browser — and that dialog lists whatever printer the OS has a driver for,
 * which for most thermal/POS receipt printers on Windows is the normal way
 * they're used (they register as a standard Windows print queue). This is
 * the "no live backend needed" case from windows-app-build-prompt.md §1 —
 * no plugin required. STILL NEEDS VERIFICATION ON REAL HARDWARE — see the
 * "still open" section of the port report; this file was not tested against
 * a physical thermal printer.
 */
export async function printReceipt(
  doc: ReceiptDoc,
  s: PrintSettings = readPrintSettings(),
  section?: InvoiceSection,
) {
  const pdf = await buildReceiptPdfWithPhoto(doc, s);

  if (isAndroid()) {
    const bytes = new Uint8Array(pdf.output("arraybuffer") as ArrayBuffer);
    const printResult = await printPdfFile(bytes, `${doc.fileName}.pdf`);
    if (printResult.printed) {
      toast.success("Print dialog opened", {
        description: "Pick your printer, copies and page range there.",
      });
      return;
    }

    // The phone refused to open its print dialog — fall back to the older
    // route (save the PDF to Downloads and open it in a viewer, whose own
    // Print action can still reach the printer), and say why.
    const saveResult = await saveExportFile(
      bytes,
      `${doc.fileName}.pdf`,
      "application/pdf",
      true,
    );
    if (saveResult.saved) {
      toast.success("Receipt saved and opened instead", {
        description: `${printResult.error ?? "The print dialog wouldn't open."} Use Print in the PDF viewer.`,
      });
    } else {
      toast.error("Couldn't print the receipt", {
        description:
          printResult.error ?? saveResult.error ?? `${doc.fileName}.pdf`,
      });
    }
    return;
  }

  const url = pdf.output("bloburl") as unknown as string;

  // Desktop: also drop a copy in the same Invoices/ folder that Download
  // and Excel exports use, so a printed bill is still on disk afterward —
  // fire-and-forget, doesn't hold up the print dialog below. Skipped on
  // Android: that $DOCUMENT fs-scope write isn't reliable there (same
  // reasoning as downloadReceipt above), and printing shouldn't silently
  // attempt — and fail — a save the person didn't ask for. Sharing/
  // downloading the receipt already covers "get a copy on Android".
  if (isDesktop()) {
    const bytes = pdf.output("arraybuffer") as ArrayBuffer;
    void saveToInvoicesFolder(
      new Uint8Array(bytes),
      `${doc.fileName}.pdf`,
      section,
    );
  }

  // "Preview before print": open the PDF in a normal tab so the person can
  // check the layout and pick their printer from the browser's own dialog,
  // instead of jumping straight into a hidden-iframe silent print.
  if (s.previewBeforePrint) {
    const preview = window.open(url, "_blank", "noopener");
    if (!preview) {
      toast.error("Couldn't open print preview", {
        description: "Allow pop-ups for the app, then try again.",
      });
      URL.revokeObjectURL(url);
      return;
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const copies = Math.max(1, Math.min(5, Math.round(s.copies || 1)));
  let printed = true;

  // Desktop (Tauri/WebView2): WebView2's built-in PDF viewer refuses a
  // programmatic print, so the hidden-PDF-iframe route below never reaches a
  // printer there — it silently fell through to "open the saved PDF", which
  // is why Print on Windows was opening an external PDF viewer instead of the
  // printer dialog. Rasterising the pages and printing them as plain HTML
  // uses the webview's ordinary print pipeline, which does show the real
  // Windows print dialog. Falls through to the old iframe path below if it
  // can't run (isAndroid() already returned earlier, so this is real desktop
  // only).
  if (isDesktop()) {
    try {
      printed = await printPdfBytesAsImages(
        new Uint8Array(pdf.output("arraybuffer") as ArrayBuffer),
        copies,
      );
    } catch (err) {
      console.error(
        "Raster print failed, falling back to legacy print path:",
        err,
      );
      printed = false;
    }
    if (printed) {
      URL.revokeObjectURL(url);
      return;
    }
  }

  for (let i = 0; i < copies; i++) {
    printed = await printPdfFrame(url);
    if (!printed) break;
  }
  if (!printed) {
    const preview = window.open(url, "_blank", "noopener");
    if (!preview) toast.error("Couldn't open receipt for printing");
    else window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  URL.revokeObjectURL(url);
}

export async function shareReceipt(
  doc: ReceiptDoc,
  fallbackUrl: string,
  s: PrintSettings = readPrintSettings(),
  section?: InvoiceSection,
) {
  const blob = (await buildReceiptPdfWithPhoto(doc, s)).output("blob");
  const file = new File([blob], `${doc.fileName}.pdf`, {
    type: "application/pdf",
  });
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  // Desktop (Tauri/WebView2, excluding Android — see below): the Web Share
  // API is not implemented in WebView2 at all, so `nav.canShare`/`nav.share`
  // are undefined and the branch below would never run anyway. More
  // importantly, the fallback's `window.open()` cannot be relied on inside a
  // Tauri webview: it either does nothing or tries to open a second webview
  // window pointed at wa.me, which is not what "share on WhatsApp" should do
  // on a desktop. So on real desktop we skip the Web Share attempt entirely,
  // save the PDF via the native dialog, and hand the WhatsApp URL to the OS
  // default browser through the opener plugin.
  //
  // Android is deliberately excluded from this branch even though it also
  // satisfies isDesktop(): Android's system WebView does implement the Web
  // Share API (including file attachments) via the OS share sheet, so it
  // should get the same "shared"/"cancelled" attempt as the browser build
  // below rather than being routed into a desktop-only save+openExternal
  // flow that used to unconditionally report "fallback" even when nothing
  // was actually attached.
  if (isDesktop() && !isAndroid()) {
    await downloadReceipt(doc, s, section);
    await openExternal(fallbackUrl);
    return "fallback";
  }
  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({
        files: [file],
        title: `${BUSINESS_NAME} ${doc.docNo}`,
      });
      return "shared";
    } catch {
      return "cancelled";
    }
  }
  // Android without Web Share support (or the user's default share sheet
  // has nothing that accepts the file): save to Downloads first so there's
  // something to attach, and don't open WhatsApp if that save failed.
  if (isAndroid()) {
    const saved = await downloadReceipt(doc, s, section);
    if (!saved) return "cancelled";
    await openExternal(fallbackUrl);
    return "fallback";
  }
  downloadReceipt(doc, s, section);
  await openExternal(fallbackUrl);
  return "fallback";
}

/* ---------- document builders ---------- */

export { safeFilePart };

export function billReceipt(bill: Bill): ReceiptDoc {
  // Printed from the bill's own frozen tax snapshot, never recomputed at
  // print time, so a reprint after a rate change is byte-identical to the
  // copy the customer first received.
  const taxLines = billTaxLines(bill);
  const grandTotal = billGrossTotal(bill);
  const taxAmount = grandTotal - rupees(bill.total);
  const paid = billPaidAmount(bill);
  const due = Math.max(0, grandTotal - paid);
  const merged = mergedBillBreakdown({
    breakdown: bill.merged_breakdown,
    paid,
    grandTotal,
    itemCount: bill.items.length,
  });
  // Narrow thermal rolls get the abbreviated unit ("2.5 L" instead of
  // "2.5 litre") in the QTY column so the value never has to be clipped with
  // an ellipsis to fit. Sheets (A4/A5/Letter) have plenty of column width and
  // keep the full unit name.
  const wide = paperInfo(readPrintSettings().paper).kind === "sheet";
  return {
    kind: "Bill",
    docNo: bill.invoice_no,
    dateText: formatDMY(bill.bill_date),
    customer: bill.customer_name,
    phone: bill.customer_phone,
    lines: merged
      ? [
          // Merged bill with a stored breakdown: turf line(s), then each snack
          // bill's items under a "Snacks" label, then offer, turf advance and
          // snacks paid. Display only — same grand total / paid / balance.
          ...merged.groups.flatMap((g) =>
            bill.items.slice(g.start, g.end).map((it) => ({
              label:
                g.kind === "snack"
                  ? `Snacks \u2014 ${it.item || "Item"}`
                  : it.item || "Item",
              sub:
                g.kind === "snack" && g.bill_no
                  ? `${g.bill_no} \u00b7 ${it.qty} ${it.unit ?? "kg"} x ${pmoney(it.rate)}`
                  : `${it.qty} ${it.unit ?? "kg"} x ${pmoney(it.rate)}`,
              qty: `${it.qty} ${it.unit ?? "kg"}`,
              amount: it.total,
            })),
          ),
          ...(bill.discount
            ? [{ label: "Offer / Discount", amount: -bill.discount }]
            : []),
          ...(merged.advancePaid > 0
            ? [{ label: "Advance paid", amount: -merged.advancePaid }]
            : []),
          ...(merged.snacksPaid > 0
            ? [{ label: "Snacks paid", amount: -merged.snacksPaid }]
            : []),
        ]
      : [
          ...bill.items.map((it) => ({
            label: it.item || "Item",
            sub: `${it.qty} ${it.unit ?? "kg"} x ${pmoney(it.rate)}`,
            qty: `${it.qty} ${it.unit ?? "kg"}`,
            amount: it.total,
          })),
          // Itemized alongside the products, in addition to the totals block
          // below, so offer/advance show as line entries on the printed bill.
          ...(bill.discount
            ? [{ label: "Offer / Discount", amount: -bill.discount }]
            : []),
          ...(paid
            ? [
                {
                  label: "Advance paid",
                  // Display only: the advance actually entered, not the running
                  // paid total (which becomes the full amount once settled).
                  amount: -Math.min(
                    paid,
                    receiptAdvanceAmount("bill", bill.id, paid),
                  ),
                },
              ]
            : []),
        ],
    totals: [
      { label: "Subtotal", value: pmoney(bill.subtotal) },
      ...(bill.discount
        ? [{ label: "Discount", value: "-" + pmoney(bill.discount) }]
        : []),
      // Every switched-on tax (GST plus any custom tax) is added on top of
      // the bill here — a tax that's off contributes nothing and doesn't
      // appear at all; switching one on adds its amount to the grand total.
      // GST keeps its conventional CGST/SGST split; each custom tax prints
      // as its own named line.
      ...(taxAmount > 0
        ? [
            { label: "Taxable Amount", value: pmoney(bill.total) },
            ...taxLines.map((l) => ({
              label: l.label,
              value: pmoney(l.value),
            })),
          ]
        : []),
      { label: "GRAND TOTAL", value: pmoney(grandTotal), strong: true },
      { label: "Paid", value: pmoney(paid) },
      ...(due > 0 ? [{ label: "Balance due", value: pmoney(due) }] : []),
      ...(bill.payment_mode
        ? [{ label: "Mode", value: bill.payment_mode }]
        : []),
      { label: "Status", value: bill.status.toUpperCase() },
    ],
    balanceDue: due,
    fileName: `${safeFilePart(bill.invoice_no)}-${safeFilePart(bill.customer_name, "customer")}`,
  };
}

/** "1 hr 30 min" from fractional hours. */
const durationText = (hours: number) => {
  const mins = Math.round((Number(hours) || 0) * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h} hr ${m} min`;
  if (h > 0) return `${h} hr`;
  return `${m} min`;
};

export function bookingReceipt(b: TurfBooking): ReceiptDoc {
  const courts = b.courts ?? 1;
  const snacks = b.snacks ?? [];
  const snacksTotal = b.snacks_total ?? 0;
  // Legacy rows saved a zero turf_amount — rebuilt by the shared court rule.
  const turfAmount = storedTurfAmount(b);
  // GRAND TOTAL is derived from the same Turf + Snacks − Discount figure
  // printed just above it, instead of trusting `b.total_amount` blindly.
  // `total_amount` is normally created exactly this way (see TurfTab's
  // submit handler), but `snacks_total` can in principle be non-zero on a
  // row that predates that guarantee (an imported/restored booking, or a
  // future feature that populates it) — trusting `total_amount` alone in
  // that case would print a Grand Total that doesn't match the Turf/Snacks/
  // Discount lines right above it, and a Balance Due computed off the wrong
  // figure. Recomputing here keeps every printed number self-consistent.
  const taxable = bookingTaxable(b);
  // Tax applies wherever GST is switched on (Settings), not only on formal
  // Bills — and it comes from the booking's own frozen snapshot, so a reprint
  // after a rate change matches the customer's copy.
  const taxLines = taxLinesWithFallback(taxable, b);
  const grandTotal = bookingGrossTotal(b);
  const taxAmount = grandTotal - taxable;
  const due = Math.max(0, rupees(grandTotal - b.advance_paid));
  const timeText =
    b.start_time && b.end_time ? ` ${b.start_time}-${b.end_time}` : "";
  // Same narrow-roll rationale as billReceipt: abbreviate on thermal paper so
  // the QTY column never has to ellipsis-clip the value.
  const wide = paperInfo(readPrintSettings().paper).kind === "sheet";
  // Which named court(s) the booking holds — only worth printing when the
  // venue has more than one. Names come from the cached Settings value, so
  // every caller gets the current names without passing them in.
  const venue = readCache<{ total_courts?: number; court_names?: string[] }>(
    "slot_durations",
    {},
  );
  const courtText =
    (venue.total_courts ?? 1) > 1 && (b.court_ids?.length ?? 0) > 0
      ? courtsLabel(b.court_ids, venue.court_names)
      : "";
  return {
    kind: "Booking",
    docNo: b.booking_no,
    dateText: formatDMY(b.booking_date),
    customer: b.customer_name,
    phone: b.phone,
    lines: [
      {
        label: `${b.slot_name} slot${timeText}`,
        sub: courtText
          ? `${durationText(b.hours)} · ${courtText}`
          : durationText(b.hours),
        qty: wide ? `${courts} court${courts > 1 ? "s" : ""}` : `${courts} crt`,
        amount: turfAmount,
      },
      ...snacks.map((it) => ({
        label: it.item_name,
        sub: `x ${pmoney(it.unit_price)}`,
        qty: it.qty,
        amount: it.amount,
      })),
      // Offer/discount and advance paid are itemized here too (not just in
      // the totals block below) so they're visible as line-by-line entries
      // on the printed receipt, matching how turf/snack items are shown.
      ...(b.discount
        ? [{ label: "Offer / Discount", amount: -b.discount }]
        : []),
      ...(b.advance_paid
        ? [
            {
              label: "Advance paid",
              // Display only: the advance actually entered, not the running
              // paid total.
              amount: -Math.min(
                b.advance_paid,
                receiptAdvanceAmount("turf_booking", b.id, b.advance_paid),
              ),
            },
          ]
        : []),
    ],
    totals: [
      { label: "Turf", value: pmoney(turfAmount) },
      ...(snacksTotal ? [{ label: "Snacks", value: pmoney(snacksTotal) }] : []),
      ...(b.discount
        ? [{ label: "Discount", value: "-" + pmoney(b.discount) }]
        : []),
      ...(taxAmount > 0
        ? [
            { label: "Taxable Amount", value: pmoney(taxable) },
            ...taxLines.map((l) => ({
              label: l.label,
              value: pmoney(l.value),
            })),
          ]
        : []),
      { label: "GRAND TOTAL", value: pmoney(grandTotal), strong: true },
      { label: "Paid", value: pmoney(b.advance_paid) },
      ...(due ? [{ label: "Balance due", value: pmoney(due) }] : []),
      {
        label: "Mode",
        value: receiptModeLabel("turf_booking", b.id, b.payment_mode),
      },
      { label: "Status", value: b.status },
    ],
    note: b.notes,
    balanceDue: due,
    fileName: `${safeFilePart(b.booking_no)}-${safeFilePart(b.customer_name, "customer")}`,
  };
}

export function snackSaleReceipt(s: SnackSale): ReceiptDoc {
  const taxLines = taxLinesWithFallback(s.total, s);
  const grandTotal = snackSaleGrossTotal(s);
  const taxAmount = grandTotal - rupees(s.total);
  return {
    kind: "Bill",
    docNo: s.bill_no,
    dateText: formatDMY(s.sale_date),
    customer: s.customer_name,
    lines: s.items.map((it) => ({
      label: it.item_name,
      sub: `x ${pmoney(it.unit_price)}`,
      qty: it.qty,
      amount: it.amount,
    })),
    totals: [
      ...(taxAmount > 0
        ? [
            { label: "Taxable Amount", value: pmoney(s.total) },
            ...taxLines.map((l) => ({
              label: l.label,
              value: pmoney(l.value),
            })),
          ]
        : []),
      { label: "GRAND TOTAL", value: pmoney(grandTotal), strong: true },
      {
        label: "Mode",
        value: receiptModeLabel("snack_sale", s.id, s.payment_mode),
      },
      ...(s.booking_no
        ? [{ label: "Linked booking", value: s.booking_no }]
        : []),
      ...(s.cancelled
        ? [{ label: "Status", value: "CANCELLED" }]
        : s.payment_mode === "On tab"
          ? [
              { label: "Paid", value: pmoney(0) },
              { label: "Balance due", value: pmoney(grandTotal) },
              { label: "Status", value: "UNPAID" },
            ]
          : [
              { label: "Paid", value: pmoney(grandTotal) },
              { label: "Status", value: "PAID" },
            ]),
    ],
    note: s.notes,
    balanceDue: !s.cancelled && s.payment_mode === "On tab" ? grandTotal : 0,
    fileName: `${safeFilePart(s.bill_no)}-snacks`,
  };
}

/** Compact `PREFIX-YYYYMMDD-HHMMSS` doc number (same date order as INV-/TB- numbers) for receipts that aren't tied
 * to a stored record with its own invoice/booking/bill number — a payment
 * collection or a customer statement is generated at print time, not saved,
 * so there's no natural id to reuse. Includes time-of-day (not just date)
 * so two same-day payments against the same customer don't share a docNo. */
const generatedDocNo = (prefix: string, d = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
};

/** Receipt for a payment collected against a customer's outstanding
 * balance — either one line/booking's due (Customer detail dialog's
 * per-line "Collect") or the whole balance at once (`useSettleCustomer`'s
 * "Settle all"). Unlike `billReceipt`/`bookingReceipt`, there's no single
 * stored record this prints from: `against` names what the payment covers
 * in plain text (e.g. "Booking TB-0012", "Full balance") and `balanceAfter`
 * is what's left once this payment lands. */
export function paymentReceipt(p: {
  customer: string;
  phone?: string | null;
  against: string;
  amount: number;
  mode: string;
  balanceAfter: number;
}): ReceiptDoc {
  const now = new Date();
  const docNo = generatedDocNo("PAY", now);
  return {
    kind: "Payment",
    docNo,
    dateText: formatDMY(now.toISOString()),
    customer: p.customer,
    phone: p.phone ?? null,
    lines: [{ label: p.against, amount: p.amount }],
    totals: [
      { label: "Amount received", value: pmoney(p.amount), strong: true },
      { label: "Mode", value: p.mode },
      { label: "Balance remaining", value: pmoney(p.balanceAfter) },
    ],
    fileName: `${docNo}-${safeFilePart(p.customer, "customer")}`,
  };
}

/** Full account-statement receipt for one customer — every bill, booking,
 * and snack-sale line together (already merged and date-sorted by the
 * caller) plus running totals, for the Customer detail dialog's "Print
 * statement" action. Each line's `sub` carries the original date and status
 * since a statement, unlike a single bill, spans many dates at once. */
export function customerStatementReceipt(p: {
  customer: string;
  phone?: string | null;
  lines: { label: string; date: string; amount: number; status: string }[];
  totalSpent: number;
  totalPaid: number;
  totalOutstanding: number;
}): ReceiptDoc {
  const now = new Date();
  const docNo = generatedDocNo("STMT", now);
  return {
    kind: "Statement",
    docNo,
    dateText: formatDMY(now.toISOString()),
    customer: p.customer,
    phone: p.phone ?? null,
    lines: p.lines.map((l) => ({
      label: l.label,
      sub: `${formatDMY(l.date)} · ${l.status}`,
      amount: l.amount,
    })),
    totals: [
      { label: "Total spent", value: pmoney(p.totalSpent) },
      { label: "Total paid", value: pmoney(p.totalPaid) },
      {
        label: "Outstanding",
        value: pmoney(p.totalOutstanding),
        strong: true,
      },
    ],
    fileName: `${docNo}-${safeFilePart(p.customer, "customer")}`,
  };
}

/** Plain-text version, used for WhatsApp / copy actions. */
export function receiptText(doc: ReceiptDoc) {
  const s = readPrintSettings();
  if (doc.details) {
    const out: string[] = [
      s.shopName.trim() || BUSINESS_NAME,
      (doc.title ?? doc.kind).toUpperCase(),
      ...doc.details.map((d) => `${d.label}: ${d.value}`),
    ];
    for (const t of doc.totals)
      if (t.strong) out.push(`${t.label}: ${t.value}`);
    if (doc.note) out.push("", `Note: ${doc.note}`);
    return out.join("\n");
  }
  const lines: string[] = [
    s.shopName.trim() || BUSINESS_NAME,
    `${doc.kind} ${doc.docNo} · ${doc.dateText}`,
  ];
  if (doc.customer) lines.push(`Customer: ${doc.customer}`);
  if (doc.phone && s.showPhone) lines.push(`Phone: ${doc.phone}`);
  lines.push("");
  for (const l of doc.lines) {
    const qty = l.qty !== undefined && l.qty !== "" ? `${l.qty} × ` : "";
    const sub = l.sub ? ` (${l.sub})` : "";
    const amount =
      l.amountText !== undefined
        ? ` = ${l.amountText}`
        : l.amount !== undefined
          ? ` = ${pmoney(l.amount, s.currencySymbol)}`
          : "";
    lines.push(`${qty}${l.label}${sub}${amount}`);
  }
  lines.push("");
  for (const t of doc.totals) lines.push(`${t.label}: ${t.value}`);
  if (doc.note) lines.push("", `Note: ${doc.note}`);
  if (s.footerLine) lines.push("", s.footerLine);
  return lines.join("\n");
}

/* ---------- backwards-compatible bill helpers ---------- */

export const buildBillPdf = (bill: Bill) => buildReceiptPdf(billReceipt(bill));
export const downloadBillPdf = (bill: Bill, section?: InvoiceSection) =>
  downloadReceipt(billReceipt(bill), readPrintSettings(), section);
export const printBillPdf = (bill: Bill, section?: InvoiceSection) =>
  printReceipt(billReceipt(bill), readPrintSettings(), section);
export const shareBillPdf = (
  bill: Bill,
  fallbackUrl: string,
  section?: InvoiceSection,
) => shareReceipt(billReceipt(bill), fallbackUrl, readPrintSettings(), section);
