import { describe, expect, it, vi } from "vitest";
import type { jsPDF } from "jspdf";
import { DEFAULT_PRINT_SETTINGS, type PrintSettings } from "./print";
import { buildReceiptPdf, receiptText, type ReceiptDoc } from "./receipt";
import { expenseReceiptDoc } from "./expense-receipt";
import { investmentReceiptDoc } from "./investments";
import { sampleDocument } from "./document-samples";
import { getDefaultLayout, normalizeLayout } from "./layout-prefs";
import { FIRST_RUN_STEPS } from "./first-run";
import type { InvestmentRow } from "./localdb";
import { INVOICE_SECTIONS } from "./desktop";

/** Captures every drawn string so output can be asserted without rasterising. */
let cap: string[] | null = null;
vi.mock("jspdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jspdf")>();
  function Patched(
    this: unknown,
    ...args: ConstructorParameters<typeof actual.jsPDF>
  ) {
    const inst = new actual.jsPDF(...args);
    const orig = inst.text.bind(inst);
    inst.text = (
      t: string | string[],
      x: number,
      y: number,
      o?: import("jspdf").TextOptions,
    ) => {
      if (cap) for (const part of Array.isArray(t) ? t : [t]) cap.push(part);
      return orig(t, x, y, o);
    };
    return inst;
  }
  return { ...actual, jsPDF: Patched };
});

const render = (doc: ReceiptDoc, over: Partial<PrintSettings>) => {
  cap = [];
  const pdf: jsPDF = buildReceiptPdf(doc, {
    ...DEFAULT_PRINT_SETTINGS,
    ...over,
  });
  const texts = cap;
  cap = null;
  return { pdf, texts };
};

const exp = (over = {}) => ({
  id: "abcdef123456",
  expense_no: "EXP-20261005-001",
  business: "Turf",
  category: "Maintenance",
  description: "Net repair",
  note: "Paid to the local vendor",
  amount: 1250.5,
  spent_at: "2026-10-05",
  receipt_path: "Receipts/2026-10-05/a.jpg",
  payment_mode: "UPI",
  cash_part: 250,
  ...over,
});

const inv = (over: Partial<InvestmentRow> = {}): InvestmentRow =>
  ({
    id: "abcdef123456",
    bill_no: "INVES-20261004-001",
    investment_date: "2026-10-04",
    amount: 125000.5,
    category: "Equipment",
    note: "Floodlight set",
    payment_mode: "Card",
    receipt_path: "Receipts/2026-10-04/b.jpg",
    created_at: "",
    updated_at: "",
    deleted_at: null,
    ...over,
  }) as InvestmentRow;

const labels = (d: ReceiptDoc) => (d.details ?? []).map((x) => x.label);

describe("expense voucher document", () => {
  it("has its own heading and field order", () => {
    const d = expenseReceiptDoc(exp());
    expect(d.variant).toBe("expense");
    expect(d.title).toBe("Expense voucher");
    expect(labels(d)).toEqual([
      "Voucher No.",
      "Date",
      "Category",
      "Paid for",
      "Business",
      "Payment method",
      "Paid in cash",
      "Receipt photo",
    ]);
    expect(d.note).toBe("Paid to the local vendor");
  });
  it("omits attachment, cash split and duplicate note when absent", () => {
    const d = expenseReceiptDoc(
      exp({
        receipt_path: null,
        payment_mode: "Cash",
        cash_part: null,
        note: "Net repair",
      }),
    );
    expect(labels(d)).not.toContain("Receipt photo");
    expect(labels(d)).not.toContain("Paid in cash");
    expect(d.note).toBeNull();
    expect(d.photoPath).toBeNull();
  });
  it("keeps the stored-data fields other actions rely on", () => {
    const d = expenseReceiptDoc(exp());
    expect(d.docNo).toBe("EXP-20261005-001");
    expect(d.totals.at(-1)).toMatchObject({ label: "Amount", strong: true });
    expect(d.photoPath).toBe("Receipts/2026-10-05/a.jpg");
  });
});

describe("investment statement document", () => {
  it("has its own heading and field order", () => {
    const d = investmentReceiptDoc(inv());
    expect(d.variant).toBe("investment");
    expect(d.title).toBe("Investment statement");
    expect(labels(d)).toEqual([
      "Statement No.",
      "Date",
      "Category",
      "Purpose",
      "Paid via",
      "Bill photo",
    ]);
  });
  it("falls back to a generic purpose and drops the attachment row", () => {
    const d = investmentReceiptDoc(inv({ note: null, receipt_path: null }));
    expect(d.details?.find((x) => x.label === "Purpose")?.value).toBe(
      "Business investment",
    );
    expect(labels(d)).not.toContain("Bill photo");
  });
});

