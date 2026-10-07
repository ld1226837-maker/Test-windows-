import type { QueryClient } from "@tanstack/react-query";

/** Canonical query roots for data that can change through restore/clear/load-test operations. */
export const DATA_QUERY_KEYS = [
  "customers",
  "bills",
  "payments",
  "turf_bookings",
  "snack_sales",
  "expenses_v2",
  "expenses",
  "customer_tabs",
  "tab_entries",
  "teams",
  "team_players",
  "team_players_count",
  "calendar_events",
  "investments",
  "slot_durations",
  "turf_rates",
  "snack_items",
  "snack_stock_history",
  "snack_combos",
  "expense_budgets",
  "recurring_expenses",
  "day_closes",
  "day_close_history",
  "history",
] as const;

export async function invalidateAllDataQueries(qc: QueryClient) {
  await Promise.all(
    DATA_QUERY_KEYS.map((key) => qc.invalidateQueries({ queryKey: [key] })),
  );
}
