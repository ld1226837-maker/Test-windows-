// Test-environment shims for jsdom + fake-indexeddb (F-05).
//
// 1. jsdom's Blob/File lack arrayBuffer()/text()/bytes(). Add them via
//    FileReader so production code paths run unchanged.
// 2. fake-indexeddb clones stored values with the global structuredClone.
//    Node's structuredClone does not understand jsdom Blob instances and turns
//    them into `{}`, losing receipt-photo bytes. Wrap it so Blob/File values
//    (which are immutable) are carried through by reference.
//
// We deliberately keep jsdom's own Blob/File/FormData classes: replacing the
// global Blob with Node's breaks jsdom FormData.append() and File.slice().

type AnyBlob = Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };

function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

if (typeof window !== "undefined" && typeof window.Blob === "function") {
  const proto = window.Blob.prototype as AnyBlob;
  if (typeof proto.arrayBuffer !== "function") {
    Object.defineProperty(proto, "arrayBuffer", {
      configurable: true,
      writable: true,
      value(this: Blob) {
        return readAsArrayBuffer(this);
      },
    });
  }
  if (typeof (proto as { text?: unknown }).text !== "function") {
    Object.defineProperty(proto, "text", {
      configurable: true,
      writable: true,
      async value(this: Blob) {
        return new TextDecoder().decode(await readAsArrayBuffer(this));
      },
    });
  }
  if (typeof (proto as { bytes?: unknown }).bytes !== "function") {
    Object.defineProperty(proto, "bytes", {
      configurable: true,
      writable: true,
      async value(this: Blob) {
        return new Uint8Array(await readAsArrayBuffer(this));
      },
    });
  }

  const BlobCtor = window.Blob;
  const original = globalThis.structuredClone;
  const hasBlob = (v: unknown, seen = new Set<unknown>()): boolean => {
    if (v instanceof BlobCtor) return true;
    if (!v || typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some((x) => hasBlob(x, seen));
    const p = Object.getPrototypeOf(v);
    if (p !== Object.prototype && p !== null) return false;
    return Object.values(v).some((x) => hasBlob(x, seen));
  };
  const cloneWithBlobs = (
    v: unknown,
    opts?: StructuredSerializeOptions,
  ): unknown => {
    if (v instanceof BlobCtor) return v;
    if (Array.isArray(v)) return v.map((x) => cloneWithBlobs(x, opts));
    if (v && typeof v === "object") {
      const p = Object.getPrototypeOf(v);
      if (p === Object.prototype || p === null) {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v))
          out[k] = cloneWithBlobs(x, opts);
        return out;
      }
    }
    return original(v, opts);
  };
  globalThis.structuredClone = (<T>(
    v: T,
    opts?: StructuredSerializeOptions,
  ): T =>
    (hasBlob(v)
      ? cloneWithBlobs(v, opts)
      : original(v, opts)) as T) as typeof structuredClone;
}
