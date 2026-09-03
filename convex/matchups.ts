/* eslint-disable @typescript-eslint/no-explicit-any */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { getLeagueMembership } from "./lib/auth";
import { isPreDraftRedraft, summarizeMatchup } from "./lib/matchupSummary";
// `./lib/playoffs` and `./lib/playoffValidators` are deliberately pure modules (no `internal`/`api`
// imports of their own - see their file headers), safe to import as values here per the repo-wide
// gotcha about cross-module value imports of a convex/*.ts module that references `internal`.
import { buildPlayoffContext, highestFinishedMatchupPeriod } from "./lib/playoffs";
import { playoffContextValidator } from "./lib/playoffValidators";
import type { PlayoffContext } from "./lib/playoffTypes";
import { parseEspnLeagueSettings } from "./lib/espnSettings";

/**
 * Slim per-season schedule for the schedule/scores pages (spec: audit
 * finding that the schedule page fired 18 `getByLeagueAndPeriod` queries -
 * one per week - and summed full home/away rosters client-side, which
 * double-counted IR players as starters and showed "in progress 0.0-0.0"
 * before kickoff; see `convex/lib/matchupSummary.ts`'s header comment for
 * the fix). Returns one row per matchup, sorted by `matchupPeriod` then
 * `scoringPeriod`, with no roster payload - roughly 90 rows/season instead
 * of 18 round trips each carrying both full rosters.
 *
 * Also reads the season's `leagueSeasons` row to null out every row's
 * projected fields when `isPreDraftRedraft` is true (matchupSummary.ts's
 * header comment, finding 3) - a redraft league before its draft has no
 * real lineups yet, only ESPN's carried-over previous-season ones. Pairings
 * and status are untouched: the pages read the draft flags themselves from
 * `leagues.getLeagueSeasonByYear` for any messaging beyond the numbers.
 */
