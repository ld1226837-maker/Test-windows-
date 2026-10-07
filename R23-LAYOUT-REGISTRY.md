# R23 follow-up — layout registry (Arrange / Layout & arrangement)

Audit: every `<LayoutSection id>` / `<LayoutPart id>` rendered in `src/components/app/*.tsx`
was compared with `LAYOUT_REGISTRY` (`layout-prefs.ts`) and `SECTION_PARTS` (`layout-parts.ts`).

## Fixed (both trees, files byte-identical)
- `settings.receipt-storage` was rendered in SettingsTab but missing from `LAYOUT_REGISTRY`.
  `normalizeLayout` drops unknown sections, so `LayoutSection` returned null: the Receipt
  storage card (usage / integrity / repair / bulk import) never showed. Registered between
  `settings.loadtest` and `settings.danger-zone`. Existing installs get it appended, visible.
- `money.add-expense.payment-mode` ("Paid via") was rendered but unregistered, so it could not
  be hidden or reordered. Registered after Amount.
- `investments.summary.total` and `investments.summary.list` were registered but never wrapped
  in `<LayoutPart>`, so they did not appear in arrange mode. Now wired in InvestmentsTab
  (the investment rows that carry the R23 Print / PDF / Share actions live in `.list`).
- R23's new `ExpenseActions` (Print / PDF / Share) sits inside each row of the existing
  `money.recent.list` part. Rows are nested inside that part's frame, so a separate part
  cannot be toggled on its own; hiding/reordering is done at the `money.recent.list` level.

## Tests
- New `src/lib/layout-registry-coverage.test.ts`: fails if a rendered section/part id is not
  registered (this would have caught the Receipt storage bug).
- `layout-prefs.test.ts`: shipped Settings order now includes `settings.receipt-storage`.
- Android: tsc 0 errors, eslint clean, vitest 86 files / 1020 tests pass.
- Windows: tsc 0 errors, eslint clean on changed files, layout + investment UI tests pass
  (full Windows suite not re-run).

## Found, NOT changed (registered but never rendered; pre-existing, not R23)
`turf.new-booking.*` (12 parts), all `surface.*` pop-up parts (customer-detail, merge-bill,
merge-customers, archive-year, booking-extras), `settings.billing.*`, `settings.turf-rates.*`,
`customers.teams.list`, `home.calendar.widget`. They are listed in the registry but have no
`<LayoutPart>` in the UI, so they cannot be arranged yet.
