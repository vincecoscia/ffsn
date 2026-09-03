/* eslint-disable @typescript-eslint/no-explicit-any */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { requireIdentity } from "./lib/auth";
import { fetchEspn, normalizeEspnCredentials, type EspnCredentials } from "./lib/espnClient";
import { parseEspnLeagueSettings } from "./lib/espnSettings";

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

      // Audit finding: the old scoring-type map above assumed
      // `scoringSettings.scoringType` was `0|1|2`, and the old roster/playoff
      // extraction below read `scheduleSettings.regularSeasonMatchupPeriods`
      // and `scheduleSettings.playoffWeekCount` - none of which ESPN actually
      // emits (`scoringType` is a string enum; PPR-ness lives in
      // `scoringItems`; the real field names are `matchupPeriodCount` and
      // `playoffMatchupPeriodLength` x rounds). `parseEspnLeagueSettings`
      // (`convex/lib/espnSettings.ts`) is the tolerant, tested replacement.
      const parsedSettings = parseEspnLeagueSettings(settings);

      // Legacy roster-composition shape the setup wizard still reads directly
      // (`EspnSettings.rosterComposition` in `src/app/setup/page.tsx`) - only
      // QB/RB/WR/TE/FLEX/K/DST/BE, kept for backward compatibility alongside
      // `parsedSettings.lineupSlots`, which carries the full ESPN slot set
      // (IDP, superflex/OP, TQB, bench, IR, ...).
      const LEGACY_SLOT_NAMES: Record<string, string> = {
        QB: 'QB',
        RB: 'RB',
        WR: 'WR',
        TE: 'TE',
        FLEX: 'FLEX',
        K: 'K',
        'D/ST': 'DST',
        BENCH: 'BE',
      };
      const rosterComposition: { [position: string]: number } = {};
      if (parsedSettings.lineupSlots) {
        for (const [slotName, legacyName] of Object.entries(LEGACY_SLOT_NAMES)) {
          const count = parsedSettings.lineupSlots[slotName];
          if (count !== undefined) rosterComposition[legacyName] = count;
        }
      }

      // ESPN stopped emitting a direct "playoff weeks" count; derive it from
      // rounds x weeks-per-round the same way `fantasyChampionshipWeek` does,
      // falling back to the old hard-coded default (3) when either input is
      // missing (e.g. `settings` came back empty).
      const playoffWeeks =
        parsedSettings.playoffMatchupPeriodLength !== undefined &&
        parsedSettings.playoffRounds !== undefined
          ? parsedSettings.playoffMatchupPeriodLength * parsedSettings.playoffRounds
          : 3;

      // Fetch draft data for current season, using whichever credentials
      // (none, or the supplied ones) actually got the main fetch through.
      const draftPicks = await fetchDraftData(args.leagueId, currentYear, creds);

      const processedData = {
        id: args.leagueId,
        name: parsedSettings.name || 'ESPN League',
        size: parsedSettings.size || teams.length,
        scoringType: parsedSettings.scoringType,
        rosterSize: Object.values(rosterComposition).reduce((sum, count) => sum + count, 0) || 16,
        playoffWeeks,
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
          scoringType: parsedSettings.scoringType,
          rosterComposition,
          playoffTeamCount: parsedSettings.playoffTeamCount ?? 6,
          playoffWeeks,
          regularSeasonMatchupPeriods: parsedSettings.regularSeasonMatchupPeriods ?? 14,
          // Full parsed shape, so the setup wizard can pass every field
          // through to `leagues.create` (see `src/app/setup/page.tsx`) even
          // though the `EspnSettings` display interface there only declares
          // the five fields above.
          playoffMatchupPeriodLength: parsedSettings.playoffMatchupPeriodLength,
          playoffRounds: parsedSettings.playoffRounds,
          playoffSeedingRule: parsedSettings.playoffSeedingRule,
          playoffReseed: parsedSettings.playoffReseed,
          divisions: parsedSettings.divisions,
          matchupPeriods: parsedSettings.matchupPeriods,
          lineupSlots: parsedSettings.lineupSlots,
          isSuperflex: parsedSettings.isSuperflex,
          hasIdp: parsedSettings.hasIdp,
          waiverType: parsedSettings.waiverType,
          faabBudget: parsedSettings.faabBudget,
          waiverHours: parsedSettings.waiverHours,
          tradeDeadline: parsedSettings.tradeDeadline,
          receptionPoints: parsedSettings.receptionPoints,
          scoringSystem: parsedSettings.scoringSystem,
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