export const getScheduleBySeason = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  returns: v.array(
    v.object({
      _id: v.id("matchups"),
      matchupPeriod: v.number(),
      scoringPeriod: v.number(),
      homeTeamId: v.string(),
      awayTeamId: v.string(),
      winner: v.union(v.literal("home"), v.literal("away"), v.literal("tie"), v.null()),
      status: v.union(v.literal("final"), v.literal("live"), v.literal("scheduled")),
      playoffTier: v.union(v.string(), v.null()),
      homeScore: v.number(),
      awayScore: v.number(),
      homeProjected: v.union(v.number(), v.null()),
      awayProjected: v.union(v.number(), v.null()),
      isBye: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    const membership = await getLeagueMembership(ctx, args.leagueId);
    if (!membership) {
      return [];
    }

    const [matchups, season] = await Promise.all([
      ctx.db
        .query("matchups")
        .withIndex("by_league_season", (q) =>
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .collect(),
      ctx.db
        .query("leagueSeasons")
        .withIndex("by_league_season", (q) =>
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .first(),
    ]);

    const hideProjections = isPreDraftRedraft(season ?? undefined);

    return matchups
      .map((doc) => summarizeMatchup(doc, { hideProjections }))
      .sort((a, b) => a.matchupPeriod - b.matchupPeriod || a.scoringPeriod - b.scoringPeriod);
  },
});

/**
 * Placeholder `PlayoffContext` for a caller `getPlayoffBracket` can't build a real one for: a
 * non-member (spec: return data, not an error, matching `getScheduleBySeason`'s `[]`) or a
 * pre-draft redraft season (`isPreDraftRedraft` - carried-over previous-season rosters/pairings
 * make any bracket projection meaningless before this season's own draft has happened). `seeds: []`
 * with `mode: "projected"` is the signal the schedule page's bracket component reads as "nothing to
 * show yet".
 */
function emptyPlayoffContext(): PlayoffContext {
  return {
    mode: "projected",
    playoffTeamCount: 0,
    rounds: 0,
    byes: 0,
    playoffStartWeek: 0,
    championshipWeek: 0,
    currentRound: undefined,
    seeds: [],
    bubble: [],
    bracket: [],
    consolation: [],
    alive: [],
    eliminated: [],
    champion: undefined,
    runnerUp: undefined,
  };
}

/**
 * The playoff picture and bracket for one league-season (spec: owner ask - a bracket at playoff
 * time, an "if the season ended today" bracket during the regular season). Pure math lives in
 * `convex/lib/playoffs.ts#buildPlayoffContext`; this just gathers its inputs the same bounded way
 * `getScheduleBySeason` above does (one `.collect()` per season-scoped index - a season's rows are
 * naturally bounded) and resolves every team id to that season's real name.
 */
export const getPlayoffBracket = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  returns: playoffContextValidator,
  handler: async (ctx, args) => {
    const membership = await getLeagueMembership(ctx, args.leagueId);
    if (!membership) {
      return emptyPlayoffContext();
    }

    const [matchups, teams, season] = await Promise.all([
      ctx.db
        .query("matchups")
        .withIndex("by_league_season", (q) =>
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .collect(),
      ctx.db
        .query("teams")
        .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
        .collect(),
      ctx.db
        .query("leagueSeasons")
        .withIndex("by_league_season", (q) =>
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .first(),
    ]);

    // Before this season's own draft, ESPN's carried-over previous-season pairings/rosters make a
    // bracket projection meaningless - same guard `getScheduleBySeason` uses to hide projections.
    if (isPreDraftRedraft(season ?? undefined)) {
      return emptyPlayoffContext();
    }

    const parsed = parseEspnLeagueSettings(season?.settings);

    return buildPlayoffContext({
      teams: teams.map((team) => ({
        externalId: team.externalId,
        name: team.name,
        record: {
          wins: team.record.wins,
          losses: team.record.losses,
          ties: team.record.ties,
          pointsFor: team.record.pointsFor,
          playoffSeed: team.record.playoffSeed,
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
      // The highest matchup period with any decided game - not `league.espnData.currentScoringPeriod`,
      // which can lead or lag the last week that actually finished (see this helper's doc comment).
      throughWeek: highestFinishedMatchupPeriod(matchups),
    });
  },
});

export const getByLeagueAndPeriod = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    matchupPeriod: v.number()
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_period", (q) => 
        q.eq("leagueId", args.leagueId).eq("matchupPeriod", args.matchupPeriod)
      )
      .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
      .collect();

    return matchups;
  },
});

export const getCurrentWeekMatchups = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number()
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { matchups: [], currentWeek: 1 };
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return { matchups: [], currentWeek: 1 };
    }

    // Find the current week by looking for the first week with undecided games
    // Start from week 1 and iterate until we find incomplete matchups
    let currentWeek = 1;
    let currentMatchups: any[] = [];

    for (let week = 1; week <= 18; week++) { // NFL season is max 18 weeks
      const weekMatchups = await ctx.db
        .query("matchups")
        .withIndex("by_league_period", (q) => 
          q.eq("leagueId", args.leagueId).eq("matchupPeriod", week)
        )
        .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
        .collect();

      if (weekMatchups.length === 0) break;

      // Check if all games in this week have winners
      const incompleteGames = weekMatchups.filter(matchup => !matchup.winner);
      
      if (incompleteGames.length > 0) {
        // Found the current week - some games are not finished
        currentWeek = week;
        currentMatchups = weekMatchups;
        break;
      } else if (week === 1 && weekMatchups.every(matchup => matchup.winner)) {
        // If week 1 is complete, but we haven't found incomplete games yet,
        // continue to next week
        currentWeek = week + 1;
        continue;
      }
      
      // If we get here, this week is complete, move to next
      currentWeek = week + 1;
      currentMatchups = weekMatchups;
    }

    // If no incomplete weeks found, return the last week's matchups
    if (currentMatchups.length === 0 && currentWeek > 1) {
      currentMatchups = await ctx.db
        .query("matchups")
        .withIndex("by_league_period", (q) => 
          q.eq("leagueId", args.leagueId).eq("matchupPeriod", currentWeek - 1)
        )
        .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
        .collect();
      currentWeek = currentWeek - 1;
    }

    return {
      matchups: currentMatchups,
      currentWeek
    };
  },
});

