import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
    })),
  },
  handler: async (ctx, { players }) => {
    const now = Date.now();
    
    for (const player of players) {
      // Check if player exists
      const existing = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_espn_id_season", (q) => 
          q.eq("espnId", player.espnId).eq("season", player.season)
        )
        .first();
      
      if (existing) {
        // Update existing player
        await ctx.db.patch(existing._id, {
          ...player,
          updatedAt: now,
        });
      } else {
        // Insert new player
        await ctx.db.insert("playersEnhanced", {
          ...player,
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
    status: v.union(v.literal("idle"), v.literal("syncing"), v.literal("error")),
    lastFullSync: v.optional(v.number()),
    lastIncrementalSync: v.optional(v.number()),
    totalPlayers: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("playerSyncStatus")
      .withIndex("by_season", (q) => q.eq("season", args.season))
      .first();
    
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("playerSyncStatus", args);
    }
  },
});

// Queries
export const getSyncStatus = query({
  args: { season: v.number() },
  handler: async (ctx, { season }) => {
    return await ctx.db
      .query("playerSyncStatus")
      .withIndex("by_season", (q) => q.eq("season", season))
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

// Helper function to convert position IDs to abbreviations
export function getPositionAbbrev(positionId: number): string {
  const positionMap: Record<number, string> = {
    0: "QB",
    1: "TQB",
    2: "RB",
    3: "RB/WR",
    4: "WR",
    5: "WR/TE",
    6: "TE",
    7: "OP",
    8: "DT",
    9: "DE",
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