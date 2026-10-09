// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WrongPassphraseError } from "../backup-crypto";
import { db, newId, nowIso } from "../localdb";
import { sha256Hex } from "../receipts-share";
import {
  BackupSelectionError,
  buildShardedFullBackup,
  discoverTelegramBackups,
  fetchShardedFullBackupByMessage,
  isStaleSelectionError,
  listRecentTelegramBackups,
  restoreFullBackupSharded,
  uploadFullBackup,
  readLastUpload,
  type TelegramConfig,
} from "../telegram-backup";

const S1 = "2026-10-08T07-09-48-851Z";
const S2 = "2026-10-07T07-09-48-851Z";
const S3 = "2026-10-06T07-09-48-851Z";
const manifestName = (s: string) => `turf-ledger-full-manifest-${s}.json`;
const shardName = (s: string) => `turf-ledger-full-shard-${s}-1-of-1.zip`;

const cfg = (over: Partial<TelegramConfig> = {}): TelegramConfig => ({
  botToken: "111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  chatId: "-100123",
  extraBotTokens: [],
  deviceLabel: "Windows",
  ...over,
});
const BOT2 = "222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const ok = (result: unknown) =>
  new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const fail = (status: number, description: string, extra: object = {}) =>
  new Response(JSON.stringify({ ok: false, description, ...extra }), {
    status,
  });
const GONE = () => fail(400, "Bad Request: message to forward not found");

type Req = { method: string; token: string; body: Record<string, unknown> };
type Handler = (req: Req, init: RequestInit) => Response | Promise<Response>;

/** Routes Bot API calls to `handler`; honours AbortSignal like real fetch. */
function stubTelegram(handler: Handler) {
  const calls: Req[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      const m = /\/bot([^/]+)\/(\w+)$/.exec(url);
      const req: Req = {
        token: m?.[1] ?? "",
        method: m?.[2] ?? "",
        body:
          typeof init.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {},
      };
      calls.push(req);
      return new Promise<Response>((resolve, reject) => {
        if (init.signal?.aborted)
          return reject(new DOMException("aborted", "AbortError"));
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        Promise.resolve(handler(req, init)).then(resolve, reject);
      });
    }),
  );
  return calls;
}

/** A forward handler: `docs` maps message_id -> document name (or null = text). */
function forwardFrom(docs: Record<number, string | null>): Handler {
  return (req) => {
    if (req.method === "forwardMessage") {
      const id = req.body["message_id"] as number;
      if (!(id in docs)) return GONE();
      const name = docs[id];
      return ok({
        message_id: 9000 + id,
        ...(name
          ? { document: { file_id: `fid-${id}`, file_name: name } }
          : {}),
      });
    }
    if (req.method === "deleteMessage") return ok(true);
    if (req.method === "getUpdates") return ok([]);
    if (req.method === "getChat") return ok({});
    return fail(404, "unexpected " + req.method);
  };
}