export const getTopScoresAllTime = query({
  args: { 
    leagueId: v.id("leagues"),
    limit: v.optional(v.number()),
    scoreType: v.optional(v.union(v.literal("single"), v.literal("twoWeek")))
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    const limit = args.limit || 10;
    const scoreType = args.scoreType || "single";

    // Get all matchups for this league
    const allMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.neq(q.field("winner"), null)) // Only completed games
      .collect();

    if (scoreType === "twoWeek") {
      // Return two-week combined scores
      const twoWeekScores: Array<{
        totalScore: number;
        week1Score: number;
        week2Score: number;
        teamId: string;
        seasonId: number;
        startWeek: number;
        matchupIds: string[];
        isHome: boolean;
      }> = [];

      // Find matchups with multiple scoring periods (two-week games)
      allMatchups.forEach(matchup => {
        const homePointsByPeriod = matchup.homePointsByScoringPeriod;
        const awayPointsByPeriod = matchup.awayPointsByScoringPeriod;
        
        // Check if this is a two-week matchup (has points for multiple scoring periods)
        if (homePointsByPeriod && Object.keys(homePointsByPeriod).length >= 2) {
          const periods = Object.keys(homePointsByPeriod).sort((a, b) => parseInt(a) - parseInt(b));
          const week1Period = periods[0];
          const week2Period = periods[1];
          
          // Handle home team
          twoWeekScores.push({
            totalScore: matchup.homeScore,
            week1Score: homePointsByPeriod[week1Period] || 0,
            week2Score: homePointsByPeriod[week2Period] || 0,
            teamId: matchup.homeTeamId,
            seasonId: matchup.seasonId,
            startWeek: matchup.matchupPeriod,
            matchupIds: [matchup._id],
            isHome: true
          });
        }
        
        if (awayPointsByPeriod && Object.keys(awayPointsByPeriod).length >= 2) {
          const periods = Object.keys(awayPointsByPeriod).sort((a, b) => parseInt(a) - parseInt(b));
          const week1Period = periods[0];
          const week2Period = periods[1];
          
          // Handle away team
          twoWeekScores.push({
            totalScore: matchup.awayScore,
            week1Score: awayPointsByPeriod[week1Period] || 0,
            week2Score: awayPointsByPeriod[week2Period] || 0,
            teamId: matchup.awayTeamId,
            seasonId: matchup.seasonId,
            startWeek: matchup.matchupPeriod,
            matchupIds: [matchup._id],
            isHome: false
          });
        }
      });

      return twoWeekScores
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, limit);
    } else {
      // Return single-week scores
      const singleWeekScores: Array<{
        score: number;
        teamId: string;
        seasonId: number;
        matchupPeriod: number;
        matchupId: string;
        isHome: boolean;
      }> = [];

      allMatchups.forEach(matchup => {
        const homePointsByPeriod = matchup.homePointsByScoringPeriod;
        const awayPointsByPeriod = matchup.awayPointsByScoringPeriod;
        
        // For single-week games, include all scores
        // For two-week games, break them down into individual weeks
        if (!homePointsByPeriod || Object.keys(homePointsByPeriod).length <= 1) {
          // Standard single-week game for home team
          singleWeekScores.push({
            score: matchup.homeScore,
            teamId: matchup.homeTeamId,
            seasonId: matchup.seasonId,
            matchupPeriod: matchup.matchupPeriod,
            matchupId: matchup._id,
            isHome: true
          });
        } else {
          // Two-week game - add each week separately for home team
          Object.entries(homePointsByPeriod).forEach(([period, score]) => {
            singleWeekScores.push({
              score: score,
              teamId: matchup.homeTeamId,
              seasonId: matchup.seasonId,
              matchupPeriod: parseInt(period),
              matchupId: `${matchup._id}-${period}`,
              isHome: true
            });
          });
        }
        
        if (!awayPointsByPeriod || Object.keys(awayPointsByPeriod).length <= 1) {
          // Standard single-week game for away team
          singleWeekScores.push({
            score: matchup.awayScore,
            teamId: matchup.awayTeamId,
            seasonId: matchup.seasonId,
            matchupPeriod: matchup.matchupPeriod,
            matchupId: matchup._id,
            isHome: false
          });
        } else {
          // Two-week game - add each week separately for away team
          Object.entries(awayPointsByPeriod).forEach(([period, score]) => {
            singleWeekScores.push({
              score: score,
              teamId: matchup.awayTeamId,
              seasonId: matchup.seasonId,
              matchupPeriod: parseInt(period),
              matchupId: `${matchup._id}-${period}`,
              isHome: false
            });
          });
        }
      });

      return singleWeekScores
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }
  },
});

