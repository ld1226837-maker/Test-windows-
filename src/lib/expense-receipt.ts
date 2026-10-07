import { formatDMY } from "./biz";
import { safeFilePart } from "./file-names";
import { investmentAmountText } from "./investments";
import type { ReceiptDoc } from "./receipt";

/** The fields of an expense row the receipt needs (both the stored row and
 * the Expenses tab's view of it satisfy this). */
export type ExpenseReceiptSource = {
  id: string;
  expense_no: string | null;
  business: string;
  category: string;
  description: string | null;
  note: string | null;
  amount: number;
  spent_at: string;
  receipt_path: string | null;
  payment_mode?: string | null;
  cash_part?: number | null;
};

/**
 * The receipt document for one expense — what the Expenses tab's Print / PDF /
 * Share actions render. Mirrors `investmentReceiptDoc`: one line carrying the
 * paise-exact amount, category / business / payment method as totals rows,
 * and the attached receipt photo (when there is one) appended as the last
 * page by the PDF builder via `photoPath`.
 */
export function expenseReceiptDoc(e: ExpenseReceiptSource): ReceiptDoc {
  const amountText = investmentAmountText(e.amount);
  const docNo = e.expense_no || `EXP-${e.id.slice(0, 8).toUpperCase()}`;
  const label = e.description?.trim() || e.note?.trim() || e.category;
  const description = e.description?.trim() || "";
  const note = e.note?.trim() || "";
  const cashPart = Number(e.cash_part ?? 0);
  const dateText = formatDMY(e.spent_at);
  return {
    kind: "Expense",
    variant: "expense",
    title: "Expense voucher",
    // Voucher field order: identity, when, what for, how paid, attachment.
    // The expense record has no separate payee/vendor field, so "Paid for"
    // carries the description and nothing is invented.
    details: [
      { label: "Voucher No.", value: docNo },
      { label: "Date", value: dateText },
      ...(e.category ? [{ label: "Category", value: e.category }] : []),
      ...(description ? [{ label: "Paid for", value: description }] : []),
      ...(e.business ? [{ label: "Business", value: e.business }] : []),
      ...(e.payment_mode
        ? [{ label: "Payment method", value: e.payment_mode }]
        : []),
      ...(e.payment_mode && e.payment_mode !== "Cash" && cashPart > 0
        ? [{ label: "Paid in cash", value: investmentAmountText(cashPart) }]
        : []),
      ...(e.receipt_path
        ? [{ label: "Receipt photo", value: "Attached (last page)" }]
        : []),
    ],
    note: note && note !== description ? note : null,
    docNo,
    dateText,
    lines: [
      {
        label,
        ...(e.category && e.category !== label ? { sub: e.category } : {}),
        amount: Number(e.amount),
        amountText,
      },
    ],
    totals: [
      ...(e.category ? [{ label: "Category", value: e.category }] : []),
      ...(e.business ? [{ label: "Business", value: e.business }] : []),
      ...(e.payment_mode
        ? [{ label: "Payment method", value: e.payment_mode }]
        : []),
      ...(e.receipt_path
        ? [{ label: "Receipt photo", value: "Attached" }]
        : []),
      { label: "Amount", value: amountText, strong: true },
    ],
    fileName: `expense-${safeFilePart(e.expense_no ?? e.id.slice(0, 8))}`,
    photoPath: e.receipt_path ?? null,
  };
}
