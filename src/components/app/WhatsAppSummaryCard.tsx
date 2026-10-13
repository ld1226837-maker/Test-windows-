import { isCancelled, isLive } from "@/lib/bill-state";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBills, usePayments } from "@/lib/data";
import { useExpensesV2, useSnackSales, useTurfBookings } from "@/lib/ops";
import { dayKey, paymentSplit, statsForDay } from "@/lib/analytics";
import { isFinancialSale, pendingMoneyIndex } from "@/lib/dues";
import { BUSINESS_NAME, formatDMY, money, whatsappUrl } from "@/lib/biz";
import { openExternal } from "@/lib/desktop";
import { usePrintSettings } from "@/lib/print";
import { useAppSettings } from "@/lib/settings";
import { useTabEntries } from "@/lib/tabs";
import { usePersistedState } from "@/lib/ui-prefs";
import {
  DAY_FILTERS,
  SORT_MODES,
  buildOwnerBillText,
  buildRecentBillRows,
  isDayFilter,
  isSortMode,
  type DayFilter,
  type OwnerBillRow,
  type SortMode,
} from "@/lib/owner-bills";
import { LayoutPart, LayoutParts } from "./LayoutSection";

const PAGE = 5;
const KIND_LABEL = { turf: "TURF", snack: "SNACK", invoice: "INV" } as const;

type SendFn = (row: OwnerBillRow) => Promise<void>;

/** Day chips + sort. Memoised: typing in the owner-number box must not re-render it. */
const RecentSortBar = memo(function RecentSortBar({
  open,
  day,
  sort,
  onToggle,
  onDay,
  onSort,
}: {
  open: boolean;
  day: DayFilter;
  sort: SortMode;
  onToggle: () => void;
  onDay: (d: DayFilter) => void;
  onSort: (s: SortMode) => void;
}) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm font-medium"
      >
        Recent bills
        <ChevronDown
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="flex flex-wrap items-center gap-1.5">
          {DAY_FILTERS.map((d) => (
            <Button
              key={d.value}
              type="button"
              size="sm"
              variant={day === d.value ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => onDay(d.value)}
            >
              {d.label}
            </Button>
          ))}
          <select
            aria-label="Sort recent bills"
            value={sort}
            onChange={(e) => onSort(e.target.value as SortMode)}
            className="ml-auto h-7 rounded-md border bg-background px-2 text-xs"
          >
            {SORT_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
});

const BillRow = memo(function BillRow({
  row,
  onSend,
}: {
  row: OwnerBillRow;
  onSend: SendFn;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex items-center gap-2 py-2 text-sm">
      <span className="w-14 shrink-0 rounded bg-muted px-1.5 py-0.5 text-center text-[10px] font-semibold">
        {KIND_LABEL[row.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{row.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.no} · {formatDMY(row.day)}
        </span>
      </span>
      <span className="shrink-0 tabular-nums">{money(row.amount)}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSend(row);
          } finally {
            setBusy(false);
          }
        }}
      >
        <MessageCircle className="mr-1 h-3.5 w-3.5" /> Send
      </Button>
    </li>
  );
});

/** Mounted only while the dropdown is open, so nothing here runs when it is closed. */
function OpenBillList({
  day,
  sort,
  visible,
  onMore,
  onLess,
  getOwner,
  focusOwner,
}: {
  day: DayFilter;
  sort: SortMode;
  visible: number;
  onMore: () => void;
  onLess: () => void;
  getOwner: () => string;
  focusOwner: () => void;
}) {
  const { data: bookings = [] } = useTurfBookings();
  const { data: sales = [] } = useSnackSales();
  const { data: bills = [] } = useBills();
  const { data: payments = [] } = usePayments();
  const { data: tabEntries = [] } = useTabEntries();

  // Day filter first, then amounts, then sort the small remaining set.
  // Depends only on the data and the two controls — never on settings.
  const rows = useMemo(
    () => buildRecentBillRows({ bookings, sales, bills }, { day, sort }),
    [bookings, sales, bills, day, sort],
  );

  const send = useCallback<SendFn>(
    async (row) => {
      const owner = getOwner();
      if (!owner.trim()) {
        toast.error("Enter the owner's WhatsApp number first");
        focusOwner();
        return;
      }
      const text = buildOwnerBillText(row, {
        bookings,
        sales,
        bills,
        payments,
        tabEntries,
      });
      if (!text) {
        toast.error("Couldn't find that bill");
        return;
      }
      const opened = await openExternal(whatsappUrl(text, owner));
      if (opened) {
        toast.success("Opening WhatsApp", {
          description: "Review and tap send.",
        });
      } else {
        toast.error("Couldn't open WhatsApp automatically", {
          description: "Your device didn't allow the app to open the link.",
        });
      }
    },
    [getOwner, focusOwner, bookings, sales, bills, payments, tabEntries],
  );

  if (rows.length === 0)
    return (
      <p className="py-3 text-sm text-muted-foreground">
        No bills in this range
      </p>
    );

  const shown = rows.slice(0, visible);
  return (
    <div>
      <ul className="divide-y">
        {shown.map((r) => (
          <BillRow key={r.key} row={r} onSend={send} />
        ))}
      </ul>
      <div className="flex gap-2 pt-2">
        {rows.length > visible && (
          <Button type="button" size="sm" variant="ghost" onClick={onMore}>
            Show {Math.min(PAGE, rows.length - visible)} more
          </Button>
        )}
        {visible > PAGE && (
          <Button type="button" size="sm" variant="ghost" onClick={onLess}>
            Show less
          </Button>
        )}
      </div>
    </div>
  );
}

