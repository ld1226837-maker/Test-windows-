/**
 * Draws the owner's Daily Summary picture from a DailyTable (daily-table.ts).
 *
 * Plain Canvas 2D, no dependency. The picture is ALWAYS paper-white with blue
 * ledger ink and never reads the app theme, so it prints and looks the same on
 * the owner's phone as on the shop PC.
 *
 * Rules this file keeps:
 *  - 1080 logical px wide, rendered at 2x pixel ratio (2160 px file).
 *  - Cells never clip: text is measured and shrunk 1 px at a time down to a
 *    minimum. A number is never cut with an ellipsis. NOTES wraps to 2 lines.
 *  - Rows grow to fit. More than 30 rows still go on one tall image; only past
 *    MAX_IMAGE_HEIGHT logical px is the table split into "Part 1/2" images.
 *  - Only strings produced by daily-table.ts are drawn, so the picture and the
 *    text fallback can never disagree.
 */
import {
  CASH_LABELS,
  COLUMN_HEADERS,
  EXPENSE_HEADERS,
  formatCell,
  rowCells,
  tableDateText,
  totalCells,
  type DailyTable,
  type DailyTableExpense,
} from "./daily-table";
import { safeFilePart } from "./file-names";

export const IMAGE_WIDTH = 1080;
export const PIXEL_RATIO = 2;
/** Cap on one image's logical height; beyond it the table is split into parts. */
export const MAX_IMAGE_HEIGHT = 8000;

export const COLORS = {
  paper: "#FAF8F2",
  ink: "#222882",
  grid: "#D6D6D6",
  headFill: "#E4E7F5",
  totalFill: "#FFECA8",
  muted: "#8A8A8A",
  note: "#5B6070",
} as const;

export const SANS_STACK =
  '"Inter Tight Variable", "Inter Tight", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const MONO_STACK =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Consolas, "Roboto Mono", "Courier New", monospace';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

const MARGIN = 40;
const TABLE_W = IMAGE_WIDTH - MARGIN * 2; // 1000
/** TIME, TOTAL, OFFER, ADVANCE, CASH, ONLINE, NOTES — sums to TABLE_W. */
const COL_W = [230, 100, 92, 116, 96, 112, 254] as const;
const PAD = 12;
const HEADER_H = 150;
const HEAD_ROW_H = 52;
const MIN_ROW_H = 56;
const TOTAL_ROW_H = 62;
const NOTE_LINE_H = 26;
const BLOCK_GAP = 30;
const BLOCKS_H = 250;
const FOOTER_H = 64;
/** Expenses list under the cash blocks: DESCRIPTION / NOTES / AMOUNT. */
const EXP_COL_W = [360, 440, 200] as const; // sums to TABLE_W
const EXP_GAP = 6;
const EXP_TITLE_H = 48;
const EXP_HEAD_H = 44;
const EXP_TOTAL_H = 54;
const EXP_MIN_ROW_H = 50;
const EXP_LINE_H = 24;
const TAIL_H = BLOCK_GAP + BLOCKS_H + FOOTER_H;

const MIN_FONT = 12;

export type DrawOptions = {
  businessName: string;
  /** Decoded logo (null/undefined = no logo). */
  logo?: CanvasImageSource | null | undefined;
  logoWidth?: number | undefined;
  logoHeight?: number | undefined;
  /** Footer timestamp; defaults to now. */
  generatedAt?: Date | undefined;
  /** Which part to draw (0-based) when the table needs splitting. */
  partIndex?: number | undefined;
};

const font = (weight: number | string, px: number, family: string) =>
  `${weight} ${px}px ${family}`;

/**
 * Largest size from `start` down to `min` (1 px steps) at which `text` fits in
 * `maxWidth`. Returns `min` if even that is too wide (the caller keeps drawing
 * at `min`; a number is never replaced by an ellipsis).
 */
export function fitFontSize(
  ctx: Ctx,
  text: string,
  maxWidth: number,
  start: number,
  min: number,
  weight: number | string,
  family: string,
): number {
  for (let px = start; px > min; px--) {
    ctx.font = font(weight, px, family);
    if (ctx.measureText(text).width <= maxWidth) return px;
  }
  return min;
}

