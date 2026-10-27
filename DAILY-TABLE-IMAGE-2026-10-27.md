# Daily Summary picture (PNG) — 2026-10-27

Replaces text-only sharing of the day's ledger with a PNG of the table (1080 px wide, 2x, paper-white, blue ink) that can be sent via WhatsApp share, downloaded, or shared. Includes the earlier "zero remaining" patch (applied first).

## Files (identical in both trees except where noted)
New, src/lib: daily-table.ts, daily-table-image.ts, daily-table-share.ts, daily-table-actions.ts, and tests daily-table.test.ts, daily-table-image.test.ts, daily-table-share.test.ts, daily-table-settings.test.ts
New, src/components/app: DailyTableSummaryPanel.tsx (Settings card), DailyTableShortcut.tsx (Dashboard tile)
Edited: src/lib/settings.ts (+summaryImageLogo, +dailyOldCash), src/lib/biz.ts (export resolvedBusinessName), src/lib/layout-parts.ts (2 parts registered), src/components/app/QuickActionsCard.tsx, src/components/app/WhatsAppSummaryCard.tsx
Native (Android plugin, same on both): src-tauri/plugins/android-save/{src/lib.rs, build.rs, permissions/default.toml, android/.../AndroidSavePlugin.kt, android/.../android_save_file_paths.xml} — new `share_file` command
Zero-remaining patch (platform-specific receipt.ts): src/lib/merged-collect.ts, receipt.ts, tabs.ts, zero-remaining.test.ts, ZERO-REMAINING-2026-10-27.md

## Behaviour notes
- ADVANCE counts only "Advance"-stage payment lines (not bookingPaymentBreakdown().advance, which also includes a one-shot "Full payment") so a booking paid at once is not shown in both ADVANCE and CASH/ONLINE.
- Snacks row = every financial snack sale of the day (counter and booking-linked); merged bills appear once as their own row.
- Old cash: typed > saved for the day > previous day's final total (its remaining cash + old cash saved for it) > 0. The figure used is saved when a picture is generated.
- Numbers are plain digits (1170), NOTES are auto-filled ("Advance paid", "Offer 800") plus any booking note; text fallback follows the mockup layout.
- Dashboard tile is the 5th quick action (long-press = pick another day); Settings card shows the full table preview, cash cards and an Owner no. button.
- Nothing claims the image was "sent": toast is always "Choose the owner in WhatsApp to send".
