# Deep Audit v9 Fix Report

Basis: `migration-verification-prompt.md`.

## Fixed

- Same-ID/different-data merge conflicts now fail closed before any write. This removes order-dependent local-wins behavior and prevents child rows from attaching to an unresolved parent.
- Unknown-format conflicting document numbers now fail closed instead of preserving duplicate human-visible numbers.
- Referential-integrity validation now checks `customer_id` for bills, turf bookings, and snack sales.
- Sharded Telegram backup creation rejects orphan receipt metadata and orphan/missing receipt hashes.
- Sharded Telegram restore validates every receipt metadata row against a referenced business row and an actual photo shard.
- Sharded restore verifies `receipt_hashes` against the actual photo SHA-256.
- Sharded restore preserves the original receipt `created_at` metadata instead of generating a new timestamp.
- Added `verification/migration-v9-static-regression.mjs` to both trees.

## Verification performed

- v9 static regression script: PASS on Windows and Android.
- TypeScript transpilation/diagnostic check of changed migration/test files: PASS on both trees.
- Core `src/lib` parity excluding documented platform-specific implementation/test files: PASS.
- Platform-specific test divergence explicitly classified: `print.test.ts`, `printers.test.ts`.

## Runtime limitation

The full project `npm ci`, typecheck, lint, Vitest suite, migration suite, numeric suite, load test, Android runtime, Telegram transport, and failure-injection matrix were not executable in this environment because the supplied project dependency installation is incomplete/offline (`vite/client` and project test executables are unavailable). These remain NOT RUN, not PASS.
