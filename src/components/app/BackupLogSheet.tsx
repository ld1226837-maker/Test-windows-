import { useMemo, useState, useSyncExternalStore } from "react";
import {
  Clipboard,
  Download,
  Trash2,
  History,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  clearLog,
  exportLogText,
  readLog,
  subscribe,
  type BackupLogEntry,
} from "@/lib/backup-log";
import { isAndroid, isDesktop, saveExportFile } from "@/lib/desktop";

const icon = (s: BackupLogEntry["status"]) =>
  s === "success" ? (
    <CheckCircle2 className="h-4 w-4" />
  ) : s === "warning" ? (
    <AlertTriangle className="h-4 w-4" />
  ) : s === "error" ? (
    <XCircle className="h-4 w-4" />
  ) : (
    <Loader2 className="h-4 w-4 animate-spin" />
  );
const kindLabel = (k: string) =>
  ({
    "local-export": "Local export",
    "local-restore": "Local restore",
    "telegram-upload": "Telegram upload",
    "telegram-year-archive": "Telegram year archive",
    "telegram-restore": "Telegram restore",
    "auto-backup": "Automatic backup",
    "telegram-config": "Telegram setup",
    preview: "Restore preview",
  })[k] ?? k;
export function BackupLogSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const entries = useSyncExternalStore(subscribe, readLog, readLog);
  const [filter, setFilter] = useState("all");
  const [kind, setKind] = useState("all");
  const [confirm, setConfirm] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const kinds = useMemo(
    () => Array.from(new Set(entries.map((e) => e.kind))),
    [entries],
  );
  const visible = useMemo(
    () =>
      entries.filter(
        (e) =>
          (filter === "all" ||
            (filter === "warnings"
              ? e.status === "warning"
              : filter === e.status)) &&
          (kind === "all" || e.kind === kind),
      ),
    [entries, filter, kind],
  );
  const shown = visible.slice(0, limit);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportLogText());
      toast.success("Backup log copied");
    } catch {
      toast.error("Couldn't copy the log");
    }
  };
  const exportTxt = async () => {
    try {
      const text = exportLogText();
      const bytes = new TextEncoder().encode(text);
      if (isAndroid()) {
        const result = await saveExportFile(
          bytes,
          "backup-log.txt",
          "text/plain",
        );
        if (!result.saved) throw new Error(result.error ?? "save failed");
        toast.success("Log exported to Downloads");
        return;
      }
      if (isDesktop()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({
          defaultPath: "backup-log.txt",
          filters: [{ name: "Text", extensions: ["txt"] }],
        });
        if (!path) return;
        await writeTextFile(path, text);
        toast.success("Log exported");
        return;
      }
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "backup-log.txt";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Log exported");
    } catch {
      toast.error("Couldn't export the log");
    }
  };
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[85vh] overflow-hidden rounded-t-2xl"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <History className="h-5 w-5" /> Backup activity
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              { id: "all", label: "All" },
              { id: "success", label: "Success" },
              { id: "warnings", label: "Warnings" },
              { id: "error", label: "Errors" },
            ].map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={filter === f.id ? "default" : "outline"}
                aria-pressed={filter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setLimit(100);
                }}
              >
                {f.label}
              </Button>
            ))}
            <select
              aria-label="Filter by backup kind"
              className="h-9 rounded-md border bg-background px-2 text-xs"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setLimit(100);
              }}
            >
              <option value="all">All kinds</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
            <span className="flex-1" />
            <Button size="sm" variant="outline" onClick={copy}>
              <Clipboard className="mr-1 h-3.5 w-3.5" />
              Copy
            </Button>
            <Button size="sm" variant="outline" onClick={exportTxt}>
              <Download className="mr-1 h-3.5 w-3.5" />
              Export .txt
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirm(true)}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
          <div className="mt-3 max-h-[62vh] space-y-2 overflow-y-auto pr-1">
            {shown.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No backup activity yet.
              </p>
            ) : (
              shown.map((e) => (
                <button
                  type="button"
                  key={e.id}
                  aria-expanded={expanded === e.id}
                  className="w-full rounded-xl border p-3 text-left"
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                >
                  <div className="flex items-start gap-2">
                    <span aria-hidden>{icon(e.status)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {e.summary}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {kindLabel(e.kind)} ·{" "}
                        {new Date(e.startedAt).toLocaleString()}{" "}
                        {e.durationMs != null
                          ? `· ${Math.round(e.durationMs / 100) / 10}s`
                          : ""}
                      </span>
                    </span>
                    <Badge variant="outline">{e.status}</Badge>
                  </div>
                  {expanded === e.id && (
                    <div className="mt-2 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                      {e.device && <div>Device: {e.device}</div>}
                      {e.detail?.bytes != null && (
                        <div>Bytes: {e.detail.bytes.toLocaleString()}</div>
                      )}
                      {e.detail?.records != null && (
                        <div>Records: {e.detail.records.toLocaleString()}</div>
                      )}
                      {e.detail?.parts && (
                        <div>
                          Parts: {e.detail.parts.done}/{e.detail.parts.total}
                        </div>
                      )}
                      {e.detail?.photos && (
                        <div>
                          Photos: {e.detail.photos.saved} saved,{" "}
                          {e.detail.photos.missing} missing
                        </div>
                      )}
                      {e.detail?.session && (
                        <div>Session: {e.detail.session}</div>
                      )}
                      {e.detail?.encrypted != null && (
                        <div>
                          Encrypted: {e.detail.encrypted ? "yes" : "no"}
                        </div>
                      )}
                      {e.detail?.retries != null && (
                        <div>
                          Retries: {e.detail.retries}
                          {e.detail.retryAfterMs != null
                            ? ` (Telegram asked to wait ${Math.ceil(e.detail.retryAfterMs / 1000)} s)`
                            : ""}
                        </div>
                      )}
                      {e.detail?.errorCode && (
                        <div>Error: {e.detail.errorCode}</div>
                      )}
                      {e.detail?.errorMessage && (
                        <div>{e.detail.errorMessage}</div>
                      )}
                    </div>
                  )}
                </button>
              ))
            )}
            {visible.length > shown.length && (
              <Button
                className="w-full"
                variant="outline"
                onClick={() => setLimit((v) => v + 100)}
              >
                Load more
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear backup activity?</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                clearLog();
                setConfirm(false);
              }}
            >
              Clear log
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
export function BackupLogButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <History className="mr-1 h-4 w-4" /> Backup activity
      </Button>
      <BackupLogSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
