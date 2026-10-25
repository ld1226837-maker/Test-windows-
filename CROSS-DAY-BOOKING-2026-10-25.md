# Cross-day / 24-hour bookings (5 AM–7 AM fix) — 2026-10-25

## Problem
A booking from **5 AM to 7 AM** could not be made. The turf's business day runs
6 AM → 6 AM, so 5 AM is "Late Night" of the *previous* date (minute 1740) and 7 AM
is the *next* business day's morning (minute 1860). `canEndAt` refused any end
past 6 AM (`end > MAX_END`), the picker had no slots past 6 AM, and the booked-slot
list never looked at the next date. Anything crossing the 6 AM cut-off was impossible.

## Plan
1. **Rules** (`slot-selection.ts`): a booking must still *start* inside its business
   day, but may *end* after 6 AM, as long as it is **at most 24 hours** and ends before
   `LAST_END` (3240). New exports: `LAST_END`, `MAX_SPAN`.
2. **Picker** (`time-slot-utils.ts`, `TimeSlotPicker.tsx`): new **Next Day** tab
   (business minutes 1800–3240). Slots there are END-only, disabled until a start
   is picked and beyond 24 h; shows "ends <next date>" in the summary and a
   "Need to go past 6 AM?" shortcut on the Late Night tab.
3. **Availability** (`TurfTab.tsx`, `courts.ts`): booked/free-court maps now include
   the Next Day window (next date's bookings), occupancy window widened 48 h → 72 h so a
   24 h booking sees everything it overlaps. Rate auto-pick ignores the Next Day tab
   so the price rate chosen for the start time is not overwritten.
4. **Unchanged on purpose**: save guard (`assertTurfSlotAvailableInTransaction`),
   `absInterval`, `courtHourSegments`, analytics — they already used absolute minutes.
   Covered with tests rather than edited.
5. **Tests**: update the old "cannot run past 6 AM" test and picker-parts test; add
   `cross-day-booking.test.ts` (pure) and section H in `slot-booking-guard.test.ts`
   (real Dexie guard).

## Scenario matrix (all covered by tests)
| # | Scenario | Start → End | Expected |
|---|----------|-------------|----------|
| S1 | **5 AM–7 AM** (60 min and 30 min grid) | 1740 → 1860 | allowed |
| S2 | 5:30–6:30 AM (30 min) | 1770 → 1830 | allowed |
| S3 | 5–6 AM and 6–7 AM separately | — | unchanged |
| S4 | Overnight 11 PM–1 AM, 12–6 AM | — | unchanged |
| S5 | 24 h 6 AM → 6 AM | 360 → 1800 | allowed (48 slots on 30 min) |
| S6 | 24 h 7 PM → 7 PM next evening | 1140 → 2580 | allowed |
| S7 | 24 h 5 AM → 5 AM (latest) | 1740 → 3180 | allowed |
| S8 | 25 h (6 AM→7 AM next, 7 PM→8 PM next, +30 min over) | — | refused |
| S9 | Next date's 6–7 AM already booked | 5–7 AM | refused; 5–6 AM ok; booking at 7 AM ok (half-open) |
| S9 | This date's 5–6 AM booked | 5–7 AM | cannot start |
| S9 | Saved 5–7 AM blocks next date 6–7 / 6:30–7:30 | — | refused; 7 AM ok |
| S9 | 24 h booking blocks everything inside it, frees at its end | — | refused / ok at end |
| S10 | 2 courts: two 5–7 AM fit, third refused; cancelled ignored | — | per-court |
| S11 | Save/edit label round-trip (5 AM–7 AM, 5 AM–5 AM = 24 h, 6 AM–6 AM = 24 h) | — | span preserved |

## How to book 5 AM–7 AM now
Pick the date → **Late Night** tab → tap **5 AM** → tap **Next Day** tab (or the
link under the grid) → tap **7 AM** (the end). Summary reads
`5 AM – 7 AM (ends <next date>) · 2 hr`.

## Files
`src/lib/{time-slot-utils,slot-selection,courts}.ts`,
`src/components/app/{TimeSlotPicker,TurfTab}.tsx`,
tests: `slot-selection`, `business-day`, `slot-booking-guard`, new `cross-day-booking`.
