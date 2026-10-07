# Truff Bookings & Sales — Final Performance Fix & Verification

Date: 6 Oct 2026
Trees: Android + Windows

## Result

All actionable code-level performance findings from PF-01–PF-50 have been addressed. Findings that were explicitly required to remain unchanged by the compiled audit (lifetime `tab_entries` semantics) remain unchanged. Runtime-only Android WebView items are code-hardened where possible but still require a physical-device profile to prove memory/paint numbers.

## Verified fixes

- PF-01: Dashboard day/month analytics are bucketed once and shared; 14-day and 60-day views reuse the same day buckets; six-month P&L reuses the monthly bucket map.
- PF-02: P&L/tax reporting no longer performs month × full-dataset `periodStats` scans; tax rows are bucketed and then traversed once for frozen tax lines.
- PF-03: `paymentSplit` reuses `collectionEntriesFor` cache.
- PF-04: customer lifetime aggregation is indexed by normalized customer identity.
- PF-05: customer visit counts are one-pass indexed.
- PF-06/D3: customer-directory dues now use an exact `matchesCustomer`-equivalent grouped index; a parity regression test was added.
- PF-07: Reports Summary skips detailed-only ranking/occupancy/item-performance work.
- PF-08/PF-11: Turf booking financial row state is precomputed per list refresh rather than recalculated on collection keystrokes; dashboard daily analytics are likewise shared.
- PF-09: Turf occupancy accepts the already-resolved court map.
- PF-10/D6: customer search is deferred; heavier calculations are not tied directly to keystrokes.
- PF-20: snack-sale tab assertion uses indexed `ref_id`.
- PF-21: Turf court-id backfill reuses loaded rows and bulk-updates only stale rows.
- PF-22/PF-23: merge writes are bulked; unmerge and merged-bill checks use `merged_into_bill_id`/`ref_id` indexes rather than full-table scans.
- PF-24: additive `merged_into_bill_id` indexes added in Dexie v19.
- PF-25: archive payment selection uses indexed `received_at` and `parent_id` lookups while preserving the union rule.
- PF-26: `expense_no` index exists in Dexie v18.
- PF-27: daily counter recovery uses indexed prefix lookup instead of `table.each`.
- PF-28: stock history uses indexed reverse ordering + limit.
- PF-29: restore key-only checks use `primaryKeys()`.
- PF-31: investment migration batches changed rows with `bulkPut`.
- PF-40/PF-41: load-test/restore/clear invalidation uses a shared canonical query-root list; no key-less invalidation remains in production.
- PF-42: dead `dashboard` invalidations and unused legacy `useExpenses` hook removed.
- PF-43: query defaults preserve previous data while a new year-window query is loading.
- PF-50/D8: lazy tab prefetch is limited to one likely-next tab; mounted tab retention is bounded and evicts the safest heavy/old tab first.
- Startup asset finding: bundled branding/payment base64 payloads were losslessly/visually-safe recompressed, reducing the embedded image payload from about 489 KB to about 168 KB total across the two asset modules.

## Intentionally preserved

- `useTabEntries` remains a full ledger read because lifetime tab balances depend on the complete ledger.
- Web Workers were not introduced for aggregates because the audit concluded algorithmic reduction is the correct first-line fix.
- Global invalidation remains semantically broad for restore/clear/load-test operations, but it is now explicit, shared, and awaited where appropriate.
- Large component boundaries (PF-12) are not mechanically split because component size alone is not a measurable performance defect; the measured state/compute boundaries were addressed instead.
- Date-specific list filtering (PF-30) remains on top of the already indexed year-window read; replacing it with duplicate date queries would increase I/O for screens that also need the full year dataset.

## Verification performed

1. Android and Windows changed source files were synchronized and byte-identical for the performance patch.
2. TypeScript parser/transpile validation passed for all changed `.ts`/`.tsx` files: **0 syntax diagnostics**.
3. Embedded image payloads decoded successfully with Pillow: Android and Windows each contain 3 branding images + 5 payment-brand images, all valid.
4. Static anti-pattern scan: no production `qc.invalidateQueries()` without a key; no `dashboard` invalidation; no legacy `useExpenses`; no hot-path `tab_entries.toArray()` remains outside the intentionally preserved tab hook and load-test code.
5. Dexie schema reaches v19 and includes the required `expense_no` and `merged_into_bill_id` indexes.
6. Added regression coverage for `periodStatsByKey()` parity and exact customer-directory due matching.
7. ZIP contents were checked after packaging: no `node_modules`, no temporary verification config, and both archives are readable.

## Verification limitation

A complete `npm run verify` / production build could not be executed here because the uploaded source trees do not contain dependencies and `npm ci` could not complete within the execution environment. Therefore the final package is source-verified, parser-verified, and statically audited, but a green runtime test/build result is **not claimed**. Android WebView memory/paint timings also require a physical Android device/profile.
