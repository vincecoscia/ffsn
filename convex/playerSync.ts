/* eslint-disable @typescript-eslint/no-explicit-any */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { getPositionAbbrev } from "./playerSyncInternal";
import { transformStats } from "./espnStatsMapping";

// Team abbreviation helper function
const getTeamAbbreviation = (teamId: number): string => {
  const teamMap: { [key: number]: string } = {
    1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
    9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
    17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
    25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
  };
  return teamMap[teamId] || 'FA';
};

// Helper function to process and transform player stats
const processPlayerStats = (stats: any[] | undefined) => {
  if (!stats || !Array.isArray(stats)) {
    return {
      actualStats: undefined,
      projectedStats: undefined,
      stats: stats
    };
  }

  // Find actual stats (statSourceId: 0) and projected stats (statSourceId: 1) for the scoring period 0
  const actualStatsEntry = stats.find((stat: any) => stat.statSourceId === 0 && stat.scoringPeriodId === 0);
  const projectedStatsEntry = stats.find((stat: any) => stat.statSourceId === 1 && stat.scoringPeriodId === 0);

  return {
    actualStats: transformStats(actualStatsEntry?.stats),
    projectedStats: transformStats(projectedStatsEntry?.stats),
    stats: stats // Keep original stats array
  };
};

// ESPN API endpoints
const ESPN_DEFAULT_PLAYERS_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leaguedefaults/3?view=kona_player_info";
const ESPN_LEAGUE_PLAYERS_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}?view=kona_player_info";

// TypeScript interfaces for ESPN API responses
interface ESPNPlayerOwnership {
  percentOwned?: number;
  percentStarted?: number;
  percentChange?: number;
  auctionValueAverage?: number;
  averageDraftPosition?: number;
}

interface ESPNPlayer {
  id: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId: number;
  eligibleSlots?: number[];
  proTeamId?: number;
  active?: boolean;
  injured?: boolean;
  injuryStatus?: string;
  droppable?: boolean;
  universeId?: number;
  ownership?: ESPNPlayerOwnership;
  jersey?: string;
  seasonOutlook?: string;
  stats?: any; // ESPN stats object structure varies
  draftRanksByRankType?: any; // ESPN draft rankings object
}

interface ESPNLeaguePlayerData {
  player: ESPNPlayer;
  onTeamId: number;
  status?: string; // "WAIVERS", "FREEAGENT", etc.
  lineupSlotId?: number;
  acquisitionType?: string;
  acquisitionDate?: number;
  tradeLocked?: boolean;
  keeperValue?: number;
  keeperValueFuture?: number;
  draftAuctionValue?: number;
}

interface ESPNLeagueResponse {
  players: ESPNLeaguePlayerData[];
}
const ESPN_PLAYERS_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/players?scoringPeriodId=0&view=players_wl&view=kona_player_info";

// Re-export queries and mutations from internal file
export { 
  getSyncStatus, 
  getLeagueFreeAgents, 
  upsertPlayersBatch,
  updateLeaguePlayerStatuses,
  updateSyncStatus,
  checkSyncStatus,
  createSyncStatus,
  getAllPlayersForSeason,
  upsertPlayerStatsBatch,
  getPlayersWithLeagueStats,
  getLeagueFreeAgentsWithStats
} from "./playerSyncInternal";

