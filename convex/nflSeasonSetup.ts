import { v } from "convex/values";
import { internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { nflSeasonYearFor } from "./lib/season";
import type { MutationCtx } from "./_generated/server";

/**
 * Shape of the data we store for a single NFL season (everything in the
 * `nflSeasons` table except `year`, `createdAt` and `updatedAt`, which are
 * assigned when the row is inserted).
 */
interface SeasonSetupData {
  phases: {
    preseason: { start: number; end: number };
    regularSeason: { start: number; end: number };
    playoffs: { start: number; end: number };
    superBowl: { start: number; end: number };
    offseason: { start: number; end: number };
  };
  weekBoundaries: Array<{ week: number; start: number; end: number; isPlayoffs: boolean }>;
  draftEligibilityWindow: { start: number; end: number };
  playoffStructure: {
    wildCardWeek: number;
    divisionalWeek: number;
    championshipWeek: number;
    superBowlWeek: number;
  };
}

// Helper function to generate 2025 week boundaries
function generate2025WeekBoundaries() {
  const boundaries = [];

  // Regular season starts September 4, 2025 (Thursday)
  let weekStart = new Date(2025, 8, 2).getTime(); // Tuesday September 2, 2025 (week boundaries start Tuesday)

  // Regular season weeks 1-18
  for (let week = 1; week <= 18; week++) {
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000) - 1; // 7 days minus 1ms
    boundaries.push({
      week,
      start: weekStart,
      end: weekEnd,
      isPlayoffs: false,
    });
    weekStart = weekEnd + 1;
  }

  // Playoff weeks 19-22
  for (let week = 19; week <= 22; week++) {
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000) - 1;
    boundaries.push({
      week,
      start: weekStart,
      end: weekEnd,
      isPlayoffs: true,
    });
    weekStart = weekEnd + 1;
  }

  return boundaries;
}

// Helper function to generate 2024 week boundaries
function generate2024WeekBoundaries() {
  const boundaries = [];

  // Regular season started September 5, 2024 (Thursday)
  let weekStart = new Date(2024, 8, 3).getTime(); // Tuesday September 3, 2024

  // Regular season weeks 1-18
  for (let week = 1; week <= 18; week++) {
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000) - 1;
    boundaries.push({
      week,
      start: weekStart,
      end: weekEnd,
      isPlayoffs: false,
    });
    weekStart = weekEnd + 1;
  }

  // Playoff weeks 19-22
  for (let week = 19; week <= 22; week++) {
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000) - 1;
    boundaries.push({
      week,
      start: weekStart,
      end: weekEnd,
      isPlayoffs: true,
    });
    weekStart = weekEnd + 1;
  }

  return boundaries;
}

// Helper function to generate 2026 week boundaries.
// Anchor confirmed against ESPN's real 2026 schedule
// (seasons/2026?view=proTeamSchedules_wl): Week 1's earliest kickoff is
// 2026-09-10T00:20Z (Thursday), so the Tuesday-before anchor is 2026-09-08.
function generate2026WeekBoundaries() {
  const boundaries = [];

  // Regular season starts September 10, 2026 (Thursday)
  let weekStart = new Date(2026, 8, 8).getTime(); // Tuesday September 8, 2026

  // Regular season weeks 1-18
  for (let week = 1; week <= 18; week++) {
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000) - 1;
    boundaries.push({
      week,
      start: weekStart,
      end: weekEnd,
      isPlayoffs: false,
    });
    weekStart = weekEnd + 1;
  }

  // Playoff weeks 19-22
  for (let week = 19; week <= 22; week++) {
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000) - 1;
    boundaries.push({
      week,
      start: weekStart,
      end: weekEnd,
      isPlayoffs: true,
    });
    weekStart = weekEnd + 1;
  }

  return boundaries;
}

const PLAYOFF_STRUCTURE = {
  wildCardWeek: 19,
  divisionalWeek: 20,
  championshipWeek: 21,
  superBowlWeek: 22,
};

