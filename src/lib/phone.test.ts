import { describe, expect, it } from "vitest";
import { parsePhone, telUrl, waMeUrl, whatsappNumber } from "./phone";

describe("Indian phone normalisation", () => {
  it.each([
    "9876543210",
    "98765 43210",
    "98765-43210",
    "(98765) 43210",
    "09876543210",
    "919876543210",
    "91 98765 43210",
    "+91 98765 43210",
    "+91-9876543210",
    "0091 9876543210",
    "\u200e+91 98765\u00a043210",
    "९८७६५४३२१०",
    "௯௮௭௬௫௪௩௨௧௦",
  ])("normalises %j to +919876543210", (raw) => {
    expect(telUrl(raw)).toBe("tel:+919876543210");
    expect(whatsappNumber(raw)).toBe("919876543210");
  });

  it("treats Chennai landlines as dialable but not WhatsApp-able", () => {
    expect(telUrl("044 2812 3456")).toBe("tel:+914428123456");
    expect(telUrl("4428123456")).toBe("tel:+914428123456");
    expect(whatsappNumber("044 2812 3456")).toBeNull();
    expect(parsePhone("4428123456")?.kind).toBe("landline");
  });

  it("keeps non-Indian numbers as-is", () => {
    expect(telUrl("+44 20 7946 0958")).toBe("tel:+442079460958");
    expect(whatsappNumber("+44 20 7946 0958")).toBe("442079460958");
  });

  it.each(["", null, undefined, "98765", "0123456789", "12345678901234567"])(
    "rejects %j",
    (raw) => {
      expect(telUrl(raw)).toBeNull();
      expect(whatsappNumber(raw)).toBeNull();
    },
  );

  it("encodes the WhatsApp message (₹, newlines, & and #)", () => {
    expect(waMeUrl("9876543210", "Hi ₹1,23,456\n& #1")).toBe(
      "https://wa.me/919876543210?text=Hi%20%E2%82%B91%2C23%2C456%0A%26%20%231",
    );
  });

  it("falls back to the generic share link without a usable mobile", () => {
    expect(waMeUrl(null, "hi")).toBe("https://wa.me/?text=hi");
  });
});
