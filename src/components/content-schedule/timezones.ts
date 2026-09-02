// Timezone options for the league clock (spec §9.1).
//
// A league prints on one clock, captured at import and stored on
// `leagueContentPreferences.timezone`. Everything here is display/selection data for
// that field — no scheduling maths (see `scheduleTime.ts`).

/**
 * Used when the runtime can't enumerate zones (`Intl.supportedValuesOf` is ES2022 and
 * missing on older Safari/Firefox). Covers the zones a US fantasy league realistically
 * prints on, plus the common overseas ones for deployed managers.
 */
const FALLBACK_TIME_ZONES: readonly string[] = [
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Halifax",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "UTC",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Kyiv",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Jerusalem",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Perth",
  "Australia/Brisbane",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** Last-resort zone: what every pre-timezone league already ran on. */
export const DEFAULT_TIME_ZONE = "America/New_York";

let cachedZones: string[] | null = null;

/**
 * Every IANA zone this runtime knows, alphabetically. Falls back to a curated list
 * where `Intl.supportedValuesOf` is unavailable, so the picker is never empty.
 */
export function supportedTimeZones(): string[] {
  if (cachedZones) return cachedZones;

  const supportedValuesOf = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;

  if (typeof supportedValuesOf === "function") {
    try {
      const zones = supportedValuesOf("timeZone");
      if (Array.isArray(zones) && zones.length > 0) {
        cachedZones = [...new Set([...zones, "UTC"])].sort((a, b) => a.localeCompare(b));
        return cachedZones;
      }
    } catch {
      // Fall through to the curated list.
    }
  }

  cachedZones = [...FALLBACK_TIME_ZONES].sort((a, b) => a.localeCompare(b));
  return cachedZones;
}

/** True when this runtime can actually format times in `timeZone`. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The viewer's own zone, which is the right default for the commissioner doing the
 * import. Falls back to Eastern if the browser reports something unusable.
 */
export function resolveBrowserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && isValidTimeZone(zone)) return zone;
  } catch {
    // Fall through.
  }
  return DEFAULT_TIME_ZONE;
}

/** "America/New_York" → "New York". The region stays available as a secondary line. */
export function timeZoneCity(timeZone: string): string {
  const segments = timeZone.split("/");
  const city = segments[segments.length - 1] ?? timeZone;
  return city.replace(/_/g, " ");
}

/** "America/New_York" → "America" (empty for single-segment ids like "UTC"). */
export function timeZoneRegion(timeZone: string): string {
  const segments = timeZone.split("/");
  if (segments.length < 2) return "";
  return segments.slice(0, -1).join(" / ").replace(/_/g, " ");
}
