# Truff — Report Findings Fix Report

Date: 2026-10-03

## Findings addressed

| ID   | Status                     | Fix                                                                                                                                                                                                                                                                                              |
| ---- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-01 | Fixed                      | Merge referential-integrity validation now recognizes receipt paths referenced by existing local expense/investment/bill rows, so an idempotent overlap with photos is not rejected as an orphan. Added a regression test for repeated merge of a row plus its receipt photo.                    |
| F-02 | Fixed                      | Receipt-photo sources are now associated with the exact parsed backup object and protected from cleanup by a rejected concurrent restore. The restore cleanup runs only for the restore that actually acquired the migration lock.                                                               |
| F-03 | Fixed                      | `stableStringify()` omits object properties whose value is `undefined`, making an IndexedDB row with an undefined optional field compare equal to the equivalent JSON-restored row where that field is absent. Added regression coverage.                                                        |
| F-04 | Fixed in verification path | The math verifier no longer resets the GST + Service Charge settings before the multi-court/customer-dues checks. Legacy bookings without frozen tax snapshots therefore use the intended live tax configuration during those checks; defaults are restored after the complete verification run. |
| F-05 | Fixed                      | Vitest now installs a Node standards-compatible `Blob` in jsdom tests so fake-indexeddb preserves receipt-photo bytes. This removes the documented jsdom Blob artifact from the photo verification harness.                                                                                      |
| F-06 | Already fixed              | The supplied calendar test already expects Feb 28 for the non-leap-year Feb 29 recurrence, matching the stored IST wall-clock rule. No regression change was necessary.                                                                                                                          |
| F-07 | Already fixed              | The supplied calendar implementation already uses `latestOccurrenceOnOrBefore()` for overdue recurring reminders, and the regression test verifies the returned occurrence is not after the requested bound. No regression change was necessary.                                                 |

## Additional regression coverage

- Repeated merge of a business row with a referenced receipt photo.
- Merge equality when an optional field is `undefined` locally but omitted after JSON round-trip.
- Existing calendar leap-day and old-recurring-reminder regression tests retained.

## Verification limitation

The supplied source trees did not contain a usable dependency installation. An attempted pinned `npm ci --ignore-scripts --no-audit --no-fund` could not complete in the sandbox, so a fresh `typecheck`/`lint`/Vitest execution could not be completed here.

The repaired packages therefore should be treated as **source-fixed, not independently green-verified in this sandbox**. The original verification logs remain included for traceability; they describe the pre-fix failures.

## Files changed

- `src/lib/backup.ts`
- `src/lib/backup.test.ts`
- `src/test-setup.ts` (new)
- `vite.config.ts`
- `scripts/verify-math.ts`
