/**
 * The Wire — live game engine, data layer (ffsn-the-wire-spec.md §19). Mutations/queries that need
 * `ctx.db` and `internal` - `wireLive.ts` (the action layer: fetches, then calls in here) stays
 * fetch-only. Default Convex runtime throughout (no `"use node"`).
 *
 * Every global event (game_started/game_final/scoring_play/big_line/bust_watch) is posted through
 * `wireDetect.ts#createPostForEvent` - the exact same path P1's detectors use, so rate limiting,
 * the take-batch hookup and the card/take split all Just Work for the live kinds too. League events
 * (matchup_live, monday_needs) go through `wireLeaguePosting.ts#insertLeaguePostIfNew` like every
 * other Dex Desk stock line.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { LanguageRating } from "../src/lib/ai/language";
import { nflSeasonYearFor } from "./lib/season";
import { isStartingSlot } from "./lib/lineupSlots";
import { localWeekdayAndHour, MONDAY } from "./lib/wireDeskRules";
import { insertLeaguePostIfNew } from "./lib/wireLeaguePosting";
import { createPostForEvent } from "./wireDetect";
import {
  BUST_WATCH_MAX_POINTS,
  BUST_WATCH_PER_DAY,
  SCORING_PLAY_MIN_PERCENT_OWNED,
  type GlobalEventKind,
  type LeagueEventKind,
  type WireFactCard,
  type WirePersona,
  type WireSlots,
} from "../src/lib/ai/wire/types";
import { validateFactCard } from "../src/lib/ai/wire/card";
import { scoreInterest } from "../src/lib/ai/wire/interest";
import { pickStockLine } from "../src/lib/ai/wire/stock-lines";
import { joinNames } from "../src/lib/ai/wire/moves";
import {
  bigLineMetricsCrossed,
  boxLineTotals,
  capEvents,
  computeFantasyPoints,
  detectGameTransitions,
  detectMatchupTriggers,
  guessScorerName,
  isBustWatchCandidate,
  matchAthleteByName,
  nextGameStateCursor,
  parsePlayYards,
  touchdownCountForPlayer,
  type BoxAthleteLine,
  type GameStateCursor,
} from "./lib/wireLiveRules";

/* ------------------------------------------------------------------------------------------- *
 * Shared validators
 * ------------------------------------------------------------------------------------------- */

const gameStateValidator = v.union(v.literal("pre"), v.literal("in"), v.literal("post"));

const parsedGameValidator = v.object({
  eventId: v.string(),
  state: gameStateValidator,
  homeAbbrev: v.string(),
  awayAbbrev: v.string(),
  homeScore: v.number(),
  awayScore: v.number(),
  period: v.optional(v.number()),
  clock: v.optional(v.string()),
  kickoffAt: v.optional(v.number()),
});

const parsedScoringPlayValidator = v.object({
  id: v.string(),
  typeText: v.string(),
  text: v.string(),
  homeScore: v.number(),
  awayScore: v.number(),
  period: v.optional(v.number()),
  clock: v.optional(v.string()),
  teamAbbrev: v.optional(v.string()),
  participantEspnId: v.optional(v.string()),
});

const boxAthleteLineValidator = v.object({
  espnId: v.string(),
  firstName: v.string(),
  lastName: v.string(),
  displayName: v.string(),
  teamAbbrev: v.string(),
  stats: v.record(v.string(), v.record(v.string(), v.number())),
});

const snapshotPlayerValidator = v.object({
  espnId: v.string(),
  points: v.number(),
  lineupSlotId: v.number(),
});

const snapshotMatchupInputValidator = v.object({
  homeTeamId: v.string(),
  awayTeamId: v.string(),
  homeScore: v.number(),
  awayScore: v.number(),
  homePlayers: v.array(snapshotPlayerValidator),
  awayPlayers: v.array(snapshotPlayerValidator),
});

