/**
 * The Wire — the game clock (ffsn-the-wire-spec.md §19.1, §9). `tick` is a self-rescheduling
 * action, not a cron: it fetches ESPN's public scoreboard (and, per live game, the summary), hands
 * the parsed payloads to `wireLiveData.ts` for scoring/dedupe/posting, then reschedules itself -
 * 60s while any game is live, else at the next kickoff minus 5 minutes, else it stops. A singleton
 * `wireSourceState` row (source "clock") holds the scheduled function id + wake time so two clocks
 * never run; `ensureWireClock` (a daily cron, and `wireSourcesNode.ts#pollNflSchedule` right after
 * it stores new kickoffs) restarts it if it died.
 *
 * Default Convex runtime (no `"use node"`): every fetch here is plain `fetch()`, same as
 * `wireSourcesNode.ts`. `env WIRE_LIVE === "0"` stops the clock at its next tick, independent of
 * the general `WIRE_ENABLED` switch.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { fetchEspn, normalizeEspnCredentials } from "./lib/espnClient";
import { transformRosterData } from "./espnSync";
import { hasActivePass } from "./credits";
import { leagueCurrentSeason } from "./lib/season";
import { inSeasonNow } from "./wireDesk";
import { localWeekdayAndHour, SUNDAY } from "./lib/wireDeskRules";
import { wireEnabled } from "./lib/wireLeaguePosting";
import { LEAGUE_LIVE_PULL_EVERY_TICKS } from "../src/lib/ai/wire/types";
import {
  anyGameLive,
  decideReschedule,
  parseBoxscore,
  parseScoreboard,
  parseScoringPlays,
  type ParsedGame,
} from "./lib/wireLiveRules";

const USER_AGENT = "FFSN/1.0 (+https://www.ffsn.ai)";
const SCOREBOARD_PRIMARY = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const SCOREBOARD_FALLBACK = "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const SUMMARY_PRIMARY = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary";
const SUMMARY_FALLBACK = "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary";

/** At most this many global events (game_started/final, scoring_play, big_line, bust_watch) posted
 *  per tick (spec §11); the rest are dropped and logged. */
const MAX_GLOBAL_EVENTS_PER_TICK = 40;
/** A clock cursor whose `nextRunAt` is this stale counts as dead (ensureWireClock). */
const CLOCK_DEAD_AFTER_MS = 10 * 60 * 1000;

