import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TeamPlayerRow, TeamRow } from "@/lib/localdb";
import {
  hasDuplicateTeamPhone,
  normalizePlayerPhone,
  useSaveTeam,
  useSaveTeamPlayer,
} from "@/lib/teams";
import {
  parsePlayerLines,
  teamNameExists,
  useAddTeamPlayers,
} from "@/lib/team-players";
import { errorMessage } from "@/lib/utils";

/** 44 px fields/buttons on a phone, regular size with a mouse. */
const FIELD =
  "h-11 text-base [@media(pointer:fine)]:h-10 [@media(pointer:fine)]:text-sm";
const ACTION = "h-11 [@media(pointer:fine)]:h-10";

/** Pasted "Name, phone" lines with a live count so mistakes show before saving. */
export function PlayerPasteField({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
}) {
  const parsed = useMemo(() => parsePlayerLines(value), [value]);
  return (
    <div className="space-y-2">
      <Textarea
        id={id}
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"Ravi, 9876543210\nSuresh, 9123456780\nKumar"}
        className="min-h-28 text-base [@media(pointer:fine)]:text-sm"
      />
      {value.trim() ? (
        <div className="space-y-1 text-xs" aria-live="polite">
          <p
            className={
              parsed.players.length
                ? "text-foreground"
                : "text-muted-foreground"
            }
          >
            {parsed.players.length} player
            {parsed.players.length === 1 ? "" : "s"} ready
            {parsed.errors.length
              ? ` · ${parsed.errors.length} line${parsed.errors.length === 1 ? "" : "s"} need fixing`
              : ""}
          </p>
          {parsed.errors.slice(0, 4).map((e) => (
            <p key={e.line} className="text-destructive">
              Line {e.line}: {e.message}
            </p>
          ))}
          {parsed.errors.length > 4 ? (
            <p className="text-muted-foreground">
              +{parsed.errors.length - 4} more
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          One player per line: name, then phone (phone is optional).
        </p>
      )}
    </div>
  );
}

/** Create a team (optionally with its first players) or rename one. */
export function TeamDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  siblings,
  team,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName?: string;
  /** The customer's other teams — for the duplicate-name check. */
  siblings: TeamRow[];
  /** Present = rename mode. */
  team?: TeamRow;
}) {
  const saveTeam = useSaveTeam();
  const addPlayers = useAddTeamPlayers();
  const [name, setName] = useState("");
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? "");
    setPaste("");
    setShowPaste(false);
    setError(null);
    setBusy(false);
  }, [open, team]);

  const submit = async () => {
    if (busy) return;
    const clean = name.trim();
    if (!clean) {
      setError("Enter a team name");
      nameRef.current?.focus();
      return;
    }
    if (teamNameExists(siblings, clean, team?.id)) {
      setError("This customer already has a team with that name");
      nameRef.current?.focus();
      return;
    }
    const parsed = showPaste ? parsePlayerLines(paste) : null;
    if (parsed && parsed.errors.length) {
      toast.error("Fix the player lines first", {
        description: `Line ${parsed.errors[0]!.line}: ${parsed.errors[0]!.message}`,
      });
      return;
    }
    setBusy(true);
    try {
      const row = await saveTeam.mutateAsync({
        ...(team ? { id: team.id, notes: team.notes } : {}),
        customer_id: customerId,
        name: clean,
      });
      let extra = "";
      if (parsed?.players.length) {
        const r = await addPlayers.mutateAsync({
          team_id: row.id,
          players: parsed.players,
        });
        extra = ` with ${r.added} player${r.added === 1 ? "" : "s"}`;
      }
      toast.success(team ? "Team renamed" : `Team “${row.name}” added${extra}`);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the team");
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{team ? "Rename team" : "Add team"}</DialogTitle>
          <DialogDescription>
            {team
              ? "The players stay in the team."
              : customerName
                ? `A team under ${customerName}.`
                : "Create a team and, if you like, paste its players."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="team-name">Team name</Label>
            <Input
              id="team-name"
              ref={nameRef}
              className={FIELD}
              value={name}
              maxLength={60}
              autoComplete="off"
              enterKeyHint={team || !showPaste ? "done" : "next"}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "team-name-error" : undefined}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
            />
            {error ? (
              <p
                id="team-name-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>
          {!team ? (
            showPaste ? (
              <div className="space-y-1.5">
                <Label htmlFor="team-paste">Players (optional)</Label>
                <PlayerPasteField
                  id="team-paste"
                  value={paste}
                  onChange={setPaste}
                />
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className={`${ACTION} -ml-3 text-primary`}
                onClick={() => setShowPaste(true)}
              >
                + Add players now
              </Button>
            )
          ) : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              className={ACTION}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className={ACTION} disabled={busy}>
              {busy ? "Saving…" : team ? "Save name" : "Add team"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Add or edit one player — replaces the cramped three-field inline row. */
export function PlayerDialog({
  open,
  onOpenChange,
  team,
  player,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: TeamRow;
  /** Present = edit mode. */
  player?: TeamPlayerRow | null;
}) {
  const save = useSaveTeamPlayer();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [dupAsk, setDupAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setName("");
    setPhone("");
    setNameErr(null);
    setPhoneErr(null);
    setDupAsk(false);
    setBusy(false);
  };
  useEffect(() => {
    if (!open) return;
    reset();
    if (player) {
      setName(player.name);
      setPhone(player.phone ?? "");
    }
  }, [open, player]);

  const submit = async (another: boolean) => {
    if (busy) return;
    if (!name.trim()) {
      setNameErr("Enter the player's name");
      nameRef.current?.focus();
      return;
    }
    let normalized: string | null = null;
    try {
      normalized = normalizePlayerPhone(phone);
    } catch (e) {
      setPhoneErr(e instanceof Error ? e.message : "Invalid phone");
      phoneRef.current?.focus();
      return;
    }
    if (
      normalized &&
      !dupAsk &&
      (await hasDuplicateTeamPhone(team.id, normalized, player?.id))
    ) {
      setDupAsk(true);
      return;
    }
    setBusy(true);
    try {
      await save.mutateAsync({
        ...(player ? { id: player.id } : {}),
        team_id: team.id,
        name,
        phone: normalized,
      });
      toast.success(player ? "Player updated" : `${name.trim()} added`);
      if (another && !player) {
        reset();
        nameRef.current?.focus();
      } else onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e, "Could not save the player"));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{player ? "Edit player" : "Add player"}</DialogTitle>
          <DialogDescription>{team.name}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="player-name">Name</Label>
            <Input
              id="player-name"
              ref={nameRef}
              className={FIELD}
              value={name}
              maxLength={60}
              autoComplete="off"
              enterKeyHint="next"
              aria-invalid={nameErr ? true : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setNameErr(null);
              }}
            />
            {nameErr ? (
              <p className="text-xs text-destructive" role="alert">
                {nameErr}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="player-phone">Phone (optional)</Label>
            <Input
              id="player-phone"
              ref={phoneRef}
              className={FIELD}
              value={phone}
              inputMode="tel"
              autoComplete="off"
              placeholder="10-digit mobile number"
              enterKeyHint="done"
              aria-invalid={phoneErr ? true : undefined}
              onChange={(e) => {
                setPhone(e.target.value);
                setPhoneErr(null);
                setDupAsk(false);
              }}
            />
            {phoneErr ? (
              <p className="text-xs text-destructive" role="alert">
                {phoneErr}
              </p>
            ) : null}
            {dupAsk ? (
              <p
                className="text-xs text-amber-600 dark:text-amber-400"
                role="alert"
              >
                This number is already in {team.name}. Save again to keep both.
              </p>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            {!player ? (
              <Button
                type="button"
                variant="outline"
                className={ACTION}
                disabled={busy}
                onClick={() => void submit(true)}
              >
                Save &amp; add another
              </Button>
            ) : null}
            <Button type="submit" className={ACTION} disabled={busy}>
              {busy ? "Saving…" : dupAsk ? "Save anyway" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Paste many players into an existing team. */
export function PastePlayersDialog({
  open,
  onOpenChange,
  team,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: TeamRow;
}) {
  const add = useAddTeamPlayers();
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const parsed = useMemo(() => parsePlayerLines(text), [text]);
  const submit = async () => {
    if (!parsed.players.length) {
      toast.error("Nothing to add yet");
      return;
    }
    try {
      const r = await add.mutateAsync({
        team_id: team.id,
        players: parsed.players,
      });
      toast.success(
        `${r.added} player${r.added === 1 ? "" : "s"} added`,
        r.duplicates
          ? {
              description: `${r.duplicates} used a phone already in this team.`,
            }
          : {},
      );
      if (parsed.errors.length) {
        // Keep only the lines that failed so nothing is lost or re-added.
        setText(
          text
            .split(/\r?\n/)
            .filter((_, i) => parsed.errors.some((e) => e.line === i + 1))
            .join("\n"),
        );
      } else onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e, "Could not add the players"));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Paste players</DialogTitle>
          <DialogDescription>{team.name}</DialogDescription>
        </DialogHeader>
        <PlayerPasteField id="paste-players" value={text} onChange={setText} />
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            className={ACTION}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            className={ACTION}
            disabled={!parsed.players.length || add.isPending}
            onClick={() => void submit()}
          >
            Add {parsed.players.length || ""} player
            {parsed.players.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
