import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { db, newId, nowIso, type TeamPlayerRow, type TeamRow } from "./localdb";
import { digits } from "./autofill";

function normalizePhoneDigits(value: string) {
  // Accept common Indian-language decimal digits while keeping the stored
  // canonical representation ASCII-only.
  const zeroBases = [
    0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xbe6, 0xc66, 0xce6, 0xd66,
  ];
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    const base = zeroBases.find((b) => cp >= b && cp <= b + 9);
    if (base != null) out += String(cp - base);
  }
  return out;
}

export function normalizePlayerPhone(phone: string | null | undefined) {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  const d = normalizePhoneDigits(raw);
  const canonical =
    d.length === 11 && d.startsWith("0")
      ? d.slice(1)
      : d.length === 12 && d.startsWith("91")
        ? d.slice(2)
        : d;
  if (canonical.length === 10 && /^[6-9]\d{9}$/.test(canonical))
    return canonical;
  throw new Error("Phone must contain a valid 10-digit Indian mobile number");
}
export function useCustomerTeams(customerId?: string) {
  return useQuery({
    queryKey: ["teams", customerId],
    enabled: !!customerId,
    initialData: [],
    queryFn: async () => {
      const teams = await db.teams
        .where("customer_id")
        .equals(customerId!)
        .toArray();
      return teams
        .filter((t) => !t.deleted_at)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}
export function useTeams() {
  return useQuery({
    queryKey: ["teams", "all"],
    initialData: [],
    queryFn: async () =>
      (await db.teams.toArray()).filter((t) => !t.deleted_at),
  });
}
export function useTeamPlayers(teamId?: string, limit = 50, offset = 0) {
  return useQuery({
    queryKey: ["team_players", teamId, limit, offset],
    enabled: !!teamId,
    initialData: [],
    queryFn: async () =>
      db.team_players
        .where("team_id")
        .equals(teamId!)
        .offset(offset)
        .limit(limit)
        .toArray(),
  });
}
export function useTeamPlayerCount(teamId?: string) {
  return useQuery({
    queryKey: ["team_players_count", teamId],
    enabled: !!teamId,
    initialData: 0,
    queryFn: async () =>
      db.team_players.where("team_id").equals(teamId!).count(),
  });
}
export async function hasDuplicateTeamPhone(
  teamId: string,
  phone: string,
  exceptId?: string,
) {
  const rows = await db.team_players.where("team_id").equals(teamId).toArray();
  return rows.some((p) => p.id !== exceptId && p.phone === phone);
}
export function useSaveTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: {
      id?: string;
      customer_id: string;
      name: string;
      notes?: string | null;
    }) => {
      const now = nowIso();
      const existing = p.id ? await db.teams.get(p.id) : undefined;
      const row: TeamRow = {
        id: p.id ?? newId(),
        customer_id: p.customer_id,
        name: p.name.trim(),
        notes: p.notes ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        deleted_at: existing?.deleted_at ?? null,
      };
      if (!row.name) throw new Error("Team name is required");
      await db.teams.put(row);
      return row;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
}
export function useSaveTeamPlayer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: {
      id?: string;
      team_id: string;
      name: string;
      phone?: string | null;
      notes?: string | null;
    }) => {
      const now = nowIso();
      const existing = p.id ? await db.team_players.get(p.id) : undefined;
      const row: TeamPlayerRow = {
        id: p.id ?? newId(),
        team_id: p.team_id,
        name: p.name.trim(),
        phone: normalizePlayerPhone(p.phone),
        notes: p.notes ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      if (!row.name) throw new Error("Player name is required");
      await db.team_players.put(row);
      return row;
    },
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["team_players", p.team_id] });
      qc.invalidateQueries({ queryKey: ["team_players_count", p.team_id] });
      qc.invalidateQueries({ queryKey: ["teams"] });
    },
  });
}
export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const now = nowIso();
      await db.transaction("rw", [db.teams, db.team_players], async () => {
        await db.teams.update(id, { deleted_at: now, updated_at: now });
        const ps = await db.team_players.where("team_id").equals(id).toArray();
        await db.team_players.bulkDelete(ps.map((p) => p.id));
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
}
export function useDeleteTeamPlayer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: TeamPlayerRow) => db.team_players.delete(p.id),
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["team_players", p.team_id] });
      qc.invalidateQueries({ queryKey: ["team_players_count", p.team_id] });
      qc.invalidateQueries({ queryKey: ["teams"] });
    },
  });
}
export async function searchTeams(term: string) {
  const q = term.trim().toLowerCase();
  const teams = (await db.teams.toArray()).filter((t) => !t.deleted_at);
  if (!q) return teams;
  const direct = teams.filter((t) => t.name.toLowerCase().includes(q));
  const phoneQ = q.replace(/\D/g, "");
  const customerRows = await db.customers.toArray();
  const customerIds = new Set(
    customerRows
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (phoneQ && (c.phone ?? "").includes(phoneQ)),
      )
      .map((c) => c.id),
  );
  const matchedIds = new Set([
    ...direct.map((t) => t.id),
    ...teams.filter((t) => customerIds.has(t.customer_id)).map((t) => t.id),
  ]);
  const players = await db.team_players
    .toCollection()
    .filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (!!phoneQ && (p.phone ?? "").includes(phoneQ)),
    )
    .toArray();
  for (const p of players) matchedIds.add(p.team_id);
  return teams.filter((t) => matchedIds.has(t.id));
}
