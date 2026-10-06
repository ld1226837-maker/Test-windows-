# Deep Audit V10 Fix Report

## Applied fixes

- `src/lib/backup.ts`: reject `payments.parent_type` values outside `bill`, `turf_booking`, `snack_sale` instead of silently skipping parent validation.
- `src/lib/backup.ts`: validate `tab_entries.ref_id` against its declared target table.
- `src/lib/backup.ts`: validate `tab_entries.source_ref_id` against its declared source target table.
- Reject populated tab reference IDs without a type, populated source IDs without a source type, unknown reference types, and missing IDs for populated reference types.
- `merge_reverse` is validated as `ref_id -> bills`; its `source_ref_type` is validated against `bills`, `turf_bookings`, or `snack_sales`.
- Mirrored exactly in Windows and Android.
- Added regression tests for invalid payment parent types, dangling tab references, and `merge_reverse` references.
- Extended `verification/migration-v9-static-regression.mjs` to 9 checks.

## Observed verification

- Windows static regression: 9/9 PASS.
- Android static regression: 9/9 PASS.
- Windows/Android changed `backup.ts` byte-identical: PASS.
- Windows/Android changed `migration-fixes.test.ts` byte-identical: PASS.

## Runtime limitations

Full Vitest/typecheck/lint/migration execution was not available in the supplied packages because dependencies are incomplete. `tsc --noEmit` on both trees stops at `TS2688: Cannot find type definition file for 'vite/client'`. Therefore no full-suite PASS is claimed.