function rememberUpload(session: string, ids: number[], chatId = "-100123") {
  const entry = {
    session,
    total: ids.length,
    messageIds: ids,
    chatId,
    at: new Date().toISOString(),
  };
  localStorage.setItem("ks:telegram-backup-last", JSON.stringify(entry));
  const hist = JSON.parse(
    localStorage.getItem("ks:telegram-backup-history") ?? "[]",
  ) as unknown[];
  localStorage.setItem(
    "ks:telegram-backup-history",
    JSON.stringify([entry, ...hist]),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("discovery: stale and wrong messages never block the list", () => {
  it("a deleted remembered message goes to `stale`, the pinned backup is still listed", async () => {
    rememberUpload(S1, [10, 11]); // manifest #11 was deleted
    stubTelegram((req, init) => {
      if (req.method === "getChat")
        return ok({
          pinned_message: {
            message_id: 40,
            document: { file_id: "p", file_name: manifestName(S2) },
          },
        });
      return forwardFrom({ 40: manifestName(S2) })(req, init);
    });
    const r = await discoverTelegramBackups(cfg());
    expect(r.backups.map((b) => b.session)).toEqual([S2]);
    expect(r.backups[0]!.status).toBe("verified");
    expect(r.backups[0]!.origins).toEqual(["pinned"]);
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]).toMatchObject({
      session: S1,
      manifestMessageId: 11,
      code: "message-gone",
    });
    // The bad device pointer is forgotten; nothing else is touched.
    expect(readLastUpload()).toBeNull();
  });

  it("an incorrect message ID (text, shard, or another backup's manifest) is stale, not restorable", async () => {
    rememberUpload(S1, [11]);
    rememberUpload(S2, [12]);
    rememberUpload(S3, [13]);
    stubTelegram(
      forwardFrom({
        11: null, // plain text message
        12: shardName(S2), // a shard, not the manifest
        13: manifestName(S1), // a different session's manifest
      }),
    );
    const r = await discoverTelegramBackups(cfg());
    expect(r.backups).toHaveLength(0);
    expect(r.stale.map((s) => [s.manifestMessageId, s.code]).sort()).toEqual([
      [11, "not-a-manifest"],
      [12, "not-a-manifest"],
      [13, "wrong-session"],
    ]);
    expect(r.notes.join(" ")).toMatch(/message link|saved backup file/i);
  });

  it("device-local and Telegram-discovered items stay labelled by origin", async () => {
    rememberUpload(S1, [21]);
    stubTelegram((req, init) => {
      if (req.method === "getUpdates")
        return ok([
          {
            update_id: 1,
            message: {
              message_id: 21,
              chat: { id: -100123 },
              document: { file_id: "u", file_name: manifestName(S1) },
            },
          },
          {
            update_id: 2,
            message: {
              message_id: 30,
              chat: { id: -100123 },
              document: { file_id: "u2", file_name: manifestName(S2) },
            },
          },
          {
            // other chat: ignored
            update_id: 3,
            message: {
              message_id: 31,
              chat: { id: -999 },
              document: { file_id: "u3", file_name: manifestName(S3) },
            },
          },
        ]);
      return forwardFrom({ 21: manifestName(S1), 30: manifestName(S2) })(
        req,
        init,
      );
    });
    const r = await discoverTelegramBackups(cfg());
    const byS = Object.fromEntries(r.backups.map((b) => [b.session, b]));
    expect([...byS[S1]!.origins].sort()).toEqual(["device", "updates"]);
    expect(byS[S2]!.origins).toEqual(["updates"]);
    expect(byS[S3]).toBeUndefined();
  });

  it("pointers remembered for a different chat are ignored", async () => {
    rememberUpload(S1, [11], "-100999");
    stubTelegram(forwardFrom({ 11: manifestName(S1) }));
    const r = await discoverTelegramBackups(cfg());
    expect(r.backups).toHaveLength(0);
  });
});

