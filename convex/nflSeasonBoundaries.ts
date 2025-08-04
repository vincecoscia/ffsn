import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * NFL Season Phase Enum
 */
export type NFLSeasonPhase = "PRESEASON" | "REGULAR_SEASON" | "PLAYOFFS" | "SUPER_BOWL" | "OFFSEASON";

/**
 * NFL Season Boundary Data Structure
 */
export interface NFLSeasonBoundaries {
  year: number;
  phases: {
    preseason: { start: number; end: number };
    regularSeason: { start: number; end: number };
    playoffs: { start: number; end: number };
    superBowl: { start: number; end: number };
    offseason: { start: number; end: number };
  };
  weekBoundaries: Array<{
    week: number;
    start: number;
    end: number;
    isPlayoffs: boolean;
  }>;
  draftEligibilityWindow: { start: number; end: number };
  playoffStructure: {
    wildCardWeek: number;
    divisionalWeek: number;
    championshipWeek: number;
    superBowlWeek: number;
  };
}

/**
 * Get NFL season boundaries for a specific year
 * This query returns all season phase dates and week boundaries
 */
export const getNFLSeasonBoundaries = query({
  args: { year: v.number() },
  handler: async (ctx, { year }): Promise<NFLSeasonBoundaries | null> => {
    const season = await ctx.db
      .query("nflSeasons")
      .withIndex("by_year", (q) => q.eq("year", year))
      .first();

    if (!season) {
      return null;
    }

    return {
      year: season.year,
      phases: season.phases,
      weekBoundaries: season.weekBoundaries,
      draftEligibilityWindow: season.draftEligibilityWindow,
      playoffStructure: season.playoffStructure,
    };
  },
});

/**
 * Get current NFL season phase for a given date (or current date if not provided)
 * This is the core function for determining what phase the NFL season is in
 */
export const getNFLSeasonPhase = query({
  args: { date: v.optional(v.number()) },
  handler: async (ctx, { date }): Promise<{ phase: NFLSeasonPhase; year: number; week?: number } | null> => {
    const targetDate = date ?? Date.now();
    
    // Determine which season year to check based on the date
    const checkDate = new Date(targetDate);
    let seasonYear = checkDate.getFullYear();
    
    // If we're in January-July, we might be in the previous season's playoffs/offseason
    if (checkDate.getMonth() < 7) { // Before August
      seasonYear -= 1;
    }
    
    // Try current year first, then next year if we're in late offseason
    for (const yearToCheck of [seasonYear, seasonYear + 1]) {
      const season = await ctx.db
        .query("nflSeasons")
        .withIndex("by_year", (q) => q.eq("year", yearToCheck))
        .first();

      if (!season) continue;

      // Check each phase in order
      if (targetDate >= season.phases.preseason.start && targetDate <= season.phases.preseason.end) {
        return { phase: "PRESEASON", year: yearToCheck };
      }
      
      if (targetDate >= season.phases.regularSeason.start && targetDate <= season.phases.regularSeason.end) {
        // Also determine the week if in regular season
        const week = getWeekFromDate(targetDate, season.weekBoundaries);
        return { phase: "REGULAR_SEASON", year: yearToCheck, week };
      }
      
      if (targetDate >= season.phases.playoffs.start && targetDate <= season.phases.playoffs.end) {
        // Also determine playoff week
        const week = getWeekFromDate(targetDate, season.weekBoundaries);
        return { phase: "PLAYOFFS", year: yearToCheck, week };
      }
      
      if (targetDate >= season.phases.superBowl.start && targetDate <= season.phases.superBowl.end) {
        return { phase: "SUPER_BOWL", year: yearToCheck, week: season.playoffStructure.superBowlWeek };
      }
      
      if (targetDate >= season.phases.offseason.start && targetDate <= season.phases.offseason.end) {
        return { phase: "OFFSEASON", year: yearToCheck };
      }
    }

    // Fallback to OFFSEASON if no season data found
    return { phase: "OFFSEASON", year: seasonYear };
  },
});

/**
 * Get current NFL week (replacement for the crude implementation)
 * Returns accurate week number based on NFL season boundaries
 */
