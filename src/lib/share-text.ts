/**
 * Plain-text version of a bill / booking / snack bill / payment receipt for the
 * Copy and WhatsApp buttons.
 *
 * Display only: every figure comes from the ReceiptDoc the printed receipt is
 * built from (billReceipt / bookingReceipt / snackSaleReceipt ...), so the text
 * can never disagree with the PDF. Nothing here recalculates a rupee.
 *
 * Two renderers share ONE list of lines:
 *   "whatsapp" - headings and key totals in *bold*, markup characters inside
 *                customer / item / note text neutralised so a name such as
 *                "Ravi_Kumar*" does not turn into italics or bold.
 *   "plain"    - the same lines with no markup (Copy button).
 *
 * Output rules (WhatsApp uses a proportional font and re-wraps long lines):
 * ASCII-safe symbols only (Rs, x, -, |), no tabs, no leading spaces, no
 * alignment by spaces, never two blank lines in a row, "\n" only.
 */
import type { ReceiptDoc } from "./receipt";
import {
  BALANCE_PAID_LABEL,
  REMAINING_LABEL,
  pdfSafeText,
} from "./remaining-summary";

export type ShareStyle = "whatsapp" | "plain";

export type ShareOptions = {
  style: ShareStyle;
  shopName: string;
  showPhone: boolean;
  footerLine?: string | undefined;
  /** Formats a line amount (same helper the printed receipt uses). */
  formatAmount: (n: number) => string;
};

/** WhatsApp links get unreliable past this many characters once encoded. */
export const WHATSAPP_SAFE_URL_CHARS = 6000;

/** True when the encoded wa.me link is long enough that it may not open. */
export const isLongForWhatsApp = (text: string) =>
  encodeURIComponent(text).length > WHATSAPP_SAFE_URL_CHARS;

/** Symbols WhatsApp or the wa.me link can garble -> ASCII equivalents. */
function ascii(s: string): string {
  return pdfSafeText(s)
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u00b7\u2022|]/g, "|")
    .replace(/[\u00d7]/g, "x")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2192/g, "->")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Free text typed by the user (names, items, notes). In WhatsApp the markup
 * characters are removed so they cannot reformat the message. */
