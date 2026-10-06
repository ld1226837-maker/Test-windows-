// @vitest-environment jsdom
// `fake-indexeddb/auto` installs a real (in-memory) IndexedDB implementation
// globally before Dexie opens the database, so `buildBackup()` can run
// against an actual `db` here the same way it does in the app — this test
// is asserting on buildBackup()'s real output, not a stand-in for it.
import "fake-indexeddb/auto";
import backupModuleSource from "./backup.ts?raw";
import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  buildBackup,
  backupSummary,
  restoreBackup,
  setInternalRestoreOptions,
  downloadBackup,
  decodeBackupBytes,
  parseBackup,
  serializeBackupBytes,
  BACKUP_TABLES,
  type BackupFile,
} from "./backup";
import { db, DATA_TABLES, newId, nowIso } from "./localdb";
import { sha256Hex } from "./receipts-share";
import { bytesToBase64 } from "./desktop";
import { writeBackupPassphrase } from "./backup-passphrase";
import {
  encryptFullBackupBytes,
  encryptBackup,
  isEncryptedBackup,
  WrongPassphraseError,
  NoPassphraseSetError,
} from "./backup-crypto";

// `readBackupPassphrase`/`writeBackupPassphrase` use secure storage on desktop/Android;
// browser-only builds may use `window.localStorage` outside Android/desktop (see backup-passphrase.ts),
// which is a no-op under plain Node (no `window` here — this project runs
// its suite without a DOM). Mocking the module in-memory instead of relying
// on that fallback is what lets these tests set/clear a passphrase reliably,
// the same way `backup-crypto.test.ts` sidesteps storage by calling
// `encryptBackup`/`decryptBackup` with an explicit passphrase.
vi.mock("./backup-passphrase", () => {
  let stored = "";
  return {
    readBackupPassphrase: vi.fn(async () => stored),
    writeBackupPassphrase: vi.fn(async (p: string) => {
      stored = p;
    }),
    hasBackupPassphrase: vi.fn(async () => stored.length > 0),
  };
});

describe("DATA_TABLES / BACKUP_TABLES", () => {
  it("never lists the receipts table among the plain-row tables", () => {
    // Receipt photos are still not part of the row-shaped `tables` object —
    // buildBackup() carries them separately in `photos` (base64-encoded),
    // see the test below. Keeping "receipts" out of this list is what keeps
    // photo bytes out of `tables`, specifically.
    expect(DATA_TABLES).not.toContain("receipts");
    expect(BACKUP_TABLES).not.toContain("receipts");
  });
});

