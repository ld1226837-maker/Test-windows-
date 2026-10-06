import { toast } from "sonner";
import {
  describeSaveError,
  isAndroid,
  isDesktop,
  revealInFolder,
  saveExportFile,
  saveToInvoicesFolder,
} from "./desktop";
import { exportToExcel, exportWorkbook } from "./xlsx";
import { db } from "./localdb";
import { downloadReportPdf } from "./report-pdf";

export type CustomerExportRow = {
  ID: string;
  Name: string;
  Phone: string;
  Visits: number;
  Due: number;
  "On tab": number;
};

export type CustomerTeamExportRow = {
  ID: string;
  "Customer ID": string;
  Name: string;
  Notes: string;
};
export type CustomerPlayerExportRow = {
  ID: string;
  "Team ID": string;
  Name: string;
  Phone: string;
  Notes: string;
};
export function customerTeamsToExportRows(
  teams: {
    id: string;
    customer_id: string;
    name: string;
    notes?: string | null;
  }[],
): CustomerTeamExportRow[] {
  return teams.map((t) => ({
    ID: t.id,
    "Customer ID": t.customer_id,
    Name: t.name,
    Notes: t.notes ?? "",
  }));
}
export function customerPlayersToExportRows(
  players: {
    id: string;
    team_id: string;
    name: string;
    phone?: string | null;
    notes?: string | null;
  }[],
): CustomerPlayerExportRow[] {
  return players.map((p) => ({
    ID: p.id,
    "Team ID": p.team_id,
    Name: p.name,
    Phone: p.phone ?? "",
    Notes: p.notes ?? "",
  }));
}

export type CustomerExportFormat = "csv" | "xlsx" | "json" | "pdf";
export type CustomerExportProfile = "full" | "name-contact";

const dateStamp = () => new Date().toISOString().slice(0, 10);

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // Prevent spreadsheet formula injection while preserving phone numbers as text.
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function customersToCsv(rows: CustomerExportRow[]): string {
  const columns: (keyof CustomerExportRow)[] = [
    "ID",
    "Name",
    "Phone",
    "Visits",
    "Due",
    "On tab",
  ];
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) =>
      columns.map((column) => csvCell(row[column])).join(","),
    ),
  ].join("\r\n");
}

/** A full customer CSV is a portable multi-section export: the customer rows
 * are followed by explicit Teams and Players sections. CSV has no worksheets,
 * so blank lines + section headers preserve the same information that the XLSX
 * export stores on separate sheets. */
export function customersWithTeamsToCsv(
  customers: CustomerExportRow[],
  teams: CustomerTeamExportRow[],
  players: CustomerPlayerExportRow[],
): string {
  const teamColumns: (keyof CustomerTeamExportRow)[] = [
    "ID",
    "Customer ID",
    "Name",
    "Notes",
  ];
  const playerColumns: (keyof CustomerPlayerExportRow)[] = [
    "ID",
    "Team ID",
    "Name",
    "Phone",
    "Notes",
  ];
  return [
    customersToCsv(customers),
    "",
    "Teams",
    teamColumns.map(csvCell).join(","),
    ...teams.map((row) =>
      teamColumns.map((column) => csvCell(row[column])).join(","),
    ),
    "",
    "Players",
    playerColumns.map(csvCell).join(","),
    ...players.map((row) =>
      playerColumns.map((column) => csvCell(row[column])).join(","),
    ),
  ].join("\r\n");
}

export type CustomerNameContactRow = {
  Name: string;
  "Contact No": string;
};

export function customerNameContactsToCsv(
  rows: CustomerNameContactRow[],
): string {
  const columns: (keyof CustomerNameContactRow)[] = ["Name", "Contact No"];
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) =>
      columns.map((column) => csvCell(row[column])).join(","),
    ),
  ].join("\r\n");
}