/**
 * Known NFL season boundaries, keyed by season year. Each entry has the same
 * shape that used to be hand-built inline inside `setup2025Season` /
 * `setup2024Season` - those mutations now just delegate to this table so
 * their behavior is unchanged.
 */
const KNOWN_SEASONS: Record<number, SeasonSetupData> = {
  2024: {
    phases: {
      preseason: {
        start: new Date(2024, 6, 25).getTime(), // July 25, 2024
        end: new Date(2024, 8, 4).getTime(),    // September 4, 2024
      },
      regularSeason: {
        start: new Date(2024, 8, 5).getTime(),  // September 5, 2024
        end: new Date(2025, 0, 6).getTime(),    // January 6, 2025
      },
      playoffs: {
        start: new Date(2025, 0, 11).getTime(), // January 11, 2025
        end: new Date(2025, 1, 8).getTime(),    // February 8, 2025
      },
      superBowl: {
        start: new Date(2025, 1, 9).getTime(),  // February 9, 2025
        end: new Date(2025, 1, 10).getTime(),   // February 10, 2025
      },
      offseason: {
        start: new Date(2025, 1, 10).getTime(), // February 10, 2025
        end: new Date(2025, 6, 24).getTime(),   // July 24, 2025
      },
    },
    weekBoundaries: generate2024WeekBoundaries(),
    draftEligibilityWindow: {
      start: new Date(2024, 6, 25).getTime(),  // July 25, 2024
      end: new Date(2024, 8, 4).getTime(),     // September 4, 2024
    },
    playoffStructure: PLAYOFF_STRUCTURE,
  },
  2025: {
    phases: {
      preseason: {
        start: new Date(2025, 6, 24).getTime(), // July 24, 2025
        end: new Date(2025, 8, 3).getTime(),    // September 3, 2025
      },
      regularSeason: {
        start: new Date(2025, 8, 4).getTime(),  // September 4, 2025 (Week 1 Thursday)
        end: new Date(2026, 0, 5).getTime(),    // January 5, 2026 (after Week 18)
      },
      playoffs: {
        start: new Date(2026, 0, 11).getTime(), // January 11, 2026 (Wild Card)
        end: new Date(2026, 1, 8).getTime(),    // February 8, 2026 (day before Super Bowl)
      },
      superBowl: {
        start: new Date(2026, 1, 9).getTime(),  // February 9, 2026 (Super Bowl Sunday)
        end: new Date(2026, 1, 10).getTime(),   // February 10, 2026
      },
      offseason: {
        start: new Date(2026, 1, 10).getTime(), // February 10, 2026
        end: new Date(2026, 6, 23).getTime(),   // July 23, 2026
      },
    },
    weekBoundaries: generate2025WeekBoundaries(),
    draftEligibilityWindow: {
      start: new Date(2025, 6, 24).getTime(),  // July 24, 2025 (preseason start)
      end: new Date(2025, 8, 3).getTime(),     // September 3, 2025 (day before season)
    },
    playoffStructure: PLAYOFF_STRUCTURE,
  },
  2026: {
    phases: {
      preseason: {
        start: new Date(2026, 6, 30).getTime(), // July 30, 2026
        end: new Date(2026, 8, 9).getTime(),    // September 9, 2026
      },
      regularSeason: {
        start: new Date(2026, 8, 10).getTime(), // September 10, 2026 (Week 1 Thursday)
        end: new Date(2027, 0, 11).getTime(),   // January 11, 2027 (after Week 18)
      },
      playoffs: {
        start: new Date(2027, 0, 16).getTime(), // January 16, 2027 (Wild Card)
        end: new Date(2027, 1, 13).getTime(),   // February 13, 2027 (day before Super Bowl)
      },
      superBowl: {
        start: new Date(2027, 1, 14).getTime(), // February 14, 2027 (Super Bowl LXI Sunday)
        end: new Date(2027, 1, 15).getTime(),   // February 15, 2027
      },
      offseason: {
        start: new Date(2027, 1, 15).getTime(), // February 15, 2027
        end: new Date(2027, 6, 23).getTime(),   // July 23, 2027
      },
    },
    weekBoundaries: generate2026WeekBoundaries(),
    draftEligibilityWindow: {
      start: new Date(2026, 6, 30).getTime(),  // July 30, 2026 (preseason start)
      end: new Date(2026, 8, 9).getTime(),     // September 9, 2026 (day before season)
    },
    playoffStructure: PLAYOFF_STRUCTURE,
  },
};

