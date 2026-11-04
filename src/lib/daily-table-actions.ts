/**
 * Glue between the app's data and the Daily Summary picture: builds the table
 * from the live records, renders the PNG, remembers the old-cash figure, and
 * runs one of the four actions. Used by the Settings card and the Dashboard
 * tile so both behave identically.
 *
 * Nothing here can lose data or crash a screen: every failure ends in a toast
 * (with "Copy text instead" when the picture itself could not be made).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { resolvedBusinessName } from "./biz";
import { dayKey } from "./analytics";
import { useBills, usePayments } from "./data";
import {
  buildDailyTable,
  buildDailyTableText,
  type DailyTable,
  type DailyTableDay,
} from "./daily-table";
import {
  loadLogo,
  renderDailyTableImages,
  type RenderedImage,
} from "./daily-table-image";
import {
  copyTableText,
  defaultShareDeps,
  downloadImage,
  sendToOwner,
  shareImage,
  type Notify,
  type ShareDeps,
} from "./daily-table-share";
import { goToTab } from "./nav";
import { useExpensesV2, useSnackSales, useTurfBookings } from "./ops";
import { readPrintSettings } from "./print";
import { useAppSettings, type AppSettings } from "./settings";
import { useTabEntries } from "./tabs";

export type SummaryAction = "send" | "download" | "share" | "copy";
export type SummaryPhase = "idle" | "rendering" | "sharing";

export const todayKey = () => dayKey(new Date());

/** "1,170" / "1170" / "" -> whole rupees, or null when empty (use the default). */
export const parseOldCash = (text: string): number | null => {
  const t = text.replace(/[^\d.]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
};

/** Live records the table is built from (all already cached app-wide). */
export function useDailyTableSource() {
  const { settings } = useAppSettings();
  const { data: bills = [] } = useBills();
  const { data: bookings = [] } = useTurfBookings();
  const { data: sales = [] } = useSnackSales();
  const { data: expenses = [] } = useExpensesV2();
  const { data: tabEntries = [] } = useTabEntries();
  const { data: payments = [] } = usePayments();

  const source = useMemo(
    () => ({
      bills,
      bookings,
      sales,
      expenses,
      tabEntries,
      payments,
      savedOldCash: settings.dailyOldCash,
      savedCashAfterExpenses: settings.dailyCashAfterExpenses,
    }),
    [
      bills,
      bookings,
      sales,
      expenses,
      tabEntries,
      payments,
      settings.dailyOldCash,
      settings.dailyCashAfterExpenses,
    ],
  );
  // A ref so a one-tap shortcut always builds from the newest records at the
  // moment it is tapped, without re-rendering its host screen to compute a table.
  const ref = useRef(source);
  ref.current = source;
  const build = useCallback(
    (date: string, oldCashOverride?: number | null) =>
      buildDailyTable({ ...ref.current, date, oldCashOverride }),
    [],
  );
  return { source, build, settings };
}

/** The table for one day, live from the app's records. */
export function useDailyTable(date: string, oldCashOverride?: number | null) {
  const { source, settings } = useDailyTableSource();
  const day = useMemo<DailyTableDay>(
    () => ({ ...source, date, oldCashOverride }),
    [source, date, oldCashOverride],
  );
  const table = useMemo(() => buildDailyTable(day), [day]);
  return { table, day, settings };
}

/** Renders the PNG(s) for a table, with the logo when the switch is on. */
export async function renderSummaryImages(
  table: DailyTable,
  settings: Pick<AppSettings, "summaryImageLogo">,
  now: Date = new Date(),
): Promise<RenderedImage[]> {
  let logo: Awaited<ReturnType<typeof loadLogo>> = null;
  if (settings.summaryImageLogo) {
    try {
      logo = await loadLogo(readPrintSettings().logo?.dataUrl);
    } catch {
      logo = null; // the picture is still made, just without the logo
    }
  }
  return renderDailyTableImages(table, {
    businessName: resolvedBusinessName(),
    logo: logo?.image ?? null,
    logoWidth: logo?.width,
    logoHeight: logo?.height,
    generatedAt: now,
  });
}

/** The two figures remembered for a day when its summary is sent. */
export type DayRecord = { oldCash: number; cashAfterExpenses: number };

/**
 * `settings` with both figures recorded for `date`, or null when nothing would
 * change. Both maps are updated in ONE object so a single save() writes them
 * together and two writes can never overwrite each other.
 *
 * Editing a past day: that date's stored cash-after-expenses is simply
 * overwritten the next time the day is sent. Later days never read it while
 * the day still has records: their default old cash follows the computed chain
 * (daily-table.ts), so an edit to a past day flows forward on its own.
 *
 * A negative old cash (a shortfall carried forward as a default) is not stored
 * as the owner's figure: it is always recomputed.
 */
export function withDayRecord(
  s: AppSettings,
  date: string,
  v: DayRecord,
): AppSettings | null {
  const keepOld = v.oldCash >= 0;
  const oldSame = !keepOld || s.dailyOldCash[date] === v.oldCash;
  const afterSame = s.dailyCashAfterExpenses[date] === v.cashAfterExpenses;
  if (oldSame && afterSame) return null;
  return {
    ...s,
    dailyOldCash: keepOld
      ? { ...s.dailyOldCash, [date]: v.oldCash }
      : s.dailyOldCash,
    dailyCashAfterExpenses: {
      ...s.dailyCashAfterExpenses,
      [date]: v.cashAfterExpenses,
    },
  };
}

export type RunInput = {
  action: SummaryAction;
  table: DailyTable;
  settings: AppSettings;
  /** Called once, after the image rendered, with the figures to remember. */
  rememberDay?: (date: string, record: DayRecord) => void;
  onPhase?: (p: SummaryPhase) => void;
  deps?: ShareDeps;
  /** Test seam; defaults to the real renderer. */
  render?: typeof renderSummaryImages;
};

/** Runs one action end to end. Never throws; always ends in a toast. */
export async function runSummaryAction(input: RunInput): Promise<boolean> {
  const { action, table, settings } = input;
  const deps = input.deps ?? defaultShareDeps();
  const notify: Notify = deps.notify;
  const text = () => buildDailyTableText(table, resolvedBusinessName());
  const copyText = async () => {
    await copyTableText(text(), notify);
  };

  if (action === "copy") {
    return copyTableText(text(), notify);
  }

  input.onPhase?.("rendering");
  let images: RenderedImage[];
  try {
    images = await (input.render ?? renderSummaryImages)(table, settings);
  } catch (e) {
    input.onPhase?.("idle");
    notify.error("Couldn't make the summary image", {
      description: e instanceof Error ? e.message : "Drawing failed.",
      action: { label: "Copy text instead", onClick: () => void copyText() },
    });
    return false;
  }

  try {
    input.rememberDay?.(table.date, {
      oldCash: table.cash.oldCash,
      cashAfterExpenses: table.cash.cashAfterExpenses,
    });
  } catch {
    /* remembering the figures is a convenience, never a reason to stop */
  }

  input.onPhase?.("sharing");
  try {
    const ctx = {
      images,
      owner: settings.whatsappOwner,
      copyText,
      openSettings: () => goToTab("settings"),
    };
    const res =
      action === "send"
        ? await sendToOwner(ctx, deps)
        : action === "download"
          ? await downloadImage(ctx, deps)
          : await shareImage(ctx, deps);
    return res.ok;
  } finally {
    input.onPhase?.("idle");
  }
}

/** Hook used by the Settings card and the Dashboard tile. */
export function useDailyTableActions() {
  const { settings, save } = useAppSettings();
  const [phase, setPhase] = useState<SummaryPhase>("idle");
  const busyRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ONE save() with the newest settings (the ref), so the two maps are
  // written together and nothing else saved meanwhile is overwritten.
  const rememberDay = useCallback(
    (date: string, record: DayRecord) => {
      const next = withDayRecord(settingsRef.current, date, record);
      if (next) save(next);
    },
    [save],
  );

  const run = useCallback(
    async (action: SummaryAction, table: DailyTable) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      try {
        return await runSummaryAction({
          action,
          table,
          settings: settingsRef.current,
          rememberDay,
          onPhase: setPhase,
        });
      } catch (e) {
        // runSummaryAction does not throw; this is the last line of defence.
        toast.error("Something went wrong", {
          description: e instanceof Error ? e.message : undefined,
        });
        return false;
      } finally {
        busyRef.current = false;
        setPhase("idle");
      }
    },
    [rememberDay],
  );

  return { run, phase, busy: phase !== "idle", settings };
}
