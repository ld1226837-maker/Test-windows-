# UI fixes (Android)

- Cart-bar flag is only set while the Sell tab is on screen, so the scroll button no longer floats too high on other tabs (SnacksTab `active` prop, wired in routes/index.tsx).
- Bottom nav columns follow the number of visible tabs (no left-bunching when tabs are hidden).
- Back button returns to Home, or to the first visible tab when Home is hidden.
- Status strip: shorter offline copy on phones and `min-h` instead of a fixed height.
- Sell cart rows wrap on phones and use full-size controls; dialog close X and court steppers get a larger hit area.
- Time-slot swipe needs a clearly horizontal gesture and uses a ref for the start point.
- Money fields are text/decimal inputs instead of type=number; small red text meets contrast in dark mode.
- `dataset["cartBar"]` typing fixed (tsc clean); lint clean.

## Round 2

- Root wrapper uses `overflow-x-clip` instead of `overflow-x-hidden`: the latter made it a scroll container, so the header and status strip scrolled away instead of staying sticky.
- Global `button { font-size: 16px }` removed (inputs keep it); buttons inherit their size.
- `monthLabel` uses a 4-digit year ("Sept 2026"); the Expenses budget label uses it too.
- Accordion `Header` is `flex-1` (Settings chevrons at the right edge); section titles are spans, not headings/paragraphs/divs inside the trigger button.
- Each tab remembers its own scroll position; hidden tabs are wrapped in `<Activity>` (state kept, effects paused).
- Status strip and bottom nav (`chrome-solid`) are opaque.
- Keyboard-shortcuts hint hidden on touch devices.
- Year picker "·" removed; duplicate Expenses disclosure labels renamed; command-palette input clears the close button.

## Round 3 (shared with Windows)

- Stat labels (`MiniStat`, "Top expense category") wrap instead of truncating; values bottom-aligned.
- Reports month field uses the new `MonthPicker` ("Sept 2026") instead of `<input type="month">`.
- Outstanding list disclosure renamed "Balance list" (was a third "Outstanding" on the same screen).
- `PopularSnacksCard`: removed the nested `ResponsiveContainer` that triggered Recharts' "width and height are both fixed numbers" warning.

## Round 3 (shared with Windows)

- Stat labels (`MiniStat`, "Top expense category") wrap instead of truncating; values bottom-aligned.
- Reports month field uses the new `MonthPicker` ("Sept 2026") instead of `<input type="month">`.
- Outstanding list disclosure renamed "Balance list" (was a third "Outstanding" on the same screen).
- `PopularSnacksCard`: removed the nested `ResponsiveContainer` that triggered Recharts' "width and height are both fixed numbers" warning.

## Round 3b — self-audit (shared with Windows)

- Second-line text wraps instead of truncating in Outstanding, Expenses, Dashboard, Dues focus, Operational alerts, Top customers, Item performance and first-run checklist rows.
- Customer row badges wrap under the name; unlabeled delete/save icon buttons in Settings and the customer row now have accessible names.

## Round 3c (shared with Windows)

- `lib/auto-label.ts` links unassociated `<Label>`s to their controls (same helper + tests as Windows).
- Alert dialogs scroll within the viewport instead of overflowing; Telegram QR dialogs have descriptions.

## Round 3d (shared with Windows)

- Sell item tiles: two-line names + tooltip, out-of-stock badge keeps full contrast, cart/picker lines wrap.
- Global `:focus-visible` ring for raw buttons/links; Reports comparison tiles use `xl` for six columns.

## Round 4

**Android only — data missing on cold start (important)**

- `router.tsx` set `staleTime: 60_000` and `refetchOnMount: false`, and the data hooks start from `initialData: () => readCache(…, [])`. When no localStorage copy exists (a table over `CACHE_ROW_LIMIT` rows is never cached, storage cleared/full, first launch after an update) that empty `[]` counted as fresh data, so IndexedDB was never read: Home showed ₹0 and lists were empty until something was edited. With 2,163 bookings / 549 bills seeded, Home showed ₹0 / ₹0; it now shows ₹9,427 / ₹18,87,905.
- Fix: every `initialData` hook (`ops.ts`, `data.ts`, `expenses.ts`, `day-close.ts`, `tabs.ts`) gets `initialDataUpdatedAt: 0`, so the cached/empty seed is only a first paint that is always verified once; `refetchOnMount` is `true` (refetch only when stale). The 60 s reuse between tab visits is unchanged.
- Regression test: `lib/initial-data-refetch.test.tsx` (fails on the old code, passes now).
- Home month-comparison tiles use `xl` for six columns and can wrap values (this Round 3d change had only reached Reports on Android).

**Shared with Windows**

- **Close day button** (Home → Cash in drawer): the text block took the whole row and squeezed the button to ~51px, so "Close day" spilled out of the blue pill and read "Close d…". The text block is now `min-w-0 flex-1` and the button `shrink-0` (also the "Edit closing" variant).
- **Slot utilisation heatmap**: the fifth column (Night) sat behind an invisible sideways scroll on phones. The grid now fits 360px with short column names below `sm` (Late / Morn / Aft / Eve / Night). Cell text no longer switches to white on a 50–80 % blue tint (2.1–3.4 : 1); it keeps the normal text colour.
- **Selected calendar day**: the "n slots" caption was 80 % white on blue (3.5 : 1); it is full white when the day is selected.
- **Header**: the business name wraps to two lines instead of "Chennai Soccer & Sports S…", and the generic tagline is hidden below 640px.
- **Booking wizard**: on phones every step was an equal-width pill showing only a number, so the step name was never visible. The active step now takes the free width and shows its name; other steps shrink to their number.
- **Chart axes** show `₹3.6L` / `₹2.5k` (`moneyAxis` in `lib/money.ts`, unit-tested) instead of raw `360000`, on the two Home charts and the two money charts in Reports.
- **Truncation → wrapping** where the cut-off text was the important part: Operational-alert titles ("433 past bookings still marked Confirmed"), Expenses rows (category · business), customer-dialog history rows (the trailing "Due ₹…"), customer tab-ledger rows, the "statement is ready" banner, Dashboard collect-now rows.
- **Collect now rows** on 360px phones: the invoice number and date broke mid-token over three lines because the text was squeezed to ~90px. It now has a minimum width so the badge, amount and buttons wrap onto the next line instead.
- **Invalid HTML**: a status `Badge` (a `<div>`) sat inside a `<p>` in the Turf booking list and the Sell sales list, which React logs as a hydration error. Both wrappers are `<div>` now.
- **Phone field** (`CustomerFields`): the suggestion list stayed open, and covered the wizard's Next button, after a complete 10-digit number; it now closes at 10 digits, and its empty text no longer says "keep typing" for a full number.
- **Tap targets**: the backup-status button, setup-checklist toggles, Invoices bill checkbox and customer-name links get an invisible larger hit area (`::after`). The status button is limited by the header above it (~36px in total).
- Prettier formatting fixed in files flagged by the lint from earlier rounds (`PopularSnacksCard`, etc.).
