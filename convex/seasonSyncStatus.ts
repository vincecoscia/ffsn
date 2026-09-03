/**
 * Per-season sync status for the league settings page (ESPN refresh audit, Sept 2026, section 5.v:
 * "one per-season status board: last full pull, periods final n/N, transactions periods n/N,
 * draft picks present, champion (source: bracket), player stats date" - replacing the four
 * "Automatic: ..." cards that claimed refresh behaviour the sync layer never actually ran).
 *
 * Reads only the bookkeeping fields agents H/I write (`leagueSeasons.lastFullSyncAt` /
 * `periodsFinal` / `finalizedAt` / `finalizationRecheckAt`) plus row counts already synced by
 * the existing pipeline - this module never talks to ESPN itself.
 */

import { v, type Infer } from "convex/values";
import { query, action, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireLeagueMember, requireLeagueMemberFromAction } from "./lib/auth";
import { leagueCurrentSeason } from "./lib/season";
import { resolveSeasonEndWeek } from "./lib/seasonWindow";
import { seasonIsDecided } from "./lib/seasonSyncPlan";

const championValidator = v.object({
  teamName: v.string(),
  source: v.union(v.literal("bracket"), v.literal("stored")),
});

const seasonSyncStatusValidator = v.object({
  seasonId: v.number(),
  isCurrent: v.boolean(),
  lastFullSyncAt: v.optional(v.number()),
  lastLivenessSyncAt: v.optional(v.number()),
  periodsFinal: v.array(v.number()),
  seasonEndWeek: v.number(),
  periodsWithLineups: v.number(),
  transactionPeriods: v.array(v.number()),
  draftPicks: v.number(),
  champion: v.optional(championValidator),
  finalizedAt: v.optional(v.number()),
  finalizationRecheckAt: v.optional(v.number()),
  playerStatsUpdatedAt: v.optional(v.number()),
});

async function buildSeasonStatus(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  season: Doc<"leagueSeasons">,
  currentSeason: number,
  league: Doc<"leagues"> | null
): Promise<Infer<typeof seasonSyncStatusValidator>> {
  const [matchups, transactions, topPerformers] = await Promise.all([
    ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", season.seasonId))
      .take(200),
    ctx.db
      .query("transactions")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", season.seasonId))
      .take(500),
    ctx.db
      .query("leagueTopPerformers")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("season", season.seasonId))
      .first(),
  ]);

  const periodsWithLineups = new Set<number>();
  for (const matchup of matchups) {
    if (matchup.awayTeamId === "") continue; // one-sided bye row - no "both sides" lineup to check
    if (matchup.homeRoster && matchup.awayRoster) periodsWithLineups.add(matchup.matchupPeriod);
  }

  const transactionPeriods = new Set<number>(transactions.map((t) => t.scoringPeriod));

  const isCurrent = season.seasonId === currentSeason;

  return {
    seasonId: season.seasonId,
    isCurrent,
    lastFullSyncAt: season.lastFullSyncAt,
    lastLivenessSyncAt: isCurrent ? league?.espnData?.lastSyncedAt : undefined,
    periodsFinal: season.periodsFinal ?? [],
    seasonEndWeek: resolveSeasonEndWeek(season.settings),
    periodsWithLineups: periodsWithLineups.size,
    transactionPeriods: Array.from(transactionPeriods).sort((a, b) => a - b),
    draftPicks: season.draft?.length ?? 0,
    champion: season.champion
      ? { teamName: season.champion.teamName, source: season.finalizedSource === "bracket" ? "bracket" : "stored" }
      : undefined,
    finalizedAt: season.finalizedAt,
    finalizationRecheckAt: season.finalizationRecheckAt,
    playerStatsUpdatedAt: topPerformers?.generatedAt,
  };
}

/**
 * Every synced season of a league, newest first, with the sync bookkeeping the settings page's
 * `SeasonSyncBoard` renders. League members only (same visibility as the rest of the settings
 * page's read side) - the commissioner sees the identical rows, no extra fields.
 */
export const getLeagueSeasonSyncStatus = query({
  args: { leagueId: v.id("leagues") },
  returns: v.array(seasonSyncStatusValidator),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    const currentSeason = leagueCurrentSeason(league);

    // A league has at most ~10 synced seasons in prod (2020-2026 today) - bounded generously
    // above that rather than `.collect()`, per the no-unbounded-reads rule.
    const seasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .take(30);
    seasons.sort((a, b) => b.seasonId - a.seasonId);

    return Promise.all(seasons.map((season) => buildSeasonStatus(ctx, args.leagueId, season, currentSeason, league)));
  },
});

/**
 * Commissioner-only "Re-check now" action for one season row of the `SeasonSyncBoard`.
 * `weekClosedRefresh` always runs (cheap - a handful of ESPN requests for the current week);
 * `seasonClosedPull` (the ~60-request full pull) only runs when the season isn't finalized yet
 * AND its bracket already has a decided champion - the exact same `lib/seasonSyncPlan.ts#seasonIsDecided`
 * check `seasonClosedPull` itself uses (`seasonSync.ts`'s header comment), so this button can
 * never disagree with that job about "is the season done". `seasonClosedPull` is idempotent
 * regardless (it no-ops when already finalized), so this gate exists only to skip the ~60-request
 * pull entirely for a season that plainly isn't over yet.
 *
 * `internal.seasonSync.*` is agent I's module (`convex/seasonSync.ts`, brief-sync-common.md) -
 * built in parallel with this file. If those references are missing at typecheck time, that is
 * I's work still landing, not a bug in this file (see the round's final report).
 */
export const requestSeasonRecheck = action({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  returns: v.object({
    weekClosedRefreshRan: v.boolean(),
    seasonClosedPullRan: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireLeagueMemberFromAction(ctx, args.leagueId, { commissioner: true });

    await ctx.runAction(internal.seasonSync.weekClosedRefresh, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
    });

    const seasonRow = await ctx.runQuery(internal.seasonSync.getSeasonSyncRow, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
    });

    let seasonClosedPullRan = false;
    if (seasonRow && !seasonRow.finalizedAt) {
      const bracket = await ctx.runQuery(internal.seasonSync.getBracketInputs, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
      });
      const decision = seasonIsDecided({
        teams: bracket.teams,
        matchups: bracket.matchups,
        format: bracket.format,
        seasonEndWeek: resolveSeasonEndWeek(seasonRow.settings),
      });
      if (decision.decided) {
        await ctx.runAction(internal.seasonSync.seasonClosedPull, {
          leagueId: args.leagueId,
          seasonId: args.seasonId,
        });
        seasonClosedPullRan = true;
      }
    }

    return { weekClosedRefreshRan: true, seasonClosedPullRan };
  },
});
