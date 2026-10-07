import { describe, expect, it } from "vitest";
import { encodePairingPayload, parseTelegramScan } from "../telegram-backup";

const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd_123";

describe("parseTelegramScan", () => {
  it("accepts the app pairing JSON", () => {
    const payload = encodePairingPayload({
      botToken: token,
      chatId: "-1001234567890",
      extraBotTokens: [],
      deviceLabel: "Test",
    });
    expect(parseTelegramScan(payload).chatId).toBe("-1001234567890");
  });
  it("accepts a bare token", () =>
    expect(parseTelegramScan(token).botToken).toBe(token));
  it("accepts token/chat separator formats", () => {
    expect(parseTelegramScan(`${token}|-1001234567890`).chatId).toBe(
      "-1001234567890",
    );
    expect(parseTelegramScan(`${token},-1001234567890`).chatId).toBe(
      "-1001234567890",
    );
    expect(parseTelegramScan(`${token} -1001234567890`).chatId).toBe(
      "-1001234567890",
    );
    expect(parseTelegramScan(`${token}\n-1001234567890`).chatId).toBe(
      "-1001234567890",
    );
  });
  it("accepts Telegram API URLs", () =>
    expect(
      parseTelegramScan(`https://api.telegram.org/bot${token}/getMe`).botToken,
    ).toBe(token));
  it("accepts a bare chat id", () =>
    expect(parseTelegramScan("-1001234567890").chatId).toBe("-1001234567890"));
  it("normalizes zero-width characters and surrounding quotes", () =>
    expect(parseTelegramScan(`\u200B"${token}"\uFEFF`).botToken).toBe(token));
  it("accepts whitespace around valid details and rejects unicode lookalikes", () => {
    expect(parseTelegramScan(`  "${token}"  `).botToken).toBe(token);
    const lookalike = "１２３４５６７:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd_123";
    expect(() => parseTelegramScan(lookalike)).toThrow(
      "That code doesn't look like Telegram bot details",
    );
  });
  it("rejects short/malformed tokens, unrelated URLs and junk without echoing input", () => {
    for (const value of [
      "123:short",
      "123456:too-short",
      "https://example.com/x",
      "x".repeat(10000),
      "１２３４５６:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
    ]) {
      expect(() => parseTelegramScan(value)).toThrow(
        "That code doesn't look like Telegram bot details",
      );
      try {
        parseTelegramScan(value);
      } catch (e) {
        expect(String(e)).not.toContain(value);
      }
    }
  });
  it("takes only the token (and an explicit chat_id) from API URLs with a query string", () => {
    expect(
      parseTelegramScan(`https://api.telegram.org/bot${token}?x=1`).botToken,
    ).toBe(token);
    const r = parseTelegramScan(
      `https://api.telegram.org/bot${token}/sendMessage?chat_id=-1001234567890&text=hi`,
    );
    expect(r.botToken).toBe(token);
    expect(r.chatId).toBe("-1001234567890");
  });
  it("never echoes scanned text in its error", () => {
    const secret = "https://evil.example/?t=" + token;
    try {
      parseTelegramScan(secret);
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).not.toContain(token);
    }
  });
});
