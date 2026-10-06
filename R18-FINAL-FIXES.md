# Truff R18 Final Fixes — Android

Applied to the Android tree after the R18 partial audit.

## Fixed

- Single-file full-backup restore preserves receipt/investment photos.
- Calendar recurrence uses IST wall-clock arithmetic, including month-end and leap-day clamping.
- Pending overdue reminders are retained beyond the previous 30-day dashboard query window, including recurring reminders.
- Reminder delivery uses the Web Notification API when permission is already granted, with the existing alert fallback.
- Team/player/calendar edits preserve `created_at` and update only `updated_at`.
- Customer phone input normalizes Arabic/Persian/Devanagari decimal digits before validation/storage.
- Removed brittle Telegram tests that inspected implementation source via `Function.toString()`; behavioral coverage remains in the restore/upload tests.

## Verification limitation

The repository archives do not contain a complete installed dependency tree. A clean `npm ci` was attempted but exceeded the execution window; therefore a full typecheck, lint, and Vitest suite could not be truthfully reported as passing. The available global TypeScript check reaches the project configuration but stops because `vite/client` is unavailable without the installed project dependencies.