// Fetch all players from ESPN (master list)
export const syncAllPlayers = action({
  args: { 
    season: v.number(),
    forceUpdate: v.optional(v.boolean()),
    leagueId: v.optional(v.id("leagues")) // Add league ID for authentication
  },
  handler: async (ctx, { season, forceUpdate = false, leagueId }): Promise<{ status: string; message?: string; playersCount?: number }> => {
    // Check if we need to sync
    const syncStatus = await ctx.runQuery(api.playerSyncInternal.getSyncStatus, { season, type: "all" });
    
    // Only sync if forced or last sync was completed recently
    if (!forceUpdate && syncStatus && syncStatus.status === "completed" && syncStatus.completedAt) {
      const hoursSinceSync = (Date.now() - syncStatus.completedAt) / (1000 * 60 * 60);
      if (hoursSinceSync < 24) {
        return { 
          status: "skipped", 
          message: `Players already synced ${hoursSinceSync.toFixed(1)} hours ago` 
        };
      }
    }

    // Create or update sync status to syncing
    await ctx.runMutation(api.playerSyncInternal.createSyncStatus, {
      type: "all",
      season,
      status: "syncing",
    });

    try {
      let allPlayers: ESPNPlayer[] = [];
      
      // If we have a league ID, use the authenticated league endpoint approach
      if (leagueId) {
        // Get league details for authentication
        const league = await ctx.runQuery(api.leagues.getById, { id: leagueId });
        if (league && league.espnData) {
          const externalId = league.externalId;
          const { espnS2, swid } = league.espnData;
          
          let offset = 0;
          const limit = 1000;
          let hasMore = true;

          while (hasMore) {
            const url = ESPN_LEAGUE_PLAYERS_ENDPOINT.replace("{season}", season.toString()).replace("{leagueId}", externalId);
            
            const headers: HeadersInit = {
              'Content-Type': 'application/json',
              'x-fantasy-filter': JSON.stringify({
                "players": {
                  // Remove status filter to get ALL players (not just free agents)
                  "filterSlotIds": {"value": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,23,24]},
                  "filterRanksForScoringPeriodIds": {"value": [1]},
                  "limit": limit,
                  "offset": offset,
                  "sortPercOwned": {"sortAsc": false, "sortPriority": 1},
                  "sortDraftRanks": {"sortPriority": 100, "sortAsc": true, "value": "STANDARD"},
                  "filterRanksForRankTypes": {"value": ["PPR"]},
                  "filterRanksForSlotIds": {"value": [0,2,4,6,17,16,8,9,10,12,13,24,11,14,15]},
                  "filterStatsForTopScoringPeriodIds": {"value": 2, "additionalValue": [`00${season}`, `10${season}`, `00${season-1}`, `1120${season}1`, `02${season}`]}
                }
              })
            };
            
            if (espnS2 && swid) {
              headers.Cookie = `espn_s2=${espnS2}; SWID=${swid}`;
            }

            const response = await fetch(url, { headers });
            
            if (!response.ok) {
              throw new Error(`ESPN API error: ${response.status}`);
            }

            const data = await response.json() as ESPNLeagueResponse;
            const players = data.players || [];
            
            if (players.length === 0) {
              hasMore = false;
            } else {
              // Extract just the player objects
              allPlayers = allPlayers.concat(players.map((p: ESPNLeaguePlayerData) => p.player));
              offset += limit;
              hasMore = players.length === limit;
            }
          }
        }
      } else {
        // Use the public players endpoint
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        while (hasMore) {
          const url = ESPN_PLAYERS_ENDPOINT.replace("{season}", season.toString());
          
          const headers: HeadersInit = {
            'Content-Type': 'application/json',
            'x-fantasy-filter': JSON.stringify({
              "players": {
                "limit": limit,
                "offset": offset,
                "sortPercOwned": {"sortAsc": false, "sortPriority": 1},
                "sortDraftRanks": {"sortPriority": 100, "sortAsc": true, "value": "STANDARD"}
              }
            })
          };
          
          const response = await fetch(url, { headers });
          
          if (!response.ok) {
            throw new Error(`ESPN API error: ${response.status}`);
          }

          const playersResponse = await response.json() as ESPNPlayer[];
          
          if (playersResponse.length === 0) {
            hasMore = false;
          } else {
            allPlayers = allPlayers.concat(playersResponse);
            offset += limit;
            hasMore = playersResponse.length === limit;
          }
        }
      }
      
      // Process players in batches to avoid timeouts
      const batchSize = 100;
      
      for (let i = 0; i < allPlayers.length; i += batchSize) {
        const batch = allPlayers.slice(i, i + batchSize);
        await ctx.runMutation(api.playerSyncInternal.upsertPlayersBatch, {
          season,
          players: batch.map((player: ESPNPlayer) => ({
            espnId: player.id.toString(),
            season,
            fullName: player.fullName || `${player.firstName || ""} ${player.lastName || ""}`.trim(),
            firstName: player.firstName,
            lastName: player.lastName,
            defaultPositionId: player.defaultPositionId,
            defaultPosition: getPositionAbbrev(player.defaultPositionId),
            eligibleSlots: player.eligibleSlots || [],
            eligiblePositions: (player.eligibleSlots || []).map((slot: number) => getPositionAbbrev(slot)),
            proTeamId: player.proTeamId || 0,
            proTeamAbbrev: getTeamAbbreviation(player.proTeamId || 0),
            active: player.active !== false,
            injured: player.injured === true,
            injuryStatus: player.injuryStatus,
            droppable: player.droppable !== false,
            universeId: player.universeId,
            ownership: {
              percentOwned: player.ownership?.percentOwned || 0,
              percentStarted: player.ownership?.percentStarted || 0,
              percentChange: player.ownership?.percentChange,
              auctionValueAverage: player.ownership?.auctionValueAverage,
              averageDraftPosition: player.ownership?.averageDraftPosition,
            },
            jersey: player.jersey || undefined,
            seasonOutlook: player.seasonOutlook || undefined,
            stats: player.stats,
            draftRanksByRankType: player.draftRanksByRankType,
          })),
        });
      }

      // Update sync status
      await ctx.runMutation(api.playerSyncInternal.updateSyncStatus, {
        season,
        status: "completed",
        type: "all",
        playersProcessed: allPlayers.length,
      });

      return { 
        status: "success", 
        playersCount: allPlayers.length,
        message: `Successfully synced ${allPlayers.length} players for ${season} season`
      };
    } catch (error: unknown) {
      // Update sync status with error
      await ctx.runMutation(api.playerSyncInternal.updateSyncStatus, {
        season,
        status: "failed",
        type: "all",
        error: error instanceof Error ? error.message : String(error),
      });
      
      throw error;
    }
  },
});
// Sync only players from a specific draft
export const syncPlayersForDraft = action({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    draftPicks: v.array(v.object({
      playerId: v.number(),
      // We only need playerId for this sync, but keeping the full structure for future use
      autoDraftTypeId: v.optional(v.number()),
      bidAmount: v.optional(v.number()),
      id: v.optional(v.number()),
      keeper: v.optional(v.boolean()),
      lineupSlotId: v.optional(v.number()),
      memberId: v.optional(v.string()),
      nominatingTeamId: v.optional(v.number()),
      overallPickNumber: v.optional(v.number()),
      reservedForKeeper: v.optional(v.boolean()),
      roundId: v.optional(v.number()),
      roundPickNumber: v.optional(v.number()),
      teamId: v.optional(v.number()),
      tradeLocked: v.optional(v.boolean()),
    })),
    forceUpdate: v.optional(v.boolean()),
  },
  handler: async (ctx, { leagueId, seasonId, draftPicks, forceUpdate = false }) => {
    if (!draftPicks || draftPicks.length === 0) {
      return {
        status: "no_picks",
        message: "No draft picks to sync",
        playersCount: 0,
      };
    }

    // Get league details for authentication
    const league = await ctx.runQuery(api.leagues.getById, { id: leagueId });
    if (!league || !league.espnData) {
      throw new Error("League not found or ESPN data missing");
    }

    const externalId = league.externalId;
    const { espnS2, swid } = league.espnData;
    
    try {
      // Extract unique player IDs
      const uniquePlayerIds = [...new Set(draftPicks.map(pick => pick.playerId))];
      
      // Process in batches
      const batchSize = 50;
      let processedCount = 0;
      
      for (let i = 0; i < uniquePlayerIds.length; i += batchSize) {
        const batchIds = uniquePlayerIds.slice(i, i + batchSize);
        
        // Construct URL with player filter
        const url = ESPN_LEAGUE_PLAYERS_ENDPOINT.replace("{season}", seasonId.toString()).replace("{leagueId}", externalId);
        
        const headers: HeadersInit = {
          'Content-Type': 'application/json',
          'x-fantasy-filter': JSON.stringify({
            "players": {
              "filterIds": {"value": batchIds},
              "filterSlotIds": {"value": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,23,24]},
              "filterStatsForTopScoringPeriodIds": {"value": 2, "additionalValue": [`00${seasonId}`, `10${seasonId}`, `00${seasonId-1}`, `1120${seasonId}1`, `02${seasonId}`]}
            }
          })
        };
        
        if (espnS2 && swid) {
          headers.Cookie = `espn_s2=${espnS2}; SWID=${swid}`;
        }

        const response = await fetch(url, { headers });
        
        if (!response.ok) {
          console.error(`ESPN API error for batch ${i/batchSize + 1}: ${response.status}`);
          continue;
        }

        const data = await response.json() as ESPNLeagueResponse;
        const players = data.players || [];
        
        if (players.length > 0) {
          // Process and store players
          await ctx.runMutation(api.playerSyncInternal.upsertPlayersBatch, {
            season: seasonId,
            players: players.map((playerData: ESPNLeaguePlayerData) => {
              const player = playerData.player;
              return {
                espnId: player.id.toString(),
                season: seasonId,
                fullName: player.fullName || `${player.firstName || ""} ${player.lastName || ""}`.trim(),
                firstName: player.firstName,
                lastName: player.lastName,
                defaultPositionId: player.defaultPositionId,
                defaultPosition: getPositionAbbrev(player.defaultPositionId),
                eligibleSlots: player.eligibleSlots || [],
                eligiblePositions: (player.eligibleSlots || []).map((slot: number) => getPositionAbbrev(slot)),
                proTeamId: player.proTeamId || 0,
                proTeamAbbrev: getTeamAbbreviation(player.proTeamId || 0),
                active: player.active !== false,
                injured: player.injured === true,
                injuryStatus: player.injuryStatus,
                droppable: player.droppable !== false,
                universeId: player.universeId,
                ownership: {
                  percentOwned: player.ownership?.percentOwned || 0,
                  percentStarted: player.ownership?.percentStarted || 0,
                  percentChange: player.ownership?.percentChange,
                  auctionValueAverage: player.ownership?.auctionValueAverage,
                  averageDraftPosition: player.ownership?.averageDraftPosition,
                },
                jersey: player.jersey || undefined,
                seasonOutlook: player.seasonOutlook || undefined,
                stats: player.stats,
                draftRanksByRankType: player.draftRanksByRankType,
              };
            }),
          });
          
          processedCount += players.length;
        }
      }
      
      return {
        status: "success",
        message: `Successfully synced ${processedCount} draft players for season ${seasonId}`,
        playersCount: processedCount,
      };
    } catch (error: unknown) {
      console.error("Failed to sync draft players:", error);
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error occurred",
        playersCount: 0,
      };
    }
  },
});

