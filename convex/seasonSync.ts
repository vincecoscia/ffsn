/**
 * The automatic season-correctness jobs (ESPN refresh audit, Sept 2026 - owner: "Ideally I want it
 * to pull full season data after the championship so we have the correct info. We should really be
 * pulling this weekly or something. A season should not be incomplete just because we don't pull in
 * information... I need an audit of what our app is not refreshing and make sure that we pull all
 * that info in.").
 *
 * The 4-hourly `espnSync.syncAllLeaguesCurrentSeason` cron is a *liveness* sync for the current
 * week; it does not backfill a week after it closes (stat corrections, a settled `pending`
 * transaction) and it never touches a season once the calendar rolls over. This module is the other
 * half (audit section 5, recommendations (i) and (ii)):
 *
 *  - `weekClosedRefresh`: once a week is over (`contentScheduling.isWeekFinal`), re-pull just that
 *    week's rosters and transaction log and record it in `leagueSeasons.periodsFinal` so it is never
 *    re-pulled by this job again. Idempotent, cheap (a handful of requests per closed week).
 *  - `seasonClosedPull`: once the bracket is decided (`lib/seasonSyncPlan.ts#seasonIsDecided`, the
 *    same bracket-derived rule `lib/playoffs.ts#deriveSeasonResults` uses), do the one full pull a
 *    season needs to be considered DONE - every period's rosters and transactions, draft picks,
 *    trades, the bracket-derived champion (`seasonResults.repairSeasonResults`, never
 *    `leagueSeasons.champion` written by anything else - see that file's header for why), and season
 *    player stats - then stamp `finalizedAt` so it is never re-run except a single 7-day recheck for
 *    stat corrections.
 *
 * Operator entry points (both are internal actions, so they only run from `npx convex run`, a cron,
 * or another Convex function - never from the browser):
 *
 *   # Close out a season by hand right after deploy (this is how e.g. a 2025 season that finished
 *   # before this module existed gets its champion/final data pulled - the crons below only look at
 *   # `current`/`current-1`, so an older, never-finalized season needs this run once explicitly):
 *   npx convex run --prod seasonSync:seasonClosedPull '{"leagueId":"<id>","seasonId":2025}'
 *
 *   # Re-pull just the weeks of one league/season that finished since the last check:
 *   npx convex run --prod seasonSync:weekClosedRefresh '{"leagueId":"<id>","seasonId":2026}'
 *
 * Both are upsert-based through the sync functions they call (`matchupRosters.fetchMatchupRosters`,
 * `espnSync.syncTransactionLog`, `espnSync.syncSeasonSnapshot`, ...), so re-running either for a
 * season/week that's already closed is safe - it just re-confirms the same data.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { resolveSeasonEndWeek } from "./lib/seasonWindow";
import { parseEspnLeagueSettings } from "./lib/espnSettings";
import {
  rangeInclusive,
  recheckDue,
  seasonClosePlan,
  seasonIsDecided,
  weeksReadyToClose,
} from "./lib/seasonSyncPlan";
// Agent H's helper (`seasonsToSync({ league, seasons, now }) -> { current, alsoSync }`, common
// brief's contract) - not yet landed at the time this file was written; kept per this task's
// instruction to code against the agreed contract rather than stub another agent's module. See this
// task's final report for the exact missing-reference error if it's still absent.
import { seasonsToSync } from "./lib/seasonToSync";
import type { PlayoffFormatInput, PlayoffMatchupInput, PlayoffTeamInput } from "./lib/playoffs";

/** `isWeekFinal` is asked at most this many times per `weekClosedRefresh` call (brief: "bounded"). */
const MAX_WEEKS_CHECKED = 20;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- *
 * Shared reads/writes - internal so the actions above can reach the database
 * (actions have no `ctx.db`), and typed as plain return values (not the raw
 * `Doc`) so every caller here works off the same small, stable shape.
 * -------------------------------------------------------------------------- */

type SeasonSyncRow = {
  seasonId: number;
  settings: unknown;
  periodsFinal?: number[];
  finalizedAt?: number;
  finalizationRecheckAt?: number;
  lastFullSyncAt?: number;
};

