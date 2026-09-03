/**
 * One notion of "the season to sync" for every ESPN sync entry point (ESPN
 * refresh audit, Sept 2026, section 2 "Rollover"): every automatic sync path
 * used to read `new Date().getFullYear()` directly - a raw calendar-year
 * concept that diverges from the rest of the app's Aug->Jul season boundary
 * (`convex/lib/season.ts`'s `nflSeasonYearFor`) every January, and never
 * re-requests the season that just finished once the calendar rolls over
 * (ESPN's `/seasons/{Y+1}/` 404s until ESPN creates the shell, freezing
 * `lastSyncedAt` and leaving the just-finished season's `pending`
 * transactions, mid-week `winner`s and missing `transactionCounter` as
 * final).
 *
 * Pure - no `ctx`, no ESPN calls - so every boundary is unit-testable in
 * isolation.
 */
import { nflSeasonYearFor } from "./season";

/** The minimal shape of `leagues.espnData` this helper reads. */
export interface SeasonToSyncLeague {
  espnData?: {
    seasonId?: number;
  };
}

/** The minimal shape of a `leagueSeasons` row this helper reads. */
export interface SeasonToSyncSeason {
  seasonId: number;
  finalizedAt?: number;
}

export interface SeasonsToSyncResult {
  /** The season every routine sync should treat as "current". */
  current: number;
  /**
   * Additional season(s) to keep refreshing alongside `current` - today, at
   * most the previous season (`current - 1`) while it hasn't been finalized
   * yet. Empty once `seasonSync.ts`'s season-closed job stamps
   * `leagueSeasons.finalizedAt`, or once the grace window has passed.
   */
  alsoSync: number[];
}

/** The previous-season refresh window closes February 15 of the year after
 * that season's December - well past when ESPN itself has moved on, and
 * short enough that an unfinalized season past this point is a data problem
 * for the season-closed job to chase down, not something routine syncing
 * should keep re-pulling forever. */
const PREVIOUS_SEASON_CUTOFF_MONTH = 1; // February (0-indexed)
const PREVIOUS_SEASON_CUTOFF_DAY = 15;

/**
 * `current` is the Aug->Jul NFL season year for `now` (`nflSeasonYearFor`),
 * unless the league's own last-synced season (`league.espnData.seasonId`) is
 * HIGHER than that - ESPN sometimes opens next season's league shell before
 * our own August cutover, and a prior sync that already landed it must not
 * be treated as behind the wall clock (going backwards would silently stop
 * refreshing the season ESPN and the league are actually on).
 *
 * `alsoSync` keeps the previous season (`current - 1`) in rotation while it
 * is a season this league has actually synced before (present in `seasons`)
 * and it hasn't been finalized (`leagueSeasons.finalizedAt` unset) - the
 * season that just ended is the one most likely to still need a correction
 * (a late stat fix, a slow-to-resolve waiver claim, a bracket nobody has
 * derived a champion from yet).
 */
export function seasonsToSync(args: {
  league: SeasonToSyncLeague | null;
  seasons: SeasonToSyncSeason[];
  now: number;
}): SeasonsToSyncResult {
  const { league, seasons, now } = args;

  let current = nflSeasonYearFor(new Date(now));
  const lastSyncedSeasonId = league?.espnData?.seasonId;
  if (lastSyncedSeasonId !== undefined && lastSyncedSeasonId > current) {
    current = lastSyncedSeasonId;
  }

  const previousSeasonId = current - 1;
  const previousSeason = seasons.find((season) => season.seasonId === previousSeasonId);
  const cutoff = new Date(current + 1, PREVIOUS_SEASON_CUTOFF_MONTH, PREVIOUS_SEASON_CUTOFF_DAY).getTime();

  const alsoSync: number[] =
    previousSeason && previousSeason.finalizedAt === undefined && now < cutoff ? [previousSeasonId] : [];

  return { current, alsoSync };
}
