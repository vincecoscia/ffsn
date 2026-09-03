/* eslint-disable @typescript-eslint/no-explicit-any */
import { action, internalMutation, internalAction, internalQuery, type ActionCtx } from "./_generated/server";
import { v, type ObjectType } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { transformStats } from "./espnStatsMapping";
import { requireLeagueMemberFromAction } from "./lib/auth";
import { nflSeasonYearFor } from "./lib/season";
import {
  fetchEspn,
  normalizeEspnCredentials,
  type EspnStatusClassification,
} from "./lib/espnClient";
import { resolveScheduledDraftDate } from "./lib/draftDate";
import {
  divisionValidator,
  parseEspnLeagueSettings,
  waiverTypeValidator,
  type ParsedLeagueSettings,
} from "./lib/espnSettings";
import { matchupPeriodIdsFromSettings, type MatchupPeriodIdSource } from "./lib/leagueCalendar";
import { seasonsToSync } from "./lib/seasonToSync";
import {
  classifyTransactionStatus,
  normalizeEspnTransaction,
  normalizedTransactionValidator,
  type RawEspnTransaction,
} from "./lib/espnTransactions";

// Helper functions for ESPN data mapping
const getPositionName = (positionId: number): string => {
  const positionMap: { [key: number]: string } = {
    1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST'
  };
  return positionMap[positionId] || 'FLEX';
};

/**
 * Whether ESPN's `draftDetail` reports the draft as complete. ESPN sends a
 * BOOLEAN on `draftDetail.drafted` (verified live, Sept 2026) - every call
 * site in this file used to compare `=== 1`, a `mDraftDetail.drafted === 1`
 * check that can never be true, so the four sites that gated on it (writing
 * `leagueSeasons.draft`, and `fetchHistoricalRostersImpl`'s "has the draft
 * happened yet" guard) never fired automatically; only the manual "Draft
 * data" button (`fetchDraftDataForSeason`, which reads `.picks` directly
 * without this gate) ever wrote picks. Accepts `true`/`1` so a stale caller
 * or a future ESPN response shaped like the old numeric flag still works.
 */
function isDrafted(draftDetail: { drafted?: boolean | number } | null | undefined): boolean {
  return draftDetail?.drafted === true || draftDetail?.drafted === 1;
}

/**
 * The one notion of "current season" every sync/probe entry point in this
 * file shares (`convex/lib/seasonToSync.ts`) - Aug->Jul, unless the league's
 * own last-synced season is already ahead of that. Every call site here
 * only needs `current` (not `alsoSync`), so `seasons` is always `[]`.
 */
function currentSeasonForLeague(league: { espnData?: { seasonId?: number } } | null | undefined): number {
  return seasonsToSync({ league: league ?? null, seasons: [], now: Date.now() }).current;
}

const getTeamAbbreviation = (teamId: number): string => {
  // ESPN team ID to abbreviation mapping (simplified)
  const teamMap: { [key: number]: string } = {
    1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
    9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
    17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
    25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
  };
  return teamMap[teamId] || 'FA';
};


/**
 * Generate the X-Fantasy-Filter header covering every ESPN matchup period
 * whose roster/matchup data a sync needs. Period-id selection is
 * `matchupPeriodIdsFromSettings` (`convex/lib/leagueCalendar.ts`) - see its
 * doc comment for the three-tier fallback (audit finding: every league used
 * to be silently synced as a hard-coded 14 regular + 4 playoff weeks, see
 * `convex/lib/espnSettings.ts`'s header comment).
 */
const generateFantasyFilterHeader = (settings?: MatchupPeriodIdSource): string => {
  return JSON.stringify({
    schedule: {
      filterMatchupPeriodIds: {
        value: matchupPeriodIdsFromSettings(settings)
      }
    }
  });
};

/**
 * Builds the `seasonData.settings` object every sync call site passes to
 * `updateLeagueSeason` (audit fix: the previous per-call-site inline object
 * read ESPN field names - `scheduleSettings.regularSeasonMatchupPeriods`,
 * `scheduleSettings.playoffWeekCount`, `scoringSettings.scoringType === 1` -
 * that don't exist in ESPN's real response, so every league was stored with
 * the same hard-coded defaults; see `convex/lib/espnSettings.ts`'s header
 * comment for the production numbers that proved it).
 *
 * Keeps the legacy required fields populated (so every existing reader of
 * `leagueSeasons.settings`/`leagues.settings` keeps working unchanged) and
 * adds the full `parseEspnLeagueSettings` passthrough alongside them.
 * `playoffWeeks` is deliberately kept as a COUNT
 * (`playoffRounds x playoffMatchupPeriodLength`), not a week list - existing
 * readers expect a number.
 */
export function buildSeasonSettings(
  rawSettings: unknown,
  fallbackName: string,
  fallbackSize: number
): { seasonSettings: Record<string, unknown>; parsed: ParsedLeagueSettings } {
  const parsed: ParsedLeagueSettings = parseEspnLeagueSettings(rawSettings);
  const playoffRounds = parsed.playoffRounds ?? 0;
  const playoffMatchupPeriodLength = parsed.playoffMatchupPeriodLength ?? 0;
  const playoffWeeksCount = playoffRounds * playoffMatchupPeriodLength;

  const seasonSettings: Record<string, unknown> = {
    name: parsed.name || fallbackName,
    size: parsed.size || fallbackSize,
    scoringType: parsed.scoringType,
    playoffTeamCount: parsed.playoffTeamCount ?? 6,
    playoffWeeks: playoffWeeksCount > 0 ? playoffWeeksCount : 3,
    regularSeasonMatchupPeriods: parsed.regularSeasonMatchupPeriods ?? 14,
    rosterSettings: (rawSettings as Record<string, unknown> | undefined)?.rosterSettings,
    // --- Parsed-settings passthrough (convex/lib/espnSettings.ts) ---------
    scoringSystem: parsed.scoringSystem,
    receptionPoints: parsed.receptionPoints,
    playoffMatchupPeriodLength: parsed.playoffMatchupPeriodLength,
    playoffRounds: parsed.playoffRounds,
    playoffSeedingRule: parsed.playoffSeedingRule,
    playoffReseed: parsed.playoffReseed,
    divisions: parsed.divisions,
    matchupPeriods: parsed.matchupPeriods,
    lineupSlots: parsed.lineupSlots,
    isSuperflex: parsed.isSuperflex,
    hasIdp: parsed.hasIdp,
    waiverType: parsed.waiverType,
    faabBudget: parsed.faabBudget,
    waiverHours: parsed.waiverHours,
    tradeDeadline: parsed.tradeDeadline,
  };

  return { seasonSettings, parsed };
}

