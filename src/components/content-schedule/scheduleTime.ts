// Wall-clock ↔ UTC maths for the league print clock (spec §9.2.1, UI half).
//
// A weekly schedule row stores a *local* day/hour/minute plus the league timezone; the
// cron runs on UTC. These helpers resolve one to the other the same way the backend does
// (solve the zone's offset for a candidate instant, then correct once for DST), so what
// the commissioner reads on screen is what the cron will actually do.

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  partsFormatters.set(timeZone, formatter);
  return formatter;
}

export interface ZoneDateParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday, matching `contentSchedules.schedule.dayOfWeek`. */
  dayOfWeek: number;
}

/** The wall-clock date/time an instant reads as inside `timeZone`. */
export function zoneDateParts(timeZone: string, instantMs: number): ZoneDateParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = value("hour") % 24;
  const minute = value("minute");

  return {
    year,
    month,
    day,
    hour,
    minute,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Minutes `timeZone` is ahead of UTC at `instantMs` (negative west of Greenwich). */
export function zoneOffsetMinutes(timeZone: string, instantMs: number): number {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const asIfUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour") % 24,
    value("minute"),
    value("second"),
  );
  return Math.round((asIfUtc - instantMs) / 60_000);
}

/**
 * The UTC instant a local wall time lands on. Solved rather than table-driven: guess with
 * the offset at the naive instant, then re-solve once at the corrected instant so a
 * schedule that crosses a DST boundary still resolves to the hour the league asked for.
 */
export function wallTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = naive - zoneOffsetMinutes(timeZone, naive) * 60_000;
  return naive - zoneOffsetMinutes(timeZone, firstPass) * 60_000;
}

/**
 * The next UTC instant a weekly row prints, strictly after `from`. Walks forward a day at
 * a time in the league's own calendar, so it never lands on the wrong side of a DST shift.
 * Returns `null` only if the zone is unusable.
 */
export function nextWeeklyOccurrence(
  timeZone: string,
  dayOfWeek: number,
  hour: number,
  minute: number,
  from: number = Date.now(),
): number | null {
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const probe = from + dayOffset * 86_400_000;
    const { year, month, day, dayOfWeek: probeDay } = zoneDateParts(timeZone, probe);
    if (probeDay !== dayOfWeek) continue;
    const instant = wallTimeToUtc(timeZone, year, month, day, hour, minute);
    if (instant > from) return instant;
  }
  return null;
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** 0 → "Sun", 2 → "Tue". */
export function shortDayName(dayOfWeek: number): string {
  return SHORT_DAYS[dayOfWeek] ?? "—";
}

/** 0 → "Sunday", 2 → "Tuesday". */
export function longDayName(dayOfWeek: number): string {
  return LONG_DAYS[dayOfWeek] ?? "Unknown";
}

/** 9, 0 → "9:00am"; 12, 30 → "12:30pm". */
export function formatWallClock(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "pm" : "am";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minute.toString().padStart(2, "0")}${suffix}`;
}

/** "Tue 9:00am" — the league's own clock, as stored on the row. */
export function formatWeeklyWallTime(
  dayOfWeek: number,
  hour: number,
  minute: number,
): string {
  return `${shortDayName(dayOfWeek)} ${formatWallClock(hour, minute)}`;
}

/** "13:00 UTC" for an instant — what the cron sees. */
export function formatUtcClock(instantMs: number): string {
  const date = new Date(instantMs);
  const hour = date.getUTCHours().toString().padStart(2, "0");
  const minute = date.getUTCMinutes().toString().padStart(2, "0");
  return `${hour}:${minute} UTC`;
}

/**
 * The UTC clock a weekly row resolves to on its next run, e.g. "13:00 UTC". Null when the
 * zone can't be resolved, so callers can simply omit the line.
 */
export function weeklyUtcClock(
  timeZone: string,
  dayOfWeek: number,
  hour: number,
  minute: number,
  from: number = Date.now(),
): string | null {
  const instant = nextWeeklyOccurrence(timeZone, dayOfWeek, hour, minute, from);
  return instant === null ? null : formatUtcClock(instant);
}

/** "Tue, Sep 8 at 9:00 AM EDT" — a print time spoken in the league's timezone. */
export function formatPrintTime(instantMs: number, timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    const parts = formatter.formatToParts(new Date(instantMs));
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const day = `${pick("weekday")}, ${pick("month")} ${pick("day")}`;
    const time = `${pick("hour")}:${pick("minute")} ${pick("dayPeriod")}`.trim();
    const zone = pick("timeZoneName");
    return `${day} at ${time}${zone ? ` ${zone}` : ""}`;
  } catch {
    return new Date(instantMs).toUTCString();
  }
}

/** "EDT" / "GMT+2" for a zone right now — the suffix on a summary line. */
export function timeZoneAbbreviation(
  timeZone: string,
  instantMs: number = Date.now(),
): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date(instantMs));
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** "GMT-04:00" for a zone right now — the offset chip in the timezone picker. */
export function timeZoneOffsetLabel(
  timeZone: string,
  instantMs: number = Date.now(),
): string {
  try {
    const offset = zoneOffsetMinutes(timeZone, instantMs);
    const sign = offset < 0 ? "-" : "+";
    const abs = Math.abs(offset);
    const hours = Math.floor(abs / 60)
      .toString()
      .padStart(2, "0");
    const minutes = (abs % 60).toString().padStart(2, "0");
    return `GMT${sign}${hours}:${minutes}`;
  } catch {
    return "";
  }
}
