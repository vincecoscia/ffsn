import { v } from "convex/values";
import { internalQuery, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
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

/* -------------------------------------------------------------------------- *
 * Manager identity (spec section 2)
 *
 * `teams.owner` is an ESPN owner string (frequently an opaque GUID) and is never
 * a Convex user id. The manager's *display* name is resolved here: ESPN's
 * `ownerInfo` first, then the user who claimed the team for the league's current
 * season (`teamClaims.userId` is a Clerk id -> `users.by_clerk_id`), then
 * "Unknown". Every payload that carries a `manager` / `teamAOwner` / `teamBOwner`
 * uses this, so the prompt layer never prints a raw ESPN owner id.
 * -------------------------------------------------------------------------- */

const UNKNOWN_MANAGER = "Unknown";

/** ESPN-provided display name for a team's owner, or null when unusable. */
function espnManagerName(team: Doc<"teams">): string | null {
  const info = team.ownerInfo;
  if (!info) return null;
  const full = [info.firstName, info.lastName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .trim();
  if (full) return full;
  const display = info.displayName?.trim();
  return display ? display : null;
}

/** The name of the user who claimed this team for `seasonId`, or null. */
async function claimedManagerName(
  ctx: QueryCtx,
  teamId: Id<"teams">,
  seasonId: number
): Promise<string | null> {
  const claim = await ctx.db
    .query("teamClaims")
    .withIndex("by_team_season", (q) =>
      q.eq("teamId", teamId).eq("seasonId", seasonId)
    )
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();
  if (!claim) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", claim.userId))
    .unique();
  const name = user?.name?.trim();
  return name ? name : null;
}

/** Convex team id -> manager display name for every team passed in. */
async function buildManagerNames(
  ctx: QueryCtx,
  teams: Array<Doc<"teams">>,
  seasonId: number
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const team of teams) {
    const fromEspn = espnManagerName(team);
    if (fromEspn) {
      names.set(team._id, fromEspn);
      continue;
    }
    names.set(
      team._id,
      (await claimedManagerName(ctx, team._id, seasonId)) ?? UNKNOWN_MANAGER
    );
  }
  return names;
}

// Get comprehensive league data for AI content generation
export const getLeagueDataForAI = internalQuery({
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
    // Infer league type (Redraft | Keeper | Dynasty)
    let inferredLeagueType: string = "Redraft";
    try {
      // Get current season's draft settings from leagueSeasons
      const currentLeagueSeason = leagueSeasons.find(ls => ls.seasonId === currentSeason);
      
      if (currentLeagueSeason?.draftSettings?.keeperCount) {
        const keeperCount = currentLeagueSeason.draftSettings.keeperCount;
        
        if (keeperCount === 0) {
          inferredLeagueType = "Redraft";
        } else if (keeperCount >= 8) {
          // High keeper count suggests Dynasty format
          inferredLeagueType = "Dynasty";
        } else {
          // Moderate keeper count (1-7) suggests Keeper format
          inferredLeagueType = "Keeper";
        }
      } else {
        // Fallback: Check if any recent seasons had keepers
        const hasKeepers = leagueSeasons
          .slice(0, 3) // Check last 3 seasons
          .some(ls => ls.draftSettings?.keeperCount && ls.draftSettings.keeperCount > 0);
        
        if (hasKeepers) {
          // If any recent season had keepers, assume it's at least a Keeper league
          const maxKeepers = Math.max(
            ...leagueSeasons
              .slice(0, 3)
              .map(ls => ls.draftSettings?.keeperCount || 0)
          );
          
          inferredLeagueType = maxKeepers >= 8 ? "Dynasty" : "Keeper";
        }
      }
    } catch (e) {
      // Default stays Redraft if inference fails
    }

    
    // Calculate standings
    const standings = teams
      .sort((a, b) => {
        // Sort by wins first
        if (a.record.wins !== b.record.wins) {
          return (b.record.wins || 0) - (a.record.wins || 0);
        }
        // Then by win percentage
        const aTotalGames = (a.record.wins || 0) + (a.record.losses || 0) + (a.record.ties || 0);
        const bTotalGames = (b.record.wins || 0) + (b.record.losses || 0) + (b.record.ties || 0);
        const aWinPct = aTotalGames > 0 ? (a.record.wins || 0) / aTotalGames : 0;
        const bWinPct = bTotalGames > 0 ? (b.record.wins || 0) / bTotalGames : 0;
        if (aWinPct !== bWinPct) {
          return bWinPct - aWinPct;
        }
        // Then by points for (tiebreaker)
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
        nflTeam?: string;
        fantasyTeamId: string;
        fantasyTeamName: string;
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
        manager: espnManagerName(team) || team.owner || UNKNOWN_MANAGER,
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
          team: player.team, // legacy: NFL team abbreviation
          nflTeam: player.team || undefined,
          fantasyTeamId: String(team.externalId),
          fantasyTeamName: team.name,
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
    
    // Manager display names for every current-season team (see the helpers above).
    const managerNames = await buildManagerNames(ctx, teams, currentSeason);

    // Debug roster availability
    console.log("Team roster check:", {
      totalTeams: teams.length,
      teamsWithRosters: teams.filter(t => t.roster && t.roster.length > 0).length,
      firstTeamRosterSize: teams[0]?.roster?.length || 0
    });
    
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
      
      // Enrich roster with player stats from playersEnhanced
      const enrichedRoster = team.roster.map((rosterPlayer: any) => {
        // Find the enhanced player data
        const enhancedPlayer = playersEnhanced.find((p: any) => 
          p.espnId === rosterPlayer.playerId && p.season === currentSeason
        );
        
        // Get stats from playerStats if available
        const playerStats = enhancedPlayer ? {
          seasonStats: {
            appliedTotal: enhancedPlayer.actualStats?.["120"] || 0, // Total fantasy points
            projectedTotal: enhancedPlayer.projectedStats?.["120"] || 0,
            averagePoints: (enhancedPlayer.actualStats?.["102"] || 0) > 0 
              ? (enhancedPlayer.actualStats?.["120"] || 0) / (enhancedPlayer.actualStats?.["102"] || 1)
              : 0,
            gamesPlayed: enhancedPlayer.actualStats?.["102"] || 0,
          },
          recentPerformance: {
            avgPoints: 0, // Would need to calculate from recent games
            trend: "stable" as const,
          }
        } : null;
        
        const nflTeam = enhancedPlayer?.proTeamAbbrev || rosterPlayer.team || undefined;

        return {
          ...rosterPlayer,
          playerId: rosterPlayer.playerId, // This is the ESPN ID
          espnId: rosterPlayer.playerId, // Make it clear this is ESPN ID
          fullName: enhancedPlayer?.fullName || rosterPlayer.playerName,
          playerName: enhancedPlayer?.fullName || rosterPlayer.playerName,
          position: enhancedPlayer?.defaultPosition || rosterPlayer.position,
          // Legacy key, unchanged: the NFL team abbreviation. New code reads the
          // three explicit keys below (spec section 4.3) and never this one.
          team: nflTeam,
          nflTeam,
          fantasyTeamId: String(team.externalId),
          fantasyTeamName: team.name,
          injured: enhancedPlayer?.injured || false,
          injuryStatus: enhancedPlayer?.injuryStatus,
          stats: playerStats,
        };
      });
      
      return {
        id: team._id,
        name: team.name,
        // Legacy key, unchanged: the raw ESPN owner string. `manager` is the
        // display name the prompt layer prints.
        owner: team.owner,
        manager: managerNames.get(team._id) ?? UNKNOWN_MANAGER,
        logo: team.logo,
        abbreviation: team.abbreviation,
        record: team.record,
        pointsFor: team.record.pointsFor ?? 0,
        pointsAgainst: team.record.pointsAgainst ?? 0,
        roster: enrichedRoster,
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
        // Same shape getWeeklyRecapDataForAI produces: names, external ids and
        // manager display names, so the prompt layer never has to guess which
        // of teamA/teamB is a name and which is an id.
        teamA: homeTeam?.name || matchup.homeTeamId,
        teamB: awayTeam?.name || matchup.awayTeamId,
        teamAId: matchup.homeTeamId,
        teamBId: matchup.awayTeamId,
        teamAOwner: homeTeam ? managerNames.get(homeTeam._id) ?? UNKNOWN_MANAGER : UNKNOWN_MANAGER,
        teamBOwner: awayTeam ? managerNames.get(awayTeam._id) ?? UNKNOWN_MANAGER : UNKNOWN_MANAGER,
        scoreA: matchup.homeScore,
        scoreB: matchup.awayScore,
        projectedScoreA: matchup.homeProjectedScore,
        projectedScoreB: matchup.awayProjectedScore,
        // Kept for compatibility with existing readers.
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
      leagueType: inferredLeagueType,
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
export const getMatchupDataForAI = internalQuery({
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
export const getWeeklyPlayerDataForAI = internalQuery({
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
      /** Legacy: the NFL team abbreviation. */
      team: string;
      nflTeam?: string;
      fantasyTeamId: string;
      fantasyTeamName: string;
      /** Legacy alias of `fantasyTeamName`. */
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
            nflTeam: player.team || undefined,
            fantasyTeamId: String(team.externalId),
            fantasyTeamName: team.name,
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
export const getMockDraftDataForAI = internalQuery({
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

      // Manager display names, never the raw ESPN owner string (spec section 2).
      const managerNames = await buildManagerNames(ctx, teams, targetSeason);
      
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
            // Get the target season's projected stats (find the entry with
            // matching externalId and statSourceId 1)
            const projectedStats = player.stats && Array.isArray(player.stats)
              ? player.stats.find((stat: any) =>
                  stat.externalId === String(targetSeason) &&
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
              // Free agents have no fantasy team; the NFL team is still explicit.
              nflTeam: player.proTeamAbbrev || undefined,
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
            manager: (team ? managerNames.get(team._id) : undefined) ?? UNKNOWN_MANAGER,
          };
        });
      } else if (teams.length > 0) {
        // If no draft order is set, create one based on available teams
        draftOrder = teams.map((team, index) => ({
          position: index + 1,
          teamId: team.externalId,
          teamName: team.name,
          manager: managerNames.get(team._id) ?? UNKNOWN_MANAGER,
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
          owner: team.owner, // legacy: raw ESPN owner string
          manager: managerNames.get(team._id) ?? UNKNOWN_MANAGER,
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
export const getSeasonWelcomeDataForAI = internalQuery({
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
          nflTeam?: string;
          fantasyTeamId: string;
          fantasyTeamName: string;
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
            manager: espnManagerName(team) || team.owner || UNKNOWN_MANAGER,
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
              team: player.team, // legacy: NFL team abbreviation
              nflTeam: player.team || undefined,
              fantasyTeamId: String(team.externalId),
              fantasyTeamName: team.name,
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
      const basicLeagueData: any = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
      });
      
      // Collect memorable moments across recent seasons
      const memorableMoments: Array<any> = [];

      // We'll analyze the last 3 historical seasons for performance & moments
      const seasonsToAnalyze = leagueSeasons
        .filter(s => s.seasonId !== currentSeason)
        .sort((a, b) => b.seasonId - a.seasonId)
        .slice(0, 3);

      for (const season of seasonsToAnalyze) {
        const seasonId = season.seasonId;
        try {
          // Teams and standings for this season
          const seasonTeams = await ctx.db
            .query("teams")
            .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
            .collect();

          const seasonStandings = [...seasonTeams]
            .sort((a, b) => {
              if ((b.record?.wins || 0) !== (a.record?.wins || 0)) return (b.record?.wins || 0) - (a.record?.wins || 0);
              return (b.record?.pointsFor || 0) - (a.record?.pointsFor || 0);
            })
            .map((t, idx) => ({
              externalId: t.externalId,
              name: t.name,
              owner: t.owner,
              rank: idx + 1,
              playoffSeed: t.record?.playoffSeed,
            }));

          const playoffTeamsCount = season.settings?.playoffTeamCount || league.settings?.playoffTeamCount || 6;

          // 1) Championship game moments (and detect unlikely champions by seed)
          try {
            // Prefer explicit CHAMPIONSHIP flag if present
            const explicitChampionshipGames = await ctx.db
              .query("matchups")
              .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .filter(q => q.eq(q.field("playoffTier"), "CHAMPIONSHIP"))
              .collect();

            let championshipGames = explicitChampionshipGames;

            if (!championshipGames || championshipGames.length === 0) {
              // Fallback: last Winners Bracket game(s) of the season
              const playoffGames = await ctx.db
                .query("matchups")
                .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
                .filter(q => q.eq(q.field("playoffTier"), "WINNERS_BRACKET"))
                .collect();

              if (playoffGames && playoffGames.length > 0) {
                const maxPeriod = Math.max(...playoffGames.map(g => g.matchupPeriod));
                championshipGames = playoffGames.filter(g => g.matchupPeriod === maxPeriod);
              }
            }

            if (championshipGames && championshipGames.length > 0) {
              // Usually one game; handle multiple just in case
              for (const game of championshipGames) {
                const margin = Math.abs(game.homeScore - game.awayScore);
                const total = (game.homeScore || 0) + (game.awayScore || 0);
                const closenessPct = total > 0 ? (margin / total) : 1;
                const winnerIsHome = (game.winner === 'home') || (game.homeScore > game.awayScore);
                const winnerTeamId = winnerIsHome ? game.homeTeamId : game.awayTeamId;
                const loserTeamId = winnerIsHome ? game.awayTeamId : game.homeTeamId;

                const winnerTeam = seasonTeams.find(t => t.externalId === winnerTeamId);
                const loserTeam = seasonTeams.find(t => t.externalId === loserTeamId);

                memorableMoments.push({
                  type: 'championship',
                  seasonId,
                  description: closenessPct <= 0.05
                    ? `Championship thriller: ${winnerTeam?.name || winnerTeamId} edged ${loserTeam?.name || loserTeamId} by ${margin.toFixed(1)} points`
                    : `Champion crowned: ${winnerTeam?.name || winnerTeamId} defeated ${loserTeam?.name || loserTeamId} by ${margin.toFixed(1)} points`,
                  details: {
                    winner: winnerTeam?.name || winnerTeamId,
                    winnerOwner: winnerTeam?.owner,
                    loser: loserTeam?.name || loserTeamId,
                    loserOwner: loserTeam?.owner,
                    score: `${game.homeScore.toFixed(1)}-${game.awayScore.toFixed(1)}`,
                    margin,
                  },
                });

                // Unlikely champion: low playoff seed won it all
                const winnerStanding = seasonStandings.find(s => s.externalId === winnerTeamId);
                const seed = winnerStanding?.playoffSeed ?? winnerStanding?.rank;
                if (seed && (seed > Math.ceil(playoffTeamsCount / 2) || seed >= 5)) {
                  memorableMoments.push({
                    type: 'unlikely_champion',
                    seasonId,
                    description: `Unlikely champion: ${winnerTeam?.name || winnerTeamId} won from seed #${seed}`,
                    details: {
                      team: winnerTeam?.name || winnerTeamId,
                      owner: winnerTeam?.owner,
                      seed,
                      playoffTeams: playoffTeamsCount,
                    }
                  });
                }
              }
            }
          } catch (e) {
            // Ignore championship computation errors per season
          }

          // 2) Close, playoff-implication matchups in final regular season week
          try {
            // Determine last regular-season week dynamically if possible (max matchupPeriod among non-playoff games)
            const allSeasonMatchups = await ctx.db
              .query("matchups")
              .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .collect();
            const regularSeasonGames = allSeasonMatchups.filter(m => !m.playoffTier);
            const inferredLastRegularWeek = regularSeasonGames.length > 0
              ? Math.max(...regularSeasonGames.map(g => g.matchupPeriod))
              : undefined;
            const configuredLastWeek = season.settings?.regularSeasonMatchupPeriods || league.settings?.regularSeasonMatchupPeriods || 13;
            const lastRegularWeek = inferredLastRegularWeek || configuredLastWeek;

            const finalWeekGames = regularSeasonGames.filter(g => g.matchupPeriod === lastRegularWeek);
            if (finalWeekGames && finalWeekGames.length > 0) {
              const cutoff = playoffTeamsCount;
              const bubbleTeamIds = new Set<string>();
              seasonStandings.forEach(s => {
                if (s.rank === cutoff || s.rank === cutoff + 1 || s.rank === cutoff - 1) {
                  bubbleTeamIds.add(s.externalId);
                }
              });
              for (const g of finalWeekGames) {
                const isBubbleGame = bubbleTeamIds.has(g.homeTeamId) || bubbleTeamIds.has(g.awayTeamId);
                const margin = Math.abs(g.homeScore - g.awayScore);
                const total = (g.homeScore || 0) + (g.awayScore || 0);
                const isNailBiter = total > 0 && (margin / total) <= 0.05 || margin <= 5;
                if (isBubbleGame && isNailBiter) {
                  const home = seasonStandings.find(s => s.externalId === g.homeTeamId);
                  const away = seasonStandings.find(s => s.externalId === g.awayTeamId);
                  memorableMoments.push({
                    type: 'playoff_clincher',
                    seasonId,
                    description: `Playoff-clinching nail-biter in Week ${lastRegularWeek}: ${g.homeScore > g.awayScore ? (home?.name || g.homeTeamId) : (away?.name || g.awayTeamId)} won by ${margin.toFixed(1)} points`,
                    details: {
                      week: lastRegularWeek,
                      homeTeam: home?.name || g.homeTeamId,
                      awayTeam: away?.name || g.awayTeamId,
                      score: `${g.homeScore.toFixed(1)}-${g.awayScore.toFixed(1)}`,
                      margin,
                    }
                  });
                }
              }
            }
          } catch (e) {
            // Ignore per-season errors
          }

          // 2b) Major playoff upsets (non-championship) in Winners Bracket
          try {
            const winnersBracket = await ctx.db
              .query("matchups")
              .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .filter(q => q.eq(q.field("playoffTier"), "WINNERS_BRACKET"))
              .collect();
            if (winnersBracket && winnersBracket.length > 0) {
              const maxPeriod = Math.max(...winnersBracket.map(g => g.matchupPeriod));
              const earlierRounds = winnersBracket.filter(g => g.matchupPeriod < maxPeriod);
              for (const g of earlierRounds) {
                if (g.homeProjectedScore && g.awayProjectedScore) {
                  const projectedWinnerIsHome = g.homeProjectedScore >= g.awayProjectedScore;
                  const actualWinnerIsHome = (g.winner === 'home') || (g.homeScore > g.awayScore);
                  const projDiff = Math.abs(g.homeProjectedScore - g.awayProjectedScore);
                  if (projDiff >= 10 && projectedWinnerIsHome !== actualWinnerIsHome) {
                    const home = seasonStandings.find(s => s.externalId === g.homeTeamId);
                    const away = seasonStandings.find(s => s.externalId === g.awayTeamId);
                    const margin = Math.abs(g.homeScore - g.awayScore);
                    memorableMoments.push({
                      type: 'playoff_upset',
                      seasonId,
                      description: `Playoff upset: ${(actualWinnerIsHome ? (home?.name || g.homeTeamId) : (away?.name || g.awayTeamId))} flipped projections by ${projDiff.toFixed(1)} pts and won by ${margin.toFixed(1)}`,
                      details: {
                        week: g.matchupPeriod,
                        homeTeam: home?.name || g.homeTeamId,
                        awayTeam: away?.name || g.awayTeamId,
                        score: `${g.homeScore.toFixed(1)}-${g.awayScore.toFixed(1)}`,
                        projectedHome: g.homeProjectedScore,
                        projectedAway: g.awayProjectedScore,
                        margin,
                      }
                    });
                  }
                }
              }
            }
          } catch (e) {
            // ignore
          }

          // Helper to get season-level actual vs projected totals for a player
          const getSeasonPlayerInfo = async (espnId: string): Promise<{ actual?: number; projected?: number; name?: string; position?: string; } | undefined> => {
            // Prefer league-specific stats if available
            const leagueSpecific = await ctx.db
              .query("playerStats")
              .withIndex("by_league_player", q => q.eq("leagueId", args.leagueId).eq("espnId", espnId).eq("season", seasonId))
              .first();
            const statsSource = leagueSpecific?.stats;
            const readFrom = async (): Promise<any | undefined> => {
              if (Array.isArray(statsSource)) return statsSource;
              const enhanced = await ctx.db
                .query("playersEnhanced")
                .withIndex("by_espn_id_season", q => q.eq("espnId", espnId).eq("season", seasonId))
                .first();
              return enhanced?.stats;
            };
            const enhancedForMeta = await ctx.db
              .query("playersEnhanced")
              .withIndex("by_espn_id_season", q => q.eq("espnId", espnId).eq("season", seasonId))
              .first();
            const stats = await readFrom();
            if (!stats || !Array.isArray(stats)) return { name: enhancedForMeta?.fullName, position: enhancedForMeta?.defaultPosition };
            const seasonActual = stats.find((s: any) => s.statSourceId === 0 && s.scoringPeriodId === 0);
            const seasonProj = stats.find((s: any) => s.statSourceId === 1 && s.scoringPeriodId === 0);
            return {
              actual: seasonActual?.appliedTotal,
              projected: seasonProj?.appliedTotal,
              name: enhancedForMeta?.fullName,
              position: enhancedForMeta?.defaultPosition,
            };
          };

          // 3) Blockbuster trades (many players or high impact)
          try {
            const trades = await ctx.db
              .query("trades")
              .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .order("desc")
              .take(50);
            const rankedTrades: Array<{ trade: any; impactScore: number; totalPlayers: number; summary: string; }> = [];
            for (const tr of trades) {
              const totalPlayers = (tr.playersFromTeamA?.length || 0) + (tr.playersFromTeamB?.length || 0);
              let impactScore = 0;
              const names: string[] = [];
              const all = [...(tr.playersFromTeamA || []), ...(tr.playersFromTeamB || [])];
              for (const p of all) {
                names.push(p.playerName);
                const totals = await getSeasonPlayerInfo(p.playerId);
                if (totals?.actual) impactScore += totals.actual;
              }
              const summary = `${tr.teamA?.teamName} ↔ ${tr.teamB?.teamName}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`;
              rankedTrades.push({ trade: tr, impactScore, totalPlayers, summary });
            }
            rankedTrades
              .sort((a, b) => (b.totalPlayers - a.totalPlayers) || (b.impactScore - a.impactScore))
              .slice(0, 3)
              .forEach(rt => {
                memorableMoments.push({
                  type: 'blockbuster_trade',
                  seasonId,
                  description: `Blockbuster trade: ${rt.summary}`,
                  details: {
                    totalPlayers: rt.totalPlayers,
                    impactScore: Number(rt.impactScore.toFixed(1)),
                    tradeDate: rt.trade.tradeDate,
                  }
                });
              });
          } catch (e) {
            // ignore
          }

          // 4) Great in-season waiver pickups (adds from FA with strong actual >> projected)
          try {
            const txns = await ctx.db
              .query("transactions")
              .withIndex("by_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", seasonId))
              .order("desc")
              .take(200);
            const bestPickups: Array<{ playerId: string; playerName: string; teamId: string; teamName: string; diff: number; actual: number; projected: number; }> = [];
            for (const t of txns) {
              if (!t.items || !Array.isArray(t.items)) continue;
              const addItem = t.items.find((it: any) => it.type === 'ADD' && it.fromTeamId === 0 && it.toTeamId !== 0);
              if (!addItem) continue;
              const playerId = addItem.playerId?.toString();
              if (!playerId) continue;
              const totals = await getSeasonPlayerInfo(playerId);
              if (!totals?.actual || !totals?.projected) continue;
              const diff = totals.actual - totals.projected;
              // Only consider meaningful overperformance with solid total
              if (diff >= 60 && totals.actual >= 150) {
                const acquiringTeam = seasonTeams.find(tm => tm.externalId === addItem.toTeamId.toString());
                bestPickups.push({
                  playerId,
                  playerName: totals.name || `Player ${playerId}`,
                  teamId: addItem.toTeamId.toString(),
                  teamName: acquiringTeam?.name || `Team ${addItem.toTeamId}`,
                  diff,
                  actual: totals.actual,
                  projected: totals.projected,
                });
              }
            }
            bestPickups
              .sort((a, b) => (b.diff - a.diff))
              .slice(0, 5)
              .forEach(pu => {
                memorableMoments.push({
                  type: 'waiver_pickup',
                  seasonId,
                  description: `Waiver gem: ${pu.playerName} added by ${pu.teamName} beat projections by ${pu.diff.toFixed(1)} pts (${pu.actual.toFixed(1)} vs ${pu.projected.toFixed(1)})`,
                  details: {
                    team: pu.teamName,
                    actual: Number(pu.actual.toFixed(1)),
                    projected: Number(pu.projected.toFixed(1)),
                  }
                });
              });
          } catch (e) {
            // ignore
          }

        } catch (e) {
          // Continue with other seasons
        }
      }

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
        // New: compiled memorable moments for season welcome prompts
        memorableMoments,
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
export const getWaiverWireDataForAI = internalQuery({
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
      const basicLeagueData: any = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
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
        // Process transactions based on the new schema with items array
        if (transaction.items && transaction.items.length > 0) {
          for (const item of transaction.items) {
            if (item.type === "ADD" && item.toTeamId !== 0) {
              const playerId = item.playerId.toString();
              transactionCounts[playerId] = (transactionCounts[playerId] || 0) + 1;
              
              // Get team info from teams data
              const team = basicLeagueData.teams.find((t: any) => t.externalId === item.toTeamId.toString());
              
              recentAdds.push({
                playerId: playerId,
                playerName: `Player ${playerId}`, // We'll need to look up player names separately
                position: "Unknown", // Position data not in transaction items
                date: new Date(transaction.proposedDate).toISOString(),
                teamName: team?.name || `Team ${item.toTeamId}`,
              });
            }
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
          // Waiver targets are free agents: NFL team only, no fantasy team.
          nflTeam: player.proTeamAbbrev || undefined,
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
              // Legacy key, unchanged: here it has always been the fantasy team
              // name. Read `nflTeam` / `fantasyTeamName` instead.
              team: team.name,
              nflTeam: p.nflTeam,
              fantasyTeamId: String(team.externalId),
              fantasyTeamName: team.name,
              position: p.position,
              status: p.injuryStatus || "QUESTIONABLE",
              fantasyTeam: team.name,
            })) || []
        ).slice(0, 20),
        
        // Required fields for content generation
        recentMatchups: basicLeagueData.recentMatchups.slice(0, 5),
        trades: [],
        transactions: recentTransactions.slice(0, 20).map(t => {
          // Extract player add/drop info from items array
          const addItem = t.items?.find((item: any) => item.type === "ADD");
          const dropItem = t.items?.find((item: any) => item.type === "DROP");
          const team = basicLeagueData.teams.find((team: any) => team.externalId === t.teamId);
          
          return {
            teamId: t.teamId,
            teamName: team?.name || `Team ${t.teamId}`,
            type: t.type,
            playerAdded: addItem ? {
              playerId: addItem.playerId.toString(),
              playerName: `Player ${addItem.playerId}`, // Would need player lookup
              position: "Unknown",
              team: "Unknown"
            } : undefined,
            playerDropped: dropItem ? {
              playerId: dropItem.playerId.toString(),
              playerName: `Player ${dropItem.playerId}`, // Would need player lookup
              position: "Unknown",
              team: "Unknown"
            } : undefined,
            date: new Date(t.proposedDate).toISOString(),
            faabBid: t.bidAmount > 0 ? t.bidAmount : undefined,
          };
        }),
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
export const getTradeAnalysisDataForAI = internalQuery({
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
      const basicLeagueData: any = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
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
          // Explicit ids (spec section 4.3). Fantasy ownership is stated
          // post-trade: what team A gave up now sits on team B.
          nflTeam: enhanced?.proTeamAbbrev || player.team || undefined,
          fantasyTeamId: String(teamBData?.externalId ?? targetTrade.teamB.teamId),
          fantasyTeamName: teamBData?.name ?? targetTrade.teamB.teamName,
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
          // Explicit ids (spec section 4.3). Fantasy ownership is stated
          // post-trade: what team B gave up now sits on team A.
          nflTeam: enhanced?.proTeamAbbrev || player.team || undefined,
          fantasyTeamId: String(teamAData?.externalId ?? targetTrade.teamA.teamId),
          fantasyTeamName: teamAData?.name ?? targetTrade.teamA.teamName,
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

// Get data for a specific week's recap - with roster data
export const getWeeklyRecapDataForAI = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    week: v.number(),
  },
  handler: async (ctx, args): Promise<{
    leagueName: string;
    currentWeek: number;
    currentSeason: number;
    teams: any;
    recentMatchups: any[];
    standingsAtWeek: any[];
    rivalries: any;
    playoffProbabilities: any;
    trades: any[];
    transactions: any[];
    managerActivity: any;
    standings: any[];
    scoringType: string;
    rosterSize: number;
    metadata: {
      dataFreshness: number;
      week: number;
      seasonId: number;
    };
  }> => {
    console.log("=== getWeeklyRecapDataForAI START ===");
    const startTime = Date.now();
    
    try {
      const league = await ctx.db.get(args.leagueId);
      if (!league) throw new Error("League not found");
      
      // Get basic league data
      const basicLeagueData = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
        leagueId: args.leagueId,
        currentWeek: args.week,
      });
      
      // Get matchups for the specific week with full roster data
      const weekMatchups = await ctx.db
        .query("matchups")
        .withIndex("by_league_season", q => 
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .filter(q => q.eq(q.field("matchupPeriod"), args.week))
        .collect();
      
      // Get teams for this season
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_season", q => 
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .collect();
      
      // Create a map of teamId to team data
      const teamMap = new Map(teams.map(team => [team.externalId, team]));

      // Manager display names and NFL teams come from the enriched league payload
      // (which already resolved ownerInfo / teamClaims and playersEnhanced), so
      // this query invents nothing of its own.
      const managerByExternalId = new Map<string, string>();
      const nflTeamByPlayerId = new Map<string, string>();
      for (const enrichedTeam of (basicLeagueData.teams ?? []) as any[]) {
        if (enrichedTeam?.externalId) {
          managerByExternalId.set(
            String(enrichedTeam.externalId),
            enrichedTeam.manager || UNKNOWN_MANAGER
          );
        }
        for (const rosterPlayer of (enrichedTeam?.roster ?? []) as any[]) {
          if (rosterPlayer?.playerId && rosterPlayer.nflTeam) {
            nflTeamByPlayerId.set(String(rosterPlayer.playerId), rosterPlayer.nflTeam);
          }
        }
      }
      const managerFor = (externalId: string | undefined) =>
        (externalId ? managerByExternalId.get(String(externalId)) : undefined) ?? UNKNOWN_MANAGER;
      
      // Categorize matchups by playoff tier
      const playoffMatchups = weekMatchups.filter(m => m.playoffTier === "WINNERS_BRACKET");
      const consolationMatchups = weekMatchups.filter(m => 
        m.playoffTier === "WINNERS_CONSOLATION_LADDER" || 
        m.playoffTier === "LOSERS_CONSOLATION_LADDER"
      );
      const regularSeasonMatchups = weekMatchups.filter(m => 
        !m.playoffTier || m.playoffTier === "NONE"
      );
      
      // Determine if this is a championship week (only one WINNERS_BRACKET game)
      const isChampionshipWeek = playoffMatchups.length === 1;
      
      console.log(`Week ${args.week} analysis: ${playoffMatchups.length} playoff games, ${consolationMatchups.length} consolation games, ${regularSeasonMatchups.length} regular season games`);
      if (isChampionshipWeek) {
        console.log("Championship game detected!");
      }
      
      // Helper function to enrich a matchup
      const enrichMatchup = (matchup: any, isPlayoffGame = false, isChampionshipGame = false) => {
        const homeTeam = teamMap.get(matchup.homeTeamId);
        const awayTeam = teamMap.get(matchup.awayTeamId);
        
        // Calculate memorable moments for this matchup
        const homeRoster = matchup.homeRoster?.players || [];
        const awayRoster = matchup.awayRoster?.players || [];
        
        // Separate starters from bench players
        // Every player carries its NFL team and its fantasy team as separate,
        // explicit keys (spec section 4.3). `team` keeps its legacy meaning in
        // this payload - the fantasy team name - and is no longer read on its own.
        const withTeamContext = (p: any, team: typeof homeTeam, fallbackId: string) => ({
          ...p,
          team: team?.name || fallbackId,
          nflTeam: nflTeamByPlayerId.get(String(p.espnId)),
          fantasyTeamId: String(team?.externalId ?? fallbackId),
          fantasyTeamName: team?.name || fallbackId,
        });

        const allPlayers = [
          ...homeRoster.map((p: any) => withTeamContext(p, homeTeam, matchup.homeTeamId)),
          ...awayRoster.map((p: any) => withTeamContext(p, awayTeam, matchup.awayTeamId))
        ];
        
        // Categorize players by lineup status
        const starters = allPlayers.filter(p => p.lineupSlotId !== 20 && p.lineupSlotId !== 21); // Not bench or IR
        const benchPlayers = allPlayers.filter(p => p.lineupSlotId === 20); // Bench only
        
        // Find top performing starters (prioritized)
        const topStarters = starters
          .sort((a, b) => b.points - a.points)
          .slice(0, isChampionshipGame ? 8 : 4)
          .map(player => ({
            playerName: player.fullName,
            position: player.position,
            points: player.points,
            projectedPoints: player.projectedPoints || 0,
            team: player.team,
            nflTeam: player.nflTeam,
            fantasyTeamId: player.fantasyTeamId,
            fantasyTeamName: player.fantasyTeamName,
            isStarter: true,
            lineupSlotId: player.lineupSlotId,
            overPerformance: player.projectedPoints ? 
              ((player.points - player.projectedPoints) / player.projectedPoints * 100).toFixed(1) : 0
          }));
        
        // Find bench players who would have made a meaningful difference
        const impactfulBenchPlayers = benchPlayers
          .filter(benchPlayer => {
            // Only consider bench players with decent scores
            if (benchPlayer.points < 15) return false;
            
            // Find the worst starter at the same position
            const samePositionStarters = starters.filter(s => s.position === benchPlayer.position);
            if (samePositionStarters.length === 0) return false;
            
            // Find the lowest scoring starter at this position
            const worstStarter = samePositionStarters.sort((a, b) => a.points - b.points)[0];
            
            // Only include if bench player significantly outperformed the worst starter
            const pointDifference = benchPlayer.points - worstStarter.points;
            return pointDifference >= 10; // At least 10 point improvement
          })
          .sort((a, b) => b.points - a.points)
          .slice(0, 2) // Max 2 impactful bench players
          .map(player => {
            // Calculate the actual impact
            const samePositionStarters = starters.filter(s => s.position === player.position);
            const worstStarter = samePositionStarters.sort((a, b) => a.points - b.points)[0];
            const pointDifference = player.points - worstStarter.points;
            
            return {
              playerName: player.fullName,
              position: player.position,
              points: player.points,
              projectedPoints: player.projectedPoints || 0,
              team: player.team,
              nflTeam: player.nflTeam,
              fantasyTeamId: player.fantasyTeamId,
              fantasyTeamName: player.fantasyTeamName,
              isStarter: false,
              lineupSlotId: player.lineupSlotId,
              overPerformance: player.projectedPoints ? 
                ((player.points - player.projectedPoints) / player.projectedPoints * 100).toFixed(1) : 0,
              benchImpact: true,
              wouldHaveReplacedPlayer: worstStarter.fullName,
              pointImprovementIfStarted: pointDifference.toFixed(1)
            };
          });
        
        // Combine top performers (starters first, then impactful bench players)
        const topPerformers = [...topStarters, ...impactfulBenchPlayers];
        
        // Calculate bench points
        const homeBenchPoints = homeRoster
          .filter((p: any) => p.lineupSlotId === 20) // Bench slot ID
          .reduce((sum: number, p: any) => sum + p.points, 0);
        
        const awayBenchPoints = awayRoster
          .filter((p: any) => p.lineupSlotId === 20)
          .reduce((sum: number, p: any) => sum + p.points, 0);
        
        // Determine closeness and upset
        const marginOfVictory = Math.abs(matchup.homeScore - matchup.awayScore);
        const totalPoints = matchup.homeScore + matchup.awayScore;
        const closeGameThreshold = totalPoints * 0.05; // 5% of total points
        
        let closeness = 'BLOWOUT';
        if (marginOfVictory <= closeGameThreshold) closeness = 'NAIL-BITER';
        else if (marginOfVictory <= closeGameThreshold * 2) closeness = 'CLOSE';
        
        const isUpset = matchup.homeProjectedScore && matchup.awayProjectedScore && (
          (matchup.winner === 'home' && matchup.awayProjectedScore > matchup.homeProjectedScore + 10) ||
          (matchup.winner === 'away' && matchup.homeProjectedScore > matchup.awayProjectedScore + 10)
        );
        
        // Create memorable moment - enhanced for playoff/championship games
        let memorableMoment = '';
        if (isChampionshipGame) {
          if (isUpset) {
            memorableMoment = `CHAMPIONSHIP UPSET! ${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} crowned champion against all odds!`;
          } else if (closeness === 'NAIL-BITER') {
            memorableMoment = `CHAMPIONSHIP THRILLER! Title decided by just ${marginOfVictory.toFixed(1)} points!`;
          } else {
            memorableMoment = `${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} claims the championship!`;
          }
        } else if (isPlayoffGame) {
          if (isUpset) {
            memorableMoment = `PLAYOFF UPSET! ${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} advances with a stunning victory!`;
          } else if (closeness === 'NAIL-BITER') {
            memorableMoment = `PLAYOFF THRILLER! ${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} survives by ${marginOfVictory.toFixed(1)} points!`;
          } else {
            memorableMoment = `${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} advances in the playoffs!`;
          }
        } else {
          if (isUpset) {
            memorableMoment = `Major upset! ${matchup.winner === 'home' ? homeTeam?.name : awayTeam?.name} defied the odds`;
          } else if (closeness === 'NAIL-BITER') {
            memorableMoment = `Down to the wire! Decided by just ${marginOfVictory.toFixed(1)} points`;
          } else if (Number(topPerformers[0]?.overPerformance) > 50) {
            memorableMoment = `${topPerformers[0].playerName} exploded for ${topPerformers[0].points.toFixed(1)} points!`;
          }
        }
        
        return {
          ...matchup,
          teamA: homeTeam?.name || matchup.homeTeamId,
          teamB: awayTeam?.name || matchup.awayTeamId,
          teamAId: matchup.homeTeamId,
          teamBId: matchup.awayTeamId,
          teamAName: homeTeam?.name || matchup.homeTeamId,
          teamBName: awayTeam?.name || matchup.awayTeamId,
          teamAOwner: managerFor(homeTeam?.externalId),
          teamBOwner: managerFor(awayTeam?.externalId),
          scoreA: matchup.homeScore,
          scoreB: matchup.awayScore,
          projectedScoreA: matchup.homeProjectedScore,
          projectedScoreB: matchup.awayProjectedScore,
          topPerformers,
          benchPointsA: homeBenchPoints,
          benchPointsB: awayBenchPoints,
          closeness,
          isUpset,
          memorableMoment,
          isPlayoffGame,
          isChampionshipGame,
          playoffTier: matchup.playoffTier,
          homeRoster: homeRoster.map((p: any) => ({
            ...p,
            teamName: homeTeam?.name || matchup.homeTeamId,
            nflTeam: nflTeamByPlayerId.get(String(p.espnId)),
            fantasyTeamId: String(homeTeam?.externalId ?? matchup.homeTeamId),
            fantasyTeamName: homeTeam?.name || matchup.homeTeamId,
            isStarter: p.lineupSlotId !== 20 && p.lineupSlotId !== 21,
            isBench: p.lineupSlotId === 20,
            isIR: p.lineupSlotId === 21,
          })),
          awayRoster: awayRoster.map((p: any) => ({
            ...p,
            teamName: awayTeam?.name || matchup.awayTeamId,
            nflTeam: nflTeamByPlayerId.get(String(p.espnId)),
            fantasyTeamId: String(awayTeam?.externalId ?? matchup.awayTeamId),
            fantasyTeamName: awayTeam?.name || matchup.awayTeamId,
            isStarter: p.lineupSlotId !== 20 && p.lineupSlotId !== 21,
            isBench: p.lineupSlotId === 20,
            isIR: p.lineupSlotId === 21,
          })),
        };
      };
      
      // Enrich matchups with priority order: Championship > Playoff > Consolation > Regular
      const enrichedPlayoffMatchups = playoffMatchups.map(m => 
        enrichMatchup(m, true, isChampionshipWeek)
      );
      const enrichedConsolationMatchups = consolationMatchups.map(m => 
        enrichMatchup(m, false, false)
      );
      const enrichedRegularMatchups = regularSeasonMatchups.map(m => 
        enrichMatchup(m, false, false)
      );
      
      // Combine all matchups with playoff games first
      const enrichedMatchups = [
        ...enrichedPlayoffMatchups,
        ...enrichedConsolationMatchups,
        ...enrichedRegularMatchups
      ];
      
      // Get all matchups up to this week for standings calculation
      const allMatchupsToWeek = await ctx.db
        .query("matchups")
        .withIndex("by_league_season", q => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
        .filter(q => q.lte(q.field("matchupPeriod"), args.week))
        .collect();
      
      // Get standings at this point in the season
      const standingsAtWeek = teams
        .map(team => {
          // Calculate record up to this week
          const teamMatchups = allMatchupsToWeek.filter(m => 
            (m.homeTeamId === team.externalId || m.awayTeamId === team.externalId) &&
            m.winner
          );
          
          let wins = 0, losses = 0, ties = 0;
          teamMatchups.forEach(m => {
            if (m.winner === 'tie') {
              ties++;
            } else if (
              (m.winner === 'home' && m.homeTeamId === team.externalId) ||
              (m.winner === 'away' && m.awayTeamId === team.externalId)
            ) {
              wins++;
            } else {
              losses++;
            }
          });
          
          return {
            teamId: team._id,
            teamName: team.name,
            externalId: team.externalId,
            owner: team.owner, // legacy: raw ESPN owner string
            manager: managerFor(team.externalId),
            wins,
            losses,
            ties,
            winPercentage: (wins + ties * 0.5) / Math.max(1, wins + losses + ties),
          };
        })
        .sort((a, b) => b.winPercentage - a.winPercentage);
      
      const result = {
        // Basic league info
        leagueName: league.name,
        currentWeek: args.week,
        currentSeason: args.seasonId,
        teams: basicLeagueData.teams,
        
        // Week-specific data with playoff prioritization
        recentMatchups: enrichedMatchups,
        standingsAtWeek,
        
        // NEW: Playoff-specific categorization for AI prioritization
        playoffBreakdown: {
          isPlayoffWeek: playoffMatchups.length > 0 || consolationMatchups.length > 0,
          isChampionshipWeek,
          playoffMatchups: enrichedPlayoffMatchups,
          consolationMatchups: enrichedConsolationMatchups,
          regularSeasonMatchups: enrichedRegularMatchups,
          playoffGameCount: playoffMatchups.length,
          consolationGameCount: consolationMatchups.length,
          regularGameCount: regularSeasonMatchups.length,
          championshipGame: isChampionshipWeek && enrichedPlayoffMatchups.length > 0 
            ? enrichedPlayoffMatchups[0] 
            : null,
        },
        
        // Context from basic data
        rivalries: basicLeagueData.rivalries,
        playoffProbabilities: basicLeagueData.playoffProbabilities,
        
        // Required fields for content generation
        trades: [], // Not needed for weekly recap
        transactions: basicLeagueData.transactions.slice(0, 10), // Recent transactions
        managerActivity: basicLeagueData.managerActivity,
        standings: standingsAtWeek,
        
        // Settings
        scoringType: league.settings?.scoringType || "PPR",
        rosterSize: league.settings?.rosterSize || 16,
        
        metadata: {
          dataFreshness: Date.now(),
          week: args.week,
          seasonId: args.seasonId,
          isPlayoffWeek: playoffMatchups.length > 0 || consolationMatchups.length > 0,
          isChampionshipWeek,
          totalMatchups: weekMatchups.length,
          playoffMatchups: playoffMatchups.length,
          consolationMatchups: consolationMatchups.length,
          regularSeasonMatchups: regularSeasonMatchups.length,
        },
      };
      
      const executionTime = Date.now() - startTime;
      console.log("=== getWeeklyRecapDataForAI SUCCESS ===");
      console.log("Execution time:", executionTime + "ms");
      console.log("Week:", args.week);
      console.log("Total matchups found:", enrichedMatchups.length);
      console.log("Playoff games (WINNERS_BRACKET):", playoffMatchups.length);
      console.log("Consolation games:", consolationMatchups.length);
      console.log("Regular season games:", regularSeasonMatchups.length);
      console.log("Is Championship Week:", isChampionshipWeek);
      
      return result;
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error("=== getWeeklyRecapDataForAI ERROR ===");
      console.error("Execution time before error:", executionTime + "ms");
      console.error("Error:", error);
      throw error;
    }
  },
});