# Booking scenarios — test plan (Windows, calendar-day model)

Automated: `src/lib/booking-scenarios.test.ts`. Run: `npx vitest run src/lib/booking-scenarios.test.ts`

## Rules under test
- Minutes are clock minutes of the booking's own date; Late Night (12–6 AM) is part of that same calendar date.
- A booking past midnight spills onto the next date (occupancy reads the previous date too).
- A single day's slots end at 12 AM, so one booking cannot exceed 24 h.
- Ends are exclusive: ending where another booking starts is allowed.

## Scenario matrix
| ID | Scenario | Expected | Automated |
|----|----------|----------|-----------|
| S1 | 6–8 AM; back-to-back 5–6 then 6–7 AM | Exact hours blocked; both fit | S1 |
| S2 | 12 AM → 12 AM (24 h) | Fills the whole date, nothing of the next | S2 |
| S2 | 6 AM → 6 AM next morning (24 h) | Blocks 6 AM–12 AM here and 12–6 AM next date | S2 |
| S2 | Empty day: every hour bookable | All fit | S2 |
| S3 | 10 PM → 2 AM | Spills 0–120 onto next date | S3 |
| S3 | Next-date 1 AM vs previous night's 11 PM–1 AM | Blocked; 1 AM–2 AM free | S3 |
| S4 | 5 AM → 7 AM | One date, labels round-trip | S4 |
| S4 | 5–7 AM vs 6–7 AM, both directions | Clash | S4 |
| S4 | 2 courts, one busy 6–7 AM | 1 free; 2-court refused | S4 |
| S5 | Utilisation segments: 5–7 AM one segment; 10 PM–2 AM splits | As stated | S5 |

## Manual checks on a device (not automated)
1. Late Night tab: tap 5 AM, then "End at 7 AM" → 5 AM – 7 AM · 2 hr, without changing tab.
2. Save, edit, reopen: same selection; receipt shows 5 AM – 7 AM.
3. Book 6–7 AM first, then 5–7 AM → refused.
4. 10 PM → 2 AM: next date's 12–2 AM shows booked.

## Known gaps
- The slot-tap logic is inline in `TurfTab.tsx`, so it is not unit-testable; the Android app extracts it as `slot-selection.ts`. Extracting it here would let the same S1–S4 tap tests run.
- Rate choice follows the last day-part tab, so a 5–7 AM booking is priced with the Morning rate if the end was picked there.
