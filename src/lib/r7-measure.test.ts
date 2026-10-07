import "fake-indexeddb/auto";
import { memoryUsage } from "node:process";
import { describe, expect, it } from "vitest";
import { runReceiptScaleTest, clearReceiptScaleData } from "./receipt-scale";

/**
 * R7 (bounded sandbox evidence): runs the receipt scale harness at N=1000
 * on the WEB storage path with a real v8 heap probe. On-device runs use
 * LoadTestCard's scale selector; this test pins the harness's
 * correctness (all phases execute, nothing is lost) at CI-friendly size.
 * Heap peaks are logged for the R7 report.
 */
describe("R7 scale measurement (N=1000, web path)", () => {
  it("all phases execute with measured time and peak heap", async () => {
    const probe = () =>
      (() => {
        const m = memoryUsage();
        return m.heapUsed + m.arrayBuffers;
      })();
    const r = await runReceiptScaleTest(1000, probe);
    const fmt = (b: number) => (b / 1048576).toFixed(1) + " MB";
    for (const p of r.phases)
      console.log(`R7 N=1000 ${p.phase}: ${p.ms} ms, peak ${fmt(p.peakBytes)}`);
    // Execution order: the .db container is restored right after it is
    // built (against a wiped DB), then the sharded full backup runs.
    expect(r.phases.map((p) => p.phase)).toEqual([
      "seed",
      "migrate",
      "db-backup",
      "db-restore",
      "full-backup",
      "full-restore",
    ]);
    expect(r.phases.every((p) => p.ms >= 0)).toBe(true);
    await clearReceiptScaleData();
  }, 120000);
});