// Shared idempotent insert used by setup2024Season/setup2025Season,
// ensureSeason, and insertDerivedSeasonData.
async function insertSeasonIfMissing(
  ctx: MutationCtx,
  year: number,
  data: SeasonSetupData
): Promise<{ success: boolean; seasonId?: Id<"nflSeasons">; year: number; message: string }> {
  const existingSeason = await ctx.db
    .query("nflSeasons")
    .withIndex("by_year", (q) => q.eq("year", year))
    .first();

  if (existingSeason) {
    return { success: false, year, message: `${year} season already exists` };
  }

  const seasonId = await ctx.db.insert("nflSeasons", {
    year,
    phases: data.phases,
    weekBoundaries: data.weekBoundaries,
    draftEligibilityWindow: data.draftEligibilityWindow,
    playoffStructure: data.playoffStructure,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return {
    success: true,
    seasonId,
    year,
    message: `${year} NFL season boundaries initialized successfully`,
  };
}

/**
 * Setup NFL season data for 2025
 * This function initializes the 2025 NFL season with accurate dates
 */
export const setup2025Season = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; seasonId?: Id<"nflSeasons">; year?: number; message: string }> => {
    return await insertSeasonIfMissing(ctx, 2025, KNOWN_SEASONS[2025]);
  },
});

/**
 * Setup NFL season data for 2024 (for testing with historical data)
 */
export const setup2024Season = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; seasonId?: Id<"nflSeasons">; year?: number; message: string }> => {
    return await insertSeasonIfMissing(ctx, 2024, KNOWN_SEASONS[2024]);
  },
});

/**
 * Setup NFL season data for 2026.
 * Week boundaries are confirmed against ESPN's real 2026 schedule; playoff
 * and Super Bowl dates are the actual published 2026-27 postseason dates.
 */
export const setup2026Season = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; seasonId?: Id<"nflSeasons">; year?: number; message: string }> => {
    return await insertSeasonIfMissing(ctx, 2026, KNOWN_SEASONS[2026]);
  },
});

/**
 * Idempotently ensure a single known season's row exists. No-op (does not
 * throw) if the year isn't in KNOWN_SEASONS or the row already exists -
 * callers that need ESPN-derived data for an unknown year should schedule
 * `deriveSeasonFromEspn` instead (see `ensureCurrentSeason`).
 */
export const ensureSeason = internalMutation({
  args: { year: v.number() },
  handler: async (ctx, { year }): Promise<{ success: boolean; seasonId?: Id<"nflSeasons">; year: number; message: string }> => {
    const data = KNOWN_SEASONS[year];
    if (!data) {
      return { success: false, year, message: `No known season data for ${year}` };
    }
    return await insertSeasonIfMissing(ctx, year, data);
  },
});

/**
 * Ensure the `nflSeasons` row for the current NFL season exists (and, once
 * we're into the summer, the upcoming season too) so that season-phase
 * lookups never silently fall back to OFFSEASON for a season that just
 * hasn't been seeded yet. Safe to call repeatedly - every branch is
 * idempotent.
 */