describe("discovery: expired or consumed update history", () => {
  it("empty getUpdates + nothing remembered: says so and offers the fallbacks, never claims history search", async () => {
    stubTelegram(forwardFrom({}));
    const r = await discoverTelegramBackups(cfg());
    expect(r.backups).toEqual([]);
    expect(r.telegramReachable).toBe(true);
    const notes = r.notes.join("\n");
    expect(notes).toMatch(/can't search old chat history/i);
    expect(notes).toMatch(/expires or consumes/i);
    expect(notes).toMatch(/message link or ID/i);
    expect(notes).toMatch(/saved backup file/i);
  });

  it("a webhook/another reader blocking getUpdates is a note, not a failure", async () => {
    rememberUpload(S1, [11]);
    stubTelegram((req, init) =>
      req.method === "getUpdates"
        ? fail(
            409,
            "Conflict: can't use getUpdates method while webhook is active",
          )
        : forwardFrom({ 11: manifestName(S1) })(req, init),
    );
    const r = await discoverTelegramBackups(cfg());
    expect(r.backups.map((b) => b.session)).toEqual([S1]);
    expect(r.notes.join(" ")).toMatch(/webhook/i);
  });

  it("when Telegram is entirely unreachable and nothing is remembered, it fails with a clear error", async () => {
    stubTelegram(() => fail(401, "Unauthorized"));
    await expect(discoverTelegramBackups(cfg())).rejects.toThrow(/token/i);
  });
});

describe("discovery: multiple bots", () => {
  it("finds a manifest only the second bot can see", async () => {
    rememberUpload(S1, [11]);
    stubTelegram((req, init) => {
      if (req.method === "forwardMessage" && req.token.startsWith("111111"))
        return GONE();
      return forwardFrom({ 11: manifestName(S1) })(req, init);
    });
    const r = await discoverTelegramBackups(cfg({ extraBotTokens: [BOT2] }));
    expect(r.backups.map((b) => b.status)).toEqual(["verified"]);
    expect(r.stale).toEqual([]);
  });

  it("a network error on one bot is not hidden by another bot's 'not found' — kept unverified, pointer retained", async () => {
    rememberUpload(S1, [11]);
    stubTelegram((req, init) => {
      if (req.method === "forwardMessage") {
        if (req.token.startsWith("111111"))
          return fail(400, "Bad Request: message to forward not found");
        return fail(429, "Too Many Requests", {
          parameters: { retry_after: 0.01 },
        });
      }
      return forwardFrom({})(req, init);
    });
    const r = await discoverTelegramBackups(cfg({ extraBotTokens: [BOT2] }));
    expect(r.stale).toEqual([]);
    expect(r.backups).toHaveLength(1);
    expect(r.backups[0]).toMatchObject({ status: "unverified" });
    expect(r.backups[0]!.warning).toMatch(/rate-limiting/i);
    expect(readLastUpload()?.session).toBe(S1); // not forgotten
  });
});

describe("discovery: bounded and cancellable", () => {
  it("a hanging Telegram connection ends at the deadline with unverified items, not an endless spinner", async () => {
    rememberUpload(S1, [11]);
    stubTelegram(() => new Promise<Response>(() => {})); // never answers
    const t0 = Date.now();
    const r = await discoverTelegramBackups(cfg(), { deadlineMs: 80 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.timedOut).toBe(true);
    expect(r.backups).toHaveLength(1);
    expect(r.backups[0]!.status).toBe("unverified");
    expect(r.notes.join(" ")).toMatch(/time limit/i);
  });

  it("the person's Cancel rejects with AbortError and stops further requests", async () => {
    rememberUpload(S1, [11]);
    const calls = stubTelegram(() => new Promise<Response>(() => {}));
    const ctl = new AbortController();
    const p = discoverTelegramBackups(cfg(), { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(n);
  });

  it("an already-cancelled signal never talks to Telegram", async () => {
    const calls = stubTelegram(forwardFrom({}));
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      discoverTelegramBackups(cfg(), { signal: ctl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("the compatibility wrapper returns plain recent-backup rows", async () => {
    rememberUpload(S1, [11]);
    stubTelegram(forwardFrom({ 11: manifestName(S1) }));
    const rows = await listRecentTelegramBackups(cfg());
    expect(rows).toEqual([
      {
        session: S1,
        manifestMessageId: 11,
        at: "2026-10-08T07:09:48.851Z",
      },
    ]);
  });
});

describe("discovery: parallel but bounded checking", () => {
  it("checks several backups at once (max 3 in flight), keeps newest-first order, and shows at most five", async () => {
    const sessions = Array.from(
      { length: 7 },
      (_, i) => `2026-10-0${i + 1}T07-09-48-851Z`,
    );
    sessions.forEach((s, i) => rememberUpload(s, [100 + i]));
    let inFlight = 0;
    let maxInFlight = 0;
    stubTelegram(async (req) => {
      if (req.method === "forwardMessage") {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        const id = req.body["message_id"] as number;
        return ok({
          message_id: 9000 + id,
          document: {
            file_id: `f${id}`,
            file_name: manifestName(sessions[id - 100]!),
          },
        });
      }
      return ok(
        req.method === "getChat" ? {} : req.method === "getUpdates" ? [] : true,
      );
    });
    const r = await discoverTelegramBackups(cfg());
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(r.backups).toHaveLength(5);
    expect(r.backups.map((b) => b.session)).toEqual(
      [...sessions].reverse().slice(0, 5),
    );
  });

  it("one slow backup does not hold up the others", async () => {
    rememberUpload(S1, [11]);
    rememberUpload(S2, [12]);
    rememberUpload(S3, [13]);
    stubTelegram((req) => {
      if (req.method === "forwardMessage") {
        const id = req.body["message_id"] as number;
        const names: Record<number, string> = {
          11: manifestName(S1),
          12: manifestName(S2),
          13: manifestName(S3),
        };
        // #11 never answers; the deadline turns it into "not checked".
        if (id === 11) return new Promise<Response>(() => {});
        return ok({
          message_id: 9000 + id,
          document: { file_id: `f${id}`, file_name: names[id] },
        });
      }
      return ok(
        req.method === "getChat" ? {} : req.method === "getUpdates" ? [] : true,
      );
    });
    const r = await discoverTelegramBackups(cfg(), { deadlineMs: 150 });
    const by = Object.fromEntries(r.backups.map((b) => [b.session, b.status]));
    expect(by[S2]).toBe("verified");
    expect(by[S3]).toBe("verified");
    expect(by[S1]).toBe("unverified");
    expect(r.timedOut).toBe(true);
  });
});

describe("temporary forwarded copies are removed, or tracked until they are", () => {
  it("deletes the forwarded copy right after reading a message (awaited), leaving nothing pending", async () => {
    rememberUpload(S1, [11]);
    const calls = stubTelegram(forwardFrom({ 11: manifestName(S1) }));
    const r = await discoverTelegramBackups(cfg());
    expect(r.backups).toHaveLength(1);
    const del = calls.filter((c) => c.method === "deleteMessage");
    expect(del.map((c) => c.body["message_id"])).toEqual([9011]);
    expect(r.leftoverCopies).toBe(0);
    expect(localStorage.getItem("ks:telegram-forward-cleanup")).toBeNull();
  });

  it("when Telegram refuses the delete, the copy is remembered, reported, and retried next time", async () => {
    rememberUpload(S1, [11]);
    let allowDelete = false;
    stubTelegram((req, init) =>
      req.method === "deleteMessage" && !allowDelete
        ? fail(400, "Bad Request: message can't be deleted")
        : forwardFrom({ 11: manifestName(S1) })(req, init),
    );
    const first = await discoverTelegramBackups(cfg());
    expect(first.backups).toHaveLength(1); // listing is not blocked
    expect(first.leftoverCopies).toBeGreaterThan(0);
    expect(first.notes.join(" ")).toMatch(/forwarded cop/i);
    expect(
      JSON.parse(localStorage.getItem("ks:telegram-forward-cleanup") ?? "[]")
        .length,
    ).toBeGreaterThan(0);
    allowDelete = true;
    const again = await discoverTelegramBackups(cfg());
    expect(again.leftoverCopies).toBe(0);
  });

  it("the pinned backup is confirmed from getChat without forwarding it", async () => {
    const calls = stubTelegram((req, init) =>
      req.method === "getChat"
        ? ok({
            pinned_message: {
              message_id: 33,
              document: { file_id: "p", file_name: manifestName(S1) },
            },
          })
        : forwardFrom({})(req, init),
    );
    const r = await discoverTelegramBackups(cfg());
    expect(r.backups).toMatchObject([
      { session: S1, manifestMessageId: 33, status: "verified" },
    ]);
    expect(calls.some((c) => c.method === "forwardMessage")).toBe(false);
  });
});

describe("restore selection errors are per-item and actionable", () => {
  it("a deleted message ID is a stale selection with a fallback hint", async () => {
    stubTelegram(forwardFrom({}));
    const e = await fetchShardedFullBackupByMessage(cfg(), "777").catch(
      (x) => x,
    );
    expect(isStaleSelectionError(e)).toBe(true);
    expect((e as Error).message).toMatch(/saved backup file|recent list/i);
  });

  it("a shard or text message is rejected as BackupSelectionError, not opened", async () => {
    stubTelegram(forwardFrom({ 5: shardName(S1), 6: null }));
    const shard = await fetchShardedFullBackupByMessage(cfg(), "5").catch(
      (x) => x,
    );
    expect(shard).toBeInstanceOf(BackupSelectionError);
    expect((shard as BackupSelectionError).code).toBe("shard-not-manifest");
    const text = await fetchShardedFullBackupByMessage(cfg(), "6").catch(
      (x) => x,
    );
    expect((text as BackupSelectionError).code).toBe("not-a-backup");
    expect((text as Error).message).toMatch(/message link/i);
  });

  it("accepts a copied Telegram message link", async () => {
    stubTelegram(forwardFrom({}));
    const e = await fetchShardedFullBackupByMessage(
      cfg(),
      "https://t.me/c/123/777",
    ).catch((x) => x);
    expect(isStaleSelectionError(e)).toBe(true); // parsed 777, then not found
  });
});

describe("upload: a lost response never causes a silent duplicate send", () => {
  it("does not retry a state-changing sendDocument at the network layer; reconciles first", async () => {
    let sends = 0;
    let sentName = "";
    stubTelegram((req, init) => {
      if (req.method === "sendDocument") {
        sends++;
        sentName = String(
          ((init.body as FormData).get("document") as File).name,
        );
        // Telegram accepted it, but the response was lost.
        return Promise.reject(new TypeError("network lost"));
      }
      if (req.method === "getUpdates")
        return ok([
          {
            update_id: 1,
            message: {
              message_id: 77,
              chat: { id: -100123 },
              document: { file_id: "recovered", file_name: sentName },
            },
          },
        ]);
      return ok(true);
    });
    const res = await uploadFullBackup(cfg(), new Uint8Array(500), {
      session: S1,
    });
    expect(sends).toBe(1); // exactly one send — no duplicate part
    expect(res.messageIds).toEqual([77]);
  });

  it("resends only when the part is not found, and then exactly once more", async () => {
    vi.useFakeTimers();
    let sends = 0;
    stubTelegram((req) => {
      if (req.method === "sendDocument") {
        sends++;
        if (sends === 1) return Promise.reject(new TypeError("network lost"));
        return ok({ message_id: 55, document: { file_id: "f" } });
      }
      if (req.method === "getUpdates") return ok([]);
      return ok(true);
    });
    const p = uploadFullBackup(cfg(), new Uint8Array(500), { session: S1 });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(sends).toBe(2);
    expect(res.messageIds).toEqual([55]);
  });
});

describe("restore safety: nothing changes before the backup is proven good", () => {
  const rowCount = () => db.expenses.count();
  const seed = async (no: string) => {
    const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, no.length]);
    const path = `Receipts/2026-01-05/${no}.jpg`;
    await db.receipt_hashes.put({
      path,
      sha256: await sha256Hex(bytes),
      created_at: nowIso(),
    });
    await db.receipts.put({
      path,
      blob: new Blob([bytes]),
      created_at: nowIso(),
    });
    await db.expenses.add({
      id: newId(),
      expense_no: no,
      business: "Turf",
      category: "Other",
      description: "d",
      note: null,
      amount: 1,
      spent_at: "2026-01-05",
      receipt_path: path,
      created_at: nowIso(),
    } as never);
  };
  beforeEach(async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
  });

  it("a wrong passphrase while opening a shard leaves live data untouched (Replace)", async () => {
    await seed("A");
    const { top } = await buildShardedFullBackup("Test");
    await seed("LIVE");
    const before = await rowCount();
    await expect(
      restoreFullBackupSharded(
        {
          fetch: async () => {
            throw new WrongPassphraseError();
          },
        },
        "replace",
        top,
      ),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await rowCount()).toBe(before);
    expect(await db.expenses.where("expense_no").equals("LIVE").count()).toBe(
      1,
    );
  });

  it("a cancel before data is written leaves live data untouched", async () => {
    await seed("A");
    const { top, shardBytes } = await buildShardedFullBackup("Test");
    await seed("LIVE");
    const before = await rowCount();
    const ctl = new AbortController();
    await expect(
      restoreFullBackupSharded(
        {
          fetch: async (i) => {
            ctl.abort();
            return shardBytes[i] ?? null;
          },
        },
        "replace",
        top,
        { signal: ctl.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await rowCount()).toBe(before);
  });

  it("an incomplete shard set (missing shard) restores nothing", async () => {
    await seed("A");
    await seed("B");
    const { top, shardBytes } = await buildShardedFullBackup("Test");
    await seed("LIVE");
    const before = await rowCount();
    await expect(
      restoreFullBackupSharded(
        { fetch: async (i) => (i === 0 ? null : (shardBytes[i] ?? null)) },
        "replace",
        top,
      ),
    ).rejects.toThrow();
    expect(await rowCount()).toBe(before);
  });

  it("a shard whose checksum disagrees with the manifest restores nothing", async () => {
    await seed("A");
    const { top, shardBytes } = await buildShardedFullBackup("Test");
    await seed("LIVE");
    const before = await rowCount();
    const bad = new Uint8Array(shardBytes[0]!);
    bad[bad.length - 1] = (bad[bad.length - 1]! + 1) & 0xff;
    await expect(
      restoreFullBackupSharded({ fetch: async () => bad }, "replace", top),
    ).rejects.toThrow();
    expect(await rowCount()).toBe(before);
  });

  it("a write failure mid-restore rolls the database back to the pre-restore state", async () => {
    await seed("A");
    const { top, shardBytes } = await buildShardedFullBackup("Test");
    // Photo A is absent locally, so restore must write it (and we make that fail).
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await seed("LIVE");
    const before = await rowCount();
    const spy = vi
      .spyOn(db.receipts, "put")
      .mockRejectedValue(new Error("disk full"));
    try {
      await expect(
        restoreFullBackupSharded(shardBytes, "replace", top),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await rowCount()).toBe(before);
    expect(await db.expenses.where("expense_no").equals("LIVE").count()).toBe(
      1,
    );
  });
});
