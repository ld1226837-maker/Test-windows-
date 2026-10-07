import { useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  History,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { backupReminderDue, useAppSettings } from "@/lib/settings";
import { readLog, subscribe, type BackupLogEntry } from "@/lib/backup-log";
import { BackupLogSheet } from "./BackupLogSheet";

const relativeTime = (iso: string) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown time";
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
};
const successful = (e: BackupLogEntry | undefined) =>
  Boolean(e && e.status === "success");

export function BackupStatusCard() {
  const { settings } = useAppSettings();
  const logs = useSyncExternalStore(subscribe, readLog, readLog);
  const [open, setOpen] = useState(false);
  const latestSuccess = (kind: "local" | "telegram") =>
    logs.find(
      (e) =>
        (kind === "local"
          ? e.kind === "local-export"
          : e.kind === "telegram-upload" || e.kind === "auto-backup") &&
        successful(e),
    );
  const local = latestSuccess("local");
  const tg = latestSuccess("telegram");
  const due = backupReminderDue(settings);
  const attempts = logs.filter(
    (e) =>
      e.kind === "local-export" ||
      e.kind === "telegram-upload" ||
      e.kind === "auto-backup",
  );
  const latestAttempt = attempts[0];
  const failed = latestAttempt?.status === "error";
  const warning = latestAttempt?.status === "warning";
  const healthy = latestAttempt?.status === "success";
  const noBackup = !latestAttempt;
  const retryKind =
    latestAttempt?.kind === "telegram-upload" ||
    latestAttempt?.kind === "auto-backup"
      ? "telegram"
      : latestAttempt?.kind === "local-export"
        ? "local"
        : null;
  const reminderMs =
    settings.backupReminder === "daily"
      ? 86400000
      : settings.backupReminder === "weekly"
        ? 7 * 86400000
        : null;
  const nextDue =
    settings.automaticBackup && settings.lastBackupAt && reminderMs
      ? new Date(Date.parse(settings.lastBackupAt) + reminderMs)
      : null;
  const detailLabel = (e: BackupLogEntry | undefined) =>
    e ? (
      <>
        <span>{relativeTime(e.finishedAt ?? e.startedAt)}</span>
        <span className="sr-only">
          {" "}
          {new Date(e.finishedAt ?? e.startedAt).toLocaleString()}
        </span>
        <span> · {new Date(e.finishedAt ?? e.startedAt).toLocaleString()}</span>
        {e.device ? <span> · {e.device}</span> : null}
        {e.detail?.bytes != null ? (
          <span> · {(e.detail.bytes / 1048576).toFixed(1)} MB</span>
        ) : null}
      </>
    ) : (
      <>No successful backup yet</>
    );
  return (
    <Card className="frost">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <CloudUpload className="h-4 w-4" />
            Backup status
          </span>
          <Badge
            variant={failed ? "destructive" : "outline"}
            className={
              failed
                ? "gap-1"
                : warning || due
                  ? "gap-1 border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : healthy
                    ? "gap-1 border-green-600/50 bg-green-600/10 text-green-700 dark:text-green-400"
                    : "gap-1"
            }
          >
            {failed ? (
              <XCircle className="h-3 w-3" aria-hidden />
            ) : warning || due ? (
              <AlertTriangle className="h-3 w-3" aria-hidden />
            ) : healthy ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden />
            ) : null}
            {failed
              ? "Needs attention"
              : warning
                ? "Backup incomplete"
                : due
                  ? "Backup due"
                  : healthy
                    ? "Healthy"
                    : noBackup
                      ? "No backup yet"
                      : "Needs attention"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            { label: "Local file", entry: local },
            { label: "Telegram", entry: tg },
          ].map(({ label, entry }) => (
            <div key={label} className="rounded-xl border p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-medium">
                {entry ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <AlertTriangle className="h-4 w-4" />
                )}
                {detailLabel(entry)}
              </p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {settings.automaticBackup
              ? "Automatic backup on"
              : "Automatic backup off"}
          </span>
          {settings.automaticBackup && nextDue && (
            <span>· Next due: {nextDue.toLocaleString()}</span>
          )}
          {latestAttempt?.status === "running" && (
            <span className="font-medium">· Backup running</span>
          )}
          {settings.lastBackupAt && (
            <span>
              · Last overall: {new Date(settings.lastBackupAt).toLocaleString()}
            </span>
          )}
          {(failed || warning) && (
            <span className="text-destructive">· {latestAttempt.summary}</span>
          )}
          <span className="flex-1" />
          {(failed || warning) && retryKind && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("truff-backup-retry", {
                    detail: { kind: retryKind },
                  }),
                )
              }
            >
              Retry
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <History className="mr-1 h-3.5 w-3.5" />
            View log
          </Button>
        </div>
        <BackupLogSheet open={open} onOpenChange={setOpen} />
      </CardContent>
    </Card>
  );
}
