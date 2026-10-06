// Independent verification (node env — real Blob survives fake-indexeddb clone).
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

vi.mock("@/lib/backup-passphrase", () => {
  let p: string | null = null;
  return {
    readBackupPassphrase: async () => p,
    writeBackupPassphrase: async (v: string | null) => {
      p = v;
    },
    clearBackupPassphrase: async () => {
      p = null;
    },
  };
});

import { db, DATA_TABLES, table } from "@/lib/localdb";
import {
  buildBackup,
  serializeBackupBytes,
  decodeBackupBytes,
  parseBackup,
  restoreBackup,
} from "@/lib/backup";
import { encryptBackup } from "@/lib/backup-crypto";

const TREE = process.env.TREE ?? "x";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed: number) => {
  const a = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    a[i] = s & 255;
  }
  return a;
};
const P = (d: string, id: string, ext: string) => `Receipts/${d}/${id}.${ext}`;
const C = "2026-01-01T00:00:00.000Z";

const photos: Record<string, Uint8Array> = {
  [P("2024-12-31", "e1", "jpg")]: bytes(2_000_000, 1),
  [P("2025-01-01", "e2", "png")]: bytes(10, 2),
  [P("2025-06-01", "e3", "webp")]: bytes(5000, 3),
  [P("2025-12-31", "i1", "jpg")]: bytes(3000, 4),
  [P("2026-01-01", "shared", "jpg")]: bytes(777, 5),
  [P("2026-02-02", "b1", "jpg")]: bytes(999, 6),
  [P("2026-03-03", "idel", "jpg")]: bytes(444, 7),
};
const ks = Object.keys(photos);

async function clearAll() {
  for (const t of DATA_TABLES) await table(t).clear();
  await db.receipts.clear();
  await db.receipt_hashes.clear();
}
async function seed() {
  await clearAll();
  for (const [path, b] of Object.entries(photos)) {
    await db.receipts.put({
      path,
      blob: new Blob([b]),
      created_at: C,
    } as never);
    await db.receipt_hashes.put({
      path,
      sha256: sha(b),
      created_at: C,
    } as never);
  }
  const exp = (id: string, amt: number, d: string, rp: string | null) => ({
    id,
    expense_no: `TX-${d.replace(/-/g, "")}-0001${id}`,
    business: "Turf",
    category: "Maintenance",
    description: id,
    note: null,
    amount: amt,
    spent_at: d,
    receipt_path: rp,
    payment_mode: "Cash",
    created_at: C,
  });
  await db.expenses.bulkPut([
    exp("e1", 500, "2024-12-31", ks[0]!),
    exp("e2", 0.01, "2025-01-01", ks[1]!),
    exp("e3", 1234.56, "2025-06-01", ks[2]!),
    exp("eshared", 50, "2026-01-01", ks[4]!),
    exp("enophoto", 0.3, "2026-01-02", null),
  ] as never);
  const inv = (
    id: string,
    amt: number,
    d: string,
    rp: string | null,
    extra = {},
  ) => ({
    id,
    title: id,
    bill_no: `INVES-${(d || "20260101").replaceAll("-", "")}-${String([...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 1000).padStart(3, "0")}`,
    amount: amt,
    investment_date: d,
    receipt_path: rp,
    payment_mode: "UPI",
    category: "Equipment",
    note: null,
    created_at: C,
    updated_at: C,
    deleted_at: null,
    ...extra,
  });
  await db.investments.bulkPut([
    inv("i1", 9999999.99, "2025-12-31", ks[3]!),
    inv("ishared", 0.1, "2026-01-01", ks[4]!),
    inv("inophoto", 0.2, "2026-01-01", null, { payment_mode: null }),
    inv("idel", 10, "2026-03-03", ks[6]!, { deleted_at: C }),
  ] as never);
  await db.bills.put({
    id: "b1",
    invoice_no: "INV-20260202-0001",
    customer_id: null,
    items: [],
    subtotal: 100,
    total: 100,
    amount_paid: 100,
    payment_mode: "Card",
    receipt_path: ks[5]!,
    created_at: C,
  } as never);
}
async function snapshot() {
  const out: Record<string, string> = {};
  for (const t of DATA_TABLES) {
    if (t === "counters") continue;
    const rows = (await table(t).toArray()).filter(
      (r: any) => !(t === "app_settings" && String(r.key).startsWith("__")),
    );
    rows.sort((a: any, b: any) =>
      String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)),
    );
    out[t] =
      `${rows.length}:` +
      sha(
        new TextEncoder().encode(
          JSON.stringify(
            rows,
            Object.keys(rows[0] ?? {}).sort().length ? undefined : undefined,
          ),
        ),
      );
  }
  return out;
}
async function photoHashes() {
  const out: Record<string, string> = {};
  for (const r of await db.receipts.toArray())
    out[r.path] = sha(new Uint8Array(await (r as any).blob.arrayBuffer()));
  return out;
}
const expectedPhotos = Object.fromEntries(
  Object.entries(photos).map(([k, v]) => [k, sha(v)]),
);
async function exportBytes() {
  return serializeBackupBytes(await buildBackup());
}
async function importBytes(
  b: Uint8Array,
  mode: "replace" | "merge",
  pass?: string,
) {
  return restoreBackup(parseBackup(await decodeBackupBytes(b, pass)), mode);
}

