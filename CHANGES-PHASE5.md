# CHANGES-PHASE5 (fixes for the Phase 5 audit, in the suggested order)

Same change in the Windows and Android trees. Full test suite green in both
(Windows 1419, Android 1438 tests), typecheck and lint clean.

| # | Change |
|---|--------|
| A1 | Printed / PDF / Copy / WhatsApp **bill** reads the running tab (`lib/receipt-tab.ts`, fed by `useReceiptPaymentIndex`). A bill moved to dues (or saved "On tab") prints "MOVED TO DUES", a "moved to the customer's tab" note, and `balanceDue` 0 (no second UPI demand). `billReceipt(bill, tabEntries?)` also accepts the ledger directly. |
| A2 | **Snack** receipt owed amount comes from the same rule as the Snacks screen (`netTabAmountFor`). Cleared tab charge -> PAID, `balanceDue` 0. No loaded ledger -> old behaviour (On tab owes its total). |
| A3 | **Booking** receipt uses the shared `isCancelled` (No-show owes 0), prints real cash collected (`bookingCashCollected`) and is tab-aware. |
| A4 | Bill and snack print status uses the screen/Excel words: CANCELLED / MOVED TO DUES / PENDING / PAID. Booking status is left as its real lifecycle word (Confirmed, No-show ...), as on the Turf screen. |
| A5 | Excel: a bill moved to the tab exports Status "Moved to dues" (Balance 0), no longer "Paid". Wording choice: change it in `bill-export.ts` if you prefer "Pending". |
| A6 | Excel: a cancelled bill exports Paid 0 / Balance 0 / Cancelled (same as Reports). `billExportStatus` now returns Paid too. |
| A7 | WhatsApp daily summary: "Pending dues" is the Dashboard's all-time figure (`pendingMoneyIndex`); "Snack bills" excludes voided/merged sales. Turf booking count unchanged (Dashboard counts visits the same way). |
| B1 | Pay-via-UPI amounts use shared helpers: bill dialog = `billDue`; moved snack sale = `pendingAmount`; paid snack sale = `snackSaleGrossTotal`. |
| B2 | Payment ceiling in `payments.ts` taxes a legacy row (no `tax_amount`) at the live rate, like `grossWithTax`, so the printed Grand Total can always be collected. |

Tests: `suite-phase5.test.ts` (new); updated `suite-consistency`, `receipt`,
`receipt-output-regressions`, `merge-pending` for the new status words.

Not changed: B3, B4, C1, C2, A8 (gaps / legacy / unverified, no wrong number to fix).
Note on A2: a general payment on the tab does not reduce a single sale's amount
in this app, so the snack receipt only differs from before once that sale's tab
charge is cleared (void / merge reversal). Receipt and screen now follow one rule.