export const ensureCurrentSeason = internalMutation({
  args: {},
  handler: async (ctx): Promise<{
    ensured: Array<{ year: number; success: boolean; message: string }>;
    derivationScheduled: number[];
  }> => {
    const now = new Date();
    const currentYear = nflSeasonYearFor(now);
    const yearsToCheck = [currentYear];
    // Between May and July we are in the offseason of `currentYear` and the upcoming
    // season is `currentYear + 1`; ESPN publishes that schedule in May, so this is the
    // only window where deriving it can succeed. Outside it, attempting next year just
    // produces a daily 404 (e.g. 2027 in September 2026).
    const month = now.getMonth();
    if (month >= 4 && month <= 6) {
      yearsToCheck.push(currentYear + 1);
    }

    const ensured: Array<{ year: number; success: boolean; message: string }> = [];
    const derivationScheduled: number[] = [];

    for (const year of yearsToCheck) {
      if (KNOWN_SEASONS[year]) {
        const result = await ctx.runMutation(internal.nflSeasonSetup.ensureSeason, { year });
        ensured.push({ year, success: result.success, message: result.message });
        continue;
      }

      // Unknown year - only kick off a derivation if we don't already have a row.
      const existing = await ctx.db
        .query("nflSeasons")
        .withIndex("by_year", (q) => q.eq("year", year))
        .first();

      if (!existing) {
        await ctx.scheduler.runAfter(0, internal.nflSeasonSetup.deriveSeasonFromEspn, { year });
        derivationScheduled.push(year);
      }
    }

    return { ensured, derivationScheduled };
  },
});

const timeRangeValidator = v.object({ start: v.number(), end: v.number() });

/**
 * Idempotent insert for season data computed by `deriveSeasonFromEspn`
 * (an action, so it can't touch ctx.db directly).
 */
export const insertDerivedSeasonData = internalMutation({
  args: {
    year: v.number(),
    phases: v.object({
      preseason: timeRangeValidator,
      regularSeason: timeRangeValidator,
      playoffs: timeRangeValidator,
      superBowl: timeRangeValidator,
      offseason: timeRangeValidator,
    }),
    weekBoundaries: v.array(v.object({
      week: v.number(),
      start: v.number(),
      end: v.number(),
      isPlayoffs: v.boolean(),
    })),
    draftEligibilityWindow: timeRangeValidator,
    playoffStructure: v.object({
      wildCardWeek: v.number(),
      divisionalWeek: v.number(),
      championshipWeek: v.number(),
      superBowlWeek: v.number(),
    }),
  },
  handler: async (ctx, { year, ...data }) => {
    return await insertSeasonIfMissing(ctx, year, data);
  },
});

/**
 * Derive NFL season boundaries for a year we don't have hand-authored data
 * for, from ESPN's public pro schedule endpoint. Used as a fallback so the
 * app doesn't fall back to OFFSEASON forever for a season nobody has
 * manually added to KNOWN_SEASONS yet.
 *
 * Week boundaries: for each ESPN "scoring period" (regular season week), we
 * take the earliest kickoff across all 32 teams and anchor the fantasy week
 * at the Tuesday before it, running through the following Monday - matching
 * the convention used by the hand-authored seasons above. Playoff/Super
 * Bowl/offseason dates aren't published this far out, so those are
 * estimated relative to the derived regular season end.
 */
