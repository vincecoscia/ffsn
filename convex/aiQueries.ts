import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { 
  calculateStrengthOfSchedule, 
  calculateRecentForm,
  analyzeTransactionTrends,
  calculatePlayoffProbabilities,
  identifyMemorableMoments 
} from "../src/lib/ai/data-aggregation-helpers";

/**
 * Enhanced query functions for AI content generation
 * These queries provide all the enriched data needed for accurate article generation
 */

// Get comprehensive league data for AI content generation
export const getLeagueDataForAI = query({
  args: {
    leagueId: v.id("leagues"),
    currentWeek: v.optional(v.number()),
  },
  async handler(ctx, args) {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");
    
    const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
    const currentWeek = args.currentWeek || league.espnData?.currentScoringPeriod || 1;
    
    // Fetch all data in parallel
    const [
      teams,
      matchups,
      recentMatchups,
      trades,
      transactions,
      rivalries,
      managerActivity,
      playersEnhanced,
    ] = await Promise.all([
      // Get all teams with roster
      ctx.db.query("teams")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),
      
      // Get all matchups
      ctx.db.query("matchups")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),
      
      // Get recent matchups (last 3 weeks)
      ctx.db.query("matchups")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .filter(q => q.gte(q.field("matchupPeriod"), Math.max(1, currentWeek - 3)))
        .collect(),
      
      // Get recent trades
      ctx.db.query("trades")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .order("desc")
        .take(20),
      
      // Get recent transactions
      ctx.db.query("transactions")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .order("desc")
        .take(50),
      
      // Get rivalries
      ctx.db.query("rivalries")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .collect(),
      
      // Get manager activity
      ctx.db.query("managerActivity")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect(),
      
      // Get player data for rosters
      ctx.db.query("playersEnhanced")
        .withIndex("by_espn_id_season")
        .take(1000), // Get a sample of players for now
    ]);
    
    // Calculate standings
    const standings = teams
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
        playoffSeed: team.record.playoffSeed,
      }));
    
    // Enhance team data with calculated metrics
    const enhancedTeams = teams.map(team => {
      // Transform matchups for calculations
      const matchupData = matchups.map(m => ({
        teamA: m.homeTeamId,
        teamB: m.awayTeamId,
        scoreA: m.homeScore,
        scoreB: m.awayScore,
        week: m.matchupPeriod,
        projectedScoreA: m.homeProjectedScore,
        projectedScoreB: m.awayProjectedScore,
        isUpset: false,
      }));
      
      // Calculate metrics
      const strengthOfSchedule = calculateStrengthOfSchedule(
        team.externalId,
        matchupData,
        standings
      );
      
      const recentForm = calculateRecentForm(
        team.externalId,
        matchupData,
        3
      );
      
      // Find playoff seed
      const standing = standings.find(s => s.teamId === team.externalId);
      const playoffSeed = standing?.playoffSeed || standing?.rank;
      
      return {
        id: team._id,
        name: team.name,
        owner: team.owner,
        logo: team.logo,
        abbreviation: team.abbreviation,
        record: team.record,
        roster: team.roster,
        playoffSeed,
        strengthOfSchedule,
        recentForm,
        benchPoints: 0, // Would calculate from roster data
        divisionRecord: team.record.divisionRecord,
      };
    });
    
    // Transform recent matchups with memorable moments
    const enrichedMatchups = recentMatchups.map(matchup => {
      const homeTeam = teams.find(t => t.externalId === matchup.homeTeamId);
      const awayTeam = teams.find(t => t.externalId === matchup.awayTeamId);
      
      const matchupData = {
        teamA: matchup.homeTeamId,
        teamB: matchup.awayTeamId,
        scoreA: matchup.homeScore,
        scoreB: matchup.awayScore,
        week: matchup.matchupPeriod,
        projectedScoreA: matchup.homeProjectedScore,
        projectedScoreB: matchup.awayProjectedScore,
        isUpset: matchup.homeProjectedScore && matchup.awayProjectedScore
          ? (matchup.homeProjectedScore > matchup.awayProjectedScore && matchup.awayScore > matchup.homeScore) ||
            (matchup.awayProjectedScore > matchup.homeProjectedScore && matchup.homeScore > matchup.awayScore)
          : false,
        benchPointsA: 0, // Would calculate
        benchPointsB: 0, // Would calculate
      };
      
      const memorableMoment = identifyMemorableMoments(matchupData);
      
      return {
        ...matchup,
        teamAName: homeTeam?.name || "Unknown",
        teamBName: awayTeam?.name || "Unknown",
        memorableMoment,
        isUpset: matchupData.isUpset,
      };
    });
    
    // Analyze transaction trends
    const transactionTrends = analyzeTransactionTrends(
      transactions as any // Type mismatch - helper expects different format
    );
    
    // Calculate playoff probabilities
    const remainingWeeks = league.settings.regularSeasonMatchupPeriods 
      ? league.settings.regularSeasonMatchupPeriods - currentWeek
      : 13 - currentWeek;
    const playoffProbabilities = calculatePlayoffProbabilities(
      standings,
      remainingWeeks,
      league.settings.playoffTeamCount || 6
    );
    
    // Format trades with analysis
    const enrichedTrades = trades.map(trade => ({
      ...trade,
      daysAgo: Math.floor((Date.now() - trade.tradeDate) / (1000 * 60 * 60 * 24)),
    }));
    
    // Format rivalries with recent matchups
    const enrichedRivalries = rivalries.map(rivalry => {
      const recentGames = matchups.filter(m => 
        (m.homeTeamId === rivalry.teamA.teamId && m.awayTeamId === rivalry.teamB.teamId) ||
        (m.homeTeamId === rivalry.teamB.teamId && m.awayTeamId === rivalry.teamA.teamId)
      ).slice(-3);
      
      return {
        ...rivalry,
        recentGames: recentGames.map(game => ({
          week: game.matchupPeriod,
          teamAScore: game.homeTeamId === rivalry.teamA.teamId ? game.homeScore : game.awayScore,
          teamBScore: game.homeTeamId === rivalry.teamB.teamId ? game.homeScore : game.awayScore,
          winner: game.homeScore > game.awayScore 
            ? (game.homeTeamId === rivalry.teamA.teamId ? "teamA" : "teamB")
            : (game.homeTeamId === rivalry.teamA.teamId ? "teamB" : "teamA"),
        })),
      };
    });
    
    // Get league history if available
    const leagueSeasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(5);
    
    return {
      league: {
        id: league._id,
        name: league.name,
        settings: league.settings,
        espnData: league.espnData,
      },
      currentWeek,
      currentSeason,
      teams: enhancedTeams,
      standings,
      recentMatchups: enrichedMatchups,
      trades: enrichedTrades,
      transactions: transactions.slice(0, 20), // Most recent 20
      rivalries: enrichedRivalries,
      managerActivity,
      transactionTrends,
      playoffProbabilities,
      leagueHistory: leagueSeasons.map(season => ({
        seasonId: season.seasonId,
        champion: season.champion,
        runnerUp: season.runnerUp,
        regularSeasonChampion: season.regularSeasonChampion,
      })),
      metadata: {
        dataFreshness: Date.now(),
        totalTeams: teams.length,
        playoffTeams: league.settings.playoffTeamCount || 6,
        scoringType: league.settings.scoringType,
      },
    };
  },
});

