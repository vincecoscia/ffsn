import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { transformStats } from "./espnStatsMapping";

// Helper function to process and transform player stats
const processPlayerStats = (stats: any[] | undefined, scoringPeriodId: number = 0) => {
  if (!stats || !Array.isArray(stats)) {
    return {
      actualStats: undefined,
      projectedStats: undefined,
    };
  }

  // Find actual stats (statSourceId: 0) and projected stats (statSourceId: 1) for the specified scoring period
  const actualStatsEntry = stats.find((stat: any) => stat.statSourceId === 0 && stat.scoringPeriodId === scoringPeriodId);
  const projectedStatsEntry = stats.find((stat: any) => stat.statSourceId === 1 && stat.scoringPeriodId === scoringPeriodId);

  return {
    actualStats: transformStats(actualStatsEntry?.stats),
    projectedStats: transformStats(projectedStatsEntry?.stats),
  };
};

// Mutations
export const upsertPlayersBatch = mutation({
  args: {
    season: v.number(),
    players: v.array(v.object({
      espnId: v.string(),
      season: v.number(),
      fullName: v.string(),
      firstName: v.optional(v.string()),
      lastName: v.optional(v.string()),
      defaultPositionId: v.number(),
      defaultPosition: v.string(),
      eligibleSlots: v.array(v.number()),
      eligiblePositions: v.array(v.string()),
      proTeamId: v.number(),
      proTeamAbbrev: v.optional(v.string()),
      active: v.boolean(),
      injured: v.boolean(),
      injuryStatus: v.optional(v.string()),
      droppable: v.boolean(),
      universeId: v.optional(v.number()),
      ownership: v.object({
        percentOwned: v.number(),
        percentStarted: v.number(),
        percentChange: v.optional(v.number()),
        auctionValueAverage: v.optional(v.number()),
        averageDraftPosition: v.optional(v.number()),
      }),
      jersey: v.optional(v.string()),
      seasonOutlook: v.optional(v.string()),
      stats: v.optional(v.any()),
      actualStats: v.optional(v.any()),
      projectedStats: v.optional(v.any()),
      draftRanksByRankType: v.optional(v.any()),
    })),
  },
  handler: async (ctx, { players }) => {
    const now = Date.now();
    
    for (const player of players) {
      // Process stats if transformed fields aren't provided
      let processedPlayer = { ...player };
      if (!player.actualStats && !player.projectedStats && player.stats) {
        const processed = processPlayerStats(player.stats);
        processedPlayer.actualStats = processed.actualStats;
        processedPlayer.projectedStats = processed.projectedStats;
      }
      
      // Check if player exists
      const existing = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_espn_id_season", (q) => 
          q.eq("espnId", processedPlayer.espnId).eq("season", processedPlayer.season)
        )
        .first();
      
      if (existing) {
        // Update existing player
        await ctx.db.patch(existing._id, {
          ...processedPlayer,
          updatedAt: now,
        });
      } else {
        // Insert new player
        await ctx.db.insert("playersEnhanced", {
          ...processedPlayer,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  },
});

export const updateLeaguePlayerStatuses = mutation({
  args: {
    updates: v.array(v.object({
      leagueId: v.id("leagues"),
      playerId: v.string(),
      season: v.number(),
      status: v.union(v.literal("owned"), v.literal("free_agent"), v.literal("waivers"), v.literal("cant_drop")),
      teamExternalId: v.optional(v.string()),
      lineupSlotId: v.optional(v.number()),
      acquisitionType: v.optional(v.string()),
      acquisitionDate: v.optional(v.number()),
      onWaivers: v.boolean(),
      tradeLocked: v.boolean(),
      keeperValue: v.optional(v.number()),
      keeperValueFuture: v.optional(v.number()),
      draftAuctionValue: v.optional(v.number()),
    })),
  },
  handler: async (ctx, { updates }) => {
    const now = Date.now();
    
    for (const update of updates) {
      // Find team by external ID if owned
      let teamId = undefined;
      if (update.teamExternalId) {
        const team = await ctx.db
          .query("teams")
          .withIndex("by_league", (q) => q.eq("leagueId", update.leagueId))
          .filter((q) => q.eq(q.field("externalId"), update.teamExternalId))
          .first();
        
        teamId = team?._id;
      }
      
      // Check if status exists
      const existing = await ctx.db
        .query("leaguePlayerStatus")
        .withIndex("by_league_player", (q) => 
          q.eq("leagueId", update.leagueId).eq("playerId", update.playerId)
        )
        .first();
      
      const statusData = {
        ...update,
        teamId,
        updatedAt: now,
      };
      
      if (existing) {
        await ctx.db.patch(existing._id, statusData);
      } else {
        await ctx.db.insert("leaguePlayerStatus", statusData);
      }
    }
  },
});

export const updateSyncStatus = mutation({
  args: {
    season: v.number(),
    status: v.union(v.literal("syncing"), v.literal("completed"), v.literal("failed")),
    type: v.string(),
    playersProcessed: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("playerSyncStatus")
      .withIndex("by_type_season", (q) => q.eq("type", args.type).eq("season", args.season))
      .first();
    
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        completedAt: args.status === "completed" ? Date.now() : undefined,
      });
    }
  },
});

