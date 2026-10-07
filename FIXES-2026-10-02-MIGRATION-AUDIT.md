# Migration Audit Fixes — 2026-10-02

Basis: `migration-verification-prompt.md`.

## Applied fixes

1. Synchronized `src/lib/expenses.test.ts` across Windows and Android so the investment-reference receipt deletion guard is present in both trees.
2. Fixed Telegram sharded-backup receipt ownership coverage for bills in `src/lib/telegram-backup.ts`:
   - bill receipt paths are included in the fallback receipt-owner map;
   - missing/corrupt bill receipt paths are cleared in the exported table snapshot when the backup is marked partial;
   - this keeps bill receipts consistent with expense and investment partial-backup handling.
3. Added a regression test in `src/lib/telegram-migration-fixes.test.ts` proving a bill-only missing receipt marks a sharded Telegram backup partial and reports the omission.

## Scope integrity

Only these source/test files differ from the supplied Windows ZIP:

- `src/lib/expenses.test.ts`
- `src/lib/telegram-backup.ts`
- `src/lib/telegram-migration-fixes.test.ts`

The Android ZIP differs only in:

- `src/lib/telegram-backup.ts`
- `src/lib/telegram-migration-fixes.test.ts`

`DATA_TABLES` remains 24 tables.

## Verification limitation

The supplied environment could not complete dependency installation. Current executable checks therefore report:

- `npm run typecheck`: blocked because `vite/client` types are unavailable;
- `npm test`: blocked because `vitest` is unavailable;
- `npm run lint`: blocked because `eslint` is unavailable.

No executable test was represented as PASS without observation.

## Remaining required runtime verification

Run the complete MD command/scenario matrix after dependencies are installed, including B1–B13, C1–C13, all D checks, Part E numeric reconciliation, and Part F failure-injection/property tests.
