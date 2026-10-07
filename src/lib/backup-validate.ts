import type { DataTable, Row } from "./localdb";
import { DATA_TABLES } from "./localdb";

/**
 * Per-row shape checks for a backup being restored, run before anything
 * reaches `bulkPut`/`bulkAdd` (`backup.ts`'s `restoreBackup`) or the
 * receipt-hash `bulkPut` in `telegram-backup.ts`'s `restoreFullBackup`.
 *
 * Until now, `parseBackup`/`parseFullBackupManifest` only checked the
 * envelope (`format`/`tables` presence) — a hand-edited or corrupted
 * `.db`/manifest file could carry a row missing its primary key, or with
 * the wrong type for a field the rest of the app assumes is present (e.g.
 * `amount` as a string, `items` as an object instead of an array). That
 * either throws a raw Dexie error mid-`restoreBackup` transaction — which
 * in `mode: "replace"` has already cleared the target tables, so the
 * failure leaves the ledger emptier than before the restore — or inserts a
 * row that crashes some unrelated read of the table much later, far from
 * the actual cause.
 *
 * This only checks the handful of fields serious enough to break something
 * structurally (the primary key, plus fields other code indexes into,
 * iterates as an array, or does arithmetic on). It is deliberately NOT a
 * full schema validator for every optional field — a backup from a
 * slightly older app version, missing a newer optional column, should
 * still restore cleanly. All checks run up front, before any table is
 * cleared or written to, so a bad backup fails closed with nothing touched
 * rather than partially applied.
 */

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isMoney = (v: unknown): v is number => isNum(v) && v >= 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isPaymentMode = (v: unknown): boolean => v == null || isStr(v);
/** F-16: payment rows and tab ledgers only ever carry received-at-counter
 * modes (On-tab balances live in tab_entries, never in payments.mode).
 * Restore must reject hand-crafted/foreign backups injecting unknown modes
 * instead of silently landing junk rows in the payments table (aggregates
 * would still coerce to Cash downstream, but statements and per-mode
 * ledgers would lie). */
const isReceivedMode = (v: unknown): boolean =>
  v === "Cash" || v === "UPI" || v === "Card";
const isTabEntryKind = (v: unknown): boolean =>
  v === "charge" || v === "payment";

/** Receipt paths are relative app-private paths. Reject traversal, absolute
 * paths, and alternate separators before any path reaches native filesystem
 * APIs during restore. */
