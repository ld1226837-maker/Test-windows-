/**
 * R5: bulk import of existing receipt photos.
 *
 * - Concurrency-bounded (default 3) worker pool - never Promise.all over
 *   all photos (rule 2).
 * - Resumable after a rate limit or app kill: progress persists in
 *   localStorage under `bulk-import-cursor` and completed items are
 *   skipped on the next run.
 * - Deduped by SHA-256 against both the incoming batch and every hash
 *   already recorded in `receipt_hashes`.
 * - Non-images are skipped and reported, never imported.
 */
import { db } from "./localdb";
import {
  isLikelyImageFile,
  compressReceiptImage,
  sniffImageMimeType,
} from "./image";
import { sha256Hex } from "./receipts-share";
import { uploadReceipt } from "./expenses";
import { errorMessage } from "@/lib/utils";

export type BulkImportProgress = {
  done: number;
  total: number;
  imported: number;
  duplicates: number;
  skipped: string[];
};

const CURSOR_KEY = "bulk-import-cursor";

type CursorItem = {
  name: string;
  size: number;
  lastModified?: number;
  status: "done" | "skipped" | "duplicate";
};

// Node/test environments have no localStorage: keep the cursor in memory
// so resumability still works; browsers persist it across app kills.
let memCursor: string | null = null;
const readRaw = (): string | null => {
  if (typeof localStorage !== "undefined")
    try {
      return localStorage.getItem(CURSOR_KEY);
    } catch {
      /* fall through */
    }
  return memCursor;
};
const writeRaw = (v: string) => {
  memCursor = v;
  if (typeof localStorage !== "undefined")
    try {
      localStorage.setItem(CURSOR_KEY, v);
    } catch {
      /* best-effort */
    }
};

export function readBulkImportCursor(): CursorItem[] {
  try {
    return JSON.parse(readRaw() ?? "[]") as CursorItem[];
  } catch {
    return [];
  }
}

export function clearBulkImportCursor(): void {
  memCursor = null;
  if (typeof localStorage !== "undefined")
    try {
      localStorage.removeItem(CURSOR_KEY);
    } catch {
      /* non-DOM env */
    }
}

export async function bulkImportPhotos(
  files: File[],
  opts: {
    expenseDate?: string;
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (p: BulkImportProgress) => void;
    onWarning?: (warning?: string) => void;
  } = {},
): Promise<BulkImportProgress> {
  const { expenseDate, concurrency = 3, signal, onProgress, onWarning } = opts;
  const cursor = readBulkImportCursor();
  const byKey = new Map(
    cursor.map((c) => [`${c.name}:${c.size}:${c.lastModified ?? 0}`, c]),
  );
  const knownHashes = new Set(
    (await db.receipt_hashes.toArray()).map((h) => h.sha256),
  );

  const progress: BulkImportProgress = {
    done: 0,
    total: files.length,
    imported: 0,
    duplicates: 0,
    skipped: [],
  };

  let idx = 0;
  // The check-and-add on knownHashes must be atomic across workers, or
  // concurrent imports of identical photos both pass the dedupe check
  // (found by test: two identical files in one batch imported twice).
  // The gate serializes only the check/add; hashing stays parallel.
  let hashGate: Promise<void> = Promise.resolve();
  const claimHash = (sha256: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      hashGate = hashGate.then(() => {
        const dup = knownHashes.has(sha256);
        if (!dup) knownHashes.add(sha256);
        resolve(dup);
      });
    });
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = idx++;
      if (i >= files.length) return;
      const file = files[i]!;
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      const seen = byKey.get(key);
      if (seen) {
        // Resumable: already settled in a previous (killed) run - count it
        // as done only; imported/duplicates/skipped report THIS run.
        progress.done++;
        onProgress?.(progress);
        continue;
      }
      if (!(await isLikelyImageFile(file))) {
        progress.skipped.push(file.name);
        byKey.set(key, {
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          status: "skipped",
        });
      } else {
        // Re-encode every supported image format so camera metadata is not
        // carried into stored receipts. HEIC is accepted only when the host
        // can decode/re-encode it; otherwise uploadReceipt rejects it rather
        // than preserving unsanitized EXIF/GPS metadata.
        const prepared =
          typeof FileReader === "undefined" || typeof Image === "undefined"
            ? file
            : await compressReceiptImage(file);
        const bytes = new Uint8Array(await prepared.arrayBuffer());
        const sha256 = await sha256Hex(bytes);
        if (await claimHash(sha256)) {
          progress.duplicates++;
          byKey.set(key, {
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            status: "duplicate",
          });
        } else {
          try {
            await uploadReceipt(prepared, expenseDate, onWarning, true);
            progress.imported++;
            byKey.set(key, {
              name: file.name,
              size: file.size,
              lastModified: file.lastModified,
              status: "done",
            });
          } catch (e) {
            // A failed upload must not reserve the hash permanently.
            knownHashes.delete(sha256);
            progress.skipped.push(`${file.name} (failed: ${errorMessage(e)})`);
            // Not recorded in the cursor, so a re-run retries it.
          }
        }
      }
      progress.done++;
      writeRaw(JSON.stringify([...byKey.values()]));
      onProgress?.(progress);
      await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );
  return progress;
}
