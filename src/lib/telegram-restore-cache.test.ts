import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the app-documents helpers the shard cache uses.
const files = new Map<string, Uint8Array>();
vi.mock("./desktop", async (orig) => ({
  ...(await orig<typeof import("./desktop")>()),
  appDocumentExists: async (p: string) => files.has(p),
  readAppDocument: async (p: string) => {
    const f = files.get(p);
    if (!f) throw new Error("missing");
    return f;
  },
  saveToAppDocuments: async (p: string, b: Uint8Array) => {
    files.set(p, b);
    return p;
  },
}));

import {
  telegramShardSource,
  type FullBackupTopManifest,
} from "./telegram-backup";
import { sha256Hex } from "./receipts-share";

const enc = (s: string) => new TextEncoder().encode(s);

describe("telegramShardSource() resumable cache", () => {
  let downloads: string[];
  const payloads: Record<string, Uint8Array> = {
    fid1: enc("shard-one"),
    fid2: enc("shard-two"),
  };

  beforeEach(() => {
    files.clear();
    downloads = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.includes("getFile")) {
          const id = JSON.parse(String(init?.body)).file_id as string;
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: `docs/${id}` } }),
          );
        }
        const id = url.split("/").pop()!;
        downloads.push(id);
        return new Response(payloads[id] as BodyInit);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const make = async () => {
    const top = {
      shards: [
        { index: 1, sha256: await sha256Hex(payloads["fid1"]!), photoCount: 0 },
        { index: 2, sha256: await sha256Hex(payloads["fid2"]!), photoCount: 0 },
      ],
    } as unknown as FullBackupTopManifest;
    return telegramShardSource({
      ordered: [
        { fileName: "a", fileId: "fid1" },
        { fileName: "b", fileId: "fid2" },
      ],
      token: "tok",
      session: "sess-1",
      top,
      passphrase: undefined,
      signal: undefined,
      onProgress: undefined,
    });
  };

  it("caches verified shards and skips them on the next attempt", async () => {
    const first = await make();
    expect(new TextDecoder().decode((await first.fetch(0))!)).toBe("shard-one");
    expect(new TextDecoder().decode((await first.fetch(1))!)).toBe("shard-two");
    expect(downloads.sort()).toEqual(["fid1", "fid2"]);
    expect(files.size).toBe(2);

    downloads.length = 0;
    const resumed = await make();
    expect(new TextDecoder().decode((await resumed.fetch(0))!)).toBe(
      "shard-one",
    );
    expect(downloads).toEqual([]);
  });

  it("re-downloads a cached shard whose bytes were damaged", async () => {
    const first = await make();
    await first.fetch(0);
    const [path, file] = [...files.entries()].find(([p]) => p.includes("/1-"))!;
    const bad = new Uint8Array(file);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    files.set(path, bad);

    downloads.length = 0;
    const again = await make();
    expect(new TextDecoder().decode((await again.fetch(0))!)).toBe("shard-one");
    expect(downloads).toContain("fid1");
  });

  it("returns null past the last shard", async () => {
    const src = await make();
    expect(await src.fetch(5)).toBeNull();
  });
});
