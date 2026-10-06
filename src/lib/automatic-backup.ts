import {
  backupReminderDue,
  readAppSettings,
  writeAppSettings,
} from "./settings";
import { readTelegramConfig, uploadShardedFullBackup } from "./telegram-backup";

let running = false;

/**
 * Runs an opted-in backup when the configured reminder interval is due. The
 * caller schedules this during idle time so startup interactions stay responsive.
 * A failed upload leaves lastBackupAt unchanged so the next launch retries.
 */
export async function runAutomaticBackupIfDue(): Promise<boolean> {
  if (running) return false;
  const settings = readAppSettings();
  if (!settings.automaticBackup) return false;
  if (!backupReminderDue(settings)) return false;

  const cfg = await readTelegramConfig();
  if (!cfg.botToken || !cfg.chatId) return false;

  running = true;
  try {
    await uploadShardedFullBackup(cfg, cfg.deviceLabel);
    writeAppSettings({
      ...readAppSettings(),
      lastBackupAt: new Date().toISOString(),
      lastBackupError: null,
      lastBackupErrorAt: null,
    });
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    writeAppSettings({
      ...readAppSettings(),
      lastBackupError: message,
      lastBackupErrorAt: new Date().toISOString(),
    });
    throw e;
  } finally {
    running = false;
  }
}
