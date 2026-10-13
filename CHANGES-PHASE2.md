# Phase 2 - one cancel model (turf, snacks, invoices)

## Two live bugs found and fixed first (unit tests could never see them)
1. `useSnackSales` dropped `cancelled` when mapping rows to the UI type, so a
   voided snack sale still looked live to the Dashboard, Reports and
   Outstanding. Fixed via exported `toSnackSale`.
2. `useTurfBookings` dropped `refunded_at` / `refund_mode`, so a refunded
   advance never left the refundable liability and never reached the drawer
   outflow. Fixed via exported `toTurfBooking`.
Both mappers now have a test that fails if a stored field is dropped again.
Expect Dashboard / Reports numbers to change on real data where a sale was
voided or an advance refunded: they were wrong before.

## What changed
- `src/lib/record-state.ts` (no imports) + `src/lib/bill-state.ts`:
  `isLive`, `isCancelled` (turf Cancelled AND No-show, snack cancelled, bill
  cancelled), `isPending`, `pendingAmount`, `pendingLabel`. The core sits in
  its own file only so dues.ts can use it without an import cycle.
- Every status-string comparison in lib/ and components/ now uses the helpers
  (dues, analytics, courts, receipt, biz, owner-bills, data, Dashboard,
  Reports, Turf, Snacks, Bills, Customer dialog, WhatsApp card). No-show now
  behaves like Cancelled in dues, revenue, Reports cancelled count, calendar.
- Refund model for invoices and snack sales: optional `is_refundable`,
  `refunded_at`, `refund_mode`, `refund_amount` (no field removed or renamed;
  unset = legacy cancelled record = holds nothing, so old numbers are unchanged).
  dues.ts has the bill/sale functions; analytics feeds forfeited / refundable
  money into the split and the drawer outflow covers all three kinds.
  `drawerCashOn()` is the single drawer formula (Dashboard uses it).
- `cancelInvoice` / `previewCancelInvoice` / `cancelInvoiceEffects` (merge.ts):
  merged invoice asks "invoice only (bills come back separately)" vs "invoice
  and its turf/snack bills" with the effects listed, then refund-or-keep.
- `voidSnackSale` (cancel-flows.ts): refund-or-keep; an On-tab sale can now be
  voided (tab charge reversed on its own tab). Same invalidation list as the
  invoice void (`VOID_QUERY_KEYS`).
- Marking a bill unpaid after payments now requires an explicit refund
  (`updateBillStatus`); nothing is deleted silently.
- UI: `CancelInvoiceDialog`, `MoneyDecisionDialog`; registry surfaces
  `surface.cancel-invoice.*` and `surface.money-decision.*` (coverage test
  passes).
- docs/calculation-rules.md updated.

## Tests added (both repos)
bill-state.test.ts (9), cancel-flows.test.ts (16 + 1 expected-fail),
cancelled-model.test.ts (9).

## Rules I was unsure about (please decide)
1. **F-DRAWER (real, pre-existing).** Cash received and refunded the same day
   leaves the drawer at -500, not 0: a refunded receipt is dropped from the
   Cash/UPI split AND the refund is subtracted. This is the existing turf rule
   (K4); I mirrored it so all three kinds agree, and marked the correct
   expectation with `it.fails`. Fix = keep refunded receipts in the split on
   their receipt day (then `collected` includes money later refunded). Tell me
   which you want before I change it.
2. Turf refunds are two-step (mark refundable, later "refund"); invoices and
   snack bills refund immediately ("paid back now"). Say if turf should match.
3. "Mark unpaid" after payments: the choices are Refund (then unpaid) or Keep
   (leave the bill as it is). A forfeited-but-still-unpaid live bill makes no
   sense, so "keep" means no change. One refund per bill; a second is refused.
4. Cancel-invoice-and-sources keeps the sources linked to the invoice (their
   money lives on it), so a cancelled source shows "Cancelled" but is not a
   separate refund line.
5. Deleting a bill still removes its receipts after an explicit confirm; it is
   a hard delete, not a cancel, so it has no refund question.