// Transform ESPN roster data to clean format
const transformRosterData = (rosterData: any) => {
  if (!rosterData || !rosterData.entries) {
    return undefined;
  }

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
      // Convert projected points to number instead of string. ESPN sometimes
      // omits appliedTotal (or sends a non-number); guard rather than throw
      // on `.toFixed` of undefined.
      const projectedPoints = typeof projectedStatsEntry?.appliedTotal === "number"
        ? parseFloat(projectedStatsEntry.appliedTotal.toFixed(1))
        : undefined;
      const projectedStats = transformStats(projectedStatsEntry ? projectedStatsEntry.appliedStats : undefined);

      // Ensure appliedStatTotal is a valid number for the player too
      const playerAppliedStatTotal = typeof entry.playerPoolEntry?.appliedStatTotal === 'number'
        ? entry.playerPoolEntry.appliedStatTotal
        : 0;

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

// Matchup roster fetching is now in matchupRosters.ts to avoid circular dependencies


export const updateTeams = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    teamsData: v.array(v.object({
      externalId: v.string(),
      name: v.string(),
      abbreviation: v.optional(v.string()),
      location: v.optional(v.string()),
      nickname: v.optional(v.string()),
      logo: v.optional(v.string()),
      owner: v.string(),
      ownerInfo: v.optional(v.object({
        displayName: v.optional(v.string()),
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        id: v.optional(v.string()),
      })),
      record: v.object({
        wins: v.number(),
        losses: v.number(),
        ties: v.number(),
        pointsFor: v.optional(v.number()),
        pointsAgainst: v.optional(v.number()),
        playoffSeed: v.optional(v.number()),
        // ESPN final-rank and form fields (refresh audit, Sept 2026) - the
        // schema already carries these (`convex/schema.ts`'s `teams.record`);
        // this args validator just used to drop them on the floor before
        // they ever reached `ctx.db.insert`/`patch`.
        rankCalculatedFinal: v.optional(v.number()),
        rankFinal: v.optional(v.number()),
        currentProjectedRank: v.optional(v.number()),
        draftDayProjectedRank: v.optional(v.number()),
        streakLength: v.optional(v.number()),
        streakType: v.optional(v.string()),
        gamesBack: v.optional(v.number()),
        percentage: v.optional(v.number()),
        divisionRecord: v.optional(v.object({
          wins: v.number(),
          losses: v.number(),
          ties: v.number(),
        })),
      }),
      roster: v.array(v.object({
        playerId: v.string(),
        playerName: v.string(),
        position: v.string(),
        team: v.string(),
        acquisitionType: v.optional(v.string()),
        lineupSlotId: v.optional(v.number()),
        playerStats: v.optional(v.object({
          appliedTotal: v.optional(v.number()),
          projectedTotal: v.optional(v.number()),
        })),
      })),
      divisionId: v.optional(v.number()),
      // FAAB accounting from ESPN's `view=mTeam` team objects (spec: waiver
      // wire report needs remaining budgets alongside winning/losing bids).
      // Every field ESPN's `team.transactionCounter` actually sends must be
      // listed - this validator is strict, and call sites pass the raw
      // object straight through (see tests/fixtures/espn-teams-public-2025.json).
      transactionCounter: v.optional(v.object({
        acquisitionBudgetSpent: v.optional(v.number()),
        acquisitions: v.optional(v.number()),
        drops: v.optional(v.number()),
        trades: v.optional(v.number()),
        moveToActive: v.optional(v.number()),
        moveToIR: v.optional(v.number()),
        matchupAcquisitionTotals: v.optional(v.record(v.string(), v.number())),
        paid: v.optional(v.number()),
        teamCharges: v.optional(v.number()),
        misc: v.optional(v.number()),
      })),
      waiverRank: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const processedExternalIds = new Set<string>();

    // Upsert teams - update if exists, insert if new
    for (const teamData of args.teamsData) {
      processedExternalIds.add(teamData.externalId);
      
      // Check if team already exists
      const existingTeam = await ctx.db
        .query("teams")
        .withIndex("by_external", (q) => 
          q.eq("leagueId", args.leagueId)
           .eq("externalId", teamData.externalId)
           .eq("seasonId", args.seasonId)
        )
        .first();

      const teamRecord = {
        leagueId: args.leagueId,
        externalId: teamData.externalId,
        name: teamData.name,
        abbreviation: teamData.abbreviation,
        location: teamData.location,
        nickname: teamData.nickname,
        logo: teamData.logo,
        owner: teamData.owner,
        ownerInfo: teamData.ownerInfo,
        record: teamData.record,
        roster: teamData.roster,
        seasonId: args.seasonId,
        divisionId: teamData.divisionId,
        transactionCounter: teamData.transactionCounter,
        waiverRank: teamData.waiverRank,
        updatedAt: now,
      };

      if (existingTeam) {
        // Update existing team, preserving the ID
        await ctx.db.patch(existingTeam._id, teamRecord);
      } else {
        // Insert new team
        await ctx.db.insert("teams", {
          ...teamRecord,
          createdAt: now,
        });
      }
    }

    // Remove teams that are no longer in the league/season
    // This handles cases where teams are removed from the league
    const allTeamsForSeason = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    for (const team of allTeamsForSeason) {
      if (!processedExternalIds.has(team.externalId)) {
        // Check if this team has any claims before deleting
        const teamClaim = await ctx.db
          .query("teamClaims")
          .withIndex("by_team_season", (q) => 
            q.eq("teamId", team._id).eq("seasonId", args.seasonId)
          )
          .first();
        
        if (!teamClaim) {
          // Safe to delete - no one has claimed this team
          await ctx.db.delete(team._id);
        } else {
          // Mark as inactive instead of deleting to preserve claims
          await ctx.db.patch(team._id, { 
            updatedAt: now,
            isActive: false 
          });
        }
      }
    }
  },
});;

export const updatePlayers = internalMutation({
  args: {
    playersData: v.array(v.object({
      externalId: v.string(),
      fullName: v.string(),
      firstName: v.optional(v.string()),
      lastName: v.optional(v.string()),
      defaultPosition: v.string(),
      eligiblePositions: v.array(v.string()),
      proTeamId: v.optional(v.number()),
      proTeamAbbrev: v.optional(v.string()),
      injuryStatus: v.optional(v.string()),
      stats: v.optional(v.object({
        seasonStats: v.optional(v.object({
          appliedTotal: v.optional(v.number()),
          projectedTotal: v.optional(v.number()),
          averagePoints: v.optional(v.number()),
        })),
      })),
      ownership: v.optional(v.object({
        percentOwned: v.optional(v.number()),
        percentChange: v.optional(v.number()),
        percentStarted: v.optional(v.number()),
      })),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    for (const playerData of args.playersData) {
      // Check if player already exists
      const existingPlayer = await ctx.db
        .query("players")
        .withIndex("by_external_id", (q) => q.eq("externalId", playerData.externalId))
        .first();

      if (existingPlayer) {
        // Update existing player
        await ctx.db.patch(existingPlayer._id, {
          fullName: playerData.fullName,
          firstName: playerData.firstName,
          lastName: playerData.lastName,
          defaultPosition: playerData.defaultPosition,
          eligiblePositions: playerData.eligiblePositions,
          proTeamId: playerData.proTeamId,
          proTeamAbbrev: playerData.proTeamAbbrev,
          injuryStatus: playerData.injuryStatus,
          stats: playerData.stats,
          ownership: playerData.ownership,
          updatedAt: now,
        });
      } else {
        // Create new player
        await ctx.db.insert("players", {
          externalId: playerData.externalId,
          fullName: playerData.fullName,
          firstName: playerData.firstName,
          lastName: playerData.lastName,
          defaultPosition: playerData.defaultPosition,
          eligiblePositions: playerData.eligiblePositions,
          proTeamId: playerData.proTeamId,
          proTeamAbbrev: playerData.proTeamAbbrev,
          injuryStatus: playerData.injuryStatus,
          stats: playerData.stats,
          ownership: playerData.ownership,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  },
});

export const updateMatchups = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    matchupsData: v.array(v.object({
      matchupPeriod: v.number(),
      scoringPeriod: v.number(),
      homeTeamId: v.string(),
      awayTeamId: v.string(),
      homeScore: v.number(),
      awayScore: v.number(),
      homeProjectedScore: v.optional(v.number()),
      awayProjectedScore: v.optional(v.number()),
      homePointsByScoringPeriod: v.optional(v.record(v.string(), v.number())),
      awayPointsByScoringPeriod: v.optional(v.record(v.string(), v.number())),
      winner: v.optional(v.union(v.literal("home"), v.literal("away"), v.literal("tie"))),
      playoffTier: v.optional(v.string()),
      
      // Clean roster data from current scoring period
      homeRoster: v.optional(v.any()),
      awayRoster: v.optional(v.any()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const processedMatchupKeys = new Set<string>();
    const payloadPeriods = new Set<number>();

    // Upsert matchups - update if exists, insert if new
    for (const matchupData of args.matchupsData) {
      // Create a unique key for this matchup
      const matchupKey = `${matchupData.matchupPeriod}-${matchupData.homeTeamId}-${matchupData.awayTeamId}`;
      processedMatchupKeys.add(matchupKey);
      payloadPeriods.add(matchupData.matchupPeriod);

      // Check if matchup already exists
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

      const matchupRecord = {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        matchupPeriod: matchupData.matchupPeriod,
        scoringPeriod: matchupData.scoringPeriod,
        homeTeamId: matchupData.homeTeamId,
        awayTeamId: matchupData.awayTeamId,
        homeScore: matchupData.homeScore,
        awayScore: matchupData.awayScore,
        homeProjectedScore: matchupData.homeProjectedScore,
        awayProjectedScore: matchupData.awayProjectedScore,
        homePointsByScoringPeriod: matchupData.homePointsByScoringPeriod,
        awayPointsByScoringPeriod: matchupData.awayPointsByScoringPeriod,
        winner: matchupData.winner,
        playoffTier: matchupData.playoffTier,
        homeRoster: matchupData.homeRoster,
        awayRoster: matchupData.awayRoster,
        updatedAt: now,
      };

      if (existingMatchup) {
        // Update existing matchup, preserving the ID
        await ctx.db.patch(existingMatchup._id, matchupRecord);
      } else {
        // Insert new matchup
        await ctx.db.insert("matchups", {
          ...matchupRecord,
          createdAt: now,
        });
      }
    }

    // Remove matchups that are no longer in the data - guarded (ESPN refresh
    // audit, gap 4.3/recommendation): a payload covering fewer periods than
    // the league's own format implies is a partial or truncated sync, not a
    // real schedule change, and must never be allowed to erase a season. A
    // period the league has already closed out (`leagueSeasons.periodsFinal`)
    // is additionally protected row-by-row even when the rest of the payload
    // is complete - a finalized period has no business disappearing from a
    // later sync's payload. The season row is read here (not passed in by
    // the caller) so every call site gets this protection for free.
    const season = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();
    const periodsFinal = new Set(season?.periodsFinal ?? []);
    const expectedPeriods = matchupPeriodIdsFromSettings(season?.settings);
    const payloadIsComplete = payloadPeriods.size >= expectedPeriods.length;

    if (payloadIsComplete) {
      const allMatchupsForSeason = await ctx.db
        .query("matchups")
        .withIndex("by_league_season", (q) =>
          q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
        )
        .collect();

      for (const matchup of allMatchupsForSeason) {
        const matchupKey = `${matchup.matchupPeriod}-${matchup.homeTeamId}-${matchup.awayTeamId}`;
        if (!processedMatchupKeys.has(matchupKey) && !periodsFinal.has(matchup.matchupPeriod)) {
          // Safe to delete - this matchup no longer exists in the source
          // data, the payload was complete, and this period isn't finalized.
          await ctx.db.delete(matchup._id);
        }
      }
    }
  },
});

/** The NFL season events are judged against (August -> July, see lib/season.ts). */
const CURRENT_SEASON_FOR_EVENTS = (): number => nflSeasonYearFor();

export const updateLeagueSeason = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    seasonData: v.object({
      settings: v.object({
        name: v.string(),
        size: v.number(),
        scoringType: v.string(),
        playoffTeamCount: v.number(),
        // Count (rounds x playoffMatchupPeriodLength), kept for backward
        // compatibility with existing readers - see `playoffRounds` and
        // `playoffMatchupPeriodLength` below for the actual shape.
        playoffWeeks: v.number(),
        regularSeasonMatchupPeriods: v.number(),
        rosterSettings: v.optional(v.any()),
        // --- Parsed-settings passthrough (convex/lib/espnSettings.ts) -----
        // All optional: every call site now builds this via
        // `parseEspnLeagueSettings`, but a field ESPN didn't emit in one
        // particular sync (or a caller that hasn't been updated) must not be
        // required to populate it.
        scoringSystem: v.optional(v.string()),
        receptionPoints: v.optional(v.number()),
        playoffMatchupPeriodLength: v.optional(v.number()),
        playoffRounds: v.optional(v.number()),
        playoffSeedingRule: v.optional(v.string()),
        playoffReseed: v.optional(v.boolean()),
        divisions: v.optional(v.array(divisionValidator)),
        matchupPeriods: v.optional(v.record(v.string(), v.array(v.number()))),
        lineupSlots: v.optional(v.record(v.string(), v.number())),
        isSuperflex: v.optional(v.boolean()),
        hasIdp: v.optional(v.boolean()),
        waiverType: v.optional(waiverTypeValidator),
        faabBudget: v.optional(v.number()),
        waiverHours: v.optional(v.number()),
        tradeDeadline: v.optional(v.number()),
      }),
      champion: v.optional(v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
        record: v.object({
          wins: v.number(),
          losses: v.number(),
          ties: v.number(),
        }),
        pointsFor: v.optional(v.number()),
      })),
      runnerUp: v.optional(v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
        record: v.object({
          wins: v.number(),
          losses: v.number(),
          ties: v.number(),
        }),
        pointsFor: v.optional(v.number()),
      })),
      regularSeasonChampion: v.optional(v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
        record: v.object({
          wins: v.number(),
          losses: v.number(),
          ties: v.number(),
        }),
        pointsFor: v.optional(v.number()),
      })),
      draftInfo: v.optional(v.object({
        draftDate: v.optional(v.number()),
        draftType: v.optional(v.string()),
        timePerPick: v.optional(v.number()),
        drafted: v.optional(v.boolean()),
        inProgress: v.optional(v.boolean()),
      })),
      draftSettings: v.optional(v.any()),
      draft: v.optional(v.array(v.object({
        autoDraftTypeId: v.number(),
        bidAmount: v.number(),
        id: v.number(),
        keeper: v.boolean(),
        lineupSlotId: v.number(),
        memberId: v.optional(v.string()),
        nominatingTeamId: v.number(),
        overallPickNumber: v.number(),
        playerId: v.number(),
        reservedForKeeper: v.boolean(),
        roundId: v.number(),
        roundPickNumber: v.number(),
        teamId: v.number(),
        tradeLocked: v.boolean(),
      }))),
    }),
  },
  // Annotated (rather than left inferred) because this handler schedules
  // internal.espnSync.syncOneLeagueCurrentSeason - a same-module `internal.*`
  // reference from inside espnSync.ts, which can otherwise make the generated
  // api type recursive (TS7022/7023).
  handler: async (ctx, args): Promise<void> => {
    // Check if season already exists
    const existingSeason = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();

    const now = Date.now();
    let seasonDocId: Id<"leagueSeasons">;

    if (existingSeason) {
      // Update existing season - only update fields that are defined to preserve existing data
      const updateData: any = {
        settings: args.seasonData.settings,
      };
      
      // Only update optional fields if they are defined (not undefined)
      if (args.seasonData.champion !== undefined) {
        updateData.champion = args.seasonData.champion;
      }
      if (args.seasonData.runnerUp !== undefined) {
        updateData.runnerUp = args.seasonData.runnerUp;
      }
      if (args.seasonData.regularSeasonChampion !== undefined) {
        updateData.regularSeasonChampion = args.seasonData.regularSeasonChampion;
      }
      // IMPORTANT: Only update draftInfo if it's explicitly provided
      if (args.seasonData.draftInfo !== undefined) {
        updateData.draftInfo = args.seasonData.draftInfo;
      }
      if (args.seasonData.draftSettings !== undefined) {
        updateData.draftSettings = args.seasonData.draftSettings;
      }
      if (args.seasonData.draft !== undefined) {
        updateData.draft = args.seasonData.draft;
      }
      
      await ctx.db.patch(existingSeason._id, updateData);

      // The routine sync is how a draft finishing is normally observed, so the
      // draft_completed event (draft rankings article, spec §9.1) must fire from
      // here, not only from the commissioner's manual draft fetch. Current NFL
      // season only: a historical row gaining draftInfo on a re-import is not a
      // draft that just happened. triggerEventBasedContent dedupes per season.
      const wasDrafted = existingSeason.draftInfo?.drafted === true;
      const isDrafted = args.seasonData.draftInfo?.drafted === true;
      if (!wasDrafted && isDrafted && args.seasonId === CURRENT_SEASON_FOR_EVENTS()) {
        console.log(`Draft completed for league ${args.leagueId}, season ${args.seasonId} (routine sync)`);
        try {
          await ctx.scheduler.runAfter(0, internal.contentScheduling.triggerEventBasedContent, {
            leagueId: args.leagueId,
            eventType: "draft_completed",
            eventData: {
              seasonId: args.seasonId,
              draftDate: args.seasonData.draftInfo?.draftDate,
              draftType: args.seasonData.draftInfo?.draftType,
            },
          });
        } catch (error) {
          console.error("Failed to trigger draft_completed event from sync:", error);
        }
      }

      seasonDocId = existingSeason._id;
    } else {
      // Create new season record
      seasonDocId = await ctx.db.insert("leagueSeasons", {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        settings: args.seasonData.settings,
        champion: args.seasonData.champion,
        runnerUp: args.seasonData.runnerUp,
        regularSeasonChampion: args.seasonData.regularSeasonChampion,
        draftInfo: args.seasonData.draftInfo,
        draftSettings: args.seasonData.draftSettings,
        draft: args.seasonData.draft,
        createdAt: now,
      });
    }

    // Live-draft follow-up syncs (owner's intent: notice a draft finishing
    // within hours rather than waiting for the next 4-hourly cron slot).
    // Current NFL season only, and only while ESPN hasn't reported the draft
    // as complete yet - a rolling/slow draft is still caught by the routine
    // cron once `drafted` flips (see resolveScheduledDraftDate's `isRolling`),
    // these three jobs are purely a faster-notice mechanism layered on top.
    // Re-running this mutation (every routine sync) must not pile up
    // duplicate scheduled jobs, so it's keyed on `postDraftSyncScheduledFor`:
    // skip when jobs are already scheduled for this exact draft instant, but
    // schedule again if the draft date changes (postponed/rescheduled draft).
    if (args.seasonId === CURRENT_SEASON_FOR_EVENTS()) {
      const resolvedDraftDate = resolveScheduledDraftDate({
        draftSettings: args.seasonData.draftSettings,
        draftInfo: args.seasonData.draftInfo,
      });
      const isDraftedNow = args.seasonData.draftInfo?.drafted === true;
      const alreadyScheduledFor = existingSeason?.postDraftSyncScheduledFor;

      if (
        !isDraftedNow &&
        resolvedDraftDate.scheduledAt !== undefined &&
        resolvedDraftDate.scheduledAt > now &&
        alreadyScheduledFor !== resolvedDraftDate.scheduledAt
      ) {
        const scheduledAt = resolvedDraftDate.scheduledAt;
        try {
          await ctx.scheduler.runAt(scheduledAt + 3 * 60 * 60 * 1000, internal.espnSync.syncOneLeagueCurrentSeason, {
            leagueId: args.leagueId,
          });
          await ctx.scheduler.runAt(scheduledAt + 8 * 60 * 60 * 1000, internal.espnSync.syncOneLeagueCurrentSeason, {
            leagueId: args.leagueId,
          });
          await ctx.scheduler.runAt(scheduledAt + 24 * 60 * 60 * 1000, internal.espnSync.syncOneLeagueCurrentSeason, {
            leagueId: args.leagueId,
          });
          await ctx.db.patch(seasonDocId, { postDraftSyncScheduledFor: scheduledAt });
        } catch (error) {
          console.error(`Failed to schedule post-draft follow-up syncs for league ${args.leagueId}:`, error);
        }
      }
    }
  },
});
export const updateSeasonDraftData = internalMutation({
  args: {
    seasonId: v.id("leagueSeasons"),
    draftSettings: v.optional(v.any()),
    draft: v.optional(v.array(v.object({
      autoDraftTypeId: v.number(),
      bidAmount: v.number(),
      id: v.number(),
      keeper: v.boolean(),
      lineupSlotId: v.number(),
      memberId: v.optional(v.string()),
      nominatingTeamId: v.number(),
      overallPickNumber: v.number(),
      playerId: v.number(),
      reservedForKeeper: v.boolean(),
      roundId: v.number(),
      roundPickNumber: v.number(),
      teamId: v.number(),
      tradeLocked: v.boolean(),
    }))),
    draftInfo: v.optional(v.object({
      draftDate: v.optional(v.number()),
      draftType: v.optional(v.string()),
      timePerPick: v.optional(v.number()),
      drafted: v.optional(v.boolean()),
      inProgress: v.optional(v.boolean()),
    })),
  },
  handler: async (ctx, args) => {
    // Get the existing season data to check if draft status changed
    const existingSeason = await ctx.db.get(args.seasonId);
    const wasPreviouslyDrafted = existingSeason?.draftInfo?.drafted === true;
    const isNowDrafted = args.draftInfo?.drafted === true;
    
    // Update the season data
    await ctx.db.patch(args.seasonId, {
      draftSettings: args.draftSettings,
      draft: args.draft,
      draftInfo: args.draftInfo,
    });
    
    // If draft just completed (wasn't drafted before, but is now), trigger draft rankings generation
    if (!wasPreviouslyDrafted && isNowDrafted && existingSeason?.leagueId) {
      console.log(`Draft completed for league ${existingSeason.leagueId}, season ${existingSeason.seasonId}`);
      
      try {
        await ctx.scheduler.runAfter(0, internal.contentScheduling.triggerEventBasedContent, {
          leagueId: existingSeason.leagueId,
          eventType: "draft_completed",
          eventData: {
            seasonId: existingSeason.seasonId,
            draftDate: args.draftInfo?.draftDate,
            draftType: args.draftInfo?.draftType,
          },
        });
        console.log(`Successfully triggered draft_completed event for league ${existingSeason.leagueId}`);
      } catch (error) {
        console.error(`Failed to trigger draft_completed event:`, error);
      }
    }
  },
});