async function fetchJson(primary: string, fallback: string): Promise<unknown> {
  let response = await fetch(primary, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (response.status === 403) {
    response = await fetch(fallback, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  }
  if (!response.ok) throw new Error(`ESPN HTTP ${response.status} (${primary})`);
  return response.json();
}

interface ClockCursor {
  scheduledId?: string;
  nextRunAt: number;
  /** Every-5th-tick counter for the per-league live pull (spec §19.1 step 3). Not part of the
   *  spec's literal `{ scheduledId, nextRunAt }` shape, but the cursor is `v.any()` and this is the
   *  simplest place to keep it - one row, read once at the top of every tick. */
  tickCount?: number;
}

/** Whether every Sunday game on this week's slate is final (spec §19.1: monday_needs fires on the
 *  first tick after that becomes true). "Sunday" is judged league-local... no - NFL-wide, so
 *  America/New_York, the same zone every other Dex Desk wall-clock check uses. */
function sundayGamesAllFinal(games: ReadonlyArray<ParsedGame>): boolean {
  const sundayGames = games.filter(
    (g) => g.kickoffAt !== undefined && localWeekdayAndHour(g.kickoffAt, "America/New_York").weekday === SUNDAY
  );
  return sundayGames.length > 0 && sundayGames.every((g) => g.state === "post");
}

export const tick = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!wireEnabled() || process.env.WIRE_LIVE === "0") {
      // Clear the clock so `ensureWireClock` sees it as dead and does nothing until re-armed.
      await ctx.runMutation(internal.wireDetect.recordSourceRun, {
        source: "clock",
        cursor: { nextRunAt: 0 } satisfies ClockCursor,
        ok: true,
        summary: "stopped (WIRE_ENABLED/WIRE_LIVE off)",
      });
      return null;
    }

    const now = Date.now();

    const priorClock: { cursor?: unknown } | null = await ctx.runQuery(internal.wireDetect.getSourceCursor, { source: "clock" });
    const priorTickCount = (priorClock?.cursor as ClockCursor | undefined)?.tickCount ?? 0;
    const thisTickCount = priorTickCount + 1;

    let games: ParsedGame[] = [];
    try {
      const payload = await fetchJson(`${SCOREBOARD_PRIMARY}?seasontype=2`, `${SCOREBOARD_FALLBACK}?seasontype=2`);
      games = parseScoreboard(payload);
    } catch (err) {
      console.error("wireLive.tick: scoreboard fetch failed:", err instanceof Error ? err.message : err);
      await ctx.runMutation(internal.wireDetect.recordSourceRun, {
        source: "espn_scoreboard",
        ok: false,
        summary: "fetch failed",
        error: err instanceof Error ? err.message : String(err),
      });
      // No games data this tick - reschedule conservatively (as if live) rather than stopping the
      // clock over a transient ESPN failure.
      await rescheduleAndRecord(ctx, { anyLive: true, nextKickoffAt: undefined, now, tickCount: thisTickCount });
      return null;
    }

    let remaining = MAX_GLOBAL_EVENTS_PER_TICK;
    const scoreboardResult: { used: number; finalizedEventIds: string[] } = await ctx.runMutation(internal.wireLiveData.ingestScoreboard, {
      games,
      fetchedAt: now,
      maxEvents: remaining,
    });
    remaining -= scoreboardResult.used;

    const liveEventIds = new Set(games.filter((g) => g.state === "in").map((g) => g.eventId));
    const finalEventIds = new Set(scoreboardResult.finalizedEventIds);

    for (const game of games) {
      if (remaining <= 0) break;
      const isFinal = finalEventIds.has(game.eventId);
      if (!liveEventIds.has(game.eventId) && !isFinal) continue;

      try {
        const payload = await fetchJson(`${SUMMARY_PRIMARY}?event=${game.eventId}`, `${SUMMARY_FALLBACK}?event=${game.eventId}`);
        const scoringPlays = parseScoringPlays(payload);
        const boxLines = parseBoxscore(payload);
        const summaryResult: { used: number } = await ctx.runMutation(internal.wireLiveData.ingestGameSummary, {
          eventId: game.eventId,
          homeAbbrev: game.homeAbbrev,
          awayAbbrev: game.awayAbbrev,
          homeScore: game.homeScore,
          awayScore: game.awayScore,
          period: game.period,
          clock: game.clock,
          scoringPlays,
          boxLines,
          isFinal,
          fetchedAt: now,
          maxEvents: remaining,
        });
        remaining -= summaryResult.used;
      } catch (err) {
        console.error(`wireLive.tick: summary fetch failed for event ${game.eventId}:`, err instanceof Error ? err.message : err);
      }
    }

    const anyLive = anyGameLive(games);
    const checkMondayNeeds = sundayGamesAllFinal(games);

    if (anyLive && thisTickCount % LEAGUE_LIVE_PULL_EVERY_TICKS === 0) {
      await fanOutLeaguePulls(ctx, now, checkMondayNeeds);
    }

    // The clock's own scoreboard-derived kickoffs cover this week's slate; the "nfl_kickoffs"
    // cursor (wireSourcesNode.ts#pollNflSchedule) already carries every kickoff within 7 days, so
    // the reschedule reuses it rather than re-deriving "next week" from a second ESPN call.
    const kickoffCursor: { cursor?: unknown } | null = await ctx.runQuery(internal.wireDetect.getSourceCursor, { source: "nfl_kickoffs" });
    const scheduled = ((kickoffCursor?.cursor as { scheduled?: number[] } | undefined)?.scheduled ?? []).filter((t) => t > now);
    const nextKickoffAt = scheduled.length > 0 ? Math.min(...scheduled) : undefined;

    await rescheduleAndRecord(ctx, { anyLive, nextKickoffAt, now, tickCount: thisTickCount });
    return null;
  },
});

