import { v } from "convex/values";
import { mutation, query, action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// Default content schedule configurations
const DEFAULT_SCHEDULES = {
  weekly_recap: {
    schedule: {
      type: "weekly" as const,
      dayOfWeek: 2, // Tuesday after games conclude
      hour: 11,
      minute: 0,
    },
  },
  weekly_preview: {
    schedule: {
      type: "weekly" as const,
      dayOfWeek: 4, // Thursday
      hour: 8, // Morning
      minute: 0,
    },
  },
  trade_analysis: {
    schedule: {
      type: "event_triggered" as const,
      trigger: "trade_occurred",
      delayMinutes: 15,
    },
  },
  power_rankings: {
    schedule: {
      type: "weekly" as const,
      dayOfWeek: 2, // Tuesday
      hour: 10,
      minute: 0,
    },
  },
  waiver_wire_report: {
    schedule: {
      type: "weekly" as const,
      dayOfWeek: 3, // Wednesday
      hour: 15, // 3 PM
      minute: 0,
    },
  },
  mock_draft: {
    schedule: {
      type: "relative" as const,
      relativeTo: "draft_date",
      offsetDays: -7, // 1 week before draft
      hour: 9,
      minute: 0,
    },
  },
  rivalry_week_special: {
    schedule: {
      type: "event_triggered" as const,
      trigger: "rivalry_detected",
      delayMinutes: 30,
    },
  },
  emergency_hot_takes: {
    schedule: {
      type: "event_triggered" as const,
      trigger: "breaking_news",
      delayMinutes: 5,
    },
  },
  mid_season_awards: {
    schedule: {
      type: "season_based" as const,
      trigger: "week_8",
      delayDays: 0,
      hour: 12,
      minute: 0,
    },
  },
  championship_manifesto: {
    schedule: {
      type: "season_based" as const,
      trigger: "championship_week",
      delayDays: -1, // Day before championship
      hour: 18, // 6 PM
      minute: 0,
    },
  },
  season_recap: {
    schedule: {
      type: "season_based" as const,
      trigger: "champion_determined",
      delayDays: 1,
      hour: 10,
      minute: 0,
    },
  },
  custom_roast: {
    schedule: {
      type: "event_triggered" as const,
      trigger: "manual_request",
      delayMinutes: 0,
    },
  },
  season_welcome: {
    schedule: {
      type: "season_based" as const,
      trigger: "season_start",
      delayDays: 0,
      hour: 9,
      minute: 0,
    },
  },
};

// Create default content schedules for a league (opt-in by default)
export const createDefaultContentSchedules = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { leagueId, timezone = "America/New_York" } = args;

    // Check if schedules already exist
    const existingSchedules = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .collect();

    if (existingSchedules.length > 0) {
      return { success: false, message: "Content schedules already exist for this league" };
    }

    // Create default schedules for each content type
    const scheduleIds = [];
    for (const [contentType, config] of Object.entries(DEFAULT_SCHEDULES)) {
      const scheduleId = await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: contentType as any,
        enabled: true, // Default to enabled (opt-in)
        timezone,
        schedule: config.schedule,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      scheduleIds.push(scheduleId);
    }

    // Create league content preferences
    await ctx.db.insert("leagueContentPreferences", {
      leagueId,
      contentEnabled: true,
      timezone,
      currentMonthSpent: 0,
      budgetResetDate: Date.now(),
      notifyCommissioner: true,
      notifyFailures: true,
      autoPublish: false, // Default to requiring approval
      requireApproval: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { success: true, scheduleIds };
  },
});

// Get content schedules for a league
export const getContentSchedules = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const schedules = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    const preferences = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();

    return { schedules, preferences };
  },
});

