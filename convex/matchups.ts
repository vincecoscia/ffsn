/* eslint-disable @typescript-eslint/no-explicit-any */
import { query } from "./_generated/server";
import { v } from "convex/values";

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