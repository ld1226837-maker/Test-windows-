import { memoryUsage } from "node:process";
import { describe, it } from "vitest";
import { writeStoreZip, type ZipEntry } from "./stream-zip";
import { createChunkedEncryptor } from "./backup-crypto";
import { realisticReceiptJpeg, mulberry32 } from "./receipt-scale-gen";

/**
 * R7 at FULL SCALE: 30,000 realistic receipt photos (~3.75 GB) streamed
 * through the production backup pipeline (STORE-zip -> chunked AEAD ->
 * sink) with a discarding sink. Nothing is stored; the photos are
 * regenerated deterministically per iteration. If peak memory stayed
 * bounded at 1k and 3k, this proves the bound holds at the goal's scale.
 */
describe("R7 30k streaming backup (bounded-memory proof)", () => {
  it("30000 photos stream through zip+encrypt under the memory budget", async () => {
    const heap = () => {
      const m = memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    const rng = mulberry32(42);
    const CHUNK = 1024 * 1024;
    let totalPlain = 0;
    async function* photos(): AsyncIterable<ZipEntry> {
      for (let i = 0; i < 30000; i++) {
        const { bytes } = realisticReceiptJpeg(rng, i);
        totalPlain += bytes.length;
        yield {
          name: `photos/2026-${String((i % 12) + 1).padStart(2, "0")}/r-${i}.jpg`,
          bytes,
        };
      }
    }
    const baseline = heap();
    let peak = baseline;
    const discarding = {
      async write(_b: Uint8Array) {
        const h = heap();
        if (h > peak) peak = h;
      },
    };
    const enc = await createChunkedEncryptor(
      "scale-passphrase",
      discarding,
      CHUNK,
    );
    const t0 = Date.now();
    await writeStoreZip(photos(), { write: (b) => enc.write(b) });
    await enc.finish();
    const ms = Date.now() - t0;
    const mb = (n: number) => (n / 1048576).toFixed(1);
    console.log(
      `R7-30k: ${(totalPlain / 1048576) | 0} MB plaintext in ${mb(totalPlain)} ` +
        `(${ms} ms), peak heap delta ${mb(peak - baseline)} MB`,
    );
    // The goal is retained JS/ArrayBuffer memory, not process RSS. RSS is
    // intentionally not used because allocator fragmentation and crypto
    // native arenas can remain resident after objects are released.
    if (peak - baseline >= 150 * 1024 * 1024)
      throw new Error(`peak ${mb(peak - baseline)} MB exceeds the 150 MB goal`);
    console.log(`R7-30k PASS: peak ${mb(peak - baseline)} MB < 150 MB goal`);
  }, 300000);
});