/** Greedy word wrap that also breaks a single over-long word by characters. */
function wrapWords(ctx: Ctx, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
  for (const w of words) {
    const tryLine = cur ? `${cur} ${w}` : w;
    if (fits(tryLine)) {
      cur = tryLine;
      continue;
    }
    if (cur) lines.push(cur);
    cur = "";
    let rest = w;
    while (rest && !fits(rest)) {
      let n = rest.length - 1;
      while (n > 1 && !fits(rest.slice(0, n))) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    cur = rest;
  }
  if (cur) lines.push(cur);
  return lines;
}

export type NotesLayout = { lines: string[]; size: number };

/**
 * NOTES text: wraps to at most `maxLines` lines. The font shrinks 1 px at a
 * time until it fits; only if it still cannot (at the minimum size) is the last
 * line ended with an ellipsis — notes are words, never numbers.
 */
export function layoutNotes(
  ctx: Ctx,
  text: string,
  maxWidth: number,
  maxLines = 2,
  start = 20,
  min = 13,
): NotesLayout {
  const t = text.trim();
  if (!t) return { lines: [], size: start };
  for (let px = start; px >= min; px--) {
    ctx.font = font(500, px, SANS_STACK);
    const lines = wrapWords(ctx, t, maxWidth);
    if (lines.length <= maxLines) return { lines, size: px };
  }
  ctx.font = font(500, min, SANS_STACK);
  const lines = wrapWords(ctx, t, maxWidth).slice(0, maxLines);
  let last = lines[maxLines - 1] ?? "";
  while (last.length > 1 && ctx.measureText(`${last}\u2026`).width > maxWidth)
    last = last.slice(0, -1);
  lines[maxLines - 1] = `${last}\u2026`;
  return { lines, size: min };
}

/* ------------------------------------------------------------------ */
/* layout (shared by every part so heights match what is drawn)         */
/* ------------------------------------------------------------------ */

type RowPlan = {
  cells: string[];
  notes: NotesLayout;
  /** Customer name lines (under the time) and phone. */
  who: NotesLayout;
  phone: string;
  height: number;
};
type ExpenseRowPlan = {
  e: DailyTableExpense;
  desc: NotesLayout;
  notes: NotesLayout;
  height: number;
};
export type PartPlan = {
  rows: RowPlan[];
  /** Expense rows drawn under the cash blocks (last part only). */
  expenses: ExpenseRowPlan[];
  /** Height of the whole expenses section (0 never: it always shows). */
  expensesH: number;
  height: number;
};

const colX = (i: number) =>
  MARGIN + COL_W.slice(0, i).reduce((s, w) => s + w, 0);

const WHO_LINE_H = 22;
const TIME_LINE_H = 30;

function planRow(ctx: Ctx, cells: string[], customer = "", phone = ""): RowPlan {
  const notes = layoutNotes(ctx, cells[6] ?? "", COL_W[6] - PAD * 2);
  const who = layoutNotes(ctx, customer, COL_W[0] - PAD * 2, 2, 18, 13);
  const whoH =
    who.lines.length > 0
      ? who.lines.length * WHO_LINE_H + (phone ? WHO_LINE_H : 0)
      : 0;
  const left = whoH > 0 ? TIME_LINE_H + whoH + 20 : 0;
  const height = Math.max(
    MIN_ROW_H,
    notes.lines.length * NOTE_LINE_H + 24,
    left,
  );
  return { cells, notes, who, phone, height };
}

function planExpenses(ctx: Ctx, table: DailyTable) {
  const rows: ExpenseRowPlan[] = (table.expenseList ?? []).map((e) => {
    const desc = layoutNotes(ctx, e.description, EXP_COL_W[0] - PAD * 2);
    const notes = layoutNotes(ctx, e.notes, EXP_COL_W[1] - PAD * 2);
    const lines = Math.max(desc.lines.length, notes.lines.length, 1);
    return { e, desc, notes, height: Math.max(EXP_MIN_ROW_H, lines * EXP_LINE_H + 22) };
  });
  const body = rows.length === 0 ? EXP_MIN_ROW_H : rows.reduce((n, r) => n + r.height, 0);
  const total = rows.length > 0 ? EXP_TOTAL_H : 0;
  return { rows, height: EXP_GAP + EXP_TITLE_H + EXP_HEAD_H + body + total };
}

/**
 * Splits the table's rows into parts no taller than MAX_IMAGE_HEIGHT. Every
 * part reserves room for the totals/cash blocks so any of them can be the last.
 */
export function planParts(ctx: Ctx, table: DailyTable): PartPlan[] {
  const plans = table.rows.map((r) =>
    planRow(ctx, rowCells(r), r.customer, r.phone),
  );
  const exp = planExpenses(ctx, table);
  const base = HEADER_H + HEAD_ROW_H + TOTAL_ROW_H + TAIL_H + exp.height;
  const empty = plans.length === 0 ? MIN_ROW_H : 0;
  const parts: PartPlan[] = [];
  let cur: RowPlan[] = [];
  let curH = base + empty;
  for (const p of plans) {
    if (cur.length > 0 && curH + p.height > MAX_IMAGE_HEIGHT) {
      parts.push({ rows: cur, expenses: exp.rows, expensesH: exp.height, height: curH });
      cur = [];
      curH = base;
    }
    cur.push(p);
    curH += p.height;
  }
  parts.push({ rows: cur, expenses: exp.rows, expensesH: exp.height, height: curH });
  return parts;
}

/* ------------------------------------------------------------------ */
/* drawing                                                              */
/* ------------------------------------------------------------------ */

function put(
  ctx: Ctx,
  str: string,
  x: number,
  y: number,
  o: {
    size: number;
    weight?: number | string;
    family?: string;
    align?: CanvasTextAlign;
    color?: string;
  },
) {
  ctx.font = font(o.weight ?? 400, o.size, o.family ?? SANS_STACK);
  ctx.textAlign = o.align ?? "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = o.color ?? COLORS.ink;
  ctx.fillText(str, x, y);
}

const line = (ctx: Ctx, x1: number, y1: number, x2: number, y2: number) => {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
};

/** A number cell: right aligned, monospace, shrunk to fit its column. */
function putNumber(
  ctx: Ctx,
  str: string,
  right: number,
  midY: number,
  width: number,
  start: number,
  weight: number | string,
  color = COLORS.ink,
) {
  const size = fitFontSize(
    ctx,
    str,
    width,
    start,
    MIN_FONT,
    weight,
    MONO_STACK,
  );
  put(ctx, str, right, midY, {
    size,
    weight,
    family: MONO_STACK,
    align: "right",
    color,
  });
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** EXPENSES: DESCRIPTION / NOTES / AMOUNT, starting at `top`. */
function drawExpenses(ctx: Ctx, table: DailyTable, plan: PartPlan, top: number) {
  const x0 = MARGIN;
  const ex = (i: number) => x0 + EXP_COL_W.slice(0, i).reduce((s, w) => s + w, 0);
  let y = top + EXP_GAP;
  put(ctx, "EXPENSES", x0, y + EXP_TITLE_H / 2, { size: 26, weight: 800 });
  const countText = `${plan.expenses.length} ${plan.expenses.length === 1 ? "item" : "items"}`;
  put(ctx, countText, x0 + TABLE_W, y + EXP_TITLE_H / 2, {
    size: 18,
    weight: 600,
    align: "right",
    color: COLORS.muted,
  });
  y += EXP_TITLE_H;
  const tableTop = y;

  ctx.fillStyle = COLORS.headFill;
  ctx.fillRect(x0, y, TABLE_W, EXP_HEAD_H);
  EXPENSE_HEADERS.forEach((h, i) => {
    if (i < 2) put(ctx, h, ex(i) + PAD, y + EXP_HEAD_H / 2, { size: 20, weight: 700 });
    else
      put(ctx, h, ex(i) + EXP_COL_W[i]! - PAD, y + EXP_HEAD_H / 2, {
        size: 20,
        weight: 700,
        align: "right",
      });
  });
  y += EXP_HEAD_H;
  const bodyTop = y;

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  if (plan.expenses.length === 0) {
    put(ctx, "No expenses on this day", x0 + PAD, y + EXP_MIN_ROW_H / 2, {
      size: 22,
      weight: 500,
      color: COLORS.muted,
    });
    y += EXP_MIN_ROW_H;
    line(ctx, x0, y, x0 + TABLE_W, y);
  }
  for (const r of plan.expenses) {
    const mid = y + r.height / 2;
    const text = (n: NotesLayout, x: number, color: string, weight: number) => {
      const top0 = mid - ((n.lines.length - 1) * EXP_LINE_H) / 2;
      n.lines.forEach((l, k) =>
        put(ctx, l, x, top0 + k * EXP_LINE_H, { size: n.size, weight, color }),
      );
    };
    text(r.desc, ex(0) + PAD, COLORS.ink, 600);
    text(r.notes, ex(1) + PAD, COLORS.note, 500);
    putNumber(ctx, formatCell(r.e.amount), ex(2) + EXP_COL_W[2]! - PAD, mid, EXP_COL_W[2]! - PAD * 2, 24, 600);
    y += r.height;
    line(ctx, x0, y, x0 + TABLE_W, y);
  }
  if (plan.expenses.length > 0) {
    ctx.fillStyle = COLORS.totalFill;
    ctx.fillRect(x0, y, TABLE_W, EXP_TOTAL_H);
    const mid = y + EXP_TOTAL_H / 2;
    put(ctx, "TOTAL EXPENSES", ex(0) + PAD, mid, { size: 20, weight: 800 });
    const cashPaid = table.cashBlock.expenses;
    if (cashPaid !== table.expenseTotal)
      put(ctx, `Cash paid: ${formatCell(cashPaid)}`, ex(1) + PAD, mid, {
        size: 18,
        weight: 600,
        color: COLORS.note,
      });
    putNumber(ctx, formatCell(table.expenseTotal), ex(2) + EXP_COL_W[2]! - PAD, mid, EXP_COL_W[2]! - PAD * 2, 26, 800);
    y += EXP_TOTAL_H;
  }

  // grid + frame
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= EXP_COL_W.length; i++) line(ctx, ex(i), tableTop, ex(i), y);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  line(ctx, x0, bodyTop, x0 + TABLE_W, bodyTop);
  ctx.strokeRect(x0, tableTop, TABLE_W, y - tableTop);
}

export function drawPart(
  ctx: Ctx,
  table: DailyTable,
  plan: PartPlan,
  opts: DrawOptions,
  partIndex: number,
  partCount: number,
) {
  const H = plan.height;
  const last = partIndex === partCount - 1;
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, IMAGE_WIDTH, H);

  // ---- header ---------------------------------------------------------
  let textX = MARGIN;
  if (opts.logo && opts.logoWidth && opts.logoHeight) {
    const box = 84;
    const k = Math.min(box / opts.logoWidth, box / opts.logoHeight);
    const w = opts.logoWidth * k;
    const h = opts.logoHeight * k;
    ctx.drawImage(opts.logo, MARGIN, 28 + (box - h) / 2, w, h);
    textX = MARGIN + w + 20;
  }
  const dateText = tableDateText(table.date);
  const dateSize = fitFontSize(
    ctx,
    dateText,
    260,
    34,
    MIN_FONT,
    700,
    MONO_STACK,
  );
  const nameMax = IMAGE_WIDTH - MARGIN - 280 - textX;
  const nameSize = fitFontSize(
    ctx,
    opts.businessName,
    nameMax,
    36,
    MIN_FONT,
    700,
    SANS_STACK,
  );
  put(ctx, opts.businessName, textX, 56, {
    size: nameSize,
    weight: 700,
  });
  put(ctx, "Daily Summary", textX, 104, { size: 28, weight: 600 });
  put(ctx, dateText, IMAGE_WIDTH - MARGIN, 56, {
    size: dateSize,
    weight: 700,
    family: MONO_STACK,
    align: "right",
  });
  if (partCount > 1) {
    put(ctx, `Part ${partIndex + 1}/${partCount}`, IMAGE_WIDTH - MARGIN, 104, {
      size: 24,
      weight: 600,
      align: "right",
    });
  }

  // ---- table head -------------------------------------------------------
  let y = HEADER_H;
  ctx.fillStyle = COLORS.headFill;
  ctx.fillRect(MARGIN, y, TABLE_W, HEAD_ROW_H);
  COLUMN_HEADERS.forEach((h, i) => {
    const left = colX(i);
    if (i === 0 || i === 6)
      put(ctx, h, left + PAD, y + HEAD_ROW_H / 2, { size: 20, weight: 700 });
    else
      put(ctx, h, left + COL_W[i]! - PAD, y + HEAD_ROW_H / 2, {
        size: 20,
        weight: 700,
        align: "right",
      });
  });
  y += HEAD_ROW_H;
  const bodyTop = y;

  // ---- body rows --------------------------------------------------------
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  if (plan.rows.length === 0) {
    put(
      ctx,
      "No bookings or sales on this day",
      MARGIN + PAD,
      y + MIN_ROW_H / 2,
      {
        size: 22,
        weight: 500,
        color: COLORS.muted,
      },
    );
    y += MIN_ROW_H;
    line(ctx, MARGIN, y, MARGIN + TABLE_W, y);
  }
  for (const r of plan.rows) {
    const mid = y + r.height / 2;
    const timeSize = fitFontSize(
      ctx,
      r.cells[0] ?? "",
      COL_W[0] - PAD * 2,
      21,
      MIN_FONT,
      600,
      MONO_STACK,
    );
    const whoH =
      r.who.lines.length > 0
        ? r.who.lines.length * WHO_LINE_H + (r.phone ? WHO_LINE_H : 0)
        : 0;
    const blockTop = mid - (TIME_LINE_H + whoH) / 2;
    put(
      ctx,
      r.cells[0] ?? "",
      colX(0) + PAD,
      whoH > 0 ? blockTop + TIME_LINE_H / 2 : mid,
      { size: timeSize, weight: 600, family: MONO_STACK },
    );
    r.who.lines.forEach((l, k) =>
      put(
        ctx,
        l,
        colX(0) + PAD,
        blockTop + TIME_LINE_H + k * WHO_LINE_H + WHO_LINE_H / 2,
        { size: r.who.size, weight: 600, color: COLORS.note },
      ),
    );
    if (r.phone && whoH > 0)
      put(
        ctx,
        r.phone,
        colX(0) + PAD,
        blockTop + TIME_LINE_H + r.who.lines.length * WHO_LINE_H + WHO_LINE_H / 2,
        { size: 16, weight: 500, family: MONO_STACK, color: COLORS.muted },
      );
    for (let i = 1; i <= 5; i++)
      putNumber(
        ctx,
        r.cells[i] ?? "",
        colX(i) + COL_W[i]! - PAD,
        mid,
        COL_W[i]! - PAD * 2,
        24,
        500,
      );
    const n = r.notes;
    const top = mid - ((n.lines.length - 1) * NOTE_LINE_H) / 2;
    n.lines.forEach((l, k) =>
      put(ctx, l, colX(6) + PAD, top + k * NOTE_LINE_H, {
        size: n.size,
        weight: 500,
        color: COLORS.note,
      }),
    );
    y += r.height;
    line(ctx, MARGIN, y, MARGIN + TABLE_W, y);
  }

  // ---- ALL TOTAL (last part only) ----------------------------------------
  if (last) {
    ctx.fillStyle = COLORS.totalFill;
    ctx.fillRect(MARGIN, y, TABLE_W, TOTAL_ROW_H);
    const cells = totalCells(table.totals);
    const mid = y + TOTAL_ROW_H / 2;
    put(ctx, cells[0] ?? "", colX(0) + PAD, mid, { size: 20, weight: 800 });
    for (let i = 1; i <= 5; i++)
      putNumber(
        ctx,
        cells[i] ?? "",
        colX(i) + COL_W[i]! - PAD,
        mid,
        COL_W[i]! - PAD * 2,
        26,
        800,
      );
    y += TOTAL_ROW_H;
  }

  // ---- grid ---------------------------------------------------------------
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= COL_W.length; i++) {
    const x = MARGIN + COL_W.slice(0, i).reduce((s, w) => s + w, 0);
    line(ctx, x, HEADER_H, x, y);
  }
  line(ctx, MARGIN, HEADER_H, MARGIN + TABLE_W, HEADER_H);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  line(ctx, MARGIN, bodyTop, MARGIN + TABLE_W, bodyTop);
  line(ctx, MARGIN, y, MARGIN + TABLE_W, y);

  // ---- cash blocks (last part only) ----------------------------------------
  if (last) {
    // Outer ink frame of the table.
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(MARGIN, HEADER_H, TABLE_W, y - HEADER_H);

    const top = y + BLOCK_GAP;
    const gap = 30;
    const cardW = (TABLE_W - gap) / 2;
    const rightX = MARGIN + cardW + gap;
    const rowH = 50;
    const pad = 18;
    const cardH = BLOCKS_H - 20;
    const card = (x: number) => {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(x, top, cardW, cardH);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, top, cardW, cardH);
    };
    card(MARGIN);
    card(rightX);
    const labelled = (
      x: number,
      yy: number,
      w: number,
      label: string,
      value: string,
      bold: boolean,
    ) => {
      const valueSize = fitFontSize(
        ctx,
        value,
        w * 0.4,
        26,
        MIN_FONT,
        700,
        MONO_STACK,
      );
      ctx.font = font(700, valueSize, MONO_STACK);
      const valueW = ctx.measureText(value).width;
      const labelSize = fitFontSize(
        ctx,
        label,
        w - valueW - 16,
        18,
        MIN_FONT,
        bold ? 800 : 600,
        SANS_STACK,
      );
      put(ctx, label, x, yy + rowH / 2, {
        size: labelSize,
        weight: bold ? 800 : 600,
      });
      put(ctx, value, x + w, yy + rowH / 2, {
        size: valueSize,
        weight: 700,
        family: MONO_STACK,
        align: "right",
      });
    };
    const lx = MARGIN + pad;
    const lw = cardW - pad * 2;
    const c = table.cashBlock;
    labelled(
      lx,
      top + 8,
      lw,
      CASH_LABELS.specificCash,
      formatCell(c.specificCash),
      false,
    );
    labelled(
      lx,
      top + 8 + rowH,
      lw,
      CASH_LABELS.expenses,
      formatCell(c.expenses),
      false,
    );
    labelled(
      lx,
      top + 8 + rowH * 2,
      lw,
      CASH_LABELS.remainingCash,
      formatCell(c.remainingCash),
      true,
    );
    put(
      ctx,
      "Remaining = cash total - cash expenses",
      lx,
      top + 8 + rowH * 3 + 10,
      {
        size: 15,
        color: COLORS.muted,
      },
    );

    const rx = rightX + pad;
    const rw = cardW - pad * 2;
    // Old cash: label on its own full-width line, then caption + boxed field.
    const oldLabelSize = fitFontSize(
      ctx,
      CASH_LABELS.oldCash,
      rw,
      18,
      MIN_FONT,
      600,
      SANS_STACK,
    );
    put(ctx, CASH_LABELS.oldCash, rx, top + 26, {
      size: oldLabelSize,
      weight: 600,
    });
    ctx.fillStyle = "#FFFDF0";
    ctx.fillRect(rx + rw - 210, top + 46, 210, 42);
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx + rw - 210, top + 46, 210, 42);
    putNumber(
      ctx,
      formatCell(table.oldCash),
      rx + rw - 14,
      top + 67,
      190,
      26,
      800,
    );
    put(
      ctx,
      `Remaining cash ${formatCell(c.remainingCash)} + old cash ${formatCell(table.oldCash)}`,
      rx,
      top + 106,
      { size: 16, color: COLORS.muted },
    );

    // FINAL TOTAL: highlighted box.
    const boxY = top + 124;
    const boxH = 80;
    ctx.fillStyle = COLORS.totalFill;
    ctx.fillRect(rx, boxY, rw, boxH);
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3;
    ctx.strokeRect(rx, boxY, rw, boxH);
    put(ctx, CASH_LABELS.finalTotal, rx + 16, boxY + boxH / 2, {
      size: 20,
      weight: 800,
    });
    const finalText = formatCell(table.finalTotal);
    const finalSize = fitFontSize(
      ctx,
      finalText,
      rw * 0.5,
      44,
      MIN_FONT,
      800,
      MONO_STACK,
    );
    put(ctx, finalText, rx + rw - 16, boxY + boxH / 2, {
      size: finalSize,
      weight: 800,
      family: MONO_STACK,
      align: "right",
    });
  }

  // ---- expenses list (last part only) -------------------------------------
  if (last) drawExpenses(ctx, table, plan, y + BLOCK_GAP + BLOCKS_H);

  // ---- footer -----------------------------------------------------------------
  put(
    ctx,
    `Generated ${stamp(opts.generatedAt ?? new Date())}`,
    IMAGE_WIDTH / 2,
    H - FOOTER_H / 2,
    {
      size: 16,
      weight: 400,
      align: "center",
      color: COLORS.muted,
    },
  );
}

