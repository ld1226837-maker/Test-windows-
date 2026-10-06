# R17 Final Migration Fixes

## Applied

1. Removed plaintext localStorage fallback for backup encryption passphrases on Android and desktop.
2. Removed plaintext localStorage read fallback for Telegram credentials on Android and desktop.
3. Legacy plaintext Telegram credential/passphrase keys are deleted after successful secure-store writes/deletes.
4. Android secure-store failure now fails closed instead of silently downgrading security.
5. Telegram 5xx retry now checks for an already accepted document before resending.
6. Successful sharded backups expose the manifest message ID to the UI and copy it when clipboard permission allows, so a replacement device can restore a historical backup using that durable locator.
7. Updated the stale Android secure-store test to require failure rather than plaintext fallback.
8. Added regression coverage for 5xx upload recovery and Android legacy plaintext credential isolation.

## Release verification required

Run on a machine with dependencies installed:

```text
npm ci
npm run typecheck
npm run lint
npm run test
npm run verify:migration
npm run verify
```

Then perform the physical Android Telegram replacement-device test and Windows <-> Android photo round-trip tests.
