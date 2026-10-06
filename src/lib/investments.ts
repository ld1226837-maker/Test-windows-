import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  db,
  newId,
  nextInvestmentBillNo,
  nowIso,
  type InvestmentRow,
} from "./localdb";
import { rowsForYears, useYearWindow } from "./years";
import { decimalRupees, rupeePaise } from "./money";
import { formatDMY } from "./biz";
import { readPrintSettings } from "./print";
import { uploadReceipt } from "./expenses";
import { safeFilePart } from "./file-names";
import { purgeReceiptIfUnreferenced } from "./receipt-storage";
import {
  saveExportFile,
  saveToInvoicesFolder,
  isAndroid,
  isDesktop,
  revealInFolder,
} from "./desktop";
import { INVOICE_SECTIONS } from "./desktop";
import { exportWorkbook, type SheetRow } from "./xlsx";
import type { ReceiptDoc } from "./receipt";

export type Investment = InvestmentRow;
export const INVESTMENT_CATEGORIES = [
  "Equipment",
  "Furniture",
  "Infrastructure",
  "Technology",
  "Supplies",
  "Other",
] as const;
export const INVESTMENT_PAYMENT_MODES = ["Cash", "UPI", "Card"] as const;
export type InvestmentSortKey =
  "date" | "amount" | "category" | "payment_mode" | "bill_no";
export type InvestmentSortDirection = "asc" | "desc";

export type InvestmentExportRow = {
  "Bill number": string;
  ID: string;
  Date: string;
  Amount: number;
  Category: string;
  Purpose: string;
  "Payment mode": string;
  "Bill photo": string;
};

export function sortInvestments(
  rows: InvestmentRow[],
  key: InvestmentSortKey,
  direction: InvestmentSortDirection,
) {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av =
      key === "date"
        ? a.investment_date
        : key === "amount"
          ? a.amount
          : key === "category"
            ? (a.category ?? "")
            : key === "payment_mode"
              ? (a.payment_mode ?? "")
              : (a.bill_no ?? "");
    const bv =
      key === "date"
        ? b.investment_date
        : key === "amount"
          ? b.amount
          : key === "category"
            ? (b.category ?? "")
            : key === "payment_mode"
              ? (b.payment_mode ?? "")
              : (b.bill_no ?? "");
    if (typeof av === "number" && typeof bv === "number")
      return (av - bv) * sign;
    return (
      String(av).localeCompare(String(bv), "en", {
        numeric: true,
        sensitivity: "base",
      }) * sign
    );
  });
}

export function investmentsToExportRows(
  rows: InvestmentRow[],
): InvestmentExportRow[] {
  return rows.map((row) => ({
    "Bill number": row.bill_no ?? "",
    ID: row.id,
    Date: row.investment_date,
    Amount: row.amount,
    Category: row.category ?? "",
    Purpose: row.note ?? "",
    "Payment mode": row.payment_mode ?? "",
    "Bill photo": row.receipt_path ? "Attached" : "",
  }));
}

export async function exportInvestmentsToExcel(
  rows?: InvestmentRow[],
): Promise<boolean> {
  const source =
    rows ?? (await db.investments.toArray()).filter((row) => !row.deleted_at);
  return exportWorkbook(
    [
      {
        name: "Investments",
        rows: investmentsToExportRows(source),
        moneyColumns: ["Amount"],
        title: "Investments",
      },
    ],
    "investments",
    INVOICE_SECTIONS.reports,
  );
}

export function useInvestments() {
  const { years } = useYearWindow();
  return useQuery({
    queryKey: ["investments", years],
    initialData: [],
    queryFn: async () =>
      (await rowsForYears<InvestmentRow>("investments", years)).filter(
        (x) => !x.deleted_at,
      ),
  });
}
export function useAllInvestments() {
  return useQuery({
    queryKey: ["investments", "all"],
    initialData: [],
    queryFn: async () =>
      (await db.investments.toArray()).filter((x) => !x.deleted_at),
  });
}
export function useInvestmentTotals() {
  const { data = [] } = useInvestments();
  const { data: all = [] } = useAllInvestments();
  return {
    period:
      Number(data.reduce((sum, x) => sum + rupeePaise(x.amount), 0n)) / 100,
    allTime:
      Number(all.reduce((sum, x) => sum + rupeePaise(x.amount), 0n)) / 100,
  };
}

