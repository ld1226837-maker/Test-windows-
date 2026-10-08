// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  forgetAllTelegramPointers,
  isMessageGoneError,
  readLastUpload,
  BACKUP_MESSAGE_MISSING,
} from "../telegram-backup";

describe("cleared Telegram chat", () => {
  beforeEach(() => localStorage.clear());
  it("forgets every remembered message number", () => {
    localStorage.setItem(
      "ks:telegram-backup-last",
      JSON.stringify({ session: "s", total: 1, messageIds: [5], at: "" }),
    );
    localStorage.setItem("ks:telegram-backup-history", "[]");
    localStorage.setItem("ks:other", "keep");
    forgetAllTelegramPointers();
    expect(readLastUpload()).toBeNull();
    expect(localStorage.getItem("ks:telegram-backup-history")).toBeNull();
    expect(localStorage.getItem("ks:other")).toBe("keep");
  });
  it("recognises deleted-message errors", () => {
    expect(isMessageGoneError(new Error(BACKUP_MESSAGE_MISSING))).toBe(true);
    expect(
      isMessageGoneError(
        new Error(
          "Telegram refused the request: Bad Request: message to delete not found",
        ),
      ),
    ).toBe(true);
    expect(isMessageGoneError(new Error("network down"))).toBe(false);
  });
});
