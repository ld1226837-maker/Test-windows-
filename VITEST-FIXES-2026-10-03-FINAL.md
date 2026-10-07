# Vitest Failure Fixes — 2026-10-03

Applied to both `truff-windows` and `truff-android`.

## Fixed failure clusters

- Backup row validation now reports at most one problem per malformed row and uses field-specific enum error wording.
- Merge now keeps the target device's existing record on primary-key collision instead of duplicating edited records; incoming payment rows are not attached to a kept local parent.
- Legacy v1/v2 inline receipt photos may remain standalone; v3 manifest photos remain reference-checked.
- v5 backup ZIP containers larger than the legacy 64 MiB guard are accepted by the decoder.
- Native restore implementation tests now target the actual restore implementation after the public wrapper refactor.
- Layout normalization now sorts the actual section array before re-numbering, so newly registered sections append after existing relative order.
- Image compression passes through verified files when no real image decoder is available (Node/jsdom), while real browser decode failures still fail closed.
- Bulk receipt import avoids invoking an unavailable browser decoder in non-browser hosts.
- Sharded receipt planning now uses `blob.size` when the metadata size field is absent, preventing oversized shards; standalone imported receipt rows/hashes are included in sharded backups and restore validation accepts them.
- Full-backup missing referenced photos fail closed before producing a partial archive.
- Full-backup manifest parsing validates partial archives only after allowing the partial marker to produce the intended pre-mutation rejection.
- Full-backup receipt-hash validation occurs before dereferencing malformed hash rows.
- Manifest size failures now use the manifest-checksum error family.
- Telegram full-backup tests are isolated from stale bill/investment/receipt state.
- Native receipt-disk tests mock the move and secure-invoke boundaries instead of exercising unavailable Tauri IPC.
- Cross-platform verification creates its `/tmp/a` exchange directory before writing exports.
- v5 tests that need receipt bytes now serialize/decode the backup so the external photo source is correctly attached.
- Year-archive coverage uses a valid capture hash fixture.

## Verification performed

- TypeScript source/test files modified in both trees: syntax-parse clean.
- The supplied Vitest proof originally showed 55 failed tests in each tree, across the same 20 test files.
- Full `bunx vitest run` was not re-executable in this working environment because the extracted archives do not contain a usable Vitest executable and registry installation is unavailable/blocked.

## Important

This report does **not** claim a fresh 0-failure Vitest run. The code and test fixes were applied and syntax-checked; a real dependency-complete Vitest run should be performed before shipping.
