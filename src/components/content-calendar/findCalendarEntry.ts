import type { CalendarEntry, ContentCalendarResult } from "./types";

/** Every entry in a calendar result, flattened — every week's rows plus the undated ones. */
export function allCalendarEntries(calendar: ContentCalendarResult): CalendarEntry[] {
  return [...calendar.weeks.flatMap((week) => week.entries), ...calendar.undated];
}

/**
 * The calendar row a manager's in-progress generation form matches, if any (spec: warn
 * before spending credits on a story the League Pass already has coming). Same content
 * type, then: an exact week match when both the form and the row have one, else the
 * soonest future row of that type — an event story with no `at` yet is offered last, as
 * the weakest possible match.
 */
export function findMatchingCalendarEntry(
  calendar: ContentCalendarResult,
  contentType: string,
  week: number | null | undefined,
  now: number = Date.now()
): CalendarEntry | null {
  const candidates = allCalendarEntries(calendar).filter((entry) => entry.contentType === contentType);
  if (candidates.length === 0) return null;

  if (week != null) {
    const weekMatches = candidates.filter((entry) => entry.week === week);
    if (weekMatches.length > 0) {
      return weekMatches.slice().sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))[0];
    }
  }

  const future = candidates
    .filter((entry) => entry.at !== null && entry.at >= now)
    .sort((a, b) => (a.at as number) - (b.at as number));
  if (future.length > 0) return future[0];

  const eventOnly = candidates.filter((entry) => entry.at === null);
  return eventOnly[0] ?? null;
}
