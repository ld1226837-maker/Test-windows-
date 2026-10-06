import { toast } from "sonner";
import { db } from "./localdb";
import { exportToExcel } from "./xlsx";
import { downloadReportPdf } from "./report-pdf";
import { saveExportBytes } from "./customer-export";

/**
 * Teams & players export — a separate export from the Customers one, offering
 * the same formats (CSV / Excel / PDF / JSON), the same "full" vs
 * "name-contact" profiles and the same "all" vs "selected customers" scopes.
 *
 * The output is one flat row per player (a team with no players still gets a
 * single row so the team is never lost), so it opens cleanly in any
 * spreadsheet and round-trips through JSON without joins.
 */

export type TeamExportFormat = "csv" | "xlsx" | "json" | "pdf";
export type TeamExportProfile = "full" | "name-contact";
export type TeamExportScope = "all" | "selected";

export type TeamExportRow = {
  "Customer ID": string;
  Customer: string;
  "Customer phone": string;
  "Team ID": string;
  Team: string;
  "Team notes": string;
  "Player ID": string;
  Player: string;
  "Player phone": string;
  "Player notes": string;
};

export type TeamNameContactRow = {
  Team: string;
  Player: string;
  "Contact No": string;
};

type CustomerLike = { id: string; name: string; phone?: string | null };
type TeamLike = {
  id: string;
  customer_id: string;
  name: string;
  notes?: string | null;
  deleted_at?: string | null;
};
type PlayerLike = {
  id: string;
  team_id: string;
  name: string;
  phone?: string | null;
  notes?: string | null;
};

const TEAM_COLUMNS: (keyof TeamExportRow)[] = [
  "Customer ID",
  "Customer",
  "Customer phone",
  "Team ID",
  "Team",
  "Team notes",
  "Player ID",
  "Player",
  "Player phone",
  "Player notes",
];
const NAME_CONTACT_COLUMNS: (keyof TeamNameContactRow)[] = [
  "Team",
  "Player",
  "Contact No",
];

const dateStamp = () => new Date().toISOString().slice(0, 10);

/** Same CSV rules as the customer export: quote when needed, and neutralise
 * spreadsheet formula injection while keeping phone numbers as text. */
function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Joins customers, teams and players into flat export rows. Pure — all the
 * filtering (soft-deleted teams, customer scope) happens here so it can be
 * unit-tested without a database.
 *
 * `customerIds` limits the export to those customers' teams ("selected"
 * scope); `undefined` means every team.
 */