export const getCurrentNFLWeek = query({
  args: { date: v.optional(v.number()) },
  handler: async (ctx, { date }): Promise<number> => {
    const targetDate = date ?? Date.now();
    
    // Call the main function logic directly to avoid circular reference
    const targetDateForPhase = targetDate;
    const checkDate = new Date(targetDateForPhase);
    let seasonYear = checkDate.getFullYear();
    
    // If we're in January-July, we might be in the previous season's playoffs/offseason
    if (checkDate.getMonth() < 7) { // Before August
      seasonYear -= 1;
    }
    
    // Try current year first, then next year if we're in late offseason
    let seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number } | null = null;
    for (const yearToCheck of [seasonYear, seasonYear + 1]) {
      const season = await ctx.db
        .query("nflSeasons")
        .withIndex("by_year", (q) => q.eq("year", yearToCheck))
        .first();

      if (!season) continue;

      // Check each phase in order
      if (targetDateForPhase >= season.phases.preseason.start && targetDateForPhase <= season.phases.preseason.end) {
        seasonInfo = { phase: "PRESEASON", year: yearToCheck };
        break;
      }
      
      if (targetDateForPhase >= season.phases.regularSeason.start && targetDateForPhase <= season.phases.regularSeason.end) {
        // Also determine the week if in regular season
        const week = getWeekFromDate(targetDateForPhase, season.weekBoundaries);
        seasonInfo = { phase: "REGULAR_SEASON", year: yearToCheck, week };
        break;
      }
      
      if (targetDateForPhase >= season.phases.playoffs.start && targetDateForPhase <= season.phases.playoffs.end) {
        // Also determine playoff week
        const week = getWeekFromDate(targetDateForPhase, season.weekBoundaries);
        seasonInfo = { phase: "PLAYOFFS", year: yearToCheck, week };
        break;
      }
      
      if (targetDateForPhase >= season.phases.superBowl.start && targetDateForPhase <= season.phases.superBowl.end) {
        seasonInfo = { phase: "SUPER_BOWL", year: yearToCheck, week: season.playoffStructure.superBowlWeek };
        break;
      }
      
      if (targetDateForPhase >= season.phases.offseason.start && targetDateForPhase <= season.phases.offseason.end) {
        seasonInfo = { phase: "OFFSEASON", year: yearToCheck };
        break;
      }
    }

    // Fallback to OFFSEASON if no season data found
    if (!seasonInfo) {
      seasonInfo = { phase: "OFFSEASON", year: seasonYear };
    }
    
    if (!seasonInfo) {
      return 1; // Fallback
    }

    if (seasonInfo.week) {
      return seasonInfo.week;
    }

    // If no specific week (like during offseason), return appropriate default
    switch (seasonInfo.phase) {
      case "PRESEASON":
        return 0; // Preseason doesn't have regular weeks
      case "OFFSEASON":
        return 1; // Default to week 1 for scheduling purposes
      default:
        return 1;
    }
  },
});

/**
 * Check if content generation is allowed for a specific content type and league
 * This is the core validation function for content scheduling
 */