export const deriveSeasonFromEspn = internalAction({
  args: { year: v.number() },
  handler: async (ctx, { year }): Promise<{ success: boolean; year: number; message: string }> => {
    const DAY = 24 * 60 * 60 * 1000;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      let data: any;
      try {
        const response = await fetch(
          `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}?view=proTeamSchedules_wl`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
              'Accept': 'application/json',
            },
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error(`ESPN API returned ${response.status}: ${response.statusText}`);
        }

        data = await response.json();
      } finally {
        clearTimeout(timeoutId);
      }

      const proTeams: any[] = data?.settings?.proTeams || [];
      if (proTeams.length === 0) {
        return { success: false, year, message: `No proTeams schedule data returned by ESPN for ${year}` };
      }

      // Aggregate every game's kickoff timestamp by scoring period, across all teams.
      const gamesByPeriod = new Map<number, number[]>();
      for (const team of proTeams) {
        const byPeriod = team.proGamesByScoringPeriod || {};
        for (const [periodKey, games] of Object.entries(byPeriod)) {
          const period = parseInt(periodKey, 10);
          if (!Number.isFinite(period) || !Array.isArray(games)) continue;
          const list = gamesByPeriod.get(period) ?? [];
          for (const game of games as any[]) {
            if (typeof game?.date === "number") list.push(game.date);
          }
          gamesByPeriod.set(period, list);
        }
      }

      const periods = Array.from(gamesByPeriod.keys()).sort((a, b) => a - b);
      if (periods.length === 0) {
        return { success: false, year, message: `No scoring period game dates found for ${year}` };
      }

      const tuesdayBeforeUTC = (ms: number): number => {
        const d = new Date(ms);
        const dow = d.getUTCDay(); // Sun=0 .. Sat=6, Tue=2
        const diff = (dow - 2 + 7) % 7;
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff, 0, 0, 0, 0);
      };

      const weekBoundaries: Array<{ week: number; start: number; end: number; isPlayoffs: boolean }> = periods.map((period, idx) => {
        const gameDates = gamesByPeriod.get(period) || [];
        const firstGame = Math.min(...gameDates);
        const start = tuesdayBeforeUTC(firstGame);
        const end = start + 7 * DAY - 1;
        return { week: idx + 1, start, end, isPlayoffs: false };
      });

      const regularSeasonStart = weekBoundaries[0].start;
      const regularSeasonEnd = weekBoundaries[weekBoundaries.length - 1].end;

      // Continue the same weekly cadence for the 4 playoff weeks, matching
      // the shape of the hand-authored seasons (even though the estimated
      // phase dates below don't line up 1:1 with these windows - see the
      // 2024/2025 data, which has the same characteristic).
      let cascadeStart = regularSeasonEnd + 1;
      for (let i = 0; i < 4; i++) {
        const week = weekBoundaries.length + 1;
        const weekEnd = cascadeStart + 7 * DAY - 1;
        weekBoundaries.push({ week, start: cascadeStart, end: weekEnd, isPlayoffs: true });
        cascadeStart = weekEnd + 1;
      }

      // Estimate playoff / Super Bowl / offseason windows - exact dates
      // aren't published this far out.
      const playoffsStart = regularSeasonEnd + DAY;
      const playoffsEnd = regularSeasonEnd + 4 * 7 * DAY;

      // Super Bowl: ~5 weeks after regular season end, snapped forward to Sunday.
      let superBowlStart = regularSeasonEnd + 5 * 7 * DAY;
      {
        const d = new Date(superBowlStart);
        const diffToSunday = (7 - d.getUTCDay()) % 7;
        superBowlStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToSunday, 0, 0, 0, 0);
      }
      const superBowlEnd = superBowlStart + DAY - 1;

      const offseasonStart = superBowlEnd + 1;
      // Rough estimate of next year's preseason start (~364 days later, 42
      // days of preseason before kickoff), so offseason has a sane end.
      const nextRegularSeasonEstimate = regularSeasonStart + 364 * DAY;
      const offseasonEnd = nextRegularSeasonEstimate - 42 * DAY - 1;

      const preseasonEnd = regularSeasonStart - 1;
      const preseasonStart = regularSeasonStart - 42 * DAY;

      const seasonData: SeasonSetupData = {
        phases: {
          preseason: { start: preseasonStart, end: preseasonEnd },
          regularSeason: { start: regularSeasonStart, end: regularSeasonEnd },
          playoffs: { start: playoffsStart, end: playoffsEnd },
          superBowl: { start: superBowlStart, end: superBowlEnd },
          offseason: { start: offseasonStart, end: offseasonEnd },
        },
        weekBoundaries,
        draftEligibilityWindow: { start: preseasonStart, end: preseasonEnd },
        playoffStructure: {
          wildCardWeek: periods.length + 1,
          divisionalWeek: periods.length + 2,
          championshipWeek: periods.length + 3,
          superBowlWeek: periods.length + 4,
        },
      };

      const result = await ctx.runMutation(internal.nflSeasonSetup.insertDerivedSeasonData, {
        year,
        ...seasonData,
      });

      return { success: result.success, year, message: result.message };
    } catch (error) {
      console.error(`deriveSeasonFromEspn failed for ${year}:`, error);
      return {
        success: false,
        year,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * Initialize both 2024 and 2025 seasons
 */
export const initializeBothSeasons = internalAction({
  args: {},
  handler: async (ctx): Promise<{ results: Array<{ year: number; success: boolean; seasonId?: Id<"nflSeasons">; message?: string; error?: string }> }> => {
    const results = [];

    try {
      const result2024 = await ctx.runMutation(internal.nflSeasonSetup.setup2024Season, {});
      results.push({ year: 2024, ...result2024 });
    } catch (error) {
      results.push({ year: 2024, success: false, error: (error as Error).message });
    }

    try {
      const result2025 = await ctx.runMutation(internal.nflSeasonSetup.setup2025Season, {});
      results.push({ year: 2025, ...result2025 });
    } catch (error) {
      results.push({ year: 2025, success: false, error: (error as Error).message });
    }

    return { results };
  },
});

/**
 * Get current season info (for debugging/admin purposes)
 */
export const getCurrentSeasonInfo = internalAction({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; date: string; seasonPhase?: any; currentWeek?: number; error?: string }> => {
    const now = Date.now();

    try {
      const seasonPhase = await ctx.runQuery(internal.nflSeasonBoundaries.getNFLSeasonPhase, { date: now });
      const currentWeek = await ctx.runQuery(internal.nflSeasonBoundaries.getCurrentNFLWeek, { date: now });

      return {
        success: true,
        date: new Date(now).toISOString(),
        seasonPhase,
        currentWeek,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        date: new Date(now).toISOString(),
      };
    }
  },
});

/**
 * Test content generation validation for different scenarios
 */
export const testContentValidation = internalAction({
  args: {
    leagueId: v.id("leagues"),
    testDates: v.optional(v.array(v.number())),
  },
  handler: async (ctx, { leagueId, testDates }): Promise<{ results: Array<{ date: string; contentTypes: Array<{ contentType: string; allowed: boolean; reason?: string }> }> }> => {
    const contentTypes = [
      "mock_draft",
      "weekly_preview",
      "weekly_recap",
      "season_recap",
      "trade_analysis",
      "power_rankings",
      "waiver_wire_report",
      "season_welcome"
    ];

    const datesToTest = testDates || [
      new Date(2025, 6, 15).getTime(),  // July 15, 2025 (preseason)
      new Date(2025, 8, 15).getTime(),  // September 15, 2025 (regular season)
      new Date(2026, 0, 15).getTime(),  // January 15, 2026 (playoffs)
      new Date(2026, 2, 15).getTime(),  // March 15, 2026 (offseason)
    ];

    const results = [];

    for (const date of datesToTest) {
      const dateResults = {
        date: new Date(date).toISOString(),
        contentTypes: [] as any[],
      };

      for (const contentType of contentTypes) {
        try {
          const validation = await ctx.runQuery(internal.nflSeasonBoundaries.isContentGenerationAllowed, {
            contentType,
            leagueId,
            date,
          });

          dateResults.contentTypes.push({
            contentType,
            allowed: validation.allowed,
            reason: validation.reason,
          });
        } catch (error) {
          dateResults.contentTypes.push({
            contentType,
            allowed: false,
            reason: (error as Error).message,
          });
        }
      }

      results.push(dateResults);
    }

    return { results };
  },
});
