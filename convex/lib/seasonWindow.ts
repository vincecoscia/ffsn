/**
 * "Is this weekly content type still inside the league's own season?" (owner
 * directive, Sept 2026: "Make sure the weekly content only generates during
 * the season" - the automatic Tue/Wed/Wed/Thu rundown). Before this, weekly
 * rows were gated only on the NFL calendar (`shouldScheduleContent` in
 * `../contentScheduling.ts`), so a 14+3 league kept getting weekly rows
 * created through NFL week 18 and the NFL playoffs, each one deferring on
 * `no_matchups_week_N` up to `MAX_DEFERRALS` times before failing with a
 * commissioner notification for a week the league never played.
 *
 * Intentionally pure - same rule as `./leagueCalendar.ts`: no imports from
 * `./_generated/api` or any other `convex/*.ts` module that itself
 * references `internal`/`api`, so this stays safe to import from an action
 * and from a plain vitest file with no Convex runtime at all.
 */
import { deriveLeagueCalendar, leagueCalendarInputFromSettings } from "./leagueCalendar";

/**
 * Season length assumed when a league has no synced ESPN settings yet: 14
 * regular-season weeks + 3 single-week playoff rounds. This is the shape
 * every real league defaulted to before the per-league calendar existed
 * (`./leagueCalendar.ts`'s header comment has the audit finding), so it is
 * also the safest guess for a league this module knows nothing else about.
 */
export const FALLBACK_SEASON_END_WEEK = 17;

/**
 * The last NFL week the league's own season reaches (its `seasonEndWeek`),
 * derived from `leagueSeasons.settings` when the league has synced ESPN
 * settings that parse, else `FALLBACK_SEASON_END_WEEK`.
 */
export function resolveSeasonEndWeek(settings: unknown): number {
  const input = leagueCalendarInputFromSettings(settings);
  if (!input) return FALLBACK_SEASON_END_WEEK;
  return deriveLeagueCalendar(input).seasonEndWeek;
}

/**
 * Whether a weekly content type should still print, given its
 * lookback-resolved target week. `targetWeek` must already have
 * `resolveTargetWeek`'s lookback applied: a recap for the league's final
 * week runs in NFL week `seasonEndWeek + 1` with `targetWeek ===
 * seasonEndWeek`, and that is IN season; a preview with `targetWeek ===
 * seasonEndWeek + 1` is not - the league has no week after its own
 * championship.
 */
export function weeklyTargetWeekInSeason(args: {
  contentType: string;
  targetWeek: number;
  seasonEndWeek: number;
}): { inSeason: boolean; reason: string } {
  const { contentType, targetWeek, seasonEndWeek } = args;

  if (targetWeek < 1) {
    return { inSeason: false, reason: `${contentType} target week ${targetWeek} is before the season starts` };
  }
  if (targetWeek > seasonEndWeek) {
    return {
      inSeason: false,
      reason: `${contentType} target week ${targetWeek} is past the league's season end (week ${seasonEndWeek})`,
    };
  }
  return { inSeason: true, reason: `week ${targetWeek} of ${seasonEndWeek}` };
}