// Comprehensive sync function for both current and historical data
// Helper function to validate ESPN credentials. Returns the ESPN status
// classification alongside `isValid` so callers can tell "definitely bad
// credentials" (401/403) apart from "ESPN is having a bad day" (429/5xx) -
// only the former should flip a league's stored credentialStatus to
// "invalid" and page an operator.
const validateEspnCredentials = async (
  leagueId: string,
  espnS2?: string,
  swid?: string,
  currentSeasonId?: number
): Promise<{
  isValid: boolean;
  classification: EspnStatusClassification;
  error?: string;
}> => {
  const creds = normalizeEspnCredentials({ espnS2, swid });
  if (!creds.hasCredentials) {
    return { isValid: false, classification: "auth", error: "Missing ESPN S2 or SWID credentials" };
  }

  try {
    // Probe the same season every other sync path treats as "current"
    // (`currentSeasonForLeague`) - a caller with no league doc handy (none
    // today) falls back to the raw wall-clock NFL season year.
    const seasonId = currentSeasonId ?? currentSeasonForLeague(null);
    const testUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${leagueId}?view=mSettings`;

    const { response, classification } = await fetchEspn(testUrl, { creds });

    return {
      isValid: classification === "ok",
      classification,
      error: classification === "ok" ? undefined : `ESPN API returned ${response.status}: ${response.statusText}`
    };
  } catch (error) {
    return {
      isValid: false,
      classification: "other",
      error: error instanceof Error ? error.message : "Unknown error validating credentials"
    };
  }
};

/**
 * Probe a private league's STORED espn_s2/SWID pair and persist the outcome
 * via `leagues.setEspnCredentialStatus`. Used by `leagues.updateEspnCredentials`
 * right after the commissioner saves a fresh pair (so a fixed connection
 * flips to "valid" -> `espnCredentialLifecycle.onRestored` -> the backlog
 * resumes without anyone running a manual sync) and by
 * `espnCredentialLifecycle.dailyCredentialReminders` to catch a token that
 * silently expired between sync attempts.
 *
 * A no-op for a league with no ESPN data or that isn't private - credential
 * health tracking only applies to private leagues.
 */
export const validateStoredCredentials = internalAction({
  args: { leagueId: v.id("leagues") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league || !league.espnData?.isPrivate) return null;

    const credentialsCheck = await validateEspnCredentials(
      league.externalId,
      league.espnData.espnS2,
      league.espnData.swid,
      currentSeasonForLeague(league)
    );

    if (credentialsCheck.isValid) {
      await ctx.runMutation(internal.leagues.setEspnCredentialStatus, {
        leagueId: args.leagueId,
        status: "valid",
      });
    } else if (credentialsCheck.classification === "auth") {
      // Only a genuine auth rejection (or missing credentials) should flip
      // the stored status - a rate limit or ESPN outage isn't a credentials
      // problem (mirrors syncAllLeaguesCurrentSeason's own guard below).
      await ctx.runMutation(internal.leagues.setEspnCredentialStatus, {
        leagueId: args.leagueId,
        status: "invalid",
        error: credentialsCheck.error,
      });
    }

    return null;
  },
});

export const syncAllLeagueData = action({
  args: {
    leagueId: v.id("leagues"),
    includeCurrentSeason: v.optional(v.boolean()),
    historicalYears: v.optional(v.number()), // Number of years to go back
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    totalYearsRequested: number;
    totalSynced: number;
    totalErrors: number;
    // Total non-fatal sub-step failures (rosters/transactions/player stats)
    // across every year, so a caller can tell "fully clean" apart from
    // "reported success but something was swallowed" without reading every
    // year's stepErrors.
    warnings: number;
    results: Array<{
      year: number;
      success: boolean;
      error?: string;
      teamsCount?: number;
      matchupsCount?: number;
      playersCount?: number;
      rostersCount?: number;
      matchupRostersCount?: number;
      transactionsCount?: number;
      // Sub-step failures that were swallowed so the year could still be
      // marked `success` (rosters/matchup rosters/transactions/player
      // stats). Empty/absent means every sub-step for this year succeeded.
      stepErrors?: string[];
    }>;
    message: string;
    syncedAt: number;
  }> => {
    await requireLeagueMemberFromAction(ctx, args.leagueId, { commissioner: true });

    const league: any = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });

    console.log('League ESPN data check:', {
      hasEspnData: !!league?.espnData,
      isPrivate: league?.espnData?.isPrivate,
      hasEspnS2: !!league?.espnData?.espnS2,
      hasSwid: !!league?.espnData?.swid,
      espnS2Length: league?.espnData?.espnS2?.length,
      swidFormat: league?.espnData?.swid?.startsWith?.('{') && league?.espnData?.swid?.endsWith?.('}')
    });
    
    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    // Validate ESPN credentials if league is private
    if (league.espnData.isPrivate) {
      const credentialsCheck = await validateEspnCredentials(
        league.externalId,
        league.espnData.espnS2,
        league.espnData.swid,
        currentSeasonForLeague(league)
      );

      await ctx.runMutation(internal.leagues.setEspnCredentialStatus, {
        leagueId: args.leagueId,
        status: credentialsCheck.isValid ? "valid" : "invalid",
        error: credentialsCheck.error,
      });

      if (!credentialsCheck.isValid) {
        throw new Error(`ESPN credentials invalid: ${credentialsCheck.error}. Please re-authenticate with ESPN.`);
      }
    }

    // Aug->Jul, not the raw calendar year (ESPN refresh audit, section 2 -
    // rollover): fixes both "Sync now" starting to request the WRONG season
    // the moment the calendar rolls over on Jan 1 (weeks before the NFL
    // season, and this app's own convention, treat it as over), and
    // dashboard-refresh callers that pass no `historicalYears` at all.
    const currentYear = currentSeasonForLeague(league);
    const includeCurrentSeason = args.includeCurrentSeason ?? true;
    const yearsBack = args.historicalYears ?? 10;
    
    const yearsToSync = [];
    
    // Add current season if requested
    if (includeCurrentSeason) {
      yearsToSync.push(currentYear);
    }
    
    // Add historical years
    for (let i = 1; i <= yearsBack; i++) {
      yearsToSync.push(currentYear - i);
    }

    const results = [];
    let totalSynced = 0;
    let totalErrors = 0;

    for (const year of yearsToSync) {
      try {
        console.log(`Starting sync for year ${year}...`);
        
        const baseUrl: string = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${league.externalId}`;

        // Add fantasy filter for all matchup periods to get roster data
        const yearCreds = normalizeEspnCredentials(league.espnData);

        // For current season, get more comprehensive data
        const viewParams = year === currentYear
          ? '?view=mSettings&view=mTeams&view=mRoster&view=mMatchup&view=mMatchupScore&view=mStandings&view=mDraftDetail&view=mNav&view=modular&view=players_wl&view=kona_player_info&view=mLogo&view=mTeam&view=mStatus&view=mBoxscore&view=mPositionalRatings&view=kona_league_communication&view=kona_playercard'
          : '?view=mSettings&view=mTeams&view=mRoster&view=mMatchup&view=mMatchupScore&view=mStandings&view=mDraftDetail&view=mNav&view=modular&view=players_wl&view=kona_player_info&view=mLogo&view=mTeam&view=mStatus&view=mBoxscore&view=mPositionalRatings&view=kona_league_communication&view=kona_playercard';

        const { response: leagueResponse, classification: leagueClassification } = await fetchEspn(
          `${baseUrl}${viewParams}`,
          { creds: yearCreds, headers: { 'X-Fantasy-Filter': generateFantasyFilterHeader(league.settings) } }
        );

        if (!leagueResponse.ok) {
          const responseText = await leagueResponse.text();
          console.error(`ESPN API Error for year ${year}:`, {
            status: leagueResponse.status,
            statusText: leagueResponse.statusText,
            classification: leagueClassification,
            url: baseUrl + viewParams,
            hasAuth: !!(league.espnData.espnS2 && league.espnData.swid),
            isPrivate: league.espnData.isPrivate,
            responseText: responseText.slice(0, 200)
          });
          console.warn(`Failed to fetch data for year ${year}: ${leagueResponse.status}`);
          results.push({
            year,
            success: false,
            error: `HTTP ${leagueResponse.status}: ${leagueResponse.statusText}${leagueClassification === 'auth' ? ' (Authentication required - check ESPN S2/SWID cookies)' : ''}`
          });
          totalErrors++;
          continue;
        }

        const leagueData = await leagueResponse.json();
        
        // Debug logging for historical data
        if (year !== currentYear) {
          console.log(`Historical data for ${year}:`, {
            hasTeams: !!leagueData.teams,
            teamsCount: leagueData.teams?.length || 0,
            hasMembers: !!leagueData.members,
            membersCount: leagueData.members?.length || 0,
            hasStatus: !!leagueData.status,
            sampleTeam: leagueData.teams?.[0] ? {
              id: leagueData.teams[0].id,
              name: leagueData.teams[0].name,
              location: leagueData.teams[0].location,
              nickname: leagueData.teams[0].nickname,
              abbrev: leagueData.teams[0].abbrev,
              hasRecord: !!leagueData.teams[0].record,
              hasOwners: !!leagueData.teams[0].owners,
              recordOverall: leagueData.teams[0].record?.overall,
              owners: leagueData.teams[0].owners,
              allKeys: Object.keys(leagueData.teams[0])
            } : null,
            sampleMember: leagueData.members?.[0] ? {
              id: leagueData.members[0].id,
              displayName: leagueData.members[0].displayName,
              isLeagueManager: leagueData.members[0].isLeagueManager
            } : null
          });
        }
        
        // Check if we got valid data
        // Allow proceeding if we have draftDetail even when teams are missing
        if (!leagueData.settings && !leagueData.draftDetail) {
          console.warn(`Invalid data structure for year ${year}`);
          results.push({ 
            year, 
            success: false, 
            error: 'Invalid data structure returned from ESPN' 
          });
          totalErrors++;
          continue;
        }

        const teams = leagueData.teams || [];
        const members = leagueData.members || [];

        // Create a map of member IDs to member data for easy lookup
        const memberMap = new Map();
        members.forEach((member: any) => {
          memberMap.set(member.id, member);
        });
        
        // Log member map for debugging in historical data
        if (year !== currentYear && members.length > 0) {
          console.log(`Member data for ${year}:`, {
            memberCount: members.length,
            sampleMemberId: members[0].id,
            memberMapSize: memberMap.size,
            firstTeamOwner: teams[0]?.owners?.[0],
            ownerInMap: teams[0]?.owners?.[0] ? memberMap.has(teams[0].owners[0]) : 'No owner'
          });
        }

        // Skip processing if historical data is too incomplete AND no draft info available
        if (year !== currentYear) {
          const hasAnyTeamData = teams.some((team: any) => 
            team.name || team.location || team.nickname || team.owners?.length > 0
          );
          const hasDraftDetail = !!leagueData.draftDetail;
          if (!hasAnyTeamData && members.length === 0 && !hasDraftDetail) {
            console.warn(`Skipping year ${year} - no meaningful team/member data and no draft info available`);
            results.push({
              year,
              success: false,
              error: 'Historical season data too incomplete - no team names, member data, or draft info available'
            });
            totalErrors++;
            continue;
          }
        }
        const settings = leagueData.settings;
        const schedule = leagueData.schedule || [];
        const players = leagueData.players || [];
        const draftDetail = leagueData.draftDetail;

        // Process champion and runner-up from final standings
        let champion, runnerUp;
        
        // First try to use rankCalculatedFinal for the most accurate results
        const finalRankings = teams
          .filter((team: any) => team.rankCalculatedFinal)
          .sort((a: any, b: any) => a.rankCalculatedFinal - b.rankCalculatedFinal);
          
        if (finalRankings.length >= 2) {
          champion = finalRankings[0]; // rankCalculatedFinal: 1
          runnerUp = finalRankings[1];  // rankCalculatedFinal: 2
        } else {
          // Fallback: Use playoff seeds for completed seasons
          const finalStandings = teams
            .filter((team: any) => team.playoffSeed)
            .sort((a: any, b: any) => a.playoffSeed - b.playoffSeed);
            
          if (finalStandings.length >= 2) {
            champion = finalStandings[0];
            runnerUp = finalStandings[1];
          } else {
            // Last resort: Use best regular season records for historical data
            const sortedByRecord = teams
              .sort((a: any, b: any) => {
                const aWinPct = (a.record?.overall?.wins || 0) / ((a.record?.overall?.wins || 0) + (a.record?.overall?.losses || 0) || 1);
                const bWinPct = (b.record?.overall?.wins || 0) / ((b.record?.overall?.wins || 0) + (b.record?.overall?.losses || 0) || 1);
                if (aWinPct !== bWinPct) return bWinPct - aWinPct;
                return (b.record?.overall?.pointsFor || 0) - (a.record?.overall?.pointsFor || 0);
              });
            
            // Only set champion/runnerUp if we have valid record data
            if (sortedByRecord[0]?.record?.overall?.wins > 0) {
              champion = sortedByRecord[0];
              runnerUp = sortedByRecord[1];
            }
          }
        }

        // Find regular season champion (best record)
        const regularSeasonChamp = teams
          .sort((a: any, b: any) => {
            const aWinPct = a.record?.overall?.wins / (a.record?.overall?.wins + a.record?.overall?.losses || 1);
            const bWinPct = b.record?.overall?.wins / (b.record?.overall?.wins + b.record?.overall?.losses || 1);
            if (aWinPct !== bWinPct) return bWinPct - aWinPct;
            return (b.record?.overall?.pointsFor || 0) - (a.record?.overall?.pointsFor || 0);
          })[0];

        // Enrich historical team data if possible
        if (year !== currentYear && members.length > 0) {
          // Try to map team IDs to member names if team data is incomplete
          teams.forEach((team: any, index: number) => {
            if (!team.name && !team.location && !team.nickname) {
              // Use member data as fallback for team names
              const member = members[index % members.length]; // Basic mapping attempt
              if (member) {
                team.location = member.displayName?.split(' ')[0] || 'Team';
                team.nickname = member.displayName?.split(' ').slice(1).join(' ') || `${team.id}`;
                team.owners = [{
                  displayName: member.displayName,
                  id: member.id,
                  isLeagueManager: member.isLeagueManager
                }];
              }
            }
          });
        }

        // Create/update league season record
        // Persist season when we have settings or draft info, regardless of team availability
        if (settings || draftDetail) {
          const { seasonSettings: yearSeasonSettings, parsed: parsedYearSettings } = buildSeasonSettings(
            settings,
            league.name,
            league.espnData?.size || teams.length || 10
          );
          const seasonData: any = {
            settings: yearSeasonSettings,
          };

          // Only include champion if exists
          if (champion) {
            seasonData.champion = {
              teamId: champion.id?.toString() || '',
              teamName: champion.name || (champion.location && champion.nickname ? `${champion.location} ${champion.nickname}` : 'Unknown Team'),
              owner: champion.owners?.[0]?.displayName || 
                  (champion.owners?.[0]?.firstName && champion.owners?.[0]?.lastName 
                    ? `${champion.owners[0].firstName} ${champion.owners[0].lastName}` 
                    : champion.owners?.[0]?.firstName || champion.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: champion.record?.overall?.wins || 0,
                losses: champion.record?.overall?.losses || 0,
                ties: champion.record?.overall?.ties || 0,
              },
              pointsFor: champion.record?.overall?.pointsFor,
            };
          }

          // Only include runnerUp if exists
          if (runnerUp) {
            seasonData.runnerUp = {
              teamId: runnerUp.id?.toString() || '',
              teamName: runnerUp.name || (runnerUp.location && runnerUp.nickname ? `${runnerUp.location} ${runnerUp.nickname}` : 'Unknown Team'),
              owner: runnerUp.owners?.[0]?.displayName || 
                  (runnerUp.owners?.[0]?.firstName && runnerUp.owners?.[0]?.lastName 
                    ? `${runnerUp.owners[0].firstName} ${runnerUp.owners[0].lastName}` 
                    : runnerUp.owners?.[0]?.firstName || runnerUp.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: runnerUp.record?.overall?.wins || 0,
                losses: runnerUp.record?.overall?.losses || 0,
                ties: runnerUp.record?.overall?.ties || 0,
              },
              pointsFor: runnerUp.record?.overall?.pointsFor,
            };
          }

          // Only include regularSeasonChampion if exists
          if (regularSeasonChamp) {
            seasonData.regularSeasonChampion = {
              teamId: regularSeasonChamp.id?.toString() || '',
              teamName: regularSeasonChamp.name || (regularSeasonChamp.location && regularSeasonChamp.nickname ? `${regularSeasonChamp.location} ${regularSeasonChamp.nickname}` : 'Unknown Team'),
              owner: regularSeasonChamp.owners?.[0]?.displayName || 
                  (regularSeasonChamp.owners?.[0]?.firstName && regularSeasonChamp.owners?.[0]?.lastName 
                    ? `${regularSeasonChamp.owners[0].firstName} ${regularSeasonChamp.owners[0].lastName}` 
                    : regularSeasonChamp.owners?.[0]?.firstName || regularSeasonChamp.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: regularSeasonChamp.record?.overall?.wins || 0,
                losses: regularSeasonChamp.record?.overall?.losses || 0,
                ties: regularSeasonChamp.record?.overall?.ties || 0,
              },
              pointsFor: regularSeasonChamp.record?.overall?.pointsFor,
            };
          }

          // Always include draftInfo to prevent it from becoming empty
          // Set it to undefined if no draftDetail exists (will preserve existing value)
          seasonData.draftInfo = draftDetail ? {
            draftDate: draftDetail.completeDate || (draftDetail.drafted ? 1 : undefined),
            draftType: draftDetail.type,
            timePerPick: draftDetail.timePerPick,
            drafted: draftDetail.drafted,
            inProgress: draftDetail.inProgress,
          } : undefined;

          // Only include draftSettings if it exists
          if (settings?.draftSettings) {
            seasonData.draftSettings = settings.draftSettings;
          }

          // Only include draft picks if draft has actually occurred
          if (isDrafted(draftDetail) && draftDetail.picks) {
            seasonData.draft = draftDetail.picks;
          }

          await ctx.runMutation(internal.espnSync.updateLeagueSeason, {
            leagueId: args.leagueId,
            seasonId: year,
            seasonData,
          });

          // Mirror onto leagues.settings for the CURRENT season only - a
          // historical year's settings must never overwrite the league's
          // "current" config (spec: mirrorSeasonSettings's doc comment in
          // leagues.ts). Non-fatal.
          if (settings && year === currentYear) {
            try {
              await ctx.runMutation(internal.leagues.mirrorSeasonSettings, {
                leagueId: args.leagueId,
                seasonId: year,
                settings: parsedYearSettings,
              });
            } catch (error) {
              console.error(`Failed to mirror season settings for league ${args.leagueId}:`, error);
            }
          }
        }

        // Helper function for roster data
        // Note: The general league endpoint doesn't reliably return roster data
        // We'll use fetchHistoricalRosters after team sync for accurate roster data
        const getRosterData = (team: any) => {
          // Return empty array - rosters will be fetched separately using fetchHistoricalRosters
          return [];
        };

        // Helper function to get owner info with fallback logic
      const getOwnerInfo = (team: any) => {
        // First try to get owner from team.owners array
        if (team.owners?.[0]) {
          const owner = team.owners[0];
          
          // Check if owner is just a string ID (historical data) or an object (current data)
          if (typeof owner === 'string') {
            // Owner is just an ID, need to look up in members
            const member = memberMap.get(owner);
            if (member) {
              return {
                ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
                ownerInfo: {
                  displayName: member.displayName,
                  firstName: member.firstName,
                  lastName: member.lastName,
                  id: member.id?.toString() || owner,
                }
              };
            }
          } else if (owner.displayName || owner.firstName || owner.lastName) {
            // Owner is an object with properties
            return {
              ownerName: (owner.firstName && owner.lastName ? `${owner.firstName} ${owner.lastName}` : owner.displayName || owner.firstName || owner.lastName || 'Unknown'),
              ownerInfo: {
                displayName: owner.displayName,
                firstName: owner.firstName,
                lastName: owner.lastName,
                id: owner.id?.toString(),
              }
            };
          }
        }
          
          // Fallback to member data using primaryOwner
          if (team.primaryOwner && memberMap.has(team.primaryOwner)) {
            const member = memberMap.get(team.primaryOwner);
            return {
              ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
              ownerInfo: {
                displayName: member.displayName,
                firstName: member.firstName,
                lastName: member.lastName,
                id: member.id?.toString(),
              }
            };
          }
          
          // Last resort - try to find member by matching team name  
          const matchingMember = members.find((m: any) => 
            team.name && (team.name.includes(m.displayName) || team.name.includes(m.firstName) || team.name.includes(m.lastName))
          );
          if (matchingMember) {
            return {
              ownerName: (matchingMember.firstName && matchingMember.lastName ? `${matchingMember.firstName} ${matchingMember.lastName}` : matchingMember.displayName) || 'Unknown',
              ownerInfo: {
                displayName: matchingMember.displayName,
                firstName: matchingMember.firstName,
                lastName: matchingMember.lastName,
                id: matchingMember.id?.toString(),
              }
            };
          }
          
          return {
            ownerName: 'Unknown',
            ownerInfo: undefined
          };
        };

        // Sync teams for this season. Teams with no `id` can't be matched to
        // anything downstream (roster fetches, matchups, claims all key off
        // externalId) - skip them rather than crash the whole year's sync on
        // `team.id.toString()`.
        await ctx.runMutation(internal.espnSync.updateTeams, {
          leagueId: args.leagueId,
          seasonId: year,
          teamsData: teams.filter((team: any) => team.id != null).map((team: any) => {
            const { ownerName, ownerInfo } = getOwnerInfo(team);
            return {
              externalId: team.id.toString(),
              name: team.name ||
                    (team.location && team.nickname ? `${team.location} ${team.nickname}` :
                     team.location || team.nickname || `Team ${team.id}` || 'Unknown Team'),
              abbreviation: team.abbrev,
              location: team.location,
              nickname: team.nickname,
              logo: team.logo || team.logoURL || team.logoUrl || undefined,
              owner: ownerName,
              ownerInfo: ownerInfo,
            record: {
              wins: team.record?.overall?.wins || 0,
              losses: team.record?.overall?.losses || 0,
              ties: team.record?.overall?.ties || 0,
              pointsFor: team.record?.overall?.pointsFor || 0,
              pointsAgainst: team.record?.overall?.pointsAgainst || 0,
              playoffSeed: team.playoffSeed,
              // ESPN final-rank and form fields (refresh audit, Sept 2026).
              rankCalculatedFinal: team.rankCalculatedFinal,
              rankFinal: team.rankFinal,
              currentProjectedRank: team.currentProjectedRank,
              draftDayProjectedRank: team.draftDayProjectedRank,
              streakLength: team.record?.overall?.streakLength,
              streakType: team.record?.overall?.streakType,
              gamesBack: team.record?.overall?.gamesBack,
              percentage: team.record?.overall?.percentage,
              divisionRecord: team.record?.division ? {
                wins: team.record.division.wins || 0,
                losses: team.record.division.losses || 0,
                ties: team.record.division.ties || 0,
              } : undefined,
            },
            roster: year === currentYear && team.roster?.entries ? team.roster.entries.map((entry: any) => ({
              playerId: entry.playerId?.toString() || '',
              playerName: entry.playerPoolEntry?.player?.fullName || 'Unknown',
              position: entry.playerPoolEntry?.player?.defaultPositionId ? getPositionName(entry.playerPoolEntry.player.defaultPositionId) : 'UNKNOWN',
              team: entry.playerPoolEntry?.player?.proTeamId ? getTeamAbbreviation(entry.playerPoolEntry.player.proTeamId) : 'FA',
              acquisitionType: entry.acquisitionType,
              lineupSlotId: entry.lineupSlotId,
              playerStats: entry.playerPoolEntry?.player?.stats ? {
                appliedTotal: entry.playerPoolEntry.player.stats.appliedTotal,
                projectedTotal: entry.playerPoolEntry.player.stats.projectedTotal,
              } : undefined,
            })) : [], // Historical rosters can be fetched separately using fetchHistoricalRosters
            divisionId: team.divisionId,
            transactionCounter: team.transactionCounter,
            waiverRank: team.waiverRank,
            };
          })
        });

        // Carry manager <-> team claims forward from the prior season - only
        // for the current season, since a rollover only ever makes sense
        // against "this season's teams now exist". Never let a rollover
        // problem fail the sync itself.
        if (year === currentYear) {
          try {
            await ctx.runMutation(internal.claimRollover.rollForwardClaims, {
              leagueId: args.leagueId,
              seasonId: year,
            });
          } catch (rolloverError) {
            console.error("Error rolling forward team claims:", rolloverError);
          }

          // Refresh derived metrics (team metrics, rivalries, manager
          // activity) that the article pipeline reads. Scheduled rather than
          // awaited so it never extends this action's runtime or fails the
          // sync itself.
          try {
            await ctx.scheduler.runAfter(0, internal.dataProcessing.processLeagueDataAfterSync, {
              leagueId: args.leagueId,
              seasonId: year,
            });
          } catch (dataProcessingError) {
            console.error("Error scheduling post-sync data processing:", dataProcessingError);
          }
        }

        // Sub-step failures below (transactions/rosters/matchup rosters/player
        // stats) are non-fatal - the year still counts as synced (its league
        // fetch, teams and matchups all succeeded above) but each swallowed
        // failure is recorded here as a warning instead of silently vanishing.
        const stepErrors: string[] = [];
        let transactionsSynced = 0;

        // Sync players data for all seasons (historical and current)
        if (players.length > 0) {
          await ctx.runMutation(internal.espnSync.updatePlayers, {
            playersData: players.map((player: any) => ({
              externalId: player.id?.toString() || '',
              fullName: player.fullName || 'Unknown Player',
              firstName: player.firstName,
              lastName: player.lastName,
              defaultPosition: getPositionName(player.defaultPositionId),
              eligiblePositions: player.eligibleSlots?.map((slot: number) => getPositionName(slot)) || [],
              proTeamId: player.proTeamId,
              proTeamAbbrev: getTeamAbbreviation(player.proTeamId),
              injuryStatus: player.injuryStatus,
              stats: player.stats ? {
                seasonStats: {
                  appliedTotal: player.stats.appliedTotal,
                  projectedTotal: player.stats.projectedTotal,
                  averagePoints: player.stats.averagePoints,
                }
              } : undefined,
              ownership: player.ownership ? {
                percentOwned: player.ownership.percentOwned,
                percentChange: player.ownership.percentChange,
                percentStarted: player.ownership.percentStarted,
              } : undefined,
            }))
          });

          // Sync player transactions for this season
          console.log(`Processing player transactions for year ${year}...`);
          try {
            const transactionResult = await ctx.runAction(internal.espnSync.syncPlayerTransactions, {
              leagueId: args.leagueId,
              seasonId: year,
              players: players,
              currentScoringPeriod: settings?.scoringSettings?.currentScoringPeriod || 1,
            });

            if (transactionResult.success) {
              transactionsSynced = transactionResult.transactionsProcessed;
              console.log(`Successfully synced ${transactionResult.transactionsProcessed} transactions for ${year}`);
            } else {
              console.warn(`Failed to sync some transactions for ${year}:`, transactionResult.message);
              stepErrors.push(`transactions: ${transactionResult.message}`);
            }
          } catch (transactionError) {
            console.error(`Error syncing player transactions for ${year}:`, transactionError);
            // Don't fail the entire sync if transaction syncing fails - recorded as a warning instead.
            stepErrors.push(`transactions: ${transactionError instanceof Error ? transactionError.message : 'Unknown error'}`);
          }
        }

        // Sync matchups data
        if (schedule.length > 0) {
          await ctx.runMutation(internal.espnSync.updateMatchups, {
            leagueId: args.leagueId,
            seasonId: year,
            matchupsData: schedule.map((matchup: any) => ({
              matchupPeriod: matchup.matchupPeriodId,
              scoringPeriod: matchup.id,
              homeTeamId: matchup.home?.teamId?.toString() || '',
              awayTeamId: matchup.away?.teamId?.toString() || '',
              homeScore: matchup.home?.totalPoints || 0,
              awayScore: matchup.away?.totalPoints || 0,
              homeProjectedScore: matchup.home?.totalProjectedPoints,
              awayProjectedScore: matchup.away?.totalProjectedPoints,
              homePointsByScoringPeriod: matchup.home?.pointsByScoringPeriod,
              awayPointsByScoringPeriod: matchup.away?.pointsByScoringPeriod,
              winner: matchup.winner === 'HOME' ? 'home' as const : 
                     matchup.winner === 'AWAY' ? 'away' as const : 
                     matchup.winner === 'TIE' ? 'tie' as const : undefined,
              playoffTier: matchup.playoffTierType,
              // Transform and clean roster data from current scoring period
              homeRoster: transformRosterData(matchup.home?.rosterForCurrentScoringPeriod),
              awayRoster: transformRosterData(matchup.away?.rosterForCurrentScoringPeriod),
            }))
          });
        }

        // Update league sync timestamp for current season
        if (year === currentYear) {
          // Determine current scoring period from multiple possible sources
          const currentScoringPeriod = leagueData.scoringPeriodId || 
                                      leagueData.status?.currentMatchupPeriod || 
                                      leagueData.status?.latestScoringPeriod || 
                                      settings?.scoringSettings?.currentScoringPeriod || 
                                      league.espnData.currentScoringPeriod;

          await ctx.runMutation(internal.espnSync.updateLeagueSync, {
            leagueId: args.leagueId,
            currentScoringPeriod: currentScoringPeriod,
            seasonId: currentYear,
          });

          // FAAB waiver-wire report data (audit gap 4.5): "Sync now" used to
          // never call this, so the button's own copy ("happens
          // automatically... before every story") was false for the
          // transaction log specifically. Same [cur, cur-1] / full-season-
          // backfill choice the 4-hourly cron makes. Never fatal.
          if (typeof currentScoringPeriod === "number" && currentScoringPeriod > 0) {
            try {
              const hasLog: boolean = await ctx.runQuery(internal.espnSync.hasTransactionLogForSeason, {
                leagueId: args.leagueId,
                seasonId: currentYear,
              });

              const periodsToSync: number[] = hasLog
                ? [currentScoringPeriod, ...(currentScoringPeriod > 1 ? [currentScoringPeriod - 1] : [])]
                : Array.from({ length: currentScoringPeriod }, (_, i) => i + 1);

              await ctx.runAction(internal.espnSync.syncTransactionLog, {
                leagueId: args.leagueId,
                seasonId: currentYear,
                scoringPeriods: periodsToSync,
              });
            } catch (transactionLogError) {
              console.error(`Error syncing transaction log for league ${league.name}:`, transactionLogError);
            }
          }
        }

        // Fetch rosters for each year after teams are synced
        console.log(`Fetching rosters for year ${year}...`);
        let rostersFetched = 0;
        try {
          const rosterResult = await ctx.runAction(internal.espnSync.fetchHistoricalRostersInternal, {
            leagueId: args.leagueId,
            seasonId: year,
          });

          if (rosterResult.success) {
            rostersFetched = rosterResult.totalRostersFetched;
            console.log(`Successfully fetched rosters for ${rostersFetched} teams in ${year}`);
          } else {
            console.warn(`Failed to fetch some rosters for ${year}:`, rosterResult.message);
            stepErrors.push(`rosters: ${rosterResult.message}`);
          }
        } catch (rosterError) {
          console.error(`Error fetching rosters for ${year}:`, rosterError);
          // Don't fail the entire sync if roster fetching fails - recorded as a warning instead.
          stepErrors.push(`rosters: ${rosterError instanceof Error ? rosterError.message : 'Unknown error'}`);
        }

        // Fetch matchup rosters for each year after teams are synced
        console.log(`Fetching matchup rosters for year ${year}...`);
        let matchupRostersFetched = 0;
        try {
          const matchupRosterResult = await ctx.runAction(internal.matchupRosters.fetchMatchupRosters, {
            leagueId: args.leagueId,
            seasonId: year,
          });

          if (matchupRosterResult.success) {
            matchupRostersFetched = matchupRosterResult.successfulPeriods;
            console.log(`Successfully fetched matchup rosters for ${matchupRostersFetched}/${matchupRosterResult.totalPeriods} periods in ${year}`);
          } else {
            console.warn(`Failed to fetch matchup rosters for ${year}:`, matchupRosterResult.message);
            stepErrors.push(`matchupRosters: ${matchupRosterResult.message}`);
          }
        } catch (matchupRosterError) {
          console.error(`Error fetching matchup rosters for ${year}:`, matchupRosterError);
          // Don't fail the entire sync if matchup roster fetching fails - recorded as a warning instead.
          stepErrors.push(`matchupRosters: ${matchupRosterError instanceof Error ? matchupRosterError.message : 'Unknown error'}`);
        }

        // Fetch player stats for each year after rosters are synced
        console.log(`Fetching player stats for year ${year}...`);
        let playerStatsSynced = 0;
        try {
          const statsResult = await ctx.runAction(internal.playerSync.syncAllLeaguePlayerStats, {
            leagueId: args.leagueId,
            season: year,
          });

          if (statsResult.status === "success") {
            playerStatsSynced = statsResult.totalPlayersProcessed;
            console.log(`Successfully synced player stats for ${playerStatsSynced} players in ${year}`);
          } else {
            console.warn(`Failed to sync player stats for ${year}`);
            stepErrors.push(`playerStats: sync did not report success`);
          }
        } catch (statsError) {
          console.error(`Error syncing player stats for ${year}:`, statsError);
          // Don't fail the entire sync if player stats syncing fails - recorded as a warning instead.
          stepErrors.push(`playerStats: ${statsError instanceof Error ? statsError.message : 'Unknown error'}`);
        }

        results.push({
          year,
          success: true,
          teamsCount: teams.length,
          matchupsCount: schedule.length,
          playersCount: year === currentYear ? players.length : 0,
          rostersCount: rostersFetched,
          matchupRostersCount: matchupRostersFetched,
          playerStatsCount: playerStatsSynced,
          transactionsCount: transactionsSynced,
          stepErrors: stepErrors.length > 0 ? stepErrors : undefined,
        });
        totalSynced++;
        
        console.log(`Successfully synced year ${year}: ${teams.length} teams, ${schedule.length} matchups, ${rostersFetched} rosters, ${matchupRostersFetched} matchup periods, ${playerStatsSynced} player stats, ${transactionsSynced} transactions`);
        
        // Add small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`Failed to sync data for year ${year}:`, error);
        results.push({ 
          year, 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        totalErrors++;
      }
    }

    // Overall success requires the current season to have actually synced
    // (when it was requested) - a sync that pulled in nine historical years
    // but failed on the current season isn't something callers should treat
    // as "it worked".
    const currentSeasonResult = results.find((r: { year: number }) => r.year === currentYear);
    const overallSuccess =
      totalSynced > 0 && (!includeCurrentSeason || currentSeasonResult?.success === true);
    const warnings = results.reduce(
      (sum: number, r: { stepErrors?: string[] }) => sum + (r.stepErrors?.length ?? 0),
      0
    );

    return {
      success: overallSuccess,
      totalYearsRequested: yearsToSync.length,
      totalSynced,
      totalErrors,
      warnings,
      results,
      message: `Sync completed: ${totalSynced}/${yearsToSync.length} years synced successfully${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}`,
      syncedAt: Date.now(),
    };
  },
});