// Update a content schedule
export const updateContentSchedule = mutation({
  args: {
    scheduleId: v.id("contentSchedules"),
    enabled: v.optional(v.boolean()),
    timezone: v.optional(v.string()),
    schedule: v.optional(v.any()),
    preferredPersona: v.optional(v.string()),
    customSettings: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { scheduleId, ...updates } = args;

    await ctx.db.patch(scheduleId, {
      ...updates,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

// Update league content preferences
export const updateLeagueContentPreferences = mutation({
  args: {
    leagueId: v.id("leagues"),
    contentEnabled: v.optional(v.boolean()),
    timezone: v.optional(v.string()),
    monthlyContentBudget: v.optional(v.number()),
    notifyCommissioner: v.optional(v.boolean()),
    notifyFailures: v.optional(v.boolean()),
    preferredPersonas: v.optional(v.array(v.string())),
    contentStyle: v.optional(v.union(
      v.literal("professional"),
      v.literal("casual"),
      v.literal("humorous"),
      v.literal("analytical")
    )),
    autoPublish: v.optional(v.boolean()),
    requireApproval: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { leagueId, ...updates } = args;

    const existing = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .first();

    if (!existing) {
      // Create default preferences if they don't exist (upsert pattern)
      const defaultPreferences = {
        leagueId,
        contentEnabled: true,
        timezone: "America/New_York",
        currentMonthSpent: 0,
        budgetResetDate: Date.now(),
        notifyCommissioner: true,
        notifyFailures: true,
        autoPublish: false, // Default to requiring approval
        requireApproval: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Apply any provided updates to the defaults
      const preferencesToCreate = {
        ...defaultPreferences,
        ...updates,
        updatedAt: Date.now(), // Ensure updatedAt is always current
      };

      await ctx.db.insert("leagueContentPreferences", preferencesToCreate);
    } else {
      // Update existing preferences
      await ctx.db.patch(existing._id, {
        ...updates,
        updatedAt: Date.now(),
      });
    }

    return { success: true };
  },
});

// Schedule content generation for a specific time
export const scheduleContentGeneration = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    contentScheduleId: v.id("contentSchedules"),
    contentType: v.string(),
    scheduledFor: v.number(),
    contextData: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const scheduledContentId = await ctx.db.insert("scheduledContent", {
      leagueId: args.leagueId,
      contentScheduleId: args.contentScheduleId,
      contentType: args.contentType,
      scheduledFor: args.scheduledFor,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      contextData: args.contextData,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { scheduledContentId };
  },
});

// Get pending scheduled content (for cron job processing)
export const getPendingScheduledContent = internalQuery({
  args: {
    beforeTime: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { beforeTime = Date.now(), limit = 50 } = args;

    const pending = await ctx.db
      .query("scheduledContent")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .filter((q) => q.lte(q.field("scheduledFor"), beforeTime))
      .take(limit);

    return pending;
  },
});

// Process scheduled content generation
export const processScheduledContent = internalAction({
  args: {
    scheduledContentId: v.id("scheduledContent"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; message?: string; contentId?: string; willRetry?: boolean }> => {
    const scheduledContent = await ctx.runQuery(internal.contentScheduling.getScheduledContentById, {
      scheduledContentId: args.scheduledContentId,
    });

    if (!scheduledContent) {
      throw new Error("Scheduled content not found");
    }

    if (scheduledContent.status !== "pending") {
      return { success: false, message: "Content is not in pending status" };
    }

    // Update status to generating
    await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
      scheduledContentId: args.scheduledContentId,
      status: "generating",
      attempts: scheduledContent.attempts + 1,
      lastAttemptAt: Date.now(),
    });

    try {
      // Get the content schedule configuration
      const contentSchedule = await ctx.runQuery(internal.contentScheduling.getContentScheduleById, {
        contentScheduleId: scheduledContent.contentScheduleId,
      });

      if (!contentSchedule || !contentSchedule.enabled) {
        await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
          scheduledContentId: args.scheduledContentId,
          status: "cancelled",
          errorMessage: "Content schedule is disabled",
        });
        return { success: false, message: "Content schedule is disabled" };
      }

      // Check league preferences
      const preferences = await ctx.runQuery(internal.contentScheduling.getLeaguePreferences, {
        leagueId: scheduledContent.leagueId,
      });

      if (!preferences?.contentEnabled) {
        await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
          scheduledContentId: args.scheduledContentId,
          status: "cancelled",
          errorMessage: "League content generation is disabled",
        });
        return { success: false, message: "League content generation is disabled" };
      }

      // Check monthly budget if set
      if (preferences.monthlyContentBudget && preferences.currentMonthSpent >= preferences.monthlyContentBudget) {
        await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
          scheduledContentId: args.scheduledContentId,
          status: "cancelled",
          errorMessage: "Monthly content budget exceeded",
        });
        return { success: false, message: "Monthly content budget exceeded" };
      }

      // Validate content generation is allowed based on NFL season boundaries
      try {
        const validationResult = await ctx.runQuery(api.nflSeasonBoundaries.isContentGenerationAllowed, {
          contentType: scheduledContent.contentType,
          leagueId: scheduledContent.leagueId,
          date: Date.now(),
        });

        if (!validationResult.allowed) {
          await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
            scheduledContentId: args.scheduledContentId,
            status: "cancelled",
            errorMessage: `Content generation not allowed: ${validationResult.reason}`,
          });
          return { success: false, message: `Content generation not allowed: ${validationResult.reason}` };
        }
      } catch (error) {
        console.warn("Season boundary validation failed, proceeding with content generation:", error);
        // Continue with generation if validation fails (graceful degradation)
      }

      // Create the content article first
      const articleId = await ctx.runMutation(internal.aiContent.createScheduledArticle, {
        leagueId: scheduledContent.leagueId,
        type: scheduledContent.contentType,
        persona: contentSchedule.preferredPersona || "analyst",
        userId: "system", // System-generated
      });

      // Schedule the content generation
      await ctx.scheduler.runAfter(0, internal.aiContent.generateContentAction, {
        articleId,
        leagueId: scheduledContent.leagueId,
        contentType: scheduledContent.contentType,
        persona: contentSchedule.preferredPersona || "analyst",
        userId: "system",
        customContext: scheduledContent.contextData ? JSON.stringify(scheduledContent.contextData) : undefined,
      });

      // Update scheduled content with results
      await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
        scheduledContentId: args.scheduledContentId,
        status: "completed",
        generatedContentId: articleId,
        generatedAt: Date.now(),
      });

      // The credit usage will be tracked when the actual generation completes
      // For now, just return success with the article ID
      return { success: true, contentId: articleId };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      
      // Check if we should retry
      const shouldRetry = scheduledContent.attempts < scheduledContent.maxAttempts;
      const nextRetryAt = shouldRetry ? Date.now() + (30 * 60 * 1000) : undefined; // Retry in 30 minutes

      await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
        scheduledContentId: args.scheduledContentId,
        status: shouldRetry ? "pending" : "failed",
        errorMessage,
        nextRetryAt,
      });

      return { success: false, message: errorMessage, willRetry: shouldRetry };
    }
  },
});