export function buildTeamExportRows(
  customers: CustomerLike[],
  teams: TeamLike[],
  players: PlayerLike[],
  customerIds?: ReadonlySet<string>,
): TeamExportRow[] {
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const playersByTeam = new Map<string, PlayerLike[]>();
  for (const p of players) {
    const list = playersByTeam.get(p.team_id);
    if (list) list.push(p);
    else playersByTeam.set(p.team_id, [p]);
  }
  const live = teams
    .filter(
      (t) => !t.deleted_at && (!customerIds || customerIds.has(t.customer_id)),
    )
    .sort((a, b) => {
      const ca = customerById.get(a.customer_id)?.name ?? "";
      const cb = customerById.get(b.customer_id)?.name ?? "";
      return (
        ca.localeCompare(cb, "en", { sensitivity: "base" }) ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" })
      );
    });
  const out: TeamExportRow[] = [];
  for (const team of live) {
    const customer = customerById.get(team.customer_id);
    const base = {
      "Customer ID": team.customer_id,
      Customer: customer?.name ?? "",
      "Customer phone": customer?.phone ?? "",
      "Team ID": team.id,
      Team: team.name,
      "Team notes": team.notes ?? "",
    };
    const teamPlayers = (playersByTeam.get(team.id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    );
    if (teamPlayers.length === 0) {
      out.push({
        ...base,
        "Player ID": "",
        Player: "",
        "Player phone": "",
        "Player notes": "",
      });
      continue;
    }
    for (const p of teamPlayers) {
      out.push({
        ...base,
        "Player ID": p.id,
        Player: p.name,
        "Player phone": p.phone ?? "",
        "Player notes": p.notes ?? "",
      });
    }
  }
  return out;
}

/** Name + contact only: one row per player that has a name. Teams without
 * players are skipped (there is no contact to list). */
export function teamNameContactRows(
  rows: TeamExportRow[],
): TeamNameContactRow[] {
  return rows
    .filter((r) => r["Player ID"] !== "")
    .map((r) => ({
      Team: r.Team,
      Player: r.Player,
      "Contact No": r["Player phone"],
    }));
}

export function teamsToCsv(rows: TeamExportRow[]): string {
  return [
    TEAM_COLUMNS.map(csvCell).join(","),
    ...rows.map((row) =>
      TEAM_COLUMNS.map((column) => csvCell(row[column])).join(","),
    ),
  ].join("\r\n");
}

export function teamNameContactsToCsv(rows: TeamNameContactRow[]): string {
  return [
    NAME_CONTACT_COLUMNS.map(csvCell).join(","),
    ...rows.map((row) =>
      NAME_CONTACT_COLUMNS.map((column) => csvCell(row[column])).join(","),
    ),
  ].join("\r\n");
}

/** Loads the rows from the local database. Soft-deleted teams are excluded. */
export async function loadTeamExportRows(
  customerIds?: ReadonlySet<string>,
): Promise<TeamExportRow[]> {
  const [customers, teams, players] = await Promise.all([
    db.customers.toArray(),
    db.teams.toArray(),
    db.team_players.toArray(),
  ]);
  return buildTeamExportRows(customers, teams, players, customerIds);
}

export async function exportTeams(
  format: TeamExportFormat,
  scope: TeamExportScope = "all",
  profile: TeamExportProfile = "full",
  selectedCustomerIds?: readonly string[],
): Promise<boolean> {
  const ids =
    scope === "selected" ? new Set(selectedCustomerIds ?? []) : undefined;
  const rows = await loadTeamExportRows(ids);
  if (rows.length === 0) {
    toast.info("No teams to export");
    return false;
  }
  const suffix = scope === "selected" ? "selected" : "all";
  const baseName =
    profile === "name-contact"
      ? `team-name-contact-${suffix}-${dateStamp()}`
      : `teams-${suffix}-${dateStamp()}`;
  const label = "Teams export";
  const save = (bytes: Uint8Array, name: string, mime: string) =>
    saveExportBytes(bytes, name, mime, label, "Teams");
  const subtitleDate = new Date().toLocaleDateString("en-IN");

  if (profile === "name-contact") {
    const contacts = teamNameContactRows(rows);
    if (contacts.length === 0) {
      toast.info("No players to export", {
        description: "These teams have no players yet.",
      });
      return false;
    }
    if (format === "xlsx")
      return exportToExcel(contacts, baseName, "Team Name & Contact");
    if (format === "pdf")
      return downloadReportPdf(
        {
          title: "Team Players — Name & Contact",
          subtitle: `${contacts.length} player${contacts.length === 1 ? "" : "s"} · Exported ${subtitleDate}`,
          fileName: baseName,
          tables: [
            {
              title: "Name & Contact",
              columns: ["Team", "Player", "Contact No"],
              align: ["left", "left", "left"],
              rows: contacts.map((r) => ({
                cells: [r.Team || "—", r.Player || "—", r["Contact No"] || "—"],
              })),
            },
          ],
        },
        undefined,
        "Teams",
      );
    if (format === "json")
      return save(
        new TextEncoder().encode(JSON.stringify(contacts, null, 2)),
        `${baseName}.json`,
        "application/json;charset=utf-8",
      );
    return save(
      new TextEncoder().encode(`\uFEFF${teamNameContactsToCsv(contacts)}`),
      `${baseName}.csv`,
      "text/csv;charset=utf-8",
    );
  }

  if (format === "xlsx") return exportToExcel(rows, baseName, "Teams");
  if (format === "pdf") {
    const teamCount = new Set(rows.map((r) => r["Team ID"])).size;
    return downloadReportPdf(
      {
        title: "Teams & Players",
        subtitle: `${teamCount} team${teamCount === 1 ? "" : "s"} · Exported ${subtitleDate}`,
        fileName: baseName,
        tables: [
          {
            title: "Teams",
            columns: ["Customer", "Team", "Player", "Phone"],
            align: ["left", "left", "left", "left"],
            rows: rows.map((r) => ({
              cells: [
                r.Customer || "—",
                r.Team || "—",
                r.Player || "—",
                r["Player phone"] || "—",
              ],
            })),
          },
        ],
      },
      undefined,
      "Teams",
    );
  }
  if (format === "json")
    return save(
      new TextEncoder().encode(JSON.stringify(rows, null, 2)),
      `${baseName}.json`,
      "application/json;charset=utf-8",
    );
  return save(
    new TextEncoder().encode(`\uFEFF${teamsToCsv(rows)}`),
    `${baseName}.csv`,
    "text/csv;charset=utf-8",
  );
}
