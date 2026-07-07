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
      const processedPlayer = { ...player };
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
    const query = ctx.db
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
      position: v.optional(v.string()),
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
      const processedStat = { ...stat };
      if (!stat.actualStats && !stat.projectedStats && stat.stats) {
        const processed = processPlayerStats(stat.stats);
        processedStat.actualStats = processed.actualStats;
        processedStat.projectedStats = processed.projectedStats;
      }

      // Derive denormalized fields for fast querying
      try {
        const statsArray: any[] | undefined = processedStat.stats as any[] | undefined;
        let actualEntry: any | undefined = undefined;
        if (Array.isArray(statsArray)) {
          // Prefer exact season match
          actualEntry = statsArray.find(
            (s: any) => s?.statSourceId === 0 && s?.scoringPeriodId === 0 && s?.seasonId === (processedStat as any).season
          );
          // Fallback: accept any season total if exact season not tagged
          if (!actualEntry) {
            actualEntry = statsArray.find((s: any) => s?.statSourceId === 0 && s?.scoringPeriodId === 0);
          }
        }
        // Fallback: compute from transformed actualStats if present
        const fallbackTotal = (processedStat as any).actualStats?.["120"] as number | undefined;
        const fallbackAvg = (processedStat as any).actualStats?.["102"]
          ? ((processedStat as any).actualStats?.["120"] || 0) / Math.max((processedStat as any).actualStats?.["102"], 1)
          : undefined;
        const actualAppliedTotal: number | undefined = (actualEntry && typeof actualEntry.appliedTotal === "number")
          ? actualEntry.appliedTotal
          : fallbackTotal;
        const actualAppliedAverage: number | undefined = (actualEntry && typeof actualEntry.appliedAverage === "number")
          ? actualEntry.appliedAverage
          : fallbackAvg;

        // Look up player's default position for denormalization only if not already provided
        if (!(processedStat as any).position) {
          const playerDoc = await ctx.db
            .query("playersEnhanced")
            .withIndex("by_espn_id_season", (q) =>
              q.eq("espnId", processedStat.espnId).eq("season", processedStat.season)
            )
            .first();
          (processedStat as any).position = playerDoc?.defaultPosition;
        }
        (processedStat as any).actualAppliedTotal = actualAppliedTotal;
        (processedStat as any).actualAppliedAverage = actualAppliedAverage;
      } catch {
        // Best effort; leave denormalized fields undefined if lookup fails
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
    const query = ctx.db
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

// Mutation to refresh cached top performers (called by cron or manually)
export const refreshLeagueTopPerformers = mutation({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
    positions: v.record(
      v.string(),
      v.array(
        v.object({
          espnId: v.string(),
          fullName: v.string(),
          defaultPosition: v.string(),
          proTeamAbbrev: v.optional(v.string()),
          ownerTeamName: v.optional(v.string()),
          appliedTotal: v.number(),
          appliedAverage: v.optional(v.number()),
        })
      )
    ),
  },
  handler: async (ctx, { leagueId, season, positions }) => {
    const existing = await ctx.db
      .query("leagueTopPerformers")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("season", season))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        positions,
        generatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("leagueTopPerformers", {
        leagueId,
        season,
        positions,
        generatedAt: Date.now(),
      });
    }
  },
});

// Compute and upsert leagueTopPerformers from denormalized playerStats using indexes
export const computeLeagueTopPerformers = mutation({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
    limitPerPosition: v.optional(v.number()),
  },
  handler: async (ctx, { leagueId, season, limitPerPosition = 10 }) => {
    const positions = ["QB", "RB", "WR", "TE", "K", "D/ST"] as const;

    // Build ownership map (espnId -> team name) for current league/season
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", season))
      .collect();
    const ownerNameByEspnId = new Map<string, string>();
    teams.forEach((team) => {
      team.roster.forEach((p) => ownerNameByEspnId.set(p.playerId, team.name));
    });

    const result: Record<string, Array<{
      espnId: string;
      fullName: string;
      defaultPosition: string;
      proTeamAbbrev?: string;
      ownerTeamName?: string;
      appliedTotal: number;
      appliedAverage?: number;
    }>> = {};

    for (const pos of positions) {
      // Query top N by index (descending on actualAppliedTotal)
      const topStats = await ctx.db
        .query("playerStats")
        .withIndex("by_league_season_position_total", (q) =>
          q.eq("leagueId", leagueId).eq("season", season).eq("position", pos)
        )
        .order("desc")
        .take(limitPerPosition);

      // Fetch player display fields
      const rows: Array<{
        espnId: string;
        fullName: string;
        defaultPosition: string;
        proTeamAbbrev?: string;
        ownerTeamName?: string;
        appliedTotal: number;
        appliedAverage?: number;
      }> = [];

      for (const s of topStats) {
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => q.eq("espnId", s.espnId).eq("season", season))
          .first();
        if (!player) continue;
        rows.push({
          espnId: s.espnId,
          fullName: player.fullName,
          defaultPosition: player.defaultPosition,
          proTeamAbbrev: player.proTeamAbbrev,
          ownerTeamName: ownerNameByEspnId.get(s.espnId) || undefined,
          appliedTotal: (s as any).actualAppliedTotal ?? 0,
          appliedAverage: (s as any).actualAppliedAverage ?? undefined,
        });
      }

      result[pos] = rows;
    }

    // Upsert cache document
    const existing = await ctx.db
      .query("leagueTopPerformers")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("season", season))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { positions: result, generatedAt: Date.now() });
    } else {
      await ctx.db.insert("leagueTopPerformers", {
        leagueId,
        season,
        positions: result,
        generatedAt: Date.now(),
      });
    }

    return { positions: result };
  },
});

