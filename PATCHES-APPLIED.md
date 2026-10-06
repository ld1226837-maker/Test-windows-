## Migration audit fixes (Oct 2026) — applied to Windows and Android

- M1 merge: same primary key == same record; local copy kept, never duplicated under a new id.
- M2 preview: stable (key-order independent) comparison, consistent with the engine.
- M3/M6 replace: device-local `ks:telegram-backup*` keys are neither wiped, exported, nor imported.
- M4 replace: child tables absent from an older backup (payments, tab_entries, snack_stock_history, teams, team_players, calendar_event_exceptions) are cleared when their parent is replaced.
- M5 merge: snack_sales.booking_no refreshed after document-number remaps.
- M7 restore options (preserveReceiptsDuringRestore) captured before schema normalisation.
- L1 legacy merge identity hashed from the raw payload; L2 dangling merged_into_bill_id rejected; L3 browser v3 replace keeps old photos until new ones are stored.
- Tests: backup.test.ts / migration-scenarios.test.ts updated; new migration-fixes.test.ts. NOT executed (no installed dependencies in sandbox).

## Telegram audit fixes (Oct 2026) — Windows and Android

- T6 sharded restore without a top manifest now verifies the declared shard count; a missing/extra shard fails closed instead of partially restoring.
- T1/T5 retention: an upload with no manifest message id, or a partial upload (receipts omitted), no longer prunes older complete backups.
- T10 rollback/recovery paths and full-backup capture no longer wipe, export or import device-local `ks:telegram-backup*` keys.
- Tests: telegram-migration-fixes.test.ts (3 cases). NOT executed in sandbox.

## Full-audit additions (Oct 2026) — Windows and Android