/* ------------------------------------------------------------------------------------------- *
 * Small shared helpers (duplicated in spirit from wireDetect.ts/wireDesk.ts rather than imported -
 * same convention those files already use for their own per-file dedupe/rating helpers).
 * ------------------------------------------------------------------------------------------- */

function clampInterest(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

async function dedupeExists(ctx: MutationCtx, dedupeKey: string): Promise<boolean> {
  const row = await ctx.db
    .query("wireEvents")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
    .first();
  return row !== null;
}

/** playersEnhanced enrichment (current season, falling back to last season), the fields a live
 *  card needs beyond what ESPN's own payload carries: position, and ESPN's own percentOwned. */
async function enrichPlayer(
  ctx: MutationCtx,
  espnId: string,
  season: number
): Promise<{ position?: string; percentOwned?: number }> {
  let row = await ctx.db
    .query("playersEnhanced")
    .withIndex("by_espn_id_season", (q) => q.eq("espnId", espnId).eq("season", season))
    .first();
  if (!row) {
    row = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_espn_id_season", (q) => q.eq("espnId", espnId).eq("season", season - 1))
      .first();
  }
  return { position: row?.defaultPosition, percentOwned: row?.ownership.percentOwned };
}

/** FFC positional ADP rank (bust_watch, spec §19.1) - the first "market" row that has one, rather
 *  than replaying wireOverlay.ts's private market-preference order (a reasonable simplification:
 *  bust_watch only needs "is he a top-24 ADP player", not the single best-ranked board). */
async function adpPositionRankFor(ctx: MutationCtx, espnId: string, season: number): Promise<number | undefined> {
  const rows = await ctx.db
    .query("playerIntel")
    .withIndex("by_player_season", (q) => q.eq("espnId", espnId).eq("season", season))
    .filter((q) => q.eq(q.field("kind"), "market"))
    .take(12);
  return rows.find((row) => row.adpPositionRank !== undefined)?.adpPositionRank;
}

function scoreValueForPlayType(typeText: string): number | undefined {
  const t = typeText.toLowerCase();
  if (t.includes("touchdown")) return 6;
  if (t.includes("field goal")) return 3;
  if (t.includes("two-point")) return 2;
  if (t.includes("safety")) return 2;
  if (t.includes("extra point")) return 1;
  return undefined;
}

/** Insert + score a live global card through the exact same path P1's detectors use. Returns
 *  whether a wireEvents row was inserted (the tick's own "used" budget counts this, not whether it
 *  cleared the posting floor - a below-floor event still cost the fetch/parse work that got it here). */
async function postGlobalLiveEvent(
  ctx: MutationCtx,
  now: number,
  kind: GlobalEventKind,
  dedupeKey: string,
  rawCard: WireFactCard
): Promise<boolean> {
  if (await dedupeExists(ctx, dedupeKey)) return false;
  let card: WireFactCard;
  try {
    card = validateFactCard(rawCard);
  } catch (err) {
    console.warn(`wireLiveData: invalid ${kind} card (dedupeKey ${dedupeKey})`, err);
    return false;
  }
  const interest = clampInterest(scoreInterest(card, { now }));
  const eventId = await ctx.db.insert("wireEvents", {
    kind,
    dedupeKey,
    observedAt: card.observedAt,
    detectedAt: now,
    players: card.players,
    primaryEspnId: card.players[0]?.espnId,
    nflTeam: card.nflTeam,
    facts: card,
    interest,
    source: card.source,
  });
  await createPostForEvent(ctx, now, eventId, kind, card, interest);
  return true;
}

async function effectiveRatingForLeague(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  featuredTeamIds: Id<"teams">[]
): Promise<LanguageRating> {
  const language = await ctx.runQuery(internal.languageSettings.getLeagueLanguage, { leagueId });
  for (const teamId of featuredTeamIds) {
    const team = await ctx.db.get(teamId);
    if (team && language.cleanTeamNames.includes(team.name)) return "clean";
  }
  return language.languageRating;
}

async function postLeagueStockLine(
  ctx: MutationCtx,
  args: {
    leagueId: Id<"leagues">;
    seasonId: number;
    week: number | undefined;
    kind: LeagueEventKind;
    persona: WirePersona;
    slots: WireSlots;
    featuredTeams: Id<"teams">[];
    dedupeKey: string;
    now: number;
  }
): Promise<boolean> {
  const rating = await effectiveRatingForLeague(ctx, args.leagueId, args.featuredTeams);
  const picked = pickStockLine(args.persona, args.kind, args.slots, args.dedupeKey, rating);
  if (!picked) return false;
  const result = await insertLeaguePostIfNew(ctx, args.now, {
    leagueId: args.leagueId,
    seasonId: args.seasonId,
    week: args.week,
    kind: args.kind,
    persona: args.persona,
    text: picked.text,
    tags: picked.tags,
    featuredTeams: args.featuredTeams,
    dedupeKey: args.dedupeKey,
  });
  return result.inserted;
}

async function resolveTeamPair(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  homeTeamId: string,
  awayTeamId: string
): Promise<{ home: Doc<"teams">; away: Doc<"teams"> } | null> {
  const home = await ctx.db
    .query("teams")
    .withIndex("by_external", (q) => q.eq("leagueId", leagueId).eq("externalId", homeTeamId).eq("seasonId", seasonId))
    .first();
  const away = await ctx.db
    .query("teams")
    .withIndex("by_external", (q) => q.eq("leagueId", leagueId).eq("externalId", awayTeamId).eq("seasonId", seasonId))
    .first();
  if (!home || !away) return null;
  return { home, away };
}

async function namesFor(ctx: MutationCtx, season: number, espnIds: ReadonlyArray<string>): Promise<string[]> {
  const names: string[] = [];
  for (const espnId of espnIds) {
    const row = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_espn_id_season", (q) => q.eq("espnId", espnId).eq("season", season))
      .first();
    names.push(row?.fullName ?? espnId);
  }
  return names;
}

/* ------------------------------------------------------------------------------------------- *
 * Scoreboard -> game_started / game_final (wireLive.ts#tick, step 1)
 * ------------------------------------------------------------------------------------------- */

export const ingestScoreboard = internalMutation({
  args: { games: v.array(parsedGameValidator), fetchedAt: v.number(), maxEvents: v.number() },
  returns: v.object({
    used: v.number(),
    finalizedEventIds: v.array(v.string()),
  }),
  handler: async (ctx, { games, fetchedAt, maxEvents }) => {
    const now = fetchedAt;
    const row = await ctx.db
      .query("wireSourceState")
      .withIndex("by_source", (q) => q.eq("source", "espn_scoreboard"))
      .first();
    const coldStart = !row;
    const prevCursor = (row?.cursor as GameStateCursor | undefined) ?? {};

    const allTransitions = detectGameTransitions(games, prevCursor, coldStart);
    const { kept, dropped } = capEvents(allTransitions, maxEvents);

    let used = 0;
    for (const t of kept) {
      const game = games.find((g) => g.eventId === t.eventId);
      if (!game) continue;
      used++; // counts against the tick's 40-event budget regardless of dedupe/floor outcome below
      const dedupeKey = `${t.kind}:${game.eventId}`;
      const card: WireFactCard = {
        kind: t.kind,
        observedAt: fetchedAt,
        // A game-level event has no individual "player" subject - a synthetic placeholder
        // satisfies the fact-card model (every card names >= 1 player) without implying one.
        players: [{ espnId: `game:${game.eventId}`, name: `${game.awayAbbrev} at ${game.homeAbbrev}` }],
        game: {
          eventId: game.eventId,
          home: game.homeAbbrev,
          away: game.awayAbbrev,
          homeScore: game.homeScore,
          awayScore: game.awayScore,
          period: game.period,
          clock: game.clock,
          kickoffAt: game.kickoffAt,
        },
        source: { type: "espn_scoreboard", id: game.eventId, fetchedAt },
      };
      await postGlobalLiveEvent(ctx, now, t.kind, dedupeKey, card);
    }

    const nextCursor = nextGameStateCursor(games);
    const summary = `${games.length} game(s), ${allTransitions.length} transition(s)${dropped > 0 ? `, ${dropped} dropped (cap)` : ""}`;
    if (row) {
      await ctx.db.patch(row._id, { cursor: nextCursor, lastRunAt: now, ok: true, summary });
    } else {
      await ctx.db.insert("wireSourceState", { source: "espn_scoreboard", cursor: nextCursor, lastRunAt: now, ok: true, summary });
    }

    return { used, finalizedEventIds: kept.filter((t) => t.kind === "game_final").map((t) => t.eventId) };
  },
});

/* ------------------------------------------------------------------------------------------- *
 * Summary (scoringPlays + boxscore) -> scoring_play / big_line / bust_watch (tick, step 2)
 * ------------------------------------------------------------------------------------------- */

interface SummaryCursor {
  lastScoringPlayId?: string;
}

export const ingestGameSummary = internalMutation({
  args: {
    eventId: v.string(),
    homeAbbrev: v.string(),
    awayAbbrev: v.string(),
    homeScore: v.number(),
    awayScore: v.number(),
    period: v.optional(v.number()),
    clock: v.optional(v.string()),
    scoringPlays: v.array(parsedScoringPlayValidator),
    boxLines: v.array(boxAthleteLineValidator),
    isFinal: v.boolean(),
    fetchedAt: v.number(),
    maxEvents: v.number(),
  },
  returns: v.object({ used: v.number() }),
  handler: async (ctx, args) => {
    const { eventId, homeAbbrev, awayAbbrev, scoringPlays, boxLines, isFinal, fetchedAt, maxEvents } = args;
    const now = fetchedAt;
    const season = nflSeasonYearFor();
    let remaining = maxEvents;
    let used = 0;

    const cursorSource = `espn_summary:${eventId}`;
    const cursorRow = await ctx.db
      .query("wireSourceState")
      .withIndex("by_source", (q) => q.eq("source", cursorSource))
      .first();
    const prevCursor = (cursorRow?.cursor as SummaryCursor | undefined) ?? {};
    const lastIndex = prevCursor.lastScoringPlayId
      ? scoringPlays.findIndex((p) => p.id === prevCursor.lastScoringPlayId)
      : -1;
    const newPlays = lastIndex >= 0 ? scoringPlays.slice(lastIndex + 1) : scoringPlays;

    const game = { eventId, home: homeAbbrev, away: awayAbbrev };

    for (const play of newPlays) {
      if (remaining <= 0) break;
      const dedupeKey = `scoring_play:${play.id}`;
      if (await dedupeExists(ctx, dedupeKey)) continue;

      const teamAthletes = boxLines.filter((b) => !play.teamAbbrev || b.teamAbbrev === play.teamAbbrev);
      const guess = guessScorerName(play.text);
      const athlete = play.participantEspnId
        ? boxLines.find((b) => b.espnId === play.participantEspnId)
        : guess
          ? matchAthleteByName(teamAthletes, guess)
          : undefined;
      if (!athlete) continue; // unresolved scorer - spec §19.1: skip

      const enriched = await enrichPlayer(ctx, athlete.espnId, season);
      if ((enriched.percentOwned ?? 0) < SCORING_PLAY_MIN_PERCENT_OWNED) continue;

      const isTd = /touchdown/i.test(play.typeText);
      const nameGuess = guess ?? {
        fullName: athlete.displayName,
        firstInitial: athlete.firstName.trim().charAt(0).toUpperCase(),
        lastName: athlete.lastName,
      };
      const tdCountToday = isTd
        ? touchdownCountForPlayer(scoringPlays, play.teamAbbrev, nameGuess, scoringPlays.indexOf(play))
        : undefined;

      const card: WireFactCard = {
        kind: "scoring_play",
        observedAt: fetchedAt,
        players: [
          {
            espnId: athlete.espnId,
            name: athlete.displayName || nameGuess.fullName,
            position: enriched.position,
            nflTeam: athlete.teamAbbrev,
            percentOwned: enriched.percentOwned,
          },
        ],
        nflTeam: athlete.teamAbbrev,
        game: {
          eventId: game.eventId,
          home: game.home,
          away: game.away,
          homeScore: play.homeScore,
          awayScore: play.awayScore,
          period: play.period,
          clock: play.clock,
        },
        play: { text: play.text, yards: parsePlayYards(play.text), tdCountToday, scoreValue: scoreValueForPlayType(play.typeText) },
        source: { type: "espn_summary", id: play.id, fetchedAt },
      };

      const inserted = await postGlobalLiveEvent(ctx, now, "scoring_play", dedupeKey, card);
      if (inserted) {
        used++;
        remaining--;
      }
    }

    for (const athlete of boxLines) {
      if (remaining <= 0) break;
      const hits = bigLineMetricsCrossed(athlete.stats);
      if (hits.length === 0) continue;

      // One post per (event, player, metric) - spec §19.1's dedupe key is per metric, so a player
      // who crosses rushing yards this tick and 3 TD a few ticks later gets two posts, not one
      // that silently folds the second threshold in.
      let enriched: { position?: string; percentOwned?: number } | undefined;
      let totals: ReturnType<typeof boxLineTotals> | undefined;
      for (const hit of hits) {
        if (remaining <= 0) break;
        const dedupeKey = `big_line:${eventId}:${athlete.espnId}:${hit.metric}`;
        if (await dedupeExists(ctx, dedupeKey)) continue;

        enriched ??= await enrichPlayer(ctx, athlete.espnId, season);
        totals ??= boxLineTotals(athlete.stats);
        const card: WireFactCard = {
          kind: "big_line",
          observedAt: fetchedAt,
          players: [
            {
              espnId: athlete.espnId,
              name: athlete.displayName,
              position: enriched.position,
              nflTeam: athlete.teamAbbrev,
              percentOwned: enriched.percentOwned,
            },
          ],
          nflTeam: athlete.teamAbbrev,
          game: { eventId: game.eventId, home: game.home, away: game.away, homeScore: args.homeScore, awayScore: args.awayScore, period: args.period, clock: args.clock },
          line: {
            rushYds: totals.rushYds,
            recYds: totals.recYds,
            passYds: totals.passYds,
            td: totals.passTd + totals.rushTd + totals.recTd,
            fantasyPoints: computeFantasyPoints(athlete.stats),
          },
          source: { type: "espn_summary", id: eventId, fetchedAt },
        };

        const inserted = await postGlobalLiveEvent(ctx, now, "big_line", dedupeKey, card);
        if (inserted) {
          used++;
          remaining--;
        }
      }
    }

    if (isFinal && remaining > 0) {
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const todaysBustWatch = await ctx.db
        .query("wireEvents")
        .withIndex("by_kind_detected", (q) => q.eq("kind", "bust_watch").gt("detectedAt", dayAgo))
        .take(BUST_WATCH_PER_DAY + 5);
      let bustCount = todaysBustWatch.length;

      for (const athlete of boxLines) {
        if (remaining <= 0 || bustCount >= BUST_WATCH_PER_DAY) break;
        const hasSkillStats = athlete.stats.passing || athlete.stats.rushing || athlete.stats.receiving;
        if (!hasSkillStats) continue;
        const fantasyPoints = computeFantasyPoints(athlete.stats);
        if (fantasyPoints >= BUST_WATCH_MAX_POINTS) continue; // cheap early exit before the ADP lookup

        const adpPositionRank = await adpPositionRankFor(ctx, athlete.espnId, season);
        if (!isBustWatchCandidate(adpPositionRank, fantasyPoints)) continue;

        const dedupeKey = `bust_watch:${eventId}:${athlete.espnId}`;
        if (await dedupeExists(ctx, dedupeKey)) continue;

        const enriched = await enrichPlayer(ctx, athlete.espnId, season);
        const guessedPosition = enriched.position ?? (athlete.stats.passing ? "QB" : undefined);
        const card: WireFactCard = {
          kind: "bust_watch",
          observedAt: fetchedAt,
          players: [
            {
              espnId: athlete.espnId,
              name: athlete.displayName,
              position: guessedPosition,
              nflTeam: athlete.teamAbbrev,
              percentOwned: enriched.percentOwned,
              adpPositionRank,
            },
          ],
          nflTeam: athlete.teamAbbrev,
          game: { eventId: game.eventId, home: game.home, away: game.away, homeScore: args.homeScore, awayScore: args.awayScore },
          line: { fantasyPoints },
          source: { type: "espn_summary", id: eventId, fetchedAt },
        };

        const inserted = await postGlobalLiveEvent(ctx, now, "bust_watch", dedupeKey, card);
        if (inserted) {
          used++;
          remaining--;
          bustCount++;
        }
      }
    }

    const nextCursor: SummaryCursor = { lastScoringPlayId: scoringPlays[scoringPlays.length - 1]?.id ?? prevCursor.lastScoringPlayId };
    const summary = `${scoringPlays.length} play(s), ${boxLines.length} athlete(s)${isFinal ? ", final" : ""}`;
    if (cursorRow) {
      await ctx.db.patch(cursorRow._id, { cursor: nextCursor, lastRunAt: now, ok: true, summary });
    } else {
      await ctx.db.insert("wireSourceState", { source: cursorSource, cursor: nextCursor, lastRunAt: now, ok: true, summary });
    }

    return { used };
  },
});

/* ------------------------------------------------------------------------------------------- *
 * Per-league live pull -> matchup_live / monday_needs (tick, step 3), plus the snapshot upsert.
 * ------------------------------------------------------------------------------------------- */

export const processLeagueLiveSnapshot = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    scoringPeriod: v.number(),
    matchups: v.array(snapshotMatchupInputValidator),
    checkMondayNeeds: v.boolean(),
    now: v.number(),
  },
  returns: v.object({ matchupLivePosted: v.number(), mondayNeedsPosted: v.number() }),
  handler: async (ctx, args) => {
    const { leagueId, seasonId, scoringPeriod, checkMondayNeeds, now } = args;

    const prevRow = await ctx.db
      .query("wireLiveSnapshots")
      .withIndex("by_league_period", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId).eq("scoringPeriod", scoringPeriod))
      .first();
    const prevMatchups = prevRow?.matchups ?? [];

    const proTeamCache = new Map<string, string | undefined>();
    async function proTeamFor(espnId: string): Promise<string | undefined> {
      if (proTeamCache.has(espnId)) return proTeamCache.get(espnId);
      const row = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_espn_id_season", (q) => q.eq("espnId", espnId).eq("season", seasonId))
        .first();
      proTeamCache.set(espnId, row?.proTeamAbbrev);
      return row?.proTeamAbbrev;
    }

    const enrichedMatchups = [];
    for (const m of args.matchups) {
      const homePlayers = [];
      for (const p of m.homePlayers) homePlayers.push({ ...p, proTeam: await proTeamFor(p.espnId) });
      const awayPlayers = [];
      for (const p of m.awayPlayers) awayPlayers.push({ ...p, proTeam: await proTeamFor(p.espnId) });
      enrichedMatchups.push({ ...m, homePlayers, awayPlayers });
    }

    let mondayTeamAbbrevs: ReadonlySet<string> = new Set();
    if (checkMondayNeeds) {
      const schedRows = await ctx.db
        .query("nflSchedules")
        .withIndex("by_week", (q) => q.eq("season", seasonId).eq("week", scoringPeriod))
        .take(64);
      mondayTeamAbbrevs = new Set(
        schedRows.filter((r) => localWeekdayAndHour(r.gameTime, "America/New_York").weekday === MONDAY).map((r) => r.teamAbbrev)
      );
    }

    let matchupLivePosted = 0;
    let mondayNeedsPosted = 0;
    const dateStr = new Date(now).toISOString().slice(0, 10);

    for (const curr of enrichedMatchups) {
      const prev = prevMatchups.find((p) => p.homeTeamId === curr.homeTeamId && p.awayTeamId === curr.awayTeamId);
      const triggers = detectMatchupTriggers(
        prev ? { homeScore: prev.homeScore, awayScore: prev.awayScore } : undefined,
        { homeScore: curr.homeScore, awayScore: curr.awayScore }
      );

      if (triggers.length > 0) {
        const teams = await resolveTeamPair(ctx, leagueId, seasonId, curr.homeTeamId, curr.awayTeamId);
        if (teams) {
          const homeLeads = curr.homeScore >= curr.awayScore;
          const leader = homeLeads ? teams.home : teams.away;
          const trailer = homeLeads ? teams.away : teams.home;
          const leaderScore = homeLeads ? curr.homeScore : curr.awayScore;
          const trailerScore = homeLeads ? curr.awayScore : curr.homeScore;
          const margin = Math.abs(curr.homeScore - curr.awayScore);
          for (const trigger of triggers) {
            const dedupeKey = `matchup_live:${curr.homeTeamId}:${curr.awayTeamId}:${trigger}:${dateStr}`;
            const posted = await postLeagueStockLine(ctx, {
              leagueId,
              seasonId,
              week: scoringPeriod,
              kind: "matchup_live",
              persona: "curtis-vaughn",
              slots: {
                team: leader.name,
                opponentTeam: trailer.name,
                score: leaderScore.toFixed(1),
                opponentScore: trailerScore.toFixed(1),
                margin: margin.toFixed(1),
                week: String(scoringPeriod),
              },
              featuredTeams: [leader._id, trailer._id],
              dedupeKey,
              now,
            });
            if (posted) matchupLivePosted++;
          }
        }
      }

      if (checkMondayNeeds && curr.homeScore !== curr.awayScore) {
        const trailingIsHome = curr.homeScore < curr.awayScore;
        const trailingPlayers = trailingIsHome ? curr.homePlayers : curr.awayPlayers;
        const mondayStarters = trailingPlayers.filter(
          (p) => isStartingSlot(p.lineupSlotId) && p.proTeam !== undefined && mondayTeamAbbrevs.has(p.proTeam)
        );
        if (mondayStarters.length > 0) {
          const teams = await resolveTeamPair(ctx, leagueId, seasonId, curr.homeTeamId, curr.awayTeamId);
          if (teams) {
            const trailingTeam = trailingIsHome ? teams.home : teams.away;
            const otherTeam = trailingIsHome ? teams.away : teams.home;
            const deficit = Math.abs(curr.homeScore - curr.awayScore);
            const names = await namesFor(ctx, seasonId, mondayStarters.map((p) => p.espnId));
            const dedupeKey = `monday_needs:${leagueId}:${scoringPeriod}:${curr.homeTeamId}-${curr.awayTeamId}`;
            const posted = await postLeagueStockLine(ctx, {
              leagueId,
              seasonId,
              week: scoringPeriod,
              kind: "monday_needs",
              persona: "nina-sharpe",
              slots: {
                team: trailingTeam.name,
                opponentTeam: otherTeam.name,
                points: deficit.toFixed(1),
                players: joinNames(names),
                week: String(scoringPeriod),
              },
              featuredTeams: [trailingTeam._id, otherTeam._id],
              dedupeKey,
              now,
            });
            if (posted) mondayNeedsPosted++;
          }
        }
      }
    }

    if (prevRow) {
      await ctx.db.patch(prevRow._id, { takenAt: now, matchups: enrichedMatchups });
    } else {
      await ctx.db.insert("wireLiveSnapshots", { leagueId, seasonId, scoringPeriod, takenAt: now, matchups: enrichedMatchups });
    }

    return { matchupLivePosted, mondayNeedsPosted };
  },
});
