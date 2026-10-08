import { beforeEach, describe, expect, it, vi } from "vitest";

let saved = "";
vi.mock("../backup-passphrase", () => ({
  readBackupPassphrase: async () => saved,
  writeBackupPassphrase: async (v: string) => {
    saved = v;
  },
  hasBackupPassphrase: async () => saved.length > 0,
}));
import { encryptBackup, NoPassphraseSetError, WrongPassphraseError } from "../backup-crypto";
import {
  fetchLatestShardedFullBackup,
  type FullBackupTopManifest,
  type TelegramConfig,
} from "../telegram-backup";

const cfg: TelegramConfig = {
  botToken: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  chatId: "-1004274097069",
  extraBotTokens: [],
  deviceLabel: "Android",
};

const top: FullBackupTopManifest = {
  format: "turf-snack-ledger-full-manifest",
  version: 2,
  created_at: "2026-10-08T07:09:48.851Z",
  device_label: "Android",
  shardCount: 1,
  shards: [{ index: 1, sha256: "x", photoCount: 0 }],
  files: [],
  telegram: { shardMessageIds: [5], shardBotIndexes: [0], shardFileIds: ["fid"] },
};

function mockTelegram(encryptedManifest: Uint8Array) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const json = (r: unknown) =>
        new Response(JSON.stringify({ ok: true, result: r }), { status: 200 });
      if (url.endsWith("/getChat"))
        return json({
          pinned_message: {
            message_id: 9,
            document: {
              file_id: "man",
              file_name:
                "turf-ledger-full-manifest-2026-10-08T07-09-48-851Z.json",
            },
          },
        });
      if (url.endsWith("/getFile")) return json({ file_path: "docs/m.bin" });
      if (url.includes("/file/bot"))
        return new Response(encryptedManifest as BodyInit, { status: 200 });
      // getUpdates is empty after a reinstall.
      return json([]);
    }),
  );
}

describe("restore from the pinned Telegram manifest after a reinstall", () => {
  beforeEach(() => {
    saved = "";
    vi.unstubAllGlobals();
  });

  it("asks for the passphrase instead of reporting 'no complete backup'", async () => {
    mockTelegram(
      await encryptBackup(new TextEncoder().encode(JSON.stringify(top)), "old-pass"),
    );
    await expect(fetchLatestShardedFullBackup(cfg)).rejects.toBeInstanceOf(
      NoPassphraseSetError,
    );
  });

  it("reports a wrong saved passphrase as such", async () => {
    mockTelegram(
      await encryptBackup(new TextEncoder().encode(JSON.stringify(top)), "old-pass"),
    );
    saved = "different";
    await expect(fetchLatestShardedFullBackup(cfg)).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it("opens the pinned backup with a typed passphrase", async () => {
    mockTelegram(
      await encryptBackup(new TextEncoder().encode(JSON.stringify(top)), "old-pass"),
    );
    const found = await fetchLatestShardedFullBackup(cfg, {
      passphrase: "old-pass",
    });
    expect(found.top.shardCount).toBe(1);
  });
});