// Sync all historical player stats for all leagues
export const syncAllHistoricalPlayerStats = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    status: string;
    message: string;
    totalLeagues: number;
    totalSeasons: number;
    results: Array<{
      leagueId: string;
      leagueName: string;
      status: string;
      seasonsProcessed?: number;
      error?: string;
    }>;
    timestamp: number;
  }> => {
    console.log("Starting comprehensive historical player stats sync for all leagues");
    
    // This delegates to the playerHistoricalSync module
    return await ctx.runAction(internal.playerHistoricalSync.syncAllLeaguesHistoricalPlayerStats, {});
  }
});

// Historical roster fetching action
const fetchHistoricalRostersArgs = {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    teamIds: v.optional(v.array(v.string())), // If not provided, fetches for all teams
};

type FetchHistoricalRostersResult = {
    success: boolean;
    totalTeams: number;
    totalRostersFetched: number;
    totalErrors: number;
    results: Array<{
      teamId: string;
      teamName: string;
      success: boolean;
      error?: string;
      playersCount?: number;
    }>;
    message: string;
    fetchedAt: number;
  };

// Shared implementation. Reached via the commissioner-gated public action below (UI) or the
// internal action (crons / other sync actions, which have no identity).
async function fetchHistoricalRostersImpl(
  ctx: ActionCtx,
  args: ObjectType<typeof fetchHistoricalRostersArgs>
): Promise<FetchHistoricalRostersResult> {

    const league: any = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });

    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    // Validate ESPN credentials if league is private
    if (league.espnData.isPrivate) {
      const credentialsCheck = await validateEspnCredentials(
        league.externalId,
        league.espnData.espnS2,
        league.espnData.swid,
        currentSeasonForLeague(league)
      );

      if (!credentialsCheck.isValid) {
        throw new Error(`ESPN credentials invalid: ${credentialsCheck.error}. Please re-authenticate with ESPN.`);
      }
    }

    // Get teams for the specified season using a query
    const teams = await ctx.runQuery(internal.teams.getBySeasonAndLeagueInternal, {
      leagueId: args.leagueId,
      seasonId: args.seasonId
    });

    if (teams.length === 0) {
      throw new Error(`No teams found for season ${args.seasonId}. Please sync team data first.`);
    }

    // Filter teams if specific teamIds provided
    const teamsToFetch = args.teamIds
      ? teams.filter((team: any) => args.teamIds!.includes(team.externalId))
      : teams;

    // Check if draft has occurred for current season - skip roster fetching if not
    const currentYear = currentSeasonForLeague(league);
    if (args.seasonId === currentYear) {
      // For current season, check draft status before fetching rosters
      try {
        const { response: leagueResponse } = await fetchEspn(
          `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${args.seasonId}/segments/0/leagues/${league.externalId}?view=mDraftDetail`,
          { creds: normalizeEspnCredentials(league.espnData) }
        );

        if (leagueResponse.ok) {
          const leagueData = await leagueResponse.json();
          // Check if the draft has actually occurred - ESPN sends a BOOLEAN
          // on `drafted` (see `isDrafted`'s doc comment); this used to
          // compare `!== 1`, which is always true, so the current season's
          // roster fetch always bailed here even after the draft.
          if (!isDrafted(leagueData.draftDetail)) {
            return {
              success: false,
              totalTeams: teamsToFetch.length,
              totalRostersFetched: 0,
              totalErrors: 1,
              results: [],
              message: "Draft has not occurred yet for current season. Cannot fetch rosters.",
              fetchedAt: Date.now(),
            };
          }
        }
      } catch (error) {
        console.log("Could not verify draft status, proceeding with roster fetch:", error);
      }
    }

    const results = [];
    let totalRostersFetched = 0;
    let totalErrors = 0;

    for (const team of teamsToFetch) {
      try {
        console.log(`Fetching historical roster for team ${team.name} (${team.externalId}) for season ${args.seasonId}...`);
        
        const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${args.seasonId}/segments/0/leagues/${league.externalId}`;
        const viewParams = `?rosterForTeamId=${team.externalId}&view=mDraftDetail&view=mLiveScoring&view=mMatchupScore&view=mPendingTransactions&view=mPositionalRatings&view=mRoster&view=mSettings&view=mTeam&view=modular&view=mNav`;

        // Add fantasy filter for all matchup periods to get roster data

        const { response } = await fetchEspn(`${baseUrl}${viewParams}`, {
          creds: normalizeEspnCredentials(league.espnData),
          headers: { 'X-Fantasy-Filter': generateFantasyFilterHeader(league.settings) },
        });

        if (!response.ok) {
          console.error(`Failed to fetch roster for team ${team.externalId}:`, response.status, response.statusText);
          results.push({
            teamId: team.externalId,
            teamName: team.name,
            success: false,
            error: `HTTP ${response.status}: ${response.statusText}`
          });
          totalErrors++;
          continue;
        }

        const data = await response.json();
        
        // Extract roster data from the response
        let rosterEntries = [];
        
        // Check multiple possible locations for roster data
        if (data.teams) {
          const teamData = data.teams.find((t: any) => t.id.toString() === team.externalId);
          if (teamData?.roster?.entries) {
            rosterEntries = teamData.roster.entries;
          }
        }
        
        // If no roster found in teams, try the direct roster property
        if (rosterEntries.length === 0 && data.roster?.entries) {
          rosterEntries = data.roster.entries;
        }

        if (rosterEntries.length === 0) {
          console.warn(`No roster data found for team ${team.externalId} in season ${args.seasonId}`);
          results.push({
            teamId: team.externalId,
            teamName: team.name,
            success: false,
            error: 'No roster data available for this team/season combination'
          });
          totalErrors++;
          continue;
        }

        // Process and store the roster data
        const historicalRoster = rosterEntries.map((entry: any) => ({
          playerId: entry.playerId?.toString() || '',
          playerName: entry.playerPoolEntry?.player?.fullName || 'Unknown',
          position: entry.playerPoolEntry?.player?.defaultPositionId ? getPositionName(entry.playerPoolEntry.player.defaultPositionId) : 'UNKNOWN',
          team: entry.playerPoolEntry?.player?.proTeamId ? getTeamAbbreviation(entry.playerPoolEntry.player.proTeamId) : 'FA',
          acquisitionType: entry.acquisitionType,
          lineupSlotId: entry.lineupSlotId,
          playerStats: entry.playerPoolEntry?.player?.stats ? {
            appliedTotal: entry.playerPoolEntry.player.stats.appliedTotal,
            projectedTotal: entry.playerPoolEntry.player.stats.projectedTotal,
          } : undefined,
        }));

        // Update the team's roster for this season using a mutation
        await ctx.runMutation(internal.teams.updateTeamRosterInternal, {
          teamId: team._id,
          roster: historicalRoster,
        });

        results.push({
          teamId: team.externalId,
          teamName: team.name,
          success: true,
          playersCount: historicalRoster.length
        });
        totalRostersFetched++;
        
        console.log(`Successfully fetched roster for team ${team.name}: ${historicalRoster.length} players`);
        
        // Add small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`Failed to fetch roster for team ${team.externalId}:`, error);
        results.push({
          teamId: team.externalId,
          teamName: team.name,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        totalErrors++;
      }
    }

    return {
      success: totalRostersFetched > 0,
      totalTeams: teamsToFetch.length,
      totalRostersFetched,
      totalErrors,
      results,
      message: `Historical rosters fetch completed: ${totalRostersFetched}/${teamsToFetch.length} teams fetched successfully`,
      fetchedAt: Date.now(),
    };
}

export const fetchHistoricalRosters = action({
  args: fetchHistoricalRostersArgs,
  handler: async (ctx, args): Promise<FetchHistoricalRostersResult> => {
    await requireLeagueMemberFromAction(ctx, args.leagueId, { commissioner: true });
    return fetchHistoricalRostersImpl(ctx, args);
  },
});

export const fetchHistoricalRostersInternal = internalAction({
  args: fetchHistoricalRostersArgs,
  handler: async (ctx, args): Promise<FetchHistoricalRostersResult> => fetchHistoricalRostersImpl(ctx, args),
});
/**
 * Shared implementation for `fetchDraftDataForSeason` (below, commissioner-
 * gated) and `fetchDraftDataForSeasonInternal` (the season-closed pull's
 * internal twin - see `convex/seasonSync.ts`). `internal.playerSync.syncAllPlayers`
 * is skipped rather than called: it requires a user identity
 * (`requireLeagueMemberFromAction`/`requireIdentity`), which the internal
 * path (a cron/scheduled job, no caller) doesn't have; the season-closed job
 * already refreshes the player pool separately
 * (`playerSync.syncAllLeaguePlayerStats`), so this is a genuine skip, not a
 * silent failure.
 */
async function fetchDraftDataForSeasonImpl(
  ctx: ActionCtx,
  args: { leagueId: Id<"leagues">; seasonId: number },
  opts: { syncPlayerPool: boolean }
): Promise<{
  success: boolean;
  message: string;
  error?: string;
  picksCount?: number;
}> {
    const league: any = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });

    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    // Validate ESPN credentials if league is private
    if (league.espnData.isPrivate) {
      const credentialsCheck = await validateEspnCredentials(
        league.externalId,
        league.espnData.espnS2,
        league.espnData.swid,
        currentSeasonForLeague(league)
      );

      if (!credentialsCheck.isValid) {
        throw new Error(`ESPN credentials invalid: ${credentialsCheck.error}. Please re-authenticate with ESPN.`);
      }
    }

    try {
      console.log(`Fetching draft data for season ${args.seasonId}...`);

      const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${args.seasonId}/segments/0/leagues/${league.externalId}`;

      // Add fantasy filter for all matchup periods to get comprehensive data

      // Fetch league data with draft details
      const { response } = await fetchEspn(
        `${baseUrl}?view=mDraftDetail&view=mSettings&view=mTeam&view=modular&view=mNav`,
        {
          creds: normalizeEspnCredentials(league.espnData),
          headers: { 'X-Fantasy-Filter': generateFantasyFilterHeader(league.settings) },
        }
      );

      if (!response.ok) {
        console.error(`ESPN API Error for draft data:`, {
          status: response.status,
          statusText: response.statusText,
        });
        return {
          success: false,
          message: `Failed to fetch draft data`,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const leagueData = await response.json();
      const draftDetail = leagueData.draftDetail;
      const settings = leagueData.settings;

      if (!draftDetail?.picks || draftDetail.picks.length === 0) {
        return {
          success: false,
          message: "No draft data available for this season",
          error: "Draft has not occurred yet or data is not available",
        };
      }

      // Sync all player data for this season to ensure comprehensive playersEnhanced table
      if (opts.syncPlayerPool) {
        try {
          await ctx.runAction(api.playerSync.syncAllPlayers, {
            season: args.seasonId,
            forceUpdate: false,
            leagueId: args.leagueId,
          });
        } catch (playerSyncError) {
          console.warn("Failed to sync all players data for season, continuing with draft data sync:", playerSyncError);
        }
      }

      // Get existing season record (internal-only lookup: the public
      // `leagues.getLeagueSeasonByYear` requires an authenticated member and
      // returns null otherwise, which is exactly what a cron/internal caller
      // has - it would silently look like "no season exists yet" every time).
      const existingSeason = await ctx.runQuery(internal.espnSync.getLeagueSeasonInternal, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
      });

      if (!existingSeason) {
        // Create new season record with draft data
        const seasonData: any = {
          settings: buildSeasonSettings(settings, league.name, 10).seasonSettings,
          // Always provide draftInfo when we have draftDetail
          draftInfo: draftDetail ? {
            draftDate: draftDetail.completeDate || (draftDetail.drafted ? 1 : undefined),
            draftType: draftDetail.type,
            timePerPick: draftDetail.timePerPick,
            drafted: draftDetail.drafted,
            inProgress: draftDetail.inProgress,
          } : undefined,
        };

        // Only include draftSettings if it exists
        if (settings?.draftSettings) {
          seasonData.draftSettings = settings.draftSettings;
        }

        // Only include draft if it exists
        if (draftDetail.picks) {
          seasonData.draft = draftDetail.picks;
        }

        await ctx.runMutation(internal.espnSync.updateLeagueSeason, {
          leagueId: args.leagueId,
          seasonId: args.seasonId,
          seasonData,
        });
      } else {
        // Update existing season with draft data
        const updateData: any = {
          draftInfo: {
            draftDate: draftDetail.completeDate || (draftDetail.drafted ? 1 : undefined),
            draftType: draftDetail.type,
            timePerPick: draftDetail.timePerPick,
            drafted: draftDetail.drafted,
            inProgress: draftDetail.inProgress,
          },
        };

        // Only include draftSettings if it exists
        if (settings?.draftSettings) {
          updateData.draftSettings = settings.draftSettings;
        }

        // Only include draft if it exists
        if (draftDetail.picks) {
          updateData.draft = draftDetail.picks;
        }

        await ctx.runMutation(internal.espnSync.updateSeasonDraftData, {
          seasonId: existingSeason._id,
          ...updateData,
        });
      }

      return {
        success: true,
        message: `Successfully fetched draft data for ${args.seasonId}`,
        picksCount: draftDetail.picks.length,
      };

    } catch (error) {
      console.error(`Failed to fetch draft data for season ${args.seasonId}:`, error);
      return {
        success: false,
        message: "Failed to fetch draft data",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
}

// Action to fetch draft data for a specific season
export const fetchDraftDataForSeason = action({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    await requireLeagueMemberFromAction(ctx, args.leagueId, { commissioner: true });
    return fetchDraftDataForSeasonImpl(ctx, args, { syncPlayerPool: true });
  },
});

/**
 * Internal twin of `fetchDraftDataForSeason` - no commissioner gate (a
 * cron/scheduled caller has no identity to check), same body. Used by the
 * season-closed pull (`convex/seasonSync.ts`) to fix the automatic sync's
 * long-standing bug where `leagueSeasons.draft` was only ever written by the
 * manual "Draft data" button (audit gap 4.6).
 */
export const fetchDraftDataForSeasonInternal = internalAction({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => fetchDraftDataForSeasonImpl(ctx, args, { syncPlayerPool: false }),
});

/** Internal-only lookup of a `leagueSeasons` row by (leagueId, seasonId) -
 * see `fetchDraftDataForSeasonImpl`'s doc comment for why this exists
 * alongside the public, identity-gated `leagues.getLeagueSeasonByYear`. */
export const getLeagueSeasonInternal = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();
  },
});

