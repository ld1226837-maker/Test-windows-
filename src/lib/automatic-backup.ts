import { backupReminderDue, readAppSettings } from "./settings";
import { readTelegramConfig, uploadShardedFullBackup } from "./telegram-backup";
import { beginOp, errorCodeFor, redact } from "./backup-log";

let running = false;

/**
 * Runs an opted-in backup when the configured reminder interval is due. The
 * caller schedules this during idle time so startup interactions stay responsive.
 * A failed upload leaves lastBackupAt unchanged so the next launch retries.
 */
export async function runAutomaticBackupIfDue(): Promise<boolean> {
  if (running) {
    if (import.meta.env.DEV)
      console.debug("Automatic backup skipped: another run is active");
    return false;
  }
  const settings = readAppSettings();
  if (!settings.automaticBackup) {
    if (import.meta.env.DEV)
      console.debug("Automatic backup skipped: disabled");
    return false;
  }
  if (!backupReminderDue(settings)) {
    if (import.meta.env.DEV) console.debug("Automatic backup skipped: not due");
    return false;
  }

  const cfg = await readTelegramConfig();
  if (!cfg.botToken || !cfg.chatId) {
    if (import.meta.env.DEV)
      console.debug("Automatic backup skipped: Telegram is not configured");
    return false;
  }

  running = true;
  const op = beginOp("auto-backup", "Automatic Telegram backup");
  try {
    await uploadShardedFullBackup(cfg, cfg.deviceLabel, undefined, {
      log: false,
    });
    op.finish("success", "Automatic backup completed");
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    op.finish("error", "Automatic backup failed", {
      errorCode: errorCodeFor(e),
      errorMessage: redact(message),
    });
    throw e;
  } finally {
    running = false;
  }
}
