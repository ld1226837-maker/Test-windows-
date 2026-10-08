import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ClipboardPaste,
  MessageCircle,
  MoreVertical,
  Pencil,
  Phone,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCustomers } from "@/lib/data";
import { db, type TeamPlayerRow, type TeamRow } from "@/lib/localdb";
import {
  useCustomerTeams,
  useDeleteTeam,
  useDeleteTeamPlayer,
  useTeamPlayerCount,
  useTeamPlayers,
  useTeams,
  searchTeams,
} from "@/lib/teams";
import { initialsOf } from "@/lib/team-players";
import { customerCallUrl, customerWhatsappUrl } from "@/lib/customer-actions";
import { callNumber, openWhatsApp } from "@/lib/contact";
import { compareBy, useSortState, type SortOption } from "@/lib/sort";
import { comparePhoneForSort } from "@/lib/phone-sort";
import { PastePlayersDialog, PlayerDialog, TeamDialog } from "./TeamDialogs";
import { SortMenu } from "./SortMenu";
import { errorMessage } from "@/lib/utils";

/** 44 px on touch screens, compact with a mouse. */
const ICONBTN =
  "h-11 w-11 shrink-0 [@media(pointer:fine)]:h-9 [@media(pointer:fine)]:w-9";
const ITEM = "min-h-11 gap-2 text-sm [@media(pointer:fine)]:min-h-9";

type TeamSortField = "name" | "number";

const TEAM_SORT_OPTIONS: SortOption<TeamSortField>[] = [
  { value: "name", label: "Name (A–Z)", defaultDir: "asc" },
  { value: "number", label: "Number (0–9)", defaultDir: "asc" },
];

