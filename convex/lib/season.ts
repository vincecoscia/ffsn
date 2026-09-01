import { Doc } from "../_generated/dataModel";

/**
 * Returns the NFL season "year" label for a given date.
 *
 * Convention used throughout this codebase: a season named YYYY runs from
 * roughly August of YYYY (preseason) through July of YYYY+1 (end of
 * offseason). Dates from January-July belong to the season that started the
 * previous calendar year (e.g. January 2026 is still part of the "2025"
 * season).
 */
export function nflSeasonYearFor(date: Date = new Date()): number {
  let year = date.getFullYear();
  if (date.getMonth() < 7) {
    // Before August (Jan-Jul) - still in the previous season's
    // playoffs/offseason (or ramping up to the next preseason).
    year -= 1;
  }
  return year;
}

/**
 * Returns the season year a league is currently synced to.
 *
 * Prefers the season ESPN sync last recorded on the league
 * (`espnData.seasonId`), falling back to the wall-clock NFL season year for
 * leagues that don't have ESPN data yet (e.g. mid-import).
 */
export function leagueCurrentSeason(league: Doc<"leagues"> | null | undefined): number {
  return league?.espnData?.seasonId ?? nflSeasonYearFor();
}
