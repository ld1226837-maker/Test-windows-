# Truff — Verification of FIXES-2026-10-03 (v3)

Date: 2026-10-03. Both trees installed with bun and checked here, not just reviewed.

| ID                        | Claimed         | Verified result                                                                                                                                                             | Action in v3                                                                                                                                           |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-01 merge with photos    | Fixed           | PASS: independent B3/B4 (merge twice) and the new regression test pass                                                                                                      | none                                                                                                                                                   |
| F-02 concurrent restore   | Fixed           | Partly. B13 passes, but cleanup re-read the shared photo slot when it finished, so it could clean up a _newer_ file's photos                                                | Photo source is now captured when the lock is taken and only that source is cleaned up                                                                 |
| F-03 undefined vs omitted | Fixed           | Code was correct, but the regression test FAILED (used `invested_at`; schema needs `investment_date`)                                                                       | Test fixture corrected; now passes                                                                                                                     |
| F-04 dues tax math        | Fixed           | PASS: `verify:math` has 0 failures in both trees                                                                                                                            | none                                                                                                                                                   |
| F-05 Blob in jsdom        | Fixed           | NOT working: `test.setupFiles` was outside `vite:`, so the setup was ignored (and caused a typecheck error). Replacing the global Blob also broke jsdom FormData/File.slice | Config moved to `vite.test`; the shim now keeps jsdom Blob, adds arrayBuffer/text/bytes, and wraps structuredClone so fake-indexeddb keeps photo bytes |
| F-06 leap day             | "Already fixed" | FAILED: test expected Feb 28 18:30 UTC (= Mar 1 IST)                                                                                                                        | Expectation corrected to Feb 28 00:00 IST                                                                                                              |
| F-07 old reminder         | "Already fixed" | FAILED: test called `occurrenceAt` (next on/after)                                                                                                                          | `latestOccurrenceOnOrBefore` is now exported and tested; returns Sep 30 for a 31st-monthly rule                                                        |

## Numbers after v3

|                             | Android                                         | Windows                |
| --------------------------- | ----------------------------------------------- | ---------------------- |
| typecheck                   | PASS (was FAIL)                                 | PASS (was FAIL)        |
| verify:math                 | PASS                                            | PASS                   |
| vitest (full)               | 66 failed / 896 passed (was 78 failed)          | 65 failed / 896 passed |
| independent round-trip (12) | 11 pass; B10 needs the other tree's export file | same                   |

## Still open (not in the F-list)

About 65 older tests still fail in each tree: stale fixtures (missing `business`, orphan photos now rejected, partial now refused), source-string assertions, `window`/IndexedDB-missing environment issues, timeouts and memory thresholds. These are test upkeep, not regressions from this round. The suite is not green yet.

## Files changed in v3

- vite.config.ts, src/test-setup.ts
- src/lib/backup.ts (F-02 ownership), src/lib/backup.test.ts (F-03 fixture)
- src/lib/calendar-events.ts (export), src/lib/calendar-events.test.ts (F-06, F-07)
- verification/migration-roundtrip.test.ts (added)