// Enhanced sync function that includes historical roster fetching
export const syncAllDataWithRosters = action({
  args: {
    leagueId: v.id("leagues"),
    includeCurrentSeason: v.optional(v.boolean()),
    historicalYears: v.optional(v.number()),
    includeHistoricalRosters: v.optional(v.boolean()), // New option
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    totalYearsRequested: number;
    totalSynced: number;
    totalErrors: number;
    warnings: number;
    results: Array<{
      year: number;
      success: boolean;
      error?: string;
      teamsCount?: number;
      matchupsCount?: number;
      playersCount?: number;
      rostersCount?: number;
      matchupRostersCount?: number;
      transactionsCount?: number;
      stepErrors?: string[];
    }>;
    message: string;
    syncedAt: number;
  }> => {
    await requireLeagueMemberFromAction(ctx, args.leagueId, { commissioner: true });

    // First run the regular sync
    const regularSyncResult = await ctx.runAction(api.espnSync.syncAllLeagueData, {
      leagueId: args.leagueId,
      includeCurrentSeason: args.includeCurrentSeason,
      historicalYears: args.historicalYears,
    });

    if (!regularSyncResult.success || !args.includeHistoricalRosters) {
      return regularSyncResult;
    }

    // Now fetch historical rosters for each successfully synced year
    const enhancedResults = [];
    
    for (const result of regularSyncResult.results) {
      if (result.success) {
        try {
          console.log(`Fetching rosters for year ${result.year}...`);
          
          const rosterResult = await ctx.runAction(internal.espnSync.fetchHistoricalRostersInternal, {
            leagueId: args.leagueId,
            seasonId: result.year,
          });

          enhancedResults.push({
            ...result,
            rostersCount: rosterResult.success ? rosterResult.totalRostersFetched : 0,
            matchupRostersCount: 0, // This function doesn't fetch matchup rosters
          });
          
          console.log(`Rosters for ${result.year}: ${rosterResult.success ? `${rosterResult.totalRostersFetched} teams` : 'failed'}`);
          
          // Add delay between roster fetches to prevent rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
          
        } catch (error) {
          console.error(`Failed to fetch rosters for year ${result.year}:`, error);
          enhancedResults.push({
            ...result,
            rostersCount: 0,
            matchupRostersCount: 0,
          });
        }
      } else {
        enhancedResults.push(result);
      }
    }

    return {
      ...regularSyncResult,
      results: enhancedResults,
      message: args.includeHistoricalRosters 
        ? `Sync completed with historical rosters: ${regularSyncResult.totalSynced}/${regularSyncResult.totalYearsRequested} years synced successfully`
        : regularSyncResult.message,
    };
  },
});

