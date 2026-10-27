# Daily Summary: expenses list + cross-day marker
- Image/text/on-screen table now end with an EXPENSES table: DESCRIPTION (falls back to category), NOTES (adds "Cash part N" for UPI/Card expenses), AMOUNT (full amount), TOTAL EXPENSES (+ "Cash paid" when it differs from the cash block).
- Bookings running past the 6 AM cut-off get a NOTES marker: "Ends next day 7 AM"; 24 h bookings "24 hr booking | ends next day 7 PM".
- Text fallback (owner share) lists the same expenses.
- Files: lib/daily-table.ts, lib/daily-table-image.ts, DailyTableSummaryPanel.tsx (+ tests). Identical in Android and Windows trees.
- Not run here: vitest/tsc (registry unreachable); image render verified in Chromium.
