import { useRef, useState } from "react";
import { Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  bulkImportPhotos,
  clearBulkImportCursor,
  type BulkImportProgress,
} from "@/lib/receipts-import";
import { localDateStr, errorMessage } from "@/lib/utils";

const fmt = (n: number) => n.toLocaleString("en-IN");

export function ReceiptBulkImportCard() {
  const input = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(localDateStr());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BulkImportProgress | null>(null);
  const run = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const result = await bulkImportPhotos(Array.from(files), {
        expenseDate: date,
        onProgress: setProgress,
        onWarning: (w) => w && toast.warning(w),
      });
      setProgress(result);
      toast.success(`Imported ${fmt(result.imported)} receipt photos`, {
        description: `${fmt(result.duplicates)} duplicates · ${fmt(result.skipped.length)} skipped`,
      });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="frost">
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="font-medium">Bulk receipt import</p>
          <p className="text-sm text-muted-foreground">
            Import an existing folder of receipt photos with bounded
            concurrency, deduplication and resumable progress.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label className="micro-label">
              Expense date for imported photos
            </Label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <input
              ref={input}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void run(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            <Button disabled={busy} onClick={() => input.current?.click()}>
              <Upload className="mr-2 h-4 w-4" />
              {busy ? "Importing…" : "Choose photos"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                clearBulkImportCursor();
                setProgress(null);
                toast.success("Import resume history cleared");
              }}
            >
              <XCircle className="mr-1 h-4 w-4" />
              Reset
            </Button>
          </div>
        </div>
        {progress && (
          <p className="text-sm text-muted-foreground">
            {fmt(progress.done)} / {fmt(progress.total)} processed ·{" "}
            {fmt(progress.imported)} imported · {fmt(progress.duplicates)}{" "}
            duplicates · {fmt(progress.skipped.length)} skipped
          </p>
        )}
      </CardContent>
    </Card>
  );
}
