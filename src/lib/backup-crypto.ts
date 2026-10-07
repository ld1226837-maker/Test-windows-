/**
 * AES-256-GCM encryption for backup payloads.
 *
 * `telegram-backup.ts` packages the whole ledger (customers, bills,
 * expenses, receipt photos) into one archive and hands it to a third party
 * — a Telegram chat, or the local filesystem if it's later shared/copied.
 * Neither Telegram nor an on-disk copy needs to be able to read that archive
 * for the backup/restore flow to work, so it's encrypted client-side before
 * it leaves the device and decrypted client-side after it comes back. This
 * module is that encrypt/decrypt step; it knows nothing about Telegram or
 * the archive's internal shape (zip vs. JSON) — callers pass it raw bytes.
 *
 * Container format (all multi-byte integers big-endian):
 *   4 bytes   magic "TSLE" (Turf Snack Ledger Encrypted)
 *   1 byte    format version (currently 1)
 *   4 bytes   PBKDF2 iteration count
 *   16 bytes  PBKDF2 salt
 *   12 bytes  AES-GCM IV
 *   N bytes   AES-256-GCM ciphertext (the last 16 bytes are GCM's own
 *             authentication tag — Web Crypto appends it automatically and
 *             `decrypt` verifies it, which is what turns "wrong passphrase"
 *             and "corrupted/tampered file" into a clean rejection instead
 *             of silently returning garbage plaintext)
 *
 * The passphrase itself never travels in the container or anywhere near
 * Telegram — only the derived key is used, and only in memory.
 */

import { readBackupPassphrase } from "./backup-passphrase";

const MAGIC = [0x54, 0x53, 0x4c, 0x45]; // "TSLE"
const VERSION = 1;
const PBKDF2_ITERATIONS = 600_000; // OWASP Password Storage Cheat Sheet's PBKDF2-HMAC-SHA256 recommendation
const MIN_PBKDF2_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const HEADER_BYTES = MAGIC.length + 1 + 4; // magic + version + iteration count
const MIN_ENCRYPTED_BYTES = HEADER_BYTES + SALT_BYTES + IV_BYTES + 16; // GCM tag

/** Thrown when decryption fails — either the passphrase is wrong, or the file is corrupt/tampered. GCM's auth tag can't tell those apart, and neither can we. */
export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase, or this backup file is damaged.");
    this.name = "WrongPassphraseError";
  }
}

/**
 * Thrown by `decryptFullBackupBytes` when the file is an encrypted `TSLE`
 * container but there's no passphrase to try it with — nothing typed in for
 * this restore, and nothing saved on this device either. Kept distinct from
 * `WrongPassphraseError` (a passphrase was tried and failed) so a caller can
 * offer "type the passphrase this file was made with" for both cases
 * without conflating "you have the wrong one" with "you have none at all".
 */
