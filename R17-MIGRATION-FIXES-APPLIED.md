# R17 Migration Fixes Applied

Applied identically to Android and Windows migration cores.

## Fixes in this iteration

1. Corrected the referential-integrity regression test.
   - Historical `snack_stock_history.item_id` is intentionally not treated as a strict foreign key.
   - Tests now exercise the strict `tab_entries.tab_id -> customer_tabs` relationship.
   - Added coverage for merge restore against an existing local parent.
2. Extended migration locking across the complete Telegram sharded restore.
   - The lock now covers shard validation, metadata restore, receipt-photo writes, completion markers, and rollback.
   - This prevents a second local import/restore from interleaving with an in-progress Telegram restore.
3. Kept the shared migration files byte-identical between Android and Windows.

## Verification

- ZIP contents pass `unzip -t` after packaging.
- Shared migration files were compared byte-for-byte.
- Targeted TypeScript parsing was checked with the installed global TypeScript compiler; full project typecheck/test execution remains unavailable because the archives do not contain complete dependency installations (`vitest`/Vite type definitions are missing).

## Final5+ verification/automation hardening

- Added an explicit `verify:migration` command covering the migration/Telegram regression suites and included it in `verify`.
- Windows CI now runs the same full verification gate before building the installer.
- Daily/weekly backup settings now trigger an automatic Telegram sharded backup on app launch when Telegram credentials are configured; failed uploads leave `lastBackupAt` unchanged for retry.
- This is intentionally foreground/on-launch automation; OS-level execution while the app process is fully terminated remains subject to platform background-execution rules.

## Final6 follow-up fixes

- Automatic Telegram backup now requires explicit `automaticBackup` consent; `backupReminder` remains a reminder/schedule setting.
- Migration verification includes `automatic-backup.test.ts`.
- Automatic backup remains foreground/on-launch because arbitrary JavaScript cannot be guaranteed after process termination on Android/WebView.
