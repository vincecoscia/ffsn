import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireLeagueMember } from "./lib/auth";

// Helper function to extract actual stats from playerStats.stats array
function extractActualStats(playerStatsRecord: any, seasonId: number) {
  if (!playerStatsRecord?.stats || !Array.isArray(playerStatsRecord.stats)) {
    return { actualTotal: 0, actualAverage: 0, gamesPlayed: 0 };
  }

  // Find the stat entry for the season with actual stats (statSourceId: 0, scoringPeriodId: 0)
  const actualStatsEntry = playerStatsRecord.stats.find((statEntry: any) =>
    statEntry?.seasonId === seasonId &&
    statEntry?.statSourceId === 0 &&
    statEntry?.scoringPeriodId === 0
  );

  if (!actualStatsEntry) {
    // Fallback to transformed actualStats if available on record
    const t = playerStatsRecord.actualStats;
    const total = t?.["120"] || 0;
    const gp = t?.["102"] || 0;
    const avg = gp > 0 ? total / gp : 0;
    return { actualTotal: total, actualAverage: avg, gamesPlayed: gp };
  }

  const actualTotal = actualStatsEntry.appliedTotal || 0;
  const actualAverage = actualStatsEntry.appliedAverage || 0;
  const gamesPlayed = actualStatsEntry.stats?.["102"] || 0; // Games played stat ID

  return {
    actualTotal,
    actualAverage,
    gamesPlayed,
    // Also extract key individual stats for detailed view
    detailedStats: {
      passingYards: actualStatsEntry.stats?.["3"] || 0,
      passingTDs: actualStatsEntry.stats?.["4"] || 0,
      interceptions: actualStatsEntry.stats?.["20"] || 0,
      rushingYards: actualStatsEntry.stats?.["24"] || 0,
      rushingTDs: actualStatsEntry.stats?.["25"] || 0,
      rushingAttempts: actualStatsEntry.stats?.["23"] || 0,
      receptions: actualStatsEntry.stats?.["53"] || 0,
      receivingYards: actualStatsEntry.stats?.["42"] || 0,
      receivingTDs: actualStatsEntry.stats?.["43"] || 0,
      targets: actualStatsEntry.stats?.["58"] || 0,
    }
  };
}

export const getPlayersByTeam = query({
  args: { teamId: v.id("teams") },
  handler: async (ctx, args) => {
    // Get the team directly
    const team = await ctx.db.get(args.teamId);
    if (!team || !team.roster) return [];

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    await requireLeagueMember(ctx, team.leagueId);

    // Get the current season (you might want to make this dynamic)
    const currentSeason = new Date().getFullYear();
    
    // For each player in the roster, look up their enhanced data
    const playersWithEnhancedData = await Promise.all(
      team.roster.map(async (rosterPlayer) => {
        // Look up the player in playersEnhanced using espnId
        const enhancedPlayer = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", rosterPlayer.playerId).eq("season", currentSeason)
          )
          .first();
        
        // Extract key stats for display (focusing on actual stats, not projections)
        let seasonStats = null;
        if (enhancedPlayer?.actualStats) {
          // Common stats across positions (using ESPN stat IDs)
          seasonStats = {
            // Scoring
            points: enhancedPlayer.actualStats["120"] || 0, // Total fantasy points
            gamesPlayed: enhancedPlayer.actualStats["102"] || 0, // Games played
            
            // Passing stats (for QBs)
            passingYards: enhancedPlayer.actualStats["3"] || 0,
            passingTDs: enhancedPlayer.actualStats["4"] || 0,
            interceptions: enhancedPlayer.actualStats["20"] || 0,
            
            // Rushing stats
            rushingYards: enhancedPlayer.actualStats["24"] || 0,
            rushingTDs: enhancedPlayer.actualStats["25"] || 0,
            rushingAttempts: enhancedPlayer.actualStats["23"] || 0,
            
            // Receiving stats
            receptions: enhancedPlayer.actualStats["53"] || 0,
            receivingYards: enhancedPlayer.actualStats["42"] || 0,
            receivingTDs: enhancedPlayer.actualStats["43"] || 0,
            targets: enhancedPlayer.actualStats["58"] || 0,
            
            // Calculate averages
            pointsPerGame: enhancedPlayer.actualStats["102"] > 0 
              ? (enhancedPlayer.actualStats["120"] || 0) / enhancedPlayer.actualStats["102"]
              : 0,
          };
        }
        
        // Return player data, preferring enhanced data when available
        return {
          _id: rosterPlayer.playerId as Id<"players">, // Keep using playerId as the identifier
          playerId: rosterPlayer.playerId, // This is the espnId
          name: enhancedPlayer?.fullName || rosterPlayer.playerName,
          position: enhancedPlayer?.defaultPosition || rosterPlayer.position,
          team: enhancedPlayer?.proTeamAbbrev || rosterPlayer.team,
          // Add additional enhanced data
          injured: enhancedPlayer?.injured || false,
          injuryStatus: enhancedPlayer?.injuryStatus,
          // Ownership data
          ownership: enhancedPlayer?.ownership ? {
            percentOwned: enhancedPlayer.ownership.percentOwned,
            percentStarted: enhancedPlayer.ownership.percentStarted,
            averageDraftPosition: enhancedPlayer.ownership.averageDraftPosition,
          } : null,
          // Season stats
          stats: seasonStats,
          // Season outlook if available
          seasonOutlook: enhancedPlayer?.seasonOutlook,
        };
      })
    );
    
    return playersWithEnhancedData;
  },
});

