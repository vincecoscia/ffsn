import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

export const getPlayersByTeam = query({
  args: { teamId: v.id("teams") },
  handler: async (ctx, args) => {
    // Get the team directly
    const team = await ctx.db.get(args.teamId);
    if (!team || !team.roster) return [];
    
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