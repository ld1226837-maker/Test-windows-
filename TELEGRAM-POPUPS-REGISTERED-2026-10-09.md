# Telegram card pop-ups registered in Layout & arrangement (2026-10-09)

Follow-up to the Test connection pop-up work. The other pop-ups on the Telegram
backup card were rendered without `LayoutParts`, so they could not be moved or
hidden. They are now registered in `SURFACE_REGISTRY` (`src/lib/layout-parts.ts`)
and wired with `<LayoutParts surfaceId>` / `<LayoutPart id>`.

| Surface | Where | Parts (locked = move only, cannot hide) |
|---|---|---|
| `surface.restore-confirm` | TelegramBackupCard (restore confirmation) | summary (locked), photos note, table breakdown, actions (locked) |
| `surface.telegram-qr` | TelegramBackupCard (QR display) | QR code (locked), instructions + bot-token warning (locked) |
| `surface.scan-confirm` | TelegramBackupCard (scanned details) | details preview (locked), actions (locked) |
| `surface.qr-scanner` | QrScannerDialog | camera (locked), manual entry (locked), tools (locked) |

Why locked: hiding the restore summary would hide what a restore deletes; hiding
the QR instructions would hide the "only show this to devices you own" warning;
hiding any scanner part would remove a way to enter the details.

Text, logic and buttons are unchanged. Existing installs get the new surfaces
added automatically (`normalizeLayout` builds surfaces from the registry).

Tests: `layout-registry-coverage.test.ts` now also checks that every pop-up in the
four Telegram files declares a `surfaceId`, that all six Telegram surfaces are
registered, and that each registered part is rendered somewhere.

## Also wired: the five R23 surfaces that were registered but never rendered
`surface.customer-detail`, `surface.merge-bill`, `surface.merge-customers` and
`surface.archive-year` now render through `LayoutParts`. The registry entries were
written ahead of the UI, so they were reconciled with what the dialogs really show
(unknown part ids are dropped on load, so nobody's saved layout is affected):

| Surface | Parts (locked = move only) |
|---|---|
| `surface.customer-detail` (pop-up **and** the desktop side pane, they share one component) | identity (locked), teams, totals, statement, dues = Settle all + pending breakdown (locked), tab card, Call/WhatsApp, history. Removed `favorites` (no such UI). |
| `surface.merge-bill` | explainer, customer name/phone (locked), bookings + snack bills (locked), due-tab option + total, Generate bill (locked). Added `customer`. |
| `surface.merge-customers` | explainer, keep (locked), merge (locked), final name/phone (locked), actions (locked). Added `final`. |
| `surface.archive-year` | explainer (locked), actions (locked). Removed `year` and `summary` (the dialog has no year picker; it is one paragraph). |

`surface.booking-extras` is still registered but has nothing to wire: booking step 3
(Extras) is an inline expandable section, not a pop-up. It is listed in
`NOT_YET_WIRED` in `layout-registry-coverage.test.ts`; that test now fails for any
other registered surface part that is not rendered.

New `surface-popups-render.test.tsx` opens the merge-customers and QR scanner pop-ups
and checks their text and buttons still render.

## Still not registered (unchanged, pre-existing)
Pop-ups elsewhere that do not use `LayoutParts`: calendar, customer directory/teams,
day close, UPI / collect payment, theme customizer, investments, print settings,
load test, archive card, clear-all-data, backup log sheet, backup card, and others.
