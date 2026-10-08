import { invalidateAllDataQueries } from "@/lib/data-query-keys";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/utils";
import { toast } from "sonner";
import { ChevronDown, Download, ShieldAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { shortDate } from "@/lib/biz";
import { useQueryClient } from "@tanstack/react-query";
import {
  backupSummary,
  buildBackup,
  decodeBackupBytes,
  clearPendingPhotoZip,
  downloadBackup,
  parseBackup,
  pickBackupFilePath,
  decodeBackupFile,
  previewRestore,
  restoreBackup,
  type BackupFile,
  type BackupTable,
  type RestorePreview,
  reloadIfSettingsRestored,
} from "@/lib/backup";
import { isAndroid, isDesktop } from "@/lib/desktop";
import { TABLE_LABELS } from "@/lib/backup-table-labels";
import { hasBackupPassphrase } from "@/lib/backup-passphrase";
import {
  WrongPassphraseError,
  NoPassphraseSetError,
} from "@/lib/backup-crypto";
import { BackupEncryptionSettings } from "./BackupEncryptionSettings";
import { RestorePassphrasePrompt } from "./RestorePassphrasePrompt";
import { useAppSettings, type BackupReminder } from "@/lib/settings";
import { OperationProgressBar } from "./OperationProgressBar";
import { LayoutPart } from "./LayoutSection";
import {
  beginProgress,
  setOperationProgress,
  setOperationResult,
  isOperationRunning,
} from "@/lib/operation-progress";

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

export function BackupCard() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [merge, setMerge] = useState(true);
  const [pending, setPending] = useState<{
    backup: BackupFile;
    mode: "merge" | "replace";
    preview: RestorePreview;
  } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  // Set only when decoding a picked file with the device's stored
  // passphrase (or none) has already failed — see applyBackup below. Holds
  // the file's bytes so a submitted passphrase can retry the same decode
  // without re-picking the file.
  const [passphrasePrompt, setPassphrasePrompt] = useState<{
    bytes?: Uint8Array;
    path?: string;
  } | null>(null);
  const { settings: appSettings, save: saveAppSettings } = useAppSettings();
  // `null` = still checking; `false` is what shows the inline encryption
  // setup below. Exports are encrypted unconditionally (downloadBackup ->
  // encryptFullBackupBytes), so a person who only ever uses this card — and
  // never opens the Telegram backup card, the other place this passphrase
  // can be set — needs a way to set one from right here too, not just a
  // toast error the first time they click Export.
  const [passphraseSet, setPassphraseSet] = useState<boolean | null>(null);

  useEffect(() => {
    void hasBackupPassphrase().then(setPassphraseSet);
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    if (isOperationRunning()) {
      toast.error("Another backup is in progress");
      return;
    }
    setBusy(label);
    try {
      await fn();
      setOperationResult(
        "success",
        `${label === "restore" ? "Restore" : "Backup"} completed`,
      );
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === "AbortError";
      setOperationResult(
        cancelled ? "cancelled" : "error",
        cancelled ? "Restore cancelled" : errorMessage(e),
      );
      toast.error(cancelled ? "Restore cancelled" : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  /** Reads the file and computes what it would actually do, then always
   * surfaces the confirm dialog below — for merge as much as replace, since
   * "nothing to confirm" was itself misleading when a merge could still add
   * dozens of records the person hadn't seen listed anywhere.
   *
   * The first call for a picked file omits `passphraseOverride`, so
   * decoding tries this device's stored passphrase (the common case: same
   * device that made the backup). If that throws
   * `WrongPassphraseError`/`NoPassphraseSetError` — a file made under a
   * different passphrase, e.g. from another device or from before this
   * one's was last changed — this opens `RestorePassphrasePrompt` instead
   * of surfacing a dead-end toast; submitting it calls this again with the
   * typed passphrase as the override. Any other error (not a valid backup
   * at all, corrupted file) still surfaces the normal toast via `run`'s
   * catch, since no passphrase would fix that.
   */
  const applyBackup = async (
    bytes: Uint8Array,
    passphraseOverride?: string,
  ) => {
    try {
      const text = await decodeBackupBytes(bytes, passphraseOverride);
      const backup = parseBackup(text);
      const mode = merge ? "merge" : "replace";
      const preview = await previewRestore(backup, mode);
      setPassphrasePrompt(null);
      setPending({ backup, mode, preview });
    } catch (e) {
      if (
        e instanceof WrongPassphraseError ||
        e instanceof NoPassphraseSetError
      ) {
        if (passphraseOverride) {
          // A typed passphrase was already wrong — say so and leave the
          // prompt open for another try, rather than closing it on a
          // failure the person can immediately fix.
          toast.error("That passphrase didn't open this file. Try again.");
          return;
        }
        setPassphrasePrompt({ bytes });
        return;
      }
      clearPendingPhotoZip();
      throw e;
    }
  };

  const applyBackupFromPath = async (
    path: string,
    passphraseOverride?: string,
  ) => {
    try {
      const text = await decodeBackupFile(path, passphraseOverride);
      const backup = parseBackup(text);
      const mode = merge ? "merge" : "replace";
      const preview = await previewRestore(backup, mode);
      setPassphrasePrompt(null);
      setPending({ backup, mode, preview });
    } catch (e) {
      if (
        e instanceof WrongPassphraseError ||
        e instanceof NoPassphraseSetError
      ) {
        setPassphrasePrompt({ path });
        return;
      }
      clearPendingPhotoZip();
      throw e;
    }
  };

  const confirmRestore = async () => {
    if (!pending) return;
    const { backup, mode, preview } = pending;
    setPending(null);
    setShowDetails(false);
    setBusy("restore");
    try {
      if (mode === "replace") {
        // Create a point-in-time safety copy before the destructive operation.
        // If the snapshot cannot be written, abort the replace.
        const safety = await buildBackup();
        const snapshotPath = await downloadBackup(
          safety,
          `pre-restore-${Date.now()}.db`,
        );
        if (!snapshotPath)
          throw new Error(
            "Pre-restore safety backup was cancelled; replace restore was aborted.",
          );
      }
      const opId = crypto.randomUUID();
      const controller = new AbortController();
      beginProgress(
        "local-restore",
        opId,
        "verifying",
        "Validating backup",
        true,
      );
      setOperationProgress({
        opId,
        kind: "local-restore",
        phase: "verifying",
        label: "Validating backup",
        cancellable: true,
        cancel: () => controller.abort(),
      });
      const count = await restoreBackup(backup, mode, {
        onProgress: (p) =>
          setOperationProgress({
            opId,
            kind: "local-restore",
            phase: p.phase,
            label: p.label ?? p.phase,
            done: p.done,
            total: p.total,
            cancellable: p.cancellable ?? false,
            cancel: p.cancellable ? () => controller.abort() : undefined,
          }),
        signal: controller.signal,
      });
      setOperationResult("success", `Restored ${count} records`);
      await invalidateAllDataQueries(qc);
      if (reloadIfSettingsRestored())
        toast.info("Restoring your settings — the app will refresh");
      const differing = preview.perTable.reduce(
        (n, row) => n + (row.mode === "merge" ? row.differing : 0),
        0,
      );
      toast.success(`Restored ${count} records`, {
        description: `${backupSummary(backup)}${mode === "merge" ? ` · ${differing} existing record${differing === 1 ? "" : "s"} differed and were kept local` : ""}`,
      });
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === "AbortError";
      setOperationResult(
        cancelled ? "cancelled" : "error",
        cancelled ? "Restore cancelled" : errorMessage(e),
      );
      toast.error(cancelled ? "Restore cancelled" : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submitUnlock = (passphrase: string) => {
    if (!passphrasePrompt) return;
    if (passphrasePrompt.path) {
      void run("import", () =>
        applyBackupFromPath(passphrasePrompt.path!, passphrase),
      );
    } else if (passphrasePrompt.bytes) {
      void run("import", () =>
        applyBackup(passphrasePrompt.bytes!, passphrase),
      );
    }
  };

  useEffect(() => {
    const retry = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: string }>).detail?.kind;
      if (kind === "local")
        void run("backup", async () => {
          const opId = crypto.randomUUID();
          beginProgress(
            "local-export",
            opId,
            "preparing",
            "Preparing local backup",
          );
          const backup = await buildBackup((progress) =>
            setOperationProgress({
              opId,
              kind: "local-export",
              phase: progress.phase,
              label: progressLabel(
                progress.phase,
                progress.done,
                progress.total,
              ),
              done: progress.done,
              total: progress.total,
              bytesDone: progress.bytesDone,
              bytesTotal: progress.bytesTotal,
              cancellable: false,
            }),
          );
          const savedTo = await downloadBackup(backup, undefined, (progress) =>
            setOperationProgress({
              opId,
              kind: "local-export",
              phase: progress.phase,
              label: progressLabel(
                progress.phase,
                progress.done,
                progress.total,
              ),
              done: progress.done,
              total: progress.total,
              bytesDone: progress.bytesDone,
              bytesTotal: progress.bytesTotal,
              cancellable: false,
            }),
          );
          if (savedTo === null)
            throw new DOMException(
              "The backup save was cancelled",
              "AbortError",
            );
        });
    };
    window.addEventListener("truff-backup-retry", retry);
    return () => window.removeEventListener("truff-backup-retry", retry);
  }, []);

  return (
    <section className="space-y-3">
      <LayoutPart id="settings.backup.progress">
        <OperationProgressBar />
      </LayoutPart>
      <Card className="frost">
        <CardHeader>
          <CardTitle className="text-base">Single-file backup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Exports every customer, bill, expense, booking and snack sale into
            one encrypted
            <code className="mx-1 rounded bg-muted px-1">.db</code> file you can
            keep or move to another device.
          </p>
          {passphraseSet === false && (
            <div className="frost-well space-y-2 rounded-xl p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                <ShieldAlert className="h-3.5 w-3.5" /> Set a backup passphrase
                before exporting
              </p>
              <BackupEncryptionSettings
                onSaved={() => setPassphraseSet(true)}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy !== null}
              onClick={() =>
                run("export", async () => {
                  const opId = crypto.randomUUID();
                  beginProgress(
                    "local-export",
                    opId,
                    "preparing",
                    "Preparing local backup",
                  );
                  const backup = await buildBackup((p) =>
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
                  const savedTo = await downloadBackup(backup, undefined, (p) =>
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
                    throw new DOMException(
                      "The backup save was cancelled",
                      "AbortError",
                    );
                  if (backup.partial) {
                    toast.warning("Backup completed with missing receipts", {
                      description: `${backup.warnings?.length ?? 0} receipt photo(s) were omitted. Repair them before relying on this backup as a complete archive.`,
                      duration: 12000,
                    });
                  } else {
                    toast.success(
                      isDesktop() ? "Backup saved" : "Backup file downloaded",
                      {
                        description: `${backupSummary(backup)}${savedTo ? ` · ${savedTo}` : ""}`,
                      },
                    );
                  }
                })
              }
            >
              <Download className="mr-1 h-4 w-4" /> Export .db file
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                if (isDesktop()) {
                  void run("import", async () => {
                    const path = await pickBackupFilePath();
                    if (!path) return;
                    await applyBackupFromPath(path);
                  });
                  return;
                }
                fileRef.current?.click();
              }}
            >
              <Upload className="mr-1 h-4 w-4" /> Import .db file
            </Button>
            <input
              ref={fileRef}
              type="file"
              // Extension-based `accept` filtering is unreliable on Android:
              // WebView resolves ".db"/".json" to MIME types via
              // MimeTypeMap before handing them to the system document
              // picker, but Android has no registered MIME mapping for
              // ".db" (the file was saved with MIME
              // "application/octet-stream" — see AndroidSavePlugin.kt).
              // Depending on WebView version, that either falls back to
              // showing everything, or silently filters the picker down to
              // just ".json" — hiding real .db backups. Since
              // decodeBackupBytes/parseBackup already validate the picked
              // file's contents and throw a clear error for anything that
              // isn't a real backup, there's no filtering safety lost by
              // leaving this unrestricted on Android.
              accept={isAndroid() ? undefined : ".db,.json"}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                void run("import", async () =>
                  applyBackup(new Uint8Array(await file.arrayBuffer())),
                );
              }}
            />
          </div>
          <label
            htmlFor="backup-merge-switch"
            className="flex items-center gap-2 text-sm"
          >
            <Switch
              id="backup-merge-switch"
              checked={merge}
              onCheckedChange={setMerge}
            />
            Merge with existing data (off = replace everything)
          </label>

          <div className="frost-well flex flex-wrap items-center justify-between gap-2 rounded-xl p-3">
            <div className="text-sm">
              <p className="micro-label">
                Automatic Telegram backup on app launch
              </p>
              <span className="block text-xs text-muted-foreground">
                {appSettings.lastBackupAt
                  ? `Last backup: ${shortDate(appSettings.lastBackupAt)}`
                  : "No successful backup recorded on this device."}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor="automatic-backup-switch"
                className="flex items-center gap-2 text-xs"
              >
                <Switch
                  id="automatic-backup-switch"
                  checked={appSettings.automaticBackup}
                  onCheckedChange={(checked) =>
                    saveAppSettings({
                      ...appSettings,
                      automaticBackup: checked,
                    })
                  }
                />
                <span>Enable automatic Telegram backup on app launch</span>
              </label>
              <div className="flex gap-2">
                {(["off", "daily", "weekly"] as BackupReminder[]).map((opt) => (
                  <Button
                    key={opt}
                    size="sm"
                    variant={
                      appSettings.backupReminder === opt ? "default" : "outline"
                    }
                    onClick={() =>
                      saveAppSettings({ ...appSettings, backupReminder: opt })
                    }
                  >
                    {opt === "off"
                      ? "Off"
                      : opt === "daily"
                        ? "Daily"
                        : "Weekly"}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={pending != null}
        onOpenChange={(o) => {
          if (!o) {
            setPending(null);
            setShowDetails(false);
            clearPendingPhotoZip();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.mode === "merge"
                ? "Add these records to this device?"
                : "Replace all data with this backup?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                {pending?.mode === "merge" ? (
                  <p>
                    This adds{" "}
                    <span className="font-medium text-foreground">
                      {pending.preview.totalAdded} new record
                      {pending.preview.totalAdded === 1 ? "" : "s"}
                    </span>{" "}
                    from the backup. The{" "}
                    {pending.preview.totalUnchangedOrRemoved} record
                    {pending.preview.totalUnchangedOrRemoved === 1
                      ? ""
                      : "s"}{" "}
                    already on this device are left exactly as they are —
                    nothing gets overwritten.
                  </p>
                ) : pending ? (
                  <p>
                    This deletes{" "}
                    <span className="font-medium text-foreground">
                      {pending.preview.totalUnchangedOrRemoved} record
                      {pending.preview.totalUnchangedOrRemoved === 1
                        ? ""
                        : "s"}{" "}
                      currently on this device
                    </span>{" "}
                    and replaces them with {pending.preview.totalAdded} from the
                    backup. This can't be undone. Turn on "Merge with existing
                    data" instead if you want to add these records without
                    deleting anything.
                  </p>
                ) : null}
                {pending && pending.preview.photoCount > 0 && (
                  <p>
                    Includes {pending.preview.photoCount} receipt photo
                    {pending.preview.photoCount === 1 ? "" : "s"}.
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
                        {pending.preview.perTable
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
      <RestorePassphrasePrompt
        open={passphrasePrompt !== null}
        busy={busy === "import"}
        onCancel={() => setPassphrasePrompt(null)}
        onSubmit={submitUnlock}
      />
    </section>
  );
}
