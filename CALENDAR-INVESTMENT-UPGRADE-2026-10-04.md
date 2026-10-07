# Calendar, Investments, Receipts & Billing Upgrade — 2026-10-04

Applied consistently to the Windows and Android source trees.

## Implemented
- Calendar month navigation, Today, day selection, visible event titles, selected-day agenda, empty states, booking + manual-event merging, category legend/filter, colors, all-day/timed presentation, labelled scrollable add/edit dialog, and explicit recurring-series vs occurrence editing.
- Investment scrollable labelled dialog with fixed actions, controlled category/payment choices, validation, recoverable form state, stable bill numbers, sorting/filtering, active-filter reset, and Excel export using the same ordered result set.
- Investment bill numbers: `INVES-YYYYMMDD-NNN`, generated transactionally from the investment date, preserved on edits/date changes, with deterministic legacy/import backfill.
- Receipt validation (real image sniffing remains in the existing storage layer plus a 10 MB UI limit), immediate thumbnail, full-screen preview with zoom/rotate, native open/download paths, reference-aware removal, and missing-file handling.
- Investment PDFs now use the investment bill number and metadata and preserve receipt-photo aspect ratio, with multi-page slicing for tall images.
- Local DB upgraded from v16 to v17; existing data, recurrence exceptions, receipt paths, and backup tables remain intact.
- Backup validation accepts and validates the new investment fields and rejects duplicate investment bill numbers; legacy/imported rows are backfilled before derived counters are rebuilt.

## Verification
- Windows and Android modified shared files were kept byte-identical where platform behavior is not intentionally different.
- TypeScript syntax pass completed with system TypeScript 5.8.3 and no syntax diagnostics in the modified files.
- Full `npm test`, `npm run lint`, and production builds could not be executed in this environment because `npm ci` could not obtain `zod@3.25.76` from the configured registry/cache. No dependency directory is included in the packages.
