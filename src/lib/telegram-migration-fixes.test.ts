// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import JSZip from "jszip";
import { sha256Hex } from "./receipts-share";
import { db, DATA_TABLES, newId, nowIso } from "./localdb";
import {
  buildFullBackup,
  restoreFullBackup,
  restoreFullBackupSharded,
  FULL_BACKUP_FORMAT,
  MANIFEST_NAME,
} from "./telegram-backup";

const shardBytes = async (shard: number, shardCount: number) => {
  const tables: Record<string, unknown[]> =
    shard === 1
      ? {
          ...Object.fromEntries(DATA_TABLES.map((t) => [t, []])),
          receipts: [],
          receipt_hashes: [],
        }
      : (null as never);
  const manifest = {
    format: FULL_BACKUP_FORMAT,
    version: 2,
    shard,
    shardCount,
    created_at: nowIso(),
    device_label: "test",
    files: [],
    tables: shard === 1 ? tables : null,
  };
  const zip = new JSZip();
  zip.file(MANIFEST_NAME, JSON.stringify(manifest));
  return zip.generateAsync({ type: "uint8array" });
};

describe("telegram sharded restore (audit fixes T6)", () => {
  beforeEach(async () => {
    for (const t of DATA_TABLES) await (db as any)[t].clear();
    await db.customers.put({
      id: newId(),
      name: "Keep me",
      phone: null,
      created_at: nowIso(),
    } as any);
  });

  it("T6: without a top manifest, a missing shard fails closed and restores nothing", async () => {
    const first = await shardBytes(1, 2);
    // Shard 2 is absent: the source reports the end of the set after shard 1.
    await expect(
      restoreFullBackupSharded(
        { fetch: async (i: number) => (i === 0 ? first : null) },
        "replace",
        null,
      ),
    ).rejects.toThrow(/incomplete/i);
    expect(await db.customers.count()).toBe(1);
  });

  it("T6: shards that disagree about the shard count are rejected", async () => {
    const [a, b] = [await shardBytes(1, 2), await shardBytes(2, 3)];
    await expect(
      restoreFullBackupSharded(
        { fetch: async (i: number) => [a, b][i] ?? null },
        "replace",
        null,
      ),
    ).rejects.toThrow(/inconsistent shard count/i);
    expect(await db.customers.count()).toBe(1);
  });

  it("T6: an extra shard beyond the declared count fails closed", async () => {
    const [a, b, extra] = [
      await shardBytes(1, 2),
      await shardBytes(2, 2),
      await shardBytes(3, 3),
    ];
    await expect(
      restoreFullBackupSharded(
        { fetch: async (i: number) => [a, b, extra][i] ?? null },
        "replace",
        null,
      ),
    ).rejects.toThrow(/extra shard/i);
    expect(await db.customers.count()).toBe(1);
  });

  it("T6: a complete 2-shard set without a top manifest still restores", async () => {
    const [a, b] = [await shardBytes(1, 2), await shardBytes(2, 2)];
    await restoreFullBackupSharded(
      { fetch: async (i: number) => [a, b][i] ?? null },
      "replace",
      null,
    );
    expect(await db.customers.count()).toBe(0); // replace of an empty backup
  });
});

describe("deep audit: partial and receipt-integrity restore guards", () => {
  it("marks a sharded backup partial when a bill-only receipt is missing", async () => {
    await db.bills.clear();
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.bills.put({
      id: "bill-photo-missing",
      bill_no: "INV-TEST-1",
      bill_date: "2026-09-04",
      customer_id: null,
      receipt_path: "Receipts/2026-09-04/missing-bill.jpg",
    } as never);
    const { buildShardedFullBackup } = await import("./telegram-backup");
    const built = await buildShardedFullBackup("test", { collectShards: true });
    expect(built.missingFiles).toContain(
      "Receipts/2026-09-04/missing-bill.jpg",
    );
    expect(built.top.partial).toBe(true);
    expect(built.top.warnings?.join(" ")).toMatch(/receipt photo/i);
    expect((built.top as any).partial).toBe(true);
  });

  it("rejects a partial full backup before clearing replace data", async () => {
    await db.customers.clear();
    await db.expenses.clear();
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.customers.put({
      id: "keep",
      name: "Keep",
      phone: null,
      created_at: new Date().toISOString(),
    } as never);
    const backup = {
      format: "turf-snack-ledger-full",
      version: 1,
      created_at: new Date().toISOString(),
      device_label: "test",
      partial: true,
      warnings: ["one receipt missing"],
      tables: { customers: [], expenses: [], receipts: [], receipt_hashes: [] },
      files: [],
    };
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(backup));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(restoreFullBackup(bytes, "replace")).rejects.toThrow(
      /marked partial/i,
    );
    expect(await db.customers.get("keep")).toBeDefined();
  });

  it("rejects a receipt hash that disagrees with the photo manifest", async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
    const bytes = new Uint8Array([1, 2, 3]);
    await db.receipts.put({
      path: "Receipts/2026-01-01/a.jpg",
      blob: new Blob([bytes]),
      size: 3,
      created_at: new Date().toISOString(),
    } as never);
    const good = await sha256Hex(bytes);
    await db.receipt_hashes.put({
      path: "Receipts/2026-01-01/a.jpg",
      sha256: good,
      created_at: new Date().toISOString(),
    });
    await db.expenses.put({
      id: "expense-hash-check",
      expense_no: "TX-HASH-CHECK",
      business: "Turf",
      category: "Other",
      amount: 1,
      spent_at: "2026-01-01",
      receipt_path: "Receipts/2026-01-01/a.jpg",
      created_at: new Date().toISOString(),
    } as never);
    const built = await buildFullBackup("test");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(built.bytes);
    const manifest = JSON.parse(
      await zip.files["manifest.json"]!.async("string"),
    );
    manifest.tables.receipt_hashes[0].sha256 = "0".repeat(64);
    zip.file("manifest.json", JSON.stringify(manifest));
    const tampered = await zip.generateAsync({ type: "uint8array" });
    // Under the partial contract a hash mismatch marks the backup partial;
    // in replace mode restore still rejects — with the partial marker rather
    // than the legacy mismatch wording. Both mean "this backup is unusable".
    await expect(restoreFullBackup(tampered, "replace")).rejects.toThrow(
      /does not match the photo manifest|marked partial/i,
    );
  });
});