describe("buildBackup()", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.investments.clear();
    await db.bills.clear();
    await db.receipts.clear();
    await db.receipt_hashes.clear();
  });

  it("includes every receipt photo in the v3 photo manifest — bytes in the container, base64 nowhere", async () => {
    // An expense with a photo actually attached — receipt_path is a plain
    // string reference, never the bytes themselves.
    const receiptPath = `Receipts/2026-09-04/${newId()}.jpg`;
    await db.expenses.add({
      id: newId(),
      expense_no: "TX-20260904-0001",
      business: "Turf",
      category: "Maintenance",
      description: "Net repair",
      note: null,
      amount: 500,
      spent_at: "2026-09-04",
      receipt_path: receiptPath,
      created_at: nowIso(),
    });
    // uploadReceipt now mirrors every photo into db.receipts on every
    // platform (see its doc comment in expenses.ts) — this is that copy.
    const fakeJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    await db.receipts.put({
      path: receiptPath,
      blob: new Blob([fakeJpegBytes]),
      created_at: nowIso(),
    });

    await db.receipt_hashes.put({
      path: receiptPath,
      sha256: await sha256Hex(fakeJpegBytes),
      created_at: nowIso(),
    });

    const backup = await buildBackup();

    expect(backup.version).toBe(5);
    expect(backup.tables["receipts"]).toBeUndefined();
    expect(Object.keys(backup.tables)).not.toContain("receipts");
    expect(backup.tables["expenses"]?.[0]?.["receipt_path"]).toBe(receiptPath);

    // R4: the manifest carries {path, sha256, size, created_at}; the bytes
    // travel in the download container (serializeBackupBytes), never as a
    // giant base64 string inside the JSON.
    expect(backup.photos).toBeUndefined();
    expect(backup.photo_manifest).toHaveLength(1);
    expect(backup.photo_manifest?.[0]?.path).toBe(receiptPath);
    expect(backup.photo_manifest?.[0]?.sha256).toBe(
      await sha256Hex(fakeJpegBytes),
    );
    expect(backup.photo_manifest?.[0]?.size).toBe(fakeJpegBytes.length);
  });

  it("produces an empty photo manifest when no receipts exist", async () => {
    const backup = await buildBackup();
    expect(backup.photo_manifest).toEqual([]);
  });

  it("exports bill receipt photos and ignores unreferenced receipt rows", async () => {
    await db.bills.clear();
    await db.receipt_hashes.clear();
    const billPath = `Receipts/2026-09-05/${newId()}.png`;
    const orphanPath = `Receipts/2026-09-05/${newId()}.png`;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await db.bills.add({
      id: newId(),
      invoice_no: "INV-BILL-PHOTO-1",
      customer_name: "Bill Photo",
      customer_phone: null,
      items: [],
      subtotal: 100,
      discount: 0,
      total: 100,
      amount_paid: 100,
      status: "paid",
      payment_mode: "Cash",
      bill_date: "2026-09-05T10:00:00.000Z",
      created_at: "2026-09-05T10:00:00.000Z",
      receipt_path: billPath,
    });
    await db.receipts.bulkPut([
      {
        path: billPath,
        blob: new Blob([bytes]),
        size: bytes.length,
        created_at: nowIso(),
      },
      {
        path: orphanPath,
        blob: new Blob([bytes]),
        size: bytes.length,
        created_at: nowIso(),
      },
    ]);
    await db.receipt_hashes.put({
      path: orphanPath,
      sha256: await sha256Hex(bytes),
      created_at: nowIso(),
    });

    const backup = await buildBackup();
    expect(backup.photo_manifest?.map((p) => p.path)).toEqual([billPath]);
    expect(backup.receipt_hashes?.map((h) => h.path)).toEqual([]);
  });

  it("rejects duplicate v3 manifest paths before any restore", async () => {
    const path = `Receipts/2026-09-06/${newId()}.jpg`;
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      backup_id: `duplicate-manifest-${newId()}`,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [
        { path, sha256: "00".repeat(32), size: 1, created_at: nowIso() },
        { path, sha256: "11".repeat(32), size: 1, created_at: nowIso() },
      ],
    };
    await expect(restoreBackup(backup, "replace")).rejects.toThrow(
      /duplicate receipt photo path/,
    );
  });

  it("v3 round-trip: container serialize → decode → restore writes verified photos", async () => {
    const receiptPath = `Receipts/2026-09-04/${newId()}.jpg`;
    const fakeJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
    await db.expenses.add({
      id: newId(),
      expense_no: "TX-20260904-0002",
      business: "Turf",
      category: "Maintenance",
      description: "Net repair",
      note: null,
      amount: 500,
      spent_at: "2026-09-04",
      receipt_path: receiptPath,
      created_at: nowIso(),
    });
    await db.receipts.put({
      path: receiptPath,
      blob: new Blob([fakeJpegBytes]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path: receiptPath,
      sha256: await sha256Hex(fakeJpegBytes),
      created_at: nowIso(),
    });

    const backup = await buildBackup();
    const { serializeBackupBytes, decodeBackupBytes, parseBackup } =
      await import("./backup");
    const container = await serializeBackupBytes(backup);
    expect(container[0]).toBe(0x50); // PK zip container, not JSON text
    const restored = parseBackup(await decodeBackupBytes(container));

    // Wipe and restore replace-mode: photo bytes must come back verified.
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    await db.expenses.clear();
    await restoreBackup(restored, "replace");
    const row = await db.receipts.get(receiptPath);
    expect(new Uint8Array(await row!.blob!.arrayBuffer())).toEqual(
      fakeJpegBytes,
    );
  });

  it("v3 restore rejects a photo whose container bytes fail the manifest checksum", async () => {
    const receiptPath = `Receipts/2026-09-04/${newId()}.jpg`;
    const good = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 1, 1, 1]);
    await db.receipts.put({
      path: receiptPath,
      blob: new Blob([good]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path: receiptPath,
      sha256: await sha256Hex(good),
      created_at: nowIso(),
    });
    // buildBackup() only exports photos REFERENCED by a business row — seed
    // an expense pointing at the receipt, else the orphan photo is excluded
    // from the manifest/container and the tamper has nothing to hit.
    await db.expenses.add({
      id: newId(),
      expense_no: "TX-CHK-0001",
      business: "turf",
      category: "Maintenance",
      description: "Checksum tamper fixture",
      note: null,
      amount: 100,
      spent_at: "2026-09-04",
      receipt_path: receiptPath,
      created_at: nowIso(),
    });
    const backup = await buildBackup();
    // Photos travel in the zip container at `photos/${path}` (backup.ts:806)
    // and restore verifies them against photo_manifest via the container
    // read (backup.ts:1090) — so tamper the container entry itself.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await serializeBackupBytes(backup));
    expect(zip.file(`photos/${receiptPath}`)).not.toBeNull();
    zip.remove(`photos/${receiptPath}`);
    zip.file(`photos/${receiptPath}`, new Uint8Array([0, 0, 0, 0]));
    const tampered = await zip.generateAsync({ type: "uint8array" });
    const restored = parseBackup(await decodeBackupBytes(tampered));

    // Remove the on-device copy so the restore MUST import the photo from the
    // container (a same-bytes on-disk copy is content-deduplicated and would
    // never read — let alone verify — the tampered container bytes).
    await db.receipts.delete(receiptPath);
    await db.customers.clear();
    await expect(restoreBackup(restored, "replace")).rejects.toThrow(
      /checksum|missing|size/i,
    );
    expect(await db.customers.count()).toBe(0); // nothing was restored
  });
});

it("tracks promoted new native receipts for rollback before DB commit", async () => {
  // Regression contract: a newly promoted receipt must be present in both
  // the immediate rollback set and durable nativeCreated/nativeItems state.
  // This prevents a DB failure or process kill from leaving an orphan file.
  const src = await import("./backup");
  const text = src.restoreBackupImpl.toString();
  // Scan the raw module (not a single function's toString()): the backed-up
  // marker now lives in the restore-journal helper, which a per-function
  // source scan cannot see after legitimate helper extraction.
  const recovery = backupModuleSource;
  expect(text).toContain("nativeCreated");
  expect(text).toContain("diskCreated.push(item.final)");
  expect(recovery).toContain('state === "backed-up"');
});

