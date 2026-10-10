# Turf quick-pay buttons, "Remaining paid" note, split-pay Excel data

Applied identically to Windows and Android (Android keeps its own button sizes).
No calculation changed: totals, tax, bookingDue, bookingCashCollected, drawer,
Cash/Online split and revenue/dues reports read the same functions as before.

## App
- `src/components/app/QuickPayRow.tsx`: shared `QuickPayControls` (Paid · Cash,
  Paid · UPI, Split cash + online, Part payment + Record). `QuickPayRow` (bills,
  incl. merged) keeps its API; new `TurfQuickPayRow` uses `useCollectBookingPayment`
  with `markCompleted: true`, exactly like "Mark paid".
- `src/components/app/TurfTab.tsx` (booking cards): quick-pay buttons when due > 0
  and the booking is not cancelled / merged / moved to dues; "Turf only" badge;
  "Remaining paid" badge + note line ("Advance ₹X · Remaining paid ₹Y (Cash + UPI) on date");
  "Split pay · Cash ₹.. + UPI ₹.." line. Turf tab Excel gets the same columns.
- `src/lib/turf-payments.ts` (new, pure, display/export only): advance vs remaining
  split from payment rows (first collection = advance, later = remaining), split labels.

## Excel (`ReportsTab.tsx`, monthly + all-time exports)
"Turf bookings" sheet, new columns appended after the old ones: Booking type,
Advance (first payment), Remaining collected, Remaining collected - Cash/Online,
Remaining collected on, Remaining status, Total collected - Cash/Online,
Payment split, Split detail, Split pay used.
New "Turf payments" sheet: one row per payment (Booking ID, Customer, Phone,
Payment date, Mode, Amount, Payment stage, Split pay, Booking type).
"Outstanding dues" sheet: + Booking type, Remaining collected, Remaining status.

## Tests
`src/lib/turf-payments.test.ts` (10 tests). Not yet run under vitest in this
environment (no node_modules / network); logic was run against stubs: 10/10 pass.
Run `npm test` and `npm run build` / tsc in both repos before shipping.

## Update: confirm pop-up + Layout & arrangement registration
- Every turf quick-pay path (Paid · Cash, Paid · UPI, Split, Part payment) now ends in a
  "Confirm payment" pop-up showing the booking, each mode/amount and the due left after;
  nothing is recorded until Confirm. Split / Part still pick the modes first, then confirm.
  Bills (merged bill) keep their original flow (`confirmSummary` is turf-only).
- `src/lib/layout-parts.ts`: the four booking-card controls are registered as parts of
  `turf.bookings` (`pay-cash`, `pay-upi`, `pay-split`, `pay-part`) so they can be shown/hidden
  from Layout & arrangement; the confirm pop-up is registered as `surface.turf-pay-confirm`
  (parts: summary [locked], due-after, actions [locked]) and wired with LayoutParts/LayoutPart.
- `layout-registry-coverage.test.ts`: new checks for the four parts and the surface.
- Not registered (unchanged): the shared "Collect for ..." dialog (CollectPaymentDialog).

## Verification: no calculation changed
- Files changed vs the uploaded zips: QuickPayRow.tsx, TurfTab.tsx, ReportsTab.tsx, layout-parts.ts,
  layout-registry-coverage.test.ts, plus new turf-payments.ts / turf-payments.test.ts. No change to
  dues.ts, payments.ts, collect.ts, biz.ts, money.ts, analytics.ts, merge*.ts, receipt*.ts or localdb.ts.
- TurfTab.tsx: only additions (the sole removed line is the `useBills` import, now `useBills, usePayments`).
- ReportsTab.tsx: only the "Outstanding dues" row builders were replaced; every original key/value is kept.
- turf-payments.ts is read-only (no DB access, no writes, inputs not mutated).
- Turf-tab Excel: new columns are appended at the END of each row (old column positions unchanged).
- Money still flows only through collectBookingPayment / collectBillPayment -> recordPayment.