export const isContentGenerationAllowed = query({
  args: { 
    contentType: v.string(),
    leagueId: v.id("leagues"),
    date: v.optional(v.number())
  },
  handler: async (ctx, { contentType, leagueId, date }): Promise<{ allowed: boolean; reason?: string }> => {
    const targetDate = date ?? Date.now();
    
    // Get current season phase - duplicate logic to avoid circular reference
    const targetDateForPhase = targetDate;
    const checkDate = new Date(targetDateForPhase);
    let seasonYear = checkDate.getFullYear();
    
    // If we're in January-July, we might be in the previous season's playoffs/offseason
    if (checkDate.getMonth() < 7) { // Before August
      seasonYear -= 1;
    }
    
    // Try current year first, then next year if we're in late offseason
    let seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number } | null = null;
    for (const yearToCheck of [seasonYear, seasonYear + 1]) {
      const season = await ctx.db
        .query("nflSeasons")
        .withIndex("by_year", (q) => q.eq("year", yearToCheck))
        .first();

      if (!season) continue;

      // Check each phase in order
      if (targetDateForPhase >= season.phases.preseason.start && targetDateForPhase <= season.phases.preseason.end) {
        seasonInfo = { phase: "PRESEASON", year: yearToCheck };
        break;
      }
      
      if (targetDateForPhase >= season.phases.regularSeason.start && targetDateForPhase <= season.phases.regularSeason.end) {
        // Also determine the week if in regular season
        const week = getWeekFromDate(targetDateForPhase, season.weekBoundaries);
        seasonInfo = { phase: "REGULAR_SEASON", year: yearToCheck, week };
        break;
      }
      
      if (targetDateForPhase >= season.phases.playoffs.start && targetDateForPhase <= season.phases.playoffs.end) {
        // Also determine playoff week
        const week = getWeekFromDate(targetDateForPhase, season.weekBoundaries);
        seasonInfo = { phase: "PLAYOFFS", year: yearToCheck, week };
        break;
      }
      
      if (targetDateForPhase >= season.phases.superBowl.start && targetDateForPhase <= season.phases.superBowl.end) {
        seasonInfo = { phase: "SUPER_BOWL", year: yearToCheck, week: season.playoffStructure.superBowlWeek };
        break;
      }
      
      if (targetDateForPhase >= season.phases.offseason.start && targetDateForPhase <= season.phases.offseason.end) {
        seasonInfo = { phase: "OFFSEASON", year: yearToCheck };
        break;
      }
    }

    // Fallback to OFFSEASON if no season data found
    if (!seasonInfo) {
      seasonInfo = { phase: "OFFSEASON", year: seasonYear };
    }
    if (!seasonInfo) {
      return { allowed: false, reason: "Unable to determine NFL season phase" };
    }

    // Get league information including draft date
    const league = await ctx.db.get(leagueId);
    if (!league) {
      return { allowed: false, reason: "League not found" };
    }

    // Get league season data for draft date
    const leagueSeason = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonInfo.year))
      .first();

    // Content type specific validation
    switch (contentType) {
      case "mock_draft":
        return validateMockDraftContent(seasonInfo, leagueSeason, targetDate);
      
      case "weekly_preview":
        return validateWeeklyPreviewContent(seasonInfo);
      
      case "weekly_recap":
        return validateWeeklyRecapContent(seasonInfo);
      
      case "season_recap":
        return validateSeasonRecapContent(seasonInfo);
      
      case "trade_analysis":
        return validateTradeAnalysisContent(seasonInfo);
      
      case "power_rankings":
        return validatePowerRankingsContent(seasonInfo);
      
      case "waiver_wire_report":
        return validateWaiverWireContent(seasonInfo);
      
      case "season_welcome":
        return validateSeasonWelcomeContent(seasonInfo, targetDate);
      
      default:
        // For unknown content types, allow during regular season and playoffs
        if (seasonInfo.phase === "REGULAR_SEASON" || seasonInfo.phase === "PLAYOFFS") {
          return { allowed: true };
        }
        return { allowed: false, reason: `Content type '${contentType}' not allowed during ${seasonInfo.phase}` };
    }
  },
});

// Content validation helper functions
function validateMockDraftContent(
  seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number },
  leagueSeason: any,
  targetDate: number
): { allowed: boolean; reason?: string } {
  // Mock drafts should only be generated 1-2 weeks before actual league draft date
  if (!leagueSeason?.draftInfo?.draftDate) {
    return { allowed: false, reason: "No draft date set for league" };
  }

  const draftDate = leagueSeason.draftInfo.draftDate;
  const daysBefore = (draftDate - targetDate) / (24 * 60 * 60 * 1000);
  
  // Allow 1-14 days before draft
  if (daysBefore >= 1 && daysBefore <= 14) {
    return { allowed: true };
  }
  
  if (daysBefore < 1) {
    return { allowed: false, reason: "Too close to draft date (less than 1 day)" };
  }
  
  return { allowed: false, reason: "Too far from draft date (more than 14 days)" };
}

