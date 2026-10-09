// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  validateRemotePointers,
  readLastUpload,
  type TelegramConfig,
} from "../telegram-backup";

const cfg = {
  botToken: "123:AAA",
  chatId: "42",
  extraBotTokens: [],
} as unknown as TelegramConfig;

describe("stale newest pointer", () => {
  beforeEach(() => {
    localStorage.clear();
    const newest = {
      session: "2026-10-08T07-09-48-851Z",
      total: 1,
      messageIds: [90],
      chatId: "42",
      at: "2026-10-08T07:09:48.851Z",
    };
    const older = {
      session: "2026-10-07T07-09-48-851Z",
      total: 1,
      messageIds: [80],
      chatId: "42",
      at: "2026-10-07T07:09:48.851Z",
    };
    localStorage.setItem("ks:telegram-backup-last", JSON.stringify(newest));
    localStorage.setItem(
      "ks:telegram-backup-history",
      JSON.stringify([newest, older]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: message to forward not found",
            }),
            { status: 400 },
          ),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("drops only the missing backup and keeps older saved ones", async () => {
    const ok = await validateRemotePointers(cfg);
    expect(ok).toBe(false);
    expect(readLastUpload()).toBeNull();
    const history = JSON.parse(
      localStorage.getItem("ks:telegram-backup-history") ?? "[]",
    );
    expect(history.map((h: { session: string }) => h.session)).toEqual([
      "2026-10-07T07-09-48-851Z",
    ]);
  });
});
