# Remaining amount after advances (display only)

New file: src/lib/remaining-summary.ts (+ remaining-summary.test.ts) in both trees.

Printed on every bill / booking / snack bill:
- "Payable after advances"  = grand total - advances (only when an advance was taken), above "Paid"
- "Remaining to be paid"    = grand total - paid, ALWAYS printed (Rs 0 when settled). Replaces "Balance due" (same value).
- Note after payment, e.g. "Received Rs 2,240 via UPI on 10-10-2026. Remaining Rs 0 - settled in full."
- Payment receipt: "Balance before this payment" + the same note.
- WhatsApp/copy text (receiptText, biz.ts) shows "Remaining to be paid".
- Scan & Pay panel label renamed; still only shown while money is due.

Not changed: biz/dues/merge/payments/collect logic, schema, backups, Excel report column headers.
Tests: only label updates in receipt.test.ts, receipt-output-regressions.test.ts, receipt-premium.test.ts.
Windows: tsc clean, 112 files / 1290 tests pass. Android: tsc clean, 114 files / 1309 tests pass.

All figures are per bill/booking/snack bill only; nothing uses the customer's total dues.
