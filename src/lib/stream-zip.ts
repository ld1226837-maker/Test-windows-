/**
 * R7 (bounded memory): a STORE-only (uncompressed) streaming ZIP writer.
 *
 * Why this exists: JSZip's `generateAsync({type:"uint8array"})` materializes
 * the ENTIRE archive in one array before anything can be written anywhere.
 * At 30k receipt photos (~3.75 GB) that single allocation is ~25x the 150 MB
 * memory budget, regardless of how carefully the rest of the pipeline
 * streams. This writer instead appends each entry's local header + raw
 * bytes to a sink as it goes, then writes the central directory at the end.
 * Peak memory = one photo + bookkeeping, on ANY sink.
 *
 * The output is a completely standard ZIP (no compression, no data
 * descriptors, no zip64 — sizes are known up front), so `JSZip.loadAsync`
 * and every unzip tool read it transparently.
 */

export type ZipSink = {
  /** Append bytes at the current end position. */
  write(bytes: Uint8Array): Promise<void>;
};

export type ZipEntry = {
  /** Archive path, e.g. "photos/Receipts/2026-09/x.jpg". */
  name: string;
  bytes: Uint8Array;
  /** Optional DOS date/time; defaults to 1980-01-01 (zip epoch). */
  dosTime?: number;
  dosDate?: number;
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const te = new TextEncoder();

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}
function u32(v: number): Uint8Array {
  return new Uint8Array([
    v & 0xff,
    (v >>> 8) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 24) & 0xff,
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

type CentralRecord = {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
};

/**
 * Writes `entries` to `sink` as a valid STORE zip. Entries are consumed
 * one at a time from the async iterable — never collect them first.
 * Resolves to the total archive size in bytes.
 */
export async function writeStoreZip(
  entries: AsyncIterable<ZipEntry>,
  sink: ZipSink,
): Promise<number> {
  const central: CentralRecord[] = [];
  let offset = 0;
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = 0x21; // 1980-01-01

  const emit = async (bytes: Uint8Array) => {
    await sink.write(bytes);
    offset += bytes.length;
  };

  for await (const entry of entries) {
    const nameBytes = te.encode(entry.name);
    if (nameBytes.length > 0xffff)
      throw new Error(`zip entry name too long: ${entry.name}`);
    if (entry.bytes.length > 0xffffffff)
      throw new Error(`zip entry too large for ZIP32: ${entry.name}`);
    if (
      offset > 0xffffffff ||
      entry.bytes.length > 0xffffffff ||
      offset + 30 + nameBytes.length + entry.bytes.length > 0xffffffff
    )
      throw new Error(
        "Backup exceeds the ZIP32 4 GiB limit; export a smaller backup or use sharded backup.",
      );
    if (central.length >= 0xffff)
      throw new Error(
        "Backup exceeds the ZIP32 65,535-entry limit; use sharded backup.",
      );
    const crc = crc32(entry.bytes);
    const localOffset = offset;
    // Local file header (30 bytes) + name + raw data.
    await emit(
      concat([
        u32(0x04034b50), // signature
        u16(20), // version needed
        u16(0), // flags
        u16(0), // method: STORE
        u16(entry.dosTime ?? DOS_TIME),
        u16(entry.dosDate ?? DOS_DATE),
        u32(crc),
        u32(entry.bytes.length), // compressed = raw
        u32(entry.bytes.length), // uncompressed
        u16(nameBytes.length),
        u16(0), // extra len
        nameBytes,
      ]),
    );
    await emit(entry.bytes);
    central.push({
      nameBytes,
      crc,
      size: entry.bytes.length,
      offset: localOffset,
      dosTime: entry.dosTime ?? DOS_TIME,
      dosDate: entry.dosDate ?? DOS_DATE,
    });
  }

  // Central directory. Calculate its complete size before writing anything so
  // a ZIP32 overflow never leaves a seemingly successful partial archive.
  const cdStart = offset;
  const cdSizePlanned = central.reduce(
    (n, r) => n + 46 + r.nameBytes.length,
    0,
  );
  const finalZipSize = cdStart + cdSizePlanned + 22;
  if (
    cdStart > 0xffffffff ||
    cdSizePlanned > 0xffffffff ||
    finalZipSize > 0xffffffff
  )
    throw new Error(
      "Backup exceeds the ZIP32 4 GiB limit; use sharded backup.",
    );
  for (const r of central) {
    await emit(
      concat([
        u32(0x02014b50), // signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // method
        u16(r.dosTime),
        u16(r.dosDate),
        u32(r.crc),
        u32(r.size),
        u32(r.size),
        u16(r.nameBytes.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(r.offset),
        r.nameBytes,
      ]),
    );
  }
  const cdSize = offset - cdStart;
  if (cdSize !== cdSizePlanned)
    throw new Error("ZIP central-directory size accounting failed.");
  // End of central directory.
  await emit(
    concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(central.length),
      u16(central.length),
      u32(cdSize),
      u32(cdStart),
      u16(0),
    ]),
  );
  return offset;
}

/** Collecting sink (tests, web fallback). */
export function memoryZipSink(): ZipSink & { bytes(): Uint8Array } {
  const chunks: Uint8Array[] = [];
  return {
    async write(b) {
      chunks.push(b);
    },
    bytes() {
      return concat(chunks);
    },
  };
}

/**
 * Reads STORE-only ZIPs produced by writeStoreZip without materialising the
 * archive. This deliberately consumes local-file records sequentially; the
 * central directory is not needed for these exports because every entry has
 * its size/CRC in the local header. It is used by streaming restore.
 */
export type StreamZipEntry = { name: string; bytes: Uint8Array };

type ReadState = {
  chunks: Uint8Array[];
  head: number;
  offset: number;
  available: number;
};

async function readExact(
  it: AsyncIterator<Uint8Array>,
  state: ReadState,
  n: number,
): Promise<Uint8Array> {
  while (state.available < n) {
    const next = await it.next();
    if (next.done) throw new Error("Truncated ZIP entry");
    if (next.value.length === 0) continue;
    state.chunks.push(next.value);
    state.available += next.value.length;
  }

  const out = new Uint8Array(n);
  let written = 0;
  while (written < n) {
    const chunk = state.chunks[state.head]!;
    const take = Math.min(n - written, chunk.length - state.offset);
    out.set(chunk.subarray(state.offset, state.offset + take), written);
    written += take;
    state.offset += take;
    state.available -= take;
    if (state.offset === chunk.length) {
      state.head++;
      state.offset = 0;
      // Compact occasionally so a long restore does not retain consumed chunks.
      if (state.head > 64 && state.head * 2 > state.chunks.length) {
        state.chunks = state.chunks.slice(state.head);
        state.head = 0;
      }
    }
  }
  return out;
}

function u16read(b: Uint8Array, o: number) {
  return b[o]! | (b[o + 1]! << 8);
}
function u32read(b: Uint8Array, o: number) {
  return (
    (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
  );
}

export async function* readStoreZipStream(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<StreamZipEntry> {
  const state: ReadState = { chunks: [], head: 0, offset: 0, available: 0 };
  const it = chunks[Symbol.asyncIterator]();
  const seenNames = new Set<string>();
  for (;;) {
    const header = await readExact(it, state, 4);
    const sig = u32read(header, 0);
    if (sig === 0x06054b50 || sig === 0x02014b50) {
      // Drain the decrypted stream before returning. Every remaining encrypted
      // frame must be authenticated, including the final frame after the ZIP
      // directory; otherwise tampering with ignored trailing bytes goes
      // undetected because the async generator is abandoned early.
      for (;;) {
        const tail = await it.next();
        if (tail.done) break;
      }
      return;
    }
    if (sig !== 0x04034b50)
      throw new Error("Unsupported ZIP record in streaming restore");
    const rest = await readExact(it, state, 26);
    const flags = u16read(rest, 2);
    const method = u16read(rest, 4);
    const expectedCrc = u32read(rest, 10);
    const compressed = u32read(rest, 14);
    const uncompressed = u32read(rest, 18);
    const nameLen = u16read(rest, 22);
    const extraLen = u16read(rest, 24);
    if (flags !== 0 || method !== 0 || compressed !== uncompressed)
      throw new Error(
        "Streaming restore only supports STORE ZIP entries without data descriptors",
      );
    const name = new TextDecoder().decode(await readExact(it, state, nameLen));
    // Backup entry names are relative paths only. Reject traversal and
    // absolute names before any restore code can turn an archive entry into
    // an app-document path.
    if (
      !name ||
      name.startsWith("/") ||
      name.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(name) ||
      name.split(/[\\/]/).includes("..")
    )
      throw new Error(`Unsafe ZIP entry path: ${name}`);
    if (seenNames.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    seenNames.add(name);
    if (extraLen) await readExact(it, state, extraLen);
    const bytes = await readExact(it, state, compressed);
    if (crc32(bytes) !== expectedCrc)
      throw new Error(`ZIP checksum mismatch: ${name}`);
    yield { name, bytes };
  }
}
