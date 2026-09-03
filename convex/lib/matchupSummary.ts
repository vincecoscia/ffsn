/**
 * Pure matchup-summary math: turns a raw `matchups` document (full
 * home/away rosters, per-scoring-period point maps) into the slim shape the
 * schedule and scores pages actually render.
 *
 * Fixes two bugs found auditing `src/app/leagues/[id]/schedule/page.tsx`'s
 * client-side math, which fired 18 `getByLeagueAndPeriod` queries and summed
 * roster points itself:
 *
 *   1. "Starters" were computed as `lineupSlotId !== 20` (ESPN's bench
 *      slot), which still counts a slot-21 (IR) player as a starter.
 *      Verified on prod data: a week-2 projected total of 146.2 included an
 *      IR player's 11.8. `isStarterSlot` below excludes both 20 and 21.
 *   2. "Live" was `matchupPeriod === league.espnData.currentScoringPeriod
 *      && !winner`, which is true before kickoff - nothing has been played
 *      yet, `winner` just isn't set. There is no date math here on purpose:
 *      before kickoff every score is genuinely zero, so `status` is
 *      "scheduled"; once ESPN reports any points it is "live"; ESPN sets
 *      `winner` (Tuesday, typically) which makes it "final".
 *   3. Before a REDRAFT league's draft, ESPN carries the PREVIOUS season's
 *      final lineups (and pairings) into the new season's payload wholesale.
 *      Verified 2026-09-02 against ESPN's live 2026 endpoint for a prod
 *      league: `draftDetail.drafted === false`, `scoringPeriodId: 0`, every
 *      `teams[].roster.entries` is EMPTY, but
 *      `schedule[].home/away.rosterForCurrentScoringPeriod` still has each
 *      team's FINAL 2025 lineup (18/18 players identical to 2025 week 17)
 *      with new-season weekly projections attached (`statSourceId 1`,
 *      `seasonId 2026`). The sync stores that as the 2026 matchup roster, so
 *      naive projected totals sum a lineup that won't exist post-draft.
 *      `isPreDraftRedraft` below detects this; `summarizeMatchup`'s
 *      `hideProjections` option and `convex/matchupRosters.ts`'s
 *      `fetchMatchupRosters` both use it. Keeper/dynasty leagues are
 *      intentionally exempt - carrying a roster forward is the point of a
 *      keeper slot - so any `keeperCount`/`keeperCountFuture` > 0 opts out.
 *
 * Intentionally pure - no imports from `./_generated/api` or any other
 * `convex/*.ts` module that itself references `internal`/`api` (the same
 * rule documented in `./leagueCalendar.ts` and `./season.ts`), so this is
 * safe to import from a query (`convex/matchups.ts`'s `getScheduleBySeason`)
 * and from a plain vitest file with no Convex runtime at all.
 */

import type { Doc, Id } from "../_generated/dataModel";

/** ESPN lineupSlotId: 20 = bench, 21 = IR. Neither counts as a starter. */
export const NON_STARTER_LINEUP_SLOTS = new Set([20, 21]);

export function isStarterSlot(lineupSlotId: number): boolean {
  return !NON_STARTER_LINEUP_SLOTS.has(lineupSlotId);
}

/** The `homeRoster`/`awayRoster` shape from the `matchups` table (identical for both sides). */
type Roster = NonNullable<Doc<"matchups">["homeRoster"]>;

/** `Math.round(x * 10) / 10` - avoids float garbage like 146.19999999999998. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function starterTotal(
  roster: Roster | undefined,
  field: "points" | "projectedPoints"
): number | undefined {
  if (!roster) return undefined;
  const total = roster.players
    .filter((player) => isStarterSlot(player.lineupSlotId))
    .reduce((sum, player) => sum + (field === "points" ? player.points : (player.projectedPoints ?? 0)), 0);
  return round1(total);
}

/** Sum of `projectedPoints` for starters only (bench/IR excluded). `undefined` when the roster is absent. */
export function starterProjectedTotal(roster: Roster | undefined): number | undefined {
  return starterTotal(roster, "projectedPoints");
}

/** Sum of `points` for starters only (bench/IR excluded). `undefined` when the roster is absent. */
export function starterActualTotal(roster: Roster | undefined): number | undefined {
  return starterTotal(roster, "points");
}

export type MatchupStatus = "final" | "live" | "scheduled";

/**
 * The subset of a `leagueSeasons` doc's `draftInfo`/`draftSettings` blobs
 * (both `v.any()` on the schema - ESPN's raw `draftDetail`/
 * `settings.draftSettings` objects; see `convex/lib/draftDate.ts` for the
 * fuller picture of what else ESPN puts in each) that `isPreDraftRedraft`
 * needs. Works equally for a stored `leagueSeasons` doc and for a live
 * per-period ESPN response (`convex/matchupRosters.ts` passes
 * `{ draftInfo: data.draftDetail, draftSettings: data.settings?.draftSettings }`
 * straight from the fetch, without waiting for a sync to persist it).
 */
