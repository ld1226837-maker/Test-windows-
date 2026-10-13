# SUITE-AUDIT (Phase 4)

How it was done: static scan of every status comparison, every date-key
pattern and every mutation hook (which tables it writes vs which query keys it
invalidates), then reading each screen's money source and each export's columns,
then cross-surface tests on real fake-indexeddb data.
Result column: PASS = checked and consistent; FIXED = found a fault, fixed, test added;
NOT CHECKED = not examined (see the end).

## Findings fixed

| # | Where | Fault | Fix | Regression test |
|---|-------|-------|-----|-----------------|
| 1 | Dashboard "Pending dues" + dues card | Counted bills + turf only; Outstanding also counted running-tab snack debt, so the two totals differed. Walk-ins who were never saved as a contact and had only a pending booking/bill were missing from Outstanding. | `pendingMoneyIndex()` in dues.ts is used by both; the card shows the running-tab remainder separately | suite-consistency (dues = outstanding = ageing, tab gap) |
| 2 | Snack sale creation | Wrote payment rows but never refreshed `payments` (Cash/UPI split + drawer stale up to 60 s) | `payments` added to onSuccess | suite-audit-regressions (hook test) |
| 3 | Bills Excel export (Bills screen and Reports) | Balance used `balanceOf` (ignores money moved to a tab); Status was the raw stored string | `billExportStatus()`: Balance = `billDue`, Status = Cancelled / Pending / Paid | suite-consistency (4 cases) |
| 4 | Bills screen | "Overdue" flag and the Pending sort used `balanceOf`, so a bill whose due sits on the tab was flagged overdue / sorted by money it no longer owes | Both use `billDue` | covered by #3 helper semantics (UI wiring only) |
| 5 | Snack Excel export | No status column; a voided sale's Amount/Profit summed as revenue | `snackExportLine()`: Status column; voided = 0 Amount/Profit | suite-consistency |
| 6 | TurfUtilizationCard, merge.ts, ops.ts | Raw "Cancelled"/"No-show"/`.cancelled` checks | `isLive` / `isCancelled` | suite-audit-regressions (source guard) |
| 7 | Customer and team exports | UTC date in file name (previous day 00:00-05:30 IST) | `localDateStr()` | suite-audit-regressions (source guard) |

## Screen by check

| Screen | Status wording | Cancelled / no-show / merged | Pending amount | Refund | Tax | Cash/UPI split | IST dates | Cache after mutation | Export / copy numbers |
|---|---|---|---|---|---|---|---|---|---|
| Dashboard | PASS | PASS | FIXED (#1) | PASS (drawerCashOn, Phase 3 tests) | PASS (periodStats) | PASS | PASS | PASS | PASS |
| Turf | PASS | FIXED (#6) | PASS (bookingDue) | PASS (two-step, Phase 2) | PASS (read) | PASS | PASS | PASS | PASS (Balance due = bookingDue) |
| Snacks | PASS | PASS | PASS | PASS | NOT CHECKED | PASS | PASS | FIXED (#2) | FIXED (#5) |
| Bills | PASS | PASS | FIXED (#4) | PASS | NOT CHECKED | PASS | PASS | PASS | FIXED (#3) |
| Customers | PASS | PASS | PASS (customerOutstandingIndex) | n/a | n/a | n/a | FIXED (#7) | PASS | FIXED (#7) |
| Outstanding | PASS | PASS | FIXED (#1) | n/a | n/a | n/a | PASS | PASS | n/a |
| Reports | PASS | PASS | PASS (period dues by design, see rules) | PASS | PASS (taxReport) | PASS | PASS | n/a | FIXED (#3) |
| Settings | n/a | n/a | n/a | n/a | NOT CHECKED | n/a | PASS | n/a | n/a |
| WhatsApp card / copy text | NOT CHECKED | NOT CHECKED | NOT CHECKED | NOT CHECKED | NOT CHECKED | n/a | n/a | n/a | NOT CHECKED |
| Printed bill | PASS (unchanged wording) | PASS | NOT CHECKED against exports | NOT CHECKED | NOT CHECKED | n/a | n/a | n/a | NOT CHECKED |

Cache audit: every `useMutation` hook was listed with the tables it writes and
the keys it invalidates (about 60 hooks); #2 was the only gap.

## Decisions / open rules (please confirm)

1. `periodStats().dues` excludes running-tab money (period figure). Reports "Dues" therefore differs from the Outstanding total by the tab part. Change it only if you want tabs in period reports.
2. The Dashboard "Collect now" list and age buckets stay bill/turf rows; the dues card states the tab remainder in text instead.
3. Bills Excel Status wording changed from stored values (unpaid/partial/paid/cancelled) to Cancelled/Pending/Paid. Anyone parsing the old words in a spreadsheet will see the change.
4. Source-guard allowlist: load-test generators, the remaining-summary input flag, a status chip's colour in TurfTab.

## Not checked (honest list)

WhatsApp card / copy text against printed bill against Excel for the same record
(only the Bills and Snacks exports were compared with the screens); tax on
snack and bill totals across screens; Settings. No manual click-through of any
screen was possible.