// Helper queries and mutations for internal use
export const getScheduledContentById = internalQuery({
  args: { scheduledContentId: v.id("scheduledContent") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.scheduledContentId);
  },
});

export const getContentScheduleById = internalQuery({
  args: { contentScheduleId: v.id("contentSchedules") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.contentScheduleId);
  },
});

export const getLeaguePreferences = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();
  },
});

export const updateScheduledContentStatus = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    status: v.union(
      v.literal("pending"),
      v.literal("generating"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    attempts: v.optional(v.number()),
    lastAttemptAt: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    generatedContentId: v.optional(v.id("aiContent")),
    generatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { scheduledContentId, ...updates } = args;
    
    await ctx.db.patch(scheduledContentId, {
      ...updates,
      updatedAt: Date.now(),
    });
  },
});

export const updateMonthlySpending = internalMutation({
  args: {
    preferencesId: v.id("leagueContentPreferences"),
    creditsUsed: v.number(),
  },
  handler: async (ctx, args) => {
    const preferences = await ctx.db.get(args.preferencesId);
    if (!preferences) return;

    await ctx.db.patch(args.preferencesId, {
      currentMonthSpent: preferences.currentMonthSpent + args.creditsUsed,
      updatedAt: Date.now(),
    });
  },
});

// Trigger event-based content generation (e.g., when a trade occurs)
export const triggerEventBasedContent = internalAction({
  args: {
    leagueId: v.id("leagues"),
    eventType: v.string(), // "trade_occurred", "season_ended", etc.
    eventData: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<{ scheduledJobs: number }> => {
    // Find all enabled content schedules that are triggered by this event
    const eventSchedules = await ctx.runQuery(internal.contentScheduling.getEventTriggeredSchedules, {
      leagueId: args.leagueId,
      eventType: args.eventType,
    });

    const scheduledJobs = [];

    for (const schedule of eventSchedules) {
      if (!schedule.enabled) continue;

      const delayMs = schedule.schedule.type === "event_triggered" 
        ? (schedule.schedule.delayMinutes || 0) * 60 * 1000 
        : 0;

      const scheduledFor = Date.now() + delayMs;

      const scheduledContentId = await ctx.runMutation(internal.contentScheduling.scheduleContentGeneration, {
        leagueId: args.leagueId,
        contentScheduleId: schedule._id,
        contentType: schedule.contentType,
        scheduledFor,
        contextData: {
          triggerEvent: args.eventType,
          eventData: args.eventData,
        },
      });

      scheduledJobs.push(scheduledContentId);

      // If no delay, process immediately
      if (delayMs === 0) {
        await ctx.scheduler.runAfter(0, internal.contentScheduling.processScheduledContent, {
          scheduledContentId: scheduledContentId.scheduledContentId,
        });
      }
    }

    return { scheduledJobs: scheduledJobs.length };
  },
});

export const getEventTriggeredSchedules = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    eventType: v.string(),
  },
  handler: async (ctx, args) => {
    const schedules = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("enabled"), true))
      .collect();

    return schedules.filter(schedule => 
      schedule.schedule.type === "event_triggered" && 
      schedule.schedule.trigger === args.eventType
    );
  },
});

