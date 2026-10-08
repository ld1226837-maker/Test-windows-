# Backup settings + Telegram passphrase fix (2026-10-08)
Applied identically to Android and Windows.
1. Backups (file + Telegram) now carry every user setting: layout arrangement, theme, team-related prefs, print, UPI/app settings, sort/UI prefs, first-run keys. Secrets (tokens, passphrase) are never included.
2. Settings are restored in both Replace and Add-records (merge) modes; the app refreshes afterwards so every screen shows the restored values.
3. Telegram restore (latest, by message, saved file) always asks for the passphrase first and decrypts with what was typed. Wrong passphrase keeps the pop-up open with an inline error. A fresh install saves the working passphrase.
4. Passphrase pop-up registered in Layout & arrangement as `surface.restore-passphrase` (explainer, passphrase box, buttons).
Tests: full vitest 96 files / 1121 tests pass (Android tree); tsc clean.