const seasonSyncRowValidator = v.object({
  seasonId: v.number(),
  settings: v.any(),
  periodsFinal: v.optional(v.array(v.number())),
  finalizedAt: v.optional(v.number()),
  finalizationRecheckAt: v.optional(v.number()),
  lastFullSyncAt: v.optional(v.number()),
});

/** The one `leagueSeasons` row this module cares about, or `null` if the league has never synced it. */
export const getSeasonSyncRow = internalQuery({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  returns: v.union(v.null(), seasonSyncRowValidator),
  handler: async (ctx, args): Promise<SeasonSyncRow | null> => {
    const row = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();
    if (!row) return null;
    return {
      seasonId: row.seasonId,
      settings: row.settings,
      periodsFinal: row.periodsFinal,
      finalizedAt: row.finalizedAt,
      finalizationRecheckAt: row.finalizationRecheckAt,
      lastFullSyncAt: row.lastFullSyncAt,
    };
  },
});

type SeasonListEntry = { seasonId: number; finalizedAt?: number };

/** Every season row a league has, trimmed to what `seasonsToSync` needs. Bounded: a real league spans a handful of seasons, never remotely close to 50. */
export const listSeasonsForLeague = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.array(v.object({ seasonId: v.number(), finalizedAt: v.optional(v.number()) })),
  handler: async (ctx, args): Promise<SeasonListEntry[]> => {
    const rows = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .take(50);
    return rows.map((row) => ({ seasonId: row.seasonId, finalizedAt: row.finalizedAt }));
  },
});

type BracketInputs = {
  teams: PlayoffTeamInput[];
  matchups: PlayoffMatchupInput[];
  format: PlayoffFormatInput;
};

const bracketTeamValidator = v.object({
  externalId: v.string(),
  name: v.string(),
  record: v.object({
    wins: v.number(),
    losses: v.number(),
    ties: v.number(),
    pointsFor: v.optional(v.number()),
    playoffSeed: v.optional(v.number()),
  }),
});
const bracketMatchupValidator = v.object({
  matchupPeriod: v.number(),
  homeTeamId: v.string(),
  awayTeamId: v.string(),
  homeScore: v.number(),
  awayScore: v.number(),
  winner: v.optional(v.union(v.literal("home"), v.literal("away"), v.literal("tie"))),
  playoffTier: v.optional(v.string()),
});

/**
 * Teams + matchups + format, shaped exactly for `lib/seasonSyncPlan.ts#seasonIsDecided` (which
 * forwards straight into `lib/playoffs.ts#buildPlayoffContext`) - the same read `seasonResults.ts`'s
 * `computeRepairForSeason` does, kept separate here since actions can't reach `ctx.db` directly.
 */
export const getBracketInputs = internalQuery({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  returns: v.object({
    teams: v.array(bracketTeamValidator),
    matchups: v.array(bracketMatchupValidator),
    format: v.object({
      playoffTeamCount: v.optional(v.number()),
      regularSeasonMatchupPeriods: v.optional(v.number()),
      playoffMatchupPeriodLength: v.optional(v.number()),
      playoffSeedingRule: v.optional(v.string()),
    }),
  }),
  handler: async (ctx, args): Promise<BracketInputs> => {
    const [teams, matchups, season] = await Promise.all([
      ctx.db
        .query("teams")
        .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
        .take(500),
      ctx.db
        .query("matchups")
        .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
        .take(1000),
      ctx.db
        .query("leagueSeasons")
        .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
        .first(),
    ]);
    const parsed = parseEspnLeagueSettings(season?.settings);
    return {
      teams: teams.map((t) => ({
        externalId: t.externalId,
        name: t.name,
        record: {
          wins: t.record.wins,
          losses: t.record.losses,
          ties: t.record.ties,
          pointsFor: t.record.pointsFor,
          playoffSeed: t.record.playoffSeed,
        },
      })),
      matchups: matchups.map((m) => ({
        matchupPeriod: m.matchupPeriod,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        winner: m.winner,
        playoffTier: m.playoffTier,
      })),
      format: {
        playoffTeamCount: parsed.playoffTeamCount,
        regularSeasonMatchupPeriods: parsed.regularSeasonMatchupPeriods,
        playoffMatchupPeriodLength: parsed.playoffMatchupPeriodLength,
        playoffSeedingRule: parsed.playoffSeedingRule,
      },
    };
  },
});

