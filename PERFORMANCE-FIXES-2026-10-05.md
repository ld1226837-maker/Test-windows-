# Truff Bookings & Sales — Performance Fix Report

Date: 5 Oct 2026

## Applied fixes

1. Cached parsed app settings in memory and invalidate on settings/custom events and cross-window `storage` updates. Legacy frozen-tax behavior is unchanged.
2. Made tax/settings lookup lazy for frozen records, removing repeated localStorage/JSON work from money calculations and sorts.
3. Added a WeakMap-backed tab-entry reference index for O(1) `refType:refId` lookups.
4. Added grouped customer dues indexing so Bills and Outstanding no longer rescan the entire year for every customer.
5. Cached `periodStats` collection-entry construction by source/settings identity so Dashboard/Reports period passes reuse the expensive payment normalization work.
6. Decorated sort keys in Bills and Turf lists so totals, balances, lowercasing, dates and due amounts are computed once per row rather than repeatedly inside comparators.
7. Added deferred search filtering to Bills and Outstanding.
8. Delayed automatic Telegram backup from a fixed 5-second startup timer to idle time / 30-second fallback.
9. Narrowed the automatic label MutationObserver away from `document.body`.
10. Removed the remaining double-sort in Turf bookings and Snack sales (single comparator, same ordering).
11. Froze the cached settings object so callers cannot accidentally mutate shared cached state.
12. Applied all shared changes to both Android and Windows packages.

## Verification

- TypeScript/TSX parser diagnostics: PASS (all modified files, both packages).
- Migration static regression suite: PASS (9/9 checks in each package).
- Shared-file parity check: PASS.

Full `npm run verify` / production build could not be executed in this sandbox because the uploaded packages do not include dependencies and the environment could not complete `npm ci`; offline install stopped on an uncached `zod` package. No verification result is being represented as a successful full build.

## Remaining deliberate scope

The following audit items are not silently represented as fixed: database-level pagination/rollups, Web Worker migration, broad targeted query invalidation, and full device profiling. They require runtime/build verification and, for rollups, migration parity work.

## Intentionally not changed

Database schema/rollup migrations and broad targeted-query rewrites were not introduced in this pass because the audit identifies those as higher-risk changes requiring full device/build verification and migration parity testing. The existing indexed year queries, lazy tabs, pagination, and cache limits remain intact.