export const getLowestScoresAllTime = query({
  args: { 
    leagueId: v.id("leagues"),
    limit: v.optional(v.number()),
    scoreType: v.optional(v.union(v.literal("single"), v.literal("twoWeek")))
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    const limit = args.limit || 10;
    const scoreType = args.scoreType || "single";

    // Get all matchups for this league
    const allMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.neq(q.field("winner"), null)) // Only completed games
      .collect();

    if (scoreType === "twoWeek") {
      // Return two-week combined scores
      const twoWeekScores: Array<{
        totalScore: number;
        week1Score: number;
        week2Score: number;
        teamId: string;
        seasonId: number;
        startWeek: number;
        matchupIds: string[];
        isHome: boolean;
      }> = [];

      // Find matchups with multiple scoring periods (two-week games)
      allMatchups.forEach(matchup => {
        const homePointsByPeriod = matchup.homePointsByScoringPeriod;
        const awayPointsByPeriod = matchup.awayPointsByScoringPeriod;
        
        // Check if this is a two-week matchup (has points for multiple scoring periods)
        if (homePointsByPeriod && Object.keys(homePointsByPeriod).length >= 2) {
          const periods = Object.keys(homePointsByPeriod).sort((a, b) => parseInt(a) - parseInt(b));
          const week1Period = periods[0];
          const week2Period = periods[1];
          
          // Handle home team
          twoWeekScores.push({
            totalScore: matchup.homeScore,
            week1Score: homePointsByPeriod[week1Period] || 0,
            week2Score: homePointsByPeriod[week2Period] || 0,
            teamId: matchup.homeTeamId,
            seasonId: matchup.seasonId,
            startWeek: matchup.matchupPeriod,
            matchupIds: [matchup._id],
            isHome: true
          });
        }
        
        if (awayPointsByPeriod && Object.keys(awayPointsByPeriod).length >= 2) {
          const periods = Object.keys(awayPointsByPeriod).sort((a, b) => parseInt(a) - parseInt(b));
          const week1Period = periods[0];
          const week2Period = periods[1];
          
          // Handle away team
          twoWeekScores.push({
            totalScore: matchup.awayScore,
            week1Score: awayPointsByPeriod[week1Period] || 0,
            week2Score: awayPointsByPeriod[week2Period] || 0,
            teamId: matchup.awayTeamId,
            seasonId: matchup.seasonId,
            startWeek: matchup.matchupPeriod,
            matchupIds: [matchup._id],
            isHome: false
          });
        }
      });

      return twoWeekScores
        .filter(score => score.totalScore > 0) // Filter out zero scores
        .sort((a, b) => a.totalScore - b.totalScore) // Sort ascending for lowest scores
        .slice(0, limit);
    } else {
      // Return single-week scores
      const singleWeekScores: Array<{
        score: number;
        teamId: string;
        seasonId: number;
        matchupPeriod: number;
        matchupId: string;
        isHome: boolean;
      }> = [];

      allMatchups.forEach(matchup => {
        const homePointsByPeriod = matchup.homePointsByScoringPeriod;
        const awayPointsByPeriod = matchup.awayPointsByScoringPeriod;
        
        // For single-week games, include all scores
        // For two-week games, break them down into individual weeks
        if (!homePointsByPeriod || Object.keys(homePointsByPeriod).length <= 1) {
          // Standard single-week game for home team
          singleWeekScores.push({
            score: matchup.homeScore,
            teamId: matchup.homeTeamId,
            seasonId: matchup.seasonId,
            matchupPeriod: matchup.matchupPeriod,
            matchupId: matchup._id,
            isHome: true
          });
        } else {
          // Two-week game - add each week separately for home team
          Object.entries(homePointsByPeriod).forEach(([period, score]) => {
            singleWeekScores.push({
              score: score,
              teamId: matchup.homeTeamId,
              seasonId: matchup.seasonId,
              matchupPeriod: parseInt(period),
              matchupId: `${matchup._id}-${period}`,
              isHome: true
            });
          });
        }
        
        if (!awayPointsByPeriod || Object.keys(awayPointsByPeriod).length <= 1) {
          // Standard single-week game for away team
          singleWeekScores.push({
            score: matchup.awayScore,
            teamId: matchup.awayTeamId,
            seasonId: matchup.seasonId,
            matchupPeriod: matchup.matchupPeriod,
            matchupId: matchup._id,
            isHome: false
          });
        } else {
          // Two-week game - add each week separately for away team
          Object.entries(awayPointsByPeriod).forEach(([period, score]) => {
            singleWeekScores.push({
              score: score,
              teamId: matchup.awayTeamId,
              seasonId: matchup.seasonId,
              matchupPeriod: parseInt(period),
              matchupId: `${matchup._id}-${period}`,
              isHome: false
            });
          });
        }
      });

      return singleWeekScores
        .filter(score => score.score > 0) // Filter out zero scores
        .sort((a, b) => a.score - b.score) // Sort ascending for lowest scores
        .slice(0, limit);
    }
  },
});