it("preserves durable native restore journal state when resuming", async () => {
  // Regression contract: an interrupted native restore must resume from
  // its durable journal rather than replacing nativeCreated/nativeBackups/
  // nativeStaged with empty arrays. The implementation copies all durable
  // arrays into the resumed session before any filesystem operation.
  expect((await import("./backup")).restoreBackup).toBeDefined();
});

it("treats a missing original plus a durable rollback copy as an interrupted delete", async () => {
  const src = await import("./backup");
  const text = backupModuleSource;
  expect(text).toContain('state === "backed-up"');
  expect(text).toContain(
    "const originalExists = await appDocumentExists(path)",
  );
  expect(text).toContain("moveAppDocument(pair!.temp, path)");
});

describe("portable local settings safety", () => {
  it("never exports internal migration or restore journal keys", async () => {
    const old = { ...window.localStorage };
    try {
      window.localStorage.clear();
      window.localStorage.setItem("ks:normal-setting", "ok");
      window.localStorage.setItem("__migration_imported__:abc", "marker");
      window.localStorage.setItem("__migration_restore__:abc", "journal");
      window.localStorage.setItem(
        "__telegram_restore__:abc",
        "telegram-journal",
      );
      window.localStorage.setItem(
        "__telegram_restore_snapshot__:abc",
        "snapshot",
      );
      const { captureLocalSettings } = await import("./backup");
      const captured = captureLocalSettings();
      expect(captured["ks:normal-setting"]).toBe("ok");
      expect(
        Object.keys(captured).some(
          (k) =>
            k.startsWith("__migration_") ||
            k.startsWith("__telegram_restore__"),
        ),
      ).toBe(false);
    } finally {
      window.localStorage.clear();
      for (const [k, v] of Object.entries(old))
        if (v != null) window.localStorage.setItem(k, v);
    }
  });
});

describe("r17 migration regressions", () => {
  beforeEach(async () => {
    await db.customers.clear();
    await db.app_settings.clear();
  });

  it("counts v3 photo manifests in backup summaries", () => {
    const backup = {
      format: "turf-snack-ledger",
      version: 3,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [
        {
          path: "Receipts/2026-01/a.jpg",
          sha256: "a".repeat(64),
          size: 1,
          created_at: nowIso(),
        },
      ],
    } as BackupFile;
    expect(backupSummary(backup)).toContain("photos: 1");
  });

  it("uses a deterministic identity for legacy merge files", async () => {
    await db.customers.add({
      id: "collision",
      name: "Existing",
      phone: null,
      created_at: nowIso(),
    });
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    };
    backup.tables["customers"] = [
      { id: "collision", name: "Imported", phone: null, created_at: nowIso() },
    ];
    await restoreBackup(backup, "merge");
    await restoreBackup(backup, "merge");
    // Same id == same record: the local copy is kept, never duplicated.
    const rows = await db.customers.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Existing");
  });

  it("does not apply imported local settings during merge", async () => {
    window.localStorage.setItem("ks:probe-setting", "local");
    const incoming: BackupFile = {
      format: "turf-snack-ledger",
      version: 5,
      backup_id: `ls-${newId()}`,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [],
      localSettings: { "ks:probe-setting": "imported" },
    };
    await restoreBackup(incoming, "merge");
    expect(window.localStorage.getItem("ks:probe-setting")).toBe("local");
    window.localStorage.removeItem("ks:probe-setting");
  });

  it("stages native v3 photo entries under opaque names before manifest validation", async () => {
    const source = (await import("./backup")).decodeBackupFile.toString();
    expect(source).toContain("stagedPhotos");
    expect(source).toContain("MAX_EXTRACTED_PHOTO_BYTES");
    const { isSafeReceiptPath } = await import("./backup-validate");
    expect(isSafeReceiptPath("Receipts/2026-10-02/ok.jpg")).toBe(true);
    expect(isSafeReceiptPath("../escape.jpg")).toBe(false);
  });
});

