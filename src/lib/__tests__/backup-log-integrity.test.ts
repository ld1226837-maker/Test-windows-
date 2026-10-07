// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "ks:backup-log";
const load = async () => {
  vi.resetModules();
  return import("../backup-log");
};
const stored = () =>
  (
    JSON.parse(window.localStorage.getItem(KEY) ?? '{"entries":[]}') as {
      entries: {
        summary: string;
        status: string;
        startedAt: string;
        detail?: { errorCode?: string };
      }[];
    }
  ).entries;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backup log ring buffer", () => {
  it("keeps the NEWEST 200 entries, stored oldest-first", async () => {
    const log = await load();
    for (let i = 0; i < 205; i++)
      log.beginOp("preview", `op ${i}`).finish("success", `done ${i}`);
    const entries = log.readLog();
    expect(entries).toHaveLength(200);
    expect(entries[0]!.summary).toBe("done 204");
    expect(entries.at(-1)!.summary).toBe("done 5");
    expect(stored()).toHaveLength(200);
    expect(stored().at(-1)!.summary).toBe("done 204");
  });

  it("still drops the oldest after an interrupted-entry recovery rewrote storage", async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: [
          {
            id: "stuck",
            kind: "local-export",
            status: "running",
            startedAt: old,
            summary: "stuck",
          },
        ],
      }),
    );
    const log = await load();
    expect(log.readLog()[0]!.detail?.errorCode).toBe("interrupted");
    await Promise.resolve();
    for (let i = 0; i < 200; i++)
      log.beginOp("preview", `op ${i}`).finish("success", `done ${i}`);
    const entries = log.readLog();
    expect(entries).toHaveLength(200);
    expect(entries[0]!.summary).toBe("done 199");
    expect(entries.some((e) => e.summary === "stuck")).toBe(false);
  });
});

describe("interrupted-operation recovery", () => {
  it("marks a stale running entry as interrupted without writing during the read", async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: [
          {
            id: "a",
            kind: "telegram-upload",
            status: "running",
            startedAt: old,
            summary: "x",
          },
        ],
      }),
    );
    const log = await load();
    const first = log.readLog();
    expect(first[0]!.status).toBe("error");
    expect(first[0]!.detail?.errorCode).toBe("interrupted");
    expect(stored()[0]!.status).toBe("running"); // getSnapshot is side-effect free
    expect(log.readLog()).toBe(first); // and returns a stable reference
    await Promise.resolve();
    expect(stored()[0]!.status).toBe("error"); // persisted afterwards
  });

  it("leaves a recently-seen running entry (another window's live operation) alone", async () => {
    const now = new Date().toISOString();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: [
          {
            id: "b",
            kind: "local-export",
            status: "running",
            startedAt: now,
            updatedAt: now,
            summary: "live elsewhere",
          },
        ],
      }),
    );
    const log = await load();
    expect(log.readLog()[0]!.status).toBe("running");
  });

  it("marks it interrupted once its heartbeat goes stale", async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: [
          {
            id: "c",
            kind: "local-export",
            status: "running",
            startedAt: now,
            updatedAt: now,
            summary: "gone",
          },
        ],
      }),
    );
    const log = await load();
    const seen: string[] = [];
    log.subscribe(() => seen.push(log.readLog()[0]!.status));
    expect(log.readLog()[0]!.status).toBe("running");
    vi.advanceTimersByTime(16_000);
    expect(log.readLog()[0]!.status).toBe("error");
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("lastBackupAt is kept truthful by every backup path", () => {
  it.each(["local-export", "telegram-upload", "auto-backup"] as const)(
    "%s success sets lastBackupAt and clears the error",
    async (kind) => {
      const log = await load();
      const { readAppSettings, writeAppSettings } = await import("../settings");
      writeAppSettings({
        ...readAppSettings(),
        lastBackupAt: null,
        lastBackupError: "old",
        lastBackupErrorAt: "2020-01-01T00:00:00.000Z",
      });
      log.beginOp(kind, "x").finish("success", "ok");
      const s = readAppSettings();
      expect(s.lastBackupAt).toBeTruthy();
      expect(s.lastBackupError).toBeNull();
      expect(s.lastBackupErrorAt).toBeNull();
    },
  );

  it.each(["local-export", "telegram-upload", "auto-backup"] as const)(
    "%s failure records the redacted error but keeps lastBackupAt",
    async (kind) => {
      const log = await load();
      const { readAppSettings, writeAppSettings } = await import("../settings");
      const when = "2026-01-01T00:00:00.000Z";
      writeAppSettings({ ...readAppSettings(), lastBackupAt: when });
      log
        .beginOp(kind, "x")
        .finish(
          "error",
          "failed for 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd_123",
        );
      const s = readAppSettings();
      expect(s.lastBackupAt).toBe(when);
      expect(s.lastBackupError).toBeTruthy();
      expect(s.lastBackupError).not.toContain(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd_123",
      );
    },
  );

  it("year archives, restores and previews never touch lastBackupAt", async () => {
    const log = await load();
    const { readAppSettings, writeAppSettings } = await import("../settings");
    writeAppSettings({ ...readAppSettings(), lastBackupAt: null });
    for (const kind of [
      "telegram-year-archive",
      "local-restore",
      "telegram-restore",
      "preview",
      "telegram-config",
    ] as const)
      log.beginOp(kind, "x").finish("success", "ok");
    expect(readAppSettings().lastBackupAt).toBeNull();
  });
});