export const isSafeReceiptPath = (v: unknown): v is string => {
  if (!isStr(v) || !v.startsWith("Receipts/") || v.length > 240) return false;
  if (v.includes("\\") || v.startsWith("/") || v.includes("..")) return false;
  // Never allow names that can escape the managed receipt area or be interpreted
  // as native special files / NTFS streams / shell wildcards.
  // eslint-disable-next-line no-control-regex -- control chars are exactly what we reject
  if (/[\u0000-\u001f:*?"<>|]/.test(v)) return false;
  const parts = v.split("/");
  for (const part of parts) {
    if (!part || part === ".") return false;
    if (part === ".restore-staging" || part === ".restore-rollback")
      return false;
    if (/[ .]$/.test(part)) return false;
    const stem = part.split(".")[0]!.toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return false;
  }
  return true;
};

export const normalizedReceiptPath = (path: string): string =>
  path.normalize("NFC").toLowerCase();

const isObj = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type FieldCheck = readonly [
  field: string,
  check: (v: unknown) => boolean,
  mode?: "optional",
];

export type RowProblem = { index: number; reason: string };

/**
 * Runs `checks` against every row in `rows`. Only reports the FIRST failing
 * field per row (enough to say "this row is broken", not every field wrong
 * with it) so one badly-shaped row doesn't produce a wall of near-duplicate
 * messages.
 */
function checkRows(
  rows: unknown[],
  checks: readonly FieldCheck[],
): RowProblem[] {
  const problems: RowProblem[] = [];
  rows.forEach((row, index) => {
    if (!isObj(row)) {
      problems.push({ index, reason: "row is not an object" });
      return;
    }
    for (const [field, check, mode] of checks) {
      const value = row[field];
      if (mode === "optional" && value === undefined) continue;
      if (!check(value)) {
        problems.push({
          index,
          reason: `"${field}" is missing or the wrong type`,
        });
        return;
      }
    }
  });
  return problems;
}

/**
 * Field checks per `DATA_TABLES` table. Not exhaustive — see the module
 * doc comment above for what's deliberately left unchecked.
 */
const TABLE_CHECKS: Record<DataTable, readonly FieldCheck[]> = {
  customers: [
    ["id", isStr],
    ["name", isStr],
  ],
  bills: [
    ["id", isStr],
    ["invoice_no", isStr],
    ["items", isArr],
    ["subtotal", isMoney],
    ["total", isMoney],
    ["amount_paid", isMoney],
    ["payment_mode", isPaymentMode, "optional"],
    ["receipt_path", (v) => v == null || isSafeReceiptPath(v), "optional"],
  ],
  expenses: [
    ["id", isStr],
    ["business", isStr],
    ["category", isStr],
    ["amount", isMoney],
    ["spent_at", isStr],
    [
      "payment_mode",
      (v: unknown): boolean => v == null || isReceivedMode(v),
      "optional",
    ],
  ],
  investments: [
    ["id", isStr],
    ["amount", isMoney],
    ["investment_date", isStr],
    [
      "bill_no",
      (v: unknown) =>
        v == null || (typeof v === "string" && /^INVES-\d{8}-\d{3}$/.test(v)),
      "optional",
    ],
    [
      "category",
      (v: unknown) => v == null || typeof v === "string",
      "optional",
    ],
    [
      "payment_mode",
      (v: unknown): boolean => v == null || isReceivedMode(v),
      "optional",
    ],
  ],
  teams: [
    ["id", isStr],
    ["customer_id", isStr],
    ["name", isStr],
  ],
  team_players: [
    ["id", isStr],
    ["team_id", isStr],
    ["name", isStr],
  ],
  calendar_events: [
    ["id", isStr],
    ["kind", isStr],
    ["title", isStr],
    ["start_at", isStr],
    ["all_day", isBool],
    ["repeat", isStr],
    ["status", isStr],
  ],
  calendar_event_exceptions: [
    ["id", isStr],
    ["event_id", isStr],
    ["occurrence_at", isStr],
    ["status", isStr],
  ],
  counters: [
    ["key", isStr],
    ["value", isNum],
    ["updated_at", isStr],
  ],
  history_entries: [
    ["id", isStr],
    ["rows", isArr],
    ["total", isMoney],
  ],
  turf_rates: [
    ["id", isStr],
    ["slot_name", isStr],
    ["rate_per_hour", isMoney],
    ["is_active", isBool],
  ],
  snack_items: [
    ["id", isStr],
    ["item_name", isStr],
    ["unit_price", isMoney],
    ["cost_price", isMoney],
    ["is_active", isBool],
    ["stock_quantity", isNum],
  ],
  snack_stock_history: [
    ["id", isStr],
    ["item_id", isStr],
    ["delta", isNum],
  ],
  turf_bookings: [
    ["id", isStr],
    ["booking_no", isStr],
    ["booking_date", isStr],
    ["hours", isNum],
    ["rate_per_hour", isMoney],
    ["total_amount", isMoney],
    ["snacks", isArr],
    ["payment_mode", isPaymentMode, "optional"],
  ],
  snack_sales: [
    ["id", isStr],
    ["bill_no", isStr],
    ["items", isArr],
    ["total", isMoney],
    ["payment_mode", isPaymentMode, "optional"],
  ],
  snack_combos: [
    ["id", isStr],
    ["name", isStr],
    ["items", isArr],
    ["price", isMoney],
  ],
  expense_budgets: [
    ["id", isStr],
    ["month", isStr],
    ["amount", isMoney],
  ],
  recurring_expenses: [
    ["id", isStr],
    ["title", isStr],
    ["amount", isMoney],
    ["day_of_month", isNum],
    ["is_active", isBool],
  ],
  customer_tabs: [
    ["id", isStr],
    ["customer_key", isStr],
    ["status", isStr],
  ],
  tab_entries: [
    ["id", isStr],
    ["tab_id", isStr],
    ["customer_key", isStr],
    ["kind", isTabEntryKind],
    ["amount", isMoney],
    [
      "payment_mode",
      (v: unknown): boolean => v == null || isReceivedMode(v),
      "optional",
    ],
  ],
  app_settings: [["key", isStr]],
  day_closes: [
    ["id", isStr],
    ["day", isStr],
    ["expected_in_drawer", isNum],
    ["counted_cash", isNum],
    ["variance", isNum],
  ],
  day_close_history: [
    ["id", isStr],
    ["day", isStr],
    ["previous_expected_in_drawer", isNum],
    ["previous_counted_cash", isNum],
    ["previous_variance", isNum],
  ],
  payments: [
    ["id", isStr],
    ["parent_type", isStr],
    ["parent_id", isStr],
    ["amount", isMoney],
    ["mode", isReceivedMode],
    ["received_at", isStr],
  ],
};

const FULL_BACKUP_EXTRA_TABLES = new Set(["receipts", "receipt_hashes"]);

/** Validate the backup envelope before any row-level validation or restore. */
export function validateBackupTablesEnvelope(
  tables: unknown,
  options: {
    requireAllDataTables?: boolean;
    allowFullBackupExtras?: boolean;
  } = {},
): asserts tables is Record<string, unknown[]> {
  if (!isObj(tables)) throw new Error("Backup tables must be an object");

  const allowed = new Set<string>(DATA_TABLES);
  if (options.allowFullBackupExtras)
    for (const extra of FULL_BACKUP_EXTRA_TABLES) allowed.add(extra);
  for (const key of Object.keys(tables)) {
    if (!allowed.has(key))
      throw new Error(`Backup contains an unknown table "${key}"`);
    if (!isArr(tables[key]))
      throw new Error(`Backup table "${key}" is not an array`);
  }

  if (options.requireAllDataTables) {
    const missing = DATA_TABLES.filter((t) => !(t in tables));
    if (missing.length > 0)
      throw new Error(
        `Full backup is missing required table${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      );
    // `receipts` is the actual photo metadata store. `receipt_hashes` was
    // introduced later as supplemental integrity metadata, so older Telegram
    // full backups may legitimately omit it; absence must not make an otherwise
    // restorable investment/expense photo backup fail closed.
    if (!("receipts" in tables))
      throw new Error(`Full backup is missing required table "receipts"`);
  }
}

export type InvalidRow = { table: DataTable; index: number; reason: string };

/**
 * Validates every row of every `DATA_TABLES` table in a backup snapshot.
 * Returns the list of problems found (empty = the backup looks
 * restorable). `tables` takes the same loose shape `BackupFile["tables"]`
 * and `FullBackup["tables"]` already share, so it works for both.
 */
export function findInvalidRows(
  tables: Record<string, unknown[] | undefined>,
): InvalidRow[] {
  const problems: InvalidRow[] = [];
  for (const t of DATA_TABLES) {
    const rows = tables[t] ?? [];
    for (const p of checkRows(rows, TABLE_CHECKS[t]))
      problems.push({ table: t, ...p });

    // Dexie's bulkPut is last-write-wins for duplicate primary keys. A
    // duplicated id inside a backup therefore silently destroys one row
    // during restore instead of restoring the snapshot faithfully. Reject
    // duplicates before any table is cleared or written.
    // Dexie primary keys are not uniformly named `id`: app_settings is keyed
    // by `key`. Validate the actual primary-key field so duplicate settings
    // cannot silently overwrite each other during bulkPut.
    const primaryKey = t === "app_settings" ? "key" : "id";
    const seen = new Set<string>();
    const enumValues: Record<string, readonly string[]> = {
      "customer_tabs.status": ["open", "closed"],
      "tab_entries.kind": ["charge", "payment"],
      "payments.parent_type": ["bill", "turf_booking", "snack_sale"],
      "payments.mode": ["Cash", "UPI", "Card"],
    };
    rows.forEach((row, index) => {
      if (!isObj(row)) return;
      for (const [key, allowed] of Object.entries(enumValues)) {
        const [tableName, field] = key.split(".");
        if (!field) continue;
        if (
          tableName === t &&
          row[field] != null &&
          !allowed.includes(String(row[field]))
        )
          problems.push({
            table: t,
            index,
            reason: `${field} has invalid value "${String(row[field])}"`,
          });
      }
      for (const pathField of ["receipt_path"]) {
        if (row[pathField] != null && !isSafeReceiptPath(row[pathField]))
          problems.push({
            table: t,
            index,
            reason: `unsafe receipt path in "${pathField}"`,
          });
      }
      for (const field of [
        "spent_at",
        "booking_date",
        "received_at",
        "created_at",
        "opened_at",
        "closed_at",
        "entry_date",
        "start_at",
        "end_at",
        "updated_at",
      ]) {
        if (row[field] == null) continue;
        const value = String(row[field]);
        if (field === "closed_at" && value === "") continue;
        if (Number.isNaN(Date.parse(value)))
          problems.push({
            table: t,
            index,
            reason: `invalid date/time in "${field}"`,
          });
      }
      if (!isObj(row) || !isStr(row[primaryKey])) return;
      const value = row[primaryKey];
      if (seen.has(value))
        problems.push({
          table: t,
          index,
          reason: `duplicate primary key "${value}"`,
        });
      else seen.add(value);
    });
  }
  // Cross-table foreign-key checks and investment amount sanity. Bill numbers
  // are logical unique identifiers even though the local table uses id as its
  // physical primary key, so reject duplicate imported numbers.
  const investmentBills = new Set<string>();
  for (const [i, r] of (tables["investments"] ?? []).entries()) {
    if (!isObj(r)) continue;
    const bill = r["bill_no"];
    if (typeof bill === "string" && bill) {
      if (investmentBills.has(bill))
        problems.push({
          table: "investments",
          index: i,
          reason: `duplicate bill number "${bill}"`,
        });
      investmentBills.add(bill);
    }
    const text = String(r["amount"]);
    if (Number(r["amount"]) <= 0)
      problems.push({
        table: "investments",
        index: i,
        reason: "amount must be greater than zero",
      });
    if (Number(r["amount"]) > 1_000_000_000_000)
      problems.push({
        table: "investments",
        index: i,
        reason: "amount is too large",
      });
    if (!/^\d+(?:\.\d{1,2})?$/.test(text))
      problems.push({
        table: "investments",
        index: i,
        reason: "amount must have at most 2 decimal places",
      });
  }
  const customers = new Set(
    (tables["customers"] ?? []).filter(isObj).map((r) => String(r["id"])),
  );
  const teams = new Map(
    (tables["teams"] ?? [])
      .filter(isObj)
      .map((r) => [String(r["id"]), String(r["customer_id"])]),
  );
  for (const [i, r] of (tables["teams"] ?? []).entries())
    if (isObj(r) && !customers.has(String(r["customer_id"])))
      problems.push({
        table: "teams",
        index: i,
        reason: `customer_id "${String(r["customer_id"])}" does not exist`,
      });
  for (const [i, r] of (tables["team_players"] ?? []).entries())
    if (isObj(r) && !teams.has(String(r["team_id"])))
      problems.push({
        table: "team_players",
        index: i,
        reason: `team_id "${String(r["team_id"])}" does not exist`,
      });
  const eventIds = new Set(
    (tables["calendar_events"] ?? []).filter(isObj).map((r) => String(r["id"])),
  );
  for (const [i, r] of (tables["calendar_event_exceptions"] ?? []).entries())
    if (isObj(r) && !eventIds.has(String(r["event_id"])))
      problems.push({
        table: "calendar_event_exceptions",
        index: i,
        reason: `event_id "${String(r["event_id"])}" does not exist`,
      });
  const eventKinds = new Set(["reminder", "meeting", "event"]),
    repeats = new Set(["none", "daily", "weekly", "monthly", "yearly"]),
    statuses = new Set(["pending", "done", "cancelled"]);
  for (const [i, r] of (tables["calendar_events"] ?? []).entries())
    if (isObj(r)) {
      if (!eventKinds.has(String(r["kind"])))
        problems.push({
          table: "calendar_events",
          index: i,
          reason: `invalid kind "${String(r["kind"])}"`,
        });
      if (!repeats.has(String(r["repeat"])))
        problems.push({
          table: "calendar_events",
          index: i,
          reason: `invalid repeat "${String(r["repeat"])}"`,
        });
      if (!statuses.has(String(r["status"])))
        problems.push({
          table: "calendar_events",
          index: i,
          reason: `invalid status "${String(r["status"])}"`,
        });
    }
  // A row should contribute at most one actionable validation problem. Several
  // semantic checks run after the structural checks above; without this final
  // de-duplication a malformed row could be reported once for its shape and
  // again for an enum/date/foreign-key-style invariant.
  const unique = new Map<string, InvalidRow>();
  for (const problem of problems) {
    const key = `${problem.table}:${problem.index}`;
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, problem);
      continue;
    }
    // Structural checks run first, but an enum/path/domain-specific check is
    // more actionable when the row shape itself is otherwise valid. Do not
    // let the generic “missing or wrong type” message hide the exact reason
    // (for example, an invalid payment mode). Preserve other first-failure
    // semantics so duplicate/primary-key diagnostics remain stable.
    if (
      previous.reason.includes("missing or the wrong type") &&
      !problem.reason.includes("missing or the wrong type")
    ) {
      unique.set(key, problem);
    }
  }
  return [...unique.values()];
}

/** One line summarizing every problem found, for an error toast. */
export function describeInvalidRows(problems: InvalidRow[]): string {
  const byTable = new Map<DataTable, number>();
  for (const p of problems)
    byTable.set(p.table, (byTable.get(p.table) ?? 0) + 1);
  const parts = [...byTable.entries()]
    .map(([t, n]) => `${n} in ${t}`)
    .join(", ");
  const reasons = problems
    .slice(0, 3)
    .map((p) => `${p.table}[${p.index}]: ${p.reason}`)
    .join("; ");
  return `This backup has ${problems.length} row${
    problems.length === 1 ? "" : "s"
  } that don't look right (${parts})${reasons ? ` — ${reasons}` : ""} — nothing was restored.`;
}

const RECEIPT_HASH_CHECKS: readonly FieldCheck[] = [
  ["path", isSafeReceiptPath],
  ["sha256", (v) => isStr(v) && /^[0-9a-f]{64}$/i.test(v)],
];

/** Same shape check as `findInvalidRows`, for the `receipt_hashes` rows a
 *  full Telegram backup restores separately (they aren't in `DATA_TABLES`). */
export function findInvalidReceiptHashRows(rows: unknown[]): RowProblem[] {
  const problems = checkRows(rows, RECEIPT_HASH_CHECKS);
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isObj(row) || !isStr(row["path"])) return;
    const normalized = normalizedReceiptPath(row["path"]);
    if (seen.has(normalized))
      problems.push({
        index,
        reason: `duplicate primary key "${row["path"]}"`,
      });
    else seen.add(normalized);
  });
  return problems;
}

const PHOTO_CHECKS: readonly FieldCheck[] = [
  ["path", isSafeReceiptPath],
  ["data", isStr],
  ["created_at", isStr],
];

/** Same shape check, for the inline base64 `photos[]` a version-2 local
 *  `.db` backup carries (`BackupPhoto` in backup.ts). */
export function findInvalidPhotoRows(rows: unknown[]): RowProblem[] {
  const problems = checkRows(rows, PHOTO_CHECKS);
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isObj(row) || !isStr(row["path"])) return;
    const normalized = normalizedReceiptPath(row["path"]);
    if (seen.has(normalized))
      problems.push({
        index,
        reason: `duplicate primary key "${row["path"]}"`,
      });
    else seen.add(normalized);
  });
  return problems;
}
