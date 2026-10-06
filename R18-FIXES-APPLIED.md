# R18 fixes applied

- Fixed single-file full-backup restore to preserve receipt references while validated receipt files are rebuilt, matching the sharded restore boundary.
- Fixed calendar recurrence arithmetic to use Asia/Kolkata wall-clock fields, including month-end and leap-day rules.
- Fixed dashboard overdue-reminder retrieval so pending reminders older than 30 days are still included without widening ordinary event queries.
- Fixed team, team-player, and calendar-event edits to preserve `created_at` while updating `updated_at`.
- Added regression coverage for month-end and leap-day recurrence behavior.
