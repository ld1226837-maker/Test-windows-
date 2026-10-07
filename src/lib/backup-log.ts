import { readAppSettings, writeAppSettings } from "./settings";

export type BackupOpKind =
  | "local-export"
  | "local-restore"
  | "telegram-upload"
  | "telegram-year-archive"
  | "telegram-restore"
  | "auto-backup"
  | "telegram-config"
  | "preview";
export type BackupOpStatus =
  "running" | "success" | "warning" | "error" | "cancelled";
export type BackupLogEntry = {
  id: string;
  kind: BackupOpKind;
  status: BackupOpStatus;
  startedAt: string;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
  /** last heartbeat from the live operation; lets another window tell "running" from "app was killed" */ updatedAt?:
    string | undefined;
  device?: string | undefined;
  summary: string;
  detail?: BackupLogDetail | undefined;
};
export type BackupLogDetail = {
  bytes?: number | undefined;
  parts?: { done: number; total: number } | undefined;
  records?: number | undefined;
  photos?: { saved: number; missing: number } | undefined;
  session?: string | undefined;
  encrypted?: boolean | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  retries?: number | undefined;
  retryAfterMs?: number | undefined;
};
const KEY = "ks:backup-log";
const VERSION = 1;
const MAX = 200;
const listeners = new Set<() => void>();
const live = new Set<string>();
const externalLive = new Set<string>();
// Browser-only: SSR/prerender (Node) must never open a channel; Node's
// BroadcastChannel differs from the DOM one and would keep the process alive.
function createLiveChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    const channel = new BroadcastChannel("ks:backup-log-live");
    if (typeof channel.addEventListener !== "function") {
      channel.close();
      return null;
    }
    channel.addEventListener("message", (event) => {
      const data = event.data as { type?: string; id?: string } | null;
      if (!data?.id) return;
      if (data.type === "begin") externalLive.add(data.id);
      else if (data.type === "finish") externalLive.delete(data.id);
    });
    return channel;
  } catch {
    return null; // observers must never break operations
  }
}
const liveChannel = createLiveChannel();
let cache: BackupLogEntry[] | null = null;
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) {
      cache = null;
      emit();
    }
  });

export function redact(value: unknown): string {
  const text = String(value ?? "");
  const tokenPattern =
    /(?:https?:\/\/api\.telegram\.org\/bot|\bbot)?(\d{6,12}):([A-Za-z0-9_-]{30,})/gi;
  let out = text.replace(
    tokenPattern,
    (_m, id: string, secret: string) =>
      `${id.slice(0, 6)}…:${secret.slice(0, 2)}…${secret.slice(-3)}`,
  );

  const chatIdPattern =
    /(\b(?:chat[_ -]?id|chat)(?:\s*[:=]\s*|\s+))(-?\d{5,})/gi;
  out = out.replace(
    chatIdPattern,
    (_m, prefix: string) => `${prefix}[redacted]`,
  );
  out = out.replace(
    /("(?:chat_id|chatId)"\s*:\s*")(-?\d{5,})(")/gi,
    (_m, prefix: string, _id: string, suffix: string) =>
      `${prefix}[redacted]${suffix}`,
  );

  const secretValue =
    /((?:"(?:passphrase|password|token|secret|api_key|api-key)"\s*:\s*|\b(?:passphrase|password|token|secret|api[-_ ]?key)\s*[:=]\s*|\b(?:passphrase|password)\s+(?:is|was|given|provided)\s+|\b(?:passphrase|password)\s+))("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi;
  out = out.replace(
    secretValue,
    (match: string, prefix: string, secret: string) => {
      if (secret.includes("…")) return match; // already masked by the token rule above
      const cleanPrefix = prefix.replace(/\s*[:=]\s*$/, "").trimEnd();
      const quote =
        secret.startsWith('"') || secret.startsWith("'") ? secret[0] : "";
      return `${cleanPrefix}: ${quote}[redacted]${quote}`;
    },
  );

  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
  out = out.replace(
    /((?:Authorization\s*:\s*|authorization\s*=\s*))(?!\[redacted\])(?:(?:Bearer|Basic|Digest|Token)\s+)?[^\s,;]+/gi,
    "$1[redacted]",
  );
  return out;
}

export function errorCodeFor(value: unknown): string {
  const message = String(
    value instanceof Error ? value.message : (value ?? ""),
  ).toLowerCase();
  if (
    /wrong passphrase|bad passphrase|passphrase.*(incorrect|invalid)|incorrect.*passphrase/.test(
      message,
    )
  )
    return "bad-passphrase";
  if (
    /\bhttp(?:\s+|:\/\/)?401\b|\bstatus\s*[:=]?\s*401\b|unauthorized|invalid bot token|rejected the bot token/.test(
      message,
    )
  )
    return "telegram-401";
  if (
    /\bhttp(?:\s+|:\/\/)?429\b|\bstatus\s*[:=]?\s*429\b|too many requests|retry_after/.test(
      message,
    )
  )
    return "telegram-429";
  if (
    /network|failed to fetch|fetch failed|couldn't reach telegram|internet connection/.test(
      message,
    )
  )
    return "telegram-network";
  if (/chunk.*(missing|not found)|(missing|not found).*chunk/.test(message))
    return "chunk-missing";
  if (/incomplete|incomplete session|complete backup/.test(message))
    return "incomplete-session";
  if (/disk.*(full|space)|no space left|quota exceeded/.test(message))
    return "disk-full";
  if (/permission|access denied|not allowed/.test(message))
    return "permission-denied";
  if (/abort|cancelled|canceled/.test(message)) return "interrupted";
  return "unknown";
}

