import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  db,
  newId,
  nowIso,
  type CalendarEventRow,
  type CalendarEventExceptionRow,
} from "./localdb";

/** Calendar recurrence is anchored to the event's stored local business time.
 * Truff stores dashboard calendar timestamps with the Asia/Kolkata (+05:30)
 * offset. Recurrence arithmetic is done on calendar dates, never by adding
 * milliseconds, so month-end and leap-year behavior is deterministic. */
function parseStoredLocal(iso: string) {
  const m = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{3})?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!m) throw new Error(`Invalid calendar timestamp: ${iso}`);
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4]),
    mi: Number(m[5]),
    s: Number(m[6] ?? 0),
    offset: m[7] === "Z" ? "+00:00" : (m[7] ?? "+05:30"),
  };
}
function isoFromStoredLocal(p: {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  offset: string;
}) {
  return `${String(p.y).padStart(4, "0")}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}T${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}:${String(p.s).padStart(2, "0")}.000${p.offset}`;
}
function daysInMonth(y: number, mo: number) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function addOccurrenceIso(
  baseIso: string,
  repeat: CalendarEventRow["repeat"],
  n: number,
) {
  const p = parseStoredLocal(baseIso);
  if (n === 0 || repeat === "none") return isoFromStoredLocal(p);
  const day0 = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  if (repeat === "daily") day0.setUTCDate(day0.getUTCDate() + n);
  else if (repeat === "weekly") day0.setUTCDate(day0.getUTCDate() + 7 * n);
  else if (repeat === "monthly") {
    const target = p.mo - 1 + n;
    const y = p.y + Math.floor(target / 12);
    const mo = ((target % 12) + 12) % 12;
    p.y = y;
    p.mo = mo + 1;
    p.d = Math.min(p.d, daysInMonth(y, mo + 1));
    return isoFromStoredLocal(p);
  } else {
    const y = p.y + n;
    p.y = y;
    p.d = Math.min(p.d, daysInMonth(y, p.mo));
    return isoFromStoredLocal(p);
  }
  p.y = day0.getUTCFullYear();
  p.mo = day0.getUTCMonth() + 1;
  p.d = day0.getUTCDate();
  return isoFromStoredLocal(p);
}
export function addOccurrence(
  base: Date,
  repeat: CalendarEventRow["repeat"],
  n: number,
) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(base);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  const wallClockIso = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.000+05:30`;
  return new Date(addOccurrenceIso(wallClockIso, repeat, n));
}
export function istDateTimeInput(iso: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}
export function occurrenceAt(
  startIso: string,
  repeat: CalendarEventRow["repeat"],
  from = new Date(),
): Date {
  const base = new Date(startIso);
  if (repeat === "none") return base;
  let n = 0;
  let d = base;
  while (d < from && n < 100000) {
    n++;
    d = addOccurrence(base, repeat, n);
  }
  return d;
}
export function latestOccurrenceOnOrBefore(
  base: Date,
  repeat: CalendarEventRow["repeat"],
  to: Date,
) {
  if (repeat === "none" || base > to) return base <= to ? base : null;
  let lo = 0,
    hi = 100000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (addOccurrence(base, repeat, mid) <= to) lo = mid;
    else hi = mid - 1;
  }
  const d = addOccurrence(base, repeat, lo);
  return d <= to ? d : null;
}
export function occurrencesBetween(
  row: CalendarEventRow,
  from: Date,
  to: Date,
) {
  const base = new Date(row.start_at);
  if (row.repeat === "none")
    return base <= to && new Date(row.end_at ?? row.start_at) >= from
      ? [base]
      : [];
  const duration = row.end_at
    ? Math.max(0, new Date(row.end_at).getTime() - base.getTime())
    : 0;
  const searchFrom = new Date(from.getTime() - duration);
  const out: Date[] = [];
  let n = 0;
  let d = base;
  while (d < searchFrom && n < 100000) {
    n++;
    d = addOccurrence(base, row.repeat, n);
  }
  for (let i = 0; i < 10000 && d <= to; i++) {
    if (new Date(d.getTime() + duration) >= from && d <= to)
      out.push(new Date(d));
    n++;
    d = addOccurrence(base, row.repeat, n);
  }
  return out;
}

async function exceptionsFor(ids: string[]) {
  if (!ids.length) return new Map<string, CalendarEventExceptionRow>();
  const rows = await db.calendar_event_exceptions
    .where("event_id")
    .anyOf(ids)
    .toArray();
  return new Map(rows.map((r) => [`${r.event_id}@${r.occurrence_at}`, r]));
}

export function useCalendarEvents(
  from: Date,
  to: Date,
  includeOverdueReminders = false,
) {
  return useQuery({
    queryKey: [
      "calendar_events",
      from.toISOString(),
      to.toISOString(),
      includeOverdueReminders,
    ],
    initialData: [],
    queryFn: async () => {
      const fromIso = from.toISOString(),
        toIso = to.toISOString();
      const oneOffStart = await db.calendar_events
        .where("start_at")
        .between(fromIso, toIso, true, true)
        .toArray();
      const spanning = await db.calendar_events
        .where("end_at")
        .aboveOrEqual(fromIso)
        .and((r) => r.start_at <= toIso)
        .toArray();
      const overdueReminders = includeOverdueReminders
        ? await db.calendar_events
            .where("start_at")
            .belowOrEqual(toIso)
            .and((r) => r.kind === "reminder" && r.status === "pending")
            .toArray()
        : [];
      const oneOff = [
        ...new Map(
          [...oneOffStart, ...spanning, ...overdueReminders].map((r) => [
            r.id,
            r,
          ]),
        ).values(),
      ];
      const repeating = await db.calendar_events
        .where("repeat")
        .anyOf(["daily", "weekly", "monthly", "yearly"])
        .filter((r) => r.status !== "cancelled" && r.start_at <= toIso)
        .toArray();
      const bases = [
        ...new Map([...oneOff, ...repeating].map((r) => [r.id, r])).values(),
      ].filter((r) => r.status !== "cancelled");
      const ex = await exceptionsFor(bases.map((r) => r.id));
      const out: CalendarEventRow[] = [];
      for (const row of bases) {
        const baseStart = new Date(row.start_at);
        const baseEnd = row.end_at ? new Date(row.end_at) : null;
        const duration = baseEnd
          ? Math.max(0, baseEnd.getTime() - baseStart.getTime())
          : 0;
        const emitted = new Set<string>();
        const starts = occurrencesBetween(row, from, to);
        if (
          includeOverdueReminders &&
          row.kind === "reminder" &&
          row.status === "pending" &&
          row.start_at <= toIso &&
          row.repeat !== "none"
        ) {
          const latest = latestOccurrenceOnOrBefore(baseStart, row.repeat, to);
          if (
            latest &&
            latest < from &&
            !starts.some((x) => x.getTime() === latest.getTime())
          )
            starts.push(latest);
        } else if (
          includeOverdueReminders &&
          row.kind === "reminder" &&
          row.status === "pending" &&
          row.repeat === "none" &&
          !starts.length
        ) {
          starts.push(baseStart);
        }
        for (const start of starts) {
          const key = `${row.id}@${start.toISOString()}`;
          emitted.add(key);
          const exception = ex.get(key);
          const effectiveStart =
            exception?.status === "snoozed" && exception.snooze_until
              ? exception.snooze_until
              : start.toISOString();
          const effectiveEnd = baseEnd
            ? new Date(
                new Date(effectiveStart).getTime() + duration,
              ).toISOString()
            : row.end_at;
          if (
            exception?.status === "cancelled" ||
            exception?.status === "done"
          ) {
            out.push({
              ...row,
              id: key,
              start_at: effectiveStart,
              end_at: effectiveEnd,
              status: exception.status,
            });
            continue;
          }
          out.push({
            ...row,
            id: key,
            start_at: effectiveStart,
            end_at: effectiveEnd,
            status: "pending",
          });
        }
        for (const exception of ex.values()) {
          if (
            exception.event_id !== row.id ||
            exception.status !== "snoozed" ||
            !exception.snooze_until ||
            emitted.has(exception.id)
          )
            continue;
          const snoozed = new Date(exception.snooze_until);
          if (snoozed >= from && snoozed <= to) {
            const end = baseEnd
              ? new Date(snoozed.getTime() + duration).toISOString()
              : row.end_at;
            out.push({
              ...row,
              id: exception.id,
              start_at: snoozed.toISOString(),
              end_at: end,
              status: "pending",
            });
          }
        }
      }
      return out;
    },
  });
}

export function useSaveCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      p: Omit<CalendarEventRow, "id" | "created_at" | "updated_at"> & {
        id?: string;
      },
    ) => {
      const now = nowIso();
      const existing = p.id ? await db.calendar_events.get(p.id) : undefined;
      const row = {
        ...p,
        title: p.title.trim(),
        id: p.id ?? newId(),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      if (!row.title) throw new Error("Event title is required");
      if (row.end_at && row.end_at < row.start_at)
        throw new Error("End time must be after start time");
      if (row.remind_before_minutes != null && row.remind_before_minutes < 0)
        throw new Error("Reminder lead time cannot be negative");
      await db.calendar_events.put(row);
      return row;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar_events"] }),
  });
}
async function saveException(
  id: string,
  status: CalendarEventExceptionRow["status"],
  snoozeUntil: string | null,
) {
  const [eventId, occurrenceAt] = id.split("@");
  if (!eventId || !occurrenceAt) throw new Error("Invalid calendar occurrence");
  const now = nowIso();
  await db.calendar_event_exceptions.put({
    id: `${eventId}@${occurrenceAt}`,
    event_id: eventId,
    occurrence_at: occurrenceAt,
    status,
    snooze_until: snoozeUntil,
    created_at: now,
    updated_at: now,
  });
}
export async function saveCalendarOccurrenceAsOneOff(row: CalendarEventRow) {
  if (!row.id.includes("@"))
    throw new Error("This is already a standalone event");
  const eventId = row.id.split("@")[0]!;
  const base = await db.calendar_events.get(eventId);
  if (!base) throw new Error("Calendar series no longer exists");
  const now = nowIso();
  const id = newId();
  const oneOff: CalendarEventRow = {
    ...base,
    id,
    start_at: row.start_at,
    end_at: row.end_at,
    repeat: "none",
    status: "pending",
    created_at: now,
    updated_at: now,
  };
  await db.transaction(
    "rw",
    db.calendar_events,
    db.calendar_event_exceptions,
    async () => {
      await db.calendar_events.put(oneOff);
      await saveException(row.id, "cancelled", null);
    },
  );
  return oneOff;
}

export function useDeleteCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (id.includes("@")) await saveException(id, "cancelled", null);
      else
        await db.calendar_events.update(id, {
          status: "cancelled",
          updated_at: nowIso(),
        });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar_events"] }),
  });
}
export function useMarkCalendarDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (id.includes("@")) await saveException(id, "done", null);
      else
        await db.calendar_events.update(id, {
          status: "done",
          updated_at: nowIso(),
        });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar_events"] }),
  });
}
export function useRestoreCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Restoring an occurrence means removing its exception so the
      // recurrence engine shows the base event again (exception statuses are
      // done/cancelled/snoozed — there is no "pending" exception).
      if (id.includes("@")) await db.calendar_event_exceptions.delete(id);
      else
        await db.calendar_events.update(id, {
          status: "pending",
          updated_at: nowIso(),
        });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar_events"] }),
  });
}
export function useSnoozeCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { id: string; minutes: number }) => {
      if (p.minutes <= 0) throw new Error("Snooze duration must be positive");
      const [eventId, occurrenceAt] = p.id.split("@");
      if (!eventId || !occurrenceAt)
        throw new Error("Invalid calendar occurrence");
      const d = new Date(occurrenceAt);
      d.setMinutes(d.getMinutes() + p.minutes);
      await saveException(p.id, "snoozed", d.toISOString());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar_events"] }),
  });
}