/** Appends `weeks` onto `leagueSeasons.periodsFinal` (sorted, deduped). A no-op if the season row doesn't exist yet - `weekClosedRefresh` never creates one; the sync functions it calls do that. */
export const markPeriodsFinal = internalMutation({
  args: { leagueId: v.id("leagues"), seasonId: v.number(), weeks: v.array(v.number()) },
  returns: v.object({ periodsFinal: v.array(v.number()) }),
  handler: async (ctx, args): Promise<{ periodsFinal: number[] }> => {
    const row = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();
    if (!row) return { periodsFinal: [] };
    const merged = [...new Set([...(row.periodsFinal ?? []), ...args.weeks])].sort((a, b) => a - b);
    if (args.weeks.length > 0) await ctx.db.patch(row._id, { periodsFinal: merged });
    return { periodsFinal: merged };
  },
});

/**
 * Applies what `seasonClosedPull` found: decided -> stamp `finalizedAt`/`finalizedSource`/
 * `periodsFinal` (the whole season, since the pull just re-fetched every period) and schedule the
 * one 7-day recheck - UNLESS this pull itself WAS that recheck (`isRecheck`), in which case the
 * recheck is consumed rather than rescheduled (`lib/seasonSyncPlan.ts#recheckDue`'s "never more"
 * contract - always resetting `finalizationRecheckAt` here would recheck forever, every 7 days).
 * Not decided -> only `lastFullSyncAt` moves; the season is still in progress.
 */
export const applySeasonClosePullResult = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    decided: v.boolean(),
    isRecheck: v.boolean(),
    seasonEndWeek: v.number(),
    now: v.number(),
  },
  returns: v.object({ justFinalized: v.boolean() }),
  handler: async (ctx, args): Promise<{ justFinalized: boolean }> => {
    const row = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();
    if (!row) return { justFinalized: false };

    if (!args.decided) {
      await ctx.db.patch(row._id, { lastFullSyncAt: args.now });
      return { justFinalized: false };
    }

    const wasFinalized = row.finalizedAt !== undefined;
    await ctx.db.patch(row._id, {
      finalizedAt: row.finalizedAt ?? args.now,
      finalizedSource: "bracket",
      finalizationRecheckAt: args.isRecheck ? undefined : args.now + SEVEN_DAYS_MS,
      periodsFinal: rangeInclusive(1, args.seasonEndWeek),
      lastFullSyncAt: args.now,
    });
    return { justFinalized: !wasFinalized };
  },
});

/* -------------------------------------------------------------------------- *
 * weekClosedRefresh
 * -------------------------------------------------------------------------- */

export const weekClosedRefresh = internalAction({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  returns: v.object({ closed: v.array(v.number()), skipped: v.array(v.string()) }),
  handler: async (ctx, args): Promise<{ closed: number[]; skipped: string[] }> => {
    const seasonRow: SeasonSyncRow | null = await ctx.runQuery(internal.seasonSync.getSeasonSyncRow, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
    });
    const seasonEndWeek = resolveSeasonEndWeek(seasonRow?.settings);
    const periodsFinal = seasonRow?.periodsFinal ?? [];

    const weeksToCheck: number[] = [];
    for (let week = 1; week <= seasonEndWeek && weeksToCheck.length < MAX_WEEKS_CHECKED; week++) {
      if (!periodsFinal.includes(week)) weeksToCheck.push(week);
    }

    const finalWeeks: number[] = [];
    const skipped: string[] = [];
    for (const week of weeksToCheck) {
      const result = await ctx.runQuery(internal.contentScheduling.isWeekFinal, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        week,
      });
      if (result.final) finalWeeks.push(week);
      else skipped.push(`week ${week}: ${result.reason}`);
    }

    const ready = weeksReadyToClose({ seasonEndWeek, finalWeeks, periodsFinal });
    const closed: number[] = [];
    for (const week of ready) {
      await ctx.runAction(internal.matchupRosters.fetchMatchupRosters, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        matchupPeriods: [week],
      });
      await ctx.runAction(internal.espnSync.syncTransactionLog, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        scoringPeriods: [week, week - 1],
      });
      closed.push(week);
    }

    if (closed.length > 0) {
      const marked: { periodsFinal: number[] } = await ctx.runMutation(internal.seasonSync.markPeriodsFinal, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        weeks: closed,
      });
      console.log(
        `[seasonSync] weekClosedRefresh league ${args.leagueId} season ${args.seasonId}: closed weeks ${closed.join(",")} -> periodsFinal now ${marked.periodsFinal.join(",")}`,
      );
    }

    return { closed, skipped };
  },
});

