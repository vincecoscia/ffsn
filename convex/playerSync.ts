import { action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { getPositionAbbrev } from "./playerSyncInternal";

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

// ESPN API endpoints
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
  lineupSlotId?: number;
  acquisitionType?: string;
  acquisitionDate?: number;
  status?: string;
  tradeLocked?: boolean;
  keeperValue?: number;
  keeperValueFuture?: number;
  draftAuctionValue?: number;
}

interface ESPNLeagueResponse {
  players: ESPNLeaguePlayerData[];
}
const ESPN_PLAYERS_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/players?scoringPeriodId=0&view=players_wl&view=kona_player_info";
const ESPN_LEAGUE_PLAYERS_ENDPOINT = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}?scoringPeriodId=0&view=kona_player_info";

// Re-export queries and mutations from internal file
export { 
  getSyncStatus, 
  getLeagueFreeAgents, 
  upsertPlayersBatch,
  updateLeaguePlayerStatuses,
  updateSyncStatus 
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
    const syncStatus = await ctx.runQuery(api.playerSyncInternal.getSyncStatus, { season });
    
    // Only sync if forced or last sync was over 24 hours ago
    if (!forceUpdate && syncStatus && syncStatus.lastFullSync) {
      const hoursSinceSync = (Date.now() - syncStatus.lastFullSync) / (1000 * 60 * 60);
      if (hoursSinceSync < 24) {
        return { 
          status: "skipped", 
          message: `Players already synced ${hoursSinceSync.toFixed(1)} hours ago` 
        };
      }
    }

    // Update sync status to syncing
    await ctx.runMutation(api.playerSyncInternal.updateSyncStatus, {
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
              // Extract just the player data (not the league-specific wrapper)
              const playerData = players.map(playerWrapper => playerWrapper.player);
              allPlayers = allPlayers.concat(playerData);
              offset += limit;
              hasMore = players.length === limit;
            }
          }
        }
      } 
      
      // Fallback to original endpoint if no league ID or league data not found
      if (allPlayers.length === 0) {
        // Try to get authentication from any available league for global endpoint
        const leagues = await ctx.runQuery(api.leagues.getByUser);
        let authHeaders: HeadersInit = {
          'Content-Type': 'application/json',
        };
        
        // Use authentication from the first available league
        if (leagues && leagues.length > 0) {
          const firstLeague = leagues[0];
          if (firstLeague.espnData?.espnS2 && firstLeague.espnData?.swid) {
            authHeaders.Cookie = `espn_s2=${firstLeague.espnData.espnS2}; SWID=${firstLeague.espnData.swid}`;
          }
        }
        
        let offset = 0;
        const limit = 1000;
        let hasMore = true;

        while (hasMore) {
          const url = ESPN_PLAYERS_ENDPOINT.replace("{season}", season.toString());
          
          // Add the proper x-fantasy-filter header that ESPN expects
          const headers = {
            ...authHeaders,
            'x-fantasy-filter': JSON.stringify({
              "filterActive": {"value": true},
              "limit": limit,
              "offset": offset
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
        status: "idle",
        lastFullSync: Date.now(),
        totalPlayers: allPlayers.length,
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
        status: "error",
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
  },
  handler: async (ctx, { leagueId, seasonId, draftPicks }): Promise<{ status: string; message?: string; playersCount?: number }> => {
    try {
      // Get league details for authentication
      const league = await ctx.runQuery(api.leagues.getById, { id: leagueId });
      if (!league || !league.espnData) {
        throw new Error("League not found or missing ESPN data");
      }

      // Extract unique player IDs from draft picks
      const playerIds = [...new Set(draftPicks.map(pick => pick.playerId.toString()))];
      
      // Fetch player data from ESPN for these specific players
      const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${league.externalId}`;
      
      const headers: HeadersInit = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      };
      
      if (league.espnData.isPrivate && league.espnData.espnS2 && league.espnData.swid) {
        const espnS2 = decodeURIComponent(league.espnData.espnS2);
        headers['Cookie'] = `espn_s2=${espnS2}; SWID=${league.espnData.swid}`;
      }

      // Fetch detailed player data from ESPN
      const response = await fetch(
        `${baseUrl}?view=kona_player_info&view=players_wl`,
        { headers }
      );

      if (!response.ok) {
        console.warn(`Failed to fetch player details from ESPN: ${response.status}`);
        // Continue without player details - draft data will still work with fallback
        return {
          status: "warning",
          message: "Draft data synced but detailed player information unavailable",
          playersCount: 0,
        };
      }

      const leagueData = await response.json();
      const players = leagueData.players || [];

      // Filter to only the players that were drafted
      const draftedPlayers = players.filter((playerWrapper: any) => {
        const player = playerWrapper.player;
        return playerIds.includes(player.id.toString());
      });

      // Process and store the player data
      if (draftedPlayers.length > 0) {
        await ctx.runMutation(api.playerSyncInternal.upsertPlayersBatch, {
          season: seasonId,
          players: draftedPlayers.map((playerWrapper: any) => {
            const player = playerWrapper.player;
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
      }

      return {
        status: "success",
        playersCount: draftedPlayers.length,
        message: `Successfully synced ${draftedPlayers.length} drafted players for ${seasonId} season`,
      };

    } catch (error: unknown) {
      console.error("Failed to sync players for draft:", error);
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

// Sync all league players with automatic pagination
export const syncAllLeaguePlayers = action({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
    maxBatches: v.optional(v.number()), // Limit number of batches per call to avoid timeout
  },
  handler: async (ctx, { leagueId, season, maxBatches = 3 }): Promise<{ status: string; totalPlayersProcessed: number; hasMore: boolean; nextOffset: number | null }> => {
    let offset = 0;
    let totalProcessed = 0;
    let hasMore = true;
    let batchCount = 0;
    
    // Process up to maxBatches to avoid timeout
    while (hasMore && batchCount < maxBatches) {
      const result = await ctx.runAction(api.playerSync.syncLeaguePlayers, {
        leagueId,
        season,
        offset,
        limit: 500,
      });
      
      totalProcessed += result.playersProcessed;
      hasMore = result.hasMore;
      offset = result.nextOffset || 0;
      batchCount++;
    }
    
    return {
      status: hasMore ? "partial" : "complete",
      totalPlayersProcessed: totalProcessed,
      hasMore,
      nextOffset: hasMore ? offset : null,
    };
  },
});

export const syncAllLeaguePlayersComplete = action({
  args: {
    leagueId: v.id("leagues"),
    season: v.number(),
  },
  handler: async (ctx, { leagueId, season }): Promise<{ status: string; totalPlayersProcessed: number; batches: number }> => {
    let totalProcessed = 0;
    let hasMore = true;
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
