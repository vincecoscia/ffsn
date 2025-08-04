import { v } from "convex/values";
import { mutation, action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * Setup NFL season data for 2025
 * This function initializes the 2025 NFL season with accurate dates
 */
export const setup2025Season = mutation({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; seasonId?: Id<"nflSeasons">; year?: number; message: string }> => {
    const year = 2025;
    
    // Check if 2025 season already exists
    const existingSeason = await ctx.db
      .query("nflSeasons")
      .withIndex("by_year", (q) => q.eq("year", year))
      .first();

    if (existingSeason) {
      return { success: false, message: "2025 season already exists" };
    }

    // 2025 NFL Season Dates (based on typical NFL schedule patterns)
    const seasonData = {
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
      playoffStructure: {
        wildCardWeek: 19,
        divisionalWeek: 20,
        championshipWeek: 21,
        superBowlWeek: 22,
      },
    };

    // Insert the season data
    const seasonId = await ctx.db.insert("nflSeasons", {
      year,
      phases: seasonData.phases,
      weekBoundaries: seasonData.weekBoundaries,
      draftEligibilityWindow: seasonData.draftEligibilityWindow,
      playoffStructure: seasonData.playoffStructure,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { 
      success: true, 
      seasonId, 
      year,
      message: "2025 NFL season boundaries initialized successfully"
    };
  },
});

/**
 * Setup NFL season data for 2024 (for testing with historical data)
 */
export const setup2024Season = mutation({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; seasonId?: Id<"nflSeasons">; year?: number; message: string }> => {
    const year = 2024;
    
    // Check if 2024 season already exists
    const existingSeason = await ctx.db
      .query("nflSeasons")
      .withIndex("by_year", (q) => q.eq("year", year))
      .first();

    if (existingSeason) {
      return { success: false, message: "2024 season already exists" };
    }

    // 2024 NFL Season Dates (actual dates)
    const seasonData = {
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
      playoffStructure: {
        wildCardWeek: 19,
        divisionalWeek: 20,
        championshipWeek: 21,
        superBowlWeek: 22,
      },
    };

    const seasonId = await ctx.db.insert("nflSeasons", {
      year,
      phases: seasonData.phases,
      weekBoundaries: seasonData.weekBoundaries,
      draftEligibilityWindow: seasonData.draftEligibilityWindow,
      playoffStructure: seasonData.playoffStructure,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { 
      success: true, 
      seasonId, 
      year,
      message: "2024 NFL season boundaries initialized successfully"
    };
  },
});

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

/**
 * Initialize both 2024 and 2025 seasons
 */
export const initializeBothSeasons = action({
  args: {},
  handler: async (ctx): Promise<{ results: Array<{ year: number; success: boolean; seasonId?: Id<"nflSeasons">; message?: string; error?: string }> }> => {
    const results = [];
    
    try {
      const result2024 = await ctx.runMutation(api.nflSeasonSetup.setup2024Season, {});
      results.push({ year: 2024, ...result2024 });
    } catch (error) {
      results.push({ year: 2024, success: false, error: (error as Error).message });
    }
    
    try {
      const result2025 = await ctx.runMutation(api.nflSeasonSetup.setup2025Season, {});
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
export const getCurrentSeasonInfo = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; date: string; seasonPhase?: any; currentWeek?: number; error?: string }> => {
    const now = Date.now();
    
    try {
      const seasonPhase = await ctx.runQuery(api.nflSeasonBoundaries.getNFLSeasonPhase, { date: now });
      const currentWeek = await ctx.runQuery(api.nflSeasonBoundaries.getCurrentNFLWeek, { date: now });
      
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
export const testContentValidation = action({
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
          const validation = await ctx.runQuery(api.nflSeasonBoundaries.isContentGenerationAllowed, {
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