/* eslint-disable @typescript-eslint/no-explicit-any */
import { internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { transformStats } from "./espnStatsMapping";
import { fetchEspn, normalizeEspnCredentials } from "./lib/espnClient";
import { matchupPeriodIdsFromSettings } from "./lib/leagueCalendar";
import { matchupPeriodWeeks } from "./lib/espnSettings";



// Helper function to transform roster data
const transformRosterData = (rosterData: any) => {
  if (!rosterData || !rosterData.entries) {
    console.log('No roster data found!!!');
    return undefined;
  }

  console.log('Roster data found!!!');
  console.log(rosterData);
  
  // Ensure appliedStatTotal is a valid number, default to 0 if missing
  const appliedStatTotal = typeof rosterData.appliedStatTotal === 'number' 
    ? rosterData.appliedStatTotal 
    : 0;

  return {
    appliedStatTotal,
    players: rosterData.entries.map((entry: any) => {
      const player = entry.playerPoolEntry?.player;
      if (!player) return null;

      // Get appliedStats from the actual stats (statSourceId: 0) and projected stats (statSourceId: 1)
      const actualStatsEntry = player.stats?.find((stat: any) => stat.statSourceId === 0);
      const projectedStatsEntry = player.stats?.find((stat: any) => stat.statSourceId === 1);
      
      const appliedStats = transformStats(actualStatsEntry ? actualStatsEntry.appliedStats : undefined);
      // ESPN sometimes omits appliedTotal (or sends a non-number); guard
      // rather than throw on `.toFixed` of undefined.
      const projectedPoints = typeof projectedStatsEntry?.appliedTotal === "number"
        ? parseFloat(projectedStatsEntry.appliedTotal.toFixed(1))
        : undefined;
      const projectedStats = transformStats(projectedStatsEntry ? projectedStatsEntry.appliedStats : undefined);

      // Ensure appliedStatTotal is a valid number for the player too
      const playerAppliedStatTotal = typeof entry.playerPoolEntry?.appliedStatTotal === 'number'
        ? entry.playerPoolEntry.appliedStatTotal
        : 0;

      // Helper function for position names
      const getPositionName = (positionId: number): string => {
        const positionMap: { [key: number]: string } = {
          1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST'
        };
        return positionMap[positionId] || 'FLEX';
      };

      return {
        lineupSlotId: entry.lineupSlotId,
        espnId: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        fullName: player.fullName,
        position: getPositionName(player.defaultPositionId),
        points: playerAppliedStatTotal,
        appliedStats: appliedStats,
        projectedPoints: projectedPoints,
        projectedStats: projectedStats,
      };
    }).filter((player: any) => player !== null),
  };
};

// Fetch matchup rosters for specific scoring periods
// Not called from src/; only invoked internally as part of the ESPN sync pipeline
// (espnSync.ts), so this is internal-only. See convex/lib/auth.ts for the
// authorization model applied to the public entry points that trigger it.
export const fetchMatchupRosters = internalAction({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    matchupPeriods: v.optional(v.array(v.number())), // If not provided, will determine from league settings
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    totalPeriods: number;
    successfulPeriods: number;
    results: any[];
    message: string;
  }> => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    
    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    const creds = normalizeEspnCredentials(league.espnData);

    // Determine matchup periods to fetch (`matchupPeriodIdsFromSettings`,
    // convex/lib/leagueCalendar.ts: the exact ESPN period ids from the
    // league's parsed `matchupPeriods` map when available, else
    // regularSeasonMatchupPeriods + playoffRounds x playoffMatchupPeriodLength,
    // else the historic 14 + 4 default).
    const leagueMatchupPeriods = league.settings?.matchupPeriods;
    const periodsToFetch = args.matchupPeriods || matchupPeriodIdsFromSettings(league.settings);

    const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${args.seasonId}/segments/0/leagues/${league.externalId}`;
    const results = [];

    console.log(`Fetching matchup rosters for ${periodsToFetch.length} periods...`);

    for (const matchupPeriod of periodsToFetch) {
      try {
        // A matchup period spanning several NFL scoring periods (a 2-week
        // playoff round) is not itself a valid `scoringPeriodId` - ESPN's
        // roster-for-scoring-period data is keyed by the individual NFL week,
        // so request the LAST scoring period the round spans (that week's
        // roster/score is the round's final one; a mid-round week is never
        // more current). A normal 1:1 period falls back to its own number.
        const periodWeeks = matchupPeriodWeeks(leagueMatchupPeriods, matchupPeriod);
        const scoringPeriodId = periodWeeks && periodWeeks.length > 0 ? Math.max(...periodWeeks) : matchupPeriod;

        console.log(`Fetching rosters for matchup period ${matchupPeriod} (scoring period ${scoringPeriodId})...`);

        const { response } = await fetchEspn(
          `${baseUrl}?scoringPeriodId=${scoringPeriodId}&view=mBoxscore&view=mMatchupScore&view=mRoster&view=mSettings&view=mStatus&view=mTeam&view=mTransactions2&view=modular&view=mNav`,
          { creds }
        );

        if (!response.ok) {
          console.warn(`Failed to fetch matchup period ${matchupPeriod}: ${response.status}`);
          results.push({ matchupPeriod, success: false, error: `HTTP ${response.status}` });
          continue;
        }

        const data = await response.json();
        const schedule = data.schedule || [];
        
        // Filter schedule to only this matchup period and update rosters
        const matchupsForPeriod = schedule.filter((matchup: any) => matchup.matchupPeriodId === matchupPeriod);
        
        if (matchupsForPeriod.length > 0) {
          console.log(`Found ${matchupsForPeriod.length} matchups for period ${matchupPeriod}`);
          
          // Prepare roster updates for this period
          const rosterUpdates = matchupsForPeriod.map((matchup: any) => ({
            matchupPeriod: matchup.matchupPeriodId,
            scoringPeriod: matchup.id,
            homeTeamId: matchup.home?.teamId?.toString() || '',
            awayTeamId: matchup.away?.teamId?.toString() || '',
            homeRoster: transformRosterData(matchup.home?.rosterForCurrentScoringPeriod),
            awayRoster: transformRosterData(matchup.away?.rosterForCurrentScoringPeriod),
          }));

          // Update matchups with roster data using internal mutation
          await ctx.runMutation(internal.matchupRosters.updateMatchupRosters, {
            leagueId: args.leagueId,
            seasonId: args.seasonId,
            matchupPeriod,
            matchupsData: rosterUpdates,
          });

          results.push({ 
            matchupPeriod, 
            success: true, 
            matchupsCount: matchupsForPeriod.length,
            rostersFound: matchupsForPeriod.filter((m: any) => m.home?.rosterForCurrentScoringPeriod || m.away?.rosterForCurrentScoringPeriod).length
          });
        } else {
          results.push({ matchupPeriod, success: false, error: 'No matchups found for this period' });
        }

        // Small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`Error fetching matchup period ${matchupPeriod}:`, error);
        results.push({ 
          matchupPeriod, 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`Matchup roster fetch completed: ${successCount}/${periodsToFetch.length} periods successful`);

    return {
      success: successCount > 0,
      totalPeriods: periodsToFetch.length,
      successfulPeriods: successCount,
      results,
      message: `Fetched rosters for ${successCount}/${periodsToFetch.length} matchup periods`
    };
  },
});

// Internal mutation to update matchup rosters
export const updateMatchupRosters = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    matchupPeriod: v.number(),
    matchupsData: v.array(v.object({
      matchupPeriod: v.number(),
      scoringPeriod: v.number(),
      homeTeamId: v.string(),
      awayTeamId: v.string(),
      homeRoster: v.optional(v.any()),
      awayRoster: v.optional(v.any()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    for (const matchupData of args.matchupsData) {
      // Find existing matchup
      const existingMatchup = await ctx.db
        .query("matchups")
        .withIndex("by_unique_matchup", (q) => 
          q.eq("leagueId", args.leagueId)
           .eq("seasonId", args.seasonId)
           .eq("matchupPeriod", matchupData.matchupPeriod)
           .eq("homeTeamId", matchupData.homeTeamId)
           .eq("awayTeamId", matchupData.awayTeamId)
        )
        .first();

      if (existingMatchup) {
        // Update only the roster data
        await ctx.db.patch(existingMatchup._id, {
          homeRoster: matchupData.homeRoster,
          awayRoster: matchupData.awayRoster,
          updatedAt: now,
        });
        
        console.log(`Updated rosters for matchup period ${matchupData.matchupPeriod}: ${matchupData.homeTeamId} vs ${matchupData.awayTeamId}`);
      } else {
        console.warn(`Matchup not found for period ${matchupData.matchupPeriod}: ${matchupData.homeTeamId} vs ${matchupData.awayTeamId}`);
      }
    }
  },
});