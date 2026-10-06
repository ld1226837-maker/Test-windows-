import { dayKey } from "./analytics";
import { formatDMY } from "./biz";
import { expenseReceiptDoc } from "./expense-receipt";
import { investmentReceiptDoc } from "./investments";
import type { ReceiptDoc } from "./receipt";

/** The three document families the app prints. Sales is every bill, booking
 * bill and snack receipt; expenses and investments have their own designs. */
export type SampleDocumentKind = "sales" | "expense" | "investment";

export const SAMPLE_DOCUMENT_OPTIONS: {
  id: SampleDocumentKind;
  label: string;
}[] = [
  { id: "sales", label: "Sales bill" },
  { id: "expense", label: "Expense voucher" },
  { id: "investment", label: "Investment statement" },
];

/** Representative documents for the "Bills & printing" preview and test
 * print. They are built by the SAME builders the real Print / PDF / Share
 * actions use, so the preview cannot drift from real output. */
export function sampleDocument(kind: SampleDocumentKind): ReceiptDoc {
  const today = dayKey(new Date());
  if (kind === "expense")
    return {
      ...expenseReceiptDoc({
        id: "sample000000",
        expense_no: "EXP-SAMPLE-001",
        business: "Turf",
        category: "Maintenance",
        description: "Net repair and ground levelling",
        note: "Sample voucher",
        amount: 1250.5,
        spent_at: today,
        receipt_path: null,
        payment_mode: "UPI",
      }),
      fileName: "print-test-expense",
    };
  if (kind === "investment")
    return {
      ...investmentReceiptDoc({
        id: "sample000000",
        bill_no: "INVES-SAMPLE-001",
        amount: 125000.5,
        investment_date: today,
        note: "Floodlight installation",
        category: "Equipment",
        payment_mode: "Card",
        receipt_path: null,
        created_at: today,
        updated_at: today,
      }),
      fileName: "print-test-investment",
    };
  return {
    kind: "Sample",
    docNo: "TEST-001",
    dateText: formatDMY(today),
    customer: "Test Customer",
    phone: "9876543210",
    lines: [
      { label: "Turf slot", sub: "1 hr x Rs 1,200", amount: 1200 },
      { label: "Tea", sub: "2 x Rs 15", amount: 30 },
    ],
    totals: [{ label: "TOTAL", value: "Rs 1,230", strong: true }],
    fileName: "print-test",
  };
}