/* -------------------------------------------------------------------------- *
 * seasonClosedPull
 * -------------------------------------------------------------------------- */

type StepResult = { step: string; ok: boolean; detail: string };
type SeasonClosedPullResult = { skipped: string } | { finalized: boolean; steps: StepResult[] };

/** A one-line-friendly summary of an internal action's result, whatever shape it turns out to have. */
function describeResult(result: unknown): string {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    try {
      return JSON.stringify(result);
    } catch {
      return "done";
    }
  }
  return "done";
}

export const seasonClosedPull = internalAction({
  args: { leagueId: v.id("leagues"), seasonId: v.number(), force: v.optional(v.boolean()) },
  returns: v.union(
    v.object({ skipped: v.string() }),
    v.object({
      finalized: v.boolean(),
      steps: v.array(v.object({ step: v.string(), ok: v.boolean(), detail: v.string() })),
    }),
  ),
  handler: async (ctx, args): Promise<SeasonClosedPullResult> => {
    const now = Date.now();
    const seasonRow: SeasonSyncRow | null = await ctx.runQuery(internal.seasonSync.getSeasonSyncRow, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
    });
    const alreadyFinalized = seasonRow?.finalizedAt !== undefined;

    if (alreadyFinalized && !args.force) {
      const due = recheckDue({
        finalizedAt: seasonRow?.finalizedAt,
        finalizationRecheckAt: seasonRow?.finalizationRecheckAt,
        now,
      });
      if (!due) return { skipped: "already finalized" };
    }

    const seasonEndWeek = resolveSeasonEndWeek(seasonRow?.settings);
    const parsed = parseEspnLeagueSettings(seasonRow?.settings);
    const plan = seasonClosePlan({
      seasonId: args.seasonId,
      regularSeasonMatchupPeriods: parsed.regularSeasonMatchupPeriods ?? seasonEndWeek,
      seasonEndWeek,
    });

    const steps: StepResult[] = [];
    const record = async (step: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        const detail = describeResult(await run());
        steps.push({ step, ok: true, detail });
        console.log(`[seasonSync] seasonClosedPull league ${args.leagueId} season ${args.seasonId} - ${step}: ok - ${detail}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        steps.push({ step, ok: false, detail });
        console.error(`[seasonSync] seasonClosedPull league ${args.leagueId} season ${args.seasonId} - ${step}: FAILED - ${detail}`);
      }
    };

    // (1) The season's full ESPN pull - settings/draftInfo/teams/matchups/players for THIS season
    // (agent H's `syncSeasonSnapshot`; never writes champion/runnerUp - step 6 below does that from
    // the bracket, and must never delete matchups for already-finalized periods).
    await record("syncSeasonSnapshot", () =>
      ctx.runAction(internal.espnSync.syncSeasonSnapshot, { leagueId: args.leagueId, seasonId: args.seasonId }),
    );

    // (2) Every period's lineups.
    await record("fetchMatchupRosters", () =>
      ctx.runAction(internal.matchupRosters.fetchMatchupRosters, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        matchupPeriods: plan.periods,
      }),
    );

    // (3) The whole season's transaction log - closes out any `pending` outcome ESPN never
    // resolved in a routine sync.
    await record("syncTransactionLog", () =>
      ctx.runAction(internal.espnSync.syncTransactionLog, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        scoringPeriods: plan.transactionPeriods,
      }),
    );

    // (4) Draft picks (audit 4.6: the `drafted === 1` gate never fires automatically, so this is
    // the only place besides the manual "Draft data" button that ever writes them).
    await record("fetchDraftDataForSeason", () =>
      ctx.runAction(internal.espnSync.fetchDraftDataForSeasonInternal, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
      }),
    );

    // (5) Trades, derived from the transaction log this pull just refreshed.
    await record("deriveTradesForSeason", () =>
      ctx.runMutation(internal.tradesSync.deriveTradesForSeason, { leagueId: args.leagueId, seasonId: args.seasonId }),
    );

    // (6) Champion/runnerUp/regularSeasonChampion from the bracket - never from ESPN's own
    // rank/seed fields, which a rolled-over sync can corrupt (see `seasonResults.ts`'s header). A
    // no-op when the bracket isn't decided yet.
    await record("repairSeasonResults", () =>
      ctx.runMutation(internal.seasonResults.repairSeasonResults, { leagueId: args.leagueId, seasonId: args.seasonId }),
    );

    // (7) Season player stats (season totals), scoped to this league/season.
    await record("playerStats", () =>
      ctx.runAction(internal.playerSync.syncAllLeaguePlayerStats, { leagueId: args.leagueId, season: args.seasonId }),
    );

    // (8) Re-read matchups+teams (fresh after steps 1-3) and check the bracket for real.
    const bracket: BracketInputs = await ctx.runQuery(internal.seasonSync.getBracketInputs, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
    });
    const decision = seasonIsDecided({
      teams: bracket.teams,
      matchups: bracket.matchups,
      format: bracket.format,
      seasonEndWeek,
    });

    const applied: { justFinalized: boolean } = await ctx.runMutation(internal.seasonSync.applySeasonClosePullResult, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
      decided: decision.decided,
      isRecheck: alreadyFinalized,
      seasonEndWeek,
      now,
    });

    // (9) Fire the season-ended event exactly once, the moment finalization first happens (never on
    // the 7-day recheck - that would fire it twice for the same season). `season_ended` is not a
    // DEFAULT_SCHEDULES trigger today (`convex/contentScheduling.ts`'s trigger list has
    // "champion_determined" and "championship_week" but nothing literally named "season_ended") -
    // fired anyway per this task's brief, since `triggerEventBasedContent` treats an unmatched
    // trigger as zero schedules found rather than an error, so a future content type can opt into
    // this event without another sync change. Confirmed missing today - see this task's final report.
    if (applied.justFinalized) {
      await record("triggerEventBasedContent", () =>
        ctx.runAction(internal.contentScheduling.triggerEventBasedContent, {
          leagueId: args.leagueId,
          eventType: "season_ended",
          eventData: { seasonId: args.seasonId, champion: decision.champion },
        }),
      );
    }

    return { finalized: decision.decided, steps };
  },
});

/* -------------------------------------------------------------------------- *
 * Cron drivers
 * -------------------------------------------------------------------------- */

/**
 * Every 6 hours: for every league with an ESPN connection, `weekClosedRefresh` its current and (if
 * not yet finalized) previous season. Cheap on a run where nothing just closed - `weekClosedRefresh`
 * itself self-gates on `isWeekFinal`, so most calls do zero ESPN requests beyond the finality check.
 * Reuses `leagues.listLeagues` the same way `espnSync.syncAllLeaguesCurrentSeason` does rather than
 * re-deriving "has a connection" - the per-league sub-actions already handle a missing/invalid
 * credential (they return a failure result instead of throwing on a league with no `espnData`).
 */
export const weekClosedCron = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const leagues = await ctx.runQuery(internal.leagues.listLeagues, {});
    const now = Date.now();

    for (const league of leagues) {
      if (!league.espnData) continue; // never connected to ESPN - nothing for the sub-actions to sync

      const seasons: SeasonListEntry[] = await ctx.runQuery(internal.seasonSync.listSeasonsForLeague, {
        leagueId: league._id,
      });
      const { current, alsoSync } = seasonsToSync({ league, seasons, now });

      for (const seasonId of [current, ...alsoSync]) {
        try {
          const result: { closed: number[]; skipped: string[] } = await ctx.runAction(
            internal.seasonSync.weekClosedRefresh,
            { leagueId: league._id, seasonId },
          );
          if (result.closed.length > 0) {
            console.log(
              `[seasonSync] weekClosedCron league ${league._id} season ${seasonId}: closed weeks ${result.closed.join(",")}`,
            );
          }
        } catch (error) {
          console.error(`[seasonSync] weekClosedCron league ${league._id} season ${seasonId} failed`, error);
        }
      }
    }
    return null;
  },
});

/**
 * Daily: for each league's current and (if not yet finalized) previous season, run
 * `seasonClosedPull` when the bracket just became decided, or when its one 7-day recheck is due.
 * Also covers a sync gap: a season whose every week is already in `periodsFinal` (so, by
 * `weekClosedRefresh`'s own bookkeeping, everything that could finish has finished) but whose bracket
 * still isn't decided - a missing WINNERS_BRACKET row rather than a season still in progress. One
 * pull can fix that; `lastFullSyncAt` older than 7 days keeps it from retrying every single day.
 */
export const seasonClosedCron = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const leagues = await ctx.runQuery(internal.leagues.listLeagues, {});
    const now = Date.now();

    for (const league of leagues) {
      if (!league.espnData) continue;

      const seasons: SeasonListEntry[] = await ctx.runQuery(internal.seasonSync.listSeasonsForLeague, {
        leagueId: league._id,
      });
      const { current, alsoSync } = seasonsToSync({ league, seasons, now });

      for (const seasonId of [current, ...alsoSync]) {
        try {
          const seasonRow: SeasonSyncRow | null = await ctx.runQuery(internal.seasonSync.getSeasonSyncRow, {
            leagueId: league._id,
            seasonId,
          });
          const seasonEndWeek = resolveSeasonEndWeek(seasonRow?.settings);

          // Three independent reasons to pull; computed up front (rather than one pull call per
          // branch) so there's exactly one `seasonClosedPull` call site to log from below.
          let shouldPull = false;
          let reason = "";

          if (seasonRow?.finalizedAt !== undefined) {
            shouldPull = recheckDue({
              finalizedAt: seasonRow.finalizedAt,
              finalizationRecheckAt: seasonRow.finalizationRecheckAt,
              now,
            });
            reason = "7-day recheck due";
          } else {
            const bracket: BracketInputs = await ctx.runQuery(internal.seasonSync.getBracketInputs, {
              leagueId: league._id,
              seasonId,
            });
            const decision = seasonIsDecided({
              teams: bracket.teams,
              matchups: bracket.matchups,
              format: bracket.format,
              seasonEndWeek,
            });
            if (decision.decided) {
              shouldPull = true;
              reason = "bracket just decided";
            } else {
              // Sync-gap guard (this file's header): every week already closed, but the bracket
              // still isn't decided - a missing WINNERS_BRACKET row, not a season still running.
              const periodsFinal = seasonRow?.periodsFinal ?? [];
              const everyPeriodFinal = rangeInclusive(1, seasonEndWeek).every((week) => periodsFinal.includes(week));
              const staleEnoughToRetry = (seasonRow?.lastFullSyncAt ?? 0) < now - SEVEN_DAYS_MS;
              if (everyPeriodFinal && staleEnoughToRetry) {
                shouldPull = true;
                reason = "every week closed but bracket undecided (possible sync gap)";
              }
            }
          }

          if (shouldPull) {
            const result: SeasonClosedPullResult = await ctx.runAction(internal.seasonSync.seasonClosedPull, {
              leagueId: league._id,
              seasonId,
            });
            console.log(
              `[seasonSync] seasonClosedCron league ${league._id} season ${seasonId} (${reason}) ->`,
              result,
            );
          }
        } catch (error) {
          console.error(`[seasonSync] seasonClosedCron league ${league._id} season ${seasonId} failed`, error);
        }
      }
    }
    return null;
  },
});
