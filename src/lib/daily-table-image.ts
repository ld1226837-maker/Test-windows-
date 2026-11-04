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
 *    minimum. A number is never cut with an ellipsis. NOTES wraps to 2 lines when it can,
 *    otherwise to as many lines as it needs: a note is never truncated.
 *  - Rows grow to fit. More than 30 rows still go on one tall image; only past
 *    MAX_IMAGE_HEIGHT logical px is the table split into "Part 1/2" images.
 *  - Top to bottom: header, three headline figures, BOOKINGS & SALES table,
 *    EXPENSES, then the CASH FLOW waterfall (the last part only). The cash flow
 *    is drawn by looping over table.cash.steps; it never has lines of its own.
 *  - Only strings produced by daily-table.ts are drawn, so the picture and the
 *    text fallback can never disagree.
 */
import {
  CASH_LABELS,
  COLUMN_HEADERS,
  EXPENSE_HEADERS,
  EXPENSE_LABELS,
  EXPENSE_PAID_HEADER,
  TABLE_TITLE,
  countsText,
  formatCell,
  headlineFigures,
  isNegativeBalance,
  rowCells,
  stepAmountText,
  tableDateText,
  totalCells,
  type CashStep,
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
  /** Red-ish ink for a balance below zero (always with a minus sign too). */
  negative: "#B3261E",
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
/** Top band: logo, business name, "Daily Summary", date. */
const HEADER_H = 150;
/** Headline strip: COLLECTED CASH / CASH EXPENSES / FINAL TOTAL. */
const STRIP_H = 108;
/** "BOOKINGS & SALES" title row with the booking / snack-sale counts. */
const TITLE_H = 52;
/** Where the table's own head row starts. */
const TABLE_TOP = HEADER_H + STRIP_H + TITLE_H;
const HEAD_ROW_H = 52;
const MIN_ROW_H = 56;
const TOTAL_ROW_H = 70;
const NOTE_LINE_H = 26;
const BLOCK_GAP = 30;
const FOOTER_H = 64;
/** Expenses list: DESCRIPTION / NOTES / PAID (CASH|ONLINE tag) / AMOUNT. */
const EXP_COL_W = [300, 330, 170, 200] as const; // sums to TABLE_W
const EXP_GAP = 6;
const EXP_TITLE_H = 48;
const EXP_HEAD_H = 44;
const EXP_TOTAL_H = 54;
/** The two subtotal rows (cash deducted / online not deducted). */
const EXP_SUB_H = 46;
const EXP_MIN_ROW_H = 50;
const EXP_LINE_H = 24;

/* Cash flow card. Every height below is per STEP KIND, so what is drawn and
 * what the part splitter reserves come from the same numbers. */
const CARD_PAD = 24;
const CARD_TITLE_H = 54;
/** Muted "carried forward" line (label + hint) and its optional note line. */
const CARRIED_H = 58;
const CARRIED_NOTE_H = 30;
/** A calculation line without / with a hint line under the label. */
const CARD_ROW_H = 52;
const CARD_ROW_HINT_H = 70;
/** Thin divider before an "=" line (subtotal / final). */
const CARD_DIVIDER_H = 16;
const FINAL_BOX_H = 96;
const CARD_CAPTION_H = 44;
/** Width of the gutter that holds the "=" sign / the carried-forward arrow. */
const GUTTER_W = 40;

const stepHeight = (st: CashStep): number => {
  switch (st.kind) {
    case "info":
      return CARRIED_H + (st.note ? CARRIED_NOTE_H : 0);
    case "close":
      return CARD_DIVIDER_H + FINAL_BOX_H;
    case "subtotal":
      return CARD_DIVIDER_H + (st.hint ? CARD_ROW_HINT_H : CARD_ROW_H);
    default:
      return st.hint ? CARD_ROW_HINT_H : CARD_ROW_H;
  }
};

/** Height of the cash flow card for this table (varies with the optional lines). */
export function cashCardHeight(table: DailyTable): number {
  return (
    CARD_TITLE_H +
    table.cash.steps.reduce((n, st) => n + stepHeight(st), 0) +
    CARD_CAPTION_H +
    CARD_PAD
  );
}

/**
 * Tallest cash card (carried-forward line AND its difference line present).
 * Reserved when a worst case is needed; planParts uses the real height.
 */
export const BLOCKS_H =
  CARD_TITLE_H +
  CARRIED_H +
  CARRIED_NOTE_H +
  CARD_ROW_HINT_H + // old cash
  CARD_ROW_H + // less
  CARD_DIVIDER_H +
  CARD_ROW_HINT_H + // cash after expenses
  CARD_ROW_H + // plus
  CARD_DIVIDER_H +
  FINAL_BOX_H +
  CARD_CAPTION_H +
  CARD_PAD;
/** Worst-case room under the table: expenses are variable, so this is the card + gaps + footer. */
export const TAIL_H = BLOCK_GAP + BLOCKS_H + FOOTER_H;

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
 * NOTES text: prefers `maxLines` lines, shrinking the font 1 px at a time down
 * to `min` to get there. If it still needs more lines at the minimum size, ALL
 * the lines are kept and the row simply grows taller: a note is never cut, and
 * never ends with an ellipsis.
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
  return { lines: wrapWords(ctx, t, maxWidth), size: min };
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
  /** Expense rows drawn under the table (last part only). */
  expenses: ExpenseRowPlan[];
  /** Height of the whole expenses section (it always shows). */
  expensesH: number;
  /** Height of the cash flow card (last part only). */
  cashH: number;
  height: number;
};