// Sync league-specific player data (with pagination)
export const syncLeaguePlayers = action({
  args: { 
    leagueId: v.id("leagues"),
    season: v.number(),
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { leagueId, season, offset = 0, limit = 50 }): Promise<{ status: string; playersProcessed: number; hasMore: boolean; nextOffset: number | null }> => {
    // Get league details
    const league = await ctx.runQuery(api.leagues.getById, { id: leagueId });
    if (!league || !league.espnData) {
      throw new Error("League not found or ESPN data missing");
    }

    const externalId = league.externalId;
    const { espnS2, swid } = league.espnData;
    
    // Construct URL - note: we don't add offset/limit to URL as they go in the header
    const url = ESPN_LEAGUE_PLAYERS_ENDPOINT.replace("{season}", season.toString()).replace("{leagueId}", externalId);
    
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'x-fantasy-filter': JSON.stringify({
        "players": {
          "filterStatus": {"value": ["FREEAGENT", "WAIVERS"]},
          "filterSlotIds": {"value": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,23,24]},
          "filterRanksForScoringPeriodIds": {"value": [1]},
          "limit": limit,
          "offset": offset,
          "sortPercOwned": {"sortAsc": false, "sortPriority": 1},
          "sortDraftRanks": {"sortPriority": 100, "sortAsc": true, "value": "STANDARD"},
          "filterRanksForRankTypes": {"value": ["PPR"]},
          "filterRanksForSlotIds": {"value": [0,2,4,6,17,16,8,9,10,12,13,24,11,14,15]},
          "filterStatsForTopScoringPeriodIds": {"value": 2, "additionalValue": [`00${season}`, `10${season}`, `00${season-1}`, `1120${season}1`, `02${season}`]}
        }
      })
    };
    
    if (espnS2 && swid) {
      headers.Cookie = `espn_s2=${espnS2}; SWID=${swid}`;
    }

    try {
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        throw new Error(`ESPN API error: ${response.status}`);
      }

      const data = await response.json() as ESPNLeagueResponse;
      const players = data.players || [];
      
      // Process each player's league-specific status
      const updates = players.map((playerData: ESPNLeaguePlayerData) => {
        const player = playerData.player;
        const onTeamId = playerData.onTeamId;
        
        return {
          leagueId,
          playerId: player.id.toString(),
          season,
          status: onTeamId === 0 ? "free_agent" as const : "owned" as const,
          teamExternalId: onTeamId > 0 ? onTeamId.toString() : undefined,
          lineupSlotId: playerData.lineupSlotId,
          acquisitionType: playerData.acquisitionType,
          acquisitionDate: playerData.acquisitionDate,
          onWaivers: playerData.status === "WAIVERS",
          tradeLocked: playerData.tradeLocked === true,
          keeperValue: playerData.keeperValue,
          keeperValueFuture: playerData.keeperValueFuture,
          draftAuctionValue: playerData.draftAuctionValue,
        };
      });

      // Update league player statuses
      await ctx.runMutation(api.playerSyncInternal.updateLeaguePlayerStatuses, {
        updates,
      });

      // Check if there are more players to fetch
      const hasMore = players.length === limit;
      
      return {
        status: "success",
        playersProcessed: players.length,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      };
    } catch (error: unknown) {
      throw new Error(`Failed to sync league players: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

// Sync ALL league players (handles pagination automatically)
export const syncAllLeaguePlayers = action({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
    maxBatches: v.optional(v.number()), // Limit for safety
  },
  handler: async (ctx, { leagueId, season, maxBatches = 100 }): Promise<{ status: string; totalPlayersProcessed: number; hasMore: boolean }> => {
    let offset = 0;
    let hasMore = true;
    let totalProcessed = 0;
    let batchCount = 0;
    
    while (hasMore && batchCount < maxBatches) {
      const result = await ctx.runAction(api.playerSync.syncLeaguePlayers, {
        leagueId,
        season,
        offset,
        limit: 500, // Large batches for efficiency
      });
      
      totalProcessed += result.playersProcessed;
      hasMore = result.hasMore;
      offset = result.nextOffset || 0;
      batchCount++;
      
      // Add a small delay between batches to be nice to the API
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return {
      status: "success",
      totalPlayersProcessed: totalProcessed,
      hasMore: hasMore && batchCount >= maxBatches,
    };
  },
});

// Complete league sync: players + statuses in chunks
export const completeLeagueSync = action({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
  },
  handler: async (ctx, { leagueId, season }) => {
    let hasMore = true;
    let totalProcessed = 0;
    let batchesRun = 0;
    
    console.log(`Starting complete league player sync for league ${leagueId}, season ${season}`);
    
    while (hasMore) {
      const result = await ctx.runAction(api.playerSync.syncAllLeaguePlayers, {
        leagueId,
        season,
        maxBatches: 3, // Process 3 batches of 500 each = 1500 players per call
      });
      
      totalProcessed += result.totalPlayersProcessed;
      hasMore = result.hasMore;
      batchesRun++;
      
      console.log(`Batch ${batchesRun}: Processed ${result.totalPlayersProcessed} players (Total: ${totalProcessed})`);
      
      // Add a small delay between chunks to be nice to the API
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log(`Completed league player sync: ${totalProcessed} total players processed in ${batchesRun} batches`);
    
    return {
      status: "success",
      totalPlayersProcessed: totalProcessed,
      batches: batchesRun,
    };
  },
});

// Sync default player stats from ESPN's public PPR endpoint
export const syncPlayersDefaultStats = action({
  args: {
    season: v.number(),
    forceUpdate: v.optional(v.boolean()),
  },
  handler: async (ctx, { season, forceUpdate = false }) => {
    // ESPN API typically only has data from 2018 onwards
    const MIN_SEASON = 2018;
    if (season < MIN_SEASON) {
      return {
        status: "skipped",
        message: `ESPN API does not have data for seasons before ${MIN_SEASON}`,
        playersCount: 0
      };
    }

    // Check if we're already syncing
    const syncStatus = await ctx.runQuery(api.playerSyncInternal.checkSyncStatus, {
      type: "default",
      season,
    });

    if (syncStatus?.status === "syncing" && !forceUpdate) {
      return { 
        status: "already_syncing", 
        message: "Default stats sync already in progress" 
      };
    }

    // Create or update sync status
    await ctx.runMutation(api.playerSyncInternal.createSyncStatus, {
      type: "default",
      season,
      status: "syncing",
    });

    try {
      let allPlayers: any[] = [];
      let offset = 0;
      const limit = 1000;
      let hasMore = true;

      // Fetch players from the public endpoint
      while (hasMore) {
        const url = ESPN_DEFAULT_PLAYERS_ENDPOINT.replace("{season}", season.toString());
        
        const headers: HeadersInit = {
          'Content-Type': 'application/json',
          'x-fantasy-filter': JSON.stringify({
            "players": {
              "filterSlotIds": {"value": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,23,24]},
              "filterRanksForScoringPeriodIds": {"value": [1]},
              "limit": limit,
              "offset": offset,
              "sortPercOwned": {"sortAsc": false, "sortPriority": 1},
              "sortDraftRanks": {"sortPriority": 100, "sortAsc": true, "value": "STANDARD"},
              "filterRanksForRankTypes": {"value": ["PPR"]},
              "filterRanksForSlotIds": {"value": [0,2,4,6,17,16,8,9,10,12,13,24,11,14,15]},
              "filterStatsForTopScoringPeriodIds": {"value": 2, "additionalValue": [`00${season}`, `10${season}`, `00${season-1}`, `1120${season}1`, `02${season}`]}
            }
          })
        };

        const response = await fetch(url, { headers });
        
        if (!response.ok) {
          throw new Error(`ESPN API error: ${response.status}`);
        }

        const data = await response.json();
        
        // Check if response has players array
        let playersResponse: any[] = [];
        if (data.players) {
          // Extract player objects from the response
          playersResponse = data.players.map((p: any) => p.player || p);
        } else if (Array.isArray(data)) {
          playersResponse = data;
        }
        
        if (playersResponse.length === 0) {
          hasMore = false;
        } else {
          allPlayers = allPlayers.concat(playersResponse);
          offset += limit;
          hasMore = playersResponse.length === limit;
        }
      }
      
      // Process players in batches
      const batchSize = 100;
      
      for (let i = 0; i < allPlayers.length; i += batchSize) {
        const batch = allPlayers.slice(i, i + batchSize);
        
        // Filter out invalid players and map to our format
        const validPlayers = batch
          .filter((player: any) => player && player.id)
          .map((player: any) => {
            const processedStats = processPlayerStats(player.stats);
            
            return {
              espnId: player.id.toString(),
              season,
              fullName: player.fullName || `${player.firstName || ""} ${player.lastName || ""}`.trim() || "Unknown Player",
              firstName: player.firstName,
              lastName: player.lastName,
              defaultPositionId: player.defaultPositionId || 0,
              defaultPosition: getPositionAbbrev(player.defaultPositionId || 0),
              eligibleSlots: player.eligibleSlots || [],
              eligiblePositions: (player.eligibleSlots || []).map((slot: number) => getPositionAbbrev(slot)),
              proTeamId: player.proTeamId || 0,
              proTeamAbbrev: getTeamAbbreviation(player.proTeamId || 0),
              active: player.active !== false,
              injured: player.injured === true,
              injuryStatus: player.injuryStatus,
              droppable: player.droppable !== false,
              universeId: player.universeId,
              ownership: {
                percentOwned: player.ownership?.percentOwned || 0,
                percentStarted: player.ownership?.percentStarted || 0,
                percentChange: player.ownership?.percentChange,
                auctionValueAverage: player.ownership?.auctionValueAverage,
                averageDraftPosition: player.ownership?.averageDraftPosition,
              },
              jersey: player.jersey || undefined,
              seasonOutlook: player.seasonOutlook || undefined,
              actualStats: processedStats.actualStats,
              projectedStats: processedStats.projectedStats,
              stats: processedStats.stats,
              draftRanksByRankType: player.draftRanksByRankType,
            };
          });
        
        if (validPlayers.length > 0) {
          await ctx.runMutation(api.playerSyncInternal.upsertPlayersBatch, {
            season,
            players: validPlayers,
          });
        }
      }

      // Update sync status
      await ctx.runMutation(api.playerSyncInternal.updateSyncStatus, {
        season,
        status: "completed",
        type: "default",
        playersProcessed: allPlayers.length,
      });

      return { 
        status: "success", 
        playersCount: allPlayers.length,
        message: `Successfully synced ${allPlayers.length} players with default PPR stats for ${season} season`
      };
    } catch (error: unknown) {
      // Update sync status with error
      await ctx.runMutation(api.playerSyncInternal.updateSyncStatus, {
        season,
        status: "failed",
        type: "default",
        error: error instanceof Error ? error.message : String(error),
      });
      
      throw error;
    }
  },
});

// Sync league-specific player stats (stores in playerStats table)
export const syncLeaguePlayerStats = action({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { leagueId, season, offset = 0, limit = 50 }): Promise<{ status: string; playersProcessed: number; hasMore: boolean; nextOffset: number | null }> => {
    // Get league details
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: leagueId });
    if (!league || !league.espnData) {
      throw new Error("League not found or ESPN data missing");
    }

    const scoringType = league.settings?.scoringType || "PPR";
    const externalId = league.externalId;
    const { espnS2, swid } = league.espnData;
    
    // Get ALL players (not just free agents) to get stats
    const url = ESPN_LEAGUE_PLAYERS_ENDPOINT.replace("{season}", season.toString()).replace("{leagueId}", externalId);
    
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'x-fantasy-filter': JSON.stringify({
        "players": {
          // Remove status filter to get ALL players
          "filterSlotIds": {"value": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,23,24]},
          "filterRanksForScoringPeriodIds": {"value": [1]},
          "limit": limit,
          "offset": offset,
          "sortPercOwned": {"sortAsc": false, "sortPriority": 1},
          "sortDraftRanks": {"sortPriority": 100, "sortAsc": true, "value": "STANDARD"},
          "filterRanksForRankTypes": {"value": ["PPR"]},
          "filterRanksForSlotIds": {"value": [0,2,4,6,17,16,8,9,10,12,13,24,11,14,15]},
          "filterStatsForTopScoringPeriodIds": {"value": 2, "additionalValue": [`00${season}`, `10${season}`, `00${season-1}`, `1120${season}1`, `02${season}`]}
        }
      })
    };
    
    if (espnS2 && swid) {
      headers.Cookie = `espn_s2=${espnS2}; SWID=${swid}`;
    }

    try {
      const response = await fetch(url, { headers });
      
      if (!response.ok) {
        throw new Error(`ESPN API error: ${response.status}`);
      }

      const data = await response.json() as ESPNLeagueResponse;
      const players = data.players || [];
      
      // Extract stats for each player
      const playerStats = players
        .filter((playerData: ESPNLeaguePlayerData) => playerData.player.stats)
        .map((playerData: ESPNLeaguePlayerData) => {
          const player = playerData.player;
          const processedStats = processPlayerStats(player.stats);
          
          return {
            leagueId,
            espnId: player.id.toString(),
            season,
            scoringType,
            stats: processedStats.stats,
            actualStats: processedStats.actualStats,
            projectedStats: processedStats.projectedStats,
            calculatedAt: Date.now(),
          };
        });

      // Batch update player stats
      if (playerStats.length > 0) {
        await ctx.runMutation(api.playerSyncInternal.upsertPlayerStatsBatch, { playerStats });
      }

      // Check if there are more players to fetch
      const hasMore = players.length === limit;
      
      return {
        status: "success",
        playersProcessed: playerStats.length,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      };
    } catch (error: unknown) {
      throw new Error(`Failed to sync league player stats: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

// Sync ALL league player stats (handles pagination automatically)
export const syncAllLeaguePlayerStats = action({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
  },
  handler: async (ctx, { leagueId, season }): Promise<{ status: string; totalPlayersProcessed: number }> => {
    let offset = 0;
    let hasMore = true;
    let totalProcessed = 0;
    
    while (hasMore) {
      const result = await ctx.runAction(api.playerSync.syncLeaguePlayerStats, {
        leagueId,
        season,
        offset,
        limit: 500, // Larger batches for efficiency
      });
      
      totalProcessed += result.playersProcessed;
      hasMore = result.hasMore;
      offset = result.nextOffset || 0;
      
      // Add a small delay between batches
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return {
      status: "success",
      totalPlayersProcessed: totalProcessed,
    };
  },
});