// Get specific matchup data for detailed analysis
export const getMatchupDataForAI = query({
  args: {
    leagueId: v.id("leagues"),
    week: v.number(),
    teamAId: v.string(),
    teamBId: v.string(),
  },
  async handler(ctx, args) {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");
    
    const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
    
    // Get the specific matchup
    const matchup = await ctx.db
      .query("matchups")
      .withIndex("by_unique_matchup", q => 
        q.eq("leagueId", args.leagueId)
         .eq("seasonId", currentSeason)
         .eq("matchupPeriod", args.week)
         .eq("homeTeamId", args.teamAId)
         .eq("awayTeamId", args.teamBId)
      )
      .first();
    
    if (!matchup) {
      // Try reversed
      const reversedMatchup = await ctx.db
        .query("matchups")
        .withIndex("by_unique_matchup", q => 
          q.eq("leagueId", args.leagueId)
           .eq("seasonId", currentSeason)
           .eq("matchupPeriod", args.week)
           .eq("homeTeamId", args.teamBId)
           .eq("awayTeamId", args.teamAId)
        )
        .first();
      
      if (!reversedMatchup) throw new Error("Matchup not found");
      
      // Return with teams in requested order
      return {
        ...reversedMatchup,
        homeTeamId: args.teamAId,
        awayTeamId: args.teamBId,
        homeScore: reversedMatchup.awayScore,
        awayScore: reversedMatchup.homeScore,
        homeProjectedScore: reversedMatchup.awayProjectedScore,
        awayProjectedScore: reversedMatchup.homeProjectedScore,
      };
    }
    
    return matchup;
  },
});

