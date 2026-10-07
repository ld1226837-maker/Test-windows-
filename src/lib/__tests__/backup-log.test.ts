import { describe, expect, it } from "vitest";
import { errorCodeFor, redact } from "../backup-log";

describe("backup log redaction", () => {
  it("masks realistic bot tokens and chat ids", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd_123";
    const out = redact(`token=${token} chat=-1001234567890`);
    expect(out).not.toContain(token);
    expect(out).not.toContain("-1001234567890");
    expect(out).toContain("123456…:");
  });
  it("does not echo secrets in password fields", () => {
    expect(redact("passphrase: SuperSecret123")).toContain("[redacted]");
    expect(redact("wrong passphrase hunter2 given")).not.toContain("hunter2");
  });
  it("redacts bot tokens embedded in Telegram URLs without corrupting ordinary sizes", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd_123";
    const out = redact(
      `fetch failed https://api.telegram.org/bot${token}/sendDocument; 4194304 bytes; 1234567ms`,
    );
    expect(out).not.toContain(token);
    expect(out).toContain("4194304 bytes");
    expect(out).toContain("1234567ms");
  });
  it("redacts prose passphrases, quoted values, positive chat ids and auth headers", () => {
    const samples = [
      "passphrase hunter2 given",
      "passphrase is hunter2",
      'password: "hunter 2 is long"',
      'passphrase: "my secret phrase here"',
      "chat 987654321 not found",
      '"chat_id": "-1001234567890"',
      "Authorization: Bearer super-secret-value",
      "Bearer another-secret-value",
      "Authorization: token-abc-secret-9",
      "Authorization: Basic dXNlcjpwYXNz-secret",
    ];
    for (const sample of samples) {
      const out = redact(sample);
      expect(out).not.toContain("hunter2");
      expect(out).not.toContain("hunter 2 is long");
      expect(out).not.toContain("my secret phrase here");
      expect(out).not.toContain("987654321");
      expect(out).not.toContain("-1001234567890");
      expect(out).not.toContain("super-secret-value");
      expect(out).not.toContain("another-secret-value");
      expect(out).not.toContain("token-abc-secret-9");
      expect(out).not.toContain("dXNlcjpwYXNz-secret");
      expect(out).toContain("[redacted]");
    }
  });

  it("preserves ordinary byte counts and durations", () => {
    expect(redact("4194304 bytes; duration 1234567ms")).toBe(
      "4194304 bytes; duration 1234567ms",
    );
  });

  it("maps stable operation error codes", () => {
    expect(errorCodeFor("HTTP 429 Too Many Requests")).toBe("telegram-429");
    expect(errorCodeFor("Wrong passphrase")).toBe("bad-passphrase");
    expect(errorCodeFor("Permission denied")).toBe("permission-denied");
  });
});