export const createSyncStatus = mutation({
  args: {
    type: v.string(),
    season: v.number(),
    status: v.union(v.literal("syncing"), v.literal("completed"), v.literal("failed")),
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("playerSyncStatus")
      .withIndex("by_type_season", (q) => q.eq("type", args.type).eq("season", args.season))
      .first();
    
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        startedAt: Date.now(),
        error: undefined,
        playersProcessed: undefined,
        completedAt: undefined,
      });
    } else {
      await ctx.db.insert("playerSyncStatus", {
        ...args,
        startedAt: Date.now(),
      });
    }
  },
});

// Queries
export const getSyncStatus = query({
  args: { 
    season: v.number(),
    type: v.optional(v.string()),
  },
  handler: async (ctx, { season, type = "all" }) => {
    return await ctx.db
      .query("playerSyncStatus")
      .withIndex("by_type_season", (q) => q.eq("type", type).eq("season", season))
      .first();
  },
});

export const checkSyncStatus = query({
  args: {
    type: v.string(),
    season: v.number(),
  },
  handler: async (ctx, { type, season }) => {
    return await ctx.db
      .query("playerSyncStatus")
      .withIndex("by_type_season", (q) => q.eq("type", type).eq("season", season))
      .first();
  },
});

export const getLeagueFreeAgents = query({
  args: {
    leagueId: v.id("leagues"),
    limit: v.optional(v.number()),
    position: v.optional(v.string()),
  },
  handler: async (ctx, { leagueId, limit = 50, position }) => {
    let query = ctx.db
      .query("leaguePlayerStatus")
      .withIndex("by_league_status", (q) => 
        q.eq("leagueId", leagueId).eq("status", "free_agent")
      );
    
    const statuses = await query.take(limit * 2); // Get extra to filter
    
    // Get player details
    const playerIds = statuses.map(s => s.playerId);
    const players = await Promise.all(
      playerIds.map(async (playerId) => {
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", 2025)
          )
          .first();
        return player;
      })
    );
    
    // Filter by position if specified
    let filteredPlayers = players.filter(p => p !== null);
    if (position) {
      filteredPlayers = filteredPlayers.filter(p => 
        p!.defaultPosition === position || p!.eligiblePositions.includes(position)
      );
    }
    
    // Sort by ownership percentage
    filteredPlayers.sort((a, b) => 
      (b!.ownership.percentOwned || 0) - (a!.ownership.percentOwned || 0)
    );
    
    return filteredPlayers.slice(0, limit);
  },
});

// Get all players for a season
export const getAllPlayersForSeason = query({
  args: {
    season: v.number(),
  },
  handler: async (ctx, { season }) => {
    return await ctx.db
      .query("playersEnhanced")
      .withIndex("by_espn_id_season")
      .filter((q) => q.eq(q.field("season"), season))
      .collect();
  },
});

