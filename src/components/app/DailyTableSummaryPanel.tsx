import { useEffect, useState } from "react";
import {
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  Send,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  COLUMN_HEADERS,
  EXPENSE_HEADERS,
  formatCell,
  rowCells,
  totalCells,
} from "@/lib/daily-table";
import {
  todayKey,
  useDailyTable,
  useDailyTableActions,
  type SummaryAction,
} from "@/lib/daily-table-actions";
import { whatsappNumber } from "@/lib/phone";
import { useAppSettings } from "@/lib/settings";

/** "1,170" / "1170" / "" -> whole rupees, or null when empty (use the default). */
const parseOldCash = (text: string): number | null => {
  const t = text.replace(/[^\d.]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
};

/**
 * Daily Summary picture: pick a day, set the old cash, then send the PNG of the
 * ledger table to the owner, save it, or share it. The Dashboard tile runs the
 * same flow for today with one tap.
 */
export function DailyTableSummaryPanel() {
  const [date, setDate] = useState(todayKey);
  const [oldCashText, setOldCashText] = useState<string | null>(null);
  const { settings, save } = useAppSettings();
  const { table } = useDailyTable(
    date,
    oldCashText === null ? null : parseOldCash(oldCashText),
  );
  const { run, phase, busy } = useDailyTableActions();

  // A different day starts from that day's own saved / default old cash.
  useEffect(() => setOldCashText(null), [date]);

  const hasOwner = Boolean(whatsappNumber(settings.whatsappOwner));
  const go = (a: SummaryAction) => void run(a, table);
  const label = (a: SummaryAction, text: string) =>
    busy && a !== "copy" && phase === "rendering" ? "Making picture…" : text;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ImageIcon className="h-4 w-4" /> Daily table picture
      </div>
      <p className="text-sm text-muted-foreground">
        A picture of the day&apos;s ledger table (bookings, cash, expenses and
        final total) that you can send to the owner or save. WhatsApp links
        cannot attach pictures, so you pick the owner&apos;s chat and press send
        yourself.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="daily-table-date">
            Day
          </Label>
          <Input
            id="daily-table-date"
            type="date"
            value={date}
            max={todayKey()}
            onChange={(e) => setDate(e.target.value || todayKey())}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="daily-table-old-cash">
            Old cash (Rs)
          </Label>
          <Input
            id="daily-table-old-cash"
            inputMode="numeric"
            value={oldCashText ?? String(table.oldCash)}
            onChange={(e) => setOldCashText(e.target.value)}
            aria-describedby="daily-table-old-cash-hint"
          />
          <p
            id="daily-table-old-cash-hint"
            className="text-[11px] text-muted-foreground"
          >
            {table.oldCashIsDefault && oldCashText === null
              ? "Starts from the previous day's final total."
              : "Typed by you; remembered for this day."}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border-2 border-indigo-900/80 bg-card">
        <table className="w-full min-w-[520px] border-collapse text-xs tabular-nums">
          <thead>
            <tr className="bg-indigo-100/70 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200">
              {COLUMN_HEADERS.map((h, i) => (
                <th
                  key={h}
                  className={`border border-border px-2 py-1.5 font-bold ${i === 0 || i === 6 ? "text-left" : "text-right"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="border border-border px-2 py-2 text-muted-foreground"
                >
                  No bookings or sales on this day
                </td>
              </tr>
            )}
            {table.rows.map((r) => (
              <tr key={r.key}>
                {rowCells(r).map((c, i) => (
                  <td
                    key={i}
                    className={`border border-border px-2 py-1.5 ${i === 0 ? "font-mono text-indigo-900 dark:text-indigo-200" : i === 6 ? "text-muted-foreground" : "text-right font-mono text-indigo-900 dark:text-indigo-200"}`}
                  >
                    {c}
                    {i === 0 && r.customer && (
                      <div className="font-sans text-[11px] text-muted-foreground">
                        {r.customer}
                        {r.phone ? ` · ${r.phone}` : ""}
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="bg-amber-200/80 font-bold text-foreground dark:bg-amber-500/30">
              {totalCells(table.totals).map((c, i) => (
                <td
                  key={i}
                  className={`border border-border px-2 py-1.5 ${i === 0 ? "" : "text-right font-mono"}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-md border-2 border-indigo-900/80 bg-card">
        <table className="w-full min-w-[420px] border-collapse text-xs tabular-nums">
          <caption className="p-1.5 text-left text-sm font-bold">
            EXPENSES
          </caption>
          <thead>
            <tr className="bg-indigo-100/70 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200">
              {EXPENSE_HEADERS.map((h, i) => (
                <th
                  key={h}
                  className={`border border-border px-2 py-1.5 font-bold ${i === 2 ? "text-right" : "text-left"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.expenseList.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="border border-border px-2 py-2 text-muted-foreground"
                >
                  No expenses on this day
                </td>
              </tr>
            )}
            {table.expenseList.map((e) => (
              <tr key={e.key}>
                <td className="border border-border px-2 py-1.5">
                  {e.description}
                </td>
                <td className="border border-border px-2 py-1.5 text-muted-foreground">
                  {e.notes}
                </td>
                <td className="border border-border px-2 py-1.5 text-right font-mono">
                  {formatCell(e.amount)}
                </td>
              </tr>
            ))}
            {table.expenseList.length > 0 && (
              <tr className="bg-amber-200/80 font-bold dark:bg-amber-500/30">
                <td className="border border-border px-2 py-1.5" colSpan={2}>
                  TOTAL EXPENSES
                </td>
                <td className="border border-border px-2 py-1.5 text-right font-mono">
                  {formatCell(table.expenseTotal)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2 rounded-lg border bg-card p-3 text-sm">
          {(
            [
              ["SPECIFIC CASH TOTAL", table.cashBlock.specificCash],
              ["THAT DAY EXPENSES", table.cashBlock.expenses],
              ["REMAINING CASH", table.cashBlock.remainingCash],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="flex justify-between gap-2">
              <span>{label}</span>
              <span className="font-mono font-bold text-indigo-900 dark:text-indigo-200">
                Rs {formatCell(v)}
              </span>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Remaining = cash total - cash expenses
          </p>
        </div>
        <div className="space-y-2 rounded-lg border bg-card p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Remaining cash {formatCell(table.cashBlock.remainingCash)} + old
            cash {formatCell(table.oldCash)}
          </p>
          <div className="flex items-center justify-between rounded-md border-2 border-indigo-900/80 bg-amber-200/80 px-3 py-2 font-bold dark:bg-amber-500/30">
            <span>FINAL TOTAL</span>
            <span className="font-mono text-lg text-indigo-900 dark:text-indigo-100">
              Rs {formatCell(table.finalTotal)}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="daily-table-logo" className="text-sm">
          Include business logo on the image
        </Label>
        <Switch
          id="daily-table-logo"
          checked={settings.summaryImageLogo}
          onCheckedChange={(v) => save({ ...settings, summaryImageLogo: v })}
        />
      </div>

      {!hasOwner && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
          Add the owner number in Settings (the field above) to open WhatsApp
          straight to the owner. You can still download or share.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => go("send")} disabled={busy}>
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-1 h-4 w-4" />
          )}
          {label("send", "Send to owner")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => go("download")}
          disabled={busy}
        >
          <Download className="mr-1 h-4 w-4" /> Download image
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => go("share")}
          disabled={busy}
        >
          <Share2 className="mr-1 h-4 w-4" /> Share…
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const el = document.getElementById("whatsapp-owner-number");
            el?.scrollIntoView({ block: "center" });
            (el as HTMLInputElement | null)?.focus();
          }}
        >
          Owner no.
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => go("copy")}
          disabled={busy}
        >
          <Copy className="mr-1 h-3.5 w-3.5" /> Copy text
        </Button>
      </div>
    </div>
  );
}
