# Phase 3 - pending everywhere (+ the drawer fix chosen after Phase 2)

## Decisions taken (owner said "choose the wise option")
1. F-DRAWER fixed properly: a cancelled record's receipt stays in the Cash/UPI
   split on the day it arrived; the refund is a separate outflow on the day it
   was paid back. Same-day cash refund now nets the drawer to 0 (was -X).
2. Turf refunds stay two-step (existing flow). 3. Mark-unpaid: refund or no
   change. 4. Hard delete of a bill stays a confirmed delete.

## What changed
- One badge, one wording: `Pending Rs X` (`pendingLabel`) via
  `paymentStateLabel` / `saleStateLabel`, shown in Turf, Snacks, Bills,
  Customers, Outstanding and the dues card ("Pending money"). A tab-owed
  booking shows only that badge. Printed bills / WhatsApp bill text keep the
  established "Remaining to be paid" line (dozens of receipt tests and
  templates depend on it) - say if you want that renamed too.
- One-tap merge on Outstanding rows (`mergePendingForCustomer`): pending
  booking + tab-owed snack bill -> ONE pending invoice.
- Payments on a merged invoice (`collectBillPayment`) are mirrored onto the
  source bookings (history), counted once in split/drawer. Money the bookings
  cannot carry (a snack part) stays on the invoice; "cancel invoice only" is
  refused while such money exists (it would vanish), with a clear message.
- Bug fixed: `bill-state` mistook a snack sale for a booking whenever the sale
  carried a `booking_no` (every sale linked to a booking).

## Tests added (both repos)
pending-everywhere.test.ts (7), bill-state (+1), cancelled-model (+1),
cancel-flows F-DRAWER now a real test. Windows 1397/1397, Android 1416/1416;
tsc and eslint 0 errors; the two 30k-photo stress tests were not run.

## Still open
- Phase 4: SUITE-AUDIT.md + per-fix regression tests (not started).
- Snack bills paid directly on a merged invoice are not mirrored (see above).