export function useSaveInvestment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id?: string;
      amount: number;
      investment_date: string;
      note?: string | null;
      category?: string | null;
      payment_mode?: string | null;
      receipt_path?: string | null;
    }) => {
      const amount = decimalRupees(payload.amount);
      if (amount <= 0)
        throw new Error("Investment amount must be greater than zero");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.investment_date))
        throw new Error("Investment date is required");
      if (
        payload.payment_mode &&
        !INVESTMENT_PAYMENT_MODES.includes(
          payload.payment_mode as (typeof INVESTMENT_PAYMENT_MODES)[number],
        )
      )
        throw new Error("Payment method must be Cash, UPI or Card");
      const existing = payload.id
        ? await db.investments.get(payload.id)
        : undefined;
      const previousReceiptPath = existing?.receipt_path ?? null;
      const billNo =
        existing?.bill_no ??
        (await nextInvestmentBillNo(payload.investment_date));
      const row: InvestmentRow = {
        ...payload,
        id: payload.id ?? newId(),
        amount,
        bill_no: billNo,
        category: payload.category ?? existing?.category ?? null,
        created_at: existing?.created_at ?? nowIso(),
        updated_at: nowIso(),
        deleted_at: existing?.deleted_at ?? null,
        note: payload.note ?? null,
        payment_mode: payload.payment_mode ?? null,
        receipt_path: payload.receipt_path ?? null,
      };
      await db.investments.put(row);
      if (previousReceiptPath && previousReceiptPath !== row.receipt_path)
        await purgeReceiptIfUnreferenced(previousReceiptPath);
      return row;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
    },
  });
}
export function useDeleteInvestment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (row: InvestmentRow) =>
      db.investments.update(row.id, {
        deleted_at: nowIso(),
        updated_at: nowIso(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      // Same as save: a deleted investment must leave the dashboard totals.
    },
  });
}
export async function addInvestmentPhoto(file: File, date: string) {
  return uploadReceipt(file, date);
}

/** Paise-exact amount in the receipt's own style ("Rs 1,25,000.50"): the
 * currency symbol from Print Settings and Indian digit grouping like every
 * other receipt figure. (moneyDecimal prints a rupee sign the PDF font can't
 * draw, so the total used to print with no currency at all.) */
export function investmentAmountText(amount: unknown) {
  const sym = (readPrintSettings().currencySymbol || "Rs").trim();
  const paise = rupeePaise(amount);
  const whole = Number(paise / 100n).toLocaleString("en-IN");
  const minor = String(paise % 100n).padStart(2, "0");
  return `${sym ? `${sym} ` : ""}${whole}${minor === "00" ? "" : `.${minor}`}`;
}

/** The receipt document for an investment — shared by the PDF export and the
 * Print / WhatsApp / Copy row actions so all of them show the same content.
 *
 * One line (the purpose, with its category underneath) carrying the real
 * amount; category / payment method are printed as totals rows above the
 * Amount bar instead of a tiny italic footnote. No quantity column value —
 * an investment is always a single item, and a blank qty used to print "1"
 * next to "Rs 0". */
export function investmentReceiptDoc(row: InvestmentRow): ReceiptDoc {
  const amountText = investmentAmountText(row.amount);
  const docNo = row.bill_no || `INVES-${row.id.slice(0, 8).toUpperCase()}`;
  const dateText = formatDMY(row.investment_date);
  return {
    kind: "Investment",
    variant: "investment",
    title: "Investment statement",
    // Statement field order: identity, when, what, how funded, attachment.
    details: [
      { label: "Statement No.", value: docNo },
      { label: "Date", value: dateText },
      ...(row.category ? [{ label: "Category", value: row.category }] : []),
      {
        label: "Purpose",
        value: row.note?.trim() || "Business investment",
      },
      ...(row.payment_mode
        ? [{ label: "Paid via", value: row.payment_mode }]
        : []),
      ...(row.receipt_path
        ? [{ label: "Bill photo", value: "Attached (last page)" }]
        : []),
    ],
    docNo,
    dateText,
    lines: [
      {
        label: row.note?.trim() || "Business investment",
        ...(row.category ? { sub: row.category } : {}),
        amount: Number(row.amount),
        amountText,
      },
    ],
    totals: [
      ...(row.category ? [{ label: "Category", value: row.category }] : []),
      ...(row.payment_mode
        ? [{ label: "Payment method", value: row.payment_mode }]
        : []),
      ...(row.receipt_path
        ? [{ label: "Receipt photo", value: "Attached" }]
        : []),
      { label: "Amount", value: amountText, strong: true },
    ],
    fileName: `investment-${safeFilePart(row.bill_no ?? row.id.slice(0, 8))}`,
    // Print / PDF / Share append this photo as the last page.
    photoPath: row.receipt_path ?? null,
  };
}

export async function investmentInvoice(row: InvestmentRow): Promise<boolean> {
  const { buildReceiptPdfWithPhoto } = await import("./receipt");
  const doc = investmentReceiptDoc(row);
  // strict: this export promises the receipt photo is in the file, so a
  // missing/unreadable photo is an error here rather than a silent omission.
  const pdf = await buildReceiptPdfWithPhoto(doc, undefined, { strict: true });
  const bytesOut = new Uint8Array(pdf.output("arraybuffer") as ArrayBuffer);
  if (isAndroid())
    return (
      await saveExportFile(bytesOut, `${doc.fileName}.pdf`, "application/pdf")
    ).saved;
  if (isDesktop()) {
    const path = await saveToInvoicesFolder(
      bytesOut,
      `${doc.fileName}.pdf`,
      INVOICE_SECTIONS.investments,
    );
    await revealInFolder(path);
    return true;
  }
  pdf.save(`${doc.fileName}.pdf`);
  return true;
}