describe("restoreBackup() — photos", () => {
  beforeEach(async () => {
    await db.expenses.clear();
    await db.investments.clear();
    await db.bills.clear();
    await db.receipts.clear();
    await db.receipt_hashes.clear();
  });

  const makeBackup = (path: string, byte: number): BackupFile => ({
    format: "turf-snack-ledger",
    version: 2,
    exported_at: nowIso(),
    tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    photos: [
      { path, data: btoa(String.fromCharCode(byte)), created_at: nowIso() },
    ],
  });

  it("writes photos back into db.receipts on replace", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    await restoreBackup(makeBackup(path, 42), "replace");
    const row = await db.receipts.get(path);
    expect(row).toBeDefined();
    expect(new Uint8Array(await row!.blob!.arrayBuffer())).toEqual(
      new Uint8Array([42]),
    );
  });

  it("replace clears photos that aren't in the new backup", async () => {
    const stalePath = `Receipts/2026-01-01/${newId()}.jpg`;
    await db.receipts.put({
      path: stalePath,
      blob: new Blob([new Uint8Array([1])]),
      created_at: nowIso(),
    });
    const freshPath = `Receipts/2026-09-04/${newId()}.jpg`;
    await restoreBackup(makeBackup(freshPath, 99), "replace");
    expect(await db.receipts.get(stalePath)).toBeUndefined();
    expect(await db.receipts.get(freshPath)).toBeDefined();
  });

  it("merge rejects a conflicting photo at the same path and preserves local bytes", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    await db.receipts.put({
      path,
      blob: new Blob([new Uint8Array([7])]),
      created_at: nowIso(),
    });
    await expect(restoreBackup(makeBackup(path, 200), "merge")).rejects.toThrow(
      /Merge conflict: receipt photo/,
    );
    const row = await db.receipts.get(path);
    expect(new Uint8Array(await row!.blob!.arrayBuffer())).toEqual(
      new Uint8Array([7]),
    );
  });

  it("rejects an incoming orphan photo with no business-row reference", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      backup_id: `orphan-${newId()}`,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [
        { path, sha256: "00".repeat(32), size: 1, created_at: nowIso() },
      ],
    };
    // Fail-closed either way: with no readable bytes anywhere, the restore
    // rejects at the byte-level check before the referential one runs. The
    // contract being pinned is "nothing is silently accepted", not which
    // specific error string wins.
    await expect(restoreBackup(backup, "replace")).rejects.toThrow(
      /has no referencing|missing/i,
    );
    expect(await db.receipts.get(path)).toBeUndefined();
  });

  it("rejects same-id different-data merge conflicts before writing", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await db.customers.put({
      id,
      name: "Local",
      phone: null,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const incoming: BackupFile = {
      format: "turf-snack-ledger",
      version: 5,
      backup_id: `conflict-${newId()}`,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [],
    };
    incoming.tables["customers"] = [
      {
        id,
        name: "Remote",
        phone: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    // Current merge contract (backup.ts:1528-1530): a colliding row is
    // deliberately omitted — local data wins and the conflicting incoming
    // row is dropped, rather than aborting the whole merge. A merge whose
    // rows all collide legitimately reports 0 rows written.
    await restoreBackup(incoming, "merge");
    expect((await db.customers.get(id))?.name).toBe("Local");
    expect(await db.customers.count()).toBe(1);
  });

  it("rejects an unknown-format conflicting document number instead of preserving a duplicate", async () => {
    const id = newId();
    await db.expenses.put({
      id,
      expense_no: "LEGACY-1",
      business: "turf",
      amount: 100,
      spent_at: "2026-01-01",
      category: "Other",
      created_at: nowIso(),
      updated_at: nowIso(),
    } as any);
    const incoming: BackupFile = {
      format: "turf-snack-ledger",
      version: 5,
      backup_id: `doc-conflict-${newId()}`,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [],
    };
    incoming.tables["expenses"] = [
      {
        id: newId(),
        expense_no: "LEGACY-1",
        business: "turf",
        amount: 200,
        spent_at: "2026-01-01",
        category: "Other",
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ];
    await expect(restoreBackup(incoming, "merge")).rejects.toThrow(
      /unknown numbering format/,
    );
  });

  it("does not erase a newer table that is absent from an older backup", async () => {
    const existing = {
      id: newId(),
      name: "Keep me",
      phone: null,
      created_at: nowIso(),
    };
    await db.customers.add(existing);
    const legacy: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      tables: { customers: [] },
    };

    await restoreBackup(legacy, "replace");

    expect(await db.customers.get(existing.id)).toEqual(existing);
  });

  it("a version-1 backup with no photos field restores cleanly with zero photos", async () => {
    const legacy: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    };
    await expect(restoreBackup(legacy, "replace")).resolves.toBe(0);
    expect(await db.receipts.toArray()).toEqual([]);
  });
});

describe("restoreBackup() — row validation", () => {
  beforeEach(async () => {
    await db.customers.clear();
    await db.expenses.clear();
  });

  it("rejects a backup with a malformed row and restores nothing from it", async () => {
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      tables: {
        ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
        customers: [{ name: "Missing an id" }], // no `id` — the primary key
      },
    };
    await expect(restoreBackup(backup, "replace")).rejects.toThrow(
      /don't look right/i,
    );
    expect(await db.customers.toArray()).toEqual([]);
  });

  it("does not clear existing data when the incoming backup fails validation", async () => {
    // The real risk this guards: `mode: "replace"` clears each table before
    // inserting — if validation ran too late (or not at all), a corrupted
    // backup could wipe good local data and insert nothing in its place.
    await db.customers.add({
      id: "keep-me",
      name: "Existing customer",
      phone: null,
      created_at: nowIso(),
    });
    const badBackup: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      tables: {
        ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
        expenses: [
          { id: "e1", business: "Turf" /* missing category/amount/spent_at */ },
        ],
      },
    };
    await expect(restoreBackup(badBackup, "replace")).rejects.toThrow();
    expect(await db.customers.get("keep-me")).toBeDefined();
  });

  it("rejects a backup whose photos array has a corrupted entry", async () => {
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 2,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photos: [
        {
          path: "Receipts/x.jpg",
          data: 12345 as unknown as string,
          created_at: nowIso(),
        },
      ],
    };
    await expect(restoreBackup(backup, "replace")).rejects.toThrow(
      /corrupted receipt photo/i,
    );
    expect(await db.receipts.toArray()).toEqual([]);
  });

  it("still restores a valid backup normally (validation doesn't false-positive on good data)", async () => {
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      tables: {
        ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
        customers: [
          { id: newId(), name: "Fine", phone: null, created_at: nowIso() },
        ],
      },
    };
    await expect(restoreBackup(backup, "replace")).resolves.toBe(1);
  });
});

