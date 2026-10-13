# Phase 0 report - "I cannot generate the merged bill without payment"

Reproduced against `src/lib/merge.ts` + `src/components/app/MergeBillDialog.tsx`
with `src/lib/phase0-repro.test.ts` (real Dexie via fake-indexeddb, 7 tests, all
pass). No production code was changed in Phase 0.

## Steps and results

| # | Scenario | Result |
|---|----------|--------|
| S1 | Turf advance 0 + snack paid Cash, name typed, tab box off | Bill created: status `partial`, amount_paid 100, total 1100 |
| S2 | Nothing paid anywhere (turf advance 0, snack On tab), name typed, tab box off | Bill created: status `unpaid`, amount_paid 0, payment_mode null. `billDue` = 1100, counted once |
| S3 | Same as S2, tab box on | Bill created: `unpaid`, payment_mode "On tab", `billDue` 0, one 1100 charge on the tab. Counted once |
| S4 | Same as S2 but customer name EMPTY | `mergeIntoBill` throws "Customer name is required for a merged bill" |
| S5 | Merge the same booking twice | 2nd refused: "Booking B-1 is already on another bill"; merged booking leaves candidates (`isFinancialBooking` false) |
| S6 | Booking whose balance is already on the tab | Still a candidate (`isFinancialBooking` true) |
| S7 | Cancelled / No-show booking | Hidden from candidates |

## Verdict per suspect

1. **Tab checkbox disabled until a name is typed - CONFIRMED (blocker, with 5).**
   `disabled={!name.trim()}`. The only way to leave a due on the customer is
   this box, and it is dead while the name is empty.
2. **Label does not say UNPAID - CONFIRMED (misleading).** It reads "Put the
   balance on X's due tab". Nothing says the invoice will be generated
   unpaid, and the unticked path (bill carries the due) is not described at
   all. The owner reads "disabled + tab" as "payment is required".
3. **Booking/snack creation needs an advance - NOT A BLOCKER.** TurfTab accepts
   advance 0 (`Number(form.advance_paid) || 0`, no error). Snack sales are
   always Cash/UPI/On tab; "On tab" is already the pending state.
4. **Source hidden from the list - PARTIAL.** Bookings/sales already merged,
   Cancelled, No-show or voided are hidden (correct). Tab-moved ones stay
   visible (S6). The real problem is the list: global (not per customer),
   newest 5 only, ONE shared "Show 5 more" button placed under the snack list,
   so an older pending booking for the customer is easy to miss.
5. **Error toast - CONFIRMED (the blocker).** `save()` toasts "Customer name is
   required" and returns before anything is written. A snack sale may have no
   customer name (name-only identity, step 26), so a snack-only or
   snack+walk-in-booking merge has nothing to put in the name box.

## Conclusion

The data layer already supports a zero-payment merge (S2, S3). What blocks the
owner is the dialog: a mandatory typed name (suspects 1 + 5), an unlabelled
tab checkbox (2) and a candidate list that is not grouped by customer (4).

## Side finding for Phase 2

`BillsTab.tsx` "Marked unpaid" sets `amount_paid: 0` with no refund-or-keep
question, and Phase 2 must route it through the new refund model.