/* ------------------------------------------------------------------ */
/* canvas plumbing                                                      */
/* ------------------------------------------------------------------ */

function makeCanvas(w: number, h: number): CanvasLike {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  throw new Error("No canvas available to draw the summary image");
}

function context2d(c: CanvasLike): Ctx {
  const ctx = c.getContext("2d") as Ctx | null;
  if (!ctx) throw new Error("Canvas 2D is not available");
  return ctx;
}

/** Waits (briefly) for web fonts so the first picture does not use a fallback. */
export async function waitForFonts(timeoutMs = 1500): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const ready = document.fonts.ready.then(() => undefined);
  const timeout = new Promise<void>((r) => setTimeout(r, timeoutMs));
  try {
    await Promise.race([ready, timeout]);
  } catch {
    /* fonts are best-effort; the fallback stacks still draw */
  }
}

/**
 * Draws one part of the table (default: the first) and returns its canvas,
 * 1080 x PIXEL_RATIO wide. Throws if no 2D context can be made.
 */
export function drawDailyTableCanvas(
  table: DailyTable,
  opts: DrawOptions,
): CanvasLike {
  const measure = context2d(makeCanvas(1, 1));
  const parts = planParts(measure, table);
  const index = Math.min(Math.max(0, opts.partIndex ?? 0), parts.length - 1);
  const plan = parts[index]!;
  const canvas = makeCanvas(
    IMAGE_WIDTH * PIXEL_RATIO,
    plan.height * PIXEL_RATIO,
  );
  const ctx = context2d(canvas);
  ctx.setTransform(PIXEL_RATIO, 0, 0, PIXEL_RATIO, 0, 0);
  drawPart(ctx, table, plan, opts, index, parts.length);
  return canvas;
}

