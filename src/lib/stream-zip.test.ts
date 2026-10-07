import { describe, expect, it } from "vitest";
import { memoryZipSink, readStoreZipStream, writeStoreZip } from "./stream-zip";

describe("streaming ZIP reader", () => {
  it("reads STORE entries without loading the archive as one value", async () => {
    const sink = memoryZipSink();
    await writeStoreZip(
      (async function* () {
        yield {
          name: "backup.json",
          bytes: new TextEncoder().encode('{"ok":true}'),
        };
        yield { name: "photos/a.jpg", bytes: new Uint8Array([1, 2, 3]) };
      })(),
      sink,
    );
    const seen: string[] = [];
    for await (const e of readStoreZipStream(
      (async function* () {
        yield sink.bytes();
      })(),
    )) {
      seen.push(`${e.name}:${e.bytes.length}`);
    }
    expect(seen).toEqual(["backup.json:11", "photos/a.jpg:3"]);
  });
});

describe("streaming ZIP integrity", () => {
  async function makeZip(entries: { name: string; bytes: Uint8Array }[]) {
    const sink = memoryZipSink();
    await writeStoreZip(
      (async function* () {
        for (const entry of entries) yield entry;
      })(),
      sink,
    );
    return sink.bytes();
  }

  it("rejects entry data whose CRC no longer matches the local header", async () => {
    const zip = await makeZip([
      { name: "backup.json", bytes: new TextEncoder().encode("{}") },
    ]);
    // Local header is 30 bytes + the 11-byte filename; flip the first data byte.
    zip[41] = zip[41]! ^ 0x01;
    await expect(async () => {
      for await (const _entry of readStoreZipStream(
        (async function* () {
          yield zip;
        })(),
      )) {
        /* consume */
      }
    }).rejects.toThrow("ZIP checksum mismatch");
  });

  it("rejects duplicate entry names", async () => {
    const zip = await makeZip([
      { name: "backup.json", bytes: new TextEncoder().encode("{}") },
      { name: "backup.json", bytes: new TextEncoder().encode("{}") },
    ]);
    await expect(async () => {
      for await (const _entry of readStoreZipStream(
        (async function* () {
          yield zip;
        })(),
      )) {
        /* consume */
      }
    }).rejects.toThrow("Duplicate ZIP entry");
  });

  it("drains the source after the ZIP directory so trailing encrypted frames are consumed", async () => {
    const zip = await makeZip([
      { name: "backup.json", bytes: new TextEncoder().encode("{}") },
    ]);
    let trailingRead = false;
    const chunks = (async function* () {
      yield zip;
      trailingRead = true;
      yield new Uint8Array([9, 8, 7]);
    })();
    for await (const _entry of readStoreZipStream(chunks)) {
      /* consume */
    }
    expect(trailingRead).toBe(true);
  });
});
