# Advance vs balance (split pay) - receipts, merge, Excel (2026-10-11)

Problem: a booking paid in two stages (advance, then balance, each possibly split
Cash + UPI) printed confusingly: Mode / note described only the advance next to a
Paid figure that included the balance, and a merged bill called ALL turf money
"Advance paid".

Definitions used everywhere now
- Advance            = first collection (every part of a split within 1 s). Never becomes "total paid".
- Payable after advances = grand total - advance.
- Balance paid       = everything collected after the advance (printed only when both exist).
- Paid               = advance + balance. Remaining = grand total - paid.
- Mode               = split of ALL money in Paid (adds up to Paid).

Changes (display only - no schema, backup or money-calculation change)
- lib/receipt-payments.ts: the receipt payment index is refreshed during render, not in an
  effect, so a receipt built right after a payment no longer uses the previous rows
  (that printed only the advance split/note beside the new Paid total).
- lib/remaining-summary.ts: new "Balance paid" row, advance split detail, and note wording
  "Advance Rs 500 via Cash Rs 300 + UPI Rs 200 on D; Balance Rs 3,500 via Cash Rs 450 + UPI Rs 3,050 on D. Remaining Rs 0 - settled in full."
- lib/payments.ts: firstBatchRows / advanceOfRows (pure), receiptAdvanceAmount uses them.
- lib/receipt.ts, lib/share-text.ts: "Advance paid" line shows its split; "Balance paid" row on
  booking, bill and WhatsApp/copy text.
- Merge: lib/merge.ts turfAdvanceBalance + MergedBreakdown.turf_first / turf_first_modes /
  turf_balance_modes (optional, new merges only). Merged bill prints "Advance paid" and
  "Balance paid" separately; the merge dialog preview shows turf advance + turf balance.
  Older merged bills (no turf_first) print exactly as before.
- Excel: column "Advance paid" (total cash taken) renamed "Total paid so far"; "Advance (first
  payment)" is 0 for a booking paid in one collection.

Tests: lib/turf-split-receipt.test.ts (Amir Parpia example, arrived + completed, text, merge),
remaining-summary.test.ts wording updated.
