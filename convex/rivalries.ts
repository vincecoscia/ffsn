import { query } from "./_generated/server";
import { v } from "convex/values";

export const getByLeague = query({
  args: { 
    leagueId: v.id("leagues")
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    const rivalries = await ctx.db
      .query("rivalries")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    return rivalries;
  },
});

export const calculateHistoricalRivalries = query({
  args: { 
    leagueId: v.id("leagues")
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    // Get all matchups for this league
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    // Get teams from the most recent season to map external IDs to team info
    const allTeams = await ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    // Find the most recent season
    const mostRecentSeason = Math.max(...allTeams.map(team => team.seasonId));
    
    // Filter teams to only include those from the most recent season
    const teams = allTeams.filter(team => team.seasonId === mostRecentSeason);

    // Create a map of external team IDs to team info
    const teamMap = new Map();
    teams.forEach(team => {
      teamMap.set(team.externalId, {
        _id: team._id,
        name: team.name,
        owner: team.owner,
        ownerInfo: team.ownerInfo,
        externalId: team.externalId
      });
    });

    // First, find the max matchupPeriod for each season to identify championship games
    const maxMatchupPeriodBySeason = new Map();
    matchups.forEach(matchup => {
      const currentMax = maxMatchupPeriodBySeason.get(matchup.seasonId) || 0;
      if (matchup.matchupPeriod > currentMax) {
        maxMatchupPeriodBySeason.set(matchup.seasonId, matchup.matchupPeriod);
      }
    });

    // Calculate head-to-head records
    const rivalryStats = new Map();
    
    matchups.forEach(matchup => {
      if (!matchup.winner || matchup.winner === "tie") return;
      
      const homeTeam = teamMap.get(matchup.homeTeamId);
      const awayTeam = teamMap.get(matchup.awayTeamId);
      
      if (!homeTeam || !awayTeam) return;
      
      // Create a consistent key for the matchup (always order by team ID)
      const teamA = homeTeam._id < awayTeam._id ? homeTeam : awayTeam;
      const teamB = homeTeam._id < awayTeam._id ? awayTeam : homeTeam;
      const key = `${teamA._id}-${teamB._id}`;
      
      if (!rivalryStats.has(key)) {
        rivalryStats.set(key, {
          teamA,
          teamB,
          teamAWins: 0,
          teamBWins: 0,
          ties: 0,
          totalGames: 0,
          avgPointDifferential: 0,
          playoffMeetings: 0,
          championshipMeetings: 0,
          recentMeetings: [],
          pointDifferentials: []
        });
      }
      
      const stats = rivalryStats.get(key);
      stats.totalGames++;
      
      // Determine winner
      const isTeamAHome = matchup.homeTeamId === teamA.externalId;
      const winner = matchup.winner;
      
      if ((isTeamAHome && winner === "home") || (!isTeamAHome && winner === "away")) {
        stats.teamAWins++;
      } else {
        stats.teamBWins++;
      }
      
      // Track playoff and championship meetings
      const isPlayoffGame = matchup.playoffTier === "WINNERS_BRACKET";
      const maxMatchupPeriod = maxMatchupPeriodBySeason.get(matchup.seasonId);
      const isChampionshipGame = isPlayoffGame && matchup.matchupPeriod === maxMatchupPeriod;
      
      if (isPlayoffGame) {
        stats.playoffMeetings++;
      }
      
      if (isChampionshipGame) {
        stats.championshipMeetings++;
      }
      
      // Track point differential for closeness calculation
      const pointDiff = Math.abs(matchup.homeScore - matchup.awayScore);
      if (!stats.pointDifferentials) stats.pointDifferentials = [];
      stats.pointDifferentials.push(pointDiff);
      
      // Add to recent meetings (keep last 5)
      stats.recentMeetings.unshift({
        seasonId: matchup.seasonId,
        week: matchup.matchupPeriod,
        homeTeam: matchup.homeTeamId,
        awayTeam: matchup.awayTeamId,
        homeScore: matchup.homeScore,
        awayScore: matchup.awayScore,
        winner: matchup.winner,
        isPlayoff: isPlayoffGame,
        isChampionship: isChampionshipGame
      });
      
      if (stats.recentMeetings.length > 5) {
        stats.recentMeetings.pop();
      }
    });
    
    // Convert to array and filter for meaningful rivalries with strict thresholds
    const rivalries = Array.from(rivalryStats.values())
      .filter(rivalry => rivalry.totalGames >= 4) // Need at least 4 games minimum
      .map(rivalry => {
        const winPercentageA = rivalry.teamAWins / rivalry.totalGames;
        const winPercentageB = rivalry.teamBWins / rivalry.totalGames;
        
        // Calculate average margin of victory (lower = closer games)
        const avgMarginOfVictory = rivalry.pointDifferentials.reduce((sum: number, diff: number) => sum + diff, 0) / rivalry.pointDifferentials.length;
        
        // Calculate competitiveness (0 = perfectly even, 1 = one team dominates)
        const recordCompetitiveness = Math.abs(rivalry.teamAWins - rivalry.teamBWins) / rivalry.totalGames;
        
        // Calculate rivalry qualification score to determine if this is a true rivalry
        let rivalryScore = 0;
        
        // Factor 1: Record closeness (0-25 points) - closer records = higher score
        const recordScore = (1 - recordCompetitiveness) * 25;
        rivalryScore += recordScore;
        
        // Factor 2: Game closeness (0-25 points) - closer games = higher score
        // Convert avg margin to score (inverse relationship, cap at 50 point margin)
        const gameClosenessScore = Math.max(0, (50 - avgMarginOfVictory) / 50 * 25);
        rivalryScore += gameClosenessScore;
        
        // Factor 3: Playoff meetings (10 points each) - high stakes encounters
        const playoffScore = rivalry.playoffMeetings * 10;
        rivalryScore += playoffScore;
        
        // Factor 4: Championship meetings (20 points each) - ultimate rivalry moments
        const championshipScore = rivalry.championshipMeetings * 20;
        rivalryScore += championshipScore;
        
        // Factor 5: Total games bonus (0-15 points) - more history matters
        const historyScore = Math.min(rivalry.totalGames * 1.5, 15);
        rivalryScore += historyScore;
        
        return {
          ...rivalry,
          winPercentageA,
          winPercentageB,
          competitiveness: recordCompetitiveness,
          avgMarginOfVictory,
          rivalryScore,
          // Keep these for the next filtering step
          tempRivalryScore: rivalryScore
        };
      })
      // STRICT RIVALRY THRESHOLD: Only meaningful rivalries pass
      .filter(rivalry => {
        // Automatic qualification criteria (bypass score threshold)
        if (rivalry.championshipMeetings >= 2) return true; // Multiple championships = automatic rivalry
        if (rivalry.championshipMeetings >= 1 && rivalry.playoffMeetings >= 2) return true; // Championship + playoffs
        if (rivalry.playoffMeetings >= 4) return true; // Lots of playoff history
        
        // Score-based qualification (need at least 40 points)
        if (rivalry.tempRivalryScore >= 40) return true;
        
        // Special case: Very close overall record + decent history + close games
        if (rivalry.competitiveness <= 0.25 && // Very close record (within 25%)
            rivalry.totalGames >= 6 && // Decent history
            rivalry.avgMarginOfVictory <= 20) return true; // Close games
        
        return false; // Not a rivalry
      })
      .map(rivalry => {
        // Now determine intensity for qualified rivalries (no more "casual")
        let intensity: "competitive" | "heated";
        
        // Heated criteria (premium rivalries)
        if (rivalry.tempRivalryScore >= 65 || 
            rivalry.championshipMeetings >= 2 ||
            (rivalry.championshipMeetings >= 1 && rivalry.playoffMeetings >= 2) ||
            (rivalry.competitiveness <= 0.15 && rivalry.avgMarginOfVictory <= 15)) {
          intensity = "heated";
        } else {
          intensity = "competitive";
        }
        
        // Clean up temp field and return final rivalry
        const { tempRivalryScore, ...finalRivalry } = rivalry;
        return {
          ...finalRivalry,
          intensity,
          intensityScore: rivalry.tempRivalryScore // Rename for consistency
        };
      })
      .sort((a, b) => {
        // Sort by intensity score first (highest intensity first)
        if (a.intensityScore !== b.intensityScore) {
          return b.intensityScore - a.intensityScore;
        }
        // Then by competitiveness (closer records = better rivalry)
        const aCompetitiveness = Math.abs(a.teamAWins - a.teamBWins);
        const bCompetitiveness = Math.abs(b.teamAWins - b.teamBWins);
        if (aCompetitiveness !== bCompetitiveness) {
          return aCompetitiveness - bCompetitiveness;
        }
        // Finally by total games
        return b.totalGames - a.totalGames;
      });

    return rivalries;
  },
});