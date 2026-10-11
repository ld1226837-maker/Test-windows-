# Separate Advance / Balance split - receipts, copy/WhatsApp text, Excel (2026-10-11)

Display / export only. No calculation, schema, backup or payment logic changed.

## Receipt (PDF / print), booking and bill
- The single combined "Mode: Cash Rs 2,055 + UPI Rs 1,045" row is gone when a booking was paid in two stages.
  It is replaced by two rows: "Advance mode: Cash Rs 300 + UPI Rs 200" and "Balance mode: Cash Rs 1,755 + UPI Rs 845".
- "Balance paid" is now its own line in the items table (negative, with its own split under it), next to "Advance paid".
- A booking/bill paid in one go still prints one "Mode" row, exactly as before.
- Merged bills with a separate turf balance no longer print the combined "Split payment" and "Turf paid" rows
  (advance and balance already print on their own lines).

## Copy / WhatsApp text
- Same rows carried through: "Advance mode: ..." and "Balance mode: ..." instead of one "Mode: ...".

## Excel (Turf bookings sheet - Turf tab and Reports)
- Removed the combined "Split detail" column for turf bookings.
- New columns: "Advance - Cash", "Advance - Online", "Advance split", "Balance split", "Full payment split".
  (Balance Cash / Online were already "Remaining collected - Cash / Online".)
- "Turf payments" sheet is unchanged: one row per payment, tagged Advance / Remaining.
- Turf tab on-screen "Split pay" line now reads "Advance ... - Balance ..." instead of one combined total.

## Not changed
- Bills / Snack sales Excel sheets still use the existing "Split detail" column (their payment rows carry no stage).

## Files
src/lib/remaining-summary.ts, src/lib/turf-payments.ts, src/lib/receipt.ts, src/components/app/TurfTab.tsx
Tests: turf-split-receipt.test.ts, turf-payments.test.ts (updated + new).

## Verified (real toolchain)
tsc clean both; 547/547 tests across 37 export/receipt/payment/merge/turf/bill/share/dues/analytics files, both repos.
The complete suite was not run to the end (it exceeds the sandbox time limit).
