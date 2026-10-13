# Phase 1 - merged invoice with no payment (pending)

## What changed
- `src/lib/merge.ts`
  - `MergeInput.dueMode: "pending" | "paid"` (new, optional). `putOnTab` is now
    optional and ignored when `dueMode` is given. No stored field added/renamed.
  - `resolveMergeCustomer()`: typed name/phone win; blanks come from the first
    picked record; no name anywhere -> `Walk-in customer`. `mergeIntoBill` no
    longer throws "Customer name is required".
  - `distinctMergeCustomers()`, `orderCandidates()`, `mergeCandidateKey()`,
    `isNamelessCandidate()`: per-customer grouping (phone first, then name);
    filter happens before the lists are sliced.
- `MergeBillDialog.tsx`: explicit "Generate bill as: Pending (customer pays
  later) / Paid / partly paid" choice, per-list "Show 5 more", customer anchor
  from the first ticked item (with "show every customer"), mixed-customer
  warning, payment fields only for "Paid". Payment is recorded through the
  existing `collectBillPayment`. Query invalidation now includes `payments`.
- Layout registry: new parts `surface.merge-bill.warning` and
  `surface.merge-bill.due-mode` (both locked); `preview` relabelled.
  `layout-registry-coverage.test.ts` passes unchanged.
- `docs/calculation-rules.md`: new "Pending merged bill" section.

## Tests added (both repos)
`merge-pending.test.ts` (12) + `phase0-repro.test.ts` (7): zero payment, advance
only, snacks paid + turf unpaid, source already on tab, merge twice refused,
due counted once in Outstanding / Dashboard / Reports (`periodStats().dues`),
settle later, name/phone fallback, walk-in fallback, ASCII copy text, candidate
grouping and mixed-customer detection.

## Results
- Windows: tsc 0 errors, eslint 0 on changed files, vitest 1353/1353.
- Android: tsc 0 errors, eslint 0 on changed files, vitest 1372/1372.
- Not run: `r7-scale-30k` and `serialize-sink` (30k-photo memory stress tests,
  unrelated to money logic).

## Rules I was unsure about (please confirm)
1. Status when the sources already collected something: spec says "status
   unpaid, amount_paid = money really collected". I kept the app's existing
   rule: `unpaid` only when nothing was collected, `partial` when some was.
2. A merge with no name anywhere is issued to `Walk-in customer`; all such
   dues share one tab identity (`n:walk-in customer`).
3. The "Pending" merge leaves the due on the BILL (not as a tab charge). The
   old "Put the balance on tab" box is gone from the dialog.
4. Share text still says "Remaining to be paid"; the single "Pending Rs X"
   wording is Phase 3.