export function canvasToPngBlob(canvas: CanvasLike): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("The browser could not encode the PNG"));
    }, "image/png");
  });
}

/** "Daily-Summary-27-10-2026.png" or "...-Part-1-of-2.png". */
export function dailyTableFileName(
  date: string,
  part?: { index: number; count: number },
): string {
  const base = `Daily-Summary-${safeFilePart(tableDateText(date), "day")}`;
  return part && part.count > 1
    ? `${base}-Part-${part.index + 1}-of-${part.count}.png`
    : `${base}.png`;
}

export type RenderedImage = {
  blob: Blob;
  fileName: string;
  width: number;
  height: number;
};

/** All parts of the table as PNG blobs (one for any normal day). */
export async function renderDailyTableImages(
  table: DailyTable,
  opts: Omit<DrawOptions, "partIndex">,
): Promise<RenderedImage[]> {
  await waitForFonts();
  const count = planParts(context2d(makeCanvas(1, 1)), table).length;
  const out: RenderedImage[] = [];
  for (let i = 0; i < count; i++) {
    const canvas = drawDailyTableCanvas(table, { ...opts, partIndex: i });
    out.push({
      blob: await canvasToPngBlob(canvas),
      fileName: dailyTableFileName(table.date, { index: i, count }),
      width: canvas.width,
      height: canvas.height,
    });
  }
  return out;
}

/** Loads a data-URL logo; resolves null (never rejects) if it will not decode. */
export function loadLogo(
  dataUrl: string | null | undefined,
  timeoutMs = 3000,
): Promise<{ image: HTMLImageElement; width: number; height: number } | null> {
  if (!dataUrl || typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      resolve(width > 0 && height > 0 ? { image: img, width, height } : null);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = dataUrl;
  });
}