export const updateLeagueSync = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    currentScoringPeriod: v.number(),
    seasonId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league || !league.espnData) {
      throw new Error("League or ESPN data not found");
    }

    await ctx.db.patch(args.leagueId, {
      espnData: {
        ...league.espnData,
        currentScoringPeriod: args.currentScoringPeriod,
        ...(args.seasonId !== undefined ? { seasonId: args.seasonId } : {}),
        lastSyncedAt: Date.now(),
      },
      lastSync: Date.now(),
    });
  },
});

export const syncPlayerTransactions = internalAction({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    players: v.array(v.any()),
    currentScoringPeriod: v.number(),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    transactionsProcessed: number;
    duplicatesSkipped: number;
    message: string;
  }> => {
    const allTransactions = [];
    const processedTransactionIds = new Set<string>();
    
    // Extract transactions from each player
    for (const player of args.players) {
      if (player.transactions && Array.isArray(player.transactions)) {
        for (const transaction of player.transactions) {
          // Skip if we've already processed this transaction ID
          if (processedTransactionIds.has(transaction.id)) {
            continue;
          }
          
          processedTransactionIds.add(transaction.id);
          

          
          allTransactions.push({
            leagueId: args.leagueId,
            seasonId: args.seasonId,
            espnTransactionId: transaction.id,
            bidAmount: transaction.bidAmount || 0,
            executionType: transaction.executionType || 'UNKNOWN',
            isActingAsTeamOwner: transaction.isActingAsTeamOwner || false,
            isLeagueManager: transaction.isLeagueManager || false,
            isPending: transaction.isPending || false,
            items: transaction.items || [],
            proposedDate: transaction.proposedDate || Date.now(),
            scoringPeriod: transaction.scoringPeriodId || args.currentScoringPeriod,
            status: transaction.status,
            type: transaction.type,
            teamId: transaction.teamId,
          });
        }
      }
    }
    
    // Store unique transactions
    const result = await ctx.runMutation(internal.espnSync.storePlayerTransactions, {
      transactions: allTransactions,
    });
    
    return {
      success: true,
      transactionsProcessed: result.stored,
      duplicatesSkipped: result.skipped,
      message: `Processed ${allTransactions.length} transactions, stored ${result.stored} new transactions`,
    };
  },
});

