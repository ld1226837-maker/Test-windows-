import { useMutation, useQueryClient } from "@tanstack/react-query";
import { db, newId, nowIso, type TeamPlayerRow } from "./localdb";
import { normalizePlayerPhone } from "./teams";

export type ParsedPlayer = { name: string; phone: string | null };
export type PlayerLineError = { line: number; text: string; message: string };

/**
 * Parses pasted player lines — "Name, phone" (phone optional, same as the
 * single-player form) — into valid players plus per-line errors, without
 * touching the database. Blank lines are skipped, duplicate phones inside the
 * paste are reported once (the first occurrence wins), and the phone is
 * normalised exactly like a single add (10-digit Indian mobile).
 */
export function parsePlayerLines(text: string): {
  players: ParsedPlayer[];
  errors: PlayerLineError[];
} {
  const players: ParsedPlayer[] = [];
  const errors: PlayerLineError[] = [];
  const seenPhones = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const comma = line.search(/[,\t;]/);
    const name = (comma === -1 ? line : line.slice(0, comma)).trim();
    const phoneText = comma === -1 ? "" : line.slice(comma + 1).trim();
    if (!name) {
      errors.push({ line: index + 1, text: line, message: "Name is missing" });
      continue;
    }
    let phone: string | null = null;
    try {
      phone = normalizePlayerPhone(phoneText);
    } catch (e) {
      errors.push({
        line: index + 1,
        text: line,
        message: e instanceof Error ? e.message : "Invalid phone",
      });
      continue;
    }
    if (phone) {
      if (seenPhones.has(phone)) {
        errors.push({
          line: index + 1,
          text: line,
          message: "Same phone appears twice in this list",
        });
        continue;
      }
      seenPhones.add(phone);
    }
    players.push({ name, phone });
  }
  return { players, errors };
}

/** Case-insensitive team-name clash within one customer's teams. */
export function teamNameExists(
  teams: { id: string; name: string }[],
  name: string,
  exceptId?: string,
): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  return teams.some(
    (t) => t.id !== exceptId && t.name.trim().toLowerCase() === key,
  );
}

/** Two-letter avatar initials for a player or team name. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Adds many players to one team in a single transaction and a single cache
 * refresh (the old paste box saved and refreshed once per line). Returns how
 * many reused a phone already present in the team so the UI can mention it. */
export function useAddTeamPlayers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { team_id: string; players: ParsedPlayer[] }) => {
      const now = nowIso();
      const existing = await db.team_players
        .where("team_id")
        .equals(p.team_id)
        .toArray();
      const have = new Set(existing.map((x) => x.phone).filter(Boolean));
      let duplicates = 0;
      const rows: TeamPlayerRow[] = p.players.map((pl) => {
        if (pl.phone && have.has(pl.phone)) duplicates++;
        return {
          id: newId(),
          team_id: p.team_id,
          name: pl.name.trim(),
          phone: pl.phone,
          notes: null,
          created_at: now,
          updated_at: now,
        };
      });
      if (rows.length) await db.team_players.bulkPut(rows);
      return { added: rows.length, duplicates };
    },
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["team_players", p.team_id] });
      qc.invalidateQueries({ queryKey: ["team_players_count", p.team_id] });
      qc.invalidateQueries({ queryKey: ["teams"] });
    },
  });
}
