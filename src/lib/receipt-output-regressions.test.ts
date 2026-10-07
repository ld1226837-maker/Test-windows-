import { describe, expect, it, vi } from "vitest";
import { jsPDF } from "jspdf";

import { DEFAULT_PRINT_SETTINGS, type PrintSettings } from "./print";
import {
  buildReceiptPdf,
  customerStatementReceipt,
  paymentReceipt,
  receiptText,
  snackSaleReceipt,
  type ReceiptDoc,
} from "./receipt";
import { safeFilePart } from "./file-names";
import { investmentReceiptDoc } from "./investments";
import type { InvestmentRow } from "./localdb";
import type { SnackSale } from "./ops";

/** Captures every text call (text + x + drawn width + y) so layout rules can
 * be asserted without rasterising the PDF. */
type Call = { text: string; x: number; y: number; w: number; align?: string };
let cap: Call[] | null = null;
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
      if (cap && typeof t === "string")
        cap.push({
          text: t,
          x,
          y,
          w: inst.getTextWidth(t),
          ...(o?.align ? { align: o.align } : {}),
        });
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
  const calls = cap;
  cap = null;
  return { pdf, calls };
};

const inv = (over: Partial<InvestmentRow> = {}): InvestmentRow =>
  ({
    id: "abcdef123456",
    bill_no: "INVES-20261004-001",
    investment_date: "2026-10-04",
    amount: 125000.5,
    category: "Equipment",
    note: "Flood light set for turf A with installation and a long purpose text",
    payment_mode: "UPI",
    receipt_path: null,
    created_at: "",
    updated_at: "",
    deleted_at: null,
    ...over,
  }) as InvestmentRow;

describe("investment receipt", () => {
  it("carries the real amount on its line (no Rs 0) and no quantity", () => {
    const d = investmentReceiptDoc(inv());
    expect(d.lines[0]!.amount).toBe(125000.5);
    // line and total show the same paise-exact figure, with the currency
    expect(d.lines[0]!.amountText).toBe("Rs 1,25,000.50");
    expect(d.totals.at(-1)!.value).toBe("Rs 1,25,000.50");
    expect("qty" in d.lines[0]!).toBe(false);
    expect(d.dateText).toBe("04-10-2026");
    expect(d.totals.map((t) => t.label)).toEqual([
      "Category",
      "Payment method",
      "Amount",
    ]);
  });
  it("never leaves the number blank for older rows without a bill_no", () => {
    expect(investmentReceiptDoc(inv({ bill_no: null })).docNo).toBe(
      "INVES-ABCDEF12",
    );
  });
});

describe("totals order and column clipping", () => {
  const sale = (over: Partial<SnackSale> = {}): SnackSale => ({
    id: "s1",
    bill_no: "SB-1",
    sale_date: "2026-10-04",
    customer_name: null,
    items: [
      {
        item_name: "Samosa",
        qty: 3,
        unit_price: 15,
        cost_price: 8,
        amount: 45,
      },
    ],
    total: 45,
    profit: 21,
    payment_mode: "On tab",
    notes: null,
    ...over,
  });
  it("an On-tab snack sale shows Paid 0, Balance due and UNPAID", () => {
    const d = snackSaleReceipt(sale());
    const get = (l: string) => d.totals.find((t) => t.label === l)?.value;
    expect(get("Balance due")).toMatch(/45/);
    expect(get("Status")).toBe("UNPAID");
    expect(
      snackSaleReceipt(sale({ payment_mode: "Cash" })).totals.find(
        (t) => t.label === "Status",
      )?.value,
    ).toBe("PAID");
  });
  for (const paper of ["80mm", "58mm", "a4", "a5"] as const)
    for (const templateStyle of ["classic", "premium"] as const)
      it(`${paper}/${templateStyle}: Balance due prints BELOW the grand-total row, nothing is clipped`, () => {
        const d = snackSaleReceipt(sale());
        const { calls } = render(d, { paper, templateStyle });
        const yOf = (re: RegExp) => calls.find((c) => re.test(c.text))?.y;
        const grand = yOf(/GRAND TOTAL/i);
        const bal = yOf(/Balance due/i);
        expect(grand).toBeDefined();
        expect(bal).toBeDefined();
        expect(bal!).toBeGreaterThan(grand!);
        // money / qty values must never be ellipsised
        for (const c of render(investmentReceiptDoc(inv({ note: "Net" })), {
          paper,
          templateStyle,
        }).calls)
          if (
            /^(Rs|-Rs)\b/.test(c.text) ||
            /^\d+( crt| courts?)?$/.test(c.text)
          )
            expect(c.text).not.toContain("…");
      });
});

describe("generated numbers, file names, text", () => {
  it("payment/statement numbers lead with YYYYMMDD", () => {
    const p = paymentReceipt({
      customer: "A",
      against: "x",
      amount: 1,
      mode: "Cash",
      balanceAfter: 0,
    });
    expect(p.docNo).toMatch(/^PAY-20\d{6}-\d{6}$/);
    const st = customerStatementReceipt({
      customer: "A",
      lines: [],
      totalSpent: 0,
      totalPaid: 0,
      totalOutstanding: 0,
    });
    expect(st.docNo).toMatch(/^STMT-20\d{6}-\d{6}$/);
  });
  it("safeFilePart strips path/reserved characters", () => {
    expect(safeFilePart("A/B: Test?*")).toBe("AB-Test");
    expect(safeFilePart("///", "customer")).toBe("customer");
    expect(
      paymentReceipt({
        customer: "A/B: C",
        against: "x",
        amount: 1,
        mode: "Cash",
        balanceAfter: 0,
      }).fileName,
    ).not.toMatch(/[\\/:*?"<>|]/);
  });
  it("receiptText keeps its blank separator lines and the shared currency symbol", () => {
    const t = receiptText(
      snackSaleReceipt({
        id: "s",
        bill_no: "SB-1",
        sale_date: "2026-10-04",
        customer_name: "Ravi",
        items: [
          {
            item_name: "Tea",
            qty: 2,
            unit_price: 10,
            cost_price: 4,
            amount: 20,
          },
        ],
        total: 20,
        profit: 12,
        payment_mode: "Cash",
        notes: null,
      } as SnackSale),
    );
    expect(t).toContain("\n\n");
    expect(t).toContain("2 × Tea");
    expect(t).not.toContain("₹");
    expect(t).toContain("Rs 20");
  });
});