async function fanOutLeaguePulls(ctx: ActionCtx, now: number, checkMondayNeeds: boolean): Promise<void> {
  if (!(await inSeasonNow(ctx, now))) return;
  const leagues = await ctx.runQuery(internal.leagues.listLeagues, {});
  for (const league of leagues) {
    if (!hasActivePass(league)) continue;
    if (!league.espnData) continue;
    if (league.espnData.isPrivate) {
      const creds = normalizeEspnCredentials(league.espnData);
      if (!creds.hasCredentials || league.espnData.credentialStatus === "invalid") continue;
    }
    await ctx.scheduler.runAfter(0, internal.wireLive.pullLeagueLive, {
      leagueId: league._id,
      checkMondayNeeds,
    });
  }
}

async function rescheduleAndRecord(
  ctx: ActionCtx,
  params: { anyLive: boolean; nextKickoffAt: number | undefined; now: number; tickCount: number }
): Promise<void> {
  const decision = decideReschedule({ anyLive: params.anyLive, nextKickoffAt: params.nextKickoffAt, now: params.now });
  let cursor: ClockCursor;
  let summary: string;
  if (decision.mode === "live") {
    const scheduledId = await ctx.scheduler.runAfter(decision.delayMs!, internal.wireLive.tick, {});
    cursor = { scheduledId, nextRunAt: params.now + decision.delayMs!, tickCount: params.tickCount };
    summary = "live - next tick in 60s";
  } else if (decision.mode === "prekickoff") {
    const scheduledId = await ctx.scheduler.runAt(decision.runAt!, internal.wireLive.tick, {});
    cursor = { scheduledId, nextRunAt: decision.runAt!, tickCount: params.tickCount };
    summary = `no games live - waking at next kickoff minus 5 min (${new Date(decision.runAt!).toISOString()})`;
  } else {
    cursor = { nextRunAt: 0, tickCount: params.tickCount };
    summary = "stopped - no games this week";
  }
  await ctx.runMutation(internal.wireDetect.recordSourceRun, { source: "clock", cursor, ok: true, summary });
}

/**
 * Starts a tick when no clock row exists, or its `nextRunAt` is in the past by more than
 * `CLOCK_DEAD_AFTER_MS` (spec §19.1: the daily cron re-arms a dead clock; `pollNflSchedule` also
 * calls this right after it stores new kickoffs, so a freshly-discovered game week wakes the clock
 * immediately rather than waiting for the next daily check).
 */
export const ensureWireClock = internalMutation({
  args: {},
  returns: v.object({ started: v.boolean() }),
  handler: async (ctx) => {
    if (!wireEnabled() || process.env.WIRE_LIVE === "0") return { started: false };
    const now = Date.now();
    const row = await ctx.db
      .query("wireSourceState")
      .withIndex("by_source", (q) => q.eq("source", "clock"))
      .first();
    const cursor = row?.cursor as ClockCursor | undefined;
    const dead = !row || !cursor?.nextRunAt || now - cursor.nextRunAt > CLOCK_DEAD_AFTER_MS;
    if (!dead) return { started: false };

    const scheduledId = await ctx.scheduler.runAfter(0, internal.wireLive.tick, {});
    const newCursor: ClockCursor = { scheduledId, nextRunAt: now, tickCount: cursor?.tickCount ?? 0 };
    if (row) {
      await ctx.db.patch(row._id, { cursor: newCursor, lastRunAt: now, ok: true, summary: "clock (re)started" });
    } else {
      await ctx.db.insert("wireSourceState", { source: "clock", cursor: newCursor, lastRunAt: now, ok: true, summary: "clock started" });
    }
    return { started: true };
  },
});

/* ------------------------------------------------------------------------------------------- *
 * Per-league live pull (spec §19.1 step 3): one ESPN fantasy call per pass-holding, wire-enabled,
 * in-season league with valid credentials, every 5th tick while any game is live. Writes the same
 * `matchups` rows the 4-hourly sync writes (so the scores page goes live too), then diffs the
 * league's own snapshot for matchup_live / monday_needs.
 * ------------------------------------------------------------------------------------------- */