const colX = (i: number) =>
  MARGIN + COL_W.slice(0, i).reduce((s, w) => s + w, 0);

const WHO_LINE_H = 22;
const TIME_LINE_H = 30;

function planRow(
  ctx: Ctx,
  cells: string[],
  customer = "",
  phone = "",
): RowPlan {
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
    return {
      e,
      desc,
      notes,
      height: Math.max(EXP_MIN_ROW_H, lines * EXP_LINE_H + 22),
    };
  });
  const body =
    rows.length === 0 ? EXP_MIN_ROW_H : rows.reduce((n, r) => n + r.height, 0);
  const total = rows.length > 0 ? EXP_TOTAL_H : 0;
  return {
    rows,
    height: EXP_GAP + EXP_TITLE_H + EXP_HEAD_H + body + total + EXP_SUB_H * 2,
  };
}

/**
 * Splits the table's rows into parts no taller than MAX_IMAGE_HEIGHT.
 *
 * Only the LAST part carries ALL TOTAL, the expenses and the cash flow card, so
 * it gets the rows that fit beside that tail (taken from the end); the earlier
 * parts hold only rows and the footer, and are filled greedily. No part ever
 * reserves room it does not draw, and every part is at most MAX_IMAGE_HEIGHT.
 */
export function planParts(ctx: Ctx, table: DailyTable): PartPlan[] {
  const plans = table.rows.map((r) =>
    planRow(ctx, rowCells(r), r.customer, r.phone),
  );
  const exp = planExpenses(ctx, table);
  const cashH = cashCardHeight(table);
  const top = TABLE_TOP + HEAD_ROW_H;
  const tail = TOTAL_ROW_H + BLOCK_GAP + exp.height + BLOCK_GAP + cashH;
  const mk = (rows: RowPlan[], last: boolean): PartPlan => {
    const body =
      rows.length === 0 ? MIN_ROW_H : rows.reduce((n, p) => n + p.height, 0);
    return {
      rows,
      expenses: last ? exp.rows : [],
      expensesH: exp.height,
      cashH,
      height: top + body + (last ? tail : 0) + FOOTER_H,
    };
  };

  // The last part: as many trailing rows as fit beside the tail (at least one
  // when there are any, so a single oversized row cannot loop forever).
  const lastCap = MAX_IMAGE_HEIGHT - top - tail - FOOTER_H;
  let lastStart = plans.length;
  let h = 0;
  while (lastStart > 0 && h + plans[lastStart - 1]!.height <= lastCap) {
    lastStart--;
    h += plans[lastStart]!.height;
  }
  if (lastStart === plans.length && plans.length > 0) lastStart--;

  const parts: PartPlan[] = [];
  const nonLastCap = MAX_IMAGE_HEIGHT - top - FOOTER_H;
  let cur: RowPlan[] = [];
  let curH = 0;
  for (const p of plans.slice(0, lastStart)) {
    if (cur.length > 0 && curH + p.height > nonLastCap) {
      parts.push(mk(cur, false));
      cur = [];
      curH = 0;
    }
    cur.push(p);
    curH += p.height;
  }
  if (cur.length > 0) parts.push(mk(cur, false));
  parts.push(mk(plans.slice(lastStart), true));
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
  color: string = COLORS.ink,
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

/** A small CASH / ONLINE tag (text says it, so it never relies on colour). */
function drawTag(ctx: Ctx, tag: string, x: number, midY: number, w: number) {
  const size = fitFontSize(ctx, tag, w - 18, 16, MIN_FONT, 700, SANS_STACK);
  ctx.font = font(700, size, SANS_STACK);
  const tw = Math.min(w, ctx.measureText(tag).width + 18);
  const h = 28;
  ctx.fillStyle = tag === "ONLINE" ? "#FFFFFF" : COLORS.headFill;
  ctx.fillRect(x, midY - h / 2, tw, h);
  ctx.strokeStyle = tag === "ONLINE" ? COLORS.muted : COLORS.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, midY - h / 2, tw, h);
  put(ctx, tag, x + 9, midY, {
    size,
    weight: 700,
    color: tag === "ONLINE" ? COLORS.note : COLORS.ink,
  });
}