const STALE_MS = 15_000;
const HEARTBEAT_MS = 5_000;
let recheckTimer: ReturnType<typeof setTimeout> | null = null;
const startedMs = (e: { startedAt: string }) => {
  const n = Date.parse(e.startedAt);
  return Number.isFinite(n) ? n : 0;
};
// Storage is always oldest-first so `slice(-MAX)` drops the OLDEST entries; the
// in-memory cache (what the UI reads) is the newest-first reverse of it.
const oldestFirst = (entries: BackupLogEntry[]) =>
  [...entries].sort((a, b) => startedMs(a) - startedMs(b));

function readRaw(): BackupLogEntry[] {
  try {
    if (typeof window === "undefined" || !window.localStorage) return [];
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    )
      return [];
    return oldestFirst((parsed as { entries: BackupLogEntry[] }).entries).slice(
      -MAX,
    );
  } catch {
    return [];
  }
}
function emit() {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* observer */
    }
  });
}

/**
 * A "running" entry nobody is working on any more means the app was killed
 * mid-operation. Another window's live operation must not be mistaken for that,
 * so an entry only counts as interrupted once its heartbeat is stale.
 */
function markInterrupted(
  entries: BackupLogEntry[],
  now: number,
): { entries: BackupLogEntry[]; changed: boolean; recheckInMs: number | null } {
  let changed = false;
  let recheckInMs: number | null = null;
  const out = entries.map((e): BackupLogEntry => {
    if (e.status !== "running" || live.has(e.id) || externalLive.has(e.id))
      return e;
    const seen = Date.parse(e.updatedAt ?? e.startedAt);
    const age = now - (Number.isFinite(seen) ? seen : 0);
    if (age < STALE_MS) {
      const wait = STALE_MS - age + 250;
      recheckInMs = recheckInMs == null ? wait : Math.min(recheckInMs, wait);
      return e;
    }
    changed = true;
    return {
      ...e,
      status: "error",
      finishedAt: new Date(now).toISOString(),
      durationMs: Math.max(0, now - startedMs(e)),
      detail: {
        ...e.detail,
        errorCode: "interrupted",
        errorMessage: "The operation was interrupted.",
      },
    };
  });
  return { entries: out, changed, recheckInMs };
}
function persist(entries: BackupLogEntry[]) {
  const stored = oldestFirst(entries).slice(-MAX);
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ v: VERSION, entries: stored }),
    );
  } catch {
    /* observer */
  }
  cache = [...markInterrupted(stored, Date.now()).entries].reverse();
  emit();
}
// getSnapshot for useSyncExternalStore: must be pure and return a stable
// reference between changes. The write-back of interrupted entries is deferred
// to a microtask so reading the log during render never writes or notifies.
function load(): BackupLogEntry[] {
  if (cache) return cache;
  const { entries, changed, recheckInMs } = markInterrupted(
    readRaw(),
    Date.now(),
  );
  cache = [...entries].reverse();
  if (changed)
    queueMicrotask(() => {
      try {
        const r = markInterrupted(readRaw(), Date.now());
        if (r.changed) persist(r.entries);
      } catch {
        /* observer */
      }
    });
  if (recheckInMs != null && !recheckTimer)
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      cache = null;
      emit();
    }, recheckInMs);
  return cache;
}
export function readLog(): BackupLogEntry[] {
  return load();
}
export function clearLog() {
  persist([]);
}
export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function exportLogText(): string {
  return readLog()
    .map((e) => {
      const d = e.detail;
      const detail = [
        d?.bytes != null ? `bytes=${d.bytes}` : null,
        d?.parts ? `parts=${d.parts.done}/${d.parts.total}` : null,
        d?.records != null ? `records=${d.records}` : null,
        d?.photos
          ? `photos=${d.photos.saved}/${d.photos.missing} missing`
          : null,
        d?.session ? `session=${d.session}` : null,
        d?.encrypted != null ? `encrypted=${d.encrypted}` : null,
        d?.errorCode ? `error=${d.errorCode}` : null,
        d?.errorMessage ? `message=${redact(d.errorMessage)}` : null,
        d?.retries != null ? `retries=${d.retries}` : null,
        d?.retryAfterMs != null ? `retryAfterMs=${d.retryAfterMs}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      return `${e.startedAt} | ${e.status.toUpperCase()} | ${e.kind} | ${e.summary}${e.device ? ` | device=${redact(e.device)}` : ""}${e.durationMs != null ? ` | ${e.durationMs}ms` : ""}${detail ? ` | ${detail}` : ""}`;
    })
    .join("\n");
}
function touch(id: string) {
  try {
    const raw = readRaw();
    if (!raw.some((e) => e.id === id)) return;
    // Heartbeat only: no emit and no cache change, the UI has nothing to redraw.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        v: VERSION,
        entries: raw.map((e) =>
          e.id === id ? { ...e, updatedAt: new Date().toISOString() } : e,
        ),
      }),
    );
  } catch {
    /* observer */
  }
}
export function beginOp(kind: BackupOpKind, summary = "Backup operation") {
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  live.add(id);
  try {
    liveChannel?.postMessage({ type: "begin", id });
  } catch {
    /* observer only */
  }
  const heartbeat = setInterval(() => touch(id), HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  const entry: BackupLogEntry = {
    id,
    kind,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    device: readDevice(),
    summary: redact(summary),
  };
  const current = readRaw().filter((e) => e.id !== id);
  persist([...current, entry]);
  return {
    id,
    update(partial: Partial<Pick<BackupLogEntry, "summary" | "detail">>) {
      try {
        const next = readRaw().map((e) =>
          e.id === id
            ? {
                ...e,
                ...partial,
                updatedAt: new Date().toISOString(),
                summary: redact(partial.summary ?? e.summary),
                detail: partial.detail
                  ? { ...e.detail, ...partial.detail }
                  : e.detail,
              }
            : e,
        );
        persist(next);
      } catch {
        /* observer */
      }
    },
    finish(
      status: Exclude<BackupOpStatus, "running">,
      summary: string,
      detail?: BackupLogEntry["detail"],
    ) {
      clearInterval(heartbeat);
      live.delete(id);
      try {
        liveChannel?.postMessage({ type: "finish", id });
      } catch {
        /* observer only */
      }
      const finishedAt = new Date().toISOString();
      const started = Date.parse(startedAt);
      const next = readRaw().map((e) =>
        e.id === id
          ? {
              ...e,
              status,
              finishedAt,
              updatedAt: finishedAt,
              durationMs: Number.isFinite(started)
                ? Date.parse(finishedAt) - started
                : undefined,
              summary: redact(summary),
              detail: detail
                ? {
                    ...e.detail,
                    ...detail,
                    errorMessage: detail.errorMessage
                      ? redact(detail.errorMessage)
                      : undefined,
                  }
                : e.detail,
            }
          : e,
      );
      persist(next);
      if (
        kind === "local-export" ||
        kind === "telegram-upload" ||
        kind === "auto-backup"
      )
        updateBackupStatus(status, summary);
    },
  };
}
function readDevice(): string | undefined {
  try {
    return typeof window === "undefined"
      ? undefined
      : window.localStorage.getItem("ks:device-label") || undefined;
  } catch {
    return undefined;
  }
}
function updateBackupStatus(status: BackupOpStatus, summary: string) {
  try {
    const s = readAppSettings();
    writeAppSettings({
      ...s,
      ...(status === "success" || status === "warning"
        ? {
            lastBackupAt: new Date().toISOString(),
            lastBackupError: null,
            lastBackupErrorAt: null,
          }
        : status === "error"
          ? {
              lastBackupError: redact(summary),
              lastBackupErrorAt: new Date().toISOString(),
            }
          : {}),
    });
  } catch {
    /* status is observational */
  }
}
