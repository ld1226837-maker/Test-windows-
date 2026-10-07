import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  receiptStorageStats,
  reconcileReceiptStorage,
  repairReceiptItem,
  requestPersistentStorage,
  type ReceiptHealthReport,
} from "@/lib/receipt-health";
import { errorMessage } from "@/lib/utils";

/**
 * R6: Receipt storage health - photo count/size stats, a reconcile action
 * that cross-checks expenses vs stored bytes vs capture-time hashes, and
 * safe per-item repair.
 */
export function ReceiptStorageCard() {
  const [stats, setStats] = useState<{
    photoCount: number;
    totalBytes: number;
    avgBytes: number;
  } | null>(null);
  const [report, setReport] = useState<ReceiptHealthReport | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStats(await receiptStorageStats());
  }, []);

  useEffect(() => {
    void refresh();
    // Web only: ask the browser not to evict IndexedDB under pressure.
    void requestPersistentStorage();
  }, [refresh]);

  const fmtBytes = (n: number) =>
    n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MB`
      : `${Math.round(n / 1024)} KB`;

  const reconcile = async () => {
    setBusy(true);
    try {
      const r = await reconcileReceiptStorage();
      setReport(r);
      setStats({
        photoCount: r.photoCount,
        totalBytes: r.totalBytes,
        avgBytes: r.avgBytes,
      });
      const issues = r.missing.length + r.orphans.length + r.mismatched.length;
      if (issues === 0) toast.success("Receipt storage is consistent.");
      else
        toast.warning(
          `Found ${issues} receipt storage issue${issues === 1 ? "" : "s"}.`,
        );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const repair = async (
    kind: "missing" | "orphan" | "mismatch",
    path: string,
  ) => {
    if (
      kind === "orphan" &&
      !window.confirm(
        `Delete orphaned receipt "${path}"? This removes the stored photo and its integrity record.`,
      )
    )
      return;
    setBusy(true);
    try {
      const msg = await repairReceiptItem(kind, path);
      toast.success(msg);
      await reconcile();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const itemRow = (
    kind: "missing" | "orphan" | "mismatch",
    label: string,
    paths: string[],
  ) =>
    paths.length > 0 && (
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {label} ({paths.length})
        </p>
        <ul className="space-y-1">
          {paths.map((p) => (
            <li
              key={p}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="truncate text-muted-foreground">{p}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void repair(kind, p)}
              >
                Repair
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Receipt storage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {stats ? (
          <p className="text-sm text-muted-foreground">
            {stats.photoCount} photo{stats.photoCount === 1 ? "" : "s"} ·{" "}
            {fmtBytes(stats.totalBytes)} total
            {stats.photoCount > 0 && ` · ${fmtBytes(stats.avgBytes)} average`}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void reconcile()}
        >
          {busy ? "Checking…" : "Reconcile"}
        </Button>
        {report && (
          <div className="space-y-3 border-t pt-3">
            {itemRow("missing", "Photos missing", report.missing)}
            {itemRow("orphan", "Unclaimed photos", report.orphans)}
            {itemRow("mismatch", "Hash mismatches", report.mismatched)}
            {report.missing.length +
              report.orphans.length +
              report.mismatched.length ===
              0 && (
              <p className="text-sm text-muted-foreground">
                No issues — every claimed photo exists and verifies.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