interface EspnMatchupRosterEntry {
  lineupSlotId?: number;
  playerPoolEntry?: {
    appliedStatTotal?: number;
    player?: { id?: number };
  };
}

export const pullLeagueLive = internalAction({
  args: { leagueId: v.id("leagues"), checkMondayNeeds: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { leagueId, checkMondayNeeds }) => {
    try {
      const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: leagueId });
      if (!league || !league.espnData) return null;

      const prefs = await ctx.runQuery(internal.wireDesk.getPrefsInternal, { leagueId });
      if (prefs?.wireEnabled === false) return null;

      const creds = normalizeEspnCredentials(league.espnData);
      if (league.espnData.isPrivate && (!creds.hasCredentials || league.espnData.credentialStatus === "invalid")) return null;

      const seasonId = leagueCurrentSeason(league);
      const period = league.espnData.currentScoringPeriod || 1;
      const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${league.externalId}`;
      const { response } = await fetchEspn(`${baseUrl}?scoringPeriodId=${period}&view=mMatchupScore&view=mBoxscore`, { creds });
      if (!response.ok) return null;

      const data: { schedule?: unknown[] } = await response.json();
      const schedule = Array.isArray(data.schedule) ? (data.schedule as Array<Record<string, any>>) : [];
      const periodMatchups = schedule.filter((m) => m.matchupPeriodId === period);
      if (periodMatchups.length === 0) return null;

      const matchupsData = periodMatchups.map((m) => ({
        matchupPeriod: m.matchupPeriodId,
        scoringPeriod: m.id,
        homeTeamId: m.home?.teamId?.toString() || "",
        awayTeamId: m.away?.teamId?.toString() || "",
        homeScore: m.home?.totalPoints || 0,
        awayScore: m.away?.totalPoints || 0,
        homeProjectedScore: m.home?.totalProjectedPoints,
        awayProjectedScore: m.away?.totalProjectedPoints,
        homePointsByScoringPeriod: m.home?.pointsByScoringPeriod,
        awayPointsByScoringPeriod: m.away?.pointsByScoringPeriod,
        winner:
          m.winner === "HOME" ? ("home" as const) : m.winner === "AWAY" ? ("away" as const) : m.winner === "TIE" ? ("tie" as const) : undefined,
        playoffTier: m.playoffTierType,
        homeRoster: transformRosterData(m.home?.rosterForCurrentScoringPeriod),
        awayRoster: transformRosterData(m.away?.rosterForCurrentScoringPeriod),
      }));

      await ctx.runMutation(internal.espnSync.updateMatchups, { leagueId, seasonId, matchupsData });

      const toSnapshotPlayers = (roster: { entries?: EspnMatchupRosterEntry[] } | undefined) =>
        (roster?.entries ?? [])
          .map((entry) => {
            const espnId = entry.playerPoolEntry?.player?.id;
            if (espnId === undefined) return null;
            return {
              espnId: String(espnId),
              points: typeof entry.playerPoolEntry?.appliedStatTotal === "number" ? entry.playerPoolEntry.appliedStatTotal : 0,
              lineupSlotId: entry.lineupSlotId ?? 20,
            };
          })
          .filter((p): p is { espnId: string; points: number; lineupSlotId: number } => p !== null);

      const snapshotMatchups = periodMatchups.map((m) => ({
        homeTeamId: m.home?.teamId?.toString() || "",
        awayTeamId: m.away?.teamId?.toString() || "",
        homeScore: m.home?.totalPoints || 0,
        awayScore: m.away?.totalPoints || 0,
        homePlayers: toSnapshotPlayers(m.home?.rosterForCurrentScoringPeriod),
        awayPlayers: toSnapshotPlayers(m.away?.rosterForCurrentScoringPeriod),
      }));

      await ctx.runMutation(internal.wireLiveData.processLeagueLiveSnapshot, {
        leagueId,
        seasonId,
        scoringPeriod: period,
        matchups: snapshotMatchups,
        checkMondayNeeds,
        now: Date.now(),
      });
    } catch (err) {
      console.error(`wireLive.pullLeagueLive failed for league ${leagueId}:`, err instanceof Error ? err.message : err);
    }
    return null;
  },
});