async function saveBytes(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<boolean> {
  return saveExportBytes(bytes, filename, mimeType);
}

/** Shared save helper (desktop folder / Android Downloads / browser download).
 * `label` and `section` default to the customer export wording so existing
 * callers are unchanged; the Teams export reuses it with its own label. */
export async function saveExportBytes(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  label = "Customer export",
  section = "Customers",
): Promise<boolean> {
  if (isAndroid()) {
    const result = await saveExportFile(bytes, filename, mimeType);
    if (!result.saved) {
      toast.error(`Couldn't save ${label.toLowerCase()}`, {
        description: result.error ?? filename,
      });
      return false;
    }
    toast.success(`${label} saved to Downloads`, {
      description: filename,
    });
    return true;
  }

  if (isDesktop()) {
    try {
      const path = await saveToInvoicesFolder(bytes, filename, section);
      await revealInFolder(path);
      toast.success(`${label} saved`, { description: filename });
      return true;
    } catch (error) {
      toast.error(`Couldn't save ${label.toLowerCase()}`, {
        description: describeSaveError(error),
      });
      return false;
    }
  }

  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  toast.success(`${label} downloaded`, { description: filename });
  return true;
}

export async function exportCustomers(
  rows: CustomerExportRow[],
  format: CustomerExportFormat,
  scope: "all" | "selected" = "all",
  profile: CustomerExportProfile = "full",
): Promise<boolean> {
  if (rows.length === 0) {
    toast.info("No customers to export");
    return false;
  }

  const suffix = scope === "selected" ? "selected" : "all";
  const baseName =
    profile === "name-contact"
      ? `customer-name-contact-${suffix}-${dateStamp()}`
      : `customers-${suffix}-${dateStamp()}`;

  if (profile === "name-contact") {
    const contactRows: CustomerNameContactRow[] = rows.map((row) => ({
      Name: row.Name,
      "Contact No": row.Phone,
    }));

    if (format === "xlsx") {
      return exportToExcel(contactRows, baseName, "Name & Contact");
    }

    if (format === "pdf") {
      return downloadReportPdf({
        title: "Customer Name & Contact List",
        subtitle: `${contactRows.length} contact${contactRows.length === 1 ? "" : "s"} · Exported ${new Date().toLocaleDateString("en-IN")}`,
        fileName: baseName,
        tables: [
          {
            title: "Name & Contact",
            columns: ["Name", "Contact No"],
            align: ["left", "left"],
            rows: contactRows.map((row) => ({
              cells: [row.Name || "—", row["Contact No"] || "—"],
            })),
          },
        ],
      });
    }

    if (format === "json") {
      return saveBytes(
        new TextEncoder().encode(JSON.stringify(contactRows, null, 2)),
        `${baseName}.json`,
        "application/json;charset=utf-8",
      );
    }

    const csv = `\uFEFF${customerNameContactsToCsv(contactRows)}`;
    return saveBytes(
      new TextEncoder().encode(csv),
      `${baseName}.csv`,
      "text/csv;charset=utf-8",
    );
  }

  if (format === "xlsx") {
    // Keep XLSX scope consistent with CSV: filtered/customer-scoped exports
    // must not leak teams or players belonging to customers outside `rows`.
    const scopedCustomerIds = new Set(rows.map((customer) => customer.ID));
    const teams = (await db.teams.toArray()).filter(
      (team) =>
        !team.deleted_at &&
        (scope === "all" || scopedCustomerIds.has(team.customer_id)),
    );
    const teamIds = new Set(teams.map((team) => team.id));
    const players = (await db.team_players.toArray()).filter((player) =>
      teamIds.has(player.team_id),
    );
    return exportWorkbook(
      [
        { name: "Customers", rows },
        { name: "Teams", rows: customerTeamsToExportRows(teams) },
        { name: "Players", rows: customerPlayersToExportRows(players) },
      ],
      baseName,
    );
  }

  if (format === "pdf") {
    return downloadReportPdf({
      title: "Customer Directory",
      subtitle: `${rows.length} customer${rows.length === 1 ? "" : "s"} · Exported ${new Date().toLocaleDateString("en-IN")}`,
      fileName: baseName,
      tables: [
        {
          title: "Customers",
          columns: ["Name", "Phone", "Visits", "Due", "On tab"],
          align: ["left", "left", "right", "right", "right"],
          rows: rows.map((row) => ({
            cells: [
              row.Name || "—",
              row.Phone || "—",
              String(row.Visits),
              `Rs ${row.Due.toLocaleString("en-IN")}`,
              `Rs ${row["On tab"].toLocaleString("en-IN")}`,
            ],
          })),
        },
      ],
    });
  }

  if (format === "json") {
    const json = JSON.stringify(rows, null, 2);
    return saveBytes(
      new TextEncoder().encode(json),
      `${baseName}.json`,
      "application/json;charset=utf-8",
    );
  }

  const teams = (await db.teams.toArray()).filter(
    (team) =>
      !team.deleted_at &&
      (scope === "all" ||
        rows.some((customer) => customer.ID === team.customer_id)),
  );
  const teamIds = new Set(teams.map((team) => team.id));
  const players = (await db.team_players.toArray()).filter((player) =>
    teamIds.has(player.team_id),
  );
  // The name-contact profile returned above, so this is always the full export.
  const csv = `\uFEFF${customersWithTeamsToCsv(rows, customerTeamsToExportRows(teams), customerPlayersToExportRows(players))}`;
  return saveBytes(
    new TextEncoder().encode(csv),
    `${baseName}.csv`,
    "text/csv;charset=utf-8",
  );
}
