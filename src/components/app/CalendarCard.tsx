import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Check,
  RotateCcw,
  Trash2,
  Pencil,
  Clock3,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCalendarEvents,
  useDeleteCalendarEvent,
  useMarkCalendarDone,
  useRestoreCalendarEvent,
  useSaveCalendarEvent,
  useSnoozeCalendarEvent,
  istDateTimeInput,
  saveCalendarOccurrenceAsOneOff,
} from "@/lib/calendar-events";
import { useTurfBookings, type TurfBooking } from "@/lib/ops";
import { db, type CalendarEventRow } from "@/lib/localdb";
import { localDateStr, errorMessage } from "@/lib/utils";
import { formatDMY, money } from "@/lib/biz";
import { isFinancialBooking } from "@/lib/analytics";
import { CalendarMonthGrid } from "./CalendarMonthGrid";

const kinds = ["reminder", "meeting", "event"] as const;
const repeats = ["none", "daily", "weekly", "monthly", "yearly"] as const;
const colors = [
  { value: "#2563eb", label: "Blue" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#16a34a", label: "Green" },
  { value: "#9333ea", label: "Purple" },
  { value: "#dc2626", label: "Red" },
];
const categoryColors: Record<string, string> = {
  booking: "#0f766e",
  reminder: "#f59e0b",
  meeting: "#2563eb",
  event: "#9333ea",
};
const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM" of a month anchor. The anchor is only a calendar position
 * (local-constructed Date used for year/month/weekday arithmetic), never a
 * point in time, so it is independent of the device time zone. */
const monthKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const lastDayOfMonth = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
/** Month anchor for a "YYYY-MM-DD" IST date string. */
const monthAnchorOf = (dateStr: string) => {
  const [y = 1970, m = 1] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, 1);
};
const istIso = (date: string, time: string) =>
  new Date(`${date}T${time || "00:00"}:00+05:30`).toISOString();

