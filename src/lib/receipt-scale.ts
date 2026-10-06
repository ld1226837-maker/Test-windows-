/**
 * R1/R7: receipt scale harness. Seeds N realistic expenses+photos, then
 * times seeding, .db backup, full backup, and restore, sampling peak JS
 * heap between phases.
 *
 * Streams everywhere - no `toArray()` over receipts, no `Promise.all` over
 * photos (rule 2): one photo's bytes are live at a time.
 */
import { db, newId, nowIso } from "./localdb";
import {
  buildBackup,
  restoreBackup,
  serializeBackupBytes,
  decodeBackupBytes,
} from "./backup";
import {
  buildShardedFullBackup,
  restoreFullBackupSharded,
  type FullBackupTopManifest,
} from "./telegram-backup";
import { migrateReceiptBlobsToDisk } from "./receipt-storage";
import { realisticReceiptJpeg, mulberry32 } from "./receipt-scale-gen";
import { sha256Hex } from "./receipts-share";
import {
  isDesktop,
  saveToAppDocuments,
  readAppDocument,
  removeAppDocument,
} from "./desktop";

export type HeapProbe = () => number; // aggregate JS/ArrayBuffer/RSS bytes when available
export const defaultHeapProbe: HeapProbe = () => {
  try {
    const p = globalThis as typeof globalThis & {
      process?: {
        memoryUsage?: () => {
          heapUsed: number;
          external: number;
          arrayBuffers: number;
          rss: number;
        };
      };
    };
    const m = p.process?.memoryUsage?.();
    if (m) return m.heapUsed + m.arrayBuffers;
  } catch {
    /* best-effort: failure here is non-fatal */
  }
  const perf =
    typeof performance !== "undefined"
      ? (performance as unknown as { memory?: { usedJSHeapSize: number } })
          .memory
      : undefined;
  return perf?.usedJSHeapSize ?? 0;
};

export type ScalePhaseName =
  | "seed"
  | "migrate"
  | "db-backup"
  | "full-backup"
  | "db-restore"
  | "full-restore";

export type ScalePhase = {
  phase: ScalePhaseName;
  ms: number;
  peakBytes: number;
};
export type ScaleResult = { n: number; phases: ScalePhase[] };

export async function runReceiptScaleTest(
  n: number,
  probe: HeapProbe = defaultHeapProbe,
  onProgress?: (done: number, total: number) => void,
): Promise<ScaleResult> {
  const phases: ScalePhase[] = [];
  let peak = 0;

  const timed = async <T>(
    phase: ScalePhaseName,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const t0 = performance.now();
    peak = Math.max(peak, probe());
    const out = await fn();
    peak = Math.max(peak, probe());
    phases.push({
      phase,
      ms: Math.round(performance.now() - t0),
      peakBytes: peak,
    });
    return out;
  };

  // Seed: one expense+photo at a time, dates spread over 24 months so
  // month sharding (R3) is exercised.
  await timed("seed", async () => {
    const rng = mulberry32(42);
    const base = Date.UTC(2026, 8, 1);
    for (let i = 0; i < n; i++) {
      const { bytes } = realisticReceiptJpeg(rng, i);
      const spent = new Date(base - Math.floor(rng() * 730) * 86400000)
        .toISOString()
        .slice(0, 10);
      const path = `Receipts/${spent}/scale-${i}.jpg`;
      const sha256 = await sha256Hex(bytes);
      const created = nowIso();
      await db.receipt_hashes.put({ path, sha256, created_at: created });
      if (isDesktop()) {
        await saveToAppDocuments(path, bytes);
        await db.receipts.put({
          path,
          size: bytes.length,
          created_at: created,
        });
      } else {
        await db.receipts.put({
          path,
          blob: new Blob([bytes.buffer as ArrayBuffer], {
            type: "image/jpeg",
          }),
          created_at: created,
        });
      }
      await db.expenses.add({
        id: newId(),
        expense_no: `SC-${i}`,
        business: "ScaleTest",
        category: "Other",
        description: `Scale receipt ${i}`,
        note: null,
        amount: 100,
        spent_at: spent,
        receipt_path: path,
        created_at: created,
      } as never);
      if (i % 100 === 0) {
        onProgress?.(i, n);
        peak = Math.max(peak, probe());
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    onProgress?.(n, n);
  });

  // R2 migration (no-op on web; still measured so the R7 table is complete).
  await timed("migrate", () => migrateReceiptBlobsToDisk());

  // The .db backup's real work = build the manifest AND serialize the
  // zip container (that's what downloadBackup ships).
  let container: Uint8Array = new Uint8Array();
  await timed("db-backup", async () => {
    const backup = await buildBackup();
    container = await serializeBackupBytes(backup);
  });

  // Restores are measured against a WIPED database (merge mode would skip
  // every already-stored photo and measure nothing). The wipe is untimed.
  const wipe = async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
  };
  await wipe();
  await timed("db-restore", async () => {
    const restored = await decodeBackupBytes(container);
    await restoreBackup(JSON.parse(restored) as never, "replace");
  });

  // R7/R11: measure the R3 sharded full backup without collecting every
  // shard in JS memory. Each finalized shard is persisted to AppDocuments
  // and the restore reads one shard at a time through ShardSource. This
  // keeps the destination off-heap for the entire 30k-scale run.
  const scaleShardPrefix = `LoadTests/receipt-scale-${Date.now()}`;
  const persistedShards: Uint8Array[] = [];
  const full = await timed("full-backup", () =>
    buildShardedFullBackup("ScaleTest", {
      collectShards: false,
      onShardBuilt: async (bytes, index) => {
        if (isDesktop())
          await saveToAppDocuments(`${scaleShardPrefix}-${index}.bin`, bytes);
        else persistedShards[index - 1] = bytes;
      },
      ...(onProgress
        ? { onShard: (done: number, total: number) => onProgress(done, total) }
        : {}),
    }),
  );
  await wipe();
  await timed("full-restore", () =>
    restoreFullBackupSharded(
      {
        fetch: async (index) => {
          if (index >= full.top.shardCount) return null;
          try {
            return isDesktop()
              ? await readAppDocument(`${scaleShardPrefix}-${index + 1}.bin`)
              : (persistedShards[index] ?? null);
          } catch {
            return null;
          }
        },
      },
      "replace",
      full.top,
    ),
  );
  if (isDesktop())
    for (let i = 1; i <= full.top.shardCount; i++)
      await removeAppDocument(`${scaleShardPrefix}-${i}.bin`);

  return { n, phases };
}

/** Wipes what the scale test created (paths contain "/scale-", expenses "SC-"). */
export async function clearReceiptScaleData(): Promise<number> {
  let removed = 0;
  const paths: string[] = [];
  await db.receipts.each((r) => {
    if (r.path.includes("/scale-")) paths.push(r.path);
  });
  if (paths.length) {
    await db.receipts.bulkDelete(paths);
    await db.receipt_hashes.bulkDelete(paths);
    removed += paths.length;
  }
  const ids: string[] = [];
  await db.expenses.each((e) => {
    if ((e.expense_no ?? "").startsWith("SC-")) ids.push(e.id);
  });
  if (ids.length) await db.expenses.bulkDelete(ids);
  removed += ids.length;
  return removed;
}