describe("voucher / statement are not sales invoices", () => {
  const papers = ["80mm", "58mm", "50mm", "a4", "a5", "letter"] as const;
  for (const paper of papers)
    for (const templateStyle of ["classic", "premium"] as const)
      it(`${paper}/${templateStyle}: heading, fields and amount, no item table`, () => {
        for (const [doc, heading, first] of [
          [expenseReceiptDoc(exp()), "EXPENSE VOUCHER", "Voucher No."],
          [
            investmentReceiptDoc(inv()),
            "INVESTMENT STATEMENT",
            "Statement No.",
          ],
        ] as const) {
          const { texts } = render(doc, { paper, templateStyle });
          const joined = texts.join(" ");
          expect(joined).toContain(heading);
          expect(texts).toContain(first);
          expect(joined).not.toMatch(/\bBill To\b/);
          expect(texts).not.toContain("ITEM");
          expect(texts).not.toContain("QTY");
          const amount = doc.totals.at(-1)!.value;
          expect(texts).toContain(amount);
          expect(texts.some((t) => t.includes("…") && /^(Rs)\b/.test(t))).toBe(
            false,
          );
        }
      });

  it("sales documents still print the item table and Bill To", () => {
    const { texts } = render(sampleDocument("sales"), {
      paper: "80mm",
      templateStyle: "classic",
    });
    expect(texts).toContain("ITEM");
    expect(texts).toContain("Bill To");
  });

  it("plain-text share/copy carries the heading, fields and amount", () => {
    for (const doc of [expenseReceiptDoc(exp()), investmentReceiptDoc(inv())]) {
      const text = receiptText(doc);
      expect(text).toContain(doc.title!.toUpperCase());
      expect(text).toContain(`${doc.details![0]!.label}: ${doc.docNo}`);
      expect(text).toContain(`Amount: ${doc.totals.at(-1)!.value}`);
    }
  });
});

describe("Bills & printing settings consolidation", () => {
  const settingsIds = () =>
    getDefaultLayout()
      .tabs.find((t) => t.tabId === "settings")!
      .sections.map((s) => s.id);

  it("registers one merged section and no longer the two old ones", () => {
    expect(settingsIds()).toContain("settings.bills-printing");
    expect(settingsIds()).not.toContain("settings.print");
    expect(settingsIds()).not.toContain("settings.invoice-branding");
    expect(settingsIds()).toContain("settings.billing");
  });

  it("an install that hid/moved the old printer section keeps that state", () => {
    const stored = getDefaultLayout();
    const tab = stored.tabs.find((t) => t.tabId === "settings")!;
    // An install from before the merge has no stored merged section yet.
    tab.sections = tab.sections.filter(
      (s) => s.id !== "settings.bills-printing",
    );
    tab.sections.push({
      id: "settings.print",
      visible: false,
      order: 3,
      parts: [],
    });
    const out = normalizeLayout(stored)
      .tabs.find((t) => t.tabId === "settings")!
      .sections.find((s) => s.id === "settings.bills-printing")!;
    expect(out.visible).toBe(false);
  });

  it("first-run steps open the merged section", () => {
    const values = FIRST_RUN_STEPS.flatMap((s) =>
      s.kind === "settings-section" ? [s.sectionValue] : [],
    );
    expect(values).not.toContain("print");
    expect(values).toContain("bills-printing");
  });

  it("sample documents come from the real builders", () => {
    expect(sampleDocument("expense").variant).toBe("expense");
    expect(sampleDocument("investment").variant).toBe("investment");
    expect(sampleDocument("sales").details).toBeUndefined();
  });
});

describe("output parity: one document, one builder", () => {
  it("PDF bytes and plain text agree on the document's key values", () => {
    for (const doc of [
      expenseReceiptDoc(exp()),
      investmentReceiptDoc(inv()),
      sampleDocument("sales"),
    ]) {
      const { texts } = render(doc, { paper: "a4", templateStyle: "classic" });
      const text = receiptText(doc);
      expect(texts.join(" ")).toContain(doc.docNo);
      expect(text).toContain(doc.docNo);
      expect(text).toContain(doc.dateText);
      const strong = doc.totals.find((t) => t.strong);
      if (strong) {
        expect(texts).toContain(strong.value);
        expect(text).toContain(strong.value);
      }
    }
  });
  it("every paper size yields a page for each document family", () => {
    for (const paper of ["80mm", "58mm", "50mm", "a4", "a5", "letter"] as const)
      for (const doc of [
        expenseReceiptDoc(exp()),
        investmentReceiptDoc(inv()),
        sampleDocument("sales"),
      ])
        expect(
          render(doc, { paper }).pdf.getNumberOfPages(),
        ).toBeGreaterThanOrEqual(1);
  });
});

describe("document folders", () => {
  it("expenses, investments and reports each have their own folder", () => {
    expect(INVOICE_SECTIONS.expenses).toBe("Expenses");
    expect(INVOICE_SECTIONS.investments).toBe("Investments");
    const folders = Object.values(INVOICE_SECTIONS);
    expect(new Set(folders).size).toBe(folders.length);
  });
});