function Avatar({
  name,
  tone = "player",
}: {
  name: string;
  tone?: "team" | "player";
}) {
  return (
    <span
      aria-hidden
      className={
        "flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold " +
        (tone === "team"
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground")
      }
    >
      {initialsOf(name)}
    </span>
  );
}

function PlayerRow({
  p,
  onEdit,
  onDelete,
}: {
  p: TeamPlayerRow;
  onEdit: (p: TeamPlayerRow) => void;
  onDelete: (p: TeamPlayerRow) => void;
}) {
  const call = customerCallUrl(p.phone);
  const wa = customerWhatsappUrl(p.phone);
  return (
    <li className="flex min-h-14 items-center gap-3 py-1.5">
      <Avatar name={p.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{p.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {p.phone || "No phone"}
        </div>
      </div>
      {call ? (
        <Button
          size="icon"
          variant="ghost"
          className={ICONBTN}
          aria-label={`Call ${p.name}`}
          onClick={() => void callNumber(p.phone)}
        >
          <Phone className="size-4" />
        </Button>
      ) : null}
      {wa ? (
        <Button
          size="icon"
          variant="ghost"
          className={ICONBTN}
          aria-label={`WhatsApp ${p.name}`}
          onClick={() => void openWhatsApp(p.phone)}
        >
          <MessageCircle className="size-4" />
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className={ICONBTN}
            aria-label={`More for ${p.name}`}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className={ITEM} onSelect={() => onEdit(p)}>
            <Pencil className="size-4" />
            Edit player
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={`${ITEM} text-destructive focus:text-destructive`}
            onSelect={() => onDelete(p)}
          >
            <Trash2 className="size-4" />
            Remove from team
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function TeamBlock({
  team,
  siblings,
  customerId,
  defaultOpen = false,
}: {
  team: TeamRow;
  siblings: TeamRow[];
  customerId: string;
  defaultOpen?: boolean;
}) {
  const [limit, setLimit] = useState(50);
  const { data: rawPlayers = [] } = useTeamPlayers(team.id, limit, 0);
  const { data: count = 0 } = useTeamPlayerCount(team.id);
  const delPlayer = useDeleteTeamPlayer();
  const delTeam = useDeleteTeam();
  const [open, setOpen] = useState(defaultOpen);
  const [playerDialog, setPlayerDialog] = useState<{
    player: TeamPlayerRow | null;
  } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmTeam, setConfirmTeam] = useState(false);
  const [confirmPlayer, setConfirmPlayer] = useState<TeamPlayerRow | null>(
    null,
  );

  const players = useMemo(
    () => [...rawPlayers].sort((a, b) => a.name.localeCompare(b.name)),
    [rawPlayers],
  );

  return (
    <div className="rounded-xl border">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Avatar name={team.name} tone="team" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{team.name}</span>
            <span className="block text-xs text-muted-foreground">
              {count} player{count === 1 ? "" : "s"}
            </span>
          </span>
          <ChevronDown
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className={ICONBTN}
              aria-label={`More for team ${team.name}`}
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className={ITEM}
              onSelect={() => setRenameOpen(true)}
            >
              <Pencil className="size-4" />
              Rename team
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={`${ITEM} text-destructive focus:text-destructive`}
              onSelect={() => setConfirmTeam(true)}
            >
              <Trash2 className="size-4" />
              Delete team
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {open ? (
        <div className="border-t px-3 pb-3 pt-2">
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button
              className="h-11 gap-1.5 [@media(pointer:fine)]:h-9"
              onClick={() => setPlayerDialog({ player: null })}
            >
              <UserPlus className="size-4" />
              Add player
            </Button>
            <Button
              variant="outline"
              className="h-11 gap-1.5 [@media(pointer:fine)]:h-9"
              onClick={() => setPasteOpen(true)}
            >
              <ClipboardPaste className="size-4" />
              Paste list
            </Button>
          </div>
          {players.length ? (
            <ul className="mt-2 divide-y">
              {players.map((p) => (
                <PlayerRow
                  key={p.id}
                  p={p}
                  onEdit={(pl) => setPlayerDialog({ player: pl })}
                  onDelete={setConfirmPlayer}
                />
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No players yet. Add one, or paste a list.
            </p>
          )}
          {count > limit ? (
            <Button
              variant="outline"
              className="mt-2 h-11 w-full [@media(pointer:fine)]:h-9"
              onClick={() => setLimit((n) => n + 50)}
            >
              Show 50 more ({count - limit} left)
            </Button>
          ) : null}
        </div>
      ) : null}

      <PlayerDialog
        open={playerDialog !== null}
        onOpenChange={(o) => !o && setPlayerDialog(null)}
        team={team}
        player={playerDialog?.player ?? null}
      />
      <PastePlayersDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        team={team}
      />
      <TeamDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        customerId={customerId}
        siblings={siblings}
        team={team}
      />

      <AlertDialog open={confirmTeam} onOpenChange={setConfirmTeam}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{team.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The team and its {count} player{count === 1 ? "" : "s"} will be
              removed. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() =>
                delTeam.mutate(team.id, {
                  onSuccess: () => toast.success(`Team “${team.name}” deleted`),
                  onError: (e) =>
                    toast.error(errorMessage(e, "Could not delete the team")),
                })
              }
            >
              Delete team
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmPlayer !== null}
        onOpenChange={(o) => !o && setConfirmPlayer(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmPlayer?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They will be removed from {team.name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmPlayer && delPlayer.mutate(confirmPlayer)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function CustomerTeams({
  name,
  phone,
  customerId,
}: {
  name: string;
  phone: string | null;
  customerId?: string;
}) {
  const { data: customers = [] } = useCustomers();
  const customer = customerId
    ? customers.find((c) => c.id === customerId)
    : customers.find(
        (c) => c.name === name && (phone ? c.phone === phone : !c.phone),
      );
  const { data: teams = [] } = useCustomerTeams(customer?.id);
  const [adding, setAdding] = useState(false);
  if (!customer) return null;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          Teams
          {teams.length ? (
            <Badge variant="secondary">{teams.length}</Badge>
          ) : null}
        </CardTitle>
        <Button
          className="h-11 gap-1.5 [@media(pointer:fine)]:h-9"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4" />
          Add team
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {teams.map((t) => (
          <TeamBlock
            key={t.id}
            team={t}
            siblings={teams}
            customerId={customer.id}
            defaultOpen={teams.length === 1}
          />
        ))}
        {teams.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-8 text-center">
            <Users className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No teams for {customer.name} yet.
            </p>
            <Button
              variant="outline"
              className="h-11 [@media(pointer:fine)]:h-9"
              onClick={() => setAdding(true)}
            >
              Add the first team
            </Button>
          </div>
        ) : null}
      </CardContent>
      <TeamDialog
        open={adding}
        onOpenChange={setAdding}
        customerId={customer.id}
        customerName={customer.name}
        siblings={teams}
      />
    </Card>
  );
}

export function CustomerTeamsDirectory() {
  const { data: teams = [] } = useTeams();
  const { data: customers = [] } = useCustomers();
  const [q, setQ] = useState("");
  const { data: searched } = useQuery({
    queryKey: ["teams-search", q],
    initialData: [],
    queryFn: () => searchTeams(q),
    enabled: q.trim().length > 0,
  });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const sort = useSortState<TeamSortField>(
    "customers.teams",
    TEAM_SORT_OPTIONS,
    { field: "name", dir: "asc" },
  );
  const rows = useMemo(() => {
    const source = q.trim() ? searched : teams;
    const active = source.filter((t) => !t.deleted_at);
    return [...active].sort((a, b) => {
      if (sort.field === "number") {
        const customerA = customers.find((c) => c.id === a.customer_id);
        const customerB = customers.find((c) => c.id === b.customer_id);
        const numberCmp = comparePhoneForSort(
          customerA?.phone,
          customerB?.phone,
          sort.dir,
        );
        // Missing numbers stay at the bottom in both directions. Equal numbers
        // are deterministic by team name.
        return (
          numberCmp ||
          compareBy(a.name.toLowerCase(), b.name.toLowerCase(), "asc")
        );
      }
      return compareBy(a.name.toLowerCase(), b.name.toLowerCase(), sort.dir);
    });
  }, [searched, teams, q, customers, sort.field, sort.dir]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        rows.map(
          async (t) =>
            [
              t.id,
              await db.team_players.where("team_id").equals(t.id).count(),
            ] as const,
        ),
      );
      if (!cancelled) setCounts(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          Teams &amp; Players
          {teams.length ? (
            <Badge variant="secondary">{teams.length}</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search teams and players"
            className="h-11 pl-9 pr-11 text-base [@media(pointer:fine)]:h-10 [@media(pointer:fine)]:text-sm"
            placeholder="Search team, customer, player or phone"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q ? (
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-0 top-0 h-11 w-11 [@media(pointer:fine)]:h-10 [@media(pointer:fine)]:w-10"
              aria-label="Clear search"
              onClick={() => setQ("")}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
        <div className="mb-3 flex items-center justify-end">
          <SortMenu
            options={TEAM_SORT_OPTIONS}
            field={sort.field}
            dir={sort.dir}
            onFieldChange={sort.setField}
            onToggleDir={sort.toggleDir}
          />
        </div>
        <ul className="divide-y">
          {rows.map((t) => {
            const customer = customers.find((c) => c.id === t.customer_id);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center gap-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    customer &&
                    window.dispatchEvent(
                      new CustomEvent("customer:open", {
                        detail: {
                          name: customer.name,
                          phone: customer.phone ?? null,
                          teamId: t.id,
                        },
                      }),
                    )
                  }
                >
                  <Avatar name={t.name} tone="team" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{t.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {customer?.name || "Unknown customer"}
                    </span>
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {counts[t.id] ?? 0} player
                    {(counts[t.id] ?? 0) === 1 ? "" : "s"}
                  </Badge>
                </button>
              </li>
            );
          })}
        </ul>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {q.trim()
              ? "No matching teams or players."
              : "No teams yet. Open a customer and tap Add team."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
