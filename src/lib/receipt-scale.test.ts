// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

// R11: the production-scale sharded benchmark must use a pull-based source,
// not retain every generated shard in an in-memory array.
describe("receipt scale bounded shard storage", () => {
  it("uses off-heap shard persistence for the full restore path", async () => {
    const src = await import("./receipt-scale");
    expect(src.runReceiptScaleTest.toString()).toContain(
      "collectShards: false",
    );
    expect(src.runReceiptScaleTest.toString()).toContain("readAppDocument");
    expect(src.runReceiptScaleTest.toString()).toContain("removeAppDocument");
  });
});
