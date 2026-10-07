# R17 Data Migration Fixes — Final14

Final14 is based on the uploaded Final13 code and the original `Truff r17 — Data Migration Audit.md`.

## Additional fixes in Final14

- Unified local-settings filtering so internal migration/restore journal keys are excluded both from normal `.db` backup settings and the independent Telegram full-backup settings snapshot.
- Corrected the Telegram 5xx recovery regression fixture to use the production single-part filename (`turf-ledger-full-backup-<session>.zip`), allowing the recovery behavior to be tested against the actual transport contract.
- Corrected the backup-passphrase documentation so native Windows/Android builds are explicitly documented as secure-store-only; plaintext fallback is not used when native secure storage fails.
- Added a regression test proving internal migration/restore keys never enter portable local settings.
- Retained all Final12/Final13 fixes: restore-option propagation, non-reentrant Telegram restore locking, partial-photo backup behavior, Android `content://` fallback, payment-mode validation, byte-level EXIF validation, compact backup JSON, stale-artifact cleanup, private Android receipt viewing, TURF numbering separation, IST business-day numbering, receipt cleanup race fix, Telegram manifest/message-ID restore, secure credential/passphrase storage, and Telegram retry recovery.

## Release status

The remaining items in the original audit that cannot be honestly marked PASS by source editing alone are physical/runtime gates: Android `content://` behavior on real devices, Web Locks end-to-end, low-RAM large imports, old-version fixture migrations, parallel-device conflict policy, and real Telegram 5xx-after-success behavior.

Run on a release-capable machine:

```text
npm ci
npm run typecheck
npm run lint
npm run test
npm run verify:migration
npm run verify
```
