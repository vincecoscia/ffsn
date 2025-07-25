/* eslint-disable @typescript-eslint/no-explicit-any */
import { action } from "./_generated/server";
import { v } from "convex/values";

// Helper function to fetch draft data for a specific season
async function fetchDraftData(leagueId: string, season: number, headers: HeadersInit): Promise<any> {
  try {
    const draftUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mDraftDetail&view=mSettings&view=mTeam&view=modular&view=mNav`;
    const response = await fetch(draftUrl, { headers });
    
    if (!response.ok) {
      console.warn(`Failed to fetch draft data for season ${season}: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    return data.draftDetail?.picks || null;
  } catch (error) {
    console.warn(`Error fetching draft data for season ${season}:`, error);
    return null;
  }
}

// Helper function to fetch historical league data
async function fetchHistoricalData(leagueId: string, headers: HeadersInit): Promise<any[]> {
  const currentYear = new Date().getFullYear();
  const history = [];
  
  // Try to fetch last 5 years of historical data
  for (let i = 1; i <= 5; i++) {
    const year = currentYear - i;
    try {
      const historicalUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${leagueId}?view=mSettings&view=mTeams`;
      const response = await fetch(historicalUrl, { headers });
      
      if (!response.ok) {
        console.warn(`Failed to fetch historical data for year ${year}: ${response.status}`);
        continue;
      }
      
      const data = await response.json();
      const teams = data.teams || [];
      
      if (teams.length === 0) continue;
      
      // Find champion (first seed in playoffs)
      const champion = teams
        .filter((team: any) => team.playoffSeed)
        .sort((a: any, b: any) => a.playoffSeed - b.playoffSeed)[0];
      
      // Find runner-up (second seed in playoffs)
      const runnerUp = teams
        .filter((team: any) => team.playoffSeed)
        .sort((a: any, b: any) => a.playoffSeed - b.playoffSeed)[1];
      
      // Find regular season champion (best record)
      const regularSeasonChamp = teams.sort((a: any, b: any) => {
        const aWinPct = a.record?.overall?.wins / (a.record?.overall?.wins + a.record?.overall?.losses || 1);
        const bWinPct = b.record?.overall?.wins / (b.record?.overall?.wins + b.record?.overall?.losses || 1);
        if (aWinPct !== bWinPct) return bWinPct - aWinPct;
        return (b.record?.overall?.pointsFor || 0) - (a.record?.overall?.pointsFor || 0);
      })[0];
      
      if (champion) {
        history.push({
          seasonId: year,
          winner: {
            teamId: champion.id?.toString() || '',
            teamName: champion.name || (champion.location && champion.nickname ? `${champion.location} ${champion.nickname}` : 'Unknown Team'),
            owner: champion.owners?.[0]?.displayName || champion.owners?.[0]?.firstName + ' ' + champion.owners?.[0]?.lastName || 'Unknown',
          },
          runnerUp: runnerUp ? {
            teamId: runnerUp.id?.toString() || '',
            teamName: runnerUp.name || (runnerUp.location && runnerUp.nickname ? `${runnerUp.location} ${runnerUp.nickname}` : 'Unknown Team'),
            owner: runnerUp.owners?.[0]?.displayName || runnerUp.owners?.[0]?.firstName + ' ' + runnerUp.owners?.[0]?.lastName || 'Unknown',
          } : undefined,
          regularSeasonChampion: regularSeasonChamp ? {
            teamId: regularSeasonChamp.id?.toString() || '',
            teamName: regularSeasonChamp.name || (regularSeasonChamp.location && regularSeasonChamp.nickname ? `${regularSeasonChamp.location} ${regularSeasonChamp.nickname}` : 'Unknown Team'),
            owner: regularSeasonChamp.owners?.[0]?.displayName || regularSeasonChamp.owners?.[0]?.firstName + ' ' + regularSeasonChamp.owners?.[0]?.lastName || 'Unknown',
          } : undefined,
        });
      }
      
      // Add small delay to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      console.warn(`Error fetching historical data for year ${year}:`, error);
      continue;
    }
  }
  
  return history.sort((a, b) => b.seasonId - a.seasonId); // Sort newest first
}

export const fetchLeagueData = action({
  args: {
    leagueId: v.string(),
    espnS2: v.optional(v.string()),
    swid: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      // Use fetch API to call ESPN directly in the Convex runtime
      const currentYear = new Date().getFullYear();
      const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${currentYear}/segments/0/leagues/${args.leagueId}`;
      
      const headers: HeadersInit = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      };
      
      if (args.espnS2 && args.swid) {
        // Decode URL-encoded espnS2 if needed  
        const espnS2 = decodeURIComponent(args.espnS2);
        headers['Cookie'] = `espn_s2=${espnS2}; SWID=${args.swid}`;
        console.log('Using ESPN authentication:', {
          hasEspnS2: !!args.espnS2,
          espnS2Length: args.espnS2.length,
          hasSwid: !!args.swid,
          swidFormat: args.swid.startsWith('{') && args.swid.endsWith('}')
        });
      }

      // Get basic league info with draft settings
      const leagueResponse = await fetch(`${baseUrl}?view=mSettings&view=mTeams&view=mNav&view=modular`, {
        headers
      });

      if (!leagueResponse.ok) {
        const responseText = await leagueResponse.text();
        console.error(`ESPN API Error Details:`, {
          status: leagueResponse.status,
          statusText: leagueResponse.statusText,
          url: `${baseUrl}?view=mSettings&view=mTeams`,
          hasAuth: !!(args.espnS2 && args.swid),
          responseText: responseText.slice(0, 500) // First 500 chars for debugging
        });
        throw new Error(`ESPN API returned ${leagueResponse.status}: ${leagueResponse.statusText}. This may indicate: 1) League is private and requires ESPN S2/SWID cookies, 2) League ID is invalid, or 3) ESPN API is temporarily unavailable.`);
      }

      const leagueData = await leagueResponse.json();
      
      // Parse the ESPN response
      const settings = leagueData.settings;
      const teams = leagueData.teams || [];
      
      // Map scoring type
      const scoringTypeMap: { [key: number]: string } = {
        0: 'standard',
        1: 'ppr', 
        2: 'half-ppr'
      };

      // Parse roster composition
      const rosterComposition: { [position: string]: number } = {};
      if (settings?.rosterSettings?.lineupSlotCounts) {
        const slotMap: { [key: number]: string } = {
          0: 'QB',
          2: 'RB', 
          4: 'WR',
          6: 'TE',
          23: 'FLEX',
          17: 'K',
          16: 'DST',
          20: 'BE'
        };

        Object.entries(settings.rosterSettings.lineupSlotCounts).forEach(([slotId, count]) => {
          const position = slotMap[parseInt(slotId)];
          if (position) {
            rosterComposition[position] = count as number;
          }
        });
      }

      const isPrivate = !!(args.espnS2 && args.swid);
      
      // Fetch draft data for current season
      const draftPicks = await fetchDraftData(args.leagueId, currentYear, headers);
      
      const processedData = {
        id: args.leagueId,
        name: settings?.name || 'ESPN League',
        size: settings?.size || teams.length,
        scoringType: scoringTypeMap[settings?.scoringSettings?.scoringType] || 'standard',
        rosterSize: Object.values(rosterComposition).reduce((sum, count) => sum + count, 0) || 16,
        playoffWeeks: settings?.scheduleSettings?.playoffWeekCount || 3,
        seasonId: currentYear,
        currentScoringPeriod: settings?.scoringSettings?.matchupPeriods?.length || 1,
        isPrivate,
        espnS2: args.espnS2,
        swid: args.swid,
        teams: teams.map((team: any) => ({
          id: team.id?.toString(),
          name: team.name || team.location + ' ' + team.nickname,
          abbreviation: team.abbrev,
          owner: team.owners?.[0]?.displayName || team.owners?.[0]?.firstName + ' ' + team.owners?.[0]?.lastName || 'Unknown',
          wins: team.record?.overall?.wins || 0,
          losses: team.record?.overall?.losses || 0,
          ties: team.record?.overall?.ties || 0,
          pointsFor: team.record?.overall?.pointsFor || 0,
          pointsAgainst: team.record?.overall?.pointsAgainst || 0,
        })),
        settings: {
          scoringType: scoringTypeMap[settings?.scoringSettings?.scoringType] || 'standard',
          rosterComposition,
          playoffTeamCount: settings?.scheduleSettings?.playoffTeamCount || 6,
          playoffWeeks: settings?.scheduleSettings?.playoffWeekCount || 3,
          regularSeasonMatchupPeriods: settings?.scheduleSettings?.regularSeasonMatchupPeriods || 14,
        },
        draftSettings: settings?.draftSettings || null,
        draftPicks: draftPicks,
        history: await fetchHistoricalData(args.leagueId, headers)
      };
      
      return {
        success: true,
        data: processedData,
      };
    } catch (error) {
      console.error("Failed to fetch ESPN league data:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch ESPN league data. Please check your League ID and try again.",
      };
    }
  },
});