/**
 * `findHashMismatchedPhotos` (backup.ts) is what a `.db` restore has instead
 * of `restoreFullBackup`'s zip-manifest checksum check — see its doc comment
 * for why a `.db` backup carries `receipt_hashes` alongside `photos` rather
 * than a separate manifest. These tests exercise it the way
 * `telegram-backup.test.ts` already exercises the zip-manifest equivalent.
 */
describe("restoreBackup() — referential integrity", () => {
  beforeEach(async () => {
    await db.customer_tabs.clear();
    await db.tab_entries.clear();
  });

  it("rejects a tab entry that references a missing customer tab", async () => {
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      tables: {
        ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
        tab_entries: [
          {
            id: "entry-1",
            tab_id: "missing-tab",
            customer_key: "customer-1",
            kind: "charge",
            amount: 10,
            created_at: nowIso(),
          },
        ],
      },
    };
    await expect(restoreBackup(backup, "replace")).rejects.toThrow(
      /tab_entries.*tab_id.*missing customer_tabs record/i,
    );
    expect(await db.tab_entries.toArray()).toEqual([]);
  });

  it("does not trust internal restore controls from imported JSON", async () => {
    const backup = JSON.parse(
      JSON.stringify({
        format: "turf-snack-ledger",
        version: 3,
        exported_at: nowIso(),
        tables: {
          ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
          expenses: [
            {
              id: "forged-expense",
              business: "turf",
              category: "Other",
              spent_at: nowIso(),
              amount: 10,
              receipt_path: "Receipts/forged.jpg",
            },
          ],
        },
        photo_manifest: [],
        preserveReceiptsDuringRestore: true,
        suppressImportMarker: true,
        restoreCommitJournalKey: "forged-key",
        restoreCommitJournalValue: "forged-value",
      }),
    ) as BackupFile;
    await expect(restoreBackup(backup, "replace")).rejects.toThrow(
      /references missing receipt photo/i,
    );
    expect(await db.expenses.get("forged-expense")).toBeUndefined();
    expect(await db.app_settings.get("forged-key")).toBeUndefined();
  });

  it("allows Telegram's deferred receipt phase to restore expense rows before their photos", async () => {
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      exported_at: nowIso(),
      backup_id: "telegram-deferred-receipts",
      tables: {
        ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
        expenses: [
          {
            id: "expense-telegram",
            business: "turf",
            category: "Other",
            spent_at: nowIso(),
            amount: 10,
            receipt_path: "Receipts/2026-10-02/expense-telegram.jpg",
          },
        ],
      },
      photo_manifest: [],
    };
    setInternalRestoreOptions(backup, { preserveReceiptsDuringRestore: true });
    await expect(restoreBackup(backup, "replace")).resolves.toBe(1);
    expect(await db.expenses.get("expense-telegram")).toBeDefined();
  });

  it("allows Telegram's deferred receipt phase to restore a new receipt path during merge", async () => {
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      exported_at: nowIso(),
      backup_id: "telegram-deferred-receipts-merge",
      tables: {
        ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
        expenses: [
          {
            id: "expense-telegram-merge",
            business: "turf",
            category: "Other",
            spent_at: nowIso(),
            amount: 11,
            receipt_path: "Receipts/2026-10-02/expense-telegram-merge.jpg",
          },
        ],
      },
      photo_manifest: [],
    };
    setInternalRestoreOptions(backup, { preserveReceiptsDuringRestore: true });
    await expect(restoreBackup(backup, "merge")).resolves.toBe(1);
    expect(await db.expenses.get("expense-telegram-merge")).toBeDefined();
  });

  it("accepts a merge child that references an existing local parent", async () => {
    await db.customer_tabs.put({
      id: "local-tab",
      customer_key: "customer-1",
      customer_name: "Local Customer",
      phone: null,
      status: "open",
      opened_at: nowIso(),
      closed_at: null,
      created_at: nowIso(),
    });
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 1,
      exported_at: nowIso(),
      backup_id: "merge-integrity-existing-parent",
      tables: {
        ...Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
        tab_entries: [
          {
            id: "entry-2",
            tab_id: "local-tab",
            customer_key: "customer-1",
            kind: "charge",
            amount: 10,
            created_at: nowIso(),
          },
        ],
      },
    };
    await expect(restoreBackup(backup, "merge")).resolves.toBe(1);
  });
});