export class NoPassphraseSetError extends Error {
  constructor() {
    super(
      "This backup is encrypted. Enter the passphrase it was created with.",
    );
    this.name = "NoPassphraseSetError";
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** True when `bytes` looks like a container this module produced (any version). */
export function isEncryptedBackup(bytes: Uint8Array): boolean {
  return (
    bytes.length >= MIN_ENCRYPTED_BYTES && MAGIC.every((b, i) => bytes[i] === b)
  );
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypts `plaintext` under `passphrase`. A fresh random salt and IV are
 * generated per call, so encrypting the same bytes twice never produces the
 * same ciphertext (important here since consecutive backups of a mostly
 * unchanged ledger would otherwise leak that fact to whoever holds the
 * chat/repo).
 */
export async function encryptBackup(
  plaintext: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  if (!passphrase) throw new Error("Set a backup encryption passphrase first.");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );

  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[MAGIC.length] = VERSION;
  new DataView(header.buffer).setUint32(
    MAGIC.length + 1,
    PBKDF2_ITERATIONS,
    false,
  );

  return concatBytes(header, salt, iv, ciphertext);
}

/**
 * Decrypts a container produced by `encryptBackup`. Throws
 * `WrongPassphraseError` when the passphrase is wrong or the bytes are
 * corrupt/tampered (GCM's authentication check is what catches this — there
 * is no separate "is this right" check to run first).
 */
export async function decryptBackup(
  container: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  if (!isEncryptedBackup(container))
    throw new Error(
      "This file isn't an encrypted backup produced by this app.",
    );
  if (!passphrase)
    throw new Error("Enter the backup passphrase to restore this file.");

  if (container.length < MIN_ENCRYPTED_BYTES) throw new WrongPassphraseError();
  const view = new DataView(
    container.buffer,
    container.byteOffset,
    container.byteLength,
  );
  const version = view.getUint8(MAGIC.length);
  if (version !== VERSION)
    throw new Error(`Unsupported encrypted backup version: ${version}`);
  const iterations = view.getUint32(MAGIC.length + 1, false);
  if (iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS)
    throw new Error(
      "Encrypted backup has an unsupported PBKDF2 iteration count.",
    );
  let offset = HEADER_BYTES;
  const salt = container.slice(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const iv = container.slice(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const ciphertext = container.slice(offset);

  const key = await deriveKey(passphrase, salt, iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new WrongPassphraseError();
  }
}

/**
 * Encrypts `bytes` — a built backup's serialized bytes, whatever the
 * underlying shape (zip archive, or plain JSON text as `downloadBackup`'s
 * single-file `.db` export produces) — with this device's stored backup
 * passphrase (see `backup-passphrase.ts`). Every path that sends a backup
 * somewhere it doesn't fully control (Telegram) or writes it to a shared
 * location (a local `.db`/`.zip`/year-archive save, which can end up
 * copied/shared like any other file) calls this before handing bytes off,
 * so nothing that leaves the device is ever plaintext. Throws a plain,
 * actionable error if no passphrase has been set yet, rather than silently
 * falling back to plaintext.
 */
export async function encryptFullBackupBytes(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const passphrase = await readBackupPassphrase();
  if (!passphrase)
    throw new Error(
      "Set a backup encryption passphrase (Settings → Backup encryption) before backing up.",
    );
  return encryptBackup(bytes, passphrase);
}

/**
 * Inverse of `encryptFullBackupBytes`, for a restore path reading `bytes`
 * fresh off disk or a picked file. Archives/`.db` files made after
 * encryption was added come back through here as `TSLE` containers; older
 * ones made before it are plain bytes and are passed through unchanged —
 * detecting and handling both is what keeps a backup someone already has
 * saved/sent from becoming unrestorable.
 *
 * `passphraseOverride`, when given, is tried instead of this device's
 * stored passphrase — for restoring a file made under a different
 * passphrase (another device, or this device's passphrase changed since).
 * Callers that don't have one to offer yet should omit it: that keeps the
 * original "just works with the stored passphrase" behavior, and lets the
 * caller catch `WrongPassphraseError`/`NoPassphraseSetError` to ask for one
 * only when the stored passphrase actually didn't work.
 */
export async function decryptFullBackupBytes(
  bytes: Uint8Array,
  passphraseOverride?: string,
): Promise<Uint8Array> {
  if (!isEncryptedBackup(bytes)) return bytes;
  if (isChunkedEncryptedBackup(bytes))
    return decryptChunkedBytes(bytes, passphraseOverride);
  const passphrase = passphraseOverride || (await readBackupPassphrase());
  if (!passphrase) throw new NoPassphraseSetError();
  return decryptBackup(bytes, passphrase);
}

/* ------------------------------------------------------------------ *
 * Chunked AEAD ("TSLE" version 2) — R7 bounded memory.
 *
 * The one-shot format above materializes plaintext + ciphertext +
 * output copies of the ENTIRE container (~2-3x archive size). This
 * chunked variant encrypts independently per chunk (1 MiB default) with
 * the chunk index as AES-GCM additional authenticated data, so chunks
 * cannot be reordered, dropped, or duplicated without detection. The
 * whole pipeline (zip writer -> chunk encryptor -> file sink, and
 * file source -> chunk decryptor -> zip reader) then holds at most one
 * chunk plus one photo in memory, at any scale.
 *
 * Layout: MAGIC(4) | u8 version=3 | u32 chunkSize | u32 iterations |
 *         salt(16) | then per chunk: IV(12) | ciphertext | GCM tag(16).
 * Version 3 authenticates a one-byte final-chunk marker inside every frame;
 * this makes truncation at an exact chunk boundary fail closed. Version 2 is
 * retained only for backwards-compatible restore of older files.
 * ------------------------------------------------------------------ */

const LEGACY_CHUNKED_VERSION = 2;
const CHUNKED_VERSION = 3;
const CHUNK_BYTES = 1024 * 1024;

type BytesSink = { write(bytes: Uint8Array): Promise<void> };

function u32le(v: number): Uint8Array {
  return new Uint8Array([
    v & 0xff,
    (v >>> 8) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 24) & 0xff,
  ]);
}

export function isChunkedEncryptedBackup(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === MAGIC[0] &&
    bytes[1] === MAGIC[1] &&
    bytes[2] === MAGIC[2] &&
    bytes[3] === MAGIC[3] &&
    (bytes[4] === LEGACY_CHUNKED_VERSION || bytes[4] === CHUNKED_VERSION)
  );
}

/**
 * Creates a streaming encryptor: `write(plain)` buffers and encrypts in
 * chunkSize blocks; `finish()` flushes the partial block and must be
 * called exactly once.
 */
export async function createChunkedEncryptor(
  passphrase: string,
  sink: BytesSink,
  chunkSize = CHUNK_BYTES,
): Promise<{
  write(plain: Uint8Array): Promise<void>;
  finish(): Promise<void>;
}> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await sink.write(
    concatBytes(
      new Uint8Array(MAGIC),
      new Uint8Array([CHUNKED_VERSION]),
      u32le(chunkSize),
      u32le(PBKDF2_ITERATIONS),
      salt,
    ),
  );
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  let pending = new Uint8Array(0);
  let index = 0;

  const encryptBlock = async (block: Uint8Array, isLast: boolean) => {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const aad = u32le(index);
    index++;
    // Version 3 authenticates the final marker as ciphertext. A zero marker
    // means more frames must follow; a one marker is the only legal EOF.
    const framedPlaintext = concatBytes(
      block,
      new Uint8Array([isLast ? 1 : 0]),
    );
    const ct = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: aad as BufferSource,
      },
      key,
      framedPlaintext as BufferSource,
    );
    await sink.write(concatBytes(iv, new Uint8Array(ct)));
  };

  return {
    async write(plain: Uint8Array) {
      // pending + plain, encrypt as many full chunks as possible.
      const buf = new Uint8Array(pending.length + plain.length);
      buf.set(pending, 0);
      buf.set(plain, pending.length);
      let off = 0;
      while (buf.length - off >= chunkSize) {
        // Full blocks are never final: finish() emits the authenticated EOF
        // marker, including an empty final frame when the size is exact.
        await encryptBlock(buf.subarray(off, off + chunkSize), false);
        off += chunkSize;
      }
      pending = buf.subarray(off);
    },
    async finish() {
      await encryptBlock(pending, true);
      pending = new Uint8Array(0);
    },
  };
}