export const getPlayersWithLeagueStats = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number()
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    await requireLeagueMember(ctx, args.leagueId);

    // Get all players enhanced for the given season
    const playersEnhanced = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_season", (q) => q.eq("season", args.seasonId))
      .collect();

    // Get all player stats for the given league and season
    const playerStats = await ctx.db
      .query("playerStats")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("season"), args.seasonId))
      .collect();

    // Create a map of player stats by espnId for efficient lookup
    const statsMap = new Map();
    playerStats.forEach(stat => {
      statsMap.set(stat.espnId, stat);
    });

    // Combine enhanced player data with league-specific stats
    const playersWithStats = playersEnhanced.map(player => {
      const leagueStats = statsMap.get(player.espnId);
      
      return {
        // Enhanced player data
        _id: player._id,
        espnId: player.espnId,
        season: player.season,
        fullName: player.fullName,
        firstName: player.firstName,
        lastName: player.lastName,
        defaultPosition: player.defaultPosition,
        eligiblePositions: player.eligiblePositions,
        proTeamId: player.proTeamId,
        proTeamAbbrev: player.proTeamAbbrev,
        jersey: player.jersey,
        active: player.active,
        injured: player.injured,
        injuryStatus: player.injuryStatus,
        droppable: player.droppable,
        ownership: player.ownership,
        seasonOutlook: player.seasonOutlook,
        
        // League-specific stats (if available)
        leagueStats: leagueStats ? {
          scoringType: leagueStats.scoringType,
          actualStats: leagueStats.actualStats,
          projectedStats: leagueStats.projectedStats,
          calculatedAt: leagueStats.calculatedAt,
        } : null,
        
        // Global stats as fallback
        globalStats: {
          actualStats: player.actualStats,
          projectedStats: player.projectedStats,
        },
        
        // Metadata
        hasLeagueSpecificStats: !!leagueStats,
        updatedAt: player.updatedAt,
      };
    });

    // Filter out players without any stats if needed
    // For now, return all players but indicate which have league-specific stats
    return playersWithStats;
  },
});

