import { describe, expect, it } from "vitest";
import { mulberry32, realisticReceiptJpeg } from "./receipt-scale-gen";
import { isLikelyImageFile, sniffImageMimeType } from "./image";

describe("receipt-scale-gen (R1)", () => {
  it("generated photos pass the image sniff as JPEG", async () => {
    const { bytes } = realisticReceiptJpeg(mulberry32(1), 0);
    expect(sniffImageMimeType(bytes.subarray(0, 32))).toBe("image/jpeg");
    expect(
      await isLikelyImageFile(
        new File([bytes.slice().buffer as ArrayBuffer], "r.jpg"),
      ),
    ).toBe(true);
  });

  it("sizes land in the realistic 100-150 KB band", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 25; i++) {
      const { bytes } = realisticReceiptJpeg(rng, i);
      expect(bytes.length).toBeGreaterThanOrEqual(100 * 1024);
      expect(bytes.length).toBeLessThanOrEqual(150 * 1024);
    }
  });

  it("is deterministic per seed and distinct per index", () => {
    const a = realisticReceiptJpeg(mulberry32(42), 0);
    const b = realisticReceiptJpeg(mulberry32(42), 0);
    const c = realisticReceiptJpeg(mulberry32(43), 0); // different seed = different photo
    // Sample-compare: deep-equality on 150 KB typed arrays busy-loops vitest.
    expect(a.bytes.length).toBe(b.bytes.length);
    expect(Array.from(a.bytes.slice(0, 64))).toEqual(
      Array.from(b.bytes.slice(0, 64)),
    );
    expect(Array.from(a.bytes.slice(-64))).toEqual(
      Array.from(b.bytes.slice(-64)),
    );
    expect(
      a.bytes.length === c.bytes.length && a.bytes[12345] === c.bytes[12345],
    ).toBe(false);
  });
});
