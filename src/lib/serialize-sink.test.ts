import "fake-indexeddb/auto";
import { memoryUsage } from "node:process";
import { describe, expect, it, beforeEach } from "vitest";
import { buildBackup, serializeBackupToSink } from "./backup";
import { db, newId, nowIso } from "./localdb";
import { realisticReceiptJpeg, mulberry32 } from "./receipt-scale-gen";
import { sha256Hex } from "./receipts-share";

const heap = () => {
  const m = memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

describe("serializeBackupToSink (R7 production serializer)", () => {
  beforeEach(async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
  });

  it("streams a 1500-photo v3 backup with flat memory above the seeded baseline", async () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 1500; i++) {
      const { bytes } = realisticReceiptJpeg(rng, i);
      const path = `Receipts/2026-09/s${i}.jpg`;
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
        expense_no: `SER-${i}`,
        business: "Turf",
        category: "Other",
        description: "serializer",
        note: null,
        amount: 1,
        spent_at: "2026-09-15",
        receipt_path: path,
        created_at: nowIso(),
      } as never);
    }
    const backup = await buildBackup();
    // Seeded DB bytes stay resident (that's storage, not the serializer).
    const baseline = heap();
    let peak = baseline;
    const discarding = {
      async write(_b: Uint8Array) {
        const h = heap();
        if (h > peak) peak = h;
      },
    };
    const total = await serializeBackupToSink(backup, discarding);
    const mb = (n: number) => (n / 1048576).toFixed(1);
    console.log(
      `serialize-v3: ${mb(total)} MB container from 1500 photos, ` +
        `peak heap delta ${mb(peak - baseline)} MB`,
    );
    // The serializer itself must add well under one photo's worth of
    // live heap - the photo stream passes through.
    expect(peak - baseline).toBeLessThan(50 * 1024 * 1024);
  }, 120000);

  it("produces a container decodeBackupBytes/restoreBackup accepts", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    await db.receipts.put({
      path: "Receipts/2026-09/x.jpg",
      blob: new Blob([bytes]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path: "Receipts/2026-09/x.jpg",
      sha256: await sha256Hex(bytes),
      created_at: nowIso(),
    });
    await db.expenses.put({
      id: newId(),
      expense_no: "SER-X",
      business: "Turf",
      category: "Other",
      description: "serializer",
      note: null,
      amount: 1,
      spent_at: "2026-09-15",
      receipt_path: "Receipts/2026-09/x.jpg",
      created_at: nowIso(),
    } as never);
    const backup = await buildBackup();
    const { memoryZipSink } = await import("./stream-zip");
    const sink = memoryZipSink();
    await serializeBackupToSink(backup, sink);
    const { decodeBackupBytes, parseBackup } = await import("./backup");
    const restored = parseBackup(await decodeBackupBytes(sink.bytes()));
    expect(restored.version).toBe(5);
    expect(restored.photo_manifest).toHaveLength(1);
  });
});
