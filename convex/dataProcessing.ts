import { v } from "convex/values";
import { mutation, internalMutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
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

// Public mutation to trigger data processing
export const runDataProcessing = mutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  async handler(ctx, args) {
    console.log(`Triggering data processing for league ${args.leagueId}, season ${args.seasonId}`);
    
    // Log available seasons for debugging
    const allSeasons = await ctx.db
      .query("teams")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
      .collect();
    const uniqueSeasons = [...new Set(allSeasons.map(t => t.seasonId))].sort();
    console.log(`Found ${uniqueSeasons.length} historical seasons:`, uniqueSeasons);
    
    try {
      // Run the processing directly
      // In a production environment, you might want to use ctx.scheduler
      // to run this asynchronously
      await ctx.runMutation(api.dataProcessing.calculateTeamMetrics, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
      });
      
      await ctx.runMutation(api.dataProcessing.detectAndStoreRivalries, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
      });
      
      await ctx.runMutation(api.dataProcessing.updateManagerActivity, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
      });
      
      return { success: true };
    } catch (error) {
      console.error("Failed to trigger data processing:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  },
});

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
export const calculateTeamMetrics = mutation({
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
export const detectAndStoreRivalries = mutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  async handler(ctx, args) {
    // Get all matchups across ALL seasons for this league
    // We need to use by_league_period index since by_league_season requires both leagueId and seasonId
    const allMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_period", q => q.eq("leagueId", args.leagueId))
      .collect();
    
    console.log(`Found ${allMatchups.length} total matchups across all seasons for rivalry detection`);
    
    // Get current season teams for metadata
    const currentTeams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .collect();
    
    // Create map of externalId to current team info
    const teamMap = new Map(currentTeams.map(t => [t.externalId, t]));
    
    // Transform matchups for rivalry detection, filtering out games where either team scored 0
    const matchupData = allMatchups
      .filter(m => m.homeScore > 0 && m.awayScore > 0)
      .map(m => ({
        teamA: m.homeTeamId,
        teamB: m.awayTeamId,
        scoreA: m.homeScore,
        scoreB: m.awayScore,
        week: m.matchupPeriod,
        isUpset: false,
      }));
    
    // Detect rivalries with minimum 3 games and closeness factor
    const detectedRivalries = detectRivalries(matchupData, 3, 10);
    
    // Calculate detailed rivalry statistics
    for (const rivalry of detectedRivalries) {
      const teamA = teamMap.get(rivalry.teamA);
      const teamB = teamMap.get(rivalry.teamB);
      
      if (!teamA || !teamB) {
        console.log(`Skipping rivalry - team not found in current season: ${rivalry.teamA} vs ${rivalry.teamB}`);
        continue;
      }
      
      // Calculate head-to-head record
      let teamAWins = 0;
      let teamBWins = 0;
      let ties = 0;
      let playoffMeetings = 0;
      let championshipMeetings = 0;
      const notableGames: any[] = [];
      
      // Filter matchups for this specific rivalry, excluding games where either team scored 0
      const rivalryMatchups = allMatchups.filter(m => 
        ((m.homeTeamId === rivalry.teamA && m.awayTeamId === rivalry.teamB) ||
        (m.homeTeamId === rivalry.teamB && m.awayTeamId === rivalry.teamA)) &&
        m.homeScore > 0 && m.awayScore > 0
      );
      
      for (const matchup of rivalryMatchups) {
        // Determine winner
        if (matchup.homeScore > matchup.awayScore) {
          if (matchup.homeTeamId === rivalry.teamA) teamAWins++;
          else teamBWins++;
        } else if (matchup.awayScore > matchup.homeScore) {
          if (matchup.awayTeamId === rivalry.teamA) teamAWins++;
          else teamBWins++;
        } else {
          ties++;
        }
        
        // Track playoff/championship games
        if (matchup.playoffTier) {
          playoffMeetings++;
          if (matchup.playoffTier === "CHAMPIONSHIP") {
            championshipMeetings++;
          }
          
          // Add to notable games
          notableGames.push({
            seasonId: matchup.seasonId,
            week: matchup.matchupPeriod,
            teamAScore: matchup.homeTeamId === rivalry.teamA ? matchup.homeScore : matchup.awayScore,
            teamBScore: matchup.homeTeamId === rivalry.teamB ? matchup.homeScore : matchup.awayScore,
            significance: matchup.playoffTier === "CHAMPIONSHIP" ? "Championship" : "Playoff",
            description: `${matchup.seasonId} ${matchup.playoffTier}`,
          });
        }
      }
      
      // Check if rivalry already exists (check both directions)
      const existing = await ctx.db
        .query("rivalries")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .collect()
        .then(rivalries => rivalries.find(r => 
          (r.teamA.teamId === rivalry.teamA && r.teamB.teamId === rivalry.teamB) ||
          (r.teamA.teamId === rivalry.teamB && r.teamB.teamId === rivalry.teamA)
        ));
      
      if (existing) {
        // Update existing rivalry
        await ctx.db.patch(existing._id, {
          allTimeRecord: {
            teamAWins: existing.teamA.teamId === rivalry.teamA ? teamAWins : teamBWins,
            teamBWins: existing.teamA.teamId === rivalry.teamA ? teamBWins : teamAWins,
            ties,
          },
          playoffMeetings,
          championshipMeetings,
          notableGames: notableGames.length > 0 ? notableGames : undefined,
          intensity: rivalry.intensity,
          updatedAt: Date.now(),
        });
        console.log(`Updated rivalry: ${teamA.name} vs ${teamB.name}`);
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
            teamAWins,
            teamBWins,
            ties,
          },
          playoffMeetings,
          championshipMeetings,
          notableGames: notableGames.length > 0 ? notableGames : undefined,
          intensity: rivalry.intensity,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        console.log(`Created new rivalry: ${teamA.name} vs ${teamB.name} (${teamAWins}-${teamBWins}-${ties})`);
      }
    }
    
    console.log(`Detected and stored ${detectedRivalries.length} rivalries`);
  },
});

// Update manager activity tracking
export const updateManagerActivity = mutation({
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
      transactions as any // Type mismatch - helper expects different format
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