function userText(s: unknown, style: ShareStyle): string {
  let t = ascii(String(s ?? ""));
  if (style === "whatsapp") {
    t = t
      .replace(/\*/g, "")
      .replace(/_/g, " ")
      .replace(/~/g, "-")
      .replace(/`/g, "'")
      .replace(/^[>\-\u2022]+\s*/, "")
      .replace(/ {2,}/g, " ")
      .trim();
  }
  return t;
}

type Row =
  | { t: "line"; s: string }
  | { t: "bold"; s: string }
  | { t: "head"; s: string }
  | { t: "blank" };

const bold = (style: ShareStyle, s: string) =>
  style === "whatsapp" && s ? `*${s}*` : s;

function render(rows: Row[], style: ShareStyle): string {
  const out: string[] = [];
  for (const r of rows) {
    if (r.t === "blank") {
      if (out.length && out[out.length - 1] !== "") out.push("");
    } else if (r.s) {
      out.push(r.t === "line" ? r.s : bold(style, r.s));
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** "Chips - 2 kg x Rs 100 = Rs 200" */
function itemLine(
  l: ReceiptDoc["lines"][number],
  n: number,
  o: ShareOptions,
): string {
  const label = userText(l.label, o.style) || "Item";
  const qty = l.qty !== undefined && String(l.qty) !== "" ? String(l.qty) : "";
  const sub = l.sub ? userText(l.sub, o.style) : "";
  const detail =
    sub && /^x\s/i.test(sub) && qty
      ? `${qty} ${sub}`
      : sub || (qty ? `Qty ${qty}` : "");
  const amount =
    l.amountText !== undefined
      ? ascii(l.amountText)
      : l.amount !== undefined
        ? ascii(o.formatAmount(l.amount))
        : "";
  return `${n}. ${label}${detail ? ` - ${detail}` : ""}${amount ? ` = ${amount}` : ""}`;
}

const isAdjustment = (l: ReceiptDoc["lines"][number]) =>
  l.amount !== undefined && Number(l.amount) < 0;

function noteRows(note: string | null | undefined, style: ShareStyle): Row[] {
  const parts = String(note ?? "")
    .split("\n")
    .map((p) => userText(p, style))
    .filter(Boolean);
  return parts.length
    ? [{ t: "blank" }, ...parts.map((p): Row => ({ t: "line", s: p }))]
    : [];
}

export function buildShareText(doc: ReceiptDoc, o: ShareOptions): string {
  const style = o.style;
  const shop = userText(o.shopName, style);
  const rows: Row[] = [{ t: "bold", s: shop }];

  // Expense / investment vouchers: heading, labelled fields, amount, note.
  if (doc.details) {
    rows.push({
      t: "bold",
      s: ascii((doc.title ?? doc.kind).toUpperCase()),
    });
    for (const d of doc.details)
      rows.push({
        t: "line",
        s: `${ascii(d.label)}: ${userText(d.value, style)}`,
      });
    for (const t of doc.totals)
      if (t.strong)
        rows.push({ t: "bold", s: `${ascii(t.label)}: ${ascii(t.value)}` });
    rows.push(...noteRows(doc.note, style));
    return render(rows, style);
  }

  rows.push({
    t: "line",
    s: ascii(`${doc.kind} ${doc.docNo} | ${doc.dateText}`),
  });
  if (doc.customer)
    rows.push({ t: "line", s: `Customer: ${userText(doc.customer, style)}` });
  if (doc.phone && o.showPhone)
    rows.push({ t: "line", s: `Phone: ${ascii(doc.phone)}` });

  // Items (price adjustments are shown in the Amount / Payment sections).
  const items = doc.lines.filter((l) => !isAdjustment(l));
  if (items.length) {
    rows.push({ t: "blank" }, { t: "head", s: "Items" });
    items.forEach((l, i) => rows.push({ t: "line", s: itemLine(l, i + 1, o) }));
  }
  const snacksPaid = doc.lines.find(
    (l) => isAdjustment(l) && /^snacks paid/i.test(l.label),
  );

  const totals = doc.totals.map((t) => ({
    label: ascii(t.label),
    value:
      t.label === "Mode" && doc.textMode ? ascii(doc.textMode) : ascii(t.value),
    strong: Boolean(t.strong) || t.label === REMAINING_LABEL,
  }));
  const grandAt = totals.findIndex((t) => /^grand total$/i.test(t.label));
  const row = (t: (typeof totals)[number], label = t.label): Row => ({
    t: t.strong ? "bold" : "line",
    s: `${label}: ${t.value}`,
  });

  if (grandAt >= 0) {
    const before = totals.slice(0, grandAt);
    const grand = totals[grandAt]!;
    rows.push({ t: "blank" }, { t: "head", s: "Amount" });
    for (const t of before) rows.push(row(t));
    rows.push({ t: "bold", s: `Grand total: ${grand.value}` });
    const after = totals.slice(grandAt + 1);
    if (after.length || doc.textAdvance) {
      rows.push({ t: "blank" }, { t: "head", s: "Payment" });
      let advanceDone = false;
      let snacksDone = false;
      for (const t of after) {
        if (
          (t.label === "Paid" || t.label === BALANCE_PAID_LABEL) &&
          doc.textAdvance &&
          !advanceDone
        ) {
          rows.push({
            t: "line",
            s: `Advance collected: ${ascii(doc.textAdvance)}`,
          });
          advanceDone = true;
        }
        if (t.label === "Paid" && snacksPaid && !snacksDone) {
          rows.push({
            t: "line",
            s: `Snacks paid: ${ascii(o.formatAmount(Math.abs(Number(snacksPaid.amount))))}`,
          });
          snacksDone = true;
        }
        rows.push(row(t));
      }
      if (!advanceDone && doc.textAdvance)
        rows.push({
          t: "line",
          s: `Advance collected: ${ascii(doc.textAdvance)}`,
        });
    }
  } else if (totals.length) {
    rows.push(
      { t: "blank" },
      { t: "head", s: doc.kind === "Payment" ? "Payment" : "Summary" },
    );
    for (const t of totals) rows.push(row(t));
  }

  rows.push(...noteRows(doc.note, style));
  const footer = userText(o.footerLine ?? "", style);
  if (footer) rows.push({ t: "blank" }, { t: "line", s: footer });
  return render(rows, style);
}
