# R17 Data Migration Fixes — Final15

Applied to Windows and Android.

- Parallel-device merge now remaps conflicting human-visible document numbers (`INV-`, `TURF-`, `SB-`, `TX-`) to a free sequence instead of leaving duplicates. Primary-key/foreign-key ID remapping remains unchanged.
- Single-archive and sharded Telegram manifests explicitly mark partial backups and include an omission warning when receipt files are missing/corrupt.
- Telegram backup history now has a bounded retention policy (7 completed uploads) with best-effort deletion of older bot messages; deletion failures never invalidate a successful backup.
- Existing Final14 security, restore-lock, partial-photo, Android content-URI, EXIF, private-receipt, journal cleanup, and Telegram manifest fixes are retained.

## Verification limitation

Full TypeScript/test verification still requires a complete dependency installation on a release machine. Do not treat source-level completion as a substitute for physical Android/Telegram runtime tests.