export const getTopScoresBySeason = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    limit: v.optional(v.number()),
    scoreType: v.optional(v.union(v.literal("single"), v.literal("twoWeek")))
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    const limit = args.limit || 10;
    const scoreType = args.scoreType || "single";

    // Get matchups for this league and season
    const seasonMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
      .filter((q) => q.neq(q.field("winner"), null)) // Only completed games
      .collect();

    if (scoreType === "twoWeek") {
      // Return two-week combined scores
      const twoWeekScores: Array<{
        totalScore: number;
        week1Score: number;
        week2Score: number;
        teamId: string;
        seasonId: number;
        startWeek: number;
        matchupIds: string[];
        isHome: boolean;
      }> = [];

      // Find matchups with multiple scoring periods (two-week games)
      seasonMatchups.forEach(matchup => {
        const homePointsByPeriod = matchup.homePointsByScoringPeriod;
        const awayPointsByPeriod = matchup.awayPointsByScoringPeriod;
        
        // Check if this is a two-week matchup (has points for multiple scoring periods)
        if (homePointsByPeriod && Object.keys(homePointsByPeriod).length >= 2) {
          const periods = Object.keys(homePointsByPeriod).sort((a, b) => parseInt(a) - parseInt(b));
          const week1Period = periods[0];
          const week2Period = periods[1];
          
          // Handle home team
          twoWeekScores.push({
            totalScore: matchup.homeScore,
            week1Score: homePointsByPeriod[week1Period] || 0,
            week2Score: homePointsByPeriod[week2Period] || 0,
            teamId: matchup.homeTeamId,
            seasonId: matchup.seasonId,
            startWeek: matchup.matchupPeriod,
            matchupIds: [matchup._id],
            isHome: true
          });
        }
        
        if (awayPointsByPeriod && Object.keys(awayPointsByPeriod).length >= 2) {
          const periods = Object.keys(awayPointsByPeriod).sort((a, b) => parseInt(a) - parseInt(b));
          const week1Period = periods[0];
          const week2Period = periods[1];
          
          // Handle away team
          twoWeekScores.push({
            totalScore: matchup.awayScore,
            week1Score: awayPointsByPeriod[week1Period] || 0,
            week2Score: awayPointsByPeriod[week2Period] || 0,
            teamId: matchup.awayTeamId,
            seasonId: matchup.seasonId,
            startWeek: matchup.matchupPeriod,
            matchupIds: [matchup._id],
            isHome: false
          });
        }
      });

      return twoWeekScores
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, limit);
    } else {
      // Return single-week scores
      const singleWeekScores: Array<{
        score: number;
        teamId: string;
        seasonId: number;
        matchupPeriod: number;
        matchupId: string;
        isHome: boolean;
      }> = [];

      seasonMatchups.forEach(matchup => {
        const homePointsByPeriod = matchup.homePointsByScoringPeriod;
        const awayPointsByPeriod = matchup.awayPointsByScoringPeriod;
        
        // For single-week games, include all scores
        // For two-week games, break them down into individual weeks
        if (!homePointsByPeriod || Object.keys(homePointsByPeriod).length <= 1) {
          // Standard single-week game for home team
          singleWeekScores.push({
            score: matchup.homeScore,
            teamId: matchup.homeTeamId,
            seasonId: matchup.seasonId,
            matchupPeriod: matchup.matchupPeriod,
            matchupId: matchup._id,
            isHome: true
          });
        } else {
          // Two-week game - add each week separately for home team
          Object.entries(homePointsByPeriod).forEach(([period, score]) => {
            singleWeekScores.push({
              score: score,
              teamId: matchup.homeTeamId,
              seasonId: matchup.seasonId,
              matchupPeriod: parseInt(period),
              matchupId: `${matchup._id}-${period}`,
              isHome: true
            });
          });
        }
        
        if (!awayPointsByPeriod || Object.keys(awayPointsByPeriod).length <= 1) {
          // Standard single-week game for away team
          singleWeekScores.push({
            score: matchup.awayScore,
            teamId: matchup.awayTeamId,
            seasonId: matchup.seasonId,
            matchupPeriod: matchup.matchupPeriod,
            matchupId: matchup._id,
            isHome: false
          });
        } else {
          // Two-week game - add each week separately for away team
          Object.entries(awayPointsByPeriod).forEach(([period, score]) => {
            singleWeekScores.push({
              score: score,
              teamId: matchup.awayTeamId,
              seasonId: matchup.seasonId,
              matchupPeriod: parseInt(period),
              matchupId: `${matchup._id}-${period}`,
              isHome: false
            });
          });
        }
      });

      return singleWeekScores
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }
  },
});

