import { rupees } from "./money";
import { describePaymentSplit, effectivePaymentEntries } from "./payments";
import type { PaymentSourceRecord, EffectivePaymentEntry } from "./payments";
import { isOnlinePaymentMode } from "./ops";
import type { PaymentParentType, PaymentRow } from "./localdb";

/**
 * Cash / Online / Split columns for the Excel exports of bills (including
 * merged bills), snack sales and turf bookings.
 *
 * EXPORT ONLY — nothing here writes data or feeds a calculation. The figures
 * come from effectivePaymentEntries (payments.ts), the same function the
 * Dashboard's payment split and the cash drawer use, so a sheet can never
 * disagree with the rest of the app about what was paid in cash or online.
 */

export const PAYMENT_MODE_MONEY_COLUMNS = ["Paid - Cash", "Paid - Online"];

export type PaymentType =
  "Cash" | "Online" | "Split (Cash + Online)" | "Not paid";

export type PaymentModeColumns = {
  /** Cash actually received (every non-online mode). */
  "Paid - Cash": number;
  /** Online actually received (UPI, Card, ...). */
  "Paid - Online": number;
  "Payment type": string;
  /** e.g. "Cash ₹400 + UPI ₹300"; the single mode when not split; "" when
   * nothing was paid. */
  "Split detail": string;
};

const EMPTY: PaymentModeColumns = {
  "Paid - Cash": 0,
  "Paid - Online": 0,
  "Payment type": "Not paid",
  "Split detail": "",
};

/** Folds a record's effective payment entries into the export columns. */
export function modeColumnsFromEntries(
  entries: Pick<EffectivePaymentEntry, "amount" | "mode">[],
): PaymentModeColumns {
  let cash = 0;
  let online = 0;
  const live = entries.filter((e) => e.amount > 0);
  for (const e of live) {
    if (isOnlinePaymentMode(e.mode)) online += e.amount;
    else cash += e.amount;
  }
  cash = rupees(cash);
  online = rupees(online);
  if (cash <= 0 && online <= 0) return { ...EMPTY };
  const type: PaymentType =
    cash > 0 && online > 0
      ? "Split (Cash + Online)"
      : online > 0
        ? "Online"
        : "Cash";
  const split = describePaymentSplit(live);
  const single = live[0]?.mode || "Cash";
  return {
    "Paid - Cash": cash,
    "Paid - Online": online,
    "Payment type": type,
    "Split detail": split ?? single,
  };
}

/**
 * One lookup for a whole sheet: record id -> Cash/Online/Split columns.
 * `records` carry the already-computed collected figure (billCollected /
 * snackSaleCollected / bookingCashCollected), exactly like analytics does.
 */
export function buildPaymentModeLookup(
  parentType: PaymentParentType,
  records: PaymentSourceRecord[],
  payments: PaymentRow[],
): (id: string) => PaymentModeColumns {
  const entries = effectivePaymentEntries({ [parentType]: records }, payments);
  const byId = new Map<string, EffectivePaymentEntry[]>();
  for (const e of entries) {
    const list = byId.get(e.parent_id);
    if (list) list.push(e);
    else byId.set(e.parent_id, [e]);
  }
  return (id) => {
    const list = byId.get(id);
    return list ? modeColumnsFromEntries(list) : { ...EMPTY };
  };
}

/**
 * Columns for a record that was merged into a bill. Its money lives on the
 * bill (the bill carries a copy of its payment rows), so the numeric columns
 * stay 0 — a plain SUM() over the sheet must not count the same rupees twice,
 * the same convention the Amount columns already use — while the text columns
 * still say how it was paid.
 */
export function mergedModeColumns(
  cols: PaymentModeColumns,
): PaymentModeColumns {
  return {
    "Paid - Cash": 0,
    "Paid - Online": 0,
    "Payment type":
      cols["Payment type"] === "Not paid"
        ? "Not paid"
        : `${cols["Payment type"]} (paid on merged bill)`,
    "Split detail": cols["Split detail"],
  };
}