/** EXPENSES: DESCRIPTION / NOTES / PAID tag / AMOUNT, then the two subtotals. */
function drawExpenses(
  ctx: Ctx,
  table: DailyTable,
  plan: PartPlan,
  top: number,
) {
  const x0 = MARGIN;
  const ex = (i: number) =>
    x0 + EXP_COL_W.slice(0, i).reduce((s, w) => s + w, 0);
  const amountRight = ex(3) + EXP_COL_W[3] - PAD;
  const amountW = EXP_COL_W[3] - PAD * 2;
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
  [...EXPENSE_HEADERS.slice(0, 2), EXPENSE_PAID_HEADER].forEach((h, i) =>
    put(ctx, h, ex(i) + PAD, y + EXP_HEAD_H / 2, { size: 20, weight: 700 }),
  );
  put(ctx, EXPENSE_HEADERS[2], amountRight, y + EXP_HEAD_H / 2, {
    size: 20,
    weight: 700,
    align: "right",
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
    drawTag(ctx, r.e.tag, ex(2) + PAD, mid, EXP_COL_W[2] - PAD * 2);
    putNumber(ctx, formatCell(r.e.amount), amountRight, mid, amountW, 24, 600);
    y += r.height;
    line(ctx, x0, y, x0 + TABLE_W, y);
  }
  const gridBottom = y;

  // Total + the two subtotals: their labels span the first three columns.
  const labelW = ex(3) - x0 - PAD * 2;
  const sumRow = (
    label: string,
    value: string,
    h: number,
    o: { fill?: string; weight: number; size: number; color?: string },
  ) => {
    if (o.fill) {
      ctx.fillStyle = o.fill;
      ctx.fillRect(x0, y, TABLE_W, h);
    }
    const labelSize = fitFontSize(
      ctx,
      label,
      labelW,
      o.size,
      MIN_FONT,
      o.weight,
      SANS_STACK,
    );
    put(ctx, label, x0 + PAD, y + h / 2, {
      size: labelSize,
      weight: o.weight,
      color: o.color ?? COLORS.ink,
    });
    putNumber(ctx, value, amountRight, y + h / 2, amountW, 26, 800, o.color);
    y += h;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    line(ctx, x0, y, x0 + TABLE_W, y);
  };
  if (plan.expenses.length > 0)
    sumRow(EXPENSE_LABELS.total, formatCell(table.expenseTotal), EXP_TOTAL_H, {
      fill: COLORS.totalFill,
      weight: 800,
      size: 20,
    });
  sumRow(EXPENSE_LABELS.cash, formatCell(table.cash.cashExpenses), EXP_SUB_H, {
    weight: 700,
    size: 20,
  });
  sumRow(
    EXPENSE_LABELS.online,
    formatCell(table.cash.onlineExpenses),
    EXP_SUB_H,
    { weight: 600, size: 20, color: COLORS.note },
  );

  // grid + frame
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= EXP_COL_W.length; i++)
    line(ctx, ex(i), tableTop, ex(i), gridBottom);
  line(ctx, ex(3), gridBottom, ex(3), y);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  line(ctx, x0, bodyTop, x0 + TABLE_W, bodyTop);
  ctx.strokeRect(x0, tableTop, TABLE_W, y - tableTop);
}

