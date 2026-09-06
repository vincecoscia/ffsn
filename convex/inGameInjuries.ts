/**
 * In-game injuries (ffsn-the-wire-spec.md §16): the query half. Pure joining logic lives in
 * `convex/lib/inGameInjuries.ts#buildInGameInjuries`; this file only fetches the rows that
 * function needs and hands them to it.
 *
 * Callers: `aiQueries.ts#getLeagueDataForAI` (recap/preview FACTS + the bench-impact exclusion)
 * and `commentRequests.ts#buildConversationContext` (the interview's `lineupDecisions` exclusion).
 * Both call this through `ctx.runQuery(internal.inGameInjuries.getInGameInjuriesForWeek, ...)`
 * rather than importing `buildInGameInjuries` and re-fetching themselves - one bounded query per
 * (league, season, week) instead of duplicating the matchup/roster/event joins at each call site.
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { buildInGameInjuries, type InGameInjuryEventCandidate, type InGameInjuryTeamRoster } from "./lib/inGameInjuries";
import { validateFactCard } from "../src/lib/ai/wire/card";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bound on total roster players scanned in one call (spec: "at most ~200 players x 2 point
 *  reads") - comfortably above any real league's two-sided roster for one week's matchups. */
const MAX_PLAYERS = 200;
// The window rule itself only needs [kickoffAt, kickoffAt + 4.5h] (buildInGameInjuries enforces
// it); this bounds the wireEvents RANGE READ generously (kickoff - 1 day .. kickoff + 1 day) so a
// clock-skewed `detectedAt` never falls just outside the indexed range.
const IN_GAME_LOOKAHEAD_MS = DAY_MS;

export const inGameInjuryValidator = v.object({
  espnId: v.string(),
  name: v.string(),
  position: v.optional(v.string()),
  nflTeam: v.optional(v.string()),
  fantasyTeamId: v.string(),
  fantasyTeamName: v.string(),
  week: v.number(),
  status: v.string(),
  observedAt: v.number(),
  kickoffAt: v.number(),
  started: v.boolean(),
  points: v.optional(v.number()),
});

export const getInGameInjuriesForWeek = internalQuery({
  args: { leagueId: v.id("leagues"), seasonId: v.number(), week: v.number() },
  returns: v.array(inGameInjuryValidator),
  handler: async (ctx, { leagueId, seasonId, week }) => {
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .filter((q) => q.eq(q.field("matchupPeriod"), week))
      .take(40);
    if (matchups.length === 0) return [];

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .take(40);
    const teamByExternalId = new Map(teams.map((t) => [t.externalId, t]));

    const rosters: InGameInjuryTeamRoster[] = [];
    let playerCount = 0;
    for (const matchup of matchups) {
      for (const side of [
        { externalId: matchup.homeTeamId, roster: matchup.homeRoster },
        { externalId: matchup.awayTeamId, roster: matchup.awayRoster },
      ]) {
        const team = teamByExternalId.get(side.externalId);
        const players = (side.roster?.players ?? []).slice(0, Math.max(0, MAX_PLAYERS - playerCount));
        playerCount += players.length;
        if (players.length === 0) continue;
        rosters.push({
          fantasyTeamId: side.externalId,
          fantasyTeamName: team?.name ?? side.externalId,
          players: players.map((p) => ({
            espnId: String(p.espnId),
            name: p.fullName,
            position: p.position,
            lineupSlotId: p.lineupSlotId,
            points: p.points,
          })),
        });
        if (playerCount >= MAX_PLAYERS) break;
      }
      if (playerCount >= MAX_PLAYERS) break;
    }

    // Per-player NFL team (playersEnhanced) and per-NFL-team kickoff (nflSchedules), cached so a
    // team shared by many players (D/ST rosters share one abbreviation with a dozen skill
    // players) costs one lookup rather than one per player.
    const nflTeamByEspnId = new Map<string, string | undefined>();
    const kickoffByNflTeam = new Map<string, number | undefined>();
    const injuryEventsByEspnId = new Map<string, InGameInjuryEventCandidate[]>();

    for (const roster of rosters) {
      for (const player of roster.players) {
        if (!nflTeamByEspnId.has(player.espnId)) {
          const enhanced = await ctx.db
            .query("playersEnhanced")
            .withIndex("by_espn_id_season", (q) => q.eq("espnId", player.espnId).eq("season", seasonId))
            .first();
          nflTeamByEspnId.set(player.espnId, enhanced?.proTeamAbbrev);
        }
        const nflTeam = nflTeamByEspnId.get(player.espnId);
        if (!nflTeam) continue;

        if (!kickoffByNflTeam.has(nflTeam)) {
          const sched = await ctx.db
            .query("nflSchedules")
            .withIndex("by_season_week_team", (q) => q.eq("season", seasonId).eq("week", week).eq("teamAbbrev", nflTeam))
            .first();
          kickoffByNflTeam.set(nflTeam, sched?.gameTime);
        }
        const kickoffAt = kickoffByNflTeam.get(nflTeam);
        if (kickoffAt === undefined) continue;

        if (!injuryEventsByEspnId.has(player.espnId)) {
          const events = await ctx.db
            .query("wireEvents")
            .withIndex("by_player_detected", (q) =>
              q
                .eq("primaryEspnId", player.espnId)
                .gt("detectedAt", kickoffAt - DAY_MS)
                .lt("detectedAt", kickoffAt + IN_GAME_LOOKAHEAD_MS)
            )
            .order("desc")
            .take(5);
          const candidates: InGameInjuryEventCandidate[] = [];
          for (const event of events) {
            if (event.kind !== "injury_status") continue;
            try {
              const card = validateFactCard(event.facts);
              if (card.statusTo) candidates.push({ observedAt: event.observedAt, status: card.statusTo });
            } catch {
              continue;
            }
          }
          injuryEventsByEspnId.set(player.espnId, candidates);
        }
      }
    }

    return buildInGameInjuries({ week, rosters, nflTeamByEspnId, kickoffByNflTeam, injuryEventsByEspnId });
  },
});
