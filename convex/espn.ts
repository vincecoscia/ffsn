/* eslint-disable @typescript-eslint/no-explicit-any */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/auth";
import { fetchEspn, normalizeEspnCredentials, type EspnCredentials } from "./lib/espnClient";

// Helper function to fetch draft data for a specific season
async function fetchDraftData(leagueId: string, season: number, creds: EspnCredentials): Promise<any> {
  try {
    const draftUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mDraftDetail&view=mSettings&view=mTeam&view=modular&view=mNav`;
    const { response } = await fetchEspn(draftUrl, { creds });

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
async function fetchHistoricalData(leagueId: string, creds: EspnCredentials): Promise<any[]> {
  const currentYear = new Date().getFullYear();
  const history = [];

  // Try to fetch last 8 years of historical data
  for (let i = 1; i <= 8; i++) {
    const year = currentYear - i;
    try {
      const historicalUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${leagueId}?view=mSettings&view=mTeams`;
      const { response } = await fetchEspn(historicalUrl, { creds });

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
  handler: async (ctx, args): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    requiresAuth?: boolean;
    status?: number;
  }> => {
    // Called during league setup before a league (and therefore a membership row) exists,
    // so we can only require that the caller is signed in.
    await requireIdentity(ctx);

    // args.leagueId is the ESPN external league id and is interpolated directly into the
    // ESPN request URLs below (here and in fetchDraftData/fetchHistoricalData). Reject
    // anything that isn't a plain numeric id before it ever reaches a fetch() call.
    if (!/^\d+$/.test(args.leagueId)) {
      return {
        success: false,
        error: "Invalid League ID. ESPN league IDs are numeric.",
      };
    }

    try {
      // Use fetch API to call ESPN directly in the Convex runtime
      const currentYear = new Date().getFullYear();
      const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${currentYear}/segments/0/leagues/${args.leagueId}`;
      const viewParams = '?view=mSettings&view=mTeams&view=mNav&view=modular';

      const suppliedCreds = normalizeEspnCredentials({ espnS2: args.espnS2, swid: args.swid });

      // Determine privacy from ESPN's actual behavior rather than trusting
      // "the caller passed cookies" - probe without cookies first. If ESPN
      // serves it anonymously, the league is public regardless of what was
      // typed into the cookie fields.
      let { response: leagueResponse, classification } = await fetchEspn(`${baseUrl}${viewParams}`, {
        creds: {},
      });

      let isPrivate = false;
      let creds: EspnCredentials = { hasCredentials: false };

      if (classification === "auth") {
        if (suppliedCreds.hasCredentials) {
          // Public probe was rejected and we have cookies to try - retry with
          // them before giving up.
          const authRetry = await fetchEspn(`${baseUrl}${viewParams}`, { creds: suppliedCreds });
          leagueResponse = authRetry.response;
          classification = authRetry.classification;
          if (classification === "ok") {
            isPrivate = true;
            creds = suppliedCreds;
          }
        }

        if (classification !== "ok") {
          const status = leagueResponse.status;
          console.error(`ESPN API Error Details:`, {
            status,
            url: `${baseUrl}${viewParams}`,
            hasAuth: suppliedCreds.hasCredentials,
          });
          // 401 OR 403 both mean "this league needs cookies (or the cookies
          // given were rejected)" - the setup page shows the cookie inputs
          // on either, not just 401.
          return {
            success: false,
            error: suppliedCreds.hasCredentials
              ? `ESPN rejected the provided espn_s2/SWID cookies (${status}). Double-check they were copied correctly and are still fresh.`
              : `This league requires ESPN authentication (${status}). Paste your espn_s2 and SWID cookies and try again.`,
            requiresAuth: true,
            status,
          };
        }
      } else if (classification !== "ok") {
        const status = leagueResponse.status;
        const responseText = await leagueResponse.text();
        console.error(`ESPN API Error Details:`, {
          status,
          statusText: leagueResponse.statusText,
          classification,
          url: `${baseUrl}${viewParams}`,
          responseText: responseText.slice(0, 500),
        });
        throw new Error(
          `ESPN API returned ${status}: ${leagueResponse.statusText}. This may indicate the League ID is invalid or ESPN's API is temporarily unavailable.`
        );
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

      // Fetch draft data for current season, using whichever credentials
      // (none, or the supplied ones) actually got the main fetch through.
      const draftPicks = await fetchDraftData(args.leagueId, currentYear, creds);

      const processedData = {
        id: args.leagueId,
        name: settings?.name || 'ESPN League',
        size: settings?.size || teams.length,
        scoringType: scoringTypeMap[settings?.scoringSettings?.scoringType] || 'standard',
        rosterSize: Object.values(rosterComposition).reduce((sum, count) => sum + count, 0) || 16,
        playoffWeeks: settings?.scheduleSettings?.playoffWeekCount || 3,
        seasonId: currentYear,
        currentScoringPeriod: leagueData.scoringPeriodId || leagueData.status?.currentMatchupPeriod || leagueData.status?.latestScoringPeriod || settings?.scoringSettings?.currentScoringPeriod || 1,
        isPrivate,
        // Normalized, not the raw args - so whatever calls `leagues.create`
        // with this payload stores a clean espn_s2/SWID pair.
        espnS2: creds.espnS2,
        swid: creds.swid,
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
        history: await fetchHistoricalData(args.leagueId, creds)
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