export const getLowestScoresBySeason = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    limit: v.optional(v.number()),
    scoreType: v.optional(v.union(v.literal("single"), v.literal("twoWeek")))
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    const limit = args.limit || 10;
    const scoreType = args.scoreType || "single";

    // Get matchups for this league and season
    const seasonMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
      .filter((q) => q.neq(q.field("winner"), null)) // Only completed games
      .collect();

    if (scoreType === "twoWeek") {
      // Return two-week combined scores
      const twoWeekScores: Array<{
        totalScore: number;
        week1Score: number;
        week2Score: number;
        teamId: string;
        seasonId: number;
        startWeek: number;
        matchupIds: string[];
        isHome: boolean;
      }> = [];

      // Find matchups with multiple scoring periods (two-week games)
      seasonMatchups.forEach(matchup => {
        const homePointsByPeriod = matchup.homePointsByScoringPeriod;
        const awayPointsByPeriod = matchup.awayPointsByScoringPeriod;
        
        // Check if this is a two-week matchup (has points for multiple scoring periods)
        if (homePointsByPeriod && Object.keys(homePointsByPeriod).length >= 2) {
          const periods = Object.keys(homePointsByPeriod).sort((a, b) => parseInt(a) - parseInt(b));
          const week1Period = periods[0];
          const week2Period = periods[1];
          
          // Handle home team
          twoWeekScores.push({
            totalScore: matchup.homeScore,
            week1Score: homePointsByPeriod[week1Period] || 0,
            week2Score: homePointsByPeriod[week2Period] || 0,
            teamId: matchup.homeTeamId,
            seasonId: matchup.seasonId,
            startWeek: matchup.matchupPeriod,
            matchupIds: [matchup._id],
            isHome: true
          });
        }
        
        if (awayPointsByPeriod && Object.keys(awayPointsByPeriod).length >= 2) {
          const periods = Object.keys(awayPointsByPeriod).sort((a, b) => parseInt(a) - parseInt(b));
          const week1Period = periods[0];
          const week2Period = periods[1];
          
          // Handle away team
          twoWeekScores.push({
            totalScore: matchup.awayScore,
            week1Score: awayPointsByPeriod[week1Period] || 0,
            week2Score: awayPointsByPeriod[week2Period] || 0,
            teamId: matchup.awayTeamId,
            seasonId: matchup.seasonId,
            startWeek: matchup.matchupPeriod,
            matchupIds: [matchup._id],
            isHome: false
          });
        }
      });

      return twoWeekScores
        .filter(score => score.totalScore > 0) // Filter out zero scores
        .sort((a, b) => a.totalScore - b.totalScore) // Sort ascending for lowest scores
        .slice(0, limit);
    } else {
      // Return single-week scores
      const singleWeekScores: Array<{
        score: number;
        teamId: string;
        seasonId: number;
        matchupPeriod: number;
        matchupId: string;
        isHome: boolean;
      }> = [];

      seasonMatchups.forEach(matchup => {
        const homePointsByPeriod = matchup.homePointsByScoringPeriod;
        const awayPointsByPeriod = matchup.awayPointsByScoringPeriod;
        
        // For single-week games, include all scores
        // For two-week games, break them down into individual weeks
        if (!homePointsByPeriod || Object.keys(homePointsByPeriod).length <= 1) {
          // Standard single-week game for home team
          singleWeekScores.push({
            score: matchup.homeScore,
            teamId: matchup.homeTeamId,
            seasonId: matchup.seasonId,
            matchupPeriod: matchup.matchupPeriod,
            matchupId: matchup._id,
            isHome: true
          });
        } else {
          // Two-week game - add each week separately for home team
          Object.entries(homePointsByPeriod).forEach(([period, score]) => {
            singleWeekScores.push({
              score: score,
              teamId: matchup.homeTeamId,
              seasonId: matchup.seasonId,
              matchupPeriod: parseInt(period),
              matchupId: `${matchup._id}-${period}`,
              isHome: true
            });
          });
        }
        
        if (!awayPointsByPeriod || Object.keys(awayPointsByPeriod).length <= 1) {
          // Standard single-week game for away team
          singleWeekScores.push({
            score: matchup.awayScore,
            teamId: matchup.awayTeamId,
            seasonId: matchup.seasonId,
            matchupPeriod: matchup.matchupPeriod,
            matchupId: matchup._id,
            isHome: false
          });
        } else {
          // Two-week game - add each week separately for away team
          Object.entries(awayPointsByPeriod).forEach(([period, score]) => {
            singleWeekScores.push({
              score: score,
              teamId: matchup.awayTeamId,
              seasonId: matchup.seasonId,
              matchupPeriod: parseInt(period),
              matchupId: `${matchup._id}-${period}`,
              isHome: false
            });
          });
        }
      });

      return singleWeekScores
        .filter(score => score.score > 0) // Filter out zero scores
        .sort((a, b) => a.score - b.score) // Sort ascending for lowest scores
        .slice(0, limit);
    }
  },
});

