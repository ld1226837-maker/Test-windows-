import { InvoiceBrandingCard } from "./InvoiceBrandingCard";
import { PrintSettingsCard } from "./PrintSettingsCard";

/**
 * One Settings destination for everything about generated documents, in five
 * groups: 1 business identity & artwork, 2 invoice layout, 3 paper & printer,
 * 4 receipt content, 5 output options (plus test / preview of every document
 * type). Both halves still read and write the same `usePrintSettings` store,
 * so no stored value, migration or default changes. GST and invoice
 * numbering stay in "Billing & tax".
 */
export function BillsPrintingCard() {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Branding, paper and layout apply to sales bills, booking bills and snack
        receipts. Expenses and investments print as their own voucher and
        statement using the same header. GST and invoice numbering are in
        Billing &amp; tax.
      </p>
      <PrintSettingsCard branding={<InvoiceBrandingCard embedded />} />
    </div>
  );
}