function validateWeeklyPreviewContent(
  seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number }
): { allowed: boolean; reason?: string } {
  // Weekly previews only during regular season and playoffs
  if (seasonInfo.phase === "REGULAR_SEASON" || seasonInfo.phase === "PLAYOFFS") {
    return { allowed: true };
  }
  
  return { allowed: false, reason: `Weekly previews not available during ${seasonInfo.phase}` };
}

function validateWeeklyRecapContent(
  seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number }
): { allowed: boolean; reason?: string } {
  // Weekly recaps only during regular season and playoffs (after games are played)
  if (seasonInfo.phase === "REGULAR_SEASON" || seasonInfo.phase === "PLAYOFFS") {
    return { allowed: true };
  }
  
  return { allowed: false, reason: `Weekly recaps not available during ${seasonInfo.phase}` };
}

function validateSeasonRecapContent(
  seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number }
): { allowed: boolean; reason?: string } {
  // Season recaps only after season ends (offseason or after Super Bowl)
  if (seasonInfo.phase === "OFFSEASON") {
    return { allowed: true };
  }
  
  return { allowed: false, reason: `Season recaps only available after season ends, currently in ${seasonInfo.phase}` };
}

function validateTradeAnalysisContent(
  seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number }
): { allowed: boolean; reason?: string } {
  // Trade analysis available during regular season and early playoffs
  if (seasonInfo.phase === "REGULAR_SEASON" || seasonInfo.phase === "PLAYOFFS") {
    return { allowed: true };
  }
  
  return { allowed: false, reason: `Trade analysis not available during ${seasonInfo.phase}` };
}

function validatePowerRankingsContent(
  seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number }
): { allowed: boolean; reason?: string } {
  // Power rankings available during regular season and playoffs
  if (seasonInfo.phase === "REGULAR_SEASON" || seasonInfo.phase === "PLAYOFFS") {
    return { allowed: true };
  }
  
  return { allowed: false, reason: `Power rankings not available during ${seasonInfo.phase}` };
}

function validateWaiverWireContent(
  seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number }
): { allowed: boolean; reason?: string } {
  // Waiver wire reports available during regular season and playoffs
  if (seasonInfo.phase === "REGULAR_SEASON" || seasonInfo.phase === "PLAYOFFS") {
    return { allowed: true };
  }
  
  return { allowed: false, reason: `Waiver wire reports not available during ${seasonInfo.phase}` };
}

function validateSeasonWelcomeContent(
  seasonInfo: { phase: NFLSeasonPhase; year: number; week?: number },
  targetDate: number
): { allowed: boolean; reason?: string } {
  // Season welcome content during preseason and early regular season (first 2 weeks)
  if (seasonInfo.phase === "PRESEASON") {
    return { allowed: true };
  }
  
  if (seasonInfo.phase === "REGULAR_SEASON" && seasonInfo.week && seasonInfo.week <= 2) {
    return { allowed: true };
  }
  
  return { allowed: false, reason: `Season welcome content only available during preseason or first 2 weeks of regular season` };
}

// Helper function to determine week from date and week boundaries
function getWeekFromDate(date: number, weekBoundaries: Array<{ week: number; start: number; end: number; isPlayoffs: boolean }>): number | undefined {
  for (const boundary of weekBoundaries) {
    if (date >= boundary.start && date <= boundary.end) {
      return boundary.week;
    }
  }
  return undefined;
}

/**
 * Initialize NFL season data for a given year
 * This mutation creates the season boundaries and week structure
 */
