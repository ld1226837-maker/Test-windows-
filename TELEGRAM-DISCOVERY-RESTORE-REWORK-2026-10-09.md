# Telegram backup discovery / restore-selection rework (2026-10-09)
Applied identically to the Windows and Android trees (backup-only changes; no schema, no ledger features, no secure-store changes, archive formats and the transactional restore path untouched).

## Defects found
1. `telegramFetch` swallowed AbortError and retried (up to ~45 s per call), so Cancel did nothing and every list call could stall; `sleep` was not abortable.
2. `retryNetwork:false` on `sendDocument` was ignored, so a lost response was retried blindly inside the fetch wrapper before the filename reconciliation ran (possible duplicate part).
3. `listRecentTelegramBackups` had no deadline, forwarded each candidate through every bot (each with up to 5 retries), treated a non-document message as valid, and a single bad newest pointer wiped all remembered pointers.
4. A bot's transient error was hidden by another bot's "message not found".

## Changes (src/lib/telegram-backup.ts, TelegramBackupCard.tsx)
- Abortable sleep/fetch; callApi/readBackupMessage take a bounded attempt cap; cancel never retries, upload cancel is not treated as a lost response.
- `discoverTelegramBackups()` (bounded, 30 s deadline, cancellable): device-local pointers vs Telegram-discovered items (pinned, recent updates) kept as labelled `origins`; up to 3 backups are checked at once (newest-first order kept; one slow message can't hold up the rest); every candidate must forward as a document named as a manifest of the same session; failures go to `stale` with an actionable reason and never block the list; transient failures stay listed as "not checked"; always returns the limitation notes (bots cannot search old history) and the message-link / saved-file fallbacks. `listRecentTelegramBackups` remains as a thin wrapper.
- `BackupSelectionError` / `isStaleSelectionError`: a wrong, deleted, text or shard message is a per-item error; the card clears the selection, moves it to the stale list, and refreshes.
- Card: Cancel while loading, "Refresh list", inline retryable error, per-item origin/"not checked"/"can't be restored" rows, limitation notes.

## Tests
`src/lib/__tests__/telegram-discovery.test.ts` (25): expired/consumed updates, webhook conflict, deleted/incorrect message IDs, multiple bots, rate limits, deadline, bounded parallel checking, cancel, lost upload response, wrong passphrase, missing/corrupt shard, cancel before write, rollback on write failure.

## Not verifiable here
Live Telegram delivery/restore (no bot credentials), APK rebuild/signing, Gradle/cargo builds. A bot normally does not receive updates for its own messages, so reconciliation after a lost upload response can only find the part when Telegram surfaces it in getUpdates; otherwise the part is resent (an orphan duplicate message is possible but the manifest records only the accepted message IDs).

## Follow-up (screenshots of the shipped Android build)
The chat screenshot showed leftover "Forwarded from encrypt_bot_1_bot" manifest copies: checking a backup forwards its message (the only way a bot can read a message's file_id) and the delete of the copy was fire-and-forget, so any failure silently left clutter, and every refresh added more.
- The forwarded copy is now deleted and awaited (with a retry); if Telegram refuses (e.g. "message can't be deleted" — no permission), the copy is remembered on the device, retried on the next refresh, and the list tells the person how many remain and what to do (grant the bots delete permission, or delete them by hand). Only "message to delete not found" counts as already gone.
- The chat's current pinned backup (and recent update items) are confirmed from what Telegram just returned, with no forwarding at all, so the common case adds nothing to the chat.
- A real failure on one bot (download/decrypt/bad manifest) is no longer replaced by another bot's "message not found" in by-message restore.
- Embedded config of the supplied APK (com.turfledger.app, 0.1.0, security policy incl. connect-src api.telegram.org) matches the Android source tree.
Open question from the screenshots: the list showed "Message #33" for the 7:57:22 pm backup and restoring it reported "isn't in this chat any more" even though that manifest is visibly pinned in the chat. The exact cause could not be determined without the live bots (the real Telegram error text is not shown). With this build, that entry is checked against Telegram when the list loads and, if Telegram rejects it, appears under "can't be restored" with its reason rather than as a selectable backup.
