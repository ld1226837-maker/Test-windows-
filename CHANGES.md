## R11 — bounded scale-test restore storage

- The 30k receipt scale harness no longer collects every generated sharded backup in a JavaScript array on native Android/Windows runs.
- Each shard is persisted to app-private documents as it is finalized and fetched one-at-a-time during restore, then removed.
- Added regression coverage asserting the scale harness uses `collectShards: false` and a pull-based storage path.
- The browser-only CI harness keeps its small compatibility path for the existing 1k test.

# Changes — R6/R7 completion

- Android pending MediaStore exports are cleaned up before new streaming exports.
- Android streaming writes keep one native OutputStream open and reject/delete zero-byte exports.
- Added 10,000 and 30,000 receipt scale-test options.
- Added the Settings bulk receipt import UI with bounded concurrency, SHA-256 deduplication, resumable progress and reset.
- Telegram full backups now use the R3 sharded format: each shard is independently encrypted and uploaded, with a separate encrypted top manifest.
- Telegram restore now uses a pull-based shard source, downloading/decrypting one shard at a time instead of rebuilding the complete backup in memory.
- Sharded restore performs replacement only on shard 1; later shards merge so earlier restored photos are never cleared.
- An empty-photo backup still emits one metadata shard so records/settings remain restorable.
- Existing receipt disk rollback, stale-file cleanup and migration protections are preserved.

## Verification

The source was statically inspected after the changes. Dependency installation (`npm ci`) timed out in the packaging environment, so a fresh TypeScript/Vitest run could not be completed here. Android MediaStore behavior and the Telegram flow still require an actual app/device run for final runtime verification.

## R7 final hardening

- Telegram sharded backup uploads each shard as soon as it is built instead of retaining the complete shard set in memory.
- Added a `onShardBuilt` streaming upload hook and regression coverage for the no-collection upload contract.
- Preserved one-shard-at-a-time Telegram restore and existing checksum validation.

Verification in this environment: source-level parity checks completed; dependency installation/typecheck could not be completed because package installation timed out.

## R8 hardening

- Sharded Telegram backups now refuse a logical shard that exceeds the single-document transport limit instead of producing ambiguous multi-part shard filenames.
- Shard manifest photo counts are derived from the files actually packaged, so missing/unreadable receipt files cannot inflate the advertised count.
- Added regression coverage for the single-document sharded transport contract.

## R9 hardening

- Sharded Telegram backups now reserve the fixed AES-GCM container overhead so a logical shard cannot cross the single-document transport boundary after encryption.
- The Telegram upload path independently asserts the encrypted shard size before sending, preventing accidental transport splitting.
- Added a regression test for the encrypted shard-size contract.
- Distributable archives intentionally omit incomplete `node_modules`; install from the lockfile before verification.

## R10 hardening

- Enforced the single-document Telegram transport limit for the encrypted sharded manifest.
- Android stream export now performs package-scoped stale MediaStore pending cleanup immediately before creating a new stream.
- Added regression coverage for the sharded-manifest transport invariant.

## R12

- Added a bounded-memory STORE ZIP reader for streaming restore. It consumes the encrypted/decrypted archive sequentially and never requires the complete ZIP as one JavaScript array.
- Added regression coverage for sequential ZIP restore records.

## R13 — bounded-memory single-file restore

- Native `.db` restore now uses the Tauri file picker plus seekable `FileHandle` reads.
- Chunked encrypted v3 backups are decrypted incrementally and STORE-ZIP entries are consumed one at a time.
- Receipt photos are staged in app-private temporary storage rather than retained as a multi-GB JavaScript archive.
- Temporary restore files are cleaned up on successful restore and failure paths.
- ZIP restore rejects absolute and `..` traversal entry names.
- Android backup import now uses the native document picker; Android extension filtering is omitted because the platform uses MIME/document picking.

## R14 — streaming restore integrity and cleanup

- Fixed native streaming restore photo verification to use the shared pull-based photo source; the prior code referenced a nonexistent JSZip field and would fail when validating a native restore.
- Streaming ZIP restore now validates each entry's CRC32 and rejects duplicate ZIP entry names.
- The ZIP reader drains the decrypted source after reaching the directory so every encrypted frame, including the final frame, is authenticated before restore proceeds.
- Version-3 photo manifests reject duplicate, absolute, traversal, and unsafe-size entries.
- Cancelling the restore confirmation or failing parsing/preview now removes staged temporary receipt files.
- Added regression tests for CRC corruption, duplicate ZIP entries, and consuming the source through EOF.
