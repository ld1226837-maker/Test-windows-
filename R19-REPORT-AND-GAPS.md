# R19 — Report and gaps (Windows + Android)

Applies to both trees. Source files are identical for every file listed below.

## 1. Expenses: attached receipt photo could not be viewed

**Likely cause (not reproduced on a device):** `ExpensesTab.openReceipt` handed the photo to an external viewer on Windows (`openPath`, allowed only under `$DOCUMENT/**` in `src-tauri/capabilities/default.json`) and to an Android intent. Both can fail silently. The Investments tab uses an in-app dialog and works.

**Changes**
- `src/components/app/ExpensesTab.tsx`: `openReceipt` now shows the in-app preview first on every platform and falls back to the external viewer. The add/edit form gets a "View attached photo" button. The preview dialog has an "Open in photo viewer" button on desktop.
- `src/lib/expenses.ts` `receiptPreviewUrl`: sniffs the image type from the bytes when a stored blob has no type, and on desktop prefers the sniffed type over the file extension.

## 2. Investments: row actions (add-only)

- `src/components/app/RecordActionRow.tsx`: new optional `omit` prop (default none, so existing callers are unchanged).
- `src/lib/investments.ts`: new `investmentReceiptDoc(row)`; `investmentInvoice` now uses it, same output.
- `src/components/app/InvestmentsTab.tsx`: each row gains Print, WhatsApp, Copy. Edit, View receipt, Delete and PDF-with-photo are untouched. Row buttons wrap on narrow screens.
- Performance: rows moved into a memoized `InvestmentListRow` with stable handlers, so typing in the form no longer re-renders every row.

## 3. Separate Teams export

- New `src/lib/teams-export.ts`: CSV, Excel, PDF, JSON; profiles `full` and `name-contact`; scopes `all` and `selected` customers. One row per player; a team without players keeps one row (full profile). Soft-deleted teams excluded. CSV neutralises formula injection like the customer export. Files go to `Invoices/Teams/` on desktop.
- `src/lib/customer-export.ts`: the save routine is now the exported `saveExportBytes` with defaults that keep the customer wording and folder.
- `src/components/app/CustomerDirectoryCard.tsx`: "Teams export" menu in the header and in the selected-customers bar. The customer export is unchanged.
- Tests: `src/lib/teams-export.test.ts`.

## 4. Export/import migration

- **Gap fixed:** `src/lib/backup.ts` merge renumbered clashing `INV-`, `TURF-`, `SB-`, `TX-` numbers but not investments. `INVES-YYYYMMDD-NNN` is now in the series (3-digit padding kept). Without this, two devices could end up with duplicate investment bill numbers.
- **New tests** (`src/lib/r19-migration-double-check.test.ts`): every database table is in the backup; investment number clash is renumbered; replace round-trip through serialize and decode returns investments, teams and players unchanged.
- `verification/migration-v9-static-regression.mjs`: three stale patterns fixed (formatting-sensitive regexes, a message that moved). Now 9 of 9 pass in both trees.

## 5. Speed

Already good: tabs load on demand, query results cached 60s, lists paged. Only the Investments row re-render was fixed (section 2).

## Verification status

- `tsc --noEmit`: clean, both trees. ESLint clean on touched files.
- New and related tests pass in both trees. Full-suite results are listed in the delivery message.
- Not verified: real Windows/Android receipt viewing, Telegram backup/restore, printing, installers.

## Open gaps (not changed)

1. **Same record edited on two devices:** merge keeps the local row and drops the incoming edit (documented in `backup.test.ts`). Edits can be lost. Needs a product decision.
2. **No receipt thumbnails** in the Expenses list, only an icon.
3. **Teams export does not include a "team size" column or per-customer subtotals.**
4. **Android capability scope** (`mobile.json`) was not changed or tested.
5. **Real-device checks still needed:** receipt view on Windows and Android, Teams export on Android (Downloads), Print from an investment row.