/** A thin down arrow in the gutter: the carried-forward figure feeds OLD CASH. */
function drawArrow(ctx: Ctx, x: number, y1: number, y2: number) {
  ctx.strokeStyle = COLORS.muted;
  ctx.fillStyle = COLORS.muted;
  ctx.lineWidth = 1.5;
  line(ctx, x, y1, x, y2 - 6);
  ctx.beginPath();
  ctx.moveTo(x - 5, y2 - 8);
  ctx.lineTo(x + 5, y2 - 8);
  ctx.lineTo(x, y2);
  ctx.closePath();
  ctx.fill();
}

/**
 * CASH FLOW card: a vertical waterfall drawn by looping over table.cash.steps.
 * Strings come from the steps (label, hint, note, signed amount text); the
 * picture adds only the layout: "=" in the gutter, a thin divider before each
 * "=" line, a lighter weight for the carried-forward line, red-ish ink and a
 * minus sign for a negative balance.
 */
function drawCashFlow(ctx: Ctx, table: DailyTable, top: number, cardH: number) {
  const x0 = MARGIN;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(x0, top, TABLE_W, cardH);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, top, TABLE_W, cardH);

  const lx = x0 + CARD_PAD;
  const labelX = lx + GUTTER_W;
  const right = x0 + TABLE_W - CARD_PAD;
  const labelMax = (valueW: number) => right - labelX - valueW - 16;

  put(ctx, "CASH FLOW", lx, top + CARD_TITLE_H / 2, { size: 26, weight: 800 });
  put(ctx, "step by step", right, top + CARD_TITLE_H / 2, {
    size: 18,
    weight: 600,
    align: "right",
    color: COLORS.muted,
  });

  let y = top + CARD_TITLE_H;
  let carriedBottom: number | null = null;
  for (const st of table.cash.steps) {
    const h = stepHeight(st);
    const value = stepAmountText(st);
    const negative = isNegativeBalance(st);
    const ink = negative ? COLORS.negative : COLORS.ink;

    if (st.kind === "info") {
      // Muted, lighter than the calculation lines: not part of the sum.
      const mid = y + 22;
      const vSize = fitFontSize(ctx, value, 220, 22, MIN_FONT, 500, MONO_STACK);
      ctx.font = font(500, vSize, MONO_STACK);
      const vW = ctx.measureText(value).width;
      const lSize = fitFontSize(
        ctx,
        st.label,
        labelMax(vW),
        20,
        MIN_FONT,
        500,
        SANS_STACK,
      );
      put(ctx, st.label, labelX, mid, {
        size: lSize,
        weight: 500,
        color: COLORS.muted,
      });
      put(ctx, value, right, mid, {
        size: vSize,
        weight: 500,
        family: MONO_STACK,
        align: "right",
        color: negative ? COLORS.negative : COLORS.muted,
      });
      if (st.hint)
        put(ctx, st.hint, labelX, y + 44, {
          size: 15,
          weight: 400,
          color: COLORS.muted,
        });
      if (st.note)
        put(ctx, st.note, labelX, y + CARRIED_H + CARRIED_NOTE_H / 2 - 4, {
          size: 15,
          weight: 500,
          color: COLORS.note,
        });
      carriedBottom = y + h;
      y += h;
      continue;
    }

    if (st.kind === "close") {
      const dy = y + CARD_DIVIDER_H / 2;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1.5;
      line(ctx, lx, dy, right, dy);
      const boxY = y + CARD_DIVIDER_H;
      ctx.fillStyle = COLORS.totalFill;
      ctx.fillRect(lx, boxY, right - lx, FINAL_BOX_H);
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 3;
      ctx.strokeRect(lx, boxY, right - lx, FINAL_BOX_H);
      const mid = boxY + FINAL_BOX_H / 2;
      put(ctx, "=", lx + 18, mid, {
        size: 34,
        weight: 800,
        family: MONO_STACK,
      });
      put(ctx, st.label, lx + 18 + GUTTER_W, mid, { size: 24, weight: 800 });
      const size = fitFontSize(
        ctx,
        value,
        (right - lx) * 0.5,
        54,
        MIN_FONT,
        800,
        MONO_STACK,
      );
      put(ctx, value, right - 18, mid, {
        size,
        weight: 800,
        family: MONO_STACK,
        align: "right",
        color: ink,
      });
      y += h;
      continue;
    }

    let rowTop = y;
    if (st.kind === "subtotal") {
      const dy = y + CARD_DIVIDER_H / 2;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1.5;
      line(ctx, lx, dy, right, dy);
      rowTop = y + CARD_DIVIDER_H;
      put(ctx, "=", lx + 12, rowTop + (st.hint ? 24 : CARD_ROW_H / 2), {
        size: 30,
        weight: 800,
        family: MONO_STACK,
      });
    }
    const bold = st.kind === "open" || st.kind === "subtotal";
    const mid = rowTop + (st.hint ? 24 : CARD_ROW_H / 2);
    const vSize = fitFontSize(
      ctx,
      value,
      300,
      bold ? 32 : 28,
      MIN_FONT,
      bold ? 800 : 700,
      MONO_STACK,
    );
    ctx.font = font(bold ? 800 : 700, vSize, MONO_STACK);
    const vW = ctx.measureText(value).width;
    const lSize = fitFontSize(
      ctx,
      st.label,
      labelMax(vW),
      bold ? 24 : 22,
      MIN_FONT,
      bold ? 800 : 600,
      SANS_STACK,
    );
    put(ctx, st.label, labelX, mid, {
      size: lSize,
      weight: bold ? 800 : 600,
    });
    put(ctx, value, right, mid, {
      size: vSize,
      weight: bold ? 800 : 700,
      family: MONO_STACK,
      align: "right",
      color: ink,
    });
    if (st.hint)
      put(ctx, st.hint, labelX, rowTop + 50, {
        size: 16,
        weight: 500,
        color: COLORS.muted,
      });
    if (st.kind === "open" && carriedBottom !== null) {
      // The arrow runs from the carried-forward line down to OLD CASH.
      drawArrow(ctx, lx + 14, carriedBottom - 20, mid - 14);
    }
    y += h;
  }

  put(
    ctx,
    CASH_LABELS.caption,
    lx,
    top + cardH - CARD_PAD - CARD_CAPTION_H / 2 + 8,
    {
      size: 16,
      weight: 400,
      color: COLORS.muted,
    },
  );
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

  // ---- headline strip: three figures an owner reads first ---------------
  {
    const gap = 16;
    const tileW = (TABLE_W - gap * 2) / 3;
    const tileY = HEADER_H;
    const tileH = STRIP_H - 18;
    headlineFigures(table).forEach((fig, i) => {
      const x = MARGIN + i * (tileW + gap);
      const isFinal = fig.key === "finalTotal";
      ctx.fillStyle = isFinal ? COLORS.totalFill : "#FFFFFF";
      ctx.fillRect(x, tileY, tileW, tileH);
      ctx.strokeStyle = isFinal ? COLORS.ink : COLORS.grid;
      ctx.lineWidth = isFinal ? 3 : 1.5;
      ctx.strokeRect(x, tileY, tileW, tileH);
      put(ctx, fig.label, x + 16, tileY + 24, {
        size: 17,
        weight: 700,
        color: COLORS.note,
      });
      const size = fitFontSize(
        ctx,
        fig.value,
        tileW - 32,
        isFinal ? 46 : 40,
        MIN_FONT,
        800,
        MONO_STACK,
      );
      put(ctx, fig.value, x + tileW - 16, tileY + tileH - 30, {
        size,
        weight: 800,
        family: MONO_STACK,
        align: "right",
        color: fig.negative ? COLORS.negative : COLORS.ink,
      });
    });
  }

  // ---- table title with the counts ---------------------------------------
  const titleMid = HEADER_H + STRIP_H + TITLE_H / 2 + 4;
  put(ctx, TABLE_TITLE, MARGIN, titleMid, { size: 26, weight: 800 });
  put(ctx, countsText(table.counts), MARGIN + TABLE_W, titleMid, {
    size: 20,
    weight: 600,
    align: "right",
    color: COLORS.muted,
  });

  // ---- table head -------------------------------------------------------
  let y = TABLE_TOP;
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
        blockTop +
          TIME_LINE_H +
          r.who.lines.length * WHO_LINE_H +
          WHO_LINE_H / 2,
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

  // ---- ALL TOTAL (last part only): taller, bolder, ink rule above ----------
  if (last) {
    ctx.fillStyle = COLORS.totalFill;
    ctx.fillRect(MARGIN, y, TABLE_W, TOTAL_ROW_H);
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3;
    line(ctx, MARGIN, y, MARGIN + TABLE_W, y);
    const cells = totalCells(table.totals);
    const mid = y + TOTAL_ROW_H / 2;
    put(ctx, cells[0] ?? "", colX(0) + PAD, mid, { size: 24, weight: 800 });
    for (let i = 1; i <= 5; i++)
      putNumber(
        ctx,
        cells[i] ?? "",
        colX(i) + COL_W[i]! - PAD,
        mid,
        COL_W[i]! - PAD * 2,
        28,
        800,
      );
    y += TOTAL_ROW_H;
  }

  // ---- grid ---------------------------------------------------------------
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= COL_W.length; i++) {
    const x = MARGIN + COL_W.slice(0, i).reduce((s, w) => s + w, 0);
    line(ctx, x, TABLE_TOP, x, y);
  }
  line(ctx, MARGIN, TABLE_TOP, MARGIN + TABLE_W, TABLE_TOP);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  line(ctx, MARGIN, bodyTop, MARGIN + TABLE_W, bodyTop);
  line(ctx, MARGIN, y, MARGIN + TABLE_W, y);
  // Outer ink frame of the table.
  ctx.strokeRect(MARGIN, TABLE_TOP, TABLE_W, y - TABLE_TOP);

  // ---- expenses, then the cash flow (last part only) -------------------------
  if (last) {
    const expTop = y + BLOCK_GAP;
    drawExpenses(ctx, table, plan, expTop);
    drawCashFlow(ctx, table, expTop + plan.expensesH + BLOCK_GAP, plan.cashH);
  }

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
