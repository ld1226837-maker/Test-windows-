import { useEffect, useState } from "react";
import { Wifi, WifiOff, CloudUpload, Loader2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { OperationProgressBar } from "./OperationProgressBar";
import { BackupLogSheet } from "./BackupLogSheet";
import {
  readInlineBars,
  readOperationProgress,
  subscribeOperationProgress,
  progressPercent,
} from "@/lib/operation-progress";
import { cn } from "@/lib/utils";
import { goToTab } from "@/lib/nav";
import {
  backupAgeLabel,
  backupReminderDue,
  useAppSettings,
} from "@/lib/settings";

/**
 * The always-visible status strip the app shell was missing (see
 * PROGRESS-NOTES.md — backup state previously lived only inside the
 * Settings tab's cards plus a one-time "Time for a backup" toast that's
 * easy to miss or dismiss). Two live facts, always on screen instead of
 * tucked away: whether the device is online right now, and how stale the
 * last backup is. Clicking the backup side jumps straight to Settings.
 *
 * Deliberately NOT a warning banner that only appears when something's
 * wrong — it's a quiet, permanent strip so "when did I last back up" is
 * always answerable at a glance, the same way a phone's status bar shows
 * signal/battery whether or not either is low.
 */
export function AppStatusStrip() {
  const { settings } = useAppSettings();
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const backupDue = backupReminderDue(settings);
  const op = useSyncExternalStore(
    subscribeOperationProgress,
    readOperationProgress,
    () => null,
  );
  // The progress bar's "View log" can fire from any tab, so the log sheet is hosted here, where it is always mounted.
  const [logOpen, setLogOpen] = useState(false);
  useEffect(() => {
    const open = () => setLogOpen(true);
    window.addEventListener("truff-open-backup-log", open);
    return () => window.removeEventListener("truff-open-backup-log", open);
  }, []);
  const inlineBars = useSyncExternalStore(
    subscribeOperationProgress,
    readInlineBars,
    () => 0,
  );
  const running = Boolean(op && (!op.status || op.status === "running"));

  return (
    <div className="sticky top-[var(--app-header-h,calc(4.25rem+env(safe-area-inset-top)))] z-10">
      <div className="flex min-h-7 items-center justify-between gap-3 border-b bg-[color-mix(in_oklab,var(--muted)_40%,var(--background))] px-4 py-0.5 text-[11px] text-muted-foreground md:px-8">
        <span className="flex items-center gap-1.5">
          {online ? (
            <Wifi className="h-3 w-3 text-success" />
          ) : (
            <WifiOff className="h-3 w-3 text-destructive" />
          )}
          {op ? (
            <>
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{" "}
              {running && op.total != null && op.done != null
                ? `Backing up ${op.done}/${op.total}`
                : (op.summary ?? op.label)}
              {running && op.total != null && op.done != null
                ? ` · ${Math.round(progressPercent(op))}%`
                : ""}
            </>
          ) : online ? (
            "Online"
          ) : (
            <>
              {/* Short copy on phones: the long line plus the backup label
                doesn't fit one row at ~360px. */}
              <span className="sm:hidden">Offline — saving locally</span>
              <span className="hidden sm:inline">
                Offline — everything still saves locally
              </span>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => goToTab("settings")}
          className={cn(
            "relative flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors after:absolute after:inset-x-0 after:-inset-y-3 hover:bg-muted",
            backupDue && "font-medium text-destructive",
          )}
          title="Open Settings → Backup & restore"
        >
          <CloudUpload className="h-3 w-3" />
          {backupAgeLabel(settings.lastBackupAt)}
        </button>
      </div>
      {op && inlineBars === 0 && <OperationProgressBar compact />}
      <BackupLogSheet open={logOpen} onOpenChange={setLogOpen} />
    </div>
  );
}
