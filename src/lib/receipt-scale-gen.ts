/**
 * R1: realistic receipt-photo generator for the 30k scale test.
 *
 * Produces JPEGs in the real 100-150 KB band whose payload is CSPRNG noise
 * (so deflate cannot shrink them - unlike the 360x240 1-bit PNG in
 * seed-photo.ts), wrapped in a minimal JPEG header so `isLikelyImageFile`'s
 * 0xFFD8FF sniff passes.
 */

/** Deterministic PRNG (mulberry32) so scale tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JPEG_HEAD = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
]);

/**
 * One ~100-150 KB "receipt photo". The body is crypto-random noise filled
 * 64 KB at a time (the only large allocation is the payload itself), so
 * compressed containers (.db zip, full-backup zip) cannot cheat the scale
 * test by deflating identical pixels.
 */
export function realisticReceiptJpeg(
  rng: () => number,
  index: number,
): { bytes: Uint8Array; name: string } {
  const sizeKb = 100 + Math.floor(rng() * 51); // 100-150 KB
  const total = sizeKb * 1024;
  const bytes = new Uint8Array(total);
  bytes.set(JPEG_HEAD);
  bytes[total - 2] = 0xff;
  bytes[total - 1] = 0xd9; // EOI
  // Fill the body from the SEEDED rng (deterministic per seed). PRNG
  // output still defeats deflate in practice (no repeated structure at the
  // LZ77 window scale), which is all the scale test needs - and unlike
  // crypto.getRandomValues it keeps runs reproducible.
  let state = Math.floor(rng() * 4294967295);
  const nextByte = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  };
  for (let off = JPEG_HEAD.length; off < total - 2; off++)
    bytes[off] = nextByte();
  return { bytes, name: `scale-receipt-${index}.jpg` };
}
