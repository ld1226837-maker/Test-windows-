import "fake-indexeddb/auto";
import { memoryUsage } from "node:process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock ONLY the Tauri fs boundary (same boundary saveToAppDocuments uses
// on device). Everything above it - serializer, chunked AEAD, sink loop -
// runs for real, end to end.
// Chunks go to a real temp file so the mock destination does not count as heap.
const tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ds-"));
const fsFiles = new Map<string, string>();
const realPath = (key: string) => {
  if (!fsFiles.has(key))
    fsFiles.set(key, nodePath.join(tmpDir, String(fsFiles.size)));
  return fsFiles.get(key)!;
};
let peakDelta = 0;
let baseline = 0;
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: async () => {},
  exists: async () => false,
  remove: async () => {},
  rename: async (from: string, to: string) => {
    const src = fsFiles.get(String(from));
    if (src) {
      fsFiles.set(String(to), src);
      fsFiles.delete(String(from));
    }
  },
  BaseDirectory: { Document: 1, AppLocalData: 2 },
  writeFile: async (
    path: string,
    data: Uint8Array,
    opts?: { append?: boolean },
  ) => {
    if (baseline === 0)
      baseline = (() => {
        const m = memoryUsage();
        return m.heapUsed + m.arrayBuffers;
      })();
    const h =
      (() => {
        const m = memoryUsage();
        return m.heapUsed + m.arrayBuffers;
      })() - baseline;
    if (h > peakDelta) peakDelta = h;
    const key = String(path);
    if (opts?.append) nodeFs.appendFileSync(realPath(key), data);
    else {
      fsFiles.delete(key);
      nodeFs.writeFileSync(realPath(key), data);
    }
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  dirname: async (p: string) => p,
  documentDir: async () => "/mock/Documents",
  appLocalDataDir: async () => "/mock",
}));

import {
  buildBackup,
  streamBackupToDisk,
  parseBackup,
  decodeBackupBytes,
} from "./backup";
import { decryptChunkedBytes } from "./backup-crypto";
import { db, newId, nowIso } from "./localdb";
import { realisticReceiptJpeg, mulberry32 } from "./receipt-scale-gen";
import { sha256Hex } from "./receipts-share";

describe("streamBackupToDisk (R7 desktop export branch)", () => {
  beforeEach(async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
    fsFiles.clear();
    peakDelta = 0;
    baseline = 0;
  });

  it("streams an encrypted v3 backup to disk that decrypts and parses back", async () => {
    const rng = mulberry32(17);
    for (let i = 0; i < 1200; i++) {
      const { bytes } = realisticReceiptJpeg(rng, i);
      const path = `Receipts/2026-09/d${i}.jpg`;
      await db.receipts.put({
        path,
        blob: new Blob([bytes.slice().buffer as ArrayBuffer]),
        created_at: nowIso(),
      });
      await db.receipt_hashes.put({
        path,
        sha256: await sha256Hex(bytes),
        created_at: nowIso(),
      });
      await db.expenses.put({
        id: newId(),
        expense_no: `DS-${i}`,
        business: "Turf",
        category: "Other",
        description: "download stream",
        note: null,
        amount: 1,
        spent_at: "2026-09-15",
        receipt_path: path,
        created_at: nowIso(),
      } as never);
    }
    const backup = await buildBackup();
    const outPath = await streamBackupToDisk(backup, "scale.db", "pw");
    expect(outPath).toBe("Exports/scale.db");
    const onDisk = fsFiles.get("TurfApp/Exports/scale.db")!;
    expect(onDisk).toBeDefined();
    const total = nodeFs.statSync(onDisk).size;
    const mb = (n: number) => (n / 1048576).toFixed(1);
    console.log(
      `download-stream: ${mb(total)} MB encrypted container on disk, peak heap delta ${mb(peakDelta)} MB`,
    );
    expect(total).toBeGreaterThan(1200 * 100 * 1024);
    expect(peakDelta).toBeLessThan(60 * 1024 * 1024);
    // The on-disk file must be a valid chunked container: decrypt ->
    // decode -> parse, with the full manifest intact.
    const container = new Uint8Array(nodeFs.readFileSync(onDisk));
    const plain = await decryptChunkedBytes(container, "pw");
    const parsed = parseBackup(await decodeBackupBytes(plain));
    expect(parsed.version).toBe(5);
    expect(parsed.photo_manifest).toHaveLength(1200);
  }, 120000);
});
