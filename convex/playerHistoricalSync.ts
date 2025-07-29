/* eslint-disable @typescript-eslint/no-explicit-any */
import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";

// Sync all players for the last 10 seasons
export const syncHistoricalPlayers = action({
  args: {
    startYear: v.optional(v.number()),
    endYear: v.optional(v.number()),
    forceUpdate: v.optional(v.boolean()),
  },
  handler: async (ctx, { startYear, endYear, forceUpdate = false }): Promise<{
    status: string;
    message: string;
    results: Array<{
      season: number;
      status: string;
      playersCount?: number;
      message?: string;
      error?: string;
    }>;
  }> => {
    const currentYear = new Date().getFullYear();
    const MIN_SEASON = 2018; // ESPN API limitation
    const start = startYear || Math.max(MIN_SEASON, currentYear - 9); // Default to last 10 years but not before 2018
    const end = endYear || currentYear;
    
    const results = [];
    
    console.log(`Starting historical player sync from ${start} to ${end}`);
    
    // Check if we have any players in the database
    const existingPlayers = await ctx.runQuery(api.playerSyncInternal.getAllPlayersForSeason, {
      season: currentYear
    });
    
    const needsHistoricalSync = existingPlayers.length === 0 || forceUpdate;
    
    if (!needsHistoricalSync) {
      return {
        status: "skipped",
        message: "Players already exist in database, use forceUpdate=true to resync",
        results: []
      };
    }
    
    // Sync each season
    for (let season = start; season <= end; season++) {
      console.log(`Syncing players for ${season} season...`);
      
      try {
        // Use the syncPlayersDefaultStats for each season
        const result = await ctx.runAction(api.playerSync.syncPlayersDefaultStats, {
          season,
          forceUpdate: true // Force update for historical sync
        });
        
        results.push({
          season,
          status: result.status,
          playersCount: result.playersCount,
          message: result.message
        });
        
        // Add a delay between seasons to be nice to ESPN's API
        if (season < end) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        }
      } catch (error) {
        console.error(`Failed to sync ${season} season:`, error);
        results.push({
          season,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    return {
      status: "completed",
      message: `Historical sync completed for ${results.length} seasons`,
      results
    };
  }
});

// Check if historical sync is needed
export const checkHistoricalSyncNeeded = action({
  args: {},
  handler: async (ctx): Promise<{
    needsSync: boolean;
    missingSeasonsCount: number;
    seasons: Array<{
      season: number;
      playerCount: number;
      hasData: boolean;
    }>;
    recommendation: string;
  }> => {
    const currentYear = new Date().getFullYear();
    const MIN_SEASON = 2018; // ESPN API limitation
    const seasons = [];
    
    // Check seasons from 2018 onwards (or last 10 years, whichever is more recent)
    const startSeason = Math.max(MIN_SEASON, currentYear - 9);
    for (let season = startSeason; season <= currentYear; season++) {
      const players = await ctx.runQuery(api.playerSyncInternal.getAllPlayersForSeason, {
        season
      });
      
      seasons.push({
        season,
        playerCount: players.length,
        hasData: players.length > 0
      });
    }
    
    const missingSeasonsCount = seasons.filter(s => !s.hasData).length;
    const needsSync = missingSeasonsCount > 0;
    
    return {
      needsSync,
      missingSeasonsCount,
      seasons,
      recommendation: needsSync 
        ? `Missing data for ${missingSeasonsCount} seasons. Run syncHistoricalPlayers to populate.`
        : "All seasons have player data."
    };
  }
});

// Daily sync for current season (both default and league stats)
export const dailyPlayerSync = action({
  args: {
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, { leagueId }): Promise<{
    status: string;
    season: number;
    results: {
      defaultStats: any;
      leagueStats: any;
    };
    timestamp: number;
    error?: string;
  }> => {
    const currentSeason = new Date().getFullYear();
    const results = {
      defaultStats: null as any,
      leagueStats: null as any,
    };
    
    console.log(`Starting daily player sync for ${currentSeason} season`);
    
    try {
      // 1. Sync default PPR stats from public API
      console.log("Syncing default PPR stats...");
      results.defaultStats = await ctx.runAction(api.playerSync.syncPlayersDefaultStats, {
        season: currentSeason,
        forceUpdate: false // Only sync if not recently synced
      });
      
      // 2. If league ID provided, sync league-specific stats
      if (leagueId) {
        console.log(`Syncing league-specific stats for league ${leagueId}...`);
        
        // Small delay between API calls
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        results.leagueStats = await ctx.runAction(api.playerSync.syncAllLeaguePlayerStats, {
          leagueId,
          season: currentSeason
        });
      }
      
      return {
        status: "success",
        season: currentSeason,
        results,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error("Daily sync failed:", error);
      return {
        status: "failed",
        season: currentSeason,
        error: error instanceof Error ? error.message : String(error),
        results,
        timestamp: Date.now()
      };
    }
  }
});

// Sync all leagues' player stats for current season
export const dailyAllLeaguesPlayerStatsSync = action({
  args: {},
  handler: async (ctx): Promise<{
    status: string;
    message: string;
    totalLeagues: number;
    results: Array<{
      leagueId: string;
      leagueName: string;
      status: string;
      playersProcessed?: number;
      error?: string;
    }>;
    timestamp: number;
  }> => {
    const currentSeason = new Date().getFullYear();
    const results = [];
    
    console.log(`Starting daily sync for all leagues' player stats`);
    
    // Get all active leagues
    const leagues = await ctx.runQuery(api.leagues.listLeagues, {});
    
    if (!leagues || leagues.length === 0) {
      return {
        status: "no_leagues",
        message: "No leagues found to sync",
        totalLeagues: 0,
        results: [],
        timestamp: Date.now()
      };
    }
    
    // Sync each league's player stats
    for (const league of leagues) {
      console.log(`Syncing stats for league: ${league.name} (${league._id})`);
      
      try {
        const result = await ctx.runAction(api.playerSync.syncAllLeaguePlayerStats, {
          leagueId: league._id,
          season: currentSeason
        });
        
        results.push({
          leagueId: league._id,
          leagueName: league.name,
          status: result.status,
          playersProcessed: result.totalPlayersProcessed
        });
        
        // Delay between leagues
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Failed to sync league ${league._id}:`, error);
        results.push({
          leagueId: league._id,
          leagueName: league.name,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    const successCount = results.filter(r => r.status === "success").length;
    const failedCount = results.filter(r => r.status === "failed").length;
    
    return {
      status: "completed",
      message: `Synced ${successCount} leagues successfully, ${failedCount} failed`,
      totalLeagues: leagues.length,
      results,
      timestamp: Date.now()
    };
  }
});

// Initialize player data if empty
export const initializePlayerData = action({
  args: {},
  handler: async (ctx): Promise<{
    status: string;
    message?: string;
    historicalSync?: any;
    syncCheck?: any;
  }> => {
    console.log("Checking if player data initialization is needed...");
    
    // Check if we need historical sync
    const syncCheck = await ctx.runAction(api.playerHistoricalSync.checkHistoricalSyncNeeded, {});
    
    if (!syncCheck.needsSync) {
      return {
        status: "already_initialized",
        message: "Player data already exists for all seasons"
      };
    }
    
    console.log(`Need to sync ${syncCheck.missingSeasonsCount} seasons`);
    
    // Run historical sync
    const historicalResult = await ctx.runAction(api.playerHistoricalSync.syncHistoricalPlayers, {
      forceUpdate: false
    });
    
    return {
      status: "initialized",
      historicalSync: historicalResult,
      syncCheck
    };
  }
});

// Internal action for cron job - daily player sync
export const scheduledDailyPlayerSync = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    console.log("Running scheduled daily player sync...");
    
    // Run the daily sync without a specific league
    return await ctx.runAction(api.playerHistoricalSync.dailyPlayerSync, {});
  }
});

// Sync all historical player stats for a specific league and all its seasons
export const syncHistoricalLeaguePlayerStats = action({
  args: {
    leagueId: v.id("leagues"),
    seasons: v.optional(v.array(v.number())), // If not provided, will sync all seasons the league has
  },
  handler: async (ctx, { leagueId, seasons }): Promise<{
    status: string;
    message: string;
    totalSeasons: number;
    results: Array<{
      season: number;
      status: string;
      playersProcessed?: number;
      error?: string;
    }>;
    timestamp: number;
  }> => {
    console.log(`Starting historical player stats sync for league ${leagueId}`);
    
    // Get league info
    const league = await ctx.runQuery(api.leagues.getById, { id: leagueId });
    if (!league) {
      throw new Error("League not found");
    }
    
    // Determine which seasons to sync
    let seasonsToSync = seasons;
    if (!seasonsToSync) {
      // Get all seasons for this league from teams
      const teams = await ctx.runQuery(api.teams.getByLeague, { leagueId });
      const uniqueSeasons = [...new Set(teams.map((team: any) => team.seasonId))].sort((a, b) => Number(a) - Number(b)) as number[];
      seasonsToSync = uniqueSeasons;
    }
    
    if (!seasonsToSync || seasonsToSync.length === 0) {
      return {
        status: "no_seasons",
        message: "No seasons found for this league",
        totalSeasons: 0,
        results: [],
        timestamp: Date.now()
      };
    }
    
    const results = [];
    let successCount = 0;
    
    // Sync each season's player stats
    for (const season of seasonsToSync) {
      console.log(`Syncing player stats for season ${season}...`);
      
      try {
        // Use the existing syncAllLeaguePlayerStats function
        const result = await ctx.runAction(api.playerSync.syncAllLeaguePlayerStats, {
          leagueId,
          season
        });
        
        results.push({
          season,
          status: result.status,
          playersProcessed: result.totalPlayersProcessed
        });
        
        if (result.status === "success") {
          successCount++;
        }
        
        // Add delay between seasons to avoid rate limiting
        if (season !== seasonsToSync![seasonsToSync!.length - 1]) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error) {
        console.error(`Failed to sync stats for season ${season}:`, error);
        results.push({
          season,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    return {
      status: "completed",
      message: `Synced ${successCount} of ${seasonsToSync!.length} seasons successfully`,
      totalSeasons: seasonsToSync!.length,
      results,
      timestamp: Date.now()
    };
  }
});

// Sync player stats for all leagues and all their historical seasons
export const syncAllLeaguesHistoricalPlayerStats = action({
  args: {},
  handler: async (ctx): Promise<{
    status: string;
    message: string;
    totalLeagues: number;
    totalSeasons: number;
    results: Array<{
      leagueId: string;
      leagueName: string;
      status: string;
      seasonsProcessed?: number;
      error?: string;
    }>;
    timestamp: number;
  }> => {
    console.log("Starting historical player stats sync for all leagues");
    
    // Get all leagues
    const leagues = await ctx.runQuery(api.leagues.listLeagues, {});
    
    if (!leagues || leagues.length === 0) {
      return {
        status: "no_leagues",
        message: "No leagues found to sync",
        totalLeagues: 0,
        totalSeasons: 0,
        results: [],
        timestamp: Date.now()
      };
    }
    
    const results = [];
    let totalSeasons = 0;
    let successfulLeagues = 0;
    
    for (const league of leagues) {
      console.log(`Processing league: ${league.name} (${league._id})`);
      
      try {
        const result = await ctx.runAction(api.playerHistoricalSync.syncHistoricalLeaguePlayerStats, {
          leagueId: league._id
        });
        
        results.push({
          leagueId: league._id,
          leagueName: league.name,
          status: result.status,
          seasonsProcessed: result.totalSeasons
        });
        
        totalSeasons += result.totalSeasons;
        if (result.status === "completed") {
          successfulLeagues++;
        }
        
        // Delay between leagues
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        console.error(`Failed to sync league ${league._id}:`, error);
        results.push({
          leagueId: league._id,
          leagueName: league.name,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    return {
      status: "completed",
      message: `Processed ${successfulLeagues} of ${leagues.length} leagues successfully`,
      totalLeagues: leagues.length,
      totalSeasons,
      results,
      timestamp: Date.now()
    };
  }
});

// Internal action for cron job - all leagues sync
export const scheduledDailyAllLeaguesSync = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    console.log("Running scheduled daily all leagues sync...");
    
    return await ctx.runAction(api.playerHistoricalSync.dailyAllLeaguesPlayerStatsSync, {});
  }
});