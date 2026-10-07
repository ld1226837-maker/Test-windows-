import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CheckCircle2,
  Loader2,
  XCircle,
  AlertTriangle,
  X,
  History,
  RotateCw,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import {
  dismissOperationResult,
  progressPercent,
  registerInlineBar,
  readOperationProgress,
  subscribeOperationProgress,
  type OpProgress,
} from "@/lib/operation-progress";

const phaseText: Record<OpProgress["phase"], string> = {
  preparing: "Preparing",
  reading: "Reading",
  compressing: "Compressing",
  encrypting: "Encrypting",
  uploading: "Uploading",
  downloading: "Downloading",
  verifying: "Verifying",
  writing: "Writing",
  "restoring-records": "Restoring records",
  "restoring-photos": "Restoring receipt photos",
  finalizing: "Finalizing",
};
const statusText: Record<NonNullable<OpProgress["status"]>, string> = {
  running: "Running",
  success: "Done",
  warning: "Finished with warnings",
  error: "Failed",
  cancelled: "Cancelled",
};
// Which card owns the "Retry" for a failed run (both cards listen for this event).
const retryKindFor = (kind: OpProgress["kind"]) =>
  kind === "telegram-upload" || kind === "auto-backup"
    ? "telegram"
    : kind === "local-export"
      ? "local"
      : null;

/** Seconds left on a Telegram rate-limit wait, ticking once a second. */
function useCountdown(until: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export function OperationProgressBar({
  compact = false,
}: {
  compact?: boolean;
}) {
  const op = useSyncExternalStore(
    subscribeOperationProgress,
    readOperationProgress,
    () => null,
  );
  const waitSeconds = useCountdown(op?.retry?.until);
  useEffect(() => (compact ? undefined : registerInlineBar()), [compact]);
  if (!op) return null;
  const percent = progressPercent(op);
  const terminal = Boolean(op.status && op.status !== "running");
  const waiting = !terminal && op.retry && waitSeconds > 0;
  const headline = waiting
    ? `Telegram asked us to wait ${waitSeconds} s, retrying (attempt ${op.retry!.attempt} of ${op.retry!.max})`
    : (op.summary ?? op.label);
  const retryKind =
    op.status === "error" || op.status === "warning"
      ? retryKindFor(op.kind)
      : null;
  const tone =
    op.status === "success"
      ? "border-green-600/60"
      : op.status === "warning"
        ? "border-amber-500/70"
        : op.status === "error"
          ? "border-destructive/70"
          : "";
  return (
    <div
      role="group"
      aria-label="Backup progress"
      className={`${compact ? "border-b bg-background px-3 py-1.5" : "rounded-xl border bg-background p-3"} ${tone}`}
    >
      <div
        className="flex items-center gap-2 text-xs font-medium"
        aria-live="polite"
      >
        {op.status === "success" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
        ) : op.status === "warning" ? (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
        ) : op.status === "error" || op.status === "cancelled" ? (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
        <span className="min-w-0 flex-1 truncate">{headline}</span>
        {terminal ? (
          <span>{statusText[op.status!]}</span>
        ) : (
          op.total != null &&
          op.done != null && <span>{Math.round(percent)}%</span>
        )}
      </div>
      {!terminal && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span>{phaseText[op.phase] ?? op.phase}</span>
          {op.total != null && op.done != null && (
            <span>
              · {op.done}/{op.total}
            </span>
          )}
          {op.bytesTotal != null && op.bytesDone != null && (
            <span>
              · {(op.bytesDone / 1048576).toFixed(1)} /{" "}
              {(op.bytesTotal / 1048576).toFixed(1)} MB
            </span>
          )}
        </div>
      )}
      <Progress
        className="mt-2"
        value={terminal ? 100 : op.total != null ? percent : undefined}
        aria-valuenow={
          terminal || op.total != null
            ? Math.round(terminal ? 100 : percent)
            : undefined
        }
        aria-label={op.label}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {!terminal && op.cancellable && op.cancel && (
          <Button size="sm" variant="outline" onClick={op.cancel}>
            <X className="mr-1 h-3.5 w-3.5" />
            Cancel
          </Button>
        )}
        {terminal && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("truff-open-backup-log"))
            }
          >
            <History className="mr-1 h-3.5 w-3.5" />
            View log
          </Button>
        )}
        {retryKind && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              dismissOperationResult();
              window.dispatchEvent(
                new CustomEvent("truff-backup-retry", {
                  detail: { kind: retryKind },
                }),
              );
            }}
          >
            <RotateCw className="mr-1 h-3.5 w-3.5" />
            Retry
          </Button>
        )}
        {terminal && (op.status === "error" || op.status === "warning") && (
          <Button size="sm" variant="ghost" onClick={dismissOperationResult}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