// Store player transactions in database
export const storePlayerTransactions = internalMutation({
  args: {
    transactions: v.array(v.object({
      leagueId: v.id("leagues"),
      seasonId: v.number(),
      espnTransactionId: v.string(),
      bidAmount: v.number(),
      executionType: v.string(),
      isActingAsTeamOwner: v.boolean(),
      isLeagueManager: v.boolean(),
      isPending: v.boolean(),
      items: v.array(v.any()),
      type: v.string(),
      proposedDate: v.number(),
      processedDate: v.optional(v.number()),
      scoringPeriod: v.number(),
      status: v.string(),
      teamId: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args): Promise<{ stored: number; skipped: number }> => {
    const now = Date.now();
    let stored = 0;
    let skipped = 0;
    
    for (const transaction of args.transactions) {
      // Skip transactions without a teamId as it's required by the schema
      if (transaction.teamId === undefined) {
        skipped++;
        continue;
      }
      
      // Check if transaction already exists by ESPN ID. A transaction_log
      // row (from `upsertTransactions`) is authoritative for the same ESPN
      // id, so a player_feed row never overwrites one - it just skips.
      const existingTransaction = await ctx.db
        .query("transactions")
        .withIndex("by_espn_id", q => q.eq("espnTransactionId", transaction.espnTransactionId))
        .first();

      if (!existingTransaction) {
        const outcome = classifyTransactionStatus(transaction.status, transaction.isPending);
        await ctx.db.insert("transactions", {
          ...transaction,
          teamId: transaction.teamId, // Explicitly ensure teamId is number (not undefined)
          outcome,
          failureReason: outcome === "failed" ? transaction.status : undefined,
          source: "player_feed",
          createdAt: now,
        });
        stored++;
      } else {
        skipped++;
      }
    }

    return { stored, skipped };
  },
});

/**
 * Fetch ESPN's `view=mTransactions2` transaction log for one or more
 * scoring periods and upsert the results. This is the FAAB waiver wire
 * report's real data source (spec: `syncPlayerTransactions`'s per-player
 * `transactions` arrays miss most of the log - production had none before
 * December 2025). One ESPN request per requested scoring period - ESPN's
 * `mTransactions2` view only returns a `transactions` array when the
 * request names a single `scoringPeriodId` (verified against
 * `tests/fixtures/espn-transactions-public.json`). Sequential with a short
 * delay between requests to stay polite to ESPN on top of `fetchEspn`'s own
 * 429/5xx retry/backoff. Never throws - a failed period is recorded in the
 * result and the rest continue.
 */
export const syncTransactionLog = internalAction({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    scoringPeriods: v.array(v.number()),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    periodsFetched: number;
    periodsFailed: number;
    transactionsUpserted: number;
    message: string;
  }> => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league) {
      return {
        success: false,
        periodsFetched: 0,
        periodsFailed: 0,
        transactionsUpserted: 0,
        message: "League not found",
      };
    }
    if (!league.espnData) {
      return {
        success: false,
        periodsFetched: 0,
        periodsFailed: 0,
        transactionsUpserted: 0,
        message: "No ESPN data configured for this league",
      };
    }

    const creds = normalizeEspnCredentials(league.espnData);
    const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${args.seasonId}/segments/0/leagues/${league.externalId}`;

    let periodsFetched = 0;
    let periodsFailed = 0;
    let transactionsUpserted = 0;

    for (const period of args.scoringPeriods) {
      try {
        const { response, classification } = await fetchEspn(
          `${baseUrl}?view=mTransactions2&scoringPeriodId=${period}`,
          { creds }
        );

        if (!response.ok) {
          console.error(
            `syncTransactionLog: ESPN returned ${response.status} for league ${league.name} period ${period} (${classification})`
          );
          periodsFailed++;
          continue;
        }

        const data = await response.json();
        const rawTransactions: RawEspnTransaction[] = Array.isArray(data.transactions)
          ? data.transactions
          : [];

        if (rawTransactions.length > 0) {
          const normalized = rawTransactions.map((raw) =>
            normalizeEspnTransaction(raw, {
              leagueId: args.leagueId,
              seasonId: args.seasonId,
              scoringPeriod: period,
            })
          );

          const result: { inserted: number; updated: number } = await ctx.runMutation(
            internal.espnSync.upsertTransactions,
            { transactions: normalized }
          );
          transactionsUpserted += result.inserted + result.updated;
        }

        periodsFetched++;
      } catch (error) {
        console.error(
          `syncTransactionLog: failed to sync period ${period} for league ${league.name}:`,
          error
        );
        periodsFailed++;
      }

      // Small delay between per-period requests, mirroring the delay
      // pattern already used elsewhere in this file to avoid rate limiting.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return {
      success: periodsFailed === 0,
      periodsFetched,
      periodsFailed,
      transactionsUpserted,
      message: `Fetched ${periodsFetched}/${args.scoringPeriods.length} scoring period(s), upserted ${transactionsUpserted} transaction(s)`,
    };
  },
});

/**
 * Upsert normalized transaction-log rows by `espnTransactionId`. Always
 * authoritative: patches an existing row regardless of its prior `source`
 * (so a transaction_log row overwrites an older `player_feed` row for the
 * same ESPN id), and a later re-fetch of the same period legitimately
 * updates a row it already wrote as ESPN resolves it (e.g. `pending` ->
 * `executed`/`failed` once the overnight waiver run processes) - idempotent
 * either way, `createdAt` is preserved across updates.
 */
export const upsertTransactions = internalMutation({
  args: {
    transactions: v.array(normalizedTransactionValidator),
  },
  handler: async (ctx, args): Promise<{ inserted: number; updated: number }> => {
    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    // TRADE_ACCEPT rows this call actually wrote (inserted or updated) - fed
    // to `tradesSync.deriveTradesForTransactionIds` below so the `trades`
    // table (and `trade_occurred` content event) stay derived from the same
    // transaction log this mutation is the one writer of (audit gap 4.10).
    const tradeAcceptIds: string[] = [];

    for (const transaction of args.transactions) {
      const existing = await ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", transaction.espnTransactionId))
        .first();

      if (!existing) {
        await ctx.db.insert("transactions", { ...transaction, createdAt: now });
        inserted++;
      } else {
        await ctx.db.patch(existing._id, { ...transaction, createdAt: existing.createdAt });
        updated++;
      }

      if (transaction.type === "TRADE_ACCEPT") {
        tradeAcceptIds.push(transaction.espnTransactionId);
      }
    }

    if (tradeAcceptIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.tradesSync.deriveTradesForTransactionIds, {
        espnTransactionIds: tradeAcceptIds,
      });
    }

    return { inserted, updated };
  },
});

/**
 * Whether any transaction_log-sourced row exists for this league/season -
 * the "first sync of a season" signal `syncOneLeagueCurrentSeasonBody` (this
 * file) uses to decide between a full 1..current backfill and the normal
 * current+previous-period fetch.
 */
export const hasTransactionLogForSeason = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query("transactions")
      .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .filter((q) => q.eq(q.field("source"), "transaction_log"))
      .first();
    return row !== null;
  },
});

/**
 * Page an operator and every commissioner of `league` about invalid ESPN
 * credentials, at most once per 24h per league.
 *
 * Only called for an "auth" classification (401/403) - a rate-limited or
 * flaky-ESPN failure isn't a credentials problem and shouldn't wake anyone
 * up. `league.espnData.credentialAlertedAt` is the dedupe clock; the operator
 * notice ledger (`deskMetrics.claimOperatorNotice`) is the delivery-once
 * guarantee for the email itself, reusing the same mechanism the daily desk
 * digest uses rather than inventing a second one.
 */
async function alertInvalidEspnCredentials(
  ctx: ActionCtx,
  league: { _id: Id<"leagues">; name: string; espnData?: { credentialAlertedAt?: number } }
): Promise<void> {
  const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const alertedAt = league.espnData?.credentialAlertedAt;
  if (alertedAt && Date.now() - alertedAt < ALERT_COOLDOWN_MS) {
    return;
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dedupeKey = `espn_credentials_invalid:${league._id}:${today}`;
  const subject = `FFSN: ESPN connection needs attention for "${league.name}"`;
  const text =
    `${subject}\n\n` +
    `League: ${league.name} (${league._id})\n` +
    `ESPN rejected the stored espn_s2/SWID cookies (401/403) during the current-season sync.\n` +
    `The commissioner has been notified in-app to reconnect from League settings.`;

  try {
    const claimed: boolean = await ctx.runMutation(internal.deskMetrics.claimOperatorNotice, {
      key: dedupeKey,
      kind: "espn_credentials_invalid",
      subject,
      leagueId: league._id,
    });
    if (claimed) {
      const to = process.env.ADMIN_ALERT_EMAIL;
      let sent = false;
      if (!to) {
        console.error(`[operator alert] ${subject}\n${text}`);
      } else {
        const result = await ctx.runAction(internal.emailService.sendPlainEmail, {
          to,
          subject,
          text,
          fromName: "FFSN Desk",
          relatedEntityType: "operator_alert",
        });
        sent = result.success;
      }
      await ctx.runMutation(internal.deskMetrics.markOperatorNoticeDelivered, {
        key: dedupeKey,
        delivered: sent,
      });
    }
  } catch (error) {
    // The operator notice is best-effort - it must never block the
    // commissioner notification below or the sync loop itself.
    console.error(`Failed to send operator alert for league ${league._id}:`, error);
  }

  // Notify every commissioner of this league in-app, regardless of whether
  // the operator email succeeded.
  try {
    const commissionerUserIds = await ctx.runQuery(
      internal.leagues.getCommissionerUserIdsInternal,
      { leagueId: league._id }
    );
    for (const userId of commissionerUserIds) {
      await ctx.runMutation(internal.notifications.createNotification, {
        userId,
        leagueId: league._id,
        type: "account_update" as const,
        title: `ESPN connection needs attention for ${league.name}`,
        message:
          `ESPN rejected the stored connection cookies for ${league.name}. ` +
          `Reconnect ESPN from League settings to resume syncing.`,
        actionUrl: `/leagues/${league._id}/settings`,
        actionText: "Open League settings",
        relatedEntityType: "league" as const,
        relatedEntityId: league._id,
        priority: "high" as const,
        deliveryChannels: ["in_app"] as const,
        dedupeKey,
      });
    }
  } catch (error) {
    console.error(`Failed to notify commissioners for league ${league._id}:`, error);
  }

  await ctx.runMutation(internal.leagues.setEspnCredentialStatus, {
    leagueId: league._id,
    status: "invalid",
    alertedAt: Date.now(),
  });
}

/** Only the fields `syncSeasonCore` needs to know about an unfinalized
 * previous season - fed to `seasonsToSync` (`convex/lib/seasonToSync.ts`). */
export const getLeagueSeasonsForSyncInternal = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<Array<{ seasonId: number; finalizedAt?: number }>> => {
    const seasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    return seasons.map((s) => ({ seasonId: s.seasonId, finalizedAt: s.finalizedAt }));
  },
});

/** Stamps `leagueSeasons.lastFullSyncAt` - "this season was pulled in full
 * (settings, teams, matchups, draft, player-feed transactions) just now".
 * Called by `syncSeasonCore` on every successful pull, current season or not. */
export const stampLeagueSeasonFullSync = internalMutation({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  handler: async (ctx, args) => {
    const season = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();
    if (season) {
      await ctx.db.patch(season._id, { lastFullSyncAt: Date.now() });
    }
  },
});

/**
 * Stamps only `espnData.lastSyncedAt`/`lastSync` - for a successful
 * `alsoSync` (previous-season) pull, which must NOT touch
 * `espnData.seasonId`/`currentScoringPeriod` (those describe the season the
 * league is actually ON; `updateLeagueSync` is the one that sets them, and
 * only ever runs for the current season). Without this, a previous season
 * refreshing successfully while `current` 404s (ESPN hasn't opened it yet)
 * would leave `lastSyncedAt` looking frozen even though the league WAS just
 * synced (seasonToSync.ts's rollover contract).
 */
export const touchLeagueLastSynced = internalMutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league?.espnData) return;
    await ctx.db.patch(args.leagueId, {
      espnData: { ...league.espnData, lastSyncedAt: Date.now() },
      lastSync: Date.now(),
    });
  },
});

/**
 * One MAIN17 pull for `seasonId` plus the upsert chain every full-season
 * sync shares: `updateLeagueSeason` (settings/draftInfo/draftSettings/draft
 * picks - NEVER champion/runnerUp/regularSeasonChampion; the bracket-derived
 * season-closed job in `convex/seasonSync.ts` owns those and would have its
 * write clobbered on the very next liveness-cron tick otherwise),
 * `updateTeams` (record incl. ESPN's final-rank/streak fields, owners,
 * roster straight from the payload, transactionCounter), `updateMatchups`
 * (guarded against a partial payload / already-finalized periods - see that
 * mutation), and player-feed transactions (`updatePlayers` +
 * `syncPlayerTransactions`). `opts.isCurrentSeason` gates the two writes that
 * must never apply to a stale `alsoSync` season: `mirrorSeasonSettings`
 * (`leagues.settings` is a CURRENT-season mirror) and `updateLeagueSync`
 * (which stamps `leagues.espnData.seasonId` - doing that for last season
 * would silently undo rollover on every run).
 *
 * Shared by `syncOneLeagueCurrentSeasonBody` (below - the liveness/cron path,
 * which layers on its own extras: claim rollover, derived-metrics
 * scheduling, the transaction log, and roster/matchup-roster refresh) and
 * the internal `syncSeasonSnapshot` (a single targeted pull for one season,
 * with none of those extras - used by the season-closed job).
 */
async function syncSeasonCore(
  ctx: ActionCtx,
  league: Doc<"leagues">,
  seasonId: number,
  opts: { isCurrentSeason: boolean }
): Promise<{
  success: boolean;
  error?: string;
  classification?: EspnStatusClassification;
  teamsCount: number;
  matchupsCount: number;
  playersCount: number;
  transactionsCount: number;
  periodsInPayload: number[];
  draftPicks: number;
  currentScoringPeriod?: number;
  teamsWithRosterInPayload: number;
}> {
  const empty = {
    teamsCount: 0,
    matchupsCount: 0,
    playersCount: 0,
    transactionsCount: 0,
    periodsInPayload: [] as number[],
    draftPicks: 0,
    teamsWithRosterInPayload: 0,
  };

  if (!league.espnData) {
    return { success: false, error: "No ESPN data configured for this league", ...empty };
  }

  // Validate ESPN credentials if league is private
  if (league.espnData.isPrivate) {
    const credentialsCheck = await validateEspnCredentials(
      league.externalId,
      league.espnData.espnS2,
      league.espnData.swid,
      seasonId
    );

    if (!credentialsCheck.isValid) {
      console.error(`ESPN credentials invalid for league ${league.name}:`, credentialsCheck.error);

      // Only a genuine auth rejection (401/403) means the cookies
      // themselves are bad - a rate limit or ESPN outage isn't a
      // credentials problem and shouldn't page anyone or flip the
      // league's stored status.
      if (credentialsCheck.classification === "auth") {
        await ctx.runMutation(internal.leagues.setEspnCredentialStatus, {
          leagueId: league._id,
          status: "invalid",
          error: credentialsCheck.error,
        });
        await alertInvalidEspnCredentials(ctx, league);
      }

      return {
        success: false,
        error: `ESPN credentials invalid: ${credentialsCheck.error}`,
        classification: credentialsCheck.classification,
        ...empty,
      };
    }

    // Credentials still good - keep the stored status fresh so a
    // league that recovers stops showing as "invalid" in the UI.
    await ctx.runMutation(internal.leagues.setEspnCredentialStatus, {
      leagueId: league._id,
      status: "valid",
    });
  }

  const baseUrl: string = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${league.externalId}`;
  const creds = normalizeEspnCredentials(league.espnData);
  const viewParams = '?view=mSettings&view=mTeams&view=mRoster&view=mMatchup&view=mMatchupScore&view=mStandings&view=mDraftDetail&view=mNav&view=modular&view=players_wl&view=kona_player_info&view=mLogo&view=mTeam&view=mStatus&view=mBoxscore&view=mPositionalRatings&view=kona_league_communication&view=kona_playercard';

  const { response: leagueResponse, classification: leagueClassification } = await fetchEspn(
    `${baseUrl}${viewParams}`,
    { creds, headers: { 'X-Fantasy-Filter': generateFantasyFilterHeader(league.settings) } }
  );

  if (!leagueResponse.ok) {
    // ESPN hasn't opened this season yet (typically `current` right after
    // the calendar rolls over on Jan 1, weeks before this app's own
    // Aug->Jul season boundary agrees a new season has even started) - not
    // a failure worth logging loudly or alerting anyone over
    // (seasonToSync.ts's rollover contract).
    if (leagueClassification === "not_found") {
      console.log(`ESPN has not opened season ${seasonId} yet for league ${league.name} (404) - not an error.`);
      return { success: false, error: `Season ${seasonId} not yet available on ESPN`, classification: leagueClassification, ...empty };
    }

    const responseText = await leagueResponse.text();
    console.error(`ESPN API Error for league ${league.name}:`, {
      status: leagueResponse.status,
      statusText: leagueResponse.statusText,
      classification: leagueClassification,
      url: baseUrl + viewParams,
      hasAuth: !!(league.espnData.espnS2 && league.espnData.swid),
      isPrivate: league.espnData.isPrivate,
      responseText: responseText.slice(0, 200)
    });

    // The pre-fetch credential probe above already covers the private
    // case; this also catches a public league whose cookies (if any)
    // ESPN rejects mid-request, or one that quietly became private.
    if (leagueClassification === "auth" && league.espnData.isPrivate) {
      await ctx.runMutation(internal.leagues.setEspnCredentialStatus, {
        leagueId: league._id,
        status: "invalid",
        error: `HTTP ${leagueResponse.status}: ${leagueResponse.statusText}`,
      });
      await alertInvalidEspnCredentials(ctx, league);
    }

    return {
      success: false,
      error: `HTTP ${leagueResponse.status}: ${leagueResponse.statusText}${leagueClassification === 'auth' ? ' (Authentication required - check ESPN S2/SWID cookies)' : ''}`,
      classification: leagueClassification,
      ...empty,
    };
  }

  const leagueData = await leagueResponse.json();

  // Check if we got valid data
  if (!leagueData.settings && !leagueData.draftDetail) {
    console.warn(`Invalid data structure for league ${league.name} season ${seasonId}`);
    return { success: false, error: 'Invalid data structure returned from ESPN', ...empty };
  }

  const teams = leagueData.teams || [];
  const members = leagueData.members || [];
  const settings = leagueData.settings;
  const schedule = leagueData.schedule || [];
  const players = leagueData.players || [];
  const draftDetail = leagueData.draftDetail;

  // Create a map of member IDs to member data for easy lookup
  const memberMap = new Map();
  members.forEach((member: any) => {
    memberMap.set(member.id, member);
  });

  // Helper function to get owner info with fallback logic
  const getOwnerInfo = (team: any) => {
    // First try to get owner from team.owners array
    if (team.owners?.[0]) {
      const owner = team.owners[0];

      // Check if owner is just a string ID (historical data) or an object (current data)
      if (typeof owner === 'string') {
        // Owner is just an ID, need to look up in members
        const member = memberMap.get(owner);
        if (member) {
          return {
            ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
            ownerInfo: {
              displayName: member.displayName,
              firstName: member.firstName,
              lastName: member.lastName,
              id: member.id?.toString() || owner,
            }
          };
        }
      } else if (owner.displayName || owner.firstName || owner.lastName) {
        // Owner is an object with properties
        return {
          ownerName: (owner.firstName && owner.lastName ? `${owner.firstName} ${owner.lastName}` : owner.displayName || owner.firstName || owner.lastName || 'Unknown'),
          ownerInfo: {
            displayName: owner.displayName,
            firstName: owner.firstName,
            lastName: owner.lastName,
            id: owner.id?.toString(),
          }
        };
      }
    }

    // Fallback to member data using primaryOwner
    if (team.primaryOwner && memberMap.has(team.primaryOwner)) {
      const member = memberMap.get(team.primaryOwner);
      return {
        ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
        ownerInfo: {
          displayName: member.displayName,
          firstName: member.firstName,
          lastName: member.lastName,
          id: member.id?.toString(),
        }
      };
    }

    // Last resort - try to find member by matching team name
    const matchingMember = members.find((m: any) =>
      team.name && (team.name.includes(m.displayName) || team.name.includes(m.firstName) || team.name.includes(m.lastName))
    );
    if (matchingMember) {
      return {
        ownerName: (matchingMember.firstName && matchingMember.lastName ? `${matchingMember.firstName} ${matchingMember.lastName}` : matchingMember.displayName) || 'Unknown',
        ownerInfo: {
          displayName: matchingMember.displayName,
          firstName: matchingMember.firstName,
          lastName: matchingMember.lastName,
          id: matchingMember.id?.toString(),
        }
      };
    }

    return {
      ownerName: 'Unknown',
      ownerInfo: undefined
    };
  };

  // Store/update this season's data
  let draftPicks = 0;
  if (settings || draftDetail) {
    const { seasonSettings, parsed: parsedSettings } = buildSeasonSettings(
      settings,
      league.name,
      league.espnData?.size || teams.length || 10
    );
    const seasonData: any = {
      settings: seasonSettings,
    };

    // Always include draftInfo to prevent it from becoming empty
    // Set it to undefined if no draftDetail exists (will preserve existing value)
    seasonData.draftInfo = draftDetail ? {
      draftDate: draftDetail.completeDate || (draftDetail.drafted ? 1 : undefined),
      draftType: draftDetail.type,
      timePerPick: draftDetail.timePerPick,
      drafted: draftDetail.drafted,
      inProgress: draftDetail.inProgress,
    } : undefined;

    // Only include draftSettings if it exists
    if (settings?.draftSettings) {
      seasonData.draftSettings = settings.draftSettings;
    }

    // Only include draft picks if draft has actually occurred
    if (isDrafted(draftDetail) && draftDetail.picks) {
      seasonData.draft = draftDetail.picks;
      draftPicks = draftDetail.picks.length;
    }

    // seasonData deliberately never sets champion/runnerUp/regularSeasonChampion
    // - `updateLeagueSeason` skips a field entirely when it's `undefined`, so
    // this never clobbers a value the season-closed job already derived.

    await ctx.runMutation(internal.espnSync.updateLeagueSeason, {
      leagueId: league._id,
      seasonId,
      seasonData,
    });

    // Only the current season - refresh leagues.settings (spec:
    // mirrorSeasonSettings's doc comment in leagues.ts). Non-fatal.
    if (settings && opts.isCurrentSeason) {
      try {
        await ctx.runMutation(internal.leagues.mirrorSeasonSettings, {
          leagueId: league._id,
          seasonId,
          settings: parsedSettings,
        });
      } catch (error) {
        console.error(`Failed to mirror season settings for league ${league._id}:`, error);
      }
    }
  }

  // First, fetch current roster data for all teams to include in the team updates
  const teamRosters = new Map();

  // Try to get roster data from the current ESPN response first
  for (const team of teams) {
    if (team.roster?.entries) {
      // Process roster from current ESPN data
      const rosterData = team.roster.entries.map((entry: any) => ({
        playerId: entry.playerId?.toString() || '',
        playerName: entry.playerPoolEntry?.player?.fullName || 'Unknown',
        position: entry.playerPoolEntry?.player?.defaultPositionId ? getPositionName(entry.playerPoolEntry.player.defaultPositionId) : 'UNKNOWN',
        team: entry.playerPoolEntry?.player?.proTeamId ? getTeamAbbreviation(entry.playerPoolEntry.player.proTeamId) : 'FA',
        acquisitionType: entry.acquisitionType,
        lineupSlotId: entry.lineupSlotId,
        playerStats: entry.playerPoolEntry?.player?.stats ? {
          appliedTotal: entry.playerPoolEntry.player.stats.appliedTotal,
          projectedTotal: entry.playerPoolEntry.player.stats.projectedTotal,
        } : undefined,
      }));
      teamRosters.set(team.id.toString(), rosterData);
    }
  }

  console.log(`Captured roster data for ${teamRosters.size} out of ${teams.length} teams for league ${league.name}, season ${seasonId}`);

  // Update teams with current data including rosters
  await ctx.runMutation(internal.espnSync.updateTeams, {
    leagueId: league._id,
    seasonId,
    teamsData: teams.map((team: any) => {
      const { ownerName, ownerInfo } = getOwnerInfo(team);
      return {
        externalId: team.id.toString(),
        name: team.name || (team.location && team.nickname ? `${team.location} ${team.nickname}` : 'Unknown Team'),
        abbreviation: team.abbrev,
        location: team.location,
        nickname: team.nickname,
        logo: team.logo || team.logoURL || team.logoUrl || undefined,
        owner: ownerName,
        ownerInfo: ownerInfo,
        record: {
          wins: team.record?.overall?.wins || 0,
          losses: team.record?.overall?.losses || 0,
          ties: team.record?.overall?.ties || 0,
          pointsFor: team.record?.overall?.pointsFor || 0,
          pointsAgainst: team.record?.overall?.pointsAgainst || 0,
          playoffSeed: team.playoffSeed,
          // ESPN final-rank and form fields (refresh audit, Sept 2026).
          rankCalculatedFinal: team.rankCalculatedFinal,
          rankFinal: team.rankFinal,
          currentProjectedRank: team.currentProjectedRank,
          draftDayProjectedRank: team.draftDayProjectedRank,
          streakLength: team.record?.overall?.streakLength,
          streakType: team.record?.overall?.streakType,
          gamesBack: team.record?.overall?.gamesBack,
          percentage: team.record?.overall?.percentage,
          divisionRecord: team.record?.division ? {
            wins: team.record.division.wins || 0,
            losses: team.record.division.losses || 0,
            ties: team.record.division.ties || 0,
          } : undefined,
        },
        roster: teamRosters.get(team.id.toString()) || [], // Use fetched roster data or empty array
        divisionId: team.divisionId,
        transactionCounter: team.transactionCounter,
        waiverRank: team.waiverRank,
      };
    })
  });

  // Sync players data if available
  let transactionsSynced = 0;
  if (players.length > 0) {
    await ctx.runMutation(internal.espnSync.updatePlayers, {
      playersData: players.map((player: any) => ({
        externalId: player.id?.toString() || '',
        fullName: player.fullName || 'Unknown Player',
        firstName: player.firstName,
        lastName: player.lastName,
        defaultPosition: getPositionName(player.defaultPositionId),
        eligiblePositions: player.eligibleSlots?.map((slot: number) => getPositionName(slot)) || [],
        proTeamId: player.proTeamId,
        proTeamAbbrev: getTeamAbbreviation(player.proTeamId),
        injuryStatus: player.injuryStatus,
        stats: player.stats ? {
          seasonStats: {
            appliedTotal: player.stats.appliedTotal,
            projectedTotal: player.stats.projectedTotal,
            averagePoints: player.stats.averagePoints,
          }
        } : undefined,
        ownership: player.ownership ? {
          percentOwned: player.ownership.percentOwned,
          percentChange: player.ownership.percentChange,
          percentStarted: player.ownership.percentStarted,
        } : undefined,
      }))
    });

    // Sync player transactions (player_feed source)
    try {
      const transactionResult = await ctx.runAction(internal.espnSync.syncPlayerTransactions, {
        leagueId: league._id,
        seasonId,
        players: players,
        currentScoringPeriod: settings?.scoringSettings?.currentScoringPeriod || 1,
      });

      if (transactionResult.success) {
        transactionsSynced = transactionResult.transactionsProcessed;
      }
    } catch (transactionError) {
      console.error(`Error syncing player transactions for league ${league.name}:`, transactionError);
    }
  }

  // Sync matchups data
  const periodsInPayload: number[] = Array.from(
    new Set<number>(schedule.map((matchup: any) => matchup.matchupPeriodId as number))
  ).sort((a, b) => a - b);
  if (schedule.length > 0) {
    await ctx.runMutation(internal.espnSync.updateMatchups, {
      leagueId: league._id,
      seasonId,
      matchupsData: schedule.map((matchup: any) => ({
        matchupPeriod: matchup.matchupPeriodId,
        scoringPeriod: matchup.id,
        homeTeamId: matchup.home?.teamId?.toString() || '',
        awayTeamId: matchup.away?.teamId?.toString() || '',
        homeScore: matchup.home?.totalPoints || 0,
        awayScore: matchup.away?.totalPoints || 0,
        homeProjectedScore: matchup.home?.totalProjectedPoints,
        awayProjectedScore: matchup.away?.totalProjectedPoints,
        homePointsByScoringPeriod: matchup.home?.pointsByScoringPeriod,
        awayPointsByScoringPeriod: matchup.away?.pointsByScoringPeriod,
        winner: matchup.winner === 'HOME' ? 'home' as const :
               matchup.winner === 'AWAY' ? 'away' as const :
               matchup.winner === 'TIE' ? 'tie' as const : undefined,
        playoffTier: matchup.playoffTierType,
        // Transform and clean roster data from current scoring period
        homeRoster: transformRosterData(matchup.home?.rosterForCurrentScoringPeriod),
        awayRoster: transformRosterData(matchup.away?.rosterForCurrentScoringPeriod),
      }))
    });
  }

  // Determine current scoring period from multiple possible sources
  const currentScoringPeriod = leagueData.scoringPeriodId ||
                              leagueData.status?.currentMatchupPeriod ||
                              leagueData.status?.latestScoringPeriod ||
                              settings?.scoringSettings?.currentScoringPeriod ||
                              league.espnData.currentScoringPeriod;

  // Only the current season stamps `espnData.seasonId`/`currentScoringPeriod`
  // - see this function's doc comment.
  if (opts.isCurrentSeason) {
    await ctx.runMutation(internal.espnSync.updateLeagueSync, {
      leagueId: league._id,
      currentScoringPeriod: currentScoringPeriod,
      seasonId,
    });
  }

  // This IS a full pull for `seasonId` (settings, teams, matchups, draft,
  // player-feed transactions) regardless of whether it's the current season.
  await ctx.runMutation(internal.espnSync.stampLeagueSeasonFullSync, {
    leagueId: league._id,
    seasonId,
  });

  return {
    success: true,
    teamsCount: teams.length,
    matchupsCount: schedule.length,
    playersCount: players.length,
    transactionsCount: transactionsSynced,
    periodsInPayload,
    draftPicks,
    currentScoringPeriod: typeof currentScoringPeriod === "number" ? currentScoringPeriod : undefined,
    teamsWithRosterInPayload: teamRosters.size,
  };
}

/**
 * The per-league, per-season sync body used by both the 4-hourly
 * `syncAllLeaguesCurrentSeason` cron (looping over every league, and every
 * season `seasonsToSync` says still needs refreshing) and
 * `syncOneLeagueCurrentSeason` (a single targeted re-sync of the current
 * season, e.g. the post-draft follow-up jobs scheduled from
 * `updateLeagueSeason`). Runs `syncSeasonCore` then layers on the
 * cron-only extras: claim rollover, derived-metrics scheduling, the
 * transaction log, and roster/matchup-roster refresh - none of which
 * `syncSeasonSnapshot` (the season-closed job's single targeted pull) does.
 */
async function syncOneLeagueCurrentSeasonBody(
  ctx: ActionCtx,
  league: Doc<"leagues">,
  seasonId: number,
  isCurrentSeason: boolean,
): Promise<{
  leagueId: string;
  leagueName: string;
  success: boolean;
  error?: string;
  teamsCount?: number;
  matchupsCount?: number;
  playersCount?: number;
  rostersCount?: number;
  matchupRostersCount?: number;
  transactionsCount?: number;
}> {
  try {
    console.log(
      `Syncing season ${seasonId} for league: ${league.name} (${league._id})${isCurrentSeason ? "" : " (previous season, not yet finalized)"}`
    );

    const core = await syncSeasonCore(ctx, league, seasonId, { isCurrentSeason });
    if (!core.success) {
      return { leagueId: league._id, leagueName: league.name, success: false, error: core.error };
    }

    // Carry manager <-> team claims forward from the prior season now that
    // this season's teams exist. Never let a rollover problem fail the sync
    // itself.
    try {
      await ctx.runMutation(internal.claimRollover.rollForwardClaims, {
        leagueId: league._id,
        seasonId,
      });
    } catch (rolloverError) {
      console.error(`Error rolling forward team claims for league ${league._id}:`, rolloverError);
    }

    // Refresh derived metrics (team metrics, rivalries, manager
    // activity) that the article pipeline reads. Scheduled rather than
    // awaited so it never extends this action's runtime or fails the
    // sync itself.
    try {
      await ctx.scheduler.runAfter(0, internal.dataProcessing.processLeagueDataAfterSync, {
        leagueId: league._id,
        seasonId,
      });
    } catch (dataProcessingError) {
      console.error(`Error scheduling post-sync data processing for league ${league._id}:`, dataProcessingError);
    }

    // FAAB waiver-wire report data: fetch ESPN's transaction log
    // (view=mTransactions2) for the current and previous scoring period -
    // waivers process overnight Tue/Wed, so the previous period's claims
    // settle after the period rolls over. On the first sync of a season (no
    // transaction_log rows stored for it yet), backfill every period from
    // 1..current instead. Never fatal - this is report data, not core sync.
    if (typeof core.currentScoringPeriod === "number" && core.currentScoringPeriod > 0) {
      try {
        const hasLog: boolean = await ctx.runQuery(internal.espnSync.hasTransactionLogForSeason, {
          leagueId: league._id,
          seasonId,
        });

        const periodsToSync: number[] = hasLog
          ? [core.currentScoringPeriod, ...(core.currentScoringPeriod > 1 ? [core.currentScoringPeriod - 1] : [])]
          : Array.from({ length: core.currentScoringPeriod }, (_, i) => i + 1);

        const transactionLogResult = await ctx.runAction(internal.espnSync.syncTransactionLog, {
          leagueId: league._id,
          seasonId,
          scoringPeriods: periodsToSync,
        });
        console.log(`Transaction log sync for league ${league.name}:`, transactionLogResult.message);
      } catch (transactionLogError) {
        console.error(`Error syncing transaction log for league ${league.name}:`, transactionLogError);
      }
    }

    // Fetch rosters for this season as fallback if not already captured
    let rostersFetched = core.teamsWithRosterInPayload;

    // If we didn't get roster data from the main API call, fetch it separately
    if (core.teamsWithRosterInPayload === 0) {
      try {
        const rosterResult = await ctx.runAction(internal.espnSync.fetchHistoricalRostersInternal, {
          leagueId: league._id,
          seasonId,
        });

        if (rosterResult.success) {
          rostersFetched = rosterResult.totalRostersFetched;
        }
      } catch (rosterError) {
        console.error(`Error fetching rosters for league ${league.name}:`, rosterError);
      }
    }

    // Matchup rosters: only the most recent period (plus the one before it,
    // for stat corrections) needs its lineup re-pulled on this 4-hourly
    // liveness run - the week-closed job re-pulls a just-finished period
    // once, properly, and the season-closed job passes every period
    // explicitly (audit recommendation (i): ~2 roster requests/run instead
    // of ~12-17).
    let matchupRostersFetched = 0;
    if (typeof core.currentScoringPeriod === "number" && core.currentScoringPeriod > 0) {
      try {
        const matchupPeriods = [
          core.currentScoringPeriod,
          ...(core.currentScoringPeriod > 1 ? [core.currentScoringPeriod - 1] : []),
        ];
        const matchupRosterResult = await ctx.runAction(internal.matchupRosters.fetchMatchupRosters, {
          leagueId: league._id,
          seasonId,
          matchupPeriods,
        });

        if (matchupRosterResult.success) {
          matchupRostersFetched = matchupRosterResult.successfulPeriods;
        }
      } catch (matchupRosterError) {
        console.error(`Error fetching matchup rosters for league ${league.name}:`, matchupRosterError);
      }
    }

    console.log(
      `Successfully synced season ${seasonId} for league ${league.name}: ${core.teamsCount} teams, ${core.matchupsCount} matchups, ${rostersFetched} rosters, ${matchupRostersFetched} matchup periods, ${core.transactionsCount} transactions`
    );

    // Add small delay to prevent rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));

    return {
      leagueId: league._id,
      leagueName: league.name,
      success: true,
      teamsCount: core.teamsCount,
      matchupsCount: core.matchupsCount,
      playersCount: core.playersCount,
      rostersCount: rostersFetched,
      matchupRostersCount: matchupRostersFetched,
      transactionsCount: core.transactionsCount,
    };
  } catch (error) {
    console.error(`Failed to sync season ${seasonId} for league ${league.name}:`, error);
    return {
      leagueId: league._id,
      leagueName: league.name,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export const syncAllLeaguesCurrentSeason = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    success: boolean;
    totalLeagues: number;
    totalSynced: number;
    totalErrors: number;
    results: Array<{
      leagueId: string;
      leagueName: string;
      success: boolean;
      error?: string;
      teamsCount?: number;
      matchupsCount?: number;
      playersCount?: number;
      rostersCount?: number;
      matchupRostersCount?: number;
      transactionsCount?: number;
    }>;
    message: string;
    syncedAt: number;
  }> => {
    console.log("Starting current season sync for all leagues");

    // Get all leagues
    const allLeagues = await ctx.runQuery(internal.leagues.listLeagues, {});

    if (allLeagues.length === 0) {
      return {
        success: true,
        totalLeagues: 0,
        totalSynced: 0,
        totalErrors: 0,
        results: [],
        message: "No leagues found to sync",
        syncedAt: Date.now(),
      };
    }

    console.log(`Found ${allLeagues.length} leagues to sync current season data`);

    const results = [];
    let totalSynced = 0;
    let totalErrors = 0;
    const now = Date.now();

    for (const league of allLeagues) {
      // One notion of "current season" (seasonToSync.ts) - Aug->Jul, unless
      // this league's own last-synced season is already ahead of that.
      // `alsoSync` keeps refreshing last season while it's synced-but-not-
      // yet-finalized (agent I's season-closed job hasn't stamped
      // `finalizedAt` yet), so a season doesn't go stale just because the
      // calendar rolled over.
      const seasons = await ctx.runQuery(internal.espnSync.getLeagueSeasonsForSyncInternal, {
        leagueId: league._id,
      });
      const { current, alsoSync } = seasonsToSync({ league, seasons, now });

      const currentResult = await syncOneLeagueCurrentSeasonBody(ctx, league, current, true);
      let leagueResult = currentResult;

      for (const seasonId of alsoSync) {
        const alsoResult = await syncOneLeagueCurrentSeasonBody(ctx, league, seasonId, false);
        // A successful previous-season pull must not leave `lastSyncedAt`
        // looking frozen just because `current` 404'd (ESPN hasn't opened
        // it yet) - seasonToSync.ts's rollover contract.
        if (alsoResult.success && !currentResult.success) {
          await ctx.runMutation(internal.espnSync.touchLeagueLastSynced, { leagueId: league._id });
        }
        if (!leagueResult.success && alsoResult.success) {
          leagueResult = alsoResult;
        }
      }

      results.push(leagueResult);
      if (leagueResult.success) {
        totalSynced++;
      } else {
        totalErrors++;
      }
    }

    return {
      success: totalSynced > 0,
      totalLeagues: allLeagues.length,
      totalSynced,
      totalErrors,
      results,
      message: `Current season sync completed: ${totalSynced}/${allLeagues.length} leagues synced successfully`,
      syncedAt: Date.now(),
    };
  },
});

/**
 * A single targeted re-sync of one league's current season, running the exact
 * same body as one iteration of `syncAllLeaguesCurrentSeason`'s loop. Used for
 * the post-draft follow-up jobs `updateLeagueSeason` schedules at
 * scheduledAt + 3h/8h/24h around a league's ESPN-reported draft time, so a
 * live draft is noticed within hours instead of waiting for the next 4-hourly
 * cron slot. Internal only - never exposed to clients.
 */
export const syncOneLeagueCurrentSeason = internalAction({
  args: {
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args): Promise<{
    leagueId: string;
    leagueName: string;
    success: boolean;
    error?: string;
    teamsCount?: number;
    matchupsCount?: number;
    playersCount?: number;
    rostersCount?: number;
    matchupRostersCount?: number;
    transactionsCount?: number;
  }> => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league) {
      console.warn(`syncOneLeagueCurrentSeason: league ${args.leagueId} not found`);
      return {
        leagueId: args.leagueId,
        leagueName: "Unknown",
        success: false,
        error: "League not found",
      };
    }

    const current = currentSeasonForLeague(league);
    return await syncOneLeagueCurrentSeasonBody(ctx, league, current, true);
  },
});

