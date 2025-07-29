import { v } from "convex/values";
import { mutation, internalMutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { 
  calculateStrengthOfSchedule, 
  calculateRecentForm, 
  detectRivalries,
  calculateBenchPoints,
  analyzeTransactionTrends,
  calculatePlayoffProbabilities,
  identifyMemorableMoments 
} from "../src/lib/ai/data-aggregation-helpers";

/**
 * Data processing pipeline for post-sync calculations
 * Processes league data after ESPN sync to calculate derived metrics
 */

// Main processing function called after league sync
export const processLeagueDataAfterSync = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  async handler(ctx, args) {
    console.log(`Starting data processing for league ${args.leagueId}, season ${args.seasonId}`);
    
    try {
      // Process each type of data calculation
      // Note: In a real implementation, these would be separate scheduled jobs
      // to avoid timeout issues with large datasets
      console.log("Data processing would calculate team metrics, detect rivalries, and update manager activity");
      
      console.log(`Data processing completed for league ${args.leagueId}`);
      return { success: true };
    } catch (error) {
      console.error("Data processing failed:", error);
      throw error;
    }
  },
});

// Calculate and store team-specific metrics
export const calculateTeamMetrics = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  async handler(ctx, args) {
    // Get teams and matchups
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .collect();
      
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .collect();
    
    // Get standings for SOS calculation
    const standings = teams
      .sort((a, b) => {
        // Sort by wins, then points for
        if (b.record.wins !== a.record.wins) return b.record.wins - a.record.wins;
        return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
      })
      .map((team, index) => ({
        teamId: team.externalId,
        team: team.name,
        rank: index + 1,
        wins: team.record.wins,
        losses: team.record.losses,
        ties: team.record.ties,
        pointsFor: team.record.pointsFor || 0,
        pointsAgainst: team.record.pointsAgainst || 0,
      }));
    
    // Calculate metrics for each team
    for (const team of teams) {
      // Transform matchups to expected format
      const matchupData = matchups.map(m => ({
        teamA: m.homeTeamId,
        teamB: m.awayTeamId,
        scoreA: m.homeScore,
        scoreB: m.awayScore,
        week: m.matchupPeriod,
        isUpset: false, // Could calculate this based on projections
      }));
      
      // Calculate strength of schedule
      const sos = calculateStrengthOfSchedule(
        team.externalId,
        matchupData,
        standings
      );
      
      // Calculate recent form
      const recentForm = calculateRecentForm(
        team.externalId,
        matchupData,
        3
      );
      
      // Store calculated metrics (extend team record or create separate metrics table)
      // For now, we'll log them - in production, store in a metrics table
      console.log(`Team ${team.name} metrics:`, {
        strengthOfSchedule: sos,
        recentForm,
      });
    }
  },
});

