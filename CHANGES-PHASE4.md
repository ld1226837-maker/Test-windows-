# Phase 4 - suite consistency

New: src/lib/bill-export.ts, src/lib/snack-export.ts, dues.ts `pendingMoneyIndex`,
tests suite-consistency.test.ts (4) and suite-audit-regressions.test.tsx (3).
Changed: DashboardTab, DuesFocusCard, OutstandingTab, BillsTab, ReportsTab,
SnackSalesList, TurfUtilizationCard, ops.ts, merge.ts, customer-export.ts,
teams-export.ts, docs/calculation-rules.md. No stored field added, removed or renamed.
No new UI part, so no layout-registry change. See SUITE-AUDIT.md.

Decisions (final): Bills Excel Status stays Cancelled/Pending/Paid; Reports "Dues"
stays per-period bill+turf with the tab total shown separately; Dashboard tab rows
are display and reminder only. Written into docs/calculation-rules.md.