// Get all league players with their ownership and stats for depth charts
export const getLeaguePlayersWithStats = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number()
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    await requireLeagueMember(ctx, args.leagueId);

    // Get all teams for this league and season
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    // Get all player stats for the league
    const playerStats = await ctx.db
      .query("playerStats")
      .withIndex("by_league_player", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("season"), args.seasonId))
      .collect();

    // Create a map of player stats by espnId
    const statsMap = new Map();
    playerStats.forEach(stat => {
      statsMap.set(stat.espnId, stat);
    });

    // Create a map of team ownership
    const ownershipMap = new Map();
    teams.forEach(team => {
      team.roster.forEach(player => {
        ownershipMap.set(player.playerId, {
          teamId: team._id,
          teamName: team.name,
          teamAbbreviation: team.abbreviation,
        });
      });
    });

    // Get enhanced player data for all owned players
    const ownedPlayerIds = Array.from(ownershipMap.keys());
    const playersEnhanced = await Promise.all(
      ownedPlayerIds.map(async (espnId) => {
        return await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", espnId).eq("season", args.seasonId)
          )
          .first();
      })
    );

    // Combine all data
    const leaguePlayers = playersEnhanced
      .filter(player => player !== null)
      .map(player => {
        const ownership = ownershipMap.get(player!.espnId);
        const leagueStats = statsMap.get(player!.espnId);
        
        return {
          // Player identification
          espnId: player!.espnId,
          fullName: player!.fullName,
          defaultPosition: player!.defaultPosition,
          proTeamAbbrev: player!.proTeamAbbrev,
          
          // Ownership info
          ownerTeamId: ownership?.teamId,
          ownerTeamName: ownership?.teamName,
          ownerTeamAbbreviation: ownership?.teamAbbreviation,
          
          // Player status
          injured: player!.injured,
          injuryStatus: player!.injuryStatus,
          active: player!.active,
          
          // Stats (prioritize league-specific, fallback to global)
          stats: {
            actualTotal: leagueStats?.actualStats?.["120"] || player!.actualStats?.["120"] || 0,
            actualAverage: leagueStats?.actualStats ? 
              (leagueStats.actualStats["120"] || 0) / Math.max(leagueStats.actualStats["102"] || 1, 1) :
              (player!.actualStats?.["120"] || 0) / Math.max(player!.actualStats?.["102"] || 1, 1),
            projectedTotal: leagueStats?.projectedStats?.["120"] || player!.projectedStats?.["120"] || 0,
            gamesPlayed: leagueStats?.actualStats?.["102"] || player!.actualStats?.["102"] || 0,
          },
          
          // Additional stats for analysis
          detailedStats: {
            // Passing
            passingYards: leagueStats?.actualStats?.["3"] || player!.actualStats?.["3"] || 0,
            passingTDs: leagueStats?.actualStats?.["4"] || player!.actualStats?.["4"] || 0,
            interceptions: leagueStats?.actualStats?.["20"] || player!.actualStats?.["20"] || 0,
            
            // Rushing
            rushingYards: leagueStats?.actualStats?.["24"] || player!.actualStats?.["24"] || 0,
            rushingTDs: leagueStats?.actualStats?.["25"] || player!.actualStats?.["25"] || 0,
            rushingAttempts: leagueStats?.actualStats?.["23"] || player!.actualStats?.["23"] || 0,
            
            // Receiving
            receptions: leagueStats?.actualStats?.["53"] || player!.actualStats?.["53"] || 0,
            receivingYards: leagueStats?.actualStats?.["42"] || player!.actualStats?.["42"] || 0,
            receivingTDs: leagueStats?.actualStats?.["43"] || player!.actualStats?.["43"] || 0,
            targets: leagueStats?.actualStats?.["58"] || player!.actualStats?.["58"] || 0,
          },
          
          // Metadata
          hasLeagueSpecificStats: !!leagueStats,
          scoringType: leagueStats?.scoringType,
        };
      });

    return leaguePlayers;
  },
});

// Get top performers by position for a league
export const getTopPerformersByPosition = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    limit: v.optional(v.number()) // Default to 1 per position
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return {} as any;
    await requireLeagueMember(ctx, args.leagueId);

    // Read-only query: serve from cache only
    const cached = await ctx.db
      .query("leagueTopPerformers")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("season", args.seasonId))
      .first();
    const limit = args.limit || 1;
    if (!cached) return {} as any;

    // Transform cached minimal rows to UI shape and apply per-position limit
    const result: Record<string, any[]> = {};
    for (const [position, players] of Object.entries(cached.positions)) {
      const limited = (players as any[]).slice(0, limit).map((p) => ({
        espnId: p.espnId,
        fullName: p.fullName,
        defaultPosition: p.defaultPosition,
        proTeamAbbrev: p.proTeamAbbrev,
        ownerTeamName: p.ownerTeamName,
        stats: {
          actualTotal: p.appliedTotal || 0,
          actualAverage: p.appliedAverage || 0,
        },
        hasLeagueSpecificStats: true,
      }));
      result[position] = limited;
    }
    return result as any;
  },
});