// Cron job to process pending scheduled content
export const processScheduledContentCron = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("Processing scheduled content...");
    
    const pendingContent = await ctx.runQuery(internal.contentScheduling.getPendingScheduledContent, {
      beforeTime: Date.now(),
      limit: 20, // Process up to 20 items per run
    });

    if (pendingContent.length === 0) {
      console.log("No pending content to process");
      return { processed: 0 };
    }

    console.log(`Found ${pendingContent.length} pending content items to process`);

    let processed = 0;
    let errors = 0;

    for (const content of pendingContent) {
      try {
        await ctx.runAction(internal.contentScheduling.processScheduledContent, {
          scheduledContentId: content._id,
        });
        processed++;
      } catch (error) {
        console.error(`Error processing scheduled content ${content._id}:`, error);
        errors++;
      }
    }

    console.log(`Processed ${processed} content items, ${errors} errors`);
    return { processed, errors };
  },
});

// Content type categorization for smart scheduling
const SEASON_INDEPENDENT_CONTENT = new Set([
  "mock_draft",        // Based on individual league draft dates, not NFL season
  "season_recap",      // Should be scheduled during offseason for completed seasons
  "season_welcome",    // Should be scheduled during preseason
]);

const SEASON_DEPENDENT_CONTENT = new Set([
  "weekly_preview",    // Only during REGULAR_SEASON, PLAYOFFS, SUPER_BOWL
  "weekly_recap",      // Only during REGULAR_SEASON, PLAYOFFS, SUPER_BOWL
  "trade_analysis",    // Only during REGULAR_SEASON, PLAYOFFS, SUPER_BOWL
  "power_rankings",    // Only during REGULAR_SEASON, PLAYOFFS, SUPER_BOWL
  "waiver_wire_report", // Only during REGULAR_SEASON, PLAYOFFS, SUPER_BOWL
]);

// Helper function to determine if content should be scheduled based on NFL season phase
function shouldScheduleContent(contentType: string, seasonPhase: string): { should: boolean; reason: string } {
  // Season-independent content is always scheduled
  if (SEASON_INDEPENDENT_CONTENT.has(contentType)) {
    return { should: true, reason: "season-independent content" };
  }

  // Season-dependent content only during active season phases
  if (SEASON_DEPENDENT_CONTENT.has(contentType)) {
    const activePhasesForContent = ["REGULAR_SEASON", "PLAYOFFS", "SUPER_BOWL"];
    if (activePhasesForContent.includes(seasonPhase)) {
      return { should: true, reason: `active season phase: ${seasonPhase}` };
    } else {
      return { should: false, reason: `inactive season phase: ${seasonPhase} (content requires active season)` };
    }
  }

  // Unknown content types - default to season-dependent behavior for safety
  const activePhasesForUnknown = ["REGULAR_SEASON", "PLAYOFFS", "SUPER_BOWL"];
  if (activePhasesForUnknown.includes(seasonPhase)) {
    return { should: true, reason: `unknown content type, allowing during active season: ${seasonPhase}` };
  } else {
    return { should: false, reason: `unknown content type, blocking during inactive season: ${seasonPhase}` };
  }
}

