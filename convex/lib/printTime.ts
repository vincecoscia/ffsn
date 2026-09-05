/**
 * Print-time alignment for articles that wait on interviews (owner, 2026-09-05: managers get
 * a real window - 24 hours for a recap, a few hours for an event article - and the article
 * never prints before it has run).
 *
 * `alignPrintTime` takes the earliest instant the article may print (send time + window) and
 * moves it to the schedule's own time of day when the schedule has one, so a Tuesday 11:00
 * recap whose interviews went out at 00:30 still prints at 11:00 - the next day's, not
 * 00:30's. Event schedules have no time of day; they round up to the next full hour.
 */

const DEFAULT_TIME_ZONE = "America/New_York";
const HOUR_MS = 60 * 60 * 1000;

type ScheduleShape =
  | { type: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | { type: "relative"; relativeTo: string; offsetDays: number; hour: number; minute: number }
  | { type: "event_triggered"; trigger: string; delayMinutes?: number }
  | { type: "season_based"; trigger: string; delayDays?: number; hour: number; minute: number; dayOfWeek?: number }
  | { type: string; hour?: number; minute?: number };

function zoneParts(instantMs: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

/** Offset (ms) of `timeZone` from UTC at `instantMs`; positive east of UTC. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const p = zoneParts(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = instantMs - (instantMs % 60000);
  return asUtc - truncated;
}

/** The instant of `hour:minute` wall-clock time on the zone-local date `year-month-day`. */
function instantOfLocal(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two rounds settle a DST boundary.
  let instant = guess - zoneOffsetMs(guess, timeZone);
  instant = guess - zoneOffsetMs(instant, timeZone);
  return instant;
}

/** The zone-local hour (0-23) at `instantMs`; falls back to the default zone on a bad name. */
export function localHour(instantMs: number, timeZone: string | undefined): number {
  const zone = timeZone && timeZone.trim().length > 0 ? timeZone : DEFAULT_TIME_ZONE;
  try {
    return zoneParts(instantMs, zone).hour;
  } catch {
    return zoneParts(instantMs, DEFAULT_TIME_ZONE).hour;
  }
}

/** The first instant at `hour:minute` (zone wall-clock) that is >= `afterMs`. */
export function nextWallClockAtOrAfter(afterMs: number, hour: number, minute: number, timeZone: string): number {
  const p = zoneParts(afterMs, timeZone);
  for (let dayOffset = 0; dayOffset <= 3; dayOffset++) {
    const candidate = instantOfLocal(p.year, p.month, p.day + dayOffset, hour, minute, timeZone);
    if (candidate >= afterMs) return candidate;
  }
  return afterMs;
}

/**
 * The first instant on weekday `dayOfWeek` (0 = Sunday, zone-local) at `hour:minute` that is
 * >= `afterMs`. A weekly schedule's slot inside an NFL week boundary.
 */
export function nextWeekdayWallClockAtOrAfter(
  afterMs: number,
  dayOfWeek: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const p = zoneParts(afterMs, timeZone);
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidate = instantOfLocal(p.year, p.month, p.day + dayOffset, hour, minute, timeZone);
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset)).getUTCDay();
    if (weekday === dayOfWeek && candidate >= afterMs) return candidate;
  }
  return afterMs;
}

/** `hour:minute` (zone-local) on the same zone-local calendar day as `instantMs`. */
export function wallClockOnLocalDay(instantMs: number, hour: number, minute: number, timeZone: string): number {
  const p = zoneParts(instantMs, timeZone);
  return instantOfLocal(p.year, p.month, p.day, hour, minute, timeZone);
}

/** Round `afterMs` up to the next full hour (UTC-agnostic; a full hour is a full hour everywhere with :00 offsets). */
export function nextFullHour(afterMs: number): number {
  return Math.ceil(afterMs / HOUR_MS) * HOUR_MS;
}

export function alignPrintTime(earliestMs: number, schedule: ScheduleShape | undefined, timeZone: string | undefined): number {
  const zone = timeZone && timeZone.trim().length > 0 ? timeZone : DEFAULT_TIME_ZONE;
  const hour = schedule && "hour" in schedule ? schedule.hour : undefined;
  const minute = schedule && "minute" in schedule ? schedule.minute : undefined;
  if (typeof hour === "number" && typeof minute === "number") {
    try {
      return nextWallClockAtOrAfter(earliestMs, hour, minute, zone);
    } catch {
      return nextFullHour(earliestMs);
    }
  }
  return nextFullHour(earliestMs);
}
