# Truff R17 Data Migration — Final12 Fixes

Applied against **Truff r17 — Data Migration Audit.md**.

## Fixed

- C1: `restoreOptions` is explicitly passed into referential-integrity validation, fixing merge/photo restore failures.
- C2: Telegram sharded restore uses the existing migration lock and calls the inner restore with `alreadyLocked: true`, preventing nested non-reentrant lock acquisition.
- H1: automatic Telegram backup failures are persisted and surfaced; the manual reminder is not suppressed after a failed automatic attempt.
- H2: local and Telegram backups no longer fail the entire backup because of one missing/corrupt receipt. Broken receipt references are removed from the exported copy and the backup is explicitly marked partial; the user is warned.
- H3: Android `content://` restore paths have a platform-aware read fallback through the Tauri file resolver.
- M1: `payment_mode` is validated against `Cash | UPI | Card | null` across the relevant imported entities.
- M2: receipt sanitization now sniffs actual image bytes rather than trusting `File.type`, preventing empty-MIME files from bypassing EXIF stripping.
- M3: v3 `backup.json` is serialized compactly instead of pretty-printed, reducing memory and archive size.
- Final11 security changes remain intact: no plaintext secure-store fallback for Telegram credentials or backup passphrases.
- Telegram 5xx retry-recovery and manifest message-ID restore changes remain intact.

## Release verification still required

Source fixes are applied, but runtime/build verification must be performed on a release-capable environment:

```text
npm ci
npm run typecheck
npm run lint
npm run test
npm run verify:migration
npm run verify
```

Required physical tests:

1. Android A → Telegram backup → replacement Android B → manifest message/link restore.
2. Windows → Android and Android → Windows `.db` restore with receipt photos.
3. Merge restore twice with the same backup: no duplicate rows.
4. Backup with one missing receipt: partial backup, explicit warning, remaining data restorable.
5. Revoke Telegram token and relaunch: visible automatic-backup failure and retained reminder.
6. Android restore using a `content://` document URI.
7. Low-RAM large backup/import test.
8. Empty-MIME JPEG with GPS EXIF: stored/exported image has EXIF removed.
9. Legacy r5/r9/r13 fixtures and newer-schema rejection.
10. Parallel-device merge/conflict behavior and document-number collision test.

## Important scope note

The audit's M7/L1/L2/M5 items include product-policy or UX decisions rather than a single safe code fix: multi-device synchronization, numbering policy, timezone policy, and Android's public viewer handoff. They should be validated/decided separately rather than silently changing existing business semantics.
