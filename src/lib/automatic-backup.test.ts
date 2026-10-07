import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backupReminderDue: vi.fn(),
  readAppSettings: vi.fn(),
  writeAppSettings: vi.fn(),
  readTelegramConfig: vi.fn(),
  uploadShardedFullBackup: vi.fn(),
}));

vi.mock("./settings", () => ({
  backupReminderDue: mocks.backupReminderDue,
  readAppSettings: mocks.readAppSettings,
  writeAppSettings: mocks.writeAppSettings,
}));
vi.mock("./telegram-backup", () => ({
  readTelegramConfig: mocks.readTelegramConfig,
  uploadShardedFullBackup: mocks.uploadShardedFullBackup,
}));

describe("runAutomaticBackupIfDue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.readAppSettings.mockReturnValue({
      backupReminder: "daily",
      automaticBackup: true,
      lastBackupAt: null,
    });
    mocks.backupReminderDue.mockReturnValue(true);
    mocks.readTelegramConfig.mockResolvedValue({
      botToken: "bot",
      chatId: "chat",
      extraBotTokens: [],
      deviceLabel: "device",
    });
    mocks.uploadShardedFullBackup.mockResolvedValue(undefined);
  });

  it("does nothing when automatic backup is disabled", async () => {
    mocks.readAppSettings.mockReturnValue({
      backupReminder: "daily",
      automaticBackup: false,
      lastBackupAt: null,
    });
    const { runAutomaticBackupIfDue } = await import("./automatic-backup");
    await expect(runAutomaticBackupIfDue()).resolves.toBe(false);
    expect(mocks.readTelegramConfig).not.toHaveBeenCalled();
    expect(mocks.uploadShardedFullBackup).not.toHaveBeenCalled();
  });

  it("does nothing when the configured interval is not due", async () => {
    mocks.backupReminderDue.mockReturnValue(false);
    const { runAutomaticBackupIfDue } = await import("./automatic-backup");
    await expect(runAutomaticBackupIfDue()).resolves.toBe(false);
    expect(mocks.readTelegramConfig).not.toHaveBeenCalled();
  });

  it("does nothing without Telegram credentials", async () => {
    mocks.readTelegramConfig.mockResolvedValue({
      botToken: "",
      chatId: "",
      extraBotTokens: [],
      deviceLabel: "device",
    });
    const { runAutomaticBackupIfDue } = await import("./automatic-backup");
    await expect(runAutomaticBackupIfDue()).resolves.toBe(false);
    expect(mocks.uploadShardedFullBackup).not.toHaveBeenCalled();
  });

  it("uploads and records the completion time on success", async () => {
    const { runAutomaticBackupIfDue } = await import("./automatic-backup");
    await expect(runAutomaticBackupIfDue()).resolves.toBe(true);
    // The auto-backup op owns the log entry and status update, so the inner
    // upload is told not to write a second log entry.
    expect(mocks.uploadShardedFullBackup).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "bot", chatId: "chat" }),
      "device",
      undefined,
      { log: false },
    );
    expect(mocks.writeAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ lastBackupAt: expect.any(String) }),
    );
  });

  it("does not record success when upload fails", async () => {
    mocks.uploadShardedFullBackup.mockRejectedValueOnce(new Error("network"));
    const { runAutomaticBackupIfDue } = await import("./automatic-backup");
    await expect(runAutomaticBackupIfDue()).rejects.toThrow("network");
    expect(mocks.writeAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        // The stored status is the generic, redacted op summary; the real
        // error is rethrown (and shown by the caller), not persisted raw.
        lastBackupError: "Automatic backup failed",
        lastBackupErrorAt: expect.any(String),
      }),
    );
    expect(mocks.writeAppSettings.mock.calls[0]?.[0]?.lastBackupAt).toBeNull();
  });
});
