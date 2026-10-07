# Deep Migration Audit — v7

Date: 2026-10-02
Basis: `migration-verification-prompt.md` supplied with the project.
Trees: Windows and Android v7.

## Executive result

**NO-GO for certification yet.** Static inspection found and fixed three receipt-ownership/migration defects in both trees. The changed TypeScript files pass TypeScript transpilation/syntax diagnostics. The complete runtime suite could not be executed because project dependencies are not installed and `npm ci --offline` fails with an uncached `zod-3.25.76` package.

The remaining S0 concern is an atomicity gap in the monolithic Telegram/full-backup restore path: `restoreFullBackup()` commits the ledger through `restoreBackup()` before rebuilding receipt files. A later receipt write failure can therefore leave ledger metadata committed while only part of the receipt set has been rebuilt. The sharded restore path has a durable rollback journal and does not have this same structural gap. This must be fixed and tested with injected photo-write failure before certification.

## Fixed in v7 audit pass

1. **Merge receipt validation included bills.** `backup.ts` merge-mode local-photo validation previously checked only expenses/investments; it now checks bills too. Regression test added as `L4` in `migration-fixes.test.ts`.
2. **Sharded Telegram backup included bill receipt references in the photo planner.** A bill-only path with no receipt row is now preflighted and reported as missing/partial instead of being invisible to the planner. Regression test added in `telegram-migration-fixes.test.ts`.
3. **Receipt deletion protected bill references.** `deleteReceipt()` now checks expenses, investments, and bills.
4. **Receipt purge protected bill references.** `purgeReceiptIfUnreferenced()` now checks expenses, investments, and bills.
5. **Receipt health included bill ownership.** `reconcileReceiptStorage()` and orphan repair now treat bills as first-class receipt owners.
6. **Regression tests added** for bill-owned receipt deletion, purge, and health reconciliation.

## Cross-platform parity

Core migration files are byte-identical between the v7 Windows and Android trees for the shared migration/receipt implementation. Remaining `src/lib` differences are platform-specific files/tests or the Windows-only printer files listed by the project structure. `expenses.ts` remains intentionally platform-different.

## Historical findings re-check

- F1 (`analytics.ts` TDZ): static structure no longer matches the reported TDZ pattern; runtime `verify:math` remains unexecuted.
- F5 (`moveBookingToTab` nonexistent `tabId`): static inspection does not show the reported access; runtime test remains unexecuted.
- F10 (`useCreateSnackSale` out-of-scope `bill_no`): current implementation does not show the reported scope error; runtime test remains unexecuted.

## Runtime baseline

| Check                 | Windows                                | Android                                |
| --------------------- | -------------------------------------- | -------------------------------------- |
| npm ci                | NOT COMPLETED / transport timeout      | NOT RUN                                |
| npm ci --offline      | FAIL: uncached zod-3.25.76             | NOT RUN                                |
| typecheck             | FAIL: missing `vite/client` dependency | FAIL: missing `vite/client` dependency |
| lint                  | NOT RUN                                | NOT RUN                                |
| test                  | NOT RUN                                | NOT RUN                                |
| verify:migration      | NOT RUN                                | NOT RUN                                |
| verify:math           | NOT RUN                                | NOT RUN                                |
| verify:sections       | NOT RUN                                | NOT RUN                                |
| verify:loadtest:light | NOT RUN                                | NOT RUN                                |

A global TypeScript 5.8.3 `transpileModule` syntax/diagnostic pass was run on all changed TypeScript files in both trees: **0 diagnostics**.

## Remaining S0/S1 items

### S0 — monolithic full/Telegram restore photo-phase atomicity

`src/lib/telegram-backup.ts`, `restoreFullBackup()` calls `restoreBackup()` before writing the archive's receipt files. The code validates the archive before the commit, but validation cannot prove a later filesystem/Dexie photo write will succeed. If a photo write fails after the ledger commit, the function has no equivalent durable rollback boundary around that post-commit phase. The sharded restore implementation does have such a rollback journal.

Required reproduction: inject a failure on the k-th receipt write during `restoreFullBackup()` replace restore; assert old tables/photos are restored exactly and retry succeeds.

### S1 — complete runtime migration matrix remains unproven

The MD requires B1-B13, C1-C13, D integrity checks, Part E numeric reconciliation, and Part F property/failure-injection tests. None can be marked PASS until the project dependencies are available and the commands actually execute.

### S1 — full 3-year deterministic fixture is not yet proven against the supplied MD

The repository has verification seed/load-test infrastructure and receipt/investment fixtures, but the supplied deterministic seed is primarily 2026-focused. The MD's explicit 3-calendar-year boundary fixture (including 31 Dec 23:59 and 1 Jan 00:00 IST) needs a dedicated executable migration test.

### S1 — physical platform checks remain unverified

Android SAF/content-URI behavior, private-storage round trips, actual process-kill recovery, disk-full behavior, real Telegram transport, and 50,000-photo/8 GiB execution require a real device/runtime or equivalent integration environment.

## MD alignment notes

The MD requires evidence for every finding, no edits before approval, independent Windows/Android checks, deterministic fixtures, receipt SHA-256 comparison, orphan/reference checks, investment-specific scenarios, all-table referential integrity, numeric reconciliation, and explicit gaps/limitations. This report does not treat unexecuted tests as PASS.

## Recommendation

**NO-GO until the monolithic full-backup photo-phase rollback gap is fixed and the complete executable matrix is run successfully on both trees.**