// Cron job to schedule weekly recurring content with smart NFL season phase awareness
export const scheduleWeeklyContentCron = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("Scheduling weekly content with smart season phase filtering...");

    // Get current NFL season phase for smart scheduling decisions
    let currentSeasonPhase: string = "UNKNOWN";
    try {
      const seasonPhaseInfo = await ctx.runQuery(api.nflSeasonBoundaries.getNFLSeasonPhase, {});
      currentSeasonPhase = seasonPhaseInfo?.phase || "UNKNOWN";
      console.log(`Current NFL season phase: ${currentSeasonPhase}`);
    } catch (error) {
      console.warn("Failed to get NFL season phase, defaulting to scheduling all content:", error);
      currentSeasonPhase = "UNKNOWN"; // Will cause all content to be scheduled as fallback
    }

    // Get all enabled weekly content schedules
    const weeklySchedules = await ctx.runQuery(internal.contentScheduling.getWeeklySchedules, {});

    if (weeklySchedules.length === 0) {
      console.log("No weekly schedules found");
      return { scheduled: 0, skipped: 0 };
    }

    let scheduled = 0;
    let skipped = 0;
    const schedulingDetails: Array<{ contentType: string; leagueId: string; action: string; reason: string }> = [];

    for (const schedule of weeklySchedules) {
      try {
        // Check if this content type should be scheduled based on current season phase
        const shouldSchedule = shouldScheduleContent(schedule.contentType, currentSeasonPhase);
        
        if (!shouldSchedule.should) {
          skipped++;
          schedulingDetails.push({
            contentType: schedule.contentType,
            leagueId: schedule.leagueId,
            action: "skipped",
            reason: shouldSchedule.reason
          });
          continue;
        }

        // Calculate next occurrence for this weekly schedule
        const nextScheduledTime = calculateNextWeeklyOccurrence(schedule);
        
        // Check if we already have a pending/generating job for this time period
        const existingJob = await ctx.runQuery(internal.contentScheduling.findExistingWeeklyJob, {
          contentScheduleId: schedule._id,
          startTime: nextScheduledTime - (2 * 60 * 60 * 1000), // 2 hour window
          endTime: nextScheduledTime + (2 * 60 * 60 * 1000),
        });

        if (existingJob) {
          schedulingDetails.push({
            contentType: schedule.contentType,
            leagueId: schedule.leagueId,
            action: "already_scheduled",
            reason: "existing job found in 4-hour window"
          });
          continue; // Skip if already scheduled
        }

        // Schedule the content
        await ctx.runMutation(internal.contentScheduling.scheduleContentGeneration, {
          leagueId: schedule.leagueId,
          contentScheduleId: schedule._id,
          contentType: schedule.contentType,
          scheduledFor: nextScheduledTime,
          contextData: {
            week: await getCurrentNFLWeek(ctx),
            additionalContext: {
              scheduleType: "weekly_recurring",
              seasonPhase: currentSeasonPhase,
            },
          },
        });

        scheduled++;
        schedulingDetails.push({
          contentType: schedule.contentType,
          leagueId: schedule.leagueId,
          action: "scheduled",
          reason: shouldSchedule.reason
        });
        console.log(`Scheduled ${schedule.contentType} for league ${schedule.leagueId} at ${new Date(nextScheduledTime)} (${shouldSchedule.reason})`);

      } catch (error) {
        console.error(`Error processing schedule ${schedule._id} (${schedule.contentType}):`, error);
        schedulingDetails.push({
          contentType: schedule.contentType,
          leagueId: schedule.leagueId,
          action: "error",
          reason: `Error: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    // Comprehensive logging of what happened
    console.log(`Smart scheduling completed - NFL Season Phase: ${currentSeasonPhase}`);
    console.log(`Total schedules processed: ${weeklySchedules.length}`);
    console.log(`Scheduled: ${scheduled} items`);
    console.log(`Skipped: ${skipped} items (season phase filtering)`);
    
    // Log breakdown by content type
    const contentTypeCounts = schedulingDetails.reduce((acc, detail) => {
      const key = `${detail.contentType}_${detail.action}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log("Content type breakdown:", contentTypeCounts);

    // Calculate expected reduction during offseason
    if (currentSeasonPhase === "OFFSEASON") {
      const totalSeasonDependent = weeklySchedules.filter(s => SEASON_DEPENDENT_CONTENT.has(s.contentType)).length;
      const reductionPercentage = totalSeasonDependent > 0 ? Math.round((skipped / weeklySchedules.length) * 100) : 0;
      console.log(`Offseason optimization: ${reductionPercentage}% reduction in DB writes (${skipped}/${weeklySchedules.length} schedules filtered)`);
    }

    return { 
      scheduled, 
      skipped, 
      seasonPhase: currentSeasonPhase,
      details: schedulingDetails 
    };
  },
});

// Helper function to calculate next weekly occurrence
function calculateNextWeeklyOccurrence(schedule: any): number {
  if (schedule.schedule.type !== "weekly") {
    throw new Error("Schedule is not weekly type");
  }

  const now = new Date();
  const targetDayOfWeek = schedule.schedule.dayOfWeek;
  const targetHour = schedule.schedule.hour;
  const targetMinute = schedule.schedule.minute;

  // Convert to league timezone
  const timezone = schedule.timezone || "America/New_York";
  
  // Create date in target timezone
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };

  // Get current time in target timezone
  const formatter = new Intl.DateTimeFormat('en-CA', options);
  const parts = formatter.formatToParts(now);
  
  const currentInTZ = new Date();
  currentInTZ.setFullYear(parseInt(parts.find(p => p.type === 'year')!.value));
  currentInTZ.setMonth(parseInt(parts.find(p => p.type === 'month')!.value) - 1);
  currentInTZ.setDate(parseInt(parts.find(p => p.type === 'day')!.value));
  currentInTZ.setHours(parseInt(parts.find(p => p.type === 'hour')!.value));
  currentInTZ.setMinutes(parseInt(parts.find(p => p.type === 'minute')!.value));
  currentInTZ.setSeconds(0);
  currentInTZ.setMilliseconds(0);

  // Calculate next occurrence
  const currentDayOfWeek = currentInTZ.getDay();
  let daysUntilTarget = targetDayOfWeek - currentDayOfWeek;
  
  if (daysUntilTarget < 0) {
    daysUntilTarget += 7; // Next week
  } else if (daysUntilTarget === 0) {
    // Same day - check if time has passed
    const currentTimeMinutes = currentInTZ.getHours() * 60 + currentInTZ.getMinutes();
    const targetTimeMinutes = targetHour * 60 + targetMinute;
    
    if (currentTimeMinutes >= targetTimeMinutes) {
      daysUntilTarget = 7; // Next week
    }
  }

  const nextOccurrence = new Date(currentInTZ);
  nextOccurrence.setDate(nextOccurrence.getDate() + daysUntilTarget);
  nextOccurrence.setHours(targetHour, targetMinute, 0, 0);

  return nextOccurrence.getTime();
}