export const initializeNFLSeason = mutation({
  args: { 
    year: v.number(),
    seasonData: v.optional(v.any()) // Allow custom season data, otherwise use defaults
  },
  handler: async (ctx, { year, seasonData }) => {
    // Check if season already exists
    const existingSeason = await ctx.db
      .query("nflSeasons")
      .withIndex("by_year", (q) => q.eq("year", year))
      .first();

    if (existingSeason) {
      throw new Error(`NFL season ${year} already exists`);
    }

    // Use provided data or generate default season structure
    const defaultSeasonData = generateDefaultSeasonData(year);
    const finalSeasonData = seasonData || defaultSeasonData;

    // Insert the season data
    const seasonId = await ctx.db.insert("nflSeasons", {
      year,
      phases: finalSeasonData.phases,
      weekBoundaries: finalSeasonData.weekBoundaries,
      draftEligibilityWindow: finalSeasonData.draftEligibilityWindow,
      playoffStructure: finalSeasonData.playoffStructure,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { seasonId, year };
  },
});

/**
 * Update NFL season boundaries
 */
export const updateNFLSeasonBoundaries = mutation({
  args: {
    year: v.number(),
    phases: v.optional(v.any()),
    weekBoundaries: v.optional(v.any()),
    draftEligibilityWindow: v.optional(v.any()),
    playoffStructure: v.optional(v.any()),
  },
  handler: async (ctx, { year, ...updates }) => {
    const season = await ctx.db
      .query("nflSeasons")
      .withIndex("by_year", (q) => q.eq("year", year))
      .first();

    if (!season) {
      throw new Error(`NFL season ${year} not found`);
    }

    await ctx.db.patch(season._id, {
      ...updates,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

// Helper function to generate default season data structure
function generateDefaultSeasonData(year: number): NFLSeasonBoundaries {
  // These are approximate dates - in production you'd want exact dates
  const baseYear = year;
  
  // Preseason typically starts late July, ends early September
  const preseasonStart = new Date(baseYear, 6, 25).getTime(); // July 25
  const preseasonEnd = new Date(baseYear, 8, 6).getTime(); // September 6
  
  // Regular season starts early September (Week 1 Thursday)
  const regularSeasonStart = new Date(baseYear, 8, 7).getTime(); // September 7
  const regularSeasonEnd = new Date(baseYear + 1, 0, 8).getTime(); // January 8 next year
  
  // Playoffs start mid-January
  const playoffsStart = new Date(baseYear + 1, 0, 13).getTime(); // January 13
  const playoffsEnd = new Date(baseYear + 1, 1, 11).getTime(); // February 11
  
  // Super Bowl is first Sunday in February
  const superBowlStart = new Date(baseYear + 1, 1, 12).getTime(); // February 12
  const superBowlEnd = new Date(baseYear + 1, 1, 13).getTime(); // February 13
  
  // Offseason starts after Super Bowl
  const offseasonStart = new Date(baseYear + 1, 1, 14).getTime(); // February 14
  const offseasonEnd = new Date(baseYear + 1, 6, 24).getTime(); // July 24 next year

  // Generate 18 regular season weeks + 4 playoff weeks
  const weekBoundaries = [];
  let weekStart = regularSeasonStart;
  
  // Regular season weeks 1-18
  for (let week = 1; week <= 18; week++) {
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000) - 1; // 7 days minus 1ms
    weekBoundaries.push({
      week,
      start: weekStart,
      end: Math.min(weekEnd, regularSeasonEnd),
      isPlayoffs: false,
    });
    weekStart = weekEnd + 1;
  }
  
  // Playoff weeks 19-22
  weekStart = playoffsStart;
  for (let week = 19; week <= 22; week++) {
    const weekEnd = weekStart + (7 * 24 * 60 * 60 * 1000) - 1;
    weekBoundaries.push({
      week,
      start: weekStart,
      end: week === 22 ? superBowlEnd : weekEnd,
      isPlayoffs: true,
    });
    weekStart = weekEnd + 1;
  }

  return {
    year,
    phases: {
      preseason: { start: preseasonStart, end: preseasonEnd },
      regularSeason: { start: regularSeasonStart, end: regularSeasonEnd },
      playoffs: { start: playoffsStart, end: playoffsEnd },
      superBowl: { start: superBowlStart, end: superBowlEnd },
      offseason: { start: offseasonStart, end: offseasonEnd },
    },
    weekBoundaries,
    draftEligibilityWindow: {
      start: preseasonStart,
      end: regularSeasonStart - (24 * 60 * 60 * 1000), // Day before season starts
    },
    playoffStructure: {
      wildCardWeek: 19,
      divisionalWeek: 20,
      championshipWeek: 21,
      superBowlWeek: 22,
    },
  };
}

