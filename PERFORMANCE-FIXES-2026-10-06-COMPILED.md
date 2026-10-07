# Truff Bookings & Sales — Compiled Performance Fixes

Date: 6 Oct 2026

Applied to the Android and Windows source trees from the compiled PF-01–PF-50 performance findings.

## Applied

- PF-01: added `periodStatsByKey()` bucketed analytics and switched Dashboard 14-day / 60-day loops to one-pass partitioning; P&L now uses the same bucketed path.
- PF-02: `profitAndLoss()` and `taxReport()` no longer invoke `periodStats()` once per month over the full dataset. Tax lines are bucketed in one pass.
- PF-03: `paymentSplit()` now reuses the existing `collectionEntriesFor()` WeakMap cache.
- PF-04: `customerLifetimeStats()` changed from customers × rows to indexed customer matching with one pass over each business dataset.
- PF-05: Customer Directory visit counts now use a one-pass `customerVisitCounts()` index while preserving the card's historical snack-sale name-only matching rule.
- PF-07: Reports Summary view skips detailed-only customer ranking, occupancy, item-performance and detailed dues sorting work.
- PF-20: snack-sale-on-tab assertion now uses the indexed `ref_id` query instead of reading the whole tab ledger.
- PF-21: Turf court-id backfill reuses already-loaded booking rows and uses Dexie `bulkUpdate` for stale rows.
- PF-22: customer merge writes use bulk updates for bills, bookings, sales, tabs, tab entries and calendar events.
- PF-23: merge-into-bill tab ledger lookup uses indexed `ref_id` lookups for selected source rows.
- PF-26: added Dexie v18 `expense_no` index so `nextNumber()` collision protection can actually query the index.
- PF-28: all-item stock history now uses `orderBy(created_at).reverse().limit()` instead of loading/sorting the entire table.

## Deliberately not changed

- `useTabEntries` / lifetime tab-ledger semantics remain full-table as required by the compiled audit.
- No Web Worker architecture was introduced for aggregates.
- Customer-directory due-index reuse remains gated on parity testing because its matching rule differs from the Outstanding index.
- Android tab retention and paint/prefetch behaviour remain runtime/device profiling items.
- Global restore/clear/seed invalidations remain because their broad scope is intentional; LoadTestCard is not changed into a collection of speculative narrow keys.

## Verification

- Changed source files in Android and Windows are byte-identical.
- TypeScript transpile/syntax validation passed for all changed `.ts`/`.tsx` files.
- Full `npm run typecheck`, test suite and production build could not be executed in this environment because dependency installation (`npm ci`) timed out; the incomplete Android `node_modules` directory was removed before packaging.
- No Android device/WebView runtime profile was available, so Android timing/memory claims remain unverified.

## Files changed

`src/lib/analytics.ts`, `src/lib/data.ts`, `src/lib/ops.ts`, `src/lib/localdb.ts`, `src/lib/merge.ts`, `src/components/app/CustomerDirectoryCard.tsx`, `src/components/app/DashboardTab.tsx`, `src/components/app/ReportsTab.tsx`, `src/components/app/TurfTab.tsx`.
