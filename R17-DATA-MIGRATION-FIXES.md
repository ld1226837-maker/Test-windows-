# r17 Data Migration Audit Fixes Applied

Applied to both Windows and Android archives.

## Fixed

- Telegram sharded uploads now persist the actual bot-pool slot used for every uploaded message, including shard and manifest messages. Aged-history `forwardMessage` fallback therefore uses the correct bot.
- Legacy backups without `backup_id` now derive a deterministic SHA-256 identity from the parsed backup payload, making repeated merge imports idempotent even when primary-key collisions require ID remapping.
- Merge restore no longer overwrites target theme, layout, or localStorage preferences. Those profile settings are restored only by replace mode.
- v3 local backup summaries/previews now report `photo_manifest` photo counts instead of incorrectly showing zero photos.
- Native v3 ZIP restore stages receipt entries under opaque temporary filenames, validates receipt paths before writing, rejects duplicate photo entries, and enforces entry-count and extracted-byte limits before accepting the archive.
- Android internal receipt storage now always uses app-private `AppLocalData`; public Downloads/MediaStore remains reserved for user-visible exports.
- Telegram-card local full-backup copy now performs a receipt-size preflight and refuses the legacy monolithic in-memory path above 128 MiB estimated working data, directing large photo libraries to the bounded sharded Telegram backup instead.

## Regression coverage added

- v3 photo-count summary
- deterministic legacy merge identity / repeat import
- merge settings protection
- native v3 photo staging/path-safety contract
- Telegram multi-bot per-part ownership mapping

## Verification

- Patched migration/UI files are byte-identical between Windows and Android.
- All changed TS/TSX files transpile successfully with TypeScript `--noCheck` syntax validation.
- Full Vitest/typecheck suite was not executable in the supplied archives because dependencies were absent and the required npm packages were not available from the local cache.

## Full re-audit follow-up fixes

The full migration re-audit identified and corrected two additional restore-path defects:

1. Telegram sharded restore defers receipt-photo materialization until after the metadata phase. The referential-integrity validator now honors the internal `preserveReceiptsDuringRestore` boundary for that replace path; the Telegram preflight still validates every shard/photo before metadata is committed.
2. Telegram sharded replace restore now re-populates `receipt_hashes` after successful photo completion instead of clearing the freshly restored incoming hashes.

Regression coverage was added for both behaviors. Android and Windows shared migration files remain byte-identical.

### Follow-up: merge/deferred receipt boundary

The same deferred-photo exception now applies to Telegram sharded merge restores. Merge restores can introduce a new expense receipt path, so the local receipt lookup is skipped only for the internal deferred-photo restore; Telegram shard preflight remains responsible for validating the incoming photo bytes.