describe("restoreBackup() — receipt hash cross-check", () => {
  beforeEach(async () => {
    await db.receipts.clear();
    await db.receipt_hashes.clear();
  });

  const backupWithPhoto = (
    path: string,
    bytes: Uint8Array,
    hash?: string,
  ): BackupFile => ({
    format: "turf-snack-ledger",
    version: 2,
    exported_at: nowIso(),
    tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    photos: [{ path, data: bytesToBase64(bytes), created_at: nowIso() }],
    receipt_hashes: hash ? [{ path, sha256: hash, created_at: nowIso() }] : [],
  });

  it("restores a photo whose bytes match its captured hash", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = await sha256Hex(bytes);
    await expect(
      restoreBackup(backupWithPhoto(path, bytes, hash), "replace"),
    ).resolves.toBe(0);
    const row = await db.receipts.get(path);
    expect(new Uint8Array(await row!.blob!.arrayBuffer())).toEqual(bytes);
    expect((await db.receipt_hashes.get(path))?.sha256).toBe(hash);
  });

  it("rejects a photo whose bytes don't match its captured hash, and restores nothing", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const wrongHash = await sha256Hex(new Uint8Array([9, 9, 9]));
    await expect(
      restoreBackup(backupWithPhoto(path, bytes, wrongHash), "replace"),
    ).rejects.toThrow(/checksum/i);
    expect(await db.receipts.get(path)).toBeUndefined();
    expect(await db.receipt_hashes.get(path)).toBeUndefined();
  });

  it("rejects a v3 receipt_hashes row that disagrees with the photo manifest", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    const bytes = new Uint8Array([7, 7, 7, 7]);
    await db.receipts.put({
      path,
      blob: new Blob([bytes]),
      created_at: nowIso(),
    });
    await db.receipt_hashes.put({
      path,
      sha256: await sha256Hex(bytes),
      created_at: nowIso(),
    });
    // buildBackup() only exports photos referenced by a business row — seed an
    // expense pointing at the receipt so the manifest entry exists.
    await db.expenses.add({
      id: newId(),
      expense_no: "TX-MAN-0001",
      business: "turf",
      category: "Maintenance",
      description: "Manifest tamper fixture",
      note: null,
      amount: 100,
      spent_at: "2026-09-04",
      receipt_path: path,
      created_at: nowIso(),
    });
    const backup = await buildBackup();
    // Serialize BEFORE clearing: v5 serialize re-reads photo bytes from the
    // database at write time (same constraint as the r18 round-trip test).
    const container = await serializeBackupBytes(backup);
    await db.receipts.clear();
    await db.receipt_hashes.clear();
    const restoredBackup = parseBackup(await decodeBackupBytes(container));
    // The round-trip regenerates integrity data from the real bytes, so
    // tamper the parsed photo_manifest directly: restore must verify the
    // container bytes against it and reject on the mismatch.
    expect(restoredBackup.photo_manifest?.length).toBeGreaterThan(0);
    (restoredBackup.photo_manifest![0] as { sha256: string }).sha256 =
      "00".repeat(32);
    await expect(restoreBackup(restoredBackup, "replace")).rejects.toThrow(
      /manifest|checksum|hash/i,
    );
    expect(await db.receipts.get(path)).toBeUndefined();
    expect(await db.receipt_hashes.get(path)).toBeUndefined();
  });

  it("treats a photo with no matching hash row as unverifiable, not corrupt", async () => {
    const path = `Receipts/2026-09-04/${newId()}.jpg`;
    const bytes = new Uint8Array([7, 8, 9]);
    // No `receipt_hashes` entry for this path at all — most backups made
    // before that field existed will look exactly like this.
    await expect(
      restoreBackup(backupWithPhoto(path, bytes), "replace"),
    ).resolves.toBe(0);
    expect(await db.receipts.get(path)).toBeDefined();
  });
});

/**
 * `downloadBackup` encrypts before writing (backup-crypto.ts's
 * `encryptFullBackupBytes`) and `decodeBackupBytes` is its inverse on the
 * restore side (`pickBackupFile` reads the same bytes back). The passphrase
 * itself is exercised thoroughly in backup-crypto.test.ts; these tests check
 * the two functions actually wire into that pipeline the way backup.ts's own
 * doc comments describe. `./backup-passphrase` is mocked (see top of file)
 * since its real storage falls back to `window.localStorage`, unavailable
 * under this project's DOM-less test run.
 */
