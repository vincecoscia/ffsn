/**
 * Pure planning helpers for the automatic season-sync jobs (`convex/seasonSync.ts`).
 *
 * Spec (ESPN refresh audit, Sept 2026 - owner: "A season should not be incomplete just because we
 * don't pull in information... I need an audit of what our app is not refreshing"). Section 5's
 * recommendation (i)/(ii)/(iii) is the design this module supports: a week-closed refresh that
 * re-pulls exactly the weeks that just finished, and a season-closed full pull that runs once the
 * bracket is decided, with a single 7-day recheck for stat corrections and then never again.
 *
 * Intentionally pure - same rule as `./leagueCalendar.ts` and `./seasonWindow.ts`: no imports from
 * `./_generated/api` or any other `convex/*.ts` module that itself references `internal`/`api`, so
 * this stays safe to import from an action and from a plain vitest file with no Convex runtime.
 * `./playoffs` and `./playoffTypes` are themselves pure for the same reason, so importing them here
 * is safe.
 */

import { buildPlayoffContext, type PlayoffFormatInput, type PlayoffMatchupInput, type PlayoffTeamInput } from "./playoffs";
import type { BracketTeam } from "./playoffTypes";

/** `[1, 2, ..., end]` - the shared "whole season" range used by several helpers below. */
export function rangeInclusive(start: number, end: number): number[] {
  const weeks: number[] = [];
  for (let n = start; n <= end; n++) weeks.push(n);
  return weeks;
}

/**
 * Which of the league's own weeks are ready for the week-closed refresh: `isWeekFinal` already said
 * final, still inside the league's season, and not already recorded in `leagueSeasons.periodsFinal`.
 * Ascending, deduped - the caller (`weekClosedRefresh`) processes these in order and appends whatever
 * it closes back onto `periodsFinal`.
 */
export function weeksReadyToClose(args: {
  seasonEndWeek: number;
  /** Weeks `isWeekFinal` reported final for this league/season. */
  finalWeeks: number[];
  periodsFinal: number[];
}): number[] {
  const alreadyClosed = new Set(args.periodsFinal);
  const ready = new Set<number>();
  for (const week of args.finalWeeks) {
    if (week < 1 || week > args.seasonEndWeek) continue; // defensive - isWeekFinal is only ever asked about in-season weeks, but never trust it blindly
    if (alreadyClosed.has(week)) continue;
    ready.add(week);
  }
  return [...ready].sort((a, b) => a - b);
}

/**
 * Is the season's championship decided, straight off the bracket - `buildPlayoffContext(...).mode
 * === "final"`, the same rule `deriveSeasonResults` (`./playoffs.ts`) uses for
 * `leagueSeasons.champion`. `champion`/`runnerUp` are only present when `decided` is true.
 */
export function seasonIsDecided(args: {
  teams: PlayoffTeamInput[];
  matchups: PlayoffMatchupInput[];
  format: PlayoffFormatInput;
  seasonEndWeek: number;
}): { decided: boolean; champion?: BracketTeam; runnerUp?: BracketTeam } {
  const context = buildPlayoffContext({
    teams: args.teams,
    matchups: args.matchups,
    format: args.format,
    throughWeek: args.seasonEndWeek,
  });
  if (context.mode !== "final") return { decided: false };
  return { decided: true, champion: context.champion, runnerUp: context.runnerUp };
}

/**
 * The period lists a season-closed full pull re-requests. Both are `1..seasonEndWeek` - deliberately
 * generous (the same tier-2 fallback `./leagueCalendar.ts#matchupPeriodIdsFromSettings` documents:
 * over-requesting a period id ESPN doesn't have for this league just gets an empty response back, so
 * it's safe, and it sidesteps having to resolve the matchup-period-vs-NFL-week mapping exactly for a
 * job that only runs once a season). `seasonId` and `regularSeasonMatchupPeriods` are accepted to
 * match the natural shape of the caller's season row (and for a future asymmetric split, e.g. if
 * `syncTransactionLog`'s period list ever needs to differ from `fetchMatchupRosters`'s); today they
 * don't change the arithmetic.
 */
export function seasonClosePlan(args: {
  seasonId: number;
  regularSeasonMatchupPeriods: number;
  seasonEndWeek: number;
}): { periods: number[]; transactionPeriods: number[] } {
  const wholeSeason = rangeInclusive(1, args.seasonEndWeek);
  return { periods: wholeSeason, transactionPeriods: wholeSeason };
}

/**
 * One recheck, seven days after finalization, never more. `finalizationRecheckAt` is the trigger;
 * once a recheck pull actually runs, `seasonSync.ts` clears the field so this can never fire again
 * for the same finalization - a `finalizationRecheckAt` that's still set but in the future is simply
 * not due yet.
 */
export function recheckDue(args: {
  finalizedAt: number | undefined;
  finalizationRecheckAt: number | undefined;
  now: number;
}): boolean {
  if (args.finalizedAt === undefined) return false; // never finalized - nothing to recheck
  if (args.finalizationRecheckAt === undefined) return false; // no recheck scheduled, or already consumed
  return args.now >= args.finalizationRecheckAt;
}