// Get player performance data for a specific week
export const getWeeklyPlayerDataForAI = query({
  args: {
    leagueId: v.id("leagues"),
    week: v.number(),
  },
  async handler(ctx, args) {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");
    
    const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
    
    // Get all teams for the week
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
      .collect();
    
    // Collect all players with their weekly performance
    const allPlayers: Array<{
      playerName: string;
      position: string;
      team: string;
      fantasyTeam: string;
      points: number;
      projected: number;
      started: boolean;
    }> = [];
    
    teams.forEach(team => {
      team.roster.forEach(player => {
        if (player.playerStats?.appliedTotal !== undefined) {
          allPlayers.push({
            playerName: player.playerName,
            position: player.position,
            team: player.team,
            fantasyTeam: team.name,
            points: player.playerStats.appliedTotal,
            projected: player.playerStats.projectedTotal || 0,
            started: player.lineupSlotId !== undefined && player.lineupSlotId < 20,
          });
        }
      });
    });
    
    // Sort by points and get top performers
    const topPerformers = allPlayers
      .filter(p => p.started)
      .sort((a, b) => b.points - a.points)
      .slice(0, 20);
    
    // Get biggest busts (underperformed projections)
    const biggestBusts = allPlayers
      .filter(p => p.started && p.projected > 10)
      .map(p => ({ ...p, differential: p.points - p.projected }))
      .sort((a, b) => a.differential - b.differential)
      .slice(0, 10);
    
    // Get best bench performances
    const bestBenchPerformances = allPlayers
      .filter(p => !p.started)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    
    return {
      week: args.week,
      topPerformers,
      biggestBusts,
      bestBenchPerformances,
      totalPlayers: allPlayers.length,
    };
  },
});