export function CalendarCard() {
  // "Today" is the IST date everywhere on this card, whatever the device
  // time zone is.
  const [month, setMonth] = useState(() => monthAnchorOf(localDateStr()));
  const [selectedDate, setSelectedDate] = useState(localDateStr());
  const [open, setOpen] = useState(false);
  const [bookingDetails, setBookingDetails] = useState<TurfBooking | null>(
    null,
  );
  const [scopePrompt, setScopePrompt] = useState<CalendarEventRow | null>(null);
  const [filters, setFilters] = useState({
    booking: true,
    reminder: true,
    meeting: true,
    event: true,
  });
  const monthStart = useMemo(
    () => new Date(istIso(`${monthKey(month)}-01`, "00:00")),
    [month],
  );
  const monthEnd = useMemo(
    () =>
      new Date(
        new Date(
          istIso(`${monthKey(month)}-${pad2(lastDayOfMonth(month))}`, "23:59"),
        ).getTime() + 59_999,
      ),
    [month],
  );
  const { data: monthData = [] } = useCalendarEvents(monthStart, monthEnd);
  const { data: bookings = [] } = useTurfBookings();
  // IST has no DST, so fixed 24h steps from IST midnight are exact.
  const todayStartMs = new Date(istIso(localDateStr(), "00:00")).getTime();
  const windowStart = new Date(todayStartMs - 30 * DAY_MS);
  const windowEnd = new Date(todayStartMs + 8 * DAY_MS - 1);
  const { data: reminderWindow = [] } = useCalendarEvents(
    windowStart,
    windowEnd,
    true,
  );
  const save = useSaveCalendarEvent();
  const del = useDeleteCalendarEvent();
  const done = useMarkCalendarDone();
  const restore = useRestoreCalendarEvent();
  const snooze = useSnoozeCalendarEvent();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(localDateStr());
  const [time, setTime] = useState("09:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [kind, setKind] = useState<(typeof kinds)[number]>("reminder");
  const [repeat, setRepeat] = useState<(typeof repeats)[number]>("none");
  const [lead, setLead] = useState("0");
  const [allDay, setAllDay] = useState(false);
  const [color, setColor] = useState(colors[0]!.value);

  useEffect(() => {
    const tick = () => {
      const nowMs = Date.now();
      for (const e of reminderWindow) {
        if (e.kind !== "reminder" || e.status !== "pending") continue;
        const trigger =
          new Date(e.start_at).getTime() -
          (e.remind_before_minutes ?? 0) * 60000;
        if (nowMs >= trigger && nowMs <= trigger + 60000) {
          const key = `truff:calendar-alert:${e.id}:${e.start_at}`;
          if (localStorage.getItem(key)) continue;
          localStorage.setItem(key, "1");
          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          )
            new Notification(`Reminder: ${e.title}`);
          else window.alert(`Reminder: ${e.title}`);
        }
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [reminderWindow]);

  const reset = (keepDate = false) => {
    setEditingId(null);
    setTitle("");
    setNotes("");
    if (!keepDate) setDate(localDateStr());
    setTime("09:00");
    setEndDate("");
    setEndTime("");
    setKind("reminder");
    setRepeat("none");
    setLead("0");
    setAllDay(false);
    setColor(colors[0]!.value);
  };
  const openNew = (day = selectedDate) => {
    reset(true);
    setDate(day);
    setSelectedDate(day);
    setOpen(true);
  };
  const beginEdit = (e: CalendarEventRow) => {
    if (e.id.includes("@") && e.repeat !== "none") {
      setScopePrompt(e);
      return;
    }
    fill(e);
    setOpen(true);
  };
  const fill = (e: CalendarEventRow) => {
    setEditingId(e.id);
    setTitle(e.title);
    setNotes(e.notes || "");
    const p = istDateTimeInput(e.start_at);
    setDate(p.date);
    setTime(p.time);
    setKind(e.kind);
    setRepeat(e.repeat);
    setLead(String(e.remind_before_minutes ?? 0));
    setAllDay(!!e.all_day);
    setEndDate(e.end_at ? istDateTimeInput(e.end_at).date : "");
    setEndTime(e.end_at ? istDateTimeInput(e.end_at).time : "");
    setColor(e.color || colors[0]!.value);
    setSelectedDate(p.date);
  };
  const editSeries = async () => {
    if (scopePrompt) {
      const id = scopePrompt.id.split("@")[0]!;
      const base = await db.calendar_events.get(id);
      if (base) {
        setScopePrompt(null);
        fill(base);
        setOpen(true);
      } else toast.error("Calendar series no longer exists");
    }
  };
  const editOccurrence = async () => {
    if (!scopePrompt) return;
    try {
      const one = await saveCalendarOccurrenceAsOneOff(scopePrompt);
      setScopePrompt(null);
      fill(one);
      setOpen(true);
    } catch (e) {
      toast.error(errorMessage(e, "Could not edit occurrence"));
    }
  };
  const submit = () => {
    try {
      if (!title.trim()) throw new Error("Event title is required");
      const start = istIso(date, allDay ? "00:00" : time);
      const end = endDate
        ? allDay
          ? istIso(endDate, "00:00")
          : istIso(endDate, endTime || time)
        : null;
      save.mutate(
        {
          kind,
          title: title.trim(),
          notes: notes.trim() || null,
          start_at: start,
          end_at: end,
          all_day: allDay,
          remind_before_minutes:
            kind === "reminder" ? Math.max(0, Number(lead) || 0) : null,
          repeat,
          status: "pending",
          color,
          customer_id: null,
          ...(editingId ? { id: editingId } : {}),
        },
        {
          onSuccess: () => {
            setOpen(false);
            reset(true);
          },
        },
      );
    } catch (e) {
      toast.error(errorMessage(e, "Could not save event"));
    }
  };

  const monthItems = useMemo(
    () => monthData.filter((e) => filters[e.kind]),
    [monthData, filters],
  );
  const bookingItems = useMemo(
    () =>
      bookings.filter(
        (b) =>
          isFinancialBooking(b) &&
          b.booking_date >= `${monthKey(month)}-01` &&
          b.booking_date <=
            `${monthKey(month)}-${pad2(lastDayOfMonth(month))}` &&
          filters.booking,
      ),
    [bookings, month, filters.booking],
  );
  const dayItems = useMemo(() => {
    const manual = monthItems.filter(
      (e) => istDateTimeInput(e.start_at).date === selectedDate,
    );
    const bs = bookingItems.filter((b) => b.booking_date === selectedDate);
    return { manual, bs };
  }, [monthItems, bookingItems, selectedDate]);
  const itemsForDay = (k: string) => {
    return {
      key: k,
      manual: monthItems.filter((e) => istDateTimeInput(e.start_at).date === k),
      bookings: bookingItems.filter((b) => b.booking_date === k),
    };
  };
  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="size-4" />
          Calendar
        </CardTitle>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const today = localDateStr();
              setMonth(monthAnchorOf(today));
              setSelectedDate(today);
            }}
          >
            Today
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous month"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
            }
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-32 text-center text-sm font-semibold">
            {month.toLocaleDateString("en-IN", {
              month: "long",
              year: "numeric",
            })}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next month"
            onClick={() =>
              setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
            }
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button size="sm" onClick={() => openNew()}>
            <Plus className="mr-1 size-4" />
            Event
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-2 text-xs">
          <span className="font-semibold">Show</span>
          {(["booking", "reminder", "meeting", "event"] as const).map((k) => (
            <label key={k} className="flex min-h-8 items-center gap-1.5">
              <input
                type="checkbox"
                checked={filters[k]}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, [k]: e.target.checked }))
                }
              />
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: categoryColors[k] }}
              />
              {k[0]!.toUpperCase() + k.slice(1)}
              {k === "booking" ? "s" : "s"}
            </label>
          ))}
        </div>
        <CalendarMonthGrid
          month={month}
          selectedKey={selectedDate}
          todayKey={localDateStr()}
          maxChips={2}
          onSelect={setSelectedDate}
          getDay={(key) => {
            const x = itemsForDay(key);
            return {
              items: [
                ...x.bookings.map((b) => ({
                  id: `b-${b.id}`,
                  label: b.customer_name || b.booking_no || "Booking",
                  color: categoryColors["booking"] ?? "#3b82f6",
                })),
                ...x.manual.map((e) => ({
                  id: `e-${e.id}`,
                  label: `${e.all_day ? "" : `${formatTime(e.start_at)} `}${e.title}`,
                  color: e.color || (categoryColors[e.kind] ?? "#6b7280"),
                })),
              ],
            };
          }}
        />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">
                {new Date(`${selectedDate}T00:00:00`).toLocaleDateString(
                  "en-IN",
                  { weekday: "long", day: "numeric", month: "long" },
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openNew(selectedDate)}
              >
                <Plus className="mr-1 size-3" />
                Add
              </Button>
            </div>
            {dayItems.manual.length === 0 && dayItems.bs.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Nothing scheduled. Use Add to create an event.
              </div>
            ) : (
              <div className="space-y-2">
                {dayItems.bs.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBookingDetails(b)}
                    className="block w-full rounded-lg border p-3 text-left"
                  >
                    <div className="flex min-w-0 items-center gap-2 font-medium">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: categoryColors["booking"] }}
                      />
                      {b.booking_no} · {b.customer_name || "Booking"}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {b.start_time || "All day"}
                      {b.end_time ? `–${b.end_time}` : ""} · {b.slot_name} ·{" "}
                      {b.status}
                    </div>
                    {b.notes ? (
                      <div className="mt-1 break-words text-xs">{b.notes}</div>
                    ) : null}
                  </button>
                ))}
                {dayItems.manual.map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 basis-40 text-left"
                      onClick={() => beginEdit(e)}
                    >
                      <div className="font-medium">
                        <span
                          className="mr-2 inline-block size-2 rounded-full"
                          style={{
                            backgroundColor: e.color || categoryColors[e.kind],
                          }}
                        />
                        {e.title}
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock3 className="size-3" />
                        {e.all_day ? "All day" : formatTime(e.start_at)}
                        {e.end_at ? `–${formatTime(e.end_at)}` : ""}
                        {e.repeat !== "none" ? ` · repeats ${e.repeat}` : ""}
                      </div>
                      {e.notes ? (
                        <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
                          {e.notes}
                        </div>
                      ) : null}
                    </button>
                    <div className="ml-auto flex shrink-0 flex-wrap gap-3">
                      {e.kind === "reminder" && e.status === "pending" ? (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Mark this occurrence done"
                            aria-label="Mark this occurrence done"
                            onClick={() => done.mutate(e.id)}
                          >
                            <Check className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Snooze 15 minutes"
                            aria-label="Snooze 15 minutes"
                            onClick={() =>
                              snooze.mutate({ id: e.id, minutes: 15 })
                            }
                          >
                            <RotateCcw className="size-4" />
                          </Button>
                        </>
                      ) : null}
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Edit"
                        aria-label="Edit"
                        onClick={() => beginEdit(e)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title={
                          e.id.includes("@")
                            ? "Cancel this occurrence"
                            : "Cancel series"
                        }
                        aria-label={
                          e.id.includes("@")
                            ? "Cancel this occurrence"
                            : "Cancel series"
                        }
                        onClick={() => {
                          if (
                            e.id.includes("@") ||
                            window.confirm("Cancel the complete event series?")
                          )
                            del.mutate(e.id);
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-lg border p-3">
            <div className="mb-2 text-sm font-semibold">Legend</div>
            <div className="grid gap-2 text-xs">
              {Object.entries(categoryColors).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2">
                  <span
                    className="size-3 rounded-full"
                    style={{ backgroundColor: v }}
                  />
                  {k[0]!.toUpperCase() + k.slice(1)}
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
              Recurring events keep their series and per-occurrence exceptions.
              Editing or cancelling one occurrence is kept separate from
              changing the full series.
            </div>
          </div>
        </div>
      </CardContent>
      <Dialog
        open={!!scopePrompt}
        onOpenChange={(v) => !v && setScopePrompt(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Recurring event</DialogTitle>
            <DialogDescription>
              Choose exactly what you want to change.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button onClick={editOccurrence}>Edit this occurrence only</Button>
            <Button variant="outline" onClick={editSeries}>
              Edit the complete series
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!bookingDetails}
        onOpenChange={(v) => !v && setBookingDetails(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Booking details</DialogTitle>
            <DialogDescription>
              Existing bookings appear in the shared calendar without changing
              the booking engine.
            </DialogDescription>
          </DialogHeader>
          {bookingDetails ? (
            <div className="grid gap-3 text-sm">
              <div className="grid grid-cols-2 gap-2 [&>div]:min-w-0 [&>div]:break-words">
                <div>
                  <div className="text-xs text-muted-foreground">
                    Booking number
                  </div>
                  <div className="font-medium">{bookingDetails.booking_no}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Date</div>
                  <div className="font-medium">
                    {formatDMY(bookingDetails.booking_date.slice(0, 10))}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Customer</div>
                  <div>{bookingDetails.customer_name || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div>{bookingDetails.status}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Time</div>
                  <div>
                    {bookingDetails.start_time || "All day"}
                    {bookingDetails.end_time
                      ? `–${bookingDetails.end_time}`
                      : ""}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Slot</div>
                  <div>{bookingDetails.slot_name}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Amount</div>
                  <div>{money(bookingDetails.total_amount)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Payment</div>
                  <div>{bookingDetails.payment_mode || "—"}</div>
                </div>
              </div>
              {bookingDetails.notes ? (
                <div>
                  <div className="text-xs text-muted-foreground">Notes</div>
                  <div>{bookingDetails.notes}</div>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setBookingDetails(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) reset(true);
        }}
      >
        <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0">
          <DialogHeader className="border-b px-5 pb-3 pt-5">
            <DialogTitle>{editingId ? "Edit event" : "Add event"}</DialogTitle>
            <DialogDescription>
              Every field stays labelled so the event remains understandable
              after it is saved.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="cal-title">Title</Label>
                <Input
                  id="cal-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What is happening?"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-type">Type</Label>
                <select
                  id="cal-type"
                  className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
                  value={kind}
                  onChange={(e) =>
                    setKind(e.target.value as (typeof kinds)[number])
                  }
                >
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {k[0]!.toUpperCase() + k.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label>Color</Label>
                <div className="flex h-10 items-center gap-2">
                  {colors.map((c) => (
                    <button
                      type="button"
                      key={c.value}
                      aria-label={c.label}
                      onClick={() => setColor(c.value)}
                      className={`size-7 rounded-full border-2 ${color === c.value ? "ring-2 ring-primary ring-offset-2" : ""}`}
                      style={{ backgroundColor: c.value }}
                    />
                  ))}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-start-date">Start date</Label>
                <Input
                  id="cal-start-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-start-time">Start time</Label>
                <Input
                  id="cal-start-time"
                  type="time"
                  disabled={allDay}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-end-date">
                  End date{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="cal-end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-end-time">End time</Label>
                <Input
                  id="cal-end-time"
                  type="time"
                  disabled={allDay}
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
              <label className="flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                />
                All-day event
              </label>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-repeat">Repeat</Label>
                <select
                  id="cal-repeat"
                  className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
                  value={repeat}
                  onChange={(e) =>
                    setRepeat(e.target.value as (typeof repeats)[number])
                  }
                >
                  {repeats.map((r) => (
                    <option key={r} value={r}>
                      {r === "none" ? "Does not repeat" : `Repeats ${r}`}
                    </option>
                  ))}
                </select>
              </div>
              {kind === "reminder" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="cal-reminder">Reminder</Label>
                  <select
                    id="cal-reminder"
                    className="h-10 rounded-md border bg-background px-3 text-base md:text-sm"
                    value={lead}
                    onChange={(e) => setLead(e.target.value)}
                  >
                    {[
                      ["0", "At time"],
                      ["5", "5 minutes before"],
                      ["15", "15 minutes before"],
                      ["30", "30 minutes before"],
                      ["60", "1 hour before"],
                      ["1440", "1 day before"],
                    ].map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="cal-notes">
                  Notes{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <Textarea
                  id="cal-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Short guidance or details"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="border-t bg-background px-5 py-3">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending
                ? "Saving…"
                : editingId
                  ? "Save changes"
                  : "Create event"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
