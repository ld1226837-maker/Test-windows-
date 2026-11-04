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
  EXPENSE_LABELS,
  TABLE_TITLE,
  countsText,
  formatCell,
  headlineFigures,
  rowCells,
  totalCells,
} from "@/lib/daily-table";
import {
  parseOldCash,
  todayKey,
  useDailyTable,
  useDailyTableActions,
  type SummaryAction,
} from "@/lib/daily-table-actions";
import { whatsappNumber } from "@/lib/phone";
import { useAppSettings } from "@/lib/settings";
import { CashFlowList } from "./CashFlowList";

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

  // One source for the hint: the OLD CASH step of the cash flow.
  const oldCashHint = table.cash.steps.find((x) => x.key === "oldCash")?.hint;
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
            value={oldCashText ?? String(table.cash.oldCash)}
            onChange={(e) => setOldCashText(e.target.value)}
            aria-describedby="daily-table-old-cash-hint"
          />
          <p
            id="daily-table-old-cash-hint"
            className="text-[11px] text-muted-foreground"
          >
            {oldCashHint}
          </p>
        </div>
      </div>

      <ul
        aria-label="Headline figures"
        className="grid grid-cols-3 gap-2 text-center"
      >
        {headlineFigures(table).map((h) => (
          <li
            key={h.key}
            className={`min-w-0 rounded-md border px-1 py-2 ${
              h.key === "finalTotal"
                ? "border-2 border-indigo-900/80 bg-amber-200/80 dark:bg-amber-500/30"
                : "bg-card"
            }`}
          >
            <div className="text-[10px] font-bold text-muted-foreground">
              {h.label}
            </div>
            <div
              className={`break-all font-mono text-base font-bold tabular-nums ${
                h.negative
                  ? "text-red-700 dark:text-red-400"
                  : "text-indigo-900 dark:text-indigo-100"
              }`}
            >
              {h.value}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-bold">{TABLE_TITLE}</span>
        <span className="text-xs text-muted-foreground">
          {countsText(table.counts)}
        </span>
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
                  {e.description}{" "}
                  <span className="rounded border px-1 text-[10px] font-bold text-muted-foreground">
                    {e.tag}
                  </span>
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
                  {EXPENSE_LABELS.total}
                </td>
                <td className="border border-border px-2 py-1.5 text-right font-mono">
                  {formatCell(table.expenseTotal)}
                </td>
              </tr>
            )}
            <tr>
              <td className="border border-border px-2 py-1.5" colSpan={2}>
                {EXPENSE_LABELS.cash}
              </td>
              <td className="border border-border px-2 py-1.5 text-right font-mono">
                {formatCell(table.cash.cashExpenses)}
              </td>
            </tr>
            <tr className="text-muted-foreground">
              <td className="border border-border px-2 py-1.5" colSpan={2}>
                {EXPENSE_LABELS.online}
              </td>
              <td className="border border-border px-2 py-1.5 text-right font-mono">
                {formatCell(table.cash.onlineExpenses)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <CashFlowList table={table} />

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
