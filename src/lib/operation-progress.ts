import type { BackupOpKind } from "./backup-log";
export type OpPhase =
  | "preparing"
  | "reading"
  | "compressing"
  | "encrypting"
  | "uploading"
  | "downloading"
  | "verifying"
  | "writing"
  | "restoring-records"
  | "restoring-photos"
  | "finalizing";
export type OpProgress = {
  opId: string;
  kind: BackupOpKind;
  phase: OpPhase;
  label: string;
  done?: number | undefined;
  total?: number | undefined;
  bytesDone?: number | undefined;
  bytesTotal?: number | undefined;
  cancellable: boolean;
  retry?: { attempt: number; max: number; until: number } | undefined;
  status?:
    "running" | "success" | "warning" | "error" | "cancelled" | undefined;
  summary?: string | undefined;
  cancel?: (() => void) | undefined;
};
let current: OpProgress | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: OpProgress | null = null;
const phaseWeights: Record<OpPhase, number> = {
  preparing: 5,
  reading: 10,
  compressing: 10,
  encrypting: 15,
  uploading: 75,
  downloading: 75,
  verifying: 5,
  writing: 10,
  "restoring-records": 65,
  "restoring-photos": 20,
  finalizing: 5,
};
const phaseOrder: Record<BackupOpKind, OpPhase[]> = {
  "local-export": [
    "preparing",
    "reading",
    "compressing",
    "encrypting",
    "writing",
    "finalizing",
  ],
  "local-restore": [
    "reading",
    "verifying",
    "restoring-records",
    "restoring-photos",
    "finalizing",
  ],
  "telegram-upload": [
    "preparing",
    "encrypting",
    "uploading",
    "verifying",
    "finalizing",
  ],
  "telegram-year-archive": [
    "preparing",
    "encrypting",
    "uploading",
    "verifying",
    "finalizing",
  ],
  "telegram-restore": [
    "preparing",
    "downloading",
    "verifying",
    "restoring-records",
    "restoring-photos",
    "finalizing",
  ],
  "auto-backup": [
    "preparing",
    "encrypting",
    "uploading",
    "verifying",
    "finalizing",
  ],
  "telegram-config": ["preparing", "verifying", "finalizing"],
  preview: ["reading", "verifying", "finalizing"],
};

function emit() {
  listeners.forEach((c) => {
    try {
      c();
    } catch {
      // A failing listener must not stop the others.
    }
  });
}
function flush() {
  timer = null;
  if (pending) {
    current = pending;
    pending = null;
    emit();
  }
}
type ScreenWakeLock = {
  release: () => Promise<void>;
  addEventListener?: (type: "release", cb: () => void) => void;
};
type WakeLockApi = { request: (type: "screen") => Promise<ScreenWakeLock> };
let wakeLock: ScreenWakeLock | null = null;
let guardCleanup: (() => void) | null = null;
const isAndroidUa = () =>
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

/**
 * While an operation runs: keep the screen awake, warn before the window
 * closes (desktop) and swallow the Android back gesture instead of silently
 * abandoning a restore. Everything is released in removeLifecycleGuard().
 */