export interface PreDraftRedraftInput {
  draftInfo?: { drafted?: boolean } | null;
  draftSettings?: { keeperCount?: number; keeperCountFuture?: number } | null;
}

/**
 * True only for a REDRAFT league sitting before its draft - see this
 * module's header comment (finding 3) for the ESPN behavior this detects.
 *
 * `drafted` must be the literal boolean `false` - `undefined` (a league
 * that hasn't synced `mDraftDetail`/`mSettings` yet) is NOT treated as "not
 * drafted"; that would hide real, final lineups for every un-synced league.
 * A keeper/dynasty league (`keeperCount` or `keeperCountFuture` > 0) is
 * exempt even before its own draft - carrying a roster forward is the point
 * of a keeper slot, not a carried-over-artifact bug.
 */
export function isPreDraftRedraft(season: PreDraftRedraftInput | null | undefined): boolean {
  if (!season) return false;
  if (season.draftInfo?.drafted !== false) return false;
  const keeperCount = season.draftSettings?.keeperCount ?? 0;
  const keeperCountFuture = season.draftSettings?.keeperCountFuture ?? 0;
  return keeperCount === 0 && keeperCountFuture === 0;
}

/**
 * The official score when ESPN has posted a nonzero `totalPoints` - this is
 * the canonical number and, for a 2-week playoff round, the cumulative total
 * across both scoring periods (the roster only ever covers the *current*
 * scoring period, so it can't reproduce that sum). The roster's starter
 * total is a fallback for the (rare) case ESPN hasn't posted a score yet but
 * points already exist on individual players.
 */
function sideScore(officialScore: number, roster: Roster | undefined): number {
  if (officialScore > 0) return officialScore;
  const rosterTotal = starterActualTotal(roster);
  if (rosterTotal !== undefined && rosterTotal > 0) return rosterTotal;
  return 0;
}

/** Roster-derived projection when the roster exists (even if it sums to 0), else the stored fallback. */
function sideProjected(roster: Roster | undefined, storedProjected: number | undefined): number | null {
  const rosterProjected = starterProjectedTotal(roster);
  if (rosterProjected !== undefined) return rosterProjected;
  return storedProjected ?? null;
}

function anyPointsRecorded(pointsByPeriod: Record<string, number> | undefined): boolean {
  if (!pointsByPeriod) return false;
  return Object.values(pointsByPeriod).some((value) => value > 0);
}

export interface MatchupSummary {
  _id: Id<"matchups">;
  matchupPeriod: number;
  scoringPeriod: number;
  homeTeamId: string;
  awayTeamId: string;
  winner: "home" | "away" | "tie" | null;
  status: MatchupStatus;
  /** ESPN `playoffTierType` ("NONE", "WINNERS_BRACKET", "LOSERS_CONSOLATION_LADDER", ...), or `null`. */
  playoffTier: string | null;
  /** Official points to display. */
  homeScore: number;
  awayScore: number;
  /** Starters' projected points, `null` when unknown. */
  homeProjected: number | null;
  awayProjected: number | null;
}

export interface SummarizeMatchupOptions {
  /**
   * Force both `homeProjected`/`awayProjected` to `null` (spec: finding 3
   * above - a pre-draft redraft league's carried-over roster produces a
   * projection for a lineup that won't exist post-draft). Callers pass
   * `isPreDraftRedraft(season)` here; everything else about the summary
   * (scores, status, pairings) is unaffected - those are real regardless.
   */
  hideProjections?: boolean;
}

/** Turns one `matchups` document into the slim shape callers actually render. See header comment for the rules. */
export function summarizeMatchup(doc: Doc<"matchups">, options: SummarizeMatchupOptions = {}): MatchupSummary {
  const homeScore = sideScore(doc.homeScore, doc.homeRoster);
  const awayScore = sideScore(doc.awayScore, doc.awayRoster);

  let status: MatchupStatus;
  if (doc.winner) {
    status = "final";
  } else if (
    homeScore > 0 ||
    awayScore > 0 ||
    anyPointsRecorded(doc.homePointsByScoringPeriod) ||
    anyPointsRecorded(doc.awayPointsByScoringPeriod)
  ) {
    status = "live";
  } else {
    status = "scheduled";
  }

  return {
    _id: doc._id,
    matchupPeriod: doc.matchupPeriod,
    scoringPeriod: doc.scoringPeriod,
    homeTeamId: doc.homeTeamId,
    awayTeamId: doc.awayTeamId,
    winner: doc.winner ?? null,
    status,
    playoffTier: doc.playoffTier ?? null,
    homeScore,
    awayScore,
    homeProjected: options.hideProjections ? null : sideProjected(doc.homeRoster, doc.homeProjectedScore),
    awayProjected: options.hideProjections ? null : sideProjected(doc.awayRoster, doc.awayProjectedScore),
  };
}
