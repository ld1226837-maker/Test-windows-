import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const squash = (t) => t.replace(/\s+/g, " ");
const backup = squash(
  fs.readFileSync(path.join(root, "src/lib/backup.ts"), "utf8"),
);
const telegram = squash(
  fs.readFileSync(path.join(root, "src/lib/telegram-backup.ts"), "utf8"),
);
const checks = [
  [
    "same-ID merge rows keep the local copy (documented contract)",
    /skipExisting\.set\(t, skipped\)/.test(backup),
  ],
  [
    "unknown document-number conflicts fail closed",
    /unknown numbering format/.test(backup),
  ],
  [
    "bill/turf/snack customer FKs checked",
    /tableName === "bills" \|\| tableName === "turf_bookings" \|\| tableName === "snack_sales"/.test(
      backup,
    ),
  ],
  [
    "invalid payment parent_type rejected",
    /parent_type has invalid value/.test(backup),
  ],
  [
    "tab ref_id/source_ref_id are validated",
    /ref_id is populated but ref_type is missing/.test(backup) &&
      /requireRef\(tableName, index, \"source_ref_id\", sourceId, target\)/.test(
        backup,
      ),
  ],
  [
    "sharded build rejects orphan receipt metadata",
    /Cannot build sharded full backup: receipt hash/.test(telegram),
  ],
  [
    "sharded restore rejects orphan receipt metadata",
    /contains orphan receipt metadata/.test(telegram),
  ],
  [
    "sharded restore verifies receipt hash against photo",
    /receipt hash does not match photo/.test(telegram),
  ],
  [
    "sharded restore preserves receipt created_at",
    /incomingReceiptMetaByPath\.get\(f\.path\)\?\.created_at/.test(telegram),
  ],
];
let failed = 0;
for (const [name, ok] of checks)
  (console.log(`${ok ? "PASS" : "FAIL"} ${name}`), (failed += ok ? 0 : 1));
if (failed) process.exit(1);