- R1 native crash recovery: a merge no longer re-applies imported local settings or wipes local keys; `ks:telegram-backup*` is preserved for replace too.
- M8 merge: payment rows from the backup are not attached to a parent record that is kept local (a payment row overrides the parent's implied amount_paid, so this silently changed what counted as paid).
- Superseded by the final encrypted-container v3 fix below: new chunked backups authenticate the final-chunk marker; legacy v2 remains restore-compatible.
- Tests: M8 case added to migration-fixes.test.ts. NOT executed in sandbox.

## Final migration-safety fixes (2 October 2026)

- **Encrypted backup v3 detection:** native file restore now recognizes both chunked container versions 2 and 3. Version 3 no longer falls through to the legacy whole-file reader.
- **Year-archive race protection:** `yearDeletionFingerprint()` fingerprints the exact dated rows, payment rows, and referenced receipt metadata targeted for deletion. `deleteYear(year, expectedFingerprint)` rechecks that fingerprint immediately before the write transaction and aborts with no deletion when anything changed. Archive deletion and counter resync run under the migration lock.
- **Receipt path hardening:** restore validation now rejects restore staging/rollback directories, NTFS streams, wildcards, control characters, Windows device names, trailing dot/space components, and paths over 240 characters.
- **Receipt collision protection:** photo/hash/manifest path checks normalize Unicode to NFC and compare case-insensitively, preventing case- or normalization-only duplicates from reaching durable restore state.
- **Streaming ZIP reader:** replaced repeated whole-buffer merge/slice reallocations with a chunk queue and offsets, avoiding O(n²)-style copying at high entry counts while preserving exact-entry output and CRC checks.
- **Regression tests:** added year-archive stale-snapshot tests and receipt-path safety/collision tests to `years.test.ts` and `backup-validate.test.ts`.
- **Verification limitation:** full Vitest, project `tsc`, and lint remain blocked in this sandbox because dependencies could not be installed. Global `tsc` reached the projects but stopped on missing installed type definitions/modules; no claim of a passing full suite is made.

## Deep migration re-audit fixes (2 October 2026)

- **Archive deletion race closed fully:** the stale-snapshot fingerprint and receipt/payment/open-tab safety checks now execute inside the same Dexie read-write transaction as the destructive deletes. A mutation cannot land between the final check and deletion.
- **Sharded Telegram backup lock:** the complete build → shard upload → manifest publication → retention sequence now runs under the migration lock, so automatic backup cannot capture a restore/import mid-flight or publish a mixed-state backup as newest.
- **Sharded restore completeness:** restore now rejects an unexpected extra shard after the declared shard count, and rejects case/Unicode-normalization-equivalent duplicate receipt paths across shards before any durable state is changed.
- **Chunked encrypted backup v3:** new files use authenticated final-chunk markers, so exact-boundary truncation, dropped/duplicated frames, and trailing bytes fail closed. Version-2 chunked backups remain readable.
- **Receipt collision normalization:** receipt-path collision checks now use deterministic Unicode-NFC + `toLowerCase()` normalization rather than locale-dependent lowercasing.
- **Regression coverage:** added chunked-encryption truncation/trailing/frame-integrity tests and Telegram extra-shard coverage.
- **Verification limitation:** dependency installation remains unavailable in this sandbox, so full Vitest/lint/project typecheck cannot honestly be reported as passing. All TypeScript source files parse successfully with the installed TypeScript parser, and the new chunked crypto was exercised with a standalone 3 MB round-trip/tamper harness.

## Deep audit remediation — second pass (2 October 2026)

- **Year archive transaction scope:** `customer_tabs` is now explicitly included in the `deleteYear()` Dexie transaction. Open-tab revalidation therefore cannot escape the transaction scope and fail after other destructive work has begun.
- **Year fingerprint transaction lifetime:** the WebCrypto SHA-256 used by the in-transaction stale-snapshot check is wrapped with `Dexie.waitFor()`, preventing Dexie from auto-committing while the asynchronous fingerprint is being calculated.
- **Receipt ownership safety:** receipt purge now checks both `expenses` and `investments`, so a receipt shared with an investment can never be deleted when an expense is removed.
- **Receipt-health ownership safety:** investment receipt references are included in the claimed set, preventing health reconciliation from falsely reporting investment receipts as orphans and deleting them.
- **Native restore crash recovery:** startup recovery now runs before stale-artifact cleanup. Journal-referenced `.restore-staging` / `.restore-rollback` artifacts remain protected if recovery itself fails, instead of being deleted before the next recovery attempt.
- **V3 manifest validation:** version-3 photo manifests now use the same strict receipt-path validator as restore, including platform-dangerous names and managed restore directories.
- **Telegram backup collision protection:** backup construction rejects case/Unicode-normalization-equivalent receipt paths before shard creation, not only during restore.
- **Destructive archive save verification:** Windows desktop year-archive writes are read back and SHA-256 verified before `archiveYear()` can delete local records.
- **Parity:** the corrected migration files remain byte-identical between Windows and Android.

## Deep audit — 2 October 2026 (latest pass)

- Protected receipt deletion from stale UI actions: `deleteReceipt()` now refuses to remove a path currently referenced by either an expense or an investment.
- Receipt-health orphan repair now checks both expenses and investments before deleting a photo.
- One-shot Telegram full-backup creation now emits each shared receipt path only once when an expense and investment reference the same photo; duplicate ZIP entries are prevented.
- Receipt-hash validation now requires a safe receipt path and a canonical 64-hex SHA-256 value.
- One-shot Telegram replace restore now removes stale receipt metadata/hash rows after the complete incoming photo phase, keeping IndexedDB metadata aligned with the restored filesystem/archive.
- Added regression coverage for shared investment receipts, stale orphan repair, duplicate shared-photo backup entries, and malformed/unsafe receipt-hash records.
- Full dependency-backed Vitest/ESLint/typecheck remains environment-dependent; source parse verification was completed after this pass.

## Deep audit — 2 October 2026 (latest)

- Reject partial full/Telegram backups before any restore mutation; incomplete receipt sets can no longer restore ledger rows while silently losing photos.
- Full-backup restore now validates receipt metadata ↔ photo-manifest ↔ receipt-hash consistency, including recorded size and capture hash.
- Full-backup creation now detects capture-time hash mismatches for expense/investment-referenced photos instead of silently packaging changed bytes under the old hash.
- Year archive metadata is now captured in one Dexie read transaction. The destructive-delete fingerprint is derived from that exact snapshot plus the actual receipt bytes, closing the snapshot/fingerprint race.
- Year deletion fingerprints actual receipt bytes rather than trusting only the stored capture hash, so same-size in-place photo changes cannot slip through the archive guard.
- Added regression coverage for partial-restore rejection, receipt-hash/manifest disagreement, and receipt-byte archive races.
- Windows and Android migration files remain parity-checked.

Verification limitation: the sandbox still cannot complete the dependency installation needed for the project's full Vitest/ESLint/tsc suites; no passing full-suite claim is made.

## 2026-10-03 deep-audit remediation

- Made recurring-expense catch-up posting atomic across expenses, recurrence state, and counters; added rollback regression coverage.
- Rejected `recordPayment()` and initial-payment writes for nonexistent parents.
- Fixed IST calendar-date ageing for plain `YYYY-MM-DD` booking dates.
- Changed period collection aggregation to use payment `received_at` for bills, bookings, and snack sales, while retaining legacy implied-payment fallback and tab-entry dates.
- Removed the status-only “Partially paid” bill action; partial status is now produced through an actual collection, and the bill update API rejects invalid partial amounts.
- Changed Reports “Mark paid” to use the normal booking collection/payment-ledger path.
- Booking creation now rolls back a newly created booking if its initial payment ledger write fails instead of silently swallowing the failure.
- Added regression tests for delayed collections, date-only ageing, missing payment parents, initial-payment parent validation, and recurring-expense transaction rollback.
- Added `upi://**` to the Android opener capability.
- Updated Android release CI to run the repository's full `npm run verify` suite.
- Verification could not be executed in this environment because `npm ci` could not obtain `zod@3.25.76` from the npm registry/cache.

## 2026-10-03 deep-audit remediation — payment integrity follow-up

- Plain merged-bill unmerge now removes copied bill payment rows and resets the historical placeholder's paid amount/status before restoring the source records, preventing duplicate payment reporting.
- `recordPayment()` now revalidates the parent gross ceiling inside the write transaction, closing the stale-due concurrent-collection overpayment race.
- Booking edits can no longer silently reduce a recorded advance through a parent-field-only patch; reductions are rejected until an explicit refund/correction flow exists.
- Snack-sale creation now writes initial cash/online payment rows in the same Dexie transaction as the sale, stock, and tab effects; a payment-write failure rolls back the sale.
- Snack sales already on tab, and transitions into/out of On-tab mode, are no longer editable through the field-only payment-mode editor; Outstanding is the controlled settlement/correction path.
- Added regression coverage for merge payment conservation and the payment gross ceiling.
- Static TypeScript parsing passes after the remediation; full dependency-backed Vitest/typecheck remains blocked because the archive has no usable `vite/client`/Vitest installation in this environment.

## 2026-10-03 — Test-report remediation pass

- Fixed `useCreateSnackSale` Dexie transaction invocation to pass its six tables as a table array, and imported `sequentialTimestamps` used by atomic initial-payment writes.
- Fixed `data.ts` to import `billGrossTotal` from its defining module (`biz.ts`).
- Removed explicit `undefined` optional snack-sale payload keys so `exactOptionalPropertyTypes` accepts the mutation payload.
- Made legacy bill gross/collection calculations accept the caller's explicit tax settings, keeping paid-bill collection tax-inclusive in analytics.
- Changed the migration-lock fallback from reject-on-contention to an in-process FIFO queue so concurrent replace restores serialize on runtimes without `navigator.locks`.
- Added ZIP shard headroom by reducing the receipt planner byte cap to 17 MiB, leaving room for ZIP metadata while remaining under Telegram's transport ceiling.
- Relaxed `receipt_hashes` from a required full-backup table because it is supplemental integrity metadata and older full backups may legitimately omit it; `receipts` remains required.
- Made backup row validation report invalid payment-mode values directly instead of hiding them behind a generic wrong-type message.
- Corrected merge/payment regression tests to use Dexie `count()`/arrays and to match the intentional plain-unmerge payment conservation rule.
- Corrected backup serializer/stream tests to reference their seeded receipt photos from business rows, matching the reference-driven export contract.
- Corrected the WP1 property-test oracle to date real collections by `payment.received_at`, matching the production ledger semantics.
- Updated Android-only heavy migration/load tests with appropriate timeouts for the documented machine-load-sensitive scenarios.

## 2026-10-03 r2.1 deep-audit cleanup

- Fixed the migration-lock FIFO fallback cleanup to release/delete the actual current tail promise rather than comparing it with the previous promise.
- Fixed the unmerge payment-conservation regression test to materialize the Dexie collection before reducing it.
- Corrected the legacy paid-bill analytics fixture so the GST fallback is tested only when no frozen tax snapshot exists.

## r4 validation diagnostics hardening — 2026-10-03

- Backup row validation now preserves specific semantic diagnostics over the generic structural message when the row shape is otherwise valid (for example, an invalid payment mode).
- Added a regression test covering an invalid `payments.mode` and asserting the actionable error is retained.
- Rechecked both Windows and Android source trees for Dexie Collection `.length`/`.reduce()` misuse in tests and for the previously reported snack/payment/restore fixes.
