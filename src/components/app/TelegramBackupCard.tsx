import { invalidateAllDataQueries } from "@/lib/data-query-keys";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/utils";
import { toast } from "sonner";
import {
  ChevronDown,
  CloudDownload,
  CloudUpload,
  HardDriveDownload,
  Pencil,
  QrCode,
  Save,
  ScanLine,
  Camera,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { isAndroid, isDesktop } from "@/lib/desktop";
import {
  DEFAULT_TELEGRAM_CONFIG,
  buildFullBackup,
  parseTelegramScan,
  detectTelegramChatId,
  defaultDeviceLabel,
  encodePairingPayload,
  fetchLatestFullBackupArchive,
  fullBackupFileName,
  isTelegramConfigured,
  pickFullBackupFile,
  previewFullBackup,
  readTelegramConfig,
  restoreFullBackup,
  restoreSummary,
  saveFullBackupLocally,
  assertLocalFullCopyWithinMemoryBudget,
  uploadFullBackup,
  uploadShardedFullBackup,
  fetchLatestShardedFullBackup,
  validateTelegramConfig,
  fetchShardedFullBackupByMessage,
  restoreFullBackupSharded,
  writeTelegramConfig,
  type FullBackupPreview,
  type TelegramConfig,
} from "@/lib/telegram-backup";
import {
  encryptFullBackupBytes,
  WrongPassphraseError,
  NoPassphraseSetError,
} from "@/lib/backup-crypto";
import {
  SettingsActions,
  SettingsField,
  SettingsGrid,
  SettingsGroup,
  SettingsSwitchRow,
} from "./SettingsField";
import { BackupEncryptionSettings } from "./BackupEncryptionSettings";
import { RestorePassphrasePrompt } from "./RestorePassphrasePrompt";
import { reloadIfSettingsRestored } from "@/lib/backup";
import { TABLE_LABELS } from "@/lib/backup-table-labels";
import { QrScannerDialog } from "./QrScannerDialog";
import { LayoutPart } from "./LayoutSection";
import { OperationProgressBar } from "./OperationProgressBar";
import { beginOp, redact } from "@/lib/backup-log";
import {
  readBackupPassphrase,
  writeBackupPassphrase,
} from "@/lib/backup-passphrase";
import {
  beginProgress,
  setOperationProgress,
  setOperationResult,
  setOperationRetry,
  isOperationRunning,
} from "@/lib/operation-progress";

const MAX_BOTS = 10;

/**
 * The one backup surface: build the combined archive (rows + receipt photos)
 * and send it to the person's own private Telegram chat, or save the exact
 * same archive to the device when they'd rather not set anything up.
 */
const progressLabel = (phase: string, done?: number, total?: number) => {
  const labels: Record<string, string> = {
    preparing: "Preparing backup",
    reading: "Reading backup data",
    compressing: "Compressing backup",
    encrypting: "Encrypting backup",
    uploading: "Uploading backup",
    downloading: "Downloading backup",
    verifying: "Verifying backup",
    writing: "Saving backup",
    "restoring-records": "Restoring records",
    "restoring-photos": "Restoring receipt photos",
    finalizing: "Finalizing backup",
  };
  const base = labels[phase] ?? "Processing backup";
  return done != null && total != null ? `${base} (${done}/${total})` : base;
};

export function TelegramBackupCard() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [cfg, setCfg] = useState<TelegramConfig>(DEFAULT_TELEGRAM_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [merge, setMerge] = useState(false);
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    from: string;
    mode: "merge" | "replace";
    preview: FullBackupPreview;
    // The passphrase that actually opened this archive, when it wasn't the
    // one stored on this device — carried through to confirmRestore so the
    // real restore step decrypts with the same passphrase the preview did,
    // instead of trying (and failing) the stored one all over again.
    passphraseOverride?: string | undefined;
  } | null>(null);
  // Set only when decoding with the stored passphrase (or none) has
  // already failed — see applyRestore below. Holds the bytes and label so
  // a submitted passphrase can retry without re-fetching/re-picking.
  const [passphrasePrompt, setPassphrasePrompt] = useState<{
    bytes: Uint8Array;
    from: string;
  } | null>(null);
  // Set when a Telegram "Restore latest" / "Restore selected" needs the
  // passphrase the backup was made with (e.g. after reinstalling the app).
  const [tgPrompt, setTgPrompt] = useState<"latest" | "message" | null>(null);
  // Inline "wrong passphrase" message shown inside the passphrase pop-up.
  const [promptError, setPromptError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [pendingScan, setPendingScan] =
    useState<Partial<TelegramConfig> | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [messageLocator, setMessageLocator] = useState("");

  // Saved details live on this device only; read them after mount so server
  // and client render the same markup.
  useEffect(() => {
    void (async () => {
      const saved = await readTelegramConfig();
      setCfg({
        ...saved,
        deviceLabel: saved.deviceLabel || defaultDeviceLabel(),
      });
      setEditing(!isTelegramConfigured(saved));
      setLoaded(true);
    })();
  }, []);

  const configured = isTelegramConfigured(cfg);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (isOperationRunning()) {
      toast.error("Another backup is in progress");
      return;
    }
    setBusy(label);
    let succeeded = false;
    try {
      await fn();
      succeeded = true;
    } catch (e) {
      if (isPassphraseFailure(e) && label.startsWith("fetch")) {
        // First attempt used this device's saved passphrase (or none, after a
        // reinstall). Ask for the one the backup was made with.
        setOperationResult("error", "Backup passphrase needed");
        setTgPrompt(label === "fetch" ? "latest" : "message");
        setBusy(null);
        setProgress(null);
        return;
      }
      if (isPassphraseFailure(e) && label.startsWith("unlock")) {
        setPromptError("Wrong passphrase. Check it and try again.");
        setOperationResult("error", "That passphrase didn't open this backup");
        toast.error("That passphrase didn't open this backup. Try again.");
        setBusy(null);
        setProgress(null);
        return;
      }
      setOperationResult(
        e instanceof DOMException && e.name === "AbortError"
          ? "cancelled"
          : "error",
        e instanceof DOMException && e.name === "AbortError"
          ? "Backup cancelled"
          : errorMessage(e),
      );
      if (!(e instanceof DOMException && e.name === "AbortError"))
        toast.error(redact(errorMessage(e)));
    } finally {
      if (succeeded)
        setOperationResult(
          "success",
          label === "backup"
            ? "Telegram backup completed"
            : label === "fetch"
              ? "Telegram restore completed"
              : label === "unlock-latest"
                ? "Telegram restore completed"
                : label === "fetch-message" || label === "unlock-message"
                  ? "Selected Telegram restore completed"
                  : label === "local-save"
                    ? "Local backup saved"
                    : label === "scan-save"
                      ? "Telegram details saved"
                      : "Operation completed",
        );
      setBusy(null);
      setProgress(null);
    }
  };

  const saveCfg = (next: TelegramConfig) => {
    setCfg(next);
    void writeTelegramConfig(next);
  };

  /** Reads the archive and computes what it would actually do — records and
   * receipt photos both — then always surfaces the confirm dialog below, for
   * merge as much as replace. A merge that silently added dozens of records
   * with nothing shown anywhere was itself the gap this closes: it matches
   * `BackupCard`'s single-file restore, which got the same treatment first.
   *
   * The first call for a fetched/picked archive omits `passphraseOverride`,
   * so `previewFullBackup` tries this device's stored passphrase. If that
   * throws `WrongPassphraseError`/`NoPassphraseSetError` — an archive from
   * another device, or from before this device's passphrase was last
   * changed — this opens `RestorePassphrasePrompt` instead of a dead-end
   * toast; submitting it calls this again with the typed passphrase, which
   * is then carried on `pending` so `confirmRestore` decrypts the same way.
   */
  const applyRestore = async (
    bytes: Uint8Array,
    from: string,
    passphraseOverride?: string,
  ) => {
    if (!passphraseOverride) {
      // Always ask: the restore reads the passphrase the user types.
      setPromptError(null);
      setPassphrasePrompt({ bytes, from });
      return;
    }
    try {
      const mode = merge ? "merge" : "replace";
      const preview = await previewFullBackup(bytes, mode, passphraseOverride);
      setPassphrasePrompt(null);
      setPromptError(null);
      setPending({ bytes, from, mode, preview, passphraseOverride });
    } catch (e) {
      if (
        e instanceof WrongPassphraseError ||
        e instanceof NoPassphraseSetError
      ) {
        setPromptError("Wrong passphrase. Check it and try again.");
        toast.error("That passphrase didn't open this file. Try again.");
        return;
      }
      throw e;
    }
  };

  const submitUnlock = (passphrase: string) => {
    setPromptError(null);
    if (tgPrompt === "latest") {
      void restoreLatest(passphrase);
      return;
    }
    if (tgPrompt === "message") {
      void restoreByMessage(passphrase);
      return;
    }
    if (!passphrasePrompt) return;
    const { bytes, from } = passphrasePrompt;
    void run("unlock", () => applyRestore(bytes, from, passphrase));
  };

  const confirmRestore = async () => {
    const job = pending;
    setPending(null);
    setShowDetails(false);
    if (!job) return;
    await run("restore", async () => {
      const result = await restoreFullBackup(
        job.bytes,
        job.mode,
        job.passphraseOverride,
      );
      await invalidateAllDataQueries(qc);
      if (reloadIfSettingsRestored())
        toast.info("Restoring your settings — the app will refresh");
      toast.success(`Restored from ${job.from}`, {
        description: restoreSummary(result),
      });
    });
  };

  const backupNow = () =>
    run("backup", async () => {
      const opId = crypto.randomUUID();
      const controller = new AbortController();
      beginProgress(
        "telegram-upload",
        opId,
        "preparing",
        "Preparing Telegram backup",
        true,
      );
      setOperationProgress({
        opId,
        kind: "telegram-upload",
        phase: "preparing",
        label: "Preparing Telegram backup",
        cancellable: true,
        cancel: () => controller.abort(),
      });
      setProgress("Packing everything into one file…");
      const result = await uploadShardedFullBackup(
        cfg,
        cfg.deviceLabel || defaultDeviceLabel(),
        (p) => {
          const retryLabel = p.retry
            ? ` · Telegram asked us to wait ${Math.ceil(p.retry.retryAfterMs / 1000)} s, retrying (attempt ${p.retry.attempt} of ${p.retry.max})`
            : "";
          const phase = p.phase ?? "uploading";
          const label =
            phase === "encrypting"
              ? `Encrypting backup${p.total ? ` · shard ${p.shard} of ${p.total}` : ""}`
              : `Uploading part ${p.shard} of ${p.total}`;
          setProgress(label + retryLabel);
          // The bar shows the wait as a live countdown (retry.until), not a frozen label.
          setOperationProgress({
            opId,
            kind: "telegram-upload",
            phase,
            label,
            retry: p.retry
              ? {
                  attempt: p.retry.attempt,
                  max: p.retry.max,
                  until: Date.now() + p.retry.retryAfterMs,
                }
              : undefined,
            done: phase === "uploading" ? p.shard : undefined,
            total: phase === "uploading" ? p.total : undefined,
            bytesDone: p.bytesDone,
            bytesTotal: p.bytesTotal,
            cancellable: true,
            cancel: () => controller.abort(),
          });
        },
        { signal: controller.signal },
      );
      const locator = String(result.messageIds.at(-1) ?? "");
      const notes = [
        `${result.shardCount} encrypted shard${result.shardCount === 1 ? "" : "s"} sent`,
        `Manifest message ID: ${locator}`,
      ];
      try {
        await navigator.clipboard?.writeText(locator);
      } catch {
        /* clipboard permission is optional */
      }
      toast.success("Backup sent to your Telegram chat", {
        description: `${result.shardCount} encrypted shard${result.shardCount === 1 ? "" : "s"} sent`,
        duration: 10000,
      });
    });

  /** After a restore that needed a typed passphrase: close the prompt and, if
   * this install had no passphrase saved (fresh reinstall), keep the one that
   * just worked so the next backup from this device uses the same key. */
  const finishTelegramUnlock = async (passphrase?: string) => {
    setTgPrompt(null);
    setPromptError(null);
    if (!passphrase) return;
    try {
      if (!(await readBackupPassphrase()))
        await writeBackupPassphrase(passphrase);
    } catch {
      /* best-effort: the restore itself already succeeded */
    }
  };

  /** Telegram restores always start by asking for the backup passphrase. */
  const askPassphraseFor = (which: "latest" | "message") => {
    if (isOperationRunning() || busy !== null) {
      toast.error("Another backup is in progress");
      return;
    }
    if (which === "message" && !messageLocator.trim()) {
      toast.error(
        "Enter a Telegram backup message ID or copied Telegram message link first.",
      );
      return;
    }
    setPromptError(null);
    setTgPrompt(which);
  };

  const restoreLatest = (passphrase?: string) =>
    run(passphrase ? "unlock-latest" : "fetch", async () => {
      const opId = crypto.randomUUID();
      const controller = new AbortController();
      beginProgress(
        "telegram-restore",
        opId,
        "preparing",
        "Finding latest Telegram backup",
        true,
        () => controller.abort(),
      );
      setProgress("Looking for the latest sharded backup…");
      const { top, shards } = await fetchLatestShardedFullBackup(cfg, {
        signal: controller.signal,
        passphrase,
        onProgress: (p) => {
          if (p.retry) setOperationRetry(p.retry);
        },
      });
      setProgress("Restoring backup…");
      const result = await restoreFullBackupSharded(
        shards,
        merge ? "merge" : "replace",
        top,
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.retry) {
              setOperationRetry(p.retry);
              return;
            }
            const cancellable =
              p.phase === "downloading" || p.phase === "verifying";
            setOperationProgress({
              opId,
              kind: "telegram-restore",
              phase: p.phase,
              label: p.label ?? progressLabel(p.phase, p.done, p.total),
              done: p.done,
              total: p.total,
              cancellable,
              cancel: cancellable ? () => controller.abort() : undefined,
            });
          },
        },
      );
      await finishTelegramUnlock(passphrase);
      await invalidateAllDataQueries(qc);
      if (reloadIfSettingsRestored())
        toast.info("Restoring your settings — the app will refresh");
      toast.success("Restored from Telegram", {
        description: restoreSummary(result),
      });
    });

  const restoreByMessage = (passphrase?: string) =>
    run(passphrase ? "unlock-message" : "fetch-message", async () => {
      const opId = crypto.randomUUID();
      const controller = new AbortController();
      beginProgress(
        "telegram-restore",
        opId,
        "preparing",
        "Opening selected Telegram backup",
        true,
        () => controller.abort(),
      );
      if (!messageLocator.trim())
        throw new Error(
          "Enter a Telegram backup message ID or copied Telegram message link first.",
        );
      setProgress("Opening the selected Telegram backup…");
      const { top, shards } = await fetchShardedFullBackupByMessage(
        cfg,
        messageLocator,
        {
          signal: controller.signal,
          passphrase,
          onProgress: (p) => {
            if (p.retry) setOperationRetry(p.retry);
          },
        },
      );
      setProgress("Restoring selected backup…");
      const result = await restoreFullBackupSharded(
        shards,
        merge ? "merge" : "replace",
        top,
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.retry) {
              setOperationRetry(p.retry);
              return;
            }
            const cancellable =
              p.phase === "downloading" || p.phase === "verifying";
            setOperationProgress({
              opId,
              kind: "telegram-restore",
              phase: p.phase,
              label: p.label ?? progressLabel(p.phase, p.done, p.total),
              done: p.done,
              total: p.total,
              cancellable,
              cancel: cancellable ? () => controller.abort() : undefined,
            });
          },
        },
      );
      await finishTelegramUnlock(passphrase);
      await invalidateAllDataQueries(qc);
      if (reloadIfSettingsRestored())
        toast.info("Restoring your settings — the app will refresh");
      toast.success("Restored selected Telegram backup", {
        description: restoreSummary(result),
      });
    });

  const saveLocalCopy = () =>
    run("local-save", async () => {
      const opId = crypto.randomUUID();
      beginProgress(
        "local-export",
        opId,
        "preparing",
        "Preparing local full backup",
      );
      await assertLocalFullCopyWithinMemoryBudget();
      setProgress("Packing everything into one file…");
      const { bytes: plainBytes, missingFiles } = await buildFullBackup(
        cfg.deviceLabel || defaultDeviceLabel(),
        (p) =>
          setOperationProgress({
            opId,
            kind: "local-export",
            phase: p.phase,
            label: progressLabel(p.phase, p.done, p.total),
            done: p.done,
            total: p.total,
            bytesDone: p.bytesDone,
            bytesTotal: p.bytesTotal,
            cancellable: false,
          }),
      );
      if (missingFiles.length > 0)
        throw new Error(
          `Backup aborted: ${missingFiles.length} receipt photo(s) are missing or corrupt on this device.`,
        );
      setProgress("Encrypting the backup…");
      const bytes = await encryptFullBackupBytes(plainBytes);
      const savedTo = await saveFullBackupLocally(
        bytes,
        fullBackupFileName(),
        (p) =>
          setOperationProgress({
            opId,
            kind: "local-export",
            phase: p.phase,
            label: progressLabel(p.phase, p.done, p.total),
            done: p.done,
            total: p.total,
            bytesDone: p.bytesDone,
            bytesTotal: p.bytesTotal,
            cancellable: false,
          }),
      );
      if (savedTo === null)
        throw new DOMException("The backup save was cancelled", "AbortError");
      toast.success(isDesktop() ? "Backup saved" : "Backup file downloaded", {
        description:
          "Records and receipt photos are both inside this one file.",
      });
    });

  useEffect(() => {
    const retry = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: string }>).detail?.kind;
      if (kind === "telegram") void backupNow();
    };
    window.addEventListener("truff-backup-retry", retry);
    return () => window.removeEventListener("truff-backup-retry", retry);
    // Re-subscribe only when the saved config changes; backupNow is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  const showQr = () =>
    run("qr", async () => {
      const QRCode = (await import("qrcode")).default;
      setQrDataUrl(
        await QRCode.toDataURL(encodePairingPayload(cfg), {
          width: 320,
          margin: 1,
        }),
      );
      setQrOpen(true);
    });

  const onScanned = (text: string) => {
    const op = beginOp("telegram-config", "Processing Telegram QR scan");
    try {
      const payload = parseTelegramScan(text);
      setPendingScan({
        ...(payload.botToken ? { botToken: payload.botToken } : {}),
        ...(payload.chatId ? { chatId: payload.chatId } : {}),
        ...(payload.extraBotTokens
          ? { extraBotTokens: payload.extraBotTokens }
          : {}),
      });
      setScanOpen(false);
      op.finish("success", "Telegram QR details recognized");
    } catch (e) {
      op.finish("error", "Telegram QR scan was not recognized", {
        errorCode: "unknown",
      });
      toast.error(redact(errorMessage(e)));
    }
  };

  const confirmScan = () => {
    if (!pendingScan) return;
    void run("scan-save", async () => {
      const next = {
        ...cfg,
        ...pendingScan,
        extraBotTokens: pendingScan.extraBotTokens ?? cfg.extraBotTokens,
      };
      if (!next.chatId?.trim()) {
        setCfg(next);
        setPendingScan(null);
        setEditing(true);
        toast.success(
          "Bot details loaded. Add or detect the chat ID, then save.",
        );
        return;
      }
      const result = await validateTelegramConfig(next);
      await writeTelegramConfig(next);
      setCfg(next);
      setPendingScan(null);
      setEditing(false);
      toast.success(
        result.username
          ? `Telegram bot @${result.username} verified and saved`
          : "Telegram details verified and saved",
      );
    });
  };

  return (
    <section className="space-y-3">
      <BackupEncryptionSettings />
      <Card className="frost">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4" /> Telegram backup
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground">
            One backup with everything in it — every customer, bill, expense,
            booking, snack sale{" "}
            <span className="font-medium text-foreground">and</span> every
            receipt photo — sent to a private Telegram chat only you can see.
            Restoring brings all of it back in one go.
          </p>

          {!loaded ? (
            <p className="text-sm text-muted-foreground">
              Checking this device…
            </p>
          ) : editing ? (
            <>
              <SettingsGroup
                title="Connect Telegram"
                hint="Create a bot with @BotFather, add it to a private channel or group as an admin, then enter the details below."
              >
                <SettingsGrid>
                  <SettingsField label="Bot token" full>
                    <Input
                      type="password"
                      value={cfg.botToken}
                      onChange={(e) =>
                        saveCfg({ ...cfg, botToken: e.target.value.trim() })
                      }
                      placeholder="123456:ABC-DEF..."
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Scan bot token"
                      onClick={() => setScanOpen(true)}
                    >
                      <Camera className="h-4 w-4" />
                    </Button>
                  </SettingsField>
                  <SettingsField
                    label="Chat ID"
                    hint="Usually starts with -100."
                  >
                    <Input
                      value={cfg.chatId}
                      onChange={(e) =>
                        saveCfg({ ...cfg, chatId: e.target.value.trim() })
                      }
                      placeholder="-1001234567890"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Scan chat ID"
                      onClick={() => setScanOpen(true)}
                    >
                      <Camera className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!cfg.botToken || busy !== null}
                      onClick={() =>
                        run("detect-chat", async () => {
                          const chatId = await detectTelegramChatId(cfg);
                          if (!chatId) {
                            toast.error(
                              "No recent chat found. Message the bot first, then try again.",
                            );
                            return;
                          }
                          saveCfg({ ...cfg, chatId });
                          toast.success(
                            `Chat ID detected: …${chatId.slice(-4)}`,
                          );
                        })
                      }
                    >
                      Detect
                    </Button>
                  </SettingsField>
                  <SettingsField label="Name for this device">
                    <Input
                      value={cfg.deviceLabel}
                      onChange={(e) =>
                        saveCfg({ ...cfg, deviceLabel: e.target.value })
                      }
                      placeholder={defaultDeviceLabel()}
                    />
                  </SettingsField>
                </SettingsGrid>
              </SettingsGroup>

              <Separator />

              <SettingsGroup
                title="Large backups"
                hint={`Optional — spread large backups across up to ${MAX_BOTS} bots.`}
              >
                <div className="space-y-3">
                  {cfg.extraBotTokens.map((token, i) => (
                    <SettingsField
                      key={i}
                      label={`Extra bot ${i + 2}`}
                      reserveHint={false}
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                        <Input
                          type="password"
                          value={token}
                          onChange={(e) => {
                            const next = [...cfg.extraBotTokens];
                            next[i] = e.target.value.trim();
                            saveCfg({ ...cfg, extraBotTokens: next });
                          }}
                          placeholder="234567:GHI-JKL..."
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={`Scan bot ${i + 2} token`}
                          onClick={() => setScanOpen(true)}
                        >
                          <Camera className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove bot ${i + 2}`}
                          onClick={() =>
                            saveCfg({
                              ...cfg,
                              extraBotTokens: cfg.extraBotTokens.filter(
                                (_, j) => j !== i,
                              ),
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </SettingsField>
                  ))}
                  <SettingsActions>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={cfg.extraBotTokens.length >= MAX_BOTS - 1}
                      onClick={() =>
                        saveCfg({
                          ...cfg,
                          extraBotTokens: [...cfg.extraBotTokens, ""],
                        })
                      }
                    >
                      <Plus className="mr-1 h-4 w-4" /> Add another bot
                    </Button>
                  </SettingsActions>
                  <p className="text-xs text-muted-foreground">
                    {cfg.extraBotTokens.length + 1} of {MAX_BOTS} bots in use
                    {cfg.extraBotTokens.length >= MAX_BOTS - 1
                      ? " — that's the maximum."
                      : ""}
                  </p>
                </div>
              </SettingsGroup>

              <Separator />

              <SettingsGroup title="Save and pair">
                <SettingsActions>
                  <Button
                    disabled={!isTelegramConfigured(cfg) || busy !== null}
                    onClick={() =>
                      run("save", async () => {
                        await validateTelegramConfig(cfg);
                        await writeTelegramConfig(cfg);
                        setEditing(false);
                        toast.success(
                          isDesktop() && !isAndroid()
                            ? "Saved — the bot token is kept in Windows Credential Manager"
                            : "Saved on this device",
                        );
                      })
                    }
                  >
                    <Save className="mr-1 h-4 w-4" /> Save details
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => setScanOpen(true)}
                  >
                    <ScanLine className="mr-1 h-4 w-4" /> Scan setup QR
                  </Button>
                  {configured && (
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  )}
                </SettingsActions>
                <p className="text-xs text-muted-foreground">
                  The bot token never leaves this device. Keep the chat private
                  — anyone in it can read your backups.
                </p>
              </SettingsGroup>
            </>
          ) : (
            <>
              <div className="frost-well flex items-start justify-between gap-3 rounded-xl p-3">
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">Chat {cfg.chatId}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    This device: {cfg.deviceLabel || defaultDeviceLabel()}
                    {cfg.extraBotTokens.length > 0
                      ? ` · ${cfg.extraBotTokens.length + 1} bots`
                      : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                </Button>
              </div>

              <SettingsActions>
                <Button disabled={busy !== null} onClick={backupNow}>
                  <CloudUpload className="mr-1 h-4 w-4" /> Backup now
                </Button>
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => askPassphraseFor("latest")}
                >
                  <CloudDownload className="mr-1 h-4 w-4" /> Restore latest
                </Button>
                <div className="grid min-w-[280px] grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <Input
                    value={messageLocator}
                    onChange={(e) => setMessageLocator(e.target.value)}
                    placeholder="Backup message ID or t.me link"
                    aria-label="Telegram backup message ID or link"
                    disabled={busy !== null}
                  />
                  <Button
                    variant="outline"
                    disabled={busy !== null || !messageLocator.trim()}
                    onClick={() => askPassphraseFor("message")}
                  >
                    Restore selected
                  </Button>
                </div>
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={showQr}
                >
                  <QrCode className="mr-1 h-4 w-4" /> Show setup QR
                </Button>
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setScanOpen(true)}
                >
                  <ScanLine className="mr-1 h-4 w-4" /> Scan setup QR
                </Button>
              </SettingsActions>

              <SettingsSwitchRow
                label="Merge with what's already here"
                hint="When off, restoring replaces everything on this device."
                checked={merge}
                onCheckedChange={setMerge}
              />
            </>
          )}

          <LayoutPart id="settings.telegram.progress">
            <OperationProgressBar />
          </LayoutPart>
          {progress && (
            <p className="text-xs text-muted-foreground">{progress}</p>
          )}

          <div className="frost-well space-y-2 rounded-xl p-3">
            <p className="text-xs text-muted-foreground">
              No Telegram? You can{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                disabled={busy !== null}
                onClick={saveLocalCopy}
              >
                save a local copy instead
              </button>{" "}
              — the very same file, kept on this device.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                if (isDesktop() && !isAndroid()) {
                  void run("local-open", async () => {
                    const bytes = await pickFullBackupFile();
                    if (bytes === null) return;
                    await applyRestore(bytes, "this device");
                  });
                  return;
                }
                fileRef.current?.click();
              }}
            >
              <HardDriveDownload className="mr-1 h-3.5 w-3.5" /> Restore from a
              saved file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                void run("local-open", async () =>
                  applyRestore(
                    new Uint8Array(await file.arrayBuffer()),
                    "this device",
                  ),
                );
              }}
            />
          </div>

          <Collapsible open={helpOpen} onOpenChange={setHelpOpen}>
            <CollapsibleTrigger className="text-xs underline underline-offset-2 text-muted-foreground">
              How do I set this up?
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <ol className="space-y-1 text-xs text-muted-foreground">
                <li>
                  1. In Telegram, message @BotFather and send /newbot to get a
                  bot token.
                </li>
                <li>
                  2. Make a private channel or group and add your bot to it as
                  an admin that can post.
                </li>
                <li>
                  3. Send any message there, then paste that chat ID here (it
                  usually starts with -100).
                </li>
                <li>
                  4. Tap "Backup now" — records and receipt photos go over as
                  one file.
                </li>
                <li>
                  5. On a second device, tap "Scan setup QR" and point it at the
                  first device's "Show setup QR", then tap "Restore latest".
                </li>
              </ol>
              <p className="pt-1 text-xs text-muted-foreground">
                Keep the chat private — anyone in it can read your backups. The
                bot token stays on this device.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <AlertDialog
        open={pending != null}
        onOpenChange={(o) => {
          if (!o) {
            setPending(null);
            setShowDetails(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.mode === "merge"
                ? "Add these records to this device?"
                : "Replace everything with this backup?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                {pending?.mode === "merge" ? (
                  <p>
                    This adds{" "}
                    <span className="font-medium text-foreground">
                      {pending.preview.tables.totalAdded} new record
                      {pending.preview.tables.totalAdded === 1 ? "" : "s"}
                    </span>{" "}
                    from {pending.from}. The{" "}
                    {pending.preview.tables.totalUnchangedOrRemoved} record
                    {pending.preview.tables.totalUnchangedOrRemoved === 1
                      ? ""
                      : "s"}{" "}
                    already on this device are left exactly as they are —
                    nothing gets overwritten.
                  </p>
                ) : pending ? (
                  <p>
                    This deletes{" "}
                    <span className="font-medium text-foreground">
                      {pending.preview.tables.totalUnchangedOrRemoved} record
                      {pending.preview.tables.totalUnchangedOrRemoved === 1
                        ? ""
                        : "s"}{" "}
                      currently on this device
                    </span>{" "}
                    and replaces them with {pending.preview.tables.totalAdded}{" "}
                    from {pending.from}. It can't be undone — turn on "Merge
                    with what's already here" first if you'd rather add to it.
                  </p>
                ) : null}
                {pending && pending.preview.filesToAdd > 0 && (
                  <p>
                    Includes {pending.preview.filesToAdd} receipt photo
                    {pending.preview.filesToAdd === 1 ? "" : "s"}
                    {pending.preview.filesSkippedExisting > 0 ? (
                      <>
                        {" "}
                        ({pending.preview.filesSkippedExisting} already saved
                        here, left alone)
                      </>
                    ) : null}
                    .
                  </p>
                )}
                {pending && (
                  <div>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
                      onClick={() => setShowDetails((v) => !v)}
                    >
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`}
                      />
                      {showDetails ? "Hide" : "Show"} table-by-table breakdown
                    </button>
                    {showDetails && (
                      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs">
                        {pending.preview.tables.perTable
                          .filter((row) =>
                            row.mode === "merge"
                              ? row.added > 0 || row.alreadyPresent > 0
                              : row.willAdd > 0 || row.willRemove > 0,
                          )
                          .map((row) => (
                            <li
                              key={row.table}
                              className="flex justify-between gap-2"
                            >
                              <span>
                                {TABLE_LABELS[row.table] ?? row.table}
                              </span>
                              <span className="text-right">
                                {row.mode === "merge"
                                  ? `+${row.added} new · ${row.alreadyPresent} already have`
                                  : `+${row.willAdd} · −${row.willRemove}`}
                              </span>
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRestore();
              }}
              disabled={busy !== null}
            >
              {pending?.mode === "merge" ? "Add records" : "Replace everything"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scan this on the other device</DialogTitle>
          </DialogHeader>
          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt="Telegram backup setup code"
              className="mx-auto max-w-full h-auto w-56 rounded-lg"
            />
          )}
          <DialogDescription className="text-xs">
            Open Settings → Telegram backup there and tap "Scan setup QR". Only
            show this to devices you own — it carries the bot token.
          </DialogDescription>
        </DialogContent>
      </Dialog>

      <QrScannerDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        onResult={onScanned}
        title="Scan Telegram details"
        hint="Scan the app setup QR, a Telegram bot-token QR, or a QR containing the chat ID."
      />
      <AlertDialog
        open={pendingScan !== null}
        onOpenChange={(v) => {
          if (!v) setPendingScan(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use scanned Telegram details?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the fields present in the scan will be filled. Review them
              before saving. Token:{" "}
              {pendingScan?.botToken
                ? `${pendingScan.botToken.slice(0, 6)}…:${pendingScan.botToken.slice(-3)}`
                : "unchanged"}
              . Chat ID:{" "}
              {pendingScan?.chatId
                ? `…${pendingScan.chatId.slice(-4)}`
                : "unchanged"}
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmScan}>
              Use details
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RestorePassphrasePrompt
        open={passphrasePrompt !== null || tgPrompt !== null}
        busy={busy === "unlock" || (busy?.startsWith("unlock-") ?? false)}
        error={promptError}
        onCancel={() => {
          setPassphrasePrompt(null);
          setTgPrompt(null);
          setPromptError(null);
        }}
        onSubmit={submitUnlock}
      />
    </section>
  );
}

/** Wrong/missing passphrase, including errors wrapped by shard restore. */
function isPassphraseFailure(e: unknown): boolean {
  if (e instanceof WrongPassphraseError || e instanceof NoPassphraseSetError)
    return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /passphrase|decrypt|OperationError|authentication tag/i.test(msg);
}
