// Display formatting for the League Pass content calendar. Reuses the league-print-clock
// maths in `content-schedule/scheduleTime.ts` rather than re-deriving it; only adds the
// couple of formats that module doesn't already have (a date with no time, a week range).

import { formatPrintTime } from "@/components/content-schedule/scheduleTime";
import type { CalendarEntry } from "./types";

/** NFL week boundaries are stored as Tuesday 00:00 UTC, which reads as Monday evening in a
 * US league timezone — shifting each end 12h inward before formatting keeps the printed
 * range on the days the week actually covers (Tue–Mon), without touching the boundary
 * value itself (still used as-is for phase/current-week math). */
const BOUNDARY_INSET_MS = 12 * 60 * 60 * 1000;

/** "Tue, Sep 23" — no time, no year. Used for a published entry's run date. */
export function formatShortDay(instantMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(instantMs));
  } catch {
    return new Date(instantMs).toDateString();
  }
}

/** "Sep 22–28" (same month) or "Sep 29 – Oct 5" (crosses a month) for an NFL week's Tue..Mon
 * span, read in the league's own clock. */
export function formatWeekRange(startMs: number, endMs: number, timeZone: string): string {
  try {
    const monthDay = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" });
    const dayOnly = new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" });

    const start = new Date(startMs + BOUNDARY_INSET_MS);
    const end = new Date(endMs - BOUNDARY_INSET_MS);

    const startParts = monthDay.formatToParts(start);
    const startMonth = startParts.find((part) => part.type === "month")?.value ?? "";
    const startDay = startParts.find((part) => part.type === "day")?.value ?? "";
    const endMonth = monthDay.formatToParts(end).find((part) => part.type === "month")?.value ?? "";
    const endDay = dayOnly.format(end);

    return startMonth === endMonth
      ? `${startMonth} ${startDay}–${endDay}`
      : `${startMonth} ${startDay} – ${endMonth} ${endDay}`;
  } catch {
    return "";
  }
}

export interface EntryTimingDisplay {
  primary: string;
  secondary?: string;
}

/**
 * How an entry's `at`/`timing` reads on screen. `at` is an exact instant — formatted as-is,
 * in the league timezone, no inset — for both "exact" and "estimated" timing (only the week
 * boundaries need the Tue–Mon correction above); "estimated" prefixes it with "~" and
 * surfaces the note as secondary text. An "event" story with no row yet (`at` null) reduces
 * to its note, or a plain placeholder when there isn't one.
 */
export function describeEntryTiming(entry: CalendarEntry, timeZone: string): EntryTimingDisplay {
  if (entry.at == null) {
    return { primary: "Not scheduled yet", secondary: entry.note ?? undefined };
  }
  const when = formatPrintTime(entry.at, timeZone);
  if (entry.timing === "estimated") {
    return { primary: `~ ${when}`, secondary: entry.note ?? undefined };
  }
  return { primary: when, secondary: entry.timing === "event" ? entry.note ?? undefined : undefined };
}
