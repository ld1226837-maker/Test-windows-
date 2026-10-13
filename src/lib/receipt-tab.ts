import type { TabEntry } from "./tabs";

// Receipts are built synchronously from a record alone (see receipt-payments.ts
// for the payment rows). The running-tab ledger is kept here the same way so a
// printed / copied / WhatsApp bill reads the SAME tab-aware figures the Bills,
// Turf and Snacks screens show. `undefined` = the ledger has not been loaded
// yet, in which case the receipt falls back to the record's own fields.
let receiptTab: TabEntry[] | undefined;

export function setReceiptTabEntries(rows: TabEntry[] | undefined) {
  receiptTab = rows;
}

export function receiptTabEntries(): TabEntry[] | undefined {
  return receiptTab;
}