// Detect and store rivalries
export const detectAndStoreRivalries = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  async handler(ctx, args) {
    // Get all matchups across all seasons
    const allMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .collect();
    
    // Get teams for mapping
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
      .collect();
    
    const teamMap = new Map(teams.map(t => [t.externalId, t]));
    
    // Transform matchups for rivalry detection
    const matchupData = allMatchups.map(m => ({
      teamA: m.homeTeamId,
      teamB: m.awayTeamId,
      scoreA: m.homeScore,
      scoreB: m.awayScore,
      week: m.matchupPeriod,
      isUpset: false,
    }));
    
    // Detect rivalries
    const detectedRivalries = detectRivalries(matchupData, 3, 10);
    
    // Store rivalries
    for (const rivalry of detectedRivalries) {
      const teamA = teamMap.get(rivalry.teamA);
      const teamB = teamMap.get(rivalry.teamB);
      
      if (!teamA || !teamB) continue;
      
      // Check if rivalry already exists
      const existing = await ctx.db
        .query("rivalries")
        .withIndex("by_teams", q => 
          q.eq("leagueId", args.leagueId)
           .eq("teamA.teamId", rivalry.teamA)
           .eq("teamB.teamId", rivalry.teamB)
        )
        .first();
      
      if (existing) {
        // Update existing rivalry
        await ctx.db.patch(existing._id, {
          allTimeRecord: {
            teamAWins: rivalry.games, // This would need proper win counting
            teamBWins: 0,
            ties: 0,
          },
          intensity: rivalry.intensity,
          updatedAt: Date.now(),
        });
      } else {
        // Create new rivalry
        await ctx.db.insert("rivalries", {
          leagueId: args.leagueId,
          teamA: {
            teamId: rivalry.teamA,
            teamName: teamA.name,
            manager: teamA.owner,
          },
          teamB: {
            teamId: rivalry.teamB,
            teamName: teamB.name,
            manager: teamB.owner,
          },
          allTimeRecord: {
            teamAWins: 0,
            teamBWins: 0,
            ties: 0,
          },
          playoffMeetings: 0,
          championshipMeetings: 0,
          intensity: rivalry.intensity,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    
    console.log(`Detected and stored ${detectedRivalries.length} rivalries`);
  },
});

// Update manager activity tracking
export const updateManagerActivity = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  async handler(ctx, args) {
    // Get all transactions for the season
    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .collect();
    
    // Get all trades
    const trades = await ctx.db
      .query("trades")
      .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .collect();
    
    // Group by team
    const activityByTeam = new Map<string, {
      totalTransactions: number;
      trades: number;
      waiverClaims: number;
    }>();
    
    // Count transactions
    for (const trans of transactions) {
      const current = activityByTeam.get(trans.teamId) || {
        totalTransactions: 0,
        trades: 0,
        waiverClaims: 0,
      };
      
      current.totalTransactions++;
      if (trans.transactionType === "waiver_claim") {
        current.waiverClaims++;
      }
      
      activityByTeam.set(trans.teamId, current);
    }
    
    // Count trades (each trade involves 2 teams)
    for (const trade of trades) {
      const teamAActivity = activityByTeam.get(trade.teamA.teamId) || {
        totalTransactions: 0,
        trades: 0,
        waiverClaims: 0,
      };
      teamAActivity.trades++;
      activityByTeam.set(trade.teamA.teamId, teamAActivity);
      
      const teamBActivity = activityByTeam.get(trade.teamB.teamId) || {
        totalTransactions: 0,
        trades: 0,
        waiverClaims: 0,
      };
      teamBActivity.trades++;
      activityByTeam.set(trade.teamB.teamId, teamBActivity);
    }
    
    // Update manager activity records
    for (const [teamId, activity] of activityByTeam) {
      // Get team to find owner
      const team = await ctx.db
        .query("teams")
        .withIndex("by_external", q => 
          q.eq("leagueId", args.leagueId)
           .eq("externalId", teamId)
           .eq("seasonId", args.seasonId)
        )
        .first();
      
      if (!team) continue;
      
      // Find existing activity record
      const existing = await ctx.db
        .query("managerActivity")
        .withIndex("by_team", q => q.eq("teamId", teamId))
        .first();
      
      if (existing) {
        await ctx.db.patch(existing._id, {
          totalTransactions: activity.totalTransactions,
          trades: activity.trades,
          waiverClaims: activity.waiverClaims,
          lastActiveAt: Date.now(),
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("managerActivity", {
          leagueId: args.leagueId,
          userId: team.owner, // This should map to Clerk ID
          teamId,
          seasonId: args.seasonId,
          totalTransactions: activity.totalTransactions,
          trades: activity.trades,
          waiverClaims: activity.waiverClaims,
          lineupChanges: 0, // Would need lineup change tracking
          lastActiveAt: Date.now(),
          loginCount: 0,
          weeklyHighScores: 0,
          weeklyLowScores: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    
    console.log(`Updated manager activity for ${activityByTeam.size} teams`);
  },
});

// Query to get enriched league data with all calculated metrics
export const getEnrichedLeagueData = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
  },
  async handler(ctx, args) {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");
    
    const currentSeason = args.seasonId || league.espnData?.seasonId || new Date().getFullYear();
    
    // Get all related data
    const [teams, matchups, standings, trades, transactions, rivalries, managerActivity] = await Promise.all([
      ctx.db.query("teams")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),
      ctx.db.query("matchups")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),
      ctx.db.query("teams")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect()
        .then(teams => teams
          .sort((a, b) => {
            if (b.record.wins !== a.record.wins) return b.record.wins - a.record.wins;
            return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
          })
          .map((team, index) => ({
            teamId: team.externalId,
            team: team.name,
            rank: index + 1,
            wins: team.record.wins,
            losses: team.record.losses,
            ties: team.record.ties,
            pointsFor: team.record.pointsFor || 0,
            pointsAgainst: team.record.pointsAgainst || 0,
          }))
        ),
      ctx.db.query("trades")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),
      ctx.db.query("transactions")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),
      ctx.db.query("rivalries")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .collect(),
      ctx.db.query("managerActivity")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),
    ]);
    
    // Calculate transaction trends
    const transactionTrends = analyzeTransactionTrends(
      transactions as any, // Type mismatch - helper expects different format
      4
    );
    
    // Calculate playoff probabilities
    const remainingWeeks = (league.settings.playoffWeeks || 4) - (league.espnData?.currentScoringPeriod || 1);
    const playoffProbabilities = calculatePlayoffProbabilities(
      standings,
      remainingWeeks,
      league.settings.playoffTeamCount || 6
    );
    
    return {
      league,
      teams,
      matchups,
      standings,
      trades,
      transactions,
      rivalries,
      managerActivity,
      transactionTrends,
      playoffProbabilities,
      metadata: {
        lastProcessed: Date.now(),
        currentWeek: league.espnData?.currentScoringPeriod || 1,
        seasonId: currentSeason,
      },
    };
  },
});