// Query: does cache exist for league+season
export const getTopPerformersCache = query({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
  },
  handler: async (ctx, { leagueId, season }) => {
    return await ctx.db
      .query("leagueTopPerformers")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("season", season))
      .first();
  },
});

// Query: do we have any playerStats for league+season
export const hasPlayerStatsForLeagueSeason = query({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
  },
  handler: async (ctx, { leagueId, season }) => {
    const any = await ctx.db
      .query("playerStats")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("season", season))
      .take(1);
    return any.length > 0;
  },
});

// Backfill denormalized fields (position, actualAppliedTotal, actualAppliedAverage) for a league/season
export const backfillLeagueSeasonPlayerStatsDenorm = mutation({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { leagueId, season, limit = 300 }) => {
    // Process only a limited set of docs that are missing denormalized fields to avoid timeouts
    const missingDocs = await ctx.db
      .query("playerStats")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("season", season))
      .filter((q) => q.or(
        q.eq(q.field("position"), undefined as any),
        q.eq(q.field("actualAppliedTotal"), undefined as any),
        q.eq(q.field("actualAppliedAverage"), undefined as any),
      ))
      .take(limit);

    for (const stat of missingDocs) {
      let needsPatch = false;
      const processedStat: any = { ...stat };

      // Derive totals/averages from raw stats or transformed fields
      try {
        const statsArray: any[] | undefined = processedStat.stats as any[] | undefined;
        let actualEntry: any | undefined = undefined;
        if (Array.isArray(statsArray)) {
          actualEntry = statsArray.find(
            (s: any) => s?.statSourceId === 0 && s?.scoringPeriodId === 0 && s?.seasonId === season
          ) || statsArray.find((s: any) => s?.statSourceId === 0 && s?.scoringPeriodId === 0);
        }

        const fallbackTotal = processedStat.actualStats?.["120"] as number | undefined;
        const fallbackAvg = processedStat.actualStats?.["102"]
          ? (processedStat.actualStats?.["120"] || 0) / Math.max(processedStat.actualStats?.["102"], 1)
          : undefined;

        const actualAppliedTotal: number | undefined = (actualEntry && typeof actualEntry.appliedTotal === "number")
          ? actualEntry.appliedTotal
          : fallbackTotal;
        const actualAppliedAverage: number | undefined = (actualEntry && typeof actualEntry.appliedAverage === "number")
          ? actualEntry.appliedAverage
          : fallbackAvg;

        if (typeof processedStat.actualAppliedTotal !== "number" && typeof actualAppliedTotal === "number") {
          processedStat.actualAppliedTotal = actualAppliedTotal;
          needsPatch = true;
        }
        if (typeof processedStat.actualAppliedAverage !== "number" && typeof actualAppliedAverage === "number") {
          processedStat.actualAppliedAverage = actualAppliedAverage;
          needsPatch = true;
        }
      } catch {}

      // Derive position from playersEnhanced (per-doc to keep memory low)
      if (!processedStat.position) {
        try {
          const playerDoc = await ctx.db
            .query("playersEnhanced")
            .withIndex("by_espn_id_season", (q) => q.eq("espnId", processedStat.espnId).eq("season", season))
            .first();
          if (playerDoc?.defaultPosition) {
            processedStat.position = playerDoc.defaultPosition;
            needsPatch = true;
          }
        } catch {}
      }

      if (needsPatch) {
        await ctx.db.patch(stat._id, {
          position: processedStat.position,
          actualAppliedTotal: processedStat.actualAppliedTotal,
          actualAppliedAverage: processedStat.actualAppliedAverage,
          updatedAt: Date.now(),
        });
      }
    }

    return { updated: true, processed: missingDocs.length, hasMore: missingDocs.length === limit };
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