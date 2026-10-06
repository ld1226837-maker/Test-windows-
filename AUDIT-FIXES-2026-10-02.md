# Migration Audit Fixes — 2026-10-02

Applied to both Windows and Android trees.

## Production migration fixes

- `buildBackup()` now treats `expenses`, `investments`, and `bills` as the only business references that make a receipt photo portable.
- Orphan `db.receipts` rows are excluded from exported photo manifests.
- Orphan `receipt_hashes` rows are excluded from exported backups.
- `restoreBackup()` rejects an incoming photo manifest/photo entry that has no expense, investment, or bill reference.
- `restoreBackup()` rejects duplicate v3 photo-manifest paths before any destructive restore work.
- Bill receipt references are validated for safe paths and missing photos just like expense/investment receipt references.
- Unavailable receipt photos are explicitly nulled in exported copies for bills as well as expenses/investments.

## Verification fixes

- Verification customer timestamps are deterministic rather than `nowIso()`.
- Verification seed now exercises bill, expense, and investment receipt photos with deterministic PNG/JPEG/WebP bytes and capture-time SHA-256 rows.
- Verification seed includes a soft-deleted investment with a receipt photo.
- The conflicting-photo merge test now expects the implementation's fail-closed behavior and verifies local bytes are preserved.
- Added regression coverage for incoming orphan photos and duplicate v3 photo-manifest paths.
- Added regression coverage proving bill receipt photos export while unreferenced receipt rows do not.

## Previously reported findings rechecked

- F1 analytics TDZ: current `periodStats` implementation has no TDZ reference.
- F5 `moveBookingToTab` nonexistent `tabId`: current implementation uses `input.bookingId`; no stale `tabId` access remains.
- F10 `bill_no` scope: `nextSnackBillNo()` is assigned before transaction use/return.
- Payment test fixtures currently include `amount_paid` and required bill rows in the previously failing cases.

## Verification limitation

The supplied environment did not have the project npm dependencies available. `npm ci` could not complete before the environment transport timeout, so the full Vitest/typecheck/lint/load-test suite was not claimed as passed. The modified files produced no file-local TypeScript diagnostics from the global compiler; the project compiler still exits because dependency/type packages are unavailable.