describe(`[${TREE}] independent migration verification`, () => {
  beforeEach(seed);

  it("B1/C1/C2/C3: replace round-trip keeps every row and photo byte-identical", async () => {
    const before = await snapshot();
    const b = await exportBytes();
    await clearAll();
    await importBytes(b, "replace");
    expect(await snapshot()).toEqual(before);
    expect(await photoHashes()).toEqual(expectedPhotos);
    expect(((await db.investments.get("i1")) as any).amount).toBe(9999999.99);
    expect(((await db.investments.get("idel")) as any).deleted_at).toBe(C);
    for (const h of await db.receipt_hashes.toArray())
      expect(h.sha256).toBe(expectedPhotos[h.path]);
  });

  it("B2: replace over different data removes old rows/photos", async () => {
    const before = await snapshot();
    const b = await exportBytes();
    await db.expenses.put({
      id: "stale",
      business: "Turf",
      category: "x",
      amount: 1,
      spent_at: "2020-01-01",
      receipt_path: "Receipts/2020-01-01/stale.jpg",
      created_at: C,
    } as never);
    await db.receipts.put({
      path: "Receipts/2020-01-01/stale.jpg",
      blob: new Blob([bytes(5, 9)]),
      created_at: C,
    } as never);
    await importBytes(b, "replace");
    expect(await snapshot()).toEqual(before);
    expect(await photoHashes()).toEqual(expectedPhotos);
  });

  it("B3/B4: merge into same data twice is idempotent", async () => {
    const before = await snapshot();
    const b = await exportBytes();
    await importBytes(b, "merge");
    await importBytes(b, "merge");
    expect(await snapshot()).toEqual(before);
    expect(await photoHashes()).toEqual(expectedPhotos);
  });

  it("C5: same investment id, different amount on target — merge does not silently overwrite", async () => {
    const b = await exportBytes();
    await db.investments.update("i1", { amount: 5 } as never);
    let err: unknown = null;
    try {
      await importBytes(b, "merge");
    } catch (e) {
      err = e;
    }
    const amt = ((await db.investments.get("i1")) as any).amount;
    // Accept: loud rejection with local value kept. Fail: silent change.
    expect(err === null && amt !== 5 ? "silent overwrite" : "ok").toBe("ok");
    console.log(
      "C5 outcome:",
      err
        ? `rejected: ${String(err).slice(0, 120)}`
        : `accepted, amount=${amt}`,
    );
  });

  it("C6: deleting the expense that shares a photo with an investment keeps the photo", async () => {
    const { purgeReceiptIfUnreferenced } =
      await import("@/lib/receipt-storage");
    await db.expenses.delete("eshared");
    await purgeReceiptIfUnreferenced(ks[4]!);
    expect(await db.receipts.get(ks[4]!)).toBeDefined();
    await db.investments.delete("ishared");
    await purgeReceiptIfUnreferenced(ks[4]!);
    expect(await db.receipts.get(ks[4]!)).toBeUndefined();
  });

  it("C7: missing investment photo at export is flagged (partial + warning), and restore refuses", async () => {
    await db.receipts.delete(ks[3]!);
    const bk = await buildBackup();
    expect(bk.partial).toBe(true);
    expect((bk.warnings ?? []).join(" ")).toContain(ks[3]!);
    await expect(restoreBackup(bk, "replace")).rejects.toThrow(/partial/i);
    expect(await db.investments.count()).toBe(4); // untouched
  });

  it("B6: tampered photo bytes fail atomically", async () => {
    const before = await snapshot();
    const bk = await buildBackup();
    const b = await serializeBackupBytes(bk);
    // flip bytes inside the stored (uncompressed?) photo region: tamper container tail area
    const target = photos[ks[2]!]!;
    const needle = target.slice(100, 116);
    let at = -1;
    outer: for (let i = 0; i < b.length - 16; i++) {
      for (let j = 0; j < 16; j++) if (b[i + j] !== needle[j]) continue outer;
      at = i;
      break;
    }
    console.log("B6 tamper offset", at);
    if (at >= 0) b[at]! ^= 0xff;
    await expect(importBytes(b, "replace")).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await photoHashes()).toEqual(expectedPhotos);
  });

  it("B6: path traversal in receipt_path rejected without writes", async () => {
    const before = await snapshot();
    for (const bad of [
      "../x.jpg",
      "/etc/x.jpg",
      "Receipts\\2026\\x.jpg",
      "Receipts/2026-01-01/..／x.jpg",
    ]) {
      const bk = await buildBackup();
      (bk.tables["expenses"]![0] as any).receipt_path = bad;
      await expect(restoreBackup(bk, "replace")).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("B6: truncated container rejected", async () => {
    const before = await snapshot();
    const b = await exportBytes();
    await expect(
      importBytes(b.slice(0, Math.floor(b.length / 2)), "replace"),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("B7: encrypted export — right passphrase restores, wrong/corrupt never writes", async () => {
    const before = await snapshot();
    const enc = await encryptBackup(await exportBytes(), "correct horse");
    await expect(importBytes(enc, "replace", "wrong")).rejects.toThrow();
    const bad = enc.slice();
    bad[bad.length - 40]! ^= 0xff;
    await expect(
      importBytes(bad, "replace", "correct horse"),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await clearAll();
    await importBytes(enc, "replace", "correct horse");
    expect(await snapshot()).toEqual(before);
    expect(await photoHashes()).toEqual(expectedPhotos);
  }, 30000);

  it("B13: two concurrent replace restores serialize and end consistent", async () => {
    const before = await snapshot();
    const b = await exportBytes();
    await clearAll();
    const r = await Promise.allSettled([
      importBytes(b, "replace"),
      importBytes(b, "replace"),
    ]);
    console.log(
      "B13:",
      r.map(
        (x) =>
          x.status +
          (x.status === "rejected"
            ? " " + String((x as any).reason).slice(0, 80)
            : ""),
      ),
    );
    expect(await snapshot()).toEqual(before);
    expect(await photoHashes()).toEqual(expectedPhotos);
  }, 30000);

  it("B10: cross-platform — write own export, restore the other tree's export", async () => {
    const before = await snapshot();
    mkdirSync("/tmp/a", { recursive: true });
    writeFileSync(`/tmp/a/xplat-${TREE}.db`, await exportBytes());
    writeFileSync(`/tmp/a/xplat-${TREE}.snap.json`, JSON.stringify(before));
    const other = TREE === "windows" ? "android" : "windows";
    if (!existsSync(`/tmp/a/xplat-${other}.db`)) {
      console.log("B10: other tree export not yet present");
      return;
    }
    await clearAll();
    await importBytes(
      new Uint8Array(readFileSync(`/tmp/a/xplat-${other}.db`)),
      "replace",
    );
    expect(await snapshot()).toEqual(
      JSON.parse(readFileSync(`/tmp/a/xplat-${other}.snap.json`, "utf8")),
    );
    expect(await photoHashes()).toEqual(expectedPhotos);
  });
});
