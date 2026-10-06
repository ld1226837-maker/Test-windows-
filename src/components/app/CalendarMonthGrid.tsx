import { cn } from "@/lib/utils";

export interface CalendarGridItem {
  id: string;
  /** Short text for the chip shown on wide screens. */
  label: string;
  /** Dot / chip accent colour (any CSS colour). */
  color: string;
}

export interface CalendarGridDay {
  items?: CalendarGridItem[];
  /** Optional one-line summary under the number, e.g. "3 slots". */
  summary?: string;
}

interface Props {
  /** Any date inside the month to show. Only year and month are read, as
   * plain calendar numbers, so the device time zone never matters. */
  month: Date;
  /** "YYYY-MM-DD" of the selected day. */
  selectedKey: string;
  /** "YYYY-MM-DD" of today (the caller's clock, IST in this app). */
  todayKey: string;
  getDay: (key: string) => CalendarGridDay;
  onSelect: (key: string) => void;
  /** Chips shown per day from the `sm` breakpoint up. 0 = dots/summary only. */
  maxChips?: number;
}

const WEEKDAYS = [
  { full: "Sunday", short: "Sun", letter: "S" },
  { full: "Monday", short: "Mon", letter: "M" },
  { full: "Tuesday", short: "Tue", letter: "T" },
  { full: "Wednesday", short: "Wed", letter: "W" },
  { full: "Thursday", short: "Thu", letter: "T" },
  { full: "Friday", short: "Fri", letter: "F" },
  { full: "Saturday", short: "Sat", letter: "S" },
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const MAX_DOTS = 3;

/**
 * One month grid for every calendar in the app.
 *
 * - Every day is a single button, so a tap always selects the day (no tiny
 *   nested targets). Chips are plain text inside it, never nested buttons.
 * - Phones (<640px): single-letter weekdays, number plus up to 3 colour dots
 *   and a "+N" that is always `count - dots shown`. Fixed ~56px rows.
 * - `sm` and up: "Sun…Sat" headers and, when `maxChips > 0`, short chips with
 *   the same `+N` rule applied to the chips actually rendered.
 * - Chips use theme colours with a coloured edge instead of white-on-colour
 *   text, so contrast holds in light and dark mode.
 */
export function CalendarMonthGrid({
  month,
  selectedKey,
  todayKey,
  getDay,
  onSelect,
  maxChips = 0,
}: Props) {
  const year = month.getFullYear();
  const m = month.getMonth();
  const leading = new Date(year, m, 1).getDay();
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const monthLabel = month.toLocaleDateString("en-IN", { month: "long" });
  const withChips = maxChips > 0;

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {WEEKDAYS.map((d, i) => (
          <div key={i} className="min-w-0 py-1">
            <span className="sr-only">{d.full}</span>
            <span aria-hidden="true" className="sm:hidden">
              {d.letter}
            </span>
            <span aria-hidden="true" className="hidden sm:inline">
              {d.short}
            </span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: leading }, (_, i) => (
          <span key={`blank-${i}`} aria-hidden="true" />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const key = `${year}-${pad2(m + 1)}-${pad2(day)}`;
          const { items = [], summary } = getDay(key);
          const count = items.length;
          const selected = key === selectedKey;
          const chips = items.slice(0, maxChips);
          const dots = items.slice(0, MAX_DOTS);
          const detail =
            summary ?? (count ? `${count} item${count > 1 ? "s" : ""}` : "");
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              aria-pressed={selected}
              aria-current={key === todayKey ? "date" : undefined}
              aria-label={`${day} ${monthLabel}${detail ? `, ${detail}` : ""}`}
              className={cn(
                "lift flex min-w-0 flex-col items-center justify-start gap-0.5 overflow-hidden rounded-lg border px-0.5 py-1.5 text-sm transition-colors",
                withChips ? "h-14 sm:h-auto sm:min-h-[5.5rem]" : "h-14",
                count > 0 && "frost-soft border-primary/40 font-semibold",
                key === todayKey && "ring-1 ring-primary",
                selected && "bg-primary text-primary-foreground shadow-md",
              )}
            >
              <span>{day}</span>
              {summary ? (
                <span
                  className={cn(
                    "max-w-full truncate text-[11px] leading-tight",
                    // 80% white on the selected (blue) day is only 3.5:1.
                    !selected && "opacity-80",
                  )}
                >
                  {summary}
                </span>
              ) : null}
              {!summary && count > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex items-center justify-center gap-0.5",
                    withChips && "sm:hidden",
                  )}
                >
                  {dots.map((it) => (
                    <span
                      key={it.id}
                      className="size-1.5 rounded-full ring-1 ring-background/60"
                      style={{ backgroundColor: it.color }}
                    />
                  ))}
                  {count > MAX_DOTS ? (
                    <span className="text-[10px] leading-none">
                      +{count - MAX_DOTS}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {!summary && withChips && count > 0 ? (
                <span
                  aria-hidden="true"
                  className="hidden w-full min-w-0 flex-col gap-0.5 sm:flex"
                >
                  {chips.map((it) => (
                    <span
                      key={it.id}
                      className="block w-full truncate rounded border-l-[3px] bg-muted px-1 text-left text-[11px] font-normal leading-4 text-foreground"
                      style={{ borderLeftColor: it.color }}
                    >
                      {it.label}
                    </span>
                  ))}
                  {count > chips.length ? (
                    <span className="text-left text-[11px] font-normal leading-4">
                      +{count - chips.length} more
                    </span>
                  ) : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