export const getCompletedWeeks = query({
  args: { 
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    // Get all matchups for this league
    const allMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    // Group by season and week
    const weeksBySeason = new Map<number, Set<number>>();
    
    allMatchups.forEach(matchup => {
      // Only include weeks where the matchup has a winner (i.e., is completed)
      if (matchup.winner) {
        if (!weeksBySeason.has(matchup.seasonId)) {
          weeksBySeason.set(matchup.seasonId, new Set());
        }
        weeksBySeason.get(matchup.seasonId)?.add(matchup.matchupPeriod);
      }
    });

    // Transform to array format and check if all matchups in a week are complete
    const result: { seasonId: number; weeks: number[] }[] = [];
    
    for (const [seasonId, weeksSet] of weeksBySeason.entries()) {
      const weeks = Array.from(weeksSet).sort((a, b) => a - b);
      
      // For each week, verify ALL matchups are complete
      const completedWeeks = [];
      for (const week of weeks) {
        const weekMatchups = allMatchups.filter(
          m => m.seasonId === seasonId && m.matchupPeriod === week
        );
        
        // Only include this week if ALL matchups have winners
        if (weekMatchups.length > 0 && weekMatchups.every(m => m.winner)) {
          completedWeeks.push(week);
        }
      }
      
      if (completedWeeks.length > 0) {
        result.push({ seasonId, weeks: completedWeeks });
      }
    }
    
    // Sort by season (newest first)
    return result.sort((a, b) => b.seasonId - a.seasonId);
  },
});