// Get players by position with pagination - optimized version
export const getPlayersByPosition = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    position: v.optional(v.string()), // If not provided, returns all
    limit: v.optional(v.number()),
    offset: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { players: [], total: 0, hasMore: false };
    }
    await requireLeagueMember(ctx, args.leagueId);

    const limit = args.limit || 50;
    const offset = args.offset || 0;

    // Since we can't use ctx.runQuery here, let's create a simplified version
    // that reuses the logic but with limits to prevent massive queries
    
    // Get teams and create ownership map
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    const ownershipMap = new Map<string, any>();
    teams.forEach(team => {
      team.roster.forEach(player => {
        ownershipMap.set(player.playerId, {
          teamId: team._id,
          teamName: team.name,
          teamAbbreviation: team.abbreviation,
        });
      });
    });

    // Get player stats and filter early
    const playerStats = await ctx.db
      .query("playerStats")
      .withIndex("by_league_player", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("season"), args.seasonId))
      .collect();

    // Filter and sort by points, limit to top 200 total to prevent massive queries
    const topPlayersWithStats = playerStats
      .map(stat => {
        const extractedStats = extractActualStats(stat, args.seasonId);
        return {
          espnId: stat.espnId,
          extractedStats,
          ownership: ownershipMap.get(stat.espnId),
        };
      })
      .filter(item => 
        item.extractedStats.actualTotal > 0 && 
        item.ownership
      )
      .sort((a, b) => b.extractedStats.actualTotal - a.extractedStats.actualTotal)
      .slice(0, 200); // Limit to top 200 to prevent massive enhanced data fetching

    // Get enhanced data only for these top players
    const enhancedPlayers = await Promise.all(
      topPlayersWithStats.map(async (item) => {
        const enhanced = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", item.espnId).eq("season", args.seasonId)
          )
          .first();
        
        return enhanced ? {
          ...enhanced,
          extractedStats: item.extractedStats,
          ownership: item.ownership,
        } : null;
      })
    );

    const allPlayers = enhancedPlayers
      .filter(player => player !== null)
      .map(player => ({
        espnId: player!.espnId,
        fullName: player!.fullName,
        defaultPosition: player!.defaultPosition,
        proTeamAbbrev: player!.proTeamAbbrev,
        ownerTeamId: player!.ownership?.teamId,
        ownerTeamName: player!.ownership?.teamName,
        injured: player!.injured,
        injuryStatus: player!.injuryStatus,
        active: player!.active,
        stats: {
          actualTotal: player!.extractedStats.actualTotal,
          actualAverage: player!.extractedStats.actualAverage,
          gamesPlayed: player!.extractedStats.gamesPlayed || 0,
        },
        hasLeagueSpecificStats: true,
      }));

    // Filter by position if specified
    let filteredPlayers = allPlayers;
    if (args.position && args.position !== "ALL") {
      filteredPlayers = allPlayers.filter(player => player.defaultPosition === args.position);
    }

    // Sort by total points (descending) - should already be sorted but ensure consistency
    const sortedPlayers = filteredPlayers.sort((a, b) => b.stats.actualTotal - a.stats.actualTotal);

    // Apply pagination
    const paginatedPlayers = sortedPlayers.slice(offset, offset + limit);

    return {
      players: paginatedPlayers,
      total: sortedPlayers.length,
      hasMore: offset + limit < sortedPlayers.length,
    };
  },
});

// Get free agents (players not on any roster) with stats
export const getFreeAgentsWithStats = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    position: v.optional(v.string()),
    limit: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    await requireLeagueMember(ctx, args.leagueId);

    const limit = args.limit || 100;
    const candidateCap = Math.min(500, limit * 15);

    // Query free agent statuses via index (small docs)
    const statuses = await ctx.db
      .query("leaguePlayerStatus")
      .withIndex("by_league_status", (q) => q.eq("leagueId", args.leagueId).eq("status", "free_agent"))
      .take(candidateCap);

    // Build candidate list by fetching minimal enhanced data only for those
    const enhancedCandidates = await Promise.all(
      statuses.map(async (s) => {
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => q.eq("espnId", s.playerId).eq("season", args.seasonId))
          .first();
        return player;
      })
    );

    // Filter by position and basic flags
    const filtered = enhancedCandidates
      .filter((p) => p)
      .filter((p) => p!.active)
      .filter((p) => !args.position || args.position === "ALL" || p!.defaultPosition === args.position)
      .slice(0, candidateCap);

    // For each candidate, fetch league-specific stats doc (small read per player)
    const withStats = await Promise.all(
      filtered.map(async (player) => {
        const leagueStat = await ctx.db
          .query("playerStats")
          .withIndex("by_league_player", (q) => q.eq("leagueId", args.leagueId).eq("espnId", player!.espnId).eq("season", args.seasonId))
          .first();
        const extracted = leagueStat ? extractActualStats(leagueStat, args.seasonId) : null;
        const finalStats = extracted && extracted.actualTotal > 0
          ? extracted
          : {
              actualTotal: player!.actualStats?.["120"] || 0,
              actualAverage: (player!.actualStats?.["120"] || 0) / Math.max(player!.actualStats?.["102"] || 1, 1),
              gamesPlayed: player!.actualStats?.["102"] || 0,
            };
        return {
          espnId: player!.espnId,
          fullName: player!.fullName,
          defaultPosition: player!.defaultPosition,
          proTeamAbbrev: player!.proTeamAbbrev,
          injured: player!.injured,
          injuryStatus: player!.injuryStatus,
          ownership: player!.ownership,
          stats: {
            actualTotal: finalStats.actualTotal,
            actualAverage: finalStats.actualAverage,
            projectedTotal: player!.projectedStats?.["120"] || 0,
            gamesPlayed: finalStats.gamesPlayed || 0,
          },
          hasLeagueSpecificStats: !!(leagueStat && (extracted?.actualTotal || 0) > 0),
        };
      })
    );

    // Rank and return top requested
    return withStats
      .sort((a, b) => b.stats.actualTotal - a.stats.actualTotal)
      .slice(0, limit);
  },
});