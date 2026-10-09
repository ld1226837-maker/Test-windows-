# Backup discovery fix (2026-10-09)
- validateRemotePointers: a missing newest backup now drops only that one remembered backup; older saved history is kept. Full wipe stays on the explicit "Reset Telegram backup links" button.
- discoverTelegramBackups: bots are probed in parallel (getChat + getUpdates), so one slow bot can't use up the 30 s budget.
- Cleanup of leftover forwarded copies now runs after the list is built and is capped at 3 s, so it can't delay "Loading backups…".
- Added regression test: src/lib/__tests__/telegram-stale-pointer-keeps-history.test.ts
Telegram limit unchanged: bots cannot search old chat history; older or cross-device backups need the pasted message link or a saved file.
