// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the native app-documents folder.
const files = new Map<string, Uint8Array>();
let failWriteFor: string | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
}));

vi.mock("./desktop", async (orig) => ({
  ...(await orig<typeof import("./desktop")>()),
  isDesktop: () => true,
  isAndroid: () => false,
  appDocumentExists: async (p: string) => files.has(p),
  readAppDocument: async (p: string) => files.get(p)!,
  removeAppDocument: async (p: string) => {
    files.delete(p);
  },
  saveToAppDocuments: async (p: string, b: Uint8Array) => {
    if (failWriteFor === p) throw new Error("disk full");
    files.set(p, b);
    return p;
  },
  moveAppDocument: async (from: string, to: string) => {
    // Production restore stages photos under a temp UUID name and promotes
    // via moveAppDocument — a disk-full must surface here as well as on the
    // initial save, or the restore would resolve despite the failed write.
    if (failWriteFor === to) throw new Error("disk full");
    const bytes = files.get(from);
    if (!bytes) throw new Error(`missing ${from}`);
    files.set(to, bytes);
    files.delete(from);
  },
}));

import { db, nowIso } from "./localdb";
import { clearAllData } from "./devdata";
import { migrateReceiptBlobsToDisk } from "./receipt-storage";
import { restoreBackup, type BackupFile } from "./backup";
import { sha256Hex } from "./receipts-share";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

describe("receipt files on disk (native shell)", () => {
  beforeEach(async () => {
    files.clear();
    failWriteFor = null;
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
  });

  it("Clear All Data removes the receipt files too", async () => {
    files.set("Receipts/d/a.jpg", new Uint8Array([1]));
    await db.receipts.put({
      path: "Receipts/d/a.jpg",
      size: 1,
      created_at: nowIso(),
    });
    await clearAllData();
    expect(files.size).toBe(0);
    expect(await db.receipts.count()).toBe(0);
  });

  it("migration never deletes an existing disk file on a hash mismatch", async () => {
    const path = "Receipts/d/m.jpg";
    const good = new Uint8Array([9, 9, 9]);
    files.set(path, new Uint8Array([0, 0, 0])); // different bytes already on disk
    await db.receipts.put({
      path,
      blob: new Blob([good.buffer as ArrayBuffer]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path,
      sha256: await sha256Hex(good),
      created_at: nowIso(),
    });
    const r = await migrateReceiptBlobsToDisk();
    expect(r.kept).toContain(path);
    expect(files.has(path)).toBe(true); // not overwritten, not deleted
    expect((await db.receipts.get(path))?.blob).toBeDefined(); // blob kept
  });

  it("a failed restore leaves the database and pre-existing files untouched", async () => {
    const keepPath = "Receipts/d/keep.jpg";
    files.set(keepPath, new Uint8Array([7, 7]));
    await db.receipts.put({ path: keepPath, size: 2, created_at: nowIso() });
    const p1 = new Uint8Array([1, 1]);
    const p2 = new Uint8Array([2, 2]);
    failWriteFor = "Receipts/d/p2.jpg";
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 2,
      exported_at: nowIso(),
      tables: {},
      photos: [
        { path: "Receipts/d/p1.jpg", data: b64(p1), created_at: nowIso() },
        { path: "Receipts/d/p2.jpg", data: b64(p2), created_at: nowIso() },
      ],
    };
    await expect(restoreBackup(backup, "replace")).rejects.toThrow("disk full");
    expect(files.has("Receipts/d/p1.jpg")).toBe(false); // created by the failed restore: rolled back
    expect(files.has(keepPath)).toBe(true); // pre-existing: untouched
    expect(await db.receipts.get(keepPath)).toBeDefined(); // DB never cleared
  });

  it("replace restore removes files of old receipts the backup does not contain", async () => {
    files.set("Receipts/d/old.jpg", new Uint8Array([5]));
    await db.receipts.put({
      path: "Receipts/d/old.jpg",
      size: 1,
      created_at: nowIso(),
    });
    const p1 = new Uint8Array([1, 1]);
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 2,
      exported_at: nowIso(),
      tables: {},
      photos: [
        { path: "Receipts/d/new.jpg", data: b64(p1), created_at: nowIso() },
      ],
    };
    await restoreBackup(backup, "replace");
    expect(files.has("Receipts/d/old.jpg")).toBe(false);
    expect(files.has("Receipts/d/new.jpg")).toBe(true);
  });
});
