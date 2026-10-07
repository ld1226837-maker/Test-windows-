# R17 Data Migration Fixes — Final13

Applied from `Truff r17 — Data Migration Audit.md`.

## Fixed

- Critical restore option scope and Telegram nested lock (retained from Final12).
- Automatic-backup failure visibility and reminder behavior.
- Partial backup handling for missing/corrupt receipts.
- Android content:// restore fallback.
- Payment-mode enum validation.
- EXIF sanitization based on byte sniffing, not File.type.
- Compact backup JSON serialization.
- Startup cleanup of stale export/restore artifacts.
- Android receipt viewing no longer relies on stale source comments; receipt data remains app-private until explicitly exported.
- Distinct TURF document-number prefix prevents turf/bill number collisions.
- Document-number business day uses IST consistently.
- Expense receipt unmount race narrowed by synchronous ref updates.
- Migration marker keys are excluded from exported local settings.
- Telegram single-archive manifests now explicitly mark partial backups.
- Brittle source-text tests reduced in favor of behavioral/function checks.

## Runtime gates still required

- Physical Android content-URI restore.
- Web Locks Telegram restore end-to-end.
- Low-RAM large import.
- 5xx Telegram recovery.
- Old-version fixtures and parallel-device conflict behavior.
