# Clean copy / WhatsApp text (2026-10-11)

Display text only. No calculation, schema, PDF/print, backup or payment logic changed.

## What was wrong (found by reading the code; not reproduced on a phone)
1. Two layouts: Bill text used `item - qty x rate = total`, booking/snack text used `qty x label (sub) = amount`.
2. Mixed currency: older Bill lines printed the rupee sign, newer lines printed "Rs".
3. Symbols that can garble in WhatsApp / wa.me: middle dot, multiply sign, em dash, rupee sign, non-breaking spaces.
4. Markup in names/notes (`*`, `_`, `~`, backtick) could reformat the message in WhatsApp.
5. Negative "Advance paid" / "Offer" lines were listed as items; blank lines were not collapsed.
6. Merged-bill Mode showed "Split (Cash + UPI)" with no amounts.
7. Very long messages could produce a wa.me link that does not open, with no hint.
(wa.me encoding itself is fine: one encodeURIComponent, newline -> %0A.)

## Fix
- New `src/lib/share-text.ts`: one list of lines, two renderers
  - WhatsApp button: bold headings / Grand total / Remaining, markup characters in names, items and notes neutralised.
  - Copy button: same lines, no markup.
- Order: shop, Bill no | date, Customer, Phone (if shown) / Items (numbered) / Amount ... Grand total / Payment (Payable after advances, Advance collected, Paid, Remaining, Mode, Status) / note / footer.
- ASCII-safe: Rs, x, -, |. No tabs, no leading/trailing spaces, no double blank lines, "\n" only.
- `receiptText(doc, style)` and `billShareText(bill, style)` keep their names; default style is "plain". WhatsApp buttons pass "whatsapp" (RecordActionRow, BillActions, ExpenseActions, InvestmentActions).
- Bill text now comes from the same ReceiptDoc as the PDF, so it cannot drift from it. `billText()` in biz.ts is unchanged and no longer used by the buttons.
- Merged bill: Mode shows amounts (`textMode`), Snacks paid sits in Payment, Advance collected shows the turf advance split.
- RecordActionRow shows a "Long message" toast when the encoded link is over 6000 characters.

## Intentional test changes
- receipt.test.ts: "GRAND TOTAL: Rs 1,200" -> "Grand total: Rs 1,200" (+ WhatsApp variant).
- receipt-output-regressions.test.ts: "2 x Tea" -> "1. Tea - 2 x Rs 10 = Rs 20".
- New share-text.test.ts: golden WhatsApp booking, plain == WhatsApp minus asterisks, merged split, no advance, cancelled, payment receipt, markup names, Tamil name round trip, safe characters, voucher, long message.

## Not verified
- No real WhatsApp send or phone paste was done.
- The full test suite did not finish in the build environment; ran share-text, receipt, biz, remaining, payments, dues, merge, split-payment, tabs, collect (428 tests) + tsc + eslint on changed files in both trees.
- Currency symbol comes from print settings; a custom symbol other than the rupee sign is passed through as typed.

Commit message: Clean up copy and WhatsApp text format