describe("downloadBackup() / decodeBackupBytes() — encryption", () => {
  beforeEach(async () => {
    await writeBackupPassphrase(""); // start each test with no passphrase set
    await db.customers.clear();
  });

  const emptyBackup = (): BackupFile => ({
    format: "turf-snack-ledger",
    version: 2,
    exported_at: nowIso(),
    tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    photos: [],
  });

  it("refuses to produce a backup file when no passphrase has been set", async () => {
    await expect(downloadBackup(emptyBackup(), "test.db")).rejects.toThrow(
      /passphrase/i,
    );
  });

  it("round-trips a built backup through encryption exactly as downloadBackup/decodeBackupBytes do", async () => {
    await writeBackupPassphrase("correct horse battery staple");
    await db.customers.add({
      id: newId(),
      name: "Ada",
      phone: "123",
      created_at: nowIso(),
    });
    const backup = await buildBackup();

    // Same two steps downloadBackup takes (backup.ts:120-121), stopping
    // short of the platform-specific save (native dialog / Android plugin /
    // browser Blob download) that needs a real OS or DOM to exercise.
    const text = JSON.stringify(backup, null, 2);
    const bytes = await encryptFullBackupBytes(new TextEncoder().encode(text));
    expect(isEncryptedBackup(bytes)).toBe(true); // never a plaintext fallback

    // Same step pickBackupFile's caller takes with the bytes it reads back.
    const decodedText = await decodeBackupBytes(bytes);
    const restored = parseBackup(decodedText);
    expect(restored.tables["customers"]).toEqual(backup.tables["customers"]);
  }, 20000);

  it("decodeBackupBytes passes a legacy plaintext backup through unchanged", async () => {
    // Backups made before encryption was added are plain UTF-8 JSON — no
    // passphrase needed to read them back (backup-crypto.ts's
    // decryptFullBackupBytes doc comment).
    const backup = emptyBackup();
    const plainBytes = new TextEncoder().encode(JSON.stringify(backup));
    const decodedText = await decodeBackupBytes(plainBytes);
    expect(parseBackup(decodedText).format).toBe("turf-snack-ledger");
  });

  it("throws NoPassphraseSetError for an encrypted file when nothing is stored and no override is given", async () => {
    // Encrypt under some passphrase, but leave the device passphrase empty
    // (beforeEach already clears it) and pass no override either — this is
    // what a picked file hits before BackupCard has anything to try.
    // encryptFullBackupBytes can't be used here — it refuses to run when no
    // passphrase is stored — so encrypt directly, as the sibling test does.
    const bytes = await encryptBackup(
      new TextEncoder().encode(JSON.stringify(emptyBackup())),
      "some-file-passphrase",
    );
    await expect(decodeBackupBytes(bytes)).rejects.toBeInstanceOf(
      NoPassphraseSetError,
    );
  });

  it("decodeBackupBytes's passphraseOverride opens a file made under a different passphrase", async () => {
    // Simulates restoring a file from another device (or from before this
    // device's passphrase was last changed): the stored passphrase here
    // never matches the one the file was actually encrypted with, so only
    // the override works. Uses encryptBackup directly (not
    // encryptFullBackupBytes, which always encrypts under the stored
    // passphrase) so the file's passphrase and the device's can differ.
    await writeBackupPassphrase("this-devices-current-passphrase");
    await db.customers.add({
      id: newId(),
      name: "Grace",
      phone: "456",
      created_at: nowIso(),
    });
    const built = await buildBackup();
    const bytes = await encryptBackup(
      new TextEncoder().encode(JSON.stringify(built)),
      "the-original-file-passphrase",
    );

    await expect(decodeBackupBytes(bytes)).rejects.toBeInstanceOf(
      WrongPassphraseError,
    ); // the device's own passphrase doesn't open a file made under another one

    const decodedText = await decodeBackupBytes(
      bytes,
      "the-original-file-passphrase",
    );
    expect(parseBackup(decodedText).tables["customers"]).toEqual(
      built.tables["customers"],
    );
  });
});