// Get mock draft data for AI content generation
export const getMockDraftDataForAI = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
  },
  async handler(ctx, args) {
    console.log("=== getMockDraftDataForAI START (OPTIMIZED V2) ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      const targetSeason = args.seasonId || league.espnData?.seasonId || new Date().getFullYear();
      console.log("Target season:", targetSeason);
    
      // Get league season data for draft information
      const leagueSeason = await ctx.db
        .query("leagueSeasons")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", targetSeason))
        .first();
      
      if (!leagueSeason) {
        console.log("No league season found, returning minimal mock data");
        return createMinimalMockDraftData(league.name, targetSeason, league.settings);
      }
      
      // Get teams (limit to avoid timeout)
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", targetSeason))
        .take(12); // Limit to 12 teams max
      
      console.log(`Found ${teams.length} teams for season ${targetSeason}`);
      
      // Fetch top 50 players with enhanced data
      console.log("Fetching player data for mock draft...");
      let topPlayers: any[] = [];
      
      try {
        // Get top 50 players by season
        const allPlayers = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_season", q => q.eq("season", targetSeason))
          .take(200); // Larger batch to ensure we get enough players
        
        // Filter and sort - only players with valid ADP
        topPlayers = allPlayers
          .filter(p => {
            const adp = p.ownership?.averageDraftPosition;
            return adp && adp > 0 && adp <= 100; // Top 100 ADP to ensure we get 50
          })
          .sort((a, b) => (a.ownership?.averageDraftPosition || 999) - (b.ownership?.averageDraftPosition || 999))
          .slice(0, 50); // Top 50 players
          
        console.log("Found", topPlayers.length, "top players");
      } catch (error) {
        console.log("Player query failed, using minimal fallback:", error);
        topPlayers = []; // Continue with empty players
      }
      
      // Create enhanced player data with seasonOutlook and projected stats
      const draftablePlayers = topPlayers.length > 0 
        ? topPlayers.map(player => {
            // Get 2025 projected stats (find the entry with externalId "2025" and statSourceId 1)
            const projectedStats = player.stats && Array.isArray(player.stats) 
              ? player.stats.find((stat: any) => 
                  stat.externalId === "2025" && 
                  stat.statSourceId === 1 && 
                  stat.appliedTotal > 0
                )
              : null;
            
            const projectedData = projectedStats
              ? {
                  projectedTotal: projectedStats.appliedTotal || 0,
                  projectedAverage: projectedStats.appliedAverage || 0
                }
              : null;
            
            return {
              playerId: player.espnId,
              playerName: player.fullName,
              position: player.defaultPosition,
              proTeam: player.proTeamAbbrev || "",
              seasonOutlook: player.seasonOutlook || "",
              projectedStats: projectedData,
              ownership: {
                averageDraftPosition: player.ownership?.averageDraftPosition || 0,
              },
            };
          })
        : [
            { playerId: "1", playerName: "CeeDee Lamb", position: "WR", proTeam: "DAL", ownership: { averageDraftPosition: 3.5 } },
            { playerId: "2", playerName: "Christian McCaffrey", position: "RB", proTeam: "SF", ownership: { averageDraftPosition: 1.2 } },
            { playerId: "3", playerName: "Tyreek Hill", position: "WR", proTeam: "MIA", ownership: { averageDraftPosition: 2.8 } },
          ];
      
      // Extract draft order (simplified)
      let draftOrder: Array<{ position: number; teamId: string; teamName: string; manager: string }> = [];
      if (leagueSeason.draftSettings?.pickOrder && teams.length > 0) {
        // pickOrder contains numbers, but externalId is stored as string
        draftOrder = leagueSeason.draftSettings.pickOrder.slice(0, teams.length).map((teamIdNum: number, index: number) => {
          const teamIdStr = String(teamIdNum);
          const team = teams.find(t => t.externalId === teamIdStr);
          return {
            position: index + 1,
            teamId: teamIdStr,
            teamName: team?.name || `Team ${index + 1}`,
            manager: team?.owner || "Unknown",
          };
        });
      } else if (teams.length > 0) {
        // If no draft order is set, create one based on available teams
        draftOrder = teams.map((team, index) => ({
          position: index + 1,
          teamId: team.externalId,
          teamName: team.name,
          manager: team.owner || "Unknown",
        }));
      }
      
      const result = {
        leagueName: league.name,
        seasonId: targetSeason,
        draftOrder,
        draftType: leagueSeason.draftSettings?.type === "AUCTION" ? "Auction" : "Snake",
        leagueType: leagueSeason.draft?.some(pick => pick.keeper) ? "Keeper" : "Redraft",
        scoringType: league.settings.scoringType,
        rosterSize: league.settings.rosterSize,
        totalTeams: teams.length,
        teams: teams.map(team => ({
          id: team._id,
          externalId: team.externalId,
          name: team.name,
          manager: team.owner,
          draftPosition: draftOrder.findIndex(d => d.teamId === team.externalId) + 1,
        })),
        availablePlayers: draftablePlayers,
        playerCount: draftablePlayers.length,
        metadata: {
          dataFreshness: Date.now(),
          draftablePlayersCount: draftablePlayers.length,
        },
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getMockDraftDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Players returned:", result.availablePlayers.length);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getMockDraftDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      
      // Return minimal fallback data
      return createMinimalMockDraftData("Mock League", new Date().getFullYear(), {
        scoringType: "PPR",
        rosterSize: 16,
      });
    }
  },
});

// Helper function to create minimal mock draft data
function createMinimalMockDraftData(
  leagueName: string, 
  seasonId: number, 
  settings: any
) {
  return {
    leagueName,
    seasonId,
    draftOrder: [],
    draftType: "Snake",
    leagueType: "Redraft",
    scoringType: settings?.scoringType || "PPR",
    rosterSize: settings?.rosterSize || 16,
    totalTeams: 10,
    teams: [],
    availablePlayers: [
      {
        playerId: "sample1",
        playerName: "CeeDee Lamb",
        position: "WR",
        proTeam: "DAL",
        ownership: {
          averageDraftPosition: 3.5,
          auctionValueAverage: 55,
        },
      },
      {
        playerId: "sample2",
        playerName: "Christian McCaffrey",
        position: "RB",
        proTeam: "SF",
        ownership: {
          averageDraftPosition: 1.2,
          auctionValueAverage: 65,
        },
      },
    ],
    playerCount: 2,
    metadata: {
      dataFreshness: Date.now(),
      draftablePlayersCount: 2,
    },
  };
};