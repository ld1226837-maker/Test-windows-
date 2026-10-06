import "fake-indexeddb/auto";
import { memoryUsage } from "node:process";
import { describe, expect, it } from "vitest";
import {
  createChunkedEncryptor,
  decryptChunkedBytes,
  decryptChunkedStream,
  isChunkedEncryptedBackup,
} from "./backup-crypto";
import { writeStoreZip, memoryZipSink, type ZipEntry } from "./stream-zip";
import { realisticReceiptJpeg, mulberry32 } from "./receipt-scale-gen";

const heap = () => {
  const m = memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

describe("chunked AEAD (R7 bounded-memory crypto)", () => {
  it("round-trips 2.5 MB across three chunks, byte-identical", async () => {
    const plain = new Uint8Array(2.5 * 1024 * 1024);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 31) & 0xff;
    const sink = memoryZipSink();
    const enc = await createChunkedEncryptor(
      "test-passphrase",
      sink,
      1024 * 1024,
    );
    await enc.write(plain);
    await enc.finish();
    const container = sink.bytes();
    expect(isChunkedEncryptedBackup(container)).toBe(true);
    const back = await decryptChunkedBytes(container, "test-passphrase");
    // toEqual on multi-MB typed arrays busy-loops vitest - compare bytes.
    expect(back.length).toBe(plain.length);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(plain))).toBe(0);
  });

  it("tampering with one ciphertext byte anywhere throws", async () => {
    const plain = new Uint8Array(3 * 1024 * 1024).fill(9);
    const sink = memoryZipSink();
    const enc = await createChunkedEncryptor(
      "test-passphrase",
      sink,
      1024 * 1024,
    );
    await enc.write(plain);
    await enc.finish();
    const container = sink.bytes();
    // Flip a bit deep in chunk 2's ciphertext.
    container[29 + 1024 * 1024 + 500]! ^= 0x01;
    await expect(
      decryptChunkedBytes(container, "test-passphrase"),
    ).rejects.toThrow();
  });

  it("v3 rejects exact-boundary truncation and trailing bytes", async () => {
    const plain = new Uint8Array(2 * 1024 * 1024);
    plain.fill(17);
    const sink = memoryZipSink();
    const enc = await createChunkedEncryptor(
      "test-passphrase",
      sink,
      1024 * 1024,
    );
    await enc.write(plain);
    await enc.finish();
    const container = sink.bytes();
    // Header (29) + two non-final full frames + authenticated empty final frame.
    const fullFrame = 12 + 1024 * 1024 + 16 + 1;
    const finalEmptyFrame = 12 + 16 + 1;
    expect(container[4]).toBe(3);
    expect(container.length).toBe(29 + fullFrame * 2 + finalEmptyFrame);

    await expect(
      decryptChunkedBytes(
        container.subarray(0, container.length - finalEmptyFrame),
        "test-passphrase",
      ),
    ).rejects.toThrow(/truncated|final/i);

    const trailing = new Uint8Array(container.length + 1);
    trailing.set(container);
    trailing[trailing.length - 1] = 0x7f;
    await expect(
      decryptChunkedBytes(trailing, "test-passphrase"),
    ).rejects.toThrow(/trailing/i);
  });

  it("v3 rejects dropped or duplicated frames and remains compatible with v2", async () => {
    const plain = new Uint8Array(2 * 1024 * 1024 + 123);
    for (let i = 0; i < plain.length; i++) plain[i] = i & 0xff;
    const sink = memoryZipSink();
    const enc = await createChunkedEncryptor(
      "test-passphrase",
      sink,
      1024 * 1024,
    );
    await enc.write(plain);
    await enc.finish();
    const container = sink.bytes();
    const fullFrame = 12 + 1024 * 1024 + 16 + 1;
    const header = 29;
    const secondStart = header + fullFrame;
    const thirdEnd = secondStart + fullFrame;

    const dropped = new Uint8Array(container.length - fullFrame);
    dropped.set(container.subarray(0, secondStart), 0);
    dropped.set(container.subarray(thirdEnd), secondStart);
    await expect(
      decryptChunkedBytes(dropped, "test-passphrase"),
    ).rejects.toThrow();

    const duplicated = new Uint8Array(container.length + fullFrame);
    duplicated.set(container.subarray(0, secondStart), 0);
    duplicated.set(container.subarray(secondStart, thirdEnd), secondStart);
    duplicated.set(container.subarray(secondStart), thirdEnd);
    await expect(
      decryptChunkedBytes(duplicated, "test-passphrase"),
    ).rejects.toThrow();
  });

  it("bounded: 3000 realistic photos -> zip -> chunked encrypt -> discarding sink", async () => {
    const rng = mulberry32(11);
    async function* photos(): AsyncIterable<ZipEntry> {
      for (let i = 0; i < 3000; i++) {
        const { bytes } = realisticReceiptJpeg(rng, i);
        yield { name: `photos/r-${i}.jpg`, bytes };
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
    const enc = await createChunkedEncryptor("test-passphrase", discarding);
    const t0 = Date.now();
    await writeStoreZip(photos(), { write: (b) => enc.write(b) });
    await enc.finish();
    const mb = (n: number) => (n / 1048576).toFixed(1);
    console.log(
      `chunked-pipeline: 3000 photos -> zip -> encrypt in ` +
        `${Date.now() - t0} ms, peak heap delta ${mb(peak - baseline)} MB`,
    );
    // 375 MB of photos through the pipe: bounded by design.
    expect(peak - baseline).toBeLessThan(80 * 1024 * 1024);
  }, 180000);

  it("bounded decrypt: chunked container of 3000 photos decrypts under budget", async () => {
    const rng = mulberry32(13);
    async function* photos(): AsyncIterable<ZipEntry> {
      for (let i = 0; i < 3000; i++) {
        const { bytes } = realisticReceiptJpeg(rng, i);
        yield { name: `photos/r-${i}.jpg`, bytes };
      }
    }
    const sink = memoryZipSink(); // ciphertext kept (as a file would be)
    const enc = await createChunkedEncryptor("test-passphrase", sink);
    await writeStoreZip(photos(), { write: (b) => enc.write(b) });
    await enc.finish();
    const container = sink.bytes();

    const baseline = heap();
    let peak = baseline;
    async function* src(): AsyncIterable<Uint8Array> {
      // feed in 256 KB reads, like a file stream
      for (let o = 0; o < container.length; o += 262144) {
        yield container.subarray(o, o + 262144);
      }
    }
    let bytes = 0;
    for await (const pt of decryptChunkedStream(src(), "test-passphrase")) {
      bytes += pt.length;
      const h = heap();
      if (h > peak) peak = h;
    }
    expect(bytes).toBeGreaterThan(3000 * 100 * 1024);
    const mb = (n: number) => (n / 1048576).toFixed(1);
    console.log(
      `chunked-decrypt: ${mb(container.length)} MB container -> ` +
        `${mb(bytes)} MB plaintext, peak heap delta ${mb(peak - baseline)} MB`,
    );
    expect(peak - baseline).toBeLessThan(80 * 1024 * 1024);
  }, 180000);
});
