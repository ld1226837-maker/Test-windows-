import { describe, expect, it } from "vitest";
import { comparePhoneForSort, normalizePhoneSortKey } from "./phone-sort";

describe("phone sorting", () => {
  it("normalizes common Indian phone representations to the same 10-digit key", () => {
    const expected = "9876543210";
    expect(normalizePhoneSortKey("9876543210")).toBe(expected);
    expect(normalizePhoneSortKey("+91 98765-43210")).toBe(expected);
    expect(normalizePhoneSortKey("0091 98765 43210")).toBe(expected);
    expect(normalizePhoneSortKey("09876543210")).toBe(expected);
  });

  it("sorts phone numbers numerically, not lexicographically", () => {
    const values = ["9876543210", "9000000000", "9123456789"];
    expect(
      [...values].sort((a, b) => comparePhoneForSort(a, b, "asc")),
    ).toEqual(["9000000000", "9123456789", "9876543210"]);
  });

  it("sorts descending while keeping missing numbers at the end", () => {
    const values = ["", "9876543210", null, "9000000000"];
    expect(
      [...values].sort((a, b) => comparePhoneForSort(a, b, "desc")),
    ).toEqual(["9876543210", "9000000000", "", null]);
  });

  it("keeps missing numbers at the end", () => {
    const values = ["9876543210", "", null, "9000000000"];
    expect(
      [...values].sort((a, b) => comparePhoneForSort(a, b, "asc")),
    ).toEqual(["9000000000", "9876543210", "", null]);
  });
});