/** Streaming decryptor over ciphertext chunks. Throws on any tamper. */
export async function* decryptChunkedStream(
  chunks: AsyncIterable<Uint8Array>,
  passphraseOverride?: string,
): AsyncIterable<Uint8Array> {
  // Read the fixed-size header first.
  const header = new Uint8Array(4 + 1 + 4 + 4 + 16);
  let filled = 0;
  let it = chunks[Symbol.asyncIterator]();
  while (filled < header.length) {
    const { value, done } = await it.next();
    if (done) throw new Error("Truncated encrypted backup header");
    const take = Math.min(value.length, header.length - filled);
    header.set(value.subarray(0, take), filled);
    filled += take;
    if (take < value.length) {
      // leftover belongs to the first ciphertext chunk - push back via a
      // prepended iterator.
      const rest = value.subarray(take);
      it = prependAsync(rest, it)[Symbol.asyncIterator]();
    }
  }
  const view = new DataView(header.buffer);
  const version = view.getUint8(4);
  if (version !== LEGACY_CHUNKED_VERSION && version !== CHUNKED_VERSION)
    throw new Error("Unsupported chunked backup version");
  const chunkSize = view.getUint32(5, true);
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > 16 * 1024 * 1024
  )
    throw new Error("Invalid encrypted backup chunk size");
  const iterations = view.getUint32(9, true);
  if (iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS)
    throw new Error("Suspicious PBKDF2 iteration count");
  const passphrase = passphraseOverride || (await readBackupPassphrase());
  if (!passphrase) throw new NoPassphraseSetError();
  const key = await deriveKey(passphrase, header.subarray(13, 29), iterations);

  const isV3 = version === CHUNKED_VERSION;
  const frame = IV_BYTES + chunkSize + 16 + (isV3 ? 1 : 0);
  let buf = new Uint8Array(0);
  let index = 0;
  let finished = false;
  let sawFinal = false;
  const decryptFrame = async (
    frameBytes: Uint8Array,
  ): Promise<{ plaintext: Uint8Array; final: boolean }> => {
    const iv = frameBytes.subarray(0, IV_BYTES);
    const ct = frameBytes.subarray(IV_BYTES);
    const aad = u32le(index);
    index++;
    try {
      const pt = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv as BufferSource,
            additionalData: aad as BufferSource,
            tagLength: 128,
          },
          key,
          ct as BufferSource,
        ),
      );
      if (!isV3) return { plaintext: pt, final: false };
      if (pt.length < 1) throw new Error("Malformed encrypted backup chunk");
      const marker = pt[pt.length - 1];
      if (marker !== 0 && marker !== 1)
        throw new Error("Malformed encrypted backup final marker");
      return { plaintext: pt.subarray(0, pt.length - 1), final: marker === 1 };
    } catch (e) {
      if (e instanceof Error && /Malformed encrypted backup/.test(e.message))
        throw e;
      throw new WrongPassphraseError();
    }
  };
  const ensureSourceEof = async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) return;
      if (next.value.length)
        throw new Error("Trailing bytes after final encrypted backup chunk");
    }
  };
  const pump = async (): Promise<Uint8Array | null> => {
    for (;;) {
      if (sawFinal) {
        if (buf.length)
          throw new Error("Trailing bytes after final encrypted backup chunk");
        await ensureSourceEof();
        return null;
      }
      if (isV3) {
        if (buf.length >= frame) {
          const decoded = await decryptFrame(buf.subarray(0, frame));
          buf = buf.subarray(frame);
          if (decoded.final) {
            sawFinal = true;
            if (buf.length)
              throw new Error(
                "Trailing bytes after final encrypted backup chunk",
              );
            await ensureSourceEof();
          }
          return decoded.plaintext;
        }
      } else if (buf.length >= frame) {
        const decoded = await decryptFrame(buf.subarray(0, frame));
        buf = buf.subarray(frame);
        return decoded.plaintext;
      }
      if (finished) {
        if (buf.length === 0) {
          if (isV3)
            throw new Error(
              "Truncated encrypted backup: final chunk marker missing",
            );
          return null;
        }
        if (isV3) {
          // The final frame consumes the rest of the stream and its size
          // varies (IV + final-chunk ciphertext + GCM tag). A stream ending
          // exactly on a chunk boundary has a fixed 29-byte EMPTY final
          // frame; trailing garbage after it must be reported as trailing,
          // not absorbed into the frame (which fails GCM auth and
          // misreports as a wrong passphrase). Anything shorter is a
          // truncation.
          const minFinalLen = IV_BYTES + 16 + 1;
          if (buf.length < minFinalLen)
            throw new Error("Truncated encrypted backup chunk");
          let decoded: { plaintext: Uint8Array; final: boolean };
          if (buf.length === minFinalLen) {
            decoded = await decryptFrame(buf);
          } else {
            // Ambiguous: a non-empty final chunk OR empty final frame plus
            // trailing bytes. On auth failure, re-check with 1..16 trailing
            // bytes stripped; a stripped frame that validates as `final`
            // proves the extra bytes were trailing. GCM forgery is
            // computationally infeasible, so misattribution cannot occur.
            const savedIndex = index;
            try {
              decoded = await decryptFrame(buf);
            } catch (e) {
              let trailing = false;
              for (let k = 1; k <= 16 && !trailing; k++) {
                if (buf.length - k < minFinalLen) break;
                index = savedIndex; // decryptFrame advances the frame counter
                try {
                  const d = await decryptFrame(buf.subarray(0, buf.length - k));
                  if (d.final) trailing = true;
                } catch {
                  index = savedIndex;
                }
              }
              index = savedIndex;
              if (trailing)
                throw new Error(
                  "Trailing bytes after final encrypted backup chunk",
                );
              throw e;
            }
          }
          buf = new Uint8Array(0);
          if (!decoded.final)
            throw new Error(
              "Truncated encrypted backup: final chunk marker missing",
            );
          sawFinal = true;
          await ensureSourceEof();
          return decoded.plaintext;
        }
        if (buf.length > IV_BYTES + 16) {
          const decoded = await decryptFrame(buf);
          buf = new Uint8Array(0);
          return decoded.plaintext;
        }
        throw new Error("Truncated encrypted backup chunk");
      }
      const { value, done } = await it.next();
      if (done) {
        finished = true;
        continue;
      }
      if (!value.length) continue;
      const nb = new Uint8Array(buf.length + value.length);
      nb.set(buf, 0);
      nb.set(value, buf.length);
      buf = nb;
    }
  };
  for (;;) {
    const pt = await pump();
    if (pt === null) break;
    yield pt;
  }
}

async function* prependAsync(
  first: Uint8Array,
  it: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  yield first;
  for (;;) {
    const { value, done } = await it.next();
    if (done) return;
    yield value;
  }
}

/** Whole-buffer chunked decrypt (bytes callers / tests). */
export async function decryptChunkedBytes(
  bytes: Uint8Array,
  passphraseOverride?: string,
): Promise<Uint8Array> {
  async function* one(): AsyncIterable<Uint8Array> {
    yield bytes;
  }
  const parts: Uint8Array[] = [];
  for await (const pt of decryptChunkedStream(one(), passphraseOverride))
    parts.push(pt);
  return concatBytes(...parts);
}