// Upsert batch of player stats
export const upsertPlayerStatsBatch = mutation({
  args: {
    playerStats: v.array(v.object({
      leagueId: v.id("leagues"),
      espnId: v.string(),
      season: v.number(),
      scoringType: v.string(),
      stats: v.any(),
      actualStats: v.optional(v.any()),
      projectedStats: v.optional(v.any()),
      calculatedAt: v.number(),
    })),
  },
  handler: async (ctx, { playerStats }) => {
    const now = Date.now();
    
    for (const stat of playerStats) {
      // Process stats if transformed fields aren't provided
      let processedStat = { ...stat };
      if (!stat.actualStats && !stat.projectedStats && stat.stats) {
        const processed = processPlayerStats(stat.stats);
        processedStat.actualStats = processed.actualStats;
        processedStat.projectedStats = processed.projectedStats;
      }
      
      // Check if player stat exists
      const existing = await ctx.db
        .query("playerStats")
        .withIndex("by_league_player", (q) => 
          q.eq("leagueId", processedStat.leagueId)
           .eq("espnId", processedStat.espnId)
           .eq("season", processedStat.season)
        )
        .first();
      
      if (existing) {
        // Update existing stat
        await ctx.db.patch(existing._id, {
          ...processedStat,
          updatedAt: now,
        });
      } else {
        // Insert new stat
        await ctx.db.insert("playerStats", {
          ...processedStat,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  },
});

// Get players with league-specific stats
export const getPlayersWithLeagueStats = query({
  args: {
    leagueId: v.id("leagues"),
    playerIds: v.array(v.string()),
    season: v.number(),
  },
  handler: async (ctx, { leagueId, playerIds, season }) => {
    // Get base player info
    const players = await Promise.all(
      playerIds.map(async (playerId) => {
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", season)
          )
          .first();
        
        if (!player) return null;
        
        // Get league-specific stats if available
        const leagueStats = await ctx.db
          .query("playerStats")
          .withIndex("by_league_player", (q) => 
            q.eq("leagueId", leagueId)
             .eq("espnId", playerId)
             .eq("season", season)
          )
          .first();
        
        return {
          ...player,
          leagueStats: leagueStats || null,
        };
      })
    );
    
    return players.filter(p => p !== null);
  },
});

// Get league free agents with league-specific stats
export const getLeagueFreeAgentsWithStats = query({
  args: {
    leagueId: v.id("leagues"),
    limit: v.optional(v.number()),
    position: v.optional(v.string()),
    season: v.number(),
  },
  handler: async (ctx, { leagueId, limit = 50, position, season }) => {
    // Get free agent statuses
    let query = ctx.db
      .query("leaguePlayerStatus")
      .withIndex("by_league_status", (q) => 
        q.eq("leagueId", leagueId).eq("status", "free_agent")
      );
    
    const statuses = await query.take(limit * 2);
    
    // Get player details with stats
    const playerIds = statuses.map(s => s.playerId);
    const playersWithStats = await Promise.all(
      playerIds.map(async (playerId) => {
        // Get base player info
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", season)
          )
          .first();
        
        if (!player) return null;
        
        // Skip if wrong position
        if (position && player.defaultPosition !== position && !player.eligiblePositions.includes(position)) {
          return null;
        }
        
        // Get league-specific stats
        const leagueStats = await ctx.db
          .query("playerStats")
          .withIndex("by_league_player", (q) => 
            q.eq("leagueId", leagueId)
             .eq("espnId", playerId)
             .eq("season", season)
          )
          .first();
        
        return {
          ...player,
          leagueStats: leagueStats || null,
        };
      })
    );
    
    // Filter out nulls and sort by ownership
    const validPlayers = playersWithStats.filter(p => p !== null);
    validPlayers.sort((a, b) => 
      (b!.ownership.percentOwned || 0) - (a!.ownership.percentOwned || 0)
    );
    
    return validPlayers.slice(0, limit);
  },
});

// Helper function to convert position IDs to abbreviations
export function getPositionAbbrev(positionId: number): string {
  const positionMap: Record<number, string> = {
    0: "QB",
    1: "QB",
    2: "RB",
    3: "WR",
    4: "TE",
    5: "K",
    6: "TE",
    7: "P",
    8: "DT",
    9: "FB",
    10: "LB",
    11: "DL",
    12: "CB",
    13: "S",
    14: "DB",
    15: "DP",
    16: "D/ST",
    17: "K",
    18: "P",
    19: "HC",
    20: "BE",
    21: "IR",
    22: "IDL",
    23: "FLEX",
    25: "RB/WR/TE"
  };
  
  return positionMap[positionId] || "UNKNOWN";
}