// Helper function to get current NFL week using the robust season boundary system
async function getCurrentNFLWeek(ctx: any): Promise<number> {
  try {
    return await ctx.runQuery(api.nflSeasonBoundaries.getCurrentNFLWeek, {});
  } catch (error) {
    console.error("Error getting current NFL week, falling back to default:", error);
    // Fallback to simplified logic if season data is not available
    const now = new Date();
    const seasonStart = new Date(now.getFullYear(), 8, 1); // September 1st as rough start
    const weeksSinceStart = Math.floor((now.getTime() - seasonStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return Math.max(1, Math.min(18, weeksSinceStart + 1)); // Weeks 1-18
  }
}

// Helper queries for cron jobs
export const getWeeklySchedules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allSchedules = await ctx.db
      .query("contentSchedules")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();

    return allSchedules.filter(schedule => schedule.schedule.type === "weekly");
  },
});

export const findExistingWeeklyJob = internalQuery({
  args: {
    contentScheduleId: v.id("contentSchedules"),
    startTime: v.number(),
    endTime: v.number(),
  },
  handler: async (ctx, args) => {
    const existingJobs = await ctx.db
      .query("scheduledContent")
      .withIndex("by_schedule_config", (q) => q.eq("contentScheduleId", args.contentScheduleId))
      .filter((q) => 
        q.and(
          q.gte(q.field("scheduledFor"), args.startTime),
          q.lte(q.field("scheduledFor"), args.endTime),
          q.or(
            q.eq(q.field("status"), "pending"),
            q.eq(q.field("status"), "generating")
          )
        )
      )
      .first();

    return existingJobs;
  },
});
