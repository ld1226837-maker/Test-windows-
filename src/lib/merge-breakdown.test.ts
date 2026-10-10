import { describe, expect, it } from "vitest";
import { mergedBillBreakdown, type MergedBreakdown } from "./merge-breakdown";

const bd = (
  snackPaid: number,
  adv = 320,
  over: Partial<MergedBreakdown> = {},
): MergedBreakdown => ({
  v: 1,
  turf_items: 1,
  turf_advance: adv,
  snacks: [{ bill_no: "SNK-1", items: 1, amount: 120, paid: snackPaid }],
  ...over,
});
const view = (b: MergedBreakdown | null | undefined, paid: number, n = 2) =>
  mergedBillBreakdown({ breakdown: b, paid, grandTotal: 2280, itemCount: n });

describe("mergedBillBreakdown (display-only split of paid)", () => {
  it("Case A: snacks paid -> Advance 320, Snacks paid 120, balance 1840", () => {
    const r = view(bd(120), 440)!;
    expect([r.advancePaid, r.snacksPaid, r.balanceDue]).toEqual([320, 120, 1840]);
    expect(r.groups.map((g) => g.kind)).toEqual(["turf", "snack"]);
  });
  it("Case B: snacks unpaid -> no Snacks paid, balance 1960", () => {
    const r = view(bd(0), 320)!;
    expect([r.advancePaid, r.snacksPaid, r.balanceDue]).toEqual([320, 0, 1960]);
  });
  it("partly paid snack shows only the paid part", () => {
    const r = view(bd(60), 380)!;
    expect([r.advancePaid, r.snacksPaid, r.balanceDue]).toEqual([320, 60, 1900]);
  });
  it("no snacks / no advance / fully settled later", () => {
    const none = mergedBillBreakdown({
      breakdown: { v: 1, turf_items: 1, turf_advance: 320, snacks: [] },
      paid: 320,
      grandTotal: 2160,
      itemCount: 1,
    })!;
    expect([none.advancePaid, none.snacksPaid, none.balanceDue]).toEqual([320, 0, 1840]);
    const noAdv = view(bd(120, 0), 120)!;
    expect([noAdv.advancePaid, noAdv.snacksPaid]).toEqual([0, 120]);
    const settled = view(bd(120), 2280)!;
    expect([settled.advancePaid, settled.snacksPaid, settled.balanceDue]).toEqual([320, 120, 0]);
  });
  it("never shows more than was paid", () => {
    const r = view(bd(120), 200)!;
    expect(r.advancePaid + r.snacksPaid).toBeLessThanOrEqual(200);
  });
  it("legacy / mismatched breakdown -> null (print the old way)", () => {
    expect(view(undefined, 440)).toBeNull();
    expect(view(null, 440)).toBeNull();
    expect(view(bd(120), 440, 3)).toBeNull();
  });
});