const RecentBillsList = memo(function RecentBillsList(
  props: Parameters<typeof OpenBillList>[0] & { open: boolean },
) {
  const { open, ...rest } = props;
  return open ? <OpenBillList {...rest} /> : null;
});

export function WhatsAppSummaryCard() {
  const { settings, save } = useAppSettings();
  const { settings: printSettings } = usePrintSettings();
  const { data: bills = [] } = useBills();
  const { data: bookings = [] } = useTurfBookings();
  const { data: sales = [] } = useSnackSales();
  const { data: expenses = [] } = useExpensesV2();
  const { data: tabEntries = [] } = useTabEntries();

  // Recent-bills controls live here so the sort bar and the list (two layout
  // parts) share them. The owner number is read through a ref so the memoised
  // children keep stable props while the number is being typed.
  const ownerRef = useRef(settings.whatsappOwner);
  ownerRef.current = settings.whatsappOwner;
  const getOwner = useCallback(() => ownerRef.current ?? "", []);
  const ownerInput = useRef<HTMLInputElement>(null);
  const focusOwner = useCallback(() => ownerInput.current?.focus(), []);
  const [open, setOpen] = usePersistedState(
    "whatsapp-recent-bills-open",
    false,
  );
  const [day, setDay] = usePersistedState<DayFilter>(
    "whatsapp-recent-day",
    "all",
    isDayFilter,
  );
  const [sort, setSort] = usePersistedState<SortMode>(
    "whatsapp-recent-sort",
    "newest",
    isSortMode,
  );
  const [visible, setVisible] = useState(PAGE);
  const onToggle = useCallback(() => setOpen((v) => !v), [setOpen]);
  const onDay = useCallback(
    (d: DayFilter) => {
      setDay(d);
      setVisible(PAGE);
    },
    [setDay],
  );
  const onSort = useCallback(
    (m: SortMode) => {
      setSort(m);
      setVisible(PAGE);
    },
    [setSort],
  );
  const onMore = useCallback(() => setVisible((v) => v + PAGE), []);
  const onLess = useCallback(() => setVisible(PAGE), []);

  const send = async () => {
    const today = dayKey(new Date());
    // Same source object (tab ledger included) as the Dashboard's "today".
    const src = { bills, bookings, sales, expenses, tabEntries };
    const s = statsForDay(src, today);
    const split = paymentSplit(src, (iso) => dayKey(iso) === today);
    const modeText = split
      .filter((m) => m.value > 0)
      .map((m) => `${m.name} ${money(m.value)}`)
      .join(" · ");
    const dateText = formatDMY(today);

    const text = [
      `*${printSettings.shopName || BUSINESS_NAME} — Daily summary (${dateText})*`,
      `Collected: ${money(s.collected)}${modeText ? `\n${modeText}` : ""}`,
      `Revenue (incl. tax): ${money(s.revenue)} (Tax: ${money(s.tax)}) · Expenses: ${money(s.expenses)} · Profit: ${money(s.profit)}`,
      `Turf bookings: ${bookings.filter((b) => b.booking_date === today && isLive(b)).length} · Snack bills: ${sales.filter((x) => x.sale_date === today && isFinancialSale(x)).length}`,
      // All-time money owed, the same figure (and words) as the Dashboard's
      // "Pending dues" card, including the running tab - not just today's
      // bills and bookings.
      `Pending dues: ${money(pendingMoneyIndex({ bills, bookings, tabEntries }).total)}`,
    ].join("\n");

    // Same phone-formatting rule (10-digit numbers get "91" prepended) and
    // the same desktop-safe navigation as every other WhatsApp entry point
    // (DashboardTab.tsx, BillActions.tsx, receipt.ts) — plain `window.open`
    // is unreliable inside the Tauri webview (see desktop.ts).
    const url = whatsappUrl(text, settings.whatsappOwner);
    const opened = await openExternal(url);
    if (opened) {
      toast.success("Opening WhatsApp", {
        description: "Review and tap send.",
      });
    } else {
      toast.error("Couldn't open WhatsApp automatically", {
        description: "Your device didn't allow the app to open the link.",
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="h-4 w-4" /> Daily summary on WhatsApp
        </CardTitle>
      </CardHeader>
      <CardContent>
        <LayoutParts sectionId="settings.whatsapp" className="space-y-3">
          <LayoutPart id="settings.whatsapp.owner-number">
            <p className="mb-3 text-sm text-muted-foreground">
              Builds today&apos;s collection, profit and dues summary and opens
              WhatsApp with the message pre-filled — one tap to send it to the
              owner.
            </p>
            <div className="space-y-1">
              <Label className="text-xs">
                Owner&apos;s WhatsApp number (with country code)
              </Label>
              <Input
                ref={ownerInput}
                inputMode="tel"
                value={settings.whatsappOwner}
                onChange={(e) =>
                  save({ ...settings, whatsappOwner: e.target.value })
                }
                placeholder="91 98765 43210"
              />
            </div>
          </LayoutPart>
          <LayoutPart id="settings.whatsapp.daily-summary">
            <Button onClick={send}>
              <MessageCircle className="mr-1 h-4 w-4" /> Send today&apos;s
              summary
            </Button>
          </LayoutPart>
          <LayoutPart id="settings.whatsapp.recent-sort">
            <RecentSortBar
              open={open}
              day={day}
              sort={sort}
              onToggle={onToggle}
              onDay={onDay}
              onSort={onSort}
            />
          </LayoutPart>
          <LayoutPart id="settings.whatsapp.recent-bills">
            <RecentBillsList
              open={open}
              day={day}
              sort={sort}
              visible={visible}
              onMore={onMore}
              onLess={onLess}
              getOwner={getOwner}
              focusOwner={focusOwner}
            />
          </LayoutPart>
        </LayoutParts>
      </CardContent>
    </Card>
  );
}