/**
 * One targeted MAIN17 pull for a single named season - the contract used by
 * the season-closed job (`convex/seasonSync.ts`) once
 * `deriveSeasonResults` (`convex/lib/playoffs.ts`) says the bracket is
 * decided. Runs `syncSeasonCore` only - none of the liveness cron's extras
 * (claim rollover, transaction log, roster/matchup-roster refresh); the
 * season-closed job runs those itself where it needs "every period", not
 * just the last two.
 */
export const syncSeasonSnapshot = internalAction({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    message: string;
    periodsInPayload: number[];
    draftPicks: number;
  }> => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league) {
      return { success: false, message: "League not found", periodsInPayload: [], draftPicks: 0 };
    }

    const current = currentSeasonForLeague(league);
    const core = await syncSeasonCore(ctx, league, args.seasonId, {
      isCurrentSeason: args.seasonId === current,
    });

    return {
      success: core.success,
      message: core.success
        ? `Synced season ${args.seasonId}: ${core.teamsCount} teams, ${core.matchupsCount} matchups, ${core.draftPicks} draft picks`
        : (core.error ?? "Sync failed"),
      periodsInPayload: core.periodsInPayload,
      draftPicks: core.draftPicks,
    };
  },
});

/**
 * A plain-English message for one ESPN connection probe outcome, shared by
 * `testEspnConnection`'s return value. Kept separate from the action so it's
 * trivially unit-testable without a Convex context.
 */
function describeEspnConnectionResult(
  classification: EspnStatusClassification,
  status: number,
  leagueName?: string,
  teamCount?: number
): string {
  switch (classification) {
    case "ok":
      return `Connected: ${leagueName ?? "league"}${teamCount != null ? ` (${teamCount} teams)` : ""}`;
    case "auth":
      return `ESPN rejected the cookies (${status}). Paste fresh espn_s2 and SWID.`;
    case "not_found":
      return `League not found for this season (${status}). Check the league ID and that it's the right season.`;
    case "rate_limited":
      return `ESPN is rate-limiting these requests (${status}). Try again in a minute.`;
    case "server":
      return `ESPN's API is having trouble (${status}). Try again shortly.`;
    default:
      return `ESPN returned an unexpected response (${status}).`;
  }
}

/**
 * Probe ESPN with either the caller-supplied credentials (a trial pair from
 * the setup/settings form, not yet saved) or the league's stored ones, and
 * report back in plain English. Commissioner-gated, like every other ESPN
 * write/probe path for a league.
 *
 * Only persists `credentialStatus` when testing the STORED pair - testing an
 * unsaved trial pair must not overwrite the status of whatever is currently
 * saved (which might still be working).
 */
export const testEspnConnection = action({
  args: {
    leagueId: v.id("leagues"),
    espnS2: v.optional(v.string()),
    swid: v.optional(v.string()),
  },
  returns: v.object({
    ok: v.boolean(),
    classification: v.string(),
    message: v.string(),
    leagueName: v.optional(v.string()),
    teamCount: v.optional(v.number()),
    seasonId: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    ok: boolean;
    classification: string;
    message: string;
    leagueName?: string;
    teamCount?: number;
    seasonId: number;
  }> => {
    await requireLeagueMemberFromAction(ctx, args.leagueId, { commissioner: true });

    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league) {
      throw new Error("League not found");
    }

    const usingSuppliedCredentials = args.espnS2 !== undefined || args.swid !== undefined;
    const creds = normalizeEspnCredentials(
      usingSuppliedCredentials
        ? { espnS2: args.espnS2, swid: args.swid }
        : { espnS2: league.espnData?.espnS2, swid: league.espnData?.swid }
    );

    // Probe the same season every other sync path treats as "current"
    // (`currentSeasonForLeague`/`seasonsToSync`) - previously fell back to
    // the raw calendar year and, worse, ALWAYS preferred a stored
    // `espnData.seasonId` even when stuck behind (a sync failure streak
    // could leave this probing a season ESPN itself moved past forever).
    const seasonId = currentSeasonForLeague(league);
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${league.externalId}?view=mSettings`;

    const { response, classification } = await fetchEspn(url, { creds });

    let leagueName: string | undefined;
    let teamCount: number | undefined;
    if (classification === "ok") {
      try {
        const data = await response.json();
        leagueName = typeof data?.settings?.name === "string" ? data.settings.name : undefined;
        teamCount = Array.isArray(data?.teams) ? data.teams.length : undefined;
      } catch {
        // A 200 with a body we couldn't parse as JSON is still "connected" -
        // just without the extra detail for the message.
      }
    }

    const message = describeEspnConnectionResult(classification, response.status, leagueName, teamCount);

    if (!usingSuppliedCredentials) {
      await ctx.runMutation(internal.leagues.setEspnCredentialStatus, {
        leagueId: args.leagueId,
        status: classification === "ok" ? "valid" : "invalid",
        error: classification === "ok" ? undefined : message,
      });
    }

    return {
      ok: classification === "ok",
      classification,
      message,
      leagueName,
      teamCount,
      seasonId,
    };
  },
});