function installLifecycleGuard() {
  if (typeof window === "undefined" || guardCleanup) return;
  let active = true;
  const android = isAndroidUa();
  let pushed = false;

  const beforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = "";
  };
  // Android WebViews have no unload prompt; there the back button is what ends a run.
  if (!android) window.addEventListener("beforeunload", beforeUnload);

  // Back button: keep one extra history entry on top and re-push it whenever it
  // is popped while an operation is running, so back does nothing but warn. The
  // entry reuses the current history.state so the router sees the same location.
  const onPopState = () => {
    if (!active || !isOperationRunning()) return;
    try {
      window.history.pushState(
        { ...(window.history.state ?? {}), __truffOp: true },
        "",
      );
    } catch {
      /* best effort */
    }
    void import("sonner")
      .then(({ toast }) =>
        toast.message(
          "A backup or restore is still running. Wait for it to finish, or cancel it first.",
        ),
      )
      .catch(() => {});
  };
  if (android) {
    try {
      window.history.pushState(
        { ...(window.history.state ?? {}), __truffOp: true },
        "",
      );
      pushed = true;
      window.addEventListener("popstate", onPopState);
    } catch {
      /* best effort */
    }
  }

  const acquire = async () => {
    try {
      const wake = (navigator as Navigator & { wakeLock?: WakeLockApi })
        .wakeLock;
      if (
        !wake ||
        wakeLock ||
        !active ||
        document.visibilityState !== "visible"
      )
        return;
      const lock = await wake.request("screen");
      // The guard may have been removed while the request was pending: release
      // the lock we just got instead of leaking it.
      if (!active) {
        void lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      // The browser drops the lock whenever the page is hidden; forget it so the
      // next visibilitychange can take a new one.
      lock.addEventListener?.("release", () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } catch {
      /* best effort; the operation is valid without a wake lock */
    }
  };
  const onVisible = () => {
    if (
      document.visibilityState === "visible" &&
      current &&
      isOperationRunning()
    )
      void acquire();
  };
  document.addEventListener("visibilitychange", onVisible);
  void acquire();

  guardCleanup = () => {
    active = false;
    window.removeEventListener("beforeunload", beforeUnload);
    window.removeEventListener("popstate", onPopState);
    // Pop the sentinel entry we added so the user does not need an extra back
    // press. Only if it is still on top; the listener is already gone so this
    // pop is not intercepted.
    if (pushed) {
      try {
        if ((window.history.state as { __truffOp?: boolean } | null)?.__truffOp)
          window.history.back();
      } catch {
        /* best effort */
      }
    }
    document.removeEventListener("visibilitychange", onVisible);
    if (wakeLock) {
      void wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    guardCleanup = null;
  };
}
function removeLifecycleGuard() {
  guardCleanup?.();
}
export function setOperationProgress(p: OpProgress | null) {
  if (!p) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
    current = null;
    removeLifecycleGuard();
    emit();
    return;
  } // A late progress callback for an operation whose result is already showing must not resurrect it (or the lifecycle guard).
  if (
    current?.opId === p.opId &&
    current.status &&
    current.status !== "running"
  )
    return;
  installLifecycleGuard();
  pending = p;
  if (!timer) timer = setTimeout(flush, 100);
}
export function readOperationProgress() {
  return current;
}
export function subscribeOperationProgress(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function progressPercent(p: OpProgress): number {
  const phases = phaseOrder[p.kind] ?? [p.phase];
  const idx = Math.max(0, phases.indexOf(p.phase));
  const weights = phases.map((phase) => phaseWeights[phase]);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const base = weights.slice(0, idx).reduce((sum, value) => sum + value, 0);
  const current = weights[idx] ?? 0;
  const fraction =
    p.total != null && p.done != null && p.total > 0
      ? Math.min(1, Math.max(0, p.done / p.total))
      : 0;
  return Math.max(
    0,
    Math.min(100, ((base + current * fraction) / total) * 100),
  );
}

export function beginProgress(
  kind: BackupOpKind,
  opId: string,
  phase: OpPhase,
  label: string,
  cancellable = false,
  cancel?: () => void,
) {
  setOperationProgress({ opId, kind, phase, label, cancellable, cancel });
}

/** Result banners that need a decision (warning/error) stay until dismissed; the rest fade. */
const AUTO_DISMISS_MS: Partial<
  Record<NonNullable<OpProgress["status"]>, number>
> = { success: 6000, cancelled: 4000 };

export function setOperationResult(
  status: NonNullable<OpProgress["status"]>,
  summary: string,
) {
  if (!current && pending) {
    current = pending;
    pending = null;
  }
  if (!current) return;
  const resultOpId = current.opId;
  current = {
    ...current,
    status,
    summary,
    cancellable: false,
    cancel: undefined,
    retry: undefined,
  };
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending = null;
  // The operation is over: stop holding the screen awake / blocking unload now,
  // not when the banner finally disappears.
  removeLifecycleGuard();
  emit();
  const after = AUTO_DISMISS_MS[status];
  if (after == null) return;
  setTimeout(() => {
    if (current?.opId === resultOpId && current.status === status) {
      current = null;
      pending = null;
      emit();
    }
  }, after);
}

/** Dismisses a finished result banner; never touches a running operation. */
export function dismissOperationResult() {
  if (current && current.status && current.status !== "running") {
    current = null;
    pending = null;
    emit();
  }
}

/** Shows a live "waiting N s, retrying" countdown on the running operation without disturbing its progress numbers. */
export function setOperationRetry(retry: {
  attempt: number;
  max: number;
  retryAfterMs: number;
}) {
  const base = pending ?? current;
  if (!base || (base.status && base.status !== "running")) return;
  setOperationProgress({
    ...base,
    retry: {
      attempt: retry.attempt,
      max: retry.max,
      until: Date.now() + retry.retryAfterMs,
    },
  });
}

export function isOperationRunning(): boolean {
  return (
    current !== null && (current.status == null || current.status === "running")
  );
}

// Inline bars (inside the Settings cards) register here so the app-wide sticky
// bar can hide itself instead of showing the same operation twice.
let inlineBars = 0;
export function registerInlineBar(): () => void {
  inlineBars += 1;
  emit();
  return () => {
    inlineBars = Math.max(0, inlineBars - 1);
    emit();
  };
}
export function readInlineBars(): number {
  return inlineBars;
}