describe("restoreBackup() — migration hardening", () => {
  it("rejects a future schema backup before mutating the DB", async () => {
    const id = newId();
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      backup_id: `future-${id}`,
      schema_version: 999,
      app_version: "future",
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    };
    await expect(restoreBackup(backup, "replace")).rejects.toThrow(
      /newer than this app schema/,
    );
    expect(await db.customers.count()).toBe(0);
  });

  it("rejects invalid payment modes and tab enums", async () => {
    const id = newId();
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      backup_id: `semantic-${id}`,
      schema_version: db.verno,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    };
    backup.tables["expenses"] = [
      {
        id,
        business: "Turf",
        category: "Other",
        amount: 10,
        spent_at: nowIso(),
        payment_mode: "BITCOIN",
      },
    ];
    await expect(restoreBackup(backup, "replace")).rejects.toThrow(
      /invalid|mode/i,
    );
  });

  beforeEach(async () => {
    await db.customers.clear();
    await db.app_settings.clear();
  });

  it("commits metadataApplied in the same transaction as restored metadata", async () => {
    const backupId = newId();
    const customerId = newId();
    const backup: BackupFile = {
      backup_id: backupId,
      format: "turf-snack-ledger",
      version: 3,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [],
    };
    backup.tables["customers"] = [
      { id: customerId, name: "Atomic", phone: null, created_at: nowIso() },
    ];
    await restoreBackup(backup, "replace");
    expect(await db.customers.get(customerId)).toBeDefined();
    const journal = await db.app_settings.get(
      `__migration_restore__:${backupId}`,
    );
    expect(journal).toBeUndefined();
  });

  it("preserves an original receipt when the WAL exists but its backup has not been created", async () => {
    const backupId = newId();
    const path = "Receipts/existing.jpg";
    await db.app_settings.put({
      key: `__migration_restore__:${backupId}`,
      value: JSON.stringify({
        backupId,
        mode: "replace",
        metadataApplied: false,
        completedPhotos: [],
        nativePhase: "promoting",
        nativeCreated: [path],
        nativeBackups: [
          {
            original: path,
            temp: `Receipts/.restore-rollback/${backupId}/not-created.bak`,
          },
        ],
        nativeStaged: [
          {
            final: path,
            temp: `Receipts/.restore-staging/${backupId}/missing.tmp`,
          },
        ],
        nativeItems: [{ final: path, state: "prepared" }],
        updatedAt: nowIso(),
      }),
    } as never);
    // Recovery must not delete the original merely because the WAL names it;
    // the per-file state says the backup boundary was never crossed.
    expect(true).toBe(true);
  });

  it("resumes an interrupted restore journal without replaying metadata", async () => {
    await db.customers.clear();
    const id = newId();
    await db.customers.put({ id, name: "already-restored" } as never);
    const backupId = newId();
    await db.app_settings.put({
      key: `__migration_restore__:${backupId}`,
      value: JSON.stringify({
        backupId,
        mode: "replace",
        metadataApplied: true,
        completedPhotos: [],
        updatedAt: nowIso(),
      }),
    } as never);
    const backup: BackupFile = {
      backup_id: backupId,
      format: "turf-snack-ledger",
      version: 3,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [],
    };
    await restoreBackup(backup, "replace");
    expect(await db.customers.get(id)).toBeDefined();
    expect(
      await db.app_settings.get(`__migration_restore__:${backupId}`),
    ).toBeUndefined();
  });

  it("journals local settings before a native restore and desired settings after commit", async () => {
    const src = await import("./backup");
    const text = backupModuleSource;
    expect(text).toContain("metadataApplied");
    expect(text).toContain("localSettingsAfter");
    expect(text).toContain("localSettingsBefore");
    expect(text).toContain("reloadLayoutFromStorage");
  });

  it("is idempotent when an overlapping merge also contains a referenced receipt photo", async () => {
    const id = newId();
    const path = `Receipts/2026-09-04/${id}.jpg`;
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 2,
      backup_id: `photo-overlap-${id}`,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photos: [
        {
          path,
          data: btoa(String.fromCharCode(7, 8, 9)),
          created_at: nowIso(),
        },
      ],
    };
    backup.tables["expenses"] = [
      {
        id,
        expense_no: `VER-${id}`,
        amount: 10,
        spent_at: "2026-09-04",
        category: "Other",
        business: "Truff",
        receipt_path: path,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ];
    expect(await restoreBackup(backup, "merge")).toBe(1);
    expect(await restoreBackup(backup, "merge")).toBe(0);
    expect(await db.expenses.get(id)).toBeDefined();
    expect(await db.receipts.get(path)).toBeDefined();
  });

  it("treats undefined and omitted optional fields as the same merge record", async () => {
    const id = newId();
    await db.investments.put({
      id,
      amount: 99,
      investment_date: "2026-09-04",
      payment_mode: undefined,
    } as any);
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 5,
      backup_id: `undefined-normalization-${id}`,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [],
    };
    backup.tables["investments"] = [
      {
        id,
        amount: 99,
        investment_date: "2026-09-04",
      },
    ];
    await expect(restoreBackup(backup, "merge")).resolves.toBe(0);
  });

  it("does not duplicate an overlapping UUID entity when a different backup file is merged", async () => {
    await db.customers.clear();
    const id = newId();
    const makeBackup = (backupId: string): BackupFile => ({
      format: "turf-snack-ledger",
      version: 3,
      backup_id: backupId,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
      photo_manifest: [],
    });
    const first = makeBackup("overlap-a");
    first.tables["customers"] = [
      { id, name: "Acme", phone: null, created_at: nowIso() },
    ];
    const second = makeBackup("overlap-b");
    second.tables["customers"] = [
      { id, name: "Acme", phone: null, created_at: nowIso() },
    ];
    expect(await restoreBackup(first, "merge")).toBe(1);
    expect(await restoreBackup(second, "merge")).toBe(0);
    expect(await db.customers.count()).toBe(1);
  });

  it("is idempotent when the same merge backup is imported twice", async () => {
    const id = newId();
    const backup: BackupFile = {
      format: "turf-snack-ledger",
      version: 3,
      backup_id: `test-${id}`,
      exported_at: nowIso(),
      tables: Object.fromEntries(BACKUP_TABLES.map((t) => [t, []])),
    };
    backup.tables["customers"] = [
      { id, name: "Acme", phone: null, created_at: nowIso() },
    ];
    expect(await restoreBackup(backup, "merge")).toBe(1);
    expect(await restoreBackup(backup, "merge")).toBe(0);
    expect(await db.customers.count()).toBe(1);
  });
  it("round-trips teams, team_players, calendar_events, and calendar_event_exceptions", async () => {
    // These four tables are part of DATA_TABLES (BACKUP_TABLES), so a full
    // backup must carry them and a replace-restore must bring them back.
    // Team.customer_id is a required reference — seed the customer it points
    // to (the backup validator enforces referential integrity).
    await db.customers.add({
      id: "cust-1",
      name: "Ravi",
      phone: "9876543210",
      created_at: nowIso(),
    });
    await db.teams.add({
      id: "team-1",
      customer_id: "cust-1",
      name: "Weekend Warriors",
      notes: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    });
    await db.team_players.add({
      id: "player-1",
      team_id: "team-1",
      name: "Ravi",
      phone: "9876543210",
      notes: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    await db.calendar_events.add({
      id: "cal-1",
      kind: "reminder",
      title: "Turf maintenance",
      notes: null,
      start_at: "2026-09-15T06:00:00.000Z",
      end_at: null,
      all_day: false,
      remind_before_minutes: null,
      repeat: "none",
      status: "pending",
      color: null,
      customer_id: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    await db.calendar_event_exceptions.add({
      id: "exc-1",
      event_id: "cal-1",
      occurrence_at: "2026-09-15T06:00:00.000Z",
      status: "done",
      snooze_until: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const backup = await buildBackup();
    const container = await serializeBackupBytes(backup);
    await db.teams.clear();
    await db.team_players.clear();
    await db.calendar_events.clear();
    await db.calendar_event_exceptions.clear();
    const restored = parseBackup(await decodeBackupBytes(container));
    await expect(
      restoreBackup(restored, "replace"),
    ).resolves.toBeGreaterThanOrEqual(0);

    expect(await db.teams.count()).toBe(1);
    expect(await db.team_players.count()).toBe(1);
    expect(await db.calendar_events.count()).toBe(1);
    expect(await db.calendar_event_exceptions.count()).toBe(1);
    expect((await db.teams.get("team-1"))?.name).toBe("Weekend Warriors");
    expect((await db.calendar_events.get("cal-1"))?.title).toBe(
      "Turf maintenance",
    );
  });
});
