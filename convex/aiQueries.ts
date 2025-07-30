import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
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
      leagueSeasons,
      allHistoricalTeams,
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
      
      // Get league seasons for historical data
      ctx.db.query("leagueSeasons")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .order("desc")
        .take(10),
      
      // Get all historical teams for all-time records
      ctx.db.query("teams")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .collect(),
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
    
    // Build previousSeasons data from leagueSeasons and historical teams
    const previousSeasons: Record<number, Array<{
      teamId: string;
      teamName: string;
      manager: string;
      record: { wins: number; losses: number; ties: number; pointsFor?: number; pointsAgainst?: number; };
      roster: Array<{
        playerId: string;
        playerName: string;
        position: string;
        team: string;
        acquisitionType: string;
        fullName?: string;
      }>;
    }>> = {};
    
    // Group historical teams by season (excluding current season)
    const pastSeasons = [...new Set(allHistoricalTeams
      .filter(team => team.seasonId !== currentSeason)
      .map(team => team.seasonId))]
      .sort((a, b) => b - a); // Most recent first
    
    for (const seasonId of pastSeasons) {
      const seasonTeams = allHistoricalTeams.filter(team => team.seasonId === seasonId);
      previousSeasons[seasonId] = seasonTeams.map(team => ({
        teamId: team.externalId,
        teamName: team.name,
        manager: team.owner,
        record: {
          wins: team.record.wins,
          losses: team.record.losses,
          ties: team.record.ties,
          pointsFor: team.record.pointsFor,
          pointsAgainst: team.record.pointsAgainst,
        },
        roster: team.roster.map(player => ({
          playerId: player.playerId,
          playerName: player.playerName,
          position: player.position,
          team: player.team,
          acquisitionType: player.acquisitionType || "UNKNOWN",
          fullName: player.playerName,
        })),
      }));
    }
    
    // Calculate all-time records by externalId (handle string vs number matching)
    const allTimeRecords: Record<string, {
      wins: number;
      losses: number;
      ties: number;
      totalPointsFor: number;
      seasonsPlayed: number;
      championships: number;
      playoffAppearances: number;
    }> = {};
    
    // Initialize with current teams
    teams.forEach(team => {
      allTimeRecords[team.externalId] = {
        wins: 0,
        losses: 0,
        ties: 0,
        totalPointsFor: 0,
        seasonsPlayed: 0,
        championships: 0,
        playoffAppearances: 0,
      };
    });
    
    // Aggregate all historical data by externalId
    allHistoricalTeams.forEach(team => {
      // Handle both string and number external IDs for consistency
      const externalId = String(team.externalId);
      
      if (!allTimeRecords[externalId]) {
        allTimeRecords[externalId] = {
          wins: 0,
          losses: 0,
          ties: 0,
          totalPointsFor: 0,
          seasonsPlayed: 0,
          championships: 0,
          playoffAppearances: 0,
        };
      }
      
      const record = allTimeRecords[externalId];
      record.wins += team.record.wins;
      record.losses += team.record.losses;
      record.ties += team.record.ties;
      record.totalPointsFor += team.record.pointsFor || 0;
      record.seasonsPlayed += 1;
      
      // Check if this team made playoffs (assuming top 6 made playoffs)
      const seasonStandings = allHistoricalTeams
        .filter(t => t.seasonId === team.seasonId)
        .sort((a, b) => {
          if (b.record.wins !== a.record.wins) return b.record.wins - a.record.wins;
          return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
        });
      
      const teamRank = seasonStandings.findIndex(t => t.externalId === team.externalId) + 1;
      const playoffTeams = league.settings?.playoffTeamCount || 6;
      
      if (teamRank <= playoffTeams) {
        record.playoffAppearances += 1;
      }
    });
    
    // Count championships from leagueSeasons
    leagueSeasons.forEach(season => {
      if (season.champion) {
        const championId = String(season.champion.teamId);
        if (allTimeRecords[championId]) {
          allTimeRecords[championId].championships += 1;
        }
      }
    });
    
    // Build championship history from leagueSeasons
    const championshipHistory = leagueSeasons
      .filter(season => season.champion || season.runnerUp || season.regularSeasonChampion)
      .map(season => ({
        seasonId: season.seasonId,
        champion: season.champion,
        runnerUp: season.runnerUp,
        regularSeasonChampion: season.regularSeasonChampion,
        settings: {
          name: season.settings.name,
          size: season.settings.size,
          scoringType: season.settings.scoringType,
        },
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
        externalId: team.externalId, // Important for matching
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
      
      // NEW: Historical data for season welcome packages
      previousSeasons,
      leagueHistory: {
        seasons: championshipHistory,
        allTimeRecords,
      },
      
      metadata: {
        dataFreshness: Date.now(),
        totalTeams: teams.length,
        playoffTeams: league.settings.playoffTeamCount || 6,
        scoringType: league.settings.scoringType,
        historicalSeasons: Object.keys(previousSeasons).length,
        totalHistoricalTeams: allHistoricalTeams.length,
      },
    };
  },
});;

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
      
      const result: any = {
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

// Get season welcome data for AI content generation
export const getSeasonWelcomeDataForAI = query({
  args: {
    leagueId: v.id("leagues"),
  },
  async handler(ctx, args) {
    console.log("=== getSeasonWelcomeDataForAI START ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
      
      // Get all league seasons for historical data
      const leagueSeasons = await ctx.db
        .query("leagueSeasons")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .order("desc")
        .collect();
      
      console.log(`Found ${leagueSeasons.length} seasons for league`);
      
      // Get current season teams
      const currentTeams = await ctx.db
        .query("teams")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .collect();
      
      // Build previous seasons data with teams and rosters
      const previousSeasons: Record<number, Array<{
        teamId: string;
        teamName: string;
        manager: string;
        record: { wins: number; losses: number; ties: number; pointsFor?: number; pointsAgainst?: number; };
        roster: Array<{
          playerId: string;
          playerName: string;
          position: string;
          team: string;
          acquisitionType: string;
          fullName?: string;
        }>;
      }>> = {};
      
      // Fetch teams and rosters for each previous season
      for (const season of leagueSeasons) {
        if (season.seasonId !== currentSeason && season.seasonId) {
          console.log(`Fetching data for season ${season.seasonId}`);
          
          const seasonTeams = await ctx.db
            .query("teams")
            .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", season.seasonId))
            .collect();
          
          console.log(`Found ${seasonTeams.length} teams for season ${season.seasonId}`);
          
          previousSeasons[season.seasonId] = seasonTeams.map(team => ({
            teamId: team.externalId,
            teamName: team.name,
            manager: team.owner || "Unknown",
            record: {
              wins: team.record.wins,
              losses: team.record.losses,
              ties: team.record.ties,
              pointsFor: team.record.pointsFor,
              pointsAgainst: team.record.pointsAgainst,
            },
            roster: team.roster?.map((player: any) => ({
              playerId: player.playerId,
              playerName: player.playerName,
              position: player.position,
              team: player.team,
              acquisitionType: player.acquisitionType || "DRAFT",
              fullName: player.playerName,
            })) || [],
          }));
        }
      }
      
      // Build championship history
      const championshipHistory = leagueSeasons
        .filter(season => season.champion)
        .map(season => ({
          year: season.seasonId,
          champion: season.champion,
          runnerUp: season.runnerUp,
          regularSeasonChampion: season.regularSeasonChampion,
        }));
      
      // Calculate all-time records
      const allTimeRecords: Record<string, any> = {};
      
      // Find most championships
      const championshipCounts: Record<string, number> = {};
      championshipHistory.forEach(season => {
        if (season.champion?.owner) {
          championshipCounts[season.champion.owner] = (championshipCounts[season.champion.owner] || 0) + 1;
        }
      });
      
      const mostChampionships = Object.entries(championshipCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 1);
      
      if (mostChampionships.length > 0) {
        allTimeRecords.mostChampionships = {
          manager: mostChampionships[0][0],
          count: mostChampionships[0][1],
        };
      }
      
      // Get basic league data  
      const basicLeagueData: any = await ctx.runQuery(api.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
      });
      
      const result: any = {
        // Basic league info
        leagueName: league.name,
        currentWeek: basicLeagueData.currentWeek,
        currentSeason,
        teams: currentTeams.map(team => ({
          id: team._id,
          externalId: team.externalId,
          name: team.name,
          manager: team.owner,
          record: team.record,
          pointsFor: team.record.pointsFor || 0,
          pointsAgainst: team.record.pointsAgainst || 0,
          roster: team.roster?.map((player: any) => ({
            playerId: player.playerId,
            playerName: player.playerName,
            position: player.position,
            team: player.team,
            fullName: player.playerName,
            acquisitionType: player.acquisitionType || "DRAFT",
          })) || [],
        })),
        
        // Historical data - CRITICAL for season welcome
        previousSeasons,
        
        // League history
        leagueHistory: {
          foundedYear: Math.min(...leagueSeasons.map(s => s.seasonId).filter(Boolean)),
          totalSeasons: leagueSeasons.length,
          seasons: championshipHistory,
          allTimeRecords,
        },
        
        // Additional context from basic query
        standings: basicLeagueData.standings,
        rivalries: basicLeagueData.rivalries,
        managerActivity: basicLeagueData.managerActivity,
        
        // Required fields for content generation
        recentMatchups: [], // Not needed for season welcome
        trades: [], // Not needed for season welcome
        transactions: [], // Not needed for season welcome
        
        // Settings
        scoringType: league.settings?.scoringType || "PPR",
        rosterSize: league.settings?.rosterSize || 16,
        
        metadata: {
          dataFreshness: Date.now(),
          previousSeasonsCount: Object.keys(previousSeasons).length,
          totalSeasons: leagueSeasons.length,
        },
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getSeasonWelcomeDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Previous seasons fetched:", Object.keys(previousSeasons).length);
      console.log("Championship history entries:", championshipHistory.length);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getSeasonWelcomeDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      throw error;
    }
  },
});

// Get waiver wire data for AI content generation
export const getWaiverWireDataForAI = query({
  args: {
    leagueId: v.id("leagues"),
  },
  async handler(ctx, args) {
    console.log("=== getWaiverWireDataForAI START ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
      const currentWeek = league.espnData?.currentScoringPeriod || 1;
      
      // Get basic league data
      const basicLeagueData: any = await ctx.runQuery(api.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
      });
      
      // Get all rostered players to determine available players
      const allRosteredPlayerIds = new Set<string>();
      basicLeagueData.teams.forEach((team: any) => {
        if (team.roster) {
          team.roster.forEach((player: any) => {
            allRosteredPlayerIds.add(player.playerId);
          });
        }
      });
      
      // Get recent transactions to identify trending players
      const recentTransactions = await ctx.db
        .query("transactions")
        .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
        .order("desc")
        .take(100);
      
      // Track transaction trends
      const transactionCounts: Record<string, number> = {};
      const recentAdds: Array<{
        playerId: string;
        playerName: string;
        position: string;
        date: string;
        teamName: string;
      }> = [];
      
      recentTransactions.forEach(transaction => {
        if (transaction.transactionType === "add" || transaction.transactionType === "add_drop" || transaction.transactionType === "waiver_claim") {
          if (transaction.playerAdded) {
            transactionCounts[transaction.playerAdded.playerId] = 
              (transactionCounts[transaction.playerAdded.playerId] || 0) + 1;
              
            recentAdds.push({
              playerId: transaction.playerAdded.playerId,
              playerName: transaction.playerAdded.playerName,
              position: transaction.playerAdded.position,
              date: new Date(transaction.transactionDate).toISOString(),
              teamName: transaction.teamName,
            });
          }
        }
      });
      
      // Get enhanced player data for available players
      const allPlayersEnhanced = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_season", q => q.eq("season", currentSeason))
        .filter(q => q.gte(q.field("ownership.percentOwned"), 0))
        .take(500); // Get more players to find available ones
      
      // Filter to get available players
      const availablePlayers = allPlayersEnhanced
        .filter(player => {
          // Player is available if not rostered in this league AND ownership < 60%
          const isRostered = allRosteredPlayerIds.has(player.espnId);
          const ownership = player.ownership?.percentOwned || 0;
          return !isRostered && ownership < 60;
        })
        .map(player => ({
          playerId: player.espnId,
          playerName: player.fullName,
          position: player.defaultPositionId,
          proTeam: player.proTeamAbbrev,
          ownership: {
            percentOwned: player.ownership?.percentOwned || 0,
            percentChange: player.ownership?.percentChange || 0,
            percentStarted: player.ownership?.percentStarted || 0,
            averageDraftPosition: player.ownership?.averageDraftPosition,
          },
          injured: player.injured || false,
          injuryStatus: player.injuryStatus,
          seasonOutlook: player.seasonOutlook,
          recentStats: player.stats?.appliedStats ? {
            avgPoints: player.stats.appliedAverage || 0,
            trend: (player.ownership?.percentChange || 0) > 0 ? "rising" : "stable",
          } : undefined,
          projectedStats: player.stats?.appliedStats ? {
            projectedTotal: player.stats.appliedTotal || 0,
            projectedAverage: player.stats.appliedAverage || 0,
          } : undefined,
          transactionCount: transactionCounts[player.espnId] || 0,
        }))
        .sort((a, b) => {
          // Sort by trending (ownership change + transaction count)
          const trendA = (a.ownership.percentChange || 0) + (a.transactionCount * 2);
          const trendB = (b.ownership.percentChange || 0) + (b.transactionCount * 2);
          return trendB - trendA;
        });
      
      const result: any = {
        // Basic league info
        leagueName: league.name,
        currentWeek,
        currentSeason,
        teams: basicLeagueData.teams,
        
        // Waiver wire specific data
        availablePlayers: availablePlayers.slice(0, 100), // Top 100 available players
        
        // Recent transaction activity
        recentAdds: recentAdds.slice(0, 20),
        transactionTrends: basicLeagueData.transactionTrends,
        
        // Team needs analysis data
        standings: basicLeagueData.standings,
        injuryReport: basicLeagueData.teams.flatMap((team: any) => 
          team.roster?.filter((p: any) => p.injuryStatus && p.injuryStatus !== "ACTIVE")
            .map((p: any) => ({
              playerId: p.playerId,
              playerName: p.playerName,
              team: team.name,
              position: p.position,
              status: p.injuryStatus || "QUESTIONABLE",
              fantasyTeam: team.name,
            })) || []
        ).slice(0, 20),
        
        // Required fields for content generation
        recentMatchups: basicLeagueData.recentMatchups.slice(0, 5),
        trades: [],
        transactions: recentTransactions.slice(0, 20).map(t => ({
          teamId: t.teamId,
          teamName: t.teamName,
          type: t.transactionType,
          playerAdded: t.playerAdded,
          playerDropped: t.playerDropped,
          date: new Date(t.transactionDate).toISOString(),
          faabBid: t.faabBid,
        })),
        rivalries: [],
        managerActivity: basicLeagueData.managerActivity,
        
        // Settings
        scoringType: league.settings?.scoringType || "PPR",
        rosterSize: league.settings?.rosterSize || 16,
        
        metadata: {
          dataFreshness: Date.now(),
          availablePlayersCount: availablePlayers.length,
          trendingPlayersCount: availablePlayers.filter(p => p.ownership.percentChange > 5).length,
        },
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getWaiverWireDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Available players found:", availablePlayers.length);
      console.log("Recent transactions:", recentTransactions.length);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getWaiverWireDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      throw error;
    }
  },
});

// Get trade analysis data for AI content generation
export const getTradeAnalysisDataForAI = query({
  args: {
    leagueId: v.id("leagues"),
    tradeId: v.optional(v.id("trades")),
  },
  async handler(ctx, args) {
    console.log("=== getTradeAnalysisDataForAI START ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      const currentSeason = league.espnData?.seasonId || new Date().getFullYear();
      const currentWeek = league.espnData?.currentScoringPeriod || 1;
      
      // Get basic league data
      const basicLeagueData: any = await ctx.runQuery(api.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
      });
      
      // Get specific trade or latest trade
      let targetTrade;
      if (args.tradeId) {
        targetTrade = await ctx.db.get(args.tradeId);
      } else {
        // Get the most recent trade
        const recentTrades = await ctx.db
          .query("trades")
          .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason))
          .order("desc")
          .take(1);
        targetTrade = recentTrades[0];
      }
      
      if (!targetTrade) {
        throw new Error("No trades found for analysis");
      }
      
      // Get detailed team data for both teams in the trade
      const teamAData = basicLeagueData.teams.find((t: any) => 
        t.externalId === targetTrade.teamA.teamId || t.name === targetTrade.teamA.teamName
      );
      const teamBData = basicLeagueData.teams.find((t: any) => 
        t.externalId === targetTrade.teamB.teamId || t.name === targetTrade.teamB.teamName
      );
      
      // Get enhanced player data for traded players
      const allTradedPlayerIds = [
        ...targetTrade.playersFromTeamA.map((p: any) => p.playerId),
        ...targetTrade.playersFromTeamB.map((p: any) => p.playerId),
      ];
      
      const tradedPlayersEnhanced = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_season", q => q.eq("season", currentSeason))
        .filter(q => q.or(...allTradedPlayerIds.map(id => q.eq(q.field("espnId"), id))))
        .collect();
      
      // Map enhanced data to traded players
      const enhancedPlayersFromA = targetTrade.playersFromTeamA.map((player: any) => {
        const enhanced = tradedPlayersEnhanced.find(p => p.espnId === player.playerId);
        return {
          ...player,
          seasonStats: enhanced?.stats ? {
            totalPoints: enhanced.stats.appliedTotal || 0,
            averagePoints: enhanced.stats.appliedAverage || 0,
            gamesPlayed: enhanced.stats.appliedStats ? Object.keys(enhanced.stats.appliedStats).length : 0,
          } : undefined,
          seasonOutlook: enhanced?.seasonOutlook,
          injuryStatus: enhanced?.injuryStatus,
          ownership: enhanced?.ownership,
          recentTrend: enhanced?.ownership?.percentChange ? 
            (enhanced.ownership.percentChange > 0 ? "rising" : "falling") : "stable",
        };
      });
      
      const enhancedPlayersFromB = targetTrade.playersFromTeamB.map((player: any) => {
        const enhanced = tradedPlayersEnhanced.find(p => p.espnId === player.playerId);
        return {
          ...player,
          seasonStats: enhanced?.stats ? {
            totalPoints: enhanced.stats.appliedTotal || 0,
            averagePoints: enhanced.stats.appliedAverage || 0,
            gamesPlayed: enhanced.stats.appliedStats ? Object.keys(enhanced.stats.appliedStats).length : 0,
          } : undefined,
          seasonOutlook: enhanced?.seasonOutlook,
          injuryStatus: enhanced?.injuryStatus,
          ownership: enhanced?.ownership,
          recentTrend: enhanced?.ownership?.percentChange ? 
            (enhanced.ownership.percentChange > 0 ? "rising" : "falling") : "stable",
        };
      });
      
      // Calculate position depth for both teams
      const calculatePositionDepth = (roster: any[]) => {
        const depth: Record<string, number> = {};
        roster?.forEach(player => {
          const pos = player.position.replace(/[0-9]/g, '');
          depth[pos] = (depth[pos] || 0) + 1;
        });
        return depth;
      };
      
      const teamADepthBefore = calculatePositionDepth(teamAData?.roster || []);
      const teamBDepthBefore = calculatePositionDepth(teamBData?.roster || []);
      
      // Calculate depth after trade
      const teamADepthAfter = { ...teamADepthBefore };
      const teamBDepthAfter = { ...teamBDepthBefore };
      
      enhancedPlayersFromA.forEach(player => {
        const pos = player.position.replace(/[0-9]/g, '');
        teamADepthAfter[pos] = Math.max(0, (teamADepthAfter[pos] || 0) - 1);
        teamBDepthAfter[pos] = (teamBDepthAfter[pos] || 0) + 1;
      });
      
      enhancedPlayersFromB.forEach(player => {
        const pos = player.position.replace(/[0-9]/g, '');
        teamBDepthAfter[pos] = Math.max(0, (teamBDepthAfter[pos] || 0) - 1);
        teamADepthAfter[pos] = (teamADepthAfter[pos] || 0) + 1;
      });
      
      // Get recent performance for both teams
      const teamARecentMatchups = basicLeagueData.recentMatchups.filter((m: any) => 
        m.teamAName === targetTrade.teamA.teamName || m.teamBName === targetTrade.teamA.teamName
      ).slice(0, 3);
      
      const teamBRecentMatchups = basicLeagueData.recentMatchups.filter((m: any) => 
        m.teamAName === targetTrade.teamB.teamName || m.teamBName === targetTrade.teamB.teamName
      ).slice(0, 3);
      
      const result: any = {
        // Basic league info
        leagueName: league.name,
        currentWeek,
        currentSeason,
        teams: basicLeagueData.teams,
        
        // Trade specific data
        trades: [{
          ...targetTrade,
          teamAData: {
            team: teamAData,
            depthBefore: teamADepthBefore,
            depthAfter: teamADepthAfter,
            recentMatchups: teamARecentMatchups,
            playoffPosition: basicLeagueData.standings.find((s: any) => s.teamId === targetTrade.teamA.teamId)?.playoffSeed,
          },
          teamBData: {
            team: teamBData,
            depthBefore: teamBDepthBefore,
            depthAfter: teamBDepthAfter,
            recentMatchups: teamBRecentMatchups,
            playoffPosition: basicLeagueData.standings.find((s: any) => s.teamId === targetTrade.teamB.teamId)?.playoffSeed,
          },
          enhancedPlayersFromA,
          enhancedPlayersFromB,
        }],
        
        // Context data
        standings: basicLeagueData.standings,
        playoffProbabilities: basicLeagueData.playoffProbabilities,
        
        // Required fields for content generation
        recentMatchups: basicLeagueData.recentMatchups.slice(0, 10),
        transactions: basicLeagueData.transactions.slice(0, 10),
        rivalries: basicLeagueData.rivalries,
        managerActivity: basicLeagueData.managerActivity,
        
        // Settings
        scoringType: league.settings?.scoringType || "PPR",
        rosterSize: league.settings?.rosterSize || 16,
        playoffTeams: league.settings?.playoffTeamCount || 6,
        
        metadata: {
          dataFreshness: Date.now(),
          tradeDate: targetTrade.tradeDate,
          daysAgo: Math.floor((Date.now() - targetTrade.tradeDate) / (1000 * 60 * 60 * 24)),
        },
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getTradeAnalysisDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Trade analyzed:", targetTrade._id);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getTradeAnalysisDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      throw error;
    }
  },
});