import { v } from "convex/values";
import {
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { nflSeasonYearFor, leagueCurrentSeason } from "./lib/season";
import { requireLeagueMember, requireCommissioner } from "./lib/auth";
import { espnConnectionBlocked, FRESHNESS_EXEMPT_CONTENT } from "./lib/espnConnection";
import { resolveSeasonEndWeek, weeklyTargetWeekInSeason } from "./lib/seasonWindow";
import { languageRatingValidator } from "./validators";
// Both of these are plain data modules (no runtime deps), so they are safe to
// import into the Convex V8 isolate - payments.ts already imports the templates.
import { contentTypePersonaMap, DEFAULT_PERSONA, personaPrompts } from "../src/lib/ai/persona-prompts";
import { contentTemplates } from "../src/lib/ai/content-templates";
// `facts.ts` is a plain module too: its only value imports are the templates
// and the persona roster, and everything else it pulls in is `import type`.
import { adpLooksLikePlaceholder } from "../src/lib/ai/facts";
import { hasActivePass, passSeasonId } from "./credits";
import { automationSpendCapUsd } from "./deskMetrics";
import { resolveScheduledDraftDate, nextMorningAfter } from "./lib/draftDate";
import { weekToMatchupPeriod } from "./lib/espnSettings";
import { deriveLeagueCalendar, describeLeagueCalendar, leagueCalendarInputFromSettings } from "./lib/leagueCalendar";
// `./lib/playoffs` is a deliberately pure module (no `internal`/`api` imports of its own - see its
// file header), safe to import as a value here per the repo-wide gotcha about cross-module value
// imports of a convex/*.ts module that references `internal`.
import { isByeMatchup } from "./lib/playoffs";
// `./lib/weekOneGate` is likewise deliberately pure (see its file header) - the week-1 preview
// scheduling gate (owner directive, 2026-09-03).
import { weekOnePreviewDecision } from "./lib/weekOneGate";
// `./lib/interviewees` is likewise deliberately pure/DB-only (no `internal`/`api` imports of its
// own) - reused here so `kickOffSeasonWelcome` can check for claimed managers with the exact
// rule `contentSchedulingIntegration.onContentScheduled` uses (owner ask, 2026-09-06).
import { resolveInterviewees } from "./lib/interviewees";

/** The roster default writer for a content type (spec section 9.2.3). */
export function defaultPersonaFor(contentType: string): string {
  return contentTypePersonaMap[contentType]?.[0] ?? DEFAULT_PERSONA;
}

/** True only for a persona that can write today; retired desks and unknown slugs are not writers. */
export function isWriterSlug(slug: string | undefined | null): slug is string {
  return typeof slug === "string" && personaPrompts[slug]?.isWriter === true;
}

/**
 * The writer a calendar row actually gets: its preferred persona when that persona can still
 * write, else the roster default. Prod calendar rows still carried retired slugs (mike-harrison,
 * chad-thunderhype), and every article for those types failed with "Failed to generate content".
 */
export function resolveWriterPersona(preferred: string | undefined | null, contentType: string): string {
  return isWriterSlug(preferred) ? preferred : defaultPersonaFor(contentType);
}

/** One entry of `nflSeasons.weekBoundaries`. */
type WeekBoundary = { week: number; start: number; end: number; isPlayoffs: boolean };

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
/** A row may be pushed out this many times for stale data before it fails. */
const MAX_DEFERRALS = 6;

// The automatic-by-default content calendar (spec section 9.1). Every entry is
// created at league import; `enabled: false` entries exist so a commissioner can
// switch them on from the schedule manager without us inventing a row later.
// All local times are in the league timezone captured at import.
type CalendarEntry = {
  enabled: boolean;
  schedule:
    | { type: "weekly"; dayOfWeek: number; hour: number; minute: number }
    | { type: "relative"; relativeTo: string; offsetDays: number; hour: number; minute: number }
    | { type: "event_triggered"; trigger: string; delayMinutes?: number }
    | { type: "season_based"; trigger: string; delayDays?: number; hour: number; minute: number; dayOfWeek?: number };
};

export const DEFAULT_SCHEDULES: Record<string, CalendarEntry> = {
  // --- on by default -----------------------------------------------------
  season_welcome: {
    enabled: true,
    // Also generated directly at payment (payments.ts); this row covers the
    // start of every subsequent season.
    schedule: { type: "season_based", trigger: "season_start", delayDays: 0, hour: 9, minute: 0 },
  },
  weekly_recap: {
    enabled: true,
    schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 }, // Tuesday 09:00
  },
  power_rankings: {
    enabled: true,
    schedule: { type: "weekly", dayOfWeek: 3, hour: 9, minute: 0 }, // Wednesday 09:00
  },
  waiver_wire_report: {
    enabled: true,
    schedule: { type: "weekly", dayOfWeek: 3, hour: 12, minute: 0 }, // Wednesday 12:00
  },
  weekly_preview: {
    enabled: true,
    schedule: { type: "weekly", dayOfWeek: 4, hour: 9, minute: 0 }, // Thursday 09:00
  },
  trade_analysis: {
    enabled: true,
    schedule: { type: "event_triggered", trigger: "trade_occurred", delayMinutes: 30 },
  },
  draft_rankings: {
    enabled: true,
    schedule: { type: "event_triggered", trigger: "draft_completed", delayMinutes: 60 },
  },
  mid_season_awards: {
    enabled: true,
    // League-relative midSeasonWeek (convex/lib/leagueCalendar.ts) when the
    // league's synced settings support it, else NFL week 9 - Wednesday 09:00
    // local either way.
    schedule: { type: "season_based", trigger: "week_9", delayDays: 0, hour: 9, minute: 0, dayOfWeek: 3 },
  },
  playoff_picture: {
    enabled: true,
    // League-relative playoffPictureWeeks (reg-2, reg-1, reg) when available,
    // else NFL weeks 12-14 - Thursday 12:00 local, one article per week.
    schedule: { type: "season_based", trigger: "weeks_12_14", delayDays: 0, hour: 12, minute: 0, dayOfWeek: 4 },
  },
  season_recap: {
    enabled: true,
    // League-relative: Tuesday 09:00 local after the league's LAST
    // championship week (seasonEndWeek) - `delayDays: 1` off that week's
    // Monday-night end lands on Tuesday. Falls back to the day after Super
    // Bowl Sunday when the league has no synced settings yet.
    schedule: { type: "season_based", trigger: "champion_determined", delayDays: 1, hour: 9, minute: 0 },
  },

  // --- created disabled --------------------------------------------------
  championship_manifesto: {
    enabled: false,
    // League-relative: Tuesday 09:00 local of the league's FIRST championship
    // week (the week boundary's start is that Tuesday 00:00, per
    // `nflSeasons.weekBoundaries`) - the day the preceding round's finality
    // is known. Falls back to the (wrong-by-construction) NFL conference
    // championship week when the league has no synced settings yet.
    schedule: { type: "season_based", trigger: "championship_week", delayDays: 0, hour: 9, minute: 0 },
  },
  rivalry_week_special: {
    enabled: false,
    schedule: { type: "event_triggered", trigger: "rivalry_detected", delayMinutes: 30 },
  },
  emergency_hot_takes: {
    enabled: false,
    schedule: { type: "event_triggered", trigger: "breaking_news", delayMinutes: 5 },
  },
  custom_roast: {
    enabled: false,
    schedule: { type: "event_triggered", trigger: "manual_request", delayMinutes: 0 },
  },
  mock_draft: {
    enabled: false,
    schedule: { type: "relative", relativeTo: "draft_date", offsetDays: -7, hour: 9, minute: 0 },
  },
  hall_of_shame: {
    enabled: false,
    schedule: { type: "season_based", trigger: "week_14", delayDays: 0, hour: 10, minute: 0, dayOfWeek: 3 },
  },
  commissioner_corner: {
    enabled: false,
    schedule: { type: "weekly", dayOfWeek: 1, hour: 10, minute: 0 },
  },
  bank_statement: {
    enabled: false,
    // Reggie Banks' results ledger, the afternoon after the recap. Created
    // disabled: it is one more weekly article per league, so the commissioner
    // switches it on from the schedule manager.
    schedule: { type: "weekly", dayOfWeek: 2, hour: 12, minute: 0 }, // Tuesday 12:00
  },
};

/**
 * Content whose `week` refers to the week that just finished rather than the
 * week that is running when the job fires. NFL week boundaries start Tuesday
 * 00:00, so a Tuesday-morning recap executes inside week N+1 while it is about
 * week N. Applied identically when the row is scheduled and when it executes,
 * so the idempotency key (spec section 9.2.6) is stable across both.
 */
const LOOKBACK_CONTENT = new Set([
  "weekly_recap",
  "power_rankings",
  "waiver_wire_report",
  "bank_statement",
  "mid_season_awards",
  "hall_of_shame",
]);

export function resolveTargetWeek(contentType: string, currentWeek: number): number {
  if (LOOKBACK_CONTENT.has(contentType)) {
    return Math.max(1, currentWeek - 1);
  }
  return currentWeek;
}

/**
 * Weekly programming (owner directive, Sept 2026: "make sure the weekly
 * content only generates during the season"). `processScheduledContent`
 * cancels one of these with `cancelReason: "out_of_season"` when its
 * lookback-resolved target week is past the league's own `seasonEndWeek`
 * (`convex/lib/seasonWindow.ts`). `trade_analysis` is event-triggered, not a
 * calendar week, so it is deliberately not in this set.
 */
const WEEKLY_CONTENT = new Set([
  "weekly_recap",
  "power_rankings",
  "waiver_wire_report",
  "bank_statement",
  "weekly_preview",
]);

/** Types whose article is written off that week's matchup results. */
const MATCHUP_DEPENDENT_CONTENT = new Set([
  "weekly_recap",
  "weekly_preview",
  "power_rankings",
  "waiver_wire_report",
  "bank_statement",
  "playoff_picture",
  "mid_season_awards",
]);

/**
 * `DEFAULT_SCHEDULES`' `season_based` triggers for these five types were
 * written against fixed NFL-week numbers (`week_9`, `weeks_12_14`,
 * `week_14`, `championship_week` -> NFL week 21 via
 * `nflSeasonBoundaries.playoffStructure`, `champion_determined` ->
 * `superBowl.end`) that only happen to be right for a 14-week regular season
 * with three single-week playoff rounds - audit finding: every real league
 * was stored as exactly that shape regardless of its actual ESPN settings
 * (`convex/lib/espnSettings.ts`'s header comment has the production
 * numbers). `scheduleSeasonAndRelativeContentCron` resolves these five
 * league-relatively via `convex/lib/leagueCalendar.ts` whenever the league's
 * synced settings support it, falling back to the old NFL-week trigger logic
 * otherwise.
 */
const LEAGUE_RELATIVE_CONTENT_TYPES = new Set([
  "mid_season_awards",
  "playoff_picture",
  "hall_of_shame",
  "championship_manifesto",
  "season_recap",
]);

/* -------------------------------------------------------------------------- *
 * Pre-generation gate vocabulary (spec §11.1)
 * -------------------------------------------------------------------------- */

/** How many matchups a single week's finality check reads. A 20-team league plays 10. */
const MAX_MATCHUPS_PER_WEEK = 40;
/** Draft transactions sampled when checking for picks and a real ADP column. */
const MAX_DRAFT_TRANSACTIONS = 60;
/** Player lookups the ADP sample may cost. `adpLooksLikePlaceholder` needs 8. */
const MAX_DRAFT_PICKS_SAMPLED = 60;

/** Every type written off a draft board. */
const DRAFT_CONTENT = new Set(["draft_rankings", "draft_strategy_guide", "mock_draft"]);
/** Draft types that GRADE picks, so a placeholder ADP column poisons the article (spec §11.1.3). */
const DRAFT_GRADED_CONTENT = new Set(["draft_rankings", "draft_strategy_guide"]);

// `requiredData` keys from `src/lib/ai/content-templates.ts`, grouped by the
// database question that answers them. Keeping the template's own vocabulary
// means a new type inherits the right gates from its `requiredData` list.
const REQUIRES_WEEK_MATCHUPS = new Set([
  "matchup_results",
  "recent_results",
  "all_matchup_results",
  "matchup_details",
]);
const REQUIRES_UPCOMING_MATCHUPS = new Set(["upcoming_matchups"]);
const REQUIRES_TEAMS = new Set([
  "team_rosters",
  "standings",
  "season_standings",
  "team_records",
  "current_records",
  "point_totals",
  "player_scores",
  "season_stats",
  "key_players",
  "finalist_teams",
  "target_team",
]);
const REQUIRES_PLAYER_POOL = new Set(["available_players"]);
const REQUIRES_DRAFT_PICKS = new Set(["draft_results"]);

/**
 * Create the automatic-by-default calendar for a freshly imported league
 * (spec section 9.1). Everything is opt-OUT: content is on, auto-publish is on,
 * approval is not required, and every schedule carries its roster writer.
 */
export const createDefaultContentSchedules = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { leagueId } = args;
    const timezone = args.timezone && args.timezone.trim().length > 0
      ? args.timezone
      : DEFAULT_TIMEZONE;

    // Check if schedules already exist
    const existingSchedules = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .collect();

    if (existingSchedules.length > 0) {
      return { success: false, message: "Content schedules already exist for this league" };
    }

    const now = Date.now();

    // Create a schedule row for every calendar entry, enabled per the table and
    // pre-assigned to the content type's default writer.
    const scheduleIds = [];
    for (const [contentType, config] of Object.entries(DEFAULT_SCHEDULES)) {
      const scheduleId = await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: contentType as any,
        enabled: config.enabled,
        timezone,
        schedule: config.schedule,
        preferredPersona: defaultPersonaFor(contentType),
        createdAt: now,
        updatedAt: now,
      });
      scheduleIds.push(scheduleId);
    }

    // League content preferences, automatic by default.
    const existingPreferences = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .first();

    if (!existingPreferences) {
      await ctx.db.insert("leagueContentPreferences", {
        leagueId,
        ...automaticDefaultPreferences(timezone),
        currentMonthSpent: 0,
        budgetResetDate: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { success: true, scheduleIds };
  },
});

/**
 * Migration (spec section 9.1). Applies the automatic defaults to every
 * preferences row the commissioner has never edited (no `preferencesTouchedAt`),
 * and replaces the stale `"analyst"`/absent persona on existing schedules with
 * the roster default. Batched: re-schedules itself until `isDone`.
 * Not wired to a cron - the owner runs it once from the dashboard.
 */
export const applyAutomaticDefaults = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{
    isDone: boolean;
    cursor: string | null;
    preferencesUpdated: number;
    schedulesUpdated: number;
  }> => {
    const numItems = args.batchSize ?? 25;
    const page = await ctx.db
      .query("leagueContentPreferences")
      .paginate({ cursor: args.cursor ?? null, numItems });

    let preferencesUpdated = 0;
    let schedulesUpdated = 0;
    const now = Date.now();

    for (const preferences of page.page) {
      // 1. Untouched preference rows get the automatic defaults. `preferencesTouchedAt`
      //    stays absent so a re-run is idempotent and a later commissioner edit
      //    still wins (updateLeagueContentPreferences stamps it).
      if (preferences.preferencesTouchedAt === undefined) {
        if (!args.dryRun) {
          await ctx.db.patch(preferences._id, {
            autoPublish: true,
            requireApproval: false,
            contentEnabled: true,
            notifyCommissioner: true,
            notifyFailures: true,
            timezone: preferences.timezone || DEFAULT_TIMEZONE,
            updatedAt: now,
          });
        }
        preferencesUpdated += 1;
      }

      // 2. Schedules still pointing at the retired "analyst" persona (or none)
      //    move to the roster default for their content type.
      const schedules = await ctx.db
        .query("contentSchedules")
        .withIndex("by_league", (q) => q.eq("leagueId", preferences.leagueId))
        .collect();

      for (const schedule of schedules) {
        // Any persona that cannot write today (the retired "analyst", chad-thunderhype,
        // mike-harrison, ...) moves to the roster default; a live writer the commissioner chose stays.
        if (isWriterSlug(schedule.preferredPersona)) continue;
        const persona = defaultPersonaFor(schedule.contentType);
        if (!args.dryRun) {
          await ctx.db.patch(schedule._id, { preferredPersona: persona, updatedAt: now });
        }
        schedulesUpdated += 1;
      }
    }

    if (!page.isDone && !args.dryRun) {
      await ctx.scheduler.runAfter(0, internal.contentScheduling.applyAutomaticDefaults, {
        cursor: page.continueCursor,
        batchSize: numItems,
      });
    }

    return {
      isDone: page.isDone,
      cursor: page.continueCursor,
      preferencesUpdated,
      schedulesUpdated,
    };
  },
});

/**
 * Fire the season kickoff article (owner directive, Sept 2026: "season
 * welcome" is repurposed to ring in every season, not just a league's first
 * one - "this can probably be repurposed... and should be included in the
 * subscription"). Billed with `userId: "system"` throughout, so
 * `aiContent.generateContentAction` charges the League Pass and nothing is
 * deducted from anyone's credits.
 *
 * Called directly from two fulfillment paths that activate the pass for a
 * season - `payments.processLeaguePayment` (a real purchase) and
 * `adminTools.compLeaguePass` (an operator comp) - which is exactly when the
 * kickoff piece should print. The season's own calendar row
 * (`DEFAULT_SCHEDULES.season_welcome`'s `season_based` "season_start"
 * trigger, via `scheduleSeasonAndRelativeContentCron`) produces this same
 * article every subsequent season without either of those callers ever
 * running again; `checkExistingContent` is what keeps the two paths from
 * ever double-firing for the same season.
 *
 * Interviews (owner ask, 2026-09-06): this is an event story, not a lookback
 * one - Sam reaches out the moment the row exists, same as a trade or the
 * draft (`COMMENT_WINDOWS_MS.season_welcome`, `convex/lib/interviewees.ts`).
 * When the league has a claimed manager, this goes through the same
 * scheduled-row path the calendar's own "season_start" trigger uses
 * (`scheduleContentGeneration`, which also queues the interview requests via
 * `contentSchedulingIntegration.onContentScheduled`), printing at now plus
 * the interview window instead of five seconds from now. A league with
 * nobody claimed yet has no one to ask, so it prints immediately - exactly
 * the fast path this function used before interviews existed.
 */
export const kickOffSeasonWelcome = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args): Promise<{ started: boolean; reason?: string }> => {
    const existing: { hasExistingContent: boolean; hasScheduledContent: boolean } = await ctx.runQuery(
      internal.contentScheduling.checkExistingContent,
      { leagueId: args.leagueId, contentType: "season_welcome", seasonId: args.seasonId },
    );
    if (existing.hasExistingContent || existing.hasScheduledContent) {
      return { started: false, reason: "season_welcome already exists or is scheduled for this season" };
    }

    // The roster's writer for this content type (spec section 9.2.3) - never
    // the retired "analyst" placeholder.
    const persona = defaultPersonaFor("season_welcome");

    const printImmediately = async (): Promise<{ started: boolean; reason?: string }> => {
      const articleId: Id<"aiContent"> = await ctx.runMutation(internal.aiContent.createScheduledArticle, {
        leagueId: args.leagueId,
        type: "season_welcome",
        persona,
        userId: "system", // Billed to the League Pass (spec §10.1); never a manager's credits.
      });

      await ctx.scheduler.runAfter(5000, internal.aiContent.generateContentAction, {
        articleId,
        leagueId: args.leagueId,
        contentType: "season_welcome",
        persona,
        userId: "system",
        seasonId: args.seasonId,
      });

      return { started: true };
    };

    // Who is around to interview, same rule `onContentScheduled` re-checks at send time
    // (convex/lib/interviewees.ts): every claimed manager, whatever the league size.
    const { targetUserIds } = await resolveInterviewees(ctx, {
      leagueId: args.leagueId,
      season: args.seasonId,
      contentType: "season_welcome",
    });
    if (targetUserIds.length === 0) {
      return await printImmediately();
    }

    const schedule = await ctx.runQuery(internal.contentScheduling.getContentScheduleByType, {
      leagueId: args.leagueId,
      contentType: "season_welcome",
    });
    if (!schedule || !schedule.enabled) {
      // No `contentSchedules` row for this league yet (an older import that predates the
      // automatic-by-default calendar), or the commissioner has switched season_welcome off on
      // the calendar - either way, `processScheduledContent` would silently cancel a row on a
      // disabled schedule (`cancelReason: "schedule_disabled"`, no notification at all), and
      // this kickoff piece has always printed unconditionally on pass activation. Fall back to
      // the immediate path rather than letting the League Pass go live with no kickoff article.
      return await printImmediately();
    }

    // The scheduled-row + interview path: `scheduleContentGeneration` inserts the
    // `scheduledContent` row and calls `contentSchedulingIntegration.onContentScheduled`, which
    // queues Sam's requests right away (season_welcome is not a lookback type - see
    // COMMENT_WINDOWS_MS's doc comment) and pushes `scheduledFor` out to now + the interview
    // window. `processScheduledContentCron`'s ordinary sweep generates the article at that time
    // with whatever comment responses came in, exactly like every other interviewed type.
    await ctx.runMutation(internal.contentScheduling.scheduleContentGeneration, {
      leagueId: args.leagueId,
      contentScheduleId: schedule._id,
      contentType: "season_welcome",
      scheduledFor: Date.now(),
      seasonId: args.seasonId,
      writerPersona: schedule.preferredPersona || persona,
      contextData: { seasonId: args.seasonId },
    });

    return { started: true };
  },
});

/**
 * Backfill missing calendar rows for a league whose `contentSchedules` were
 * seeded from an older `DEFAULT_SCHEDULES` shape (audit finding: prod's one
 * live league has no `draft_rankings` row and no `playoff_picture` row, and
 * ships several types enabled that today's defaults create disabled).
 *
 * Adds a row for every `DEFAULT_SCHEDULES` type the league has none of yet.
 * Never touches an existing row - whatever its `enabled` flag or times -
 * because the commissioner may have deliberately changed it; this only fills
 * gaps, the same "insert if absent" contract `createDefaultContentSchedules`
 * uses for a brand new league.
 *
 * Pass `leagueId` for one league; omit it to page over every league with a
 * `leagueContentPreferences` row, same batching shape as
 * `applyAutomaticDefaults`. Prod dry run:
 *   npx convex run --prod contentScheduling:reconcileDefaultContentSchedules '{"leagueId":"<id>","dryRun":true}'
 */
export const reconcileDefaultContentSchedules = internalMutation({
  args: {
    leagueId: v.optional(v.id("leagues")),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{
    added: Array<{ leagueId: Id<"leagues">; contentType: string; enabled: boolean }>;
    leaguesChecked: number;
    isDone: boolean;
    cursor: string | null;
  }> => {
    const now = Date.now();
    const added: Array<{ leagueId: Id<"leagues">; contentType: string; enabled: boolean }> = [];

    const reconcileOne = async (leagueId: Id<"leagues">, timezone: string) => {
      const existing = await ctx.db
        .query("contentSchedules")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect();
      const existingTypes = new Set(existing.map((s) => s.contentType as string));

      for (const [contentType, config] of Object.entries(DEFAULT_SCHEDULES)) {
        if (existingTypes.has(contentType)) continue;
        if (!args.dryRun) {
          await ctx.db.insert("contentSchedules", {
            leagueId,
            contentType: contentType as any,
            enabled: config.enabled,
            timezone,
            schedule: config.schedule,
            preferredPersona: defaultPersonaFor(contentType),
            createdAt: now,
            updatedAt: now,
          });
        }
        added.push({ leagueId, contentType, enabled: config.enabled });
      }
    };

    if (args.leagueId) {
      const preferences = await ctx.db
        .query("leagueContentPreferences")
        .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId as Id<"leagues">))
        .first();
      await reconcileOne(args.leagueId, preferences?.timezone || DEFAULT_TIMEZONE);
      return { added, leaguesChecked: 1, isDone: true, cursor: null };
    }

    const numItems = args.batchSize ?? 25;
    const page = await ctx.db
      .query("leagueContentPreferences")
      .paginate({ cursor: args.cursor ?? null, numItems });

    for (const preferences of page.page) {
      await reconcileOne(preferences.leagueId, preferences.timezone || DEFAULT_TIMEZONE);
    }

    if (!page.isDone && !args.dryRun) {
      await ctx.scheduler.runAfter(0, internal.contentScheduling.reconcileDefaultContentSchedules, {
        cursor: page.continueCursor,
        batchSize: numItems,
      });
    }

    return { added, leaguesChecked: page.page.length, isDone: page.isDone, cursor: page.continueCursor };
  },
});

// Get content schedules for a league
export const getContentSchedules = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { schedules: [], preferences: null };
    }
    await requireLeagueMember(ctx, args.leagueId);

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

    const schedule = await ctx.db.get(scheduleId);
    if (!schedule) {
      throw new Error("Content schedule not found");
    }
    await requireCommissioner(ctx, schedule.leagueId);

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
    // League-level language rating (owner ask, Sept 2026): how far the desk's writers can go.
    // Absent means "clean".
    languageRating: v.optional(languageRatingValidator),
    autoPublish: v.optional(v.boolean()),
    requireApproval: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireCommissioner(ctx, args.leagueId);

    const { leagueId, ...updates } = args;

    const existing = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .first();

    const now = Date.now();

    if (!existing) {
      // Create default preferences if they don't exist (upsert pattern).
      const defaultPreferences = {
        leagueId,
        ...automaticDefaultPreferences(DEFAULT_TIMEZONE),
        currentMonthSpent: 0,
        budgetResetDate: now,
        createdAt: now,
        updatedAt: now,
      };

      // Apply any provided updates to the defaults. This path is only reached
      // through a commissioner edit, so the row counts as touched.
      await ctx.db.insert("leagueContentPreferences", {
        ...defaultPreferences,
        ...updates,
        preferencesTouchedAt: now,
        updatedAt: now,
      });
    } else {
      // Update existing preferences. Stamping `preferencesTouchedAt` takes the
      // row out of scope for `applyAutomaticDefaults` from here on.
      await ctx.db.patch(existing._id, {
        ...updates,
        preferencesTouchedAt: now,
        updatedAt: now,
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
    // Stamped top-level so the idempotency index can see them; re-stamped at
    // execution by processScheduledContent.
    week: v.optional(v.number()),
    seasonId: v.optional(v.number()),
    // Dedupe key for event-triggered rows.
    eventKey: v.optional(v.string()),
    // The writer this article is destined for, forwarded to comment requests.
    writerPersona: v.optional(v.string()),
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
      week: args.week ?? args.contextData?.week,
      seasonId: args.seasonId ?? args.contextData?.seasonId,
      eventKey: args.eventKey,
      deferrals: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Kick off comment request integration for this scheduled content
    try {
      await ctx.runMutation(internal.contentSchedulingIntegration.onContentScheduled, {
        scheduledContentId,
        leagueId: args.leagueId,
        contentType: args.contentType,
        scheduledTime: args.scheduledFor,
        writerPersona: args.writerPersona ?? defaultPersonaFor(args.contentType),
      });
    } catch (e) {
      console.warn("Failed to trigger content scheduling integration (comments)", e);
    }

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

    // A deferred or retried row keeps its original `scheduledFor` (in the past),
    // so `nextRetryAt` is what actually holds it back until its cooldown is up.
    const pending = await ctx.db
      .query("scheduledContent")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .filter((q) =>
        q.and(
          q.lte(q.field("scheduledFor"), beforeTime),
          q.or(
            q.eq(q.field("nextRetryAt"), undefined),
            q.lte(q.field("nextRetryAt"), beforeTime),
          ),
        ),
      )
      .take(limit);

    // Season backfill rows (convex/seasonBackfill.ts) are driven directly by
    // that tool's own chain, never by this cron queue.
    return pending.filter((row) => !row.backfill);
  },
});

/**
 * Execute one scheduled row (spec section 9.2, items 3/4/6/7).
 *
 * Order: preference/season gates -> re-stamp the target period -> ensure the
 * league's ESPN data is fresh enough to write about -> credit gate -> generate.
 * `attempts` is only spent once we actually hand off to generation; deferrals
 * for stale data are counted separately so a quiet ESPN afternoon does not burn
 * the retry budget.
 */
export const processScheduledContent = internalAction({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    // --- Dev end-to-end tool hooks (spec §11.3.12) ----------------------
    // `devTools.runScheduledPipelineNow` needs the EXACT path below, not a
    // copy of it, so the three things it has to change are parameters rather
    // than a second implementation: write about a named period instead of
    // re-reading the clock, never hand the article to the batch API, and run
    // generation inline so the caller can wait for the article.
    forcePeriod: v.optional(v.object({ seasonId: v.number(), week: v.number() })),
    disableBatching: v.optional(v.boolean()),
    awaitGeneration: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ success: boolean; message?: string; contentId?: string; willRetry?: boolean; deferred?: boolean }> => {
    const scheduledContent = await ctx.runQuery(internal.contentScheduling.getScheduledContentById, {
      scheduledContentId: args.scheduledContentId,
    });

    if (!scheduledContent) {
      throw new Error("Scheduled content not found");
    }

    if (scheduledContent.status !== "pending") {
      return { success: false, message: "Content is not in pending status" };
    }

    const contentType = scheduledContent.contentType;
    const leagueId = scheduledContent.leagueId;

    // Claim the row. `attempts` is bumped later, immediately before generation.
    await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
      scheduledContentId: args.scheduledContentId,
      status: "generating",
      lastAttemptAt: Date.now(),
    });

    const cancel = async (reason: string, message: string) => {
      await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
        scheduledContentId: args.scheduledContentId,
        status: "cancelled",
        errorMessage: message,
        cancelReason: reason,
      });
    };

    try {
      // Get the content schedule configuration
      const contentSchedule = await ctx.runQuery(internal.contentScheduling.getContentScheduleById, {
        contentScheduleId: scheduledContent.contentScheduleId,
      });

      if (!contentSchedule || !contentSchedule.enabled) {
        await cancel("schedule_disabled", "Content schedule is disabled");
        return { success: false, message: "Content schedule is disabled" };
      }

      // Check league preferences
      const preferences = await ctx.runQuery(internal.contentScheduling.getLeaguePreferences, {
        leagueId,
      });

      if (!preferences?.contentEnabled) {
        await cancel("content_disabled", "League content generation is disabled");
        return { success: false, message: "League content generation is disabled" };
      }

      // Check monthly budget if set
      if (preferences.monthlyContentBudget && preferences.currentMonthSpent >= preferences.monthlyContentBudget) {
        await cancel("budget_exceeded", "Monthly content budget exceeded");
        return { success: false, message: "Monthly content budget exceeded" };
      }

      // Validate content generation is allowed based on NFL season boundaries. The check reads the
      // calendar, so a forced historical period (dev end-to-end runs only; production never sets
      // `forcePeriod`) skips it — the week being generated is not the week on the wall clock.
      try {
        const validationResult = args.forcePeriod
          ? { allowed: true as const, reason: `forced period ${args.forcePeriod.seasonId} week ${args.forcePeriod.week}` }
          : await ctx.runQuery(internal.nflSeasonBoundaries.isContentGenerationAllowed, {
              contentType,
              leagueId,
              date: Date.now(),
            });

        if (!validationResult.allowed) {
          await cancel("season_boundary", `Content generation not allowed: ${validationResult.reason}`);
          return { success: false, message: `Content generation not allowed: ${validationResult.reason}` };
        }
      } catch (error) {
        console.warn("Season boundary validation failed, proceeding with content generation:", error);
        // Continue with generation if validation fails (graceful degradation)
      }

      const league = await ctx.runQuery(internal.contentScheduling.getLeagueById, { leagueId });
      if (!league) {
        await cancel("league_missing", "League not found");
        return { success: false, message: "League not found" };
      }

      // ESPN connection gate (owner directive, Sept 2026): "with no valid
      // private token we should pause all content generation and file a
      // backlog." A private league whose stored cookies ESPN rejects cannot
      // have its data refreshed, so writing about it now would be a
      // confidently wrong article - hold the row instead, before it spends an
      // attempt or a credit. Freshness-exempt types never read live league
      // data, so they are unaffected and generate on schedule.
      if (!FRESHNESS_EXEMPT_CONTENT.has(contentType) && espnConnectionBlocked(league)) {
        return await backlogForBlockedConnection(ctx, args.scheduledContentId, scheduledContent);
      }

      // (a) Re-stamp week/season at execution time so the article is about the
      //     period that is actually current, not the one the cron guessed a day
      //     earlier, and so the idempotency index reflects reality.
      const currentWeek = await getCurrentNFLWeek(ctx);
      // Before kickoff the NFL clock reads week 0; the one row that legitimately runs then is the
      // week-1 preview (scheduleWeekOnePreview stamps it week 1), so keep the row's own week.
      const targetWeek = args.forcePeriod
        ? args.forcePeriod.week
        : currentWeek < 1 && contentType === "weekly_preview" && scheduledContent.week === 1
          ? 1
          : resolveTargetWeek(contentType, currentWeek);
      const seasonId =
        args.forcePeriod?.seasonId ??
        league.espnData?.seasonId ??
        scheduledContent.contextData?.seasonId ??
        nflSeasonYearFor();

      await ctx.runMutation(internal.contentScheduling.stampExecutionPeriod, {
        scheduledContentId: args.scheduledContentId,
        week: targetWeek,
        seasonId,
      });

      // (a2) Weekly programming only prints during the league's own season
      //      (owner directive, Sept 2026). A forced period (dev end-to-end
      //      tool only) is deliberately about a period other than "now", so
      //      it skips this - the same reason it skips the NFL-calendar
      //      validation above. No commissioner notification: an off-season
      //      row is expected, not a failure.
      if (!args.forcePeriod && WEEKLY_CONTENT.has(contentType)) {
        const leagueSeasonDoc = await ctx.runQuery(internal.contentScheduling.getLeagueSeasonDoc, {
          leagueId,
          seasonId,
        });
        const inSeason = weeklyTargetWeekInSeason({
          contentType,
          targetWeek,
          seasonEndWeek: resolveSeasonEndWeek(leagueSeasonDoc?.settings),
        });
        if (!inSeason.inSeason) {
          await cancel("out_of_season", `Not scheduling ${contentType}: ${inSeason.reason}`);
          return { success: false, message: `Not in season: ${inSeason.reason}` };
        }
      }

      // A historical period (season backfill, convex/seasonBackfill.ts) is
      // never going to become "more synced" by re-running a CURRENT-season
      // ESPN sync - that sync cannot fetch a past season's data at all, so
      // both re-sync attempts below are pure waste for one. The reads that
      // follow (matchup/finality/completeness checks) still run as normal:
      // they confirm the historical data that should already be there.
      const isHistoricalPeriod =
        args.forcePeriod !== undefined && args.forcePeriod.seasonId < leagueCurrentSeason(league);

      // (b) Fresh data. Stale league data produces a confidently wrong article,
      //     which is worse than a late one - so sync first, and defer if the
      //     week we are writing about still has no matchups.
      let syncedThisPass = false;
      if (!FRESHNESS_EXEMPT_CONTENT.has(contentType)) {
        const lastSyncedAt = league.espnData?.lastSyncedAt ?? 0;

        if (isHistoricalPeriod) {
          console.log(`Scheduled content ${args.scheduledContentId}: historical period; not syncing`);
        } else if (Date.now() - lastSyncedAt > SIX_HOURS_MS) {
          console.log(`League ${leagueId} ESPN data is stale (last synced ${new Date(lastSyncedAt).toISOString()}); syncing before generation`);
          try {
            // NOTE: espnSync exposes no per-league internal current-season
            // action; syncAllLeaguesCurrentSeason is the only internal entry
            // point, and it refreshes this league along with the rest.
            await ctx.runAction(internal.espnSync.syncAllLeaguesCurrentSeason, {});
            syncedThisPass = true;
          } catch (error) {
            console.warn("ESPN sync failed before scheduled generation:", error);
            // The sync itself may have just flipped credentialStatus to
            // "invalid" (that is how a rejected cookie is normally
            // discovered) - re-read the league before deciding whether this
            // is an ordinary transient failure (defer) or a now-confirmed
            // bad connection (backlog, so this row stops burning deferrals).
            const refreshedLeague = await ctx.runQuery(internal.contentScheduling.getLeagueById, { leagueId });
            if (espnConnectionBlocked(refreshedLeague)) {
              return await backlogForBlockedConnection(ctx, args.scheduledContentId, scheduledContent);
            }
            return await deferForData(ctx, args.scheduledContentId, scheduledContent, "espn_sync_failed");
          }
        }

        if (MATCHUP_DEPENDENT_CONTENT.has(contentType)) {
          const hasMatchups = await ctx.runQuery(internal.contentScheduling.hasMatchupsForWeek, {
            leagueId,
            seasonId,
            week: targetWeek,
          });
          if (!hasMatchups) {
            return await deferForData(ctx, args.scheduledContentId, scheduledContent, `no_matchups_week_${targetWeek}`);
          }
        }
      }

      // (b2) Week finality (spec §11.1.1). A recap, ranking, award or hall of
      //      shame is a claim about a finished week. Monday night settles late;
      //      the Tuesday 09:00 slot does not get to guess. Deferring costs 30
      //      minutes and the deferral budget is separate from `attempts`, so a
      //      long Monday night never burns a retry.
      if (LOOKBACK_CONTENT.has(contentType) && !FRESHNESS_EXEMPT_CONTENT.has(contentType)) {
        const finality = await ctx.runQuery(internal.contentScheduling.isWeekFinal, {
          leagueId,
          seasonId,
          week: targetWeek,
        });
        if (!finality.final) {
          console.log(
            `Week ${targetWeek} is not final for league ${leagueId}: ` +
              `${finality.unfinished}/${finality.matchups} matchup(s) unsettled (${finality.reason})`,
          );
          return await deferForData(
            ctx,
            args.scheduledContentId,
            scheduledContent,
            "week_not_final",
          );
        }
      }

      // (b3) Data completeness (spec §11.1.2, §11.1.3). The type's core inputs
      //      must actually be in the database. A missing one earns exactly one
      //      sync before the row is deferred: if this pass has not already
      //      synced, sync now and re-ask, because a gap that a sync closes
      //      should not cost the league half an hour.
      let completeness = await ctx.runQuery(internal.contentScheduling.checkDataCompleteness, {
        leagueId,
        contentType,
        seasonId,
        week: targetWeek,
      });

      // "Re-syncs once" is per row, not per pass: a row that has already been
      // deferred for data has already had its sync, and re-running a full
      // all-leagues sync on every 30-minute retry would cost far more than the
      // article is worth. A historical period skips this the same way it
      // skipped the freshness sync above - see the comment on
      // `isHistoricalPeriod`.
      if (!completeness.complete && isHistoricalPeriod) {
        console.log(`Scheduled content ${args.scheduledContentId}: historical period; not syncing`);
      } else if (!completeness.complete && !syncedThisPass && (scheduledContent.deferrals ?? 0) === 0) {
        console.log(
          `Missing core data for ${contentType} (${completeness.missing.join(", ")}); syncing once before deferring`,
        );
        try {
          await ctx.runAction(internal.espnSync.syncAllLeaguesCurrentSeason, {});
          syncedThisPass = true;
          completeness = await ctx.runQuery(internal.contentScheduling.checkDataCompleteness, {
            leagueId,
            contentType,
            seasonId,
            week: targetWeek,
          });
        } catch (error) {
          console.warn("ESPN sync failed while chasing missing core data:", error);
          // Same reasoning as the freshness sync above: this sync may be the
          // thing that just discovered the cookies are rejected.
          const refreshedLeague = await ctx.runQuery(internal.contentScheduling.getLeagueById, { leagueId });
          if (espnConnectionBlocked(refreshedLeague)) {
            return await backlogForBlockedConnection(ctx, args.scheduledContentId, scheduledContent);
          }
        }
      }

      if (!completeness.complete) {
        return await deferForData(
          ctx,
          args.scheduledContentId,
          scheduledContent,
          `data_incomplete:${completeness.missing.join(",")}`,
        );
      }

      // (c) League Pass (spec §10.1). Automated content is covered by the pass
      //     and never touches anyone's credits - this used to charge the
      //     commissioner per story, which is exactly the bill the pass exists
      //     to replace. What is checked instead is that the pass is live.
      if (!hasActivePass(league)) {
        await cancel(
          "no_pass",
          `League Pass is not active for ${league.name}; automated content is paused`,
        );
        // A backfill row must never spam the commissioner (owner directive,
        // Sept 2026: "zero notifications or emails" for the backfill) - the
        // tool that scheduled it is what surfaces a lapsed pass to whoever
        // ran it.
        if (!scheduledContent.backfill) {
          await ctx.runMutation(internal.contentScheduling.notifyScheduleOutcome, {
            leagueId,
            outcome: "no_pass",
            contentType,
            week: targetWeek,
          });
        }
        return { success: false, message: "League Pass is not active" };
      }

      // (c2) Spend cap (spec §10.1). A safety valve on measured API cost, not a
      //      product limit: a normal 12-manager season lands near $16. Hitting
      //      it means something is wrong, so automation stops and both the
      //      commissioner and the operator hear about it.
      const capUsd = automationSpendCapUsd();
      const spend = await ctx.runQuery(internal.deskMetrics.getLeagueSeasonSpend, {
        leagueId,
        seasonId: passSeasonId(league),
      });
      const coveredUsd = spend.automatedUsd + spend.interviewUsd;

      if (coveredUsd >= capUsd) {
        const detail =
          `Automated spend for ${league.name} reached $${coveredUsd.toFixed(2)} of the ` +
          `$${capUsd.toFixed(2)} season cap (articles $${spend.automatedUsd.toFixed(2)}, ` +
          `interviews $${spend.interviewUsd.toFixed(2)})`;
        await cancel("spend_cap", detail);
        // Same backfill rule as `no_pass` above; `alertOperator` below stays
        // unconditional - hitting the season spend cap is a real problem
        // whether or not a backfill row is what tipped it over.
        if (!scheduledContent.backfill) {
          await ctx.runMutation(internal.contentScheduling.notifyScheduleOutcome, {
            leagueId,
            outcome: "spend_cap",
            contentType,
            week: targetWeek,
            spentUsd: coveredUsd,
            capUsd,
          });
        }
        await alertOperator(
          ctx,
          `FFSN automation paused: league ${leagueId} hit the spend cap`,
          `${detail}.\n\nThe ${contentType} scheduled for week ${targetWeek} was cancelled. ` +
            `Raise AUTOMATION_SPEND_CAP_USD or investigate before automation resumes.`,
        );
        return { success: false, message: "Automated spend cap reached" };
      }

      // (d) Persona: the schedule's writer, else the roster default. Never "analyst".
      const persona = resolveWriterPersona(contentSchedule.preferredPersona, contentType);

      // (e) Batch API (spec §10.3.5). When print is still comfortably ahead,
      //     hand this article to the Message Batches API at print - 3h instead
      //     of generating now: batch is billed at 50%. The row stays `pending`
      //     until aiBatch accepts the submission (it sets `batched`), so if the
      //     submission never happens the ordinary due-now pass generates it
      //     directly at print time. That is the fallback, and it is the reason
      //     nothing here is destructive.
      const msUntilPrint = scheduledContent.scheduledFor - Date.now();
      if (!args.disableBatching && batchScheduledGenerationEnabled() && msUntilPrint >= TWO_HOURS_MS) {
        const submitAt = Math.max(Date.now(), scheduledContent.scheduledFor - THREE_HOURS_MS);
        const submitted = await scheduleBatchSubmission(ctx, args.scheduledContentId, submitAt);
        if (submitted) {
          return {
            success: true,
            message: `Batch submission scheduled for ${new Date(submitAt).toISOString()}`,
          };
        }
        // Falls through to direct generation when the scheduler refused the
        // job. The row is back to `pending` either way, and re-claimed below.
      }

      // Spend an attempt now that everything is in place.
      await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
        scheduledContentId: args.scheduledContentId,
        status: "generating",
        attempts: scheduledContent.attempts + 1,
        lastAttemptAt: Date.now(),
      });

      // Create the content article first
      const articleId = await ctx.runMutation(internal.aiContent.createScheduledArticle, {
        leagueId,
        type: contentType,
        persona,
        userId: "system", // System-generated
      });

      // Schedule the content generation (include scheduling context and scheduledContentId)
      const generationArgs = {
        articleId,
        leagueId,
        contentType,
        persona,
        userId: "system",
        customContext: scheduledContent.contextData ? JSON.stringify(scheduledContent.contextData) : undefined,
        seasonId,
        week: targetWeek,
        scheduledContentId: args.scheduledContentId,
      };

      if (args.awaitGeneration) {
        // The dev end-to-end tool (spec §11.3.12) needs the generation to have
        // started before this returns, so it runs inline rather than through
        // the scheduler. The prepared content types still chain a scheduled
        // step of their own, which is why the tool polls the article rather
        // than trusting this to have finished.
        await ctx.runAction(internal.aiContent.generateContentAction, generationArgs);
      } else {
        await ctx.scheduler.runAfter(0, internal.aiContent.generateContentAction, generationArgs);
      }

      // Leave status as generating; final status will be updated by the generation action
      return { success: true, contentId: articleId };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

      // Check if we should retry
      const shouldRetry = scheduledContent.attempts < scheduledContent.maxAttempts;
      const nextRetryAt = shouldRetry ? Date.now() + THIRTY_MINUTES_MS : undefined;

      await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
        scheduledContentId: args.scheduledContentId,
        status: shouldRetry ? "pending" : "failed",
        errorMessage,
        nextRetryAt,
      });

      // A backfill row's failure is the backfill tool's business, not the
      // commissioner's (owner directive, Sept 2026: zero notifications from
      // the backfill).
      if (!shouldRetry && !scheduledContent.backfill) {
        await ctx.runMutation(internal.contentScheduling.notifyScheduleOutcome, {
          leagueId,
          outcome: "failed",
          contentType,
          week: scheduledContent.week,
          errorMessage,
        });
      }

      return { success: false, message: errorMessage, willRetry: shouldRetry };
    }
  },
});

/* -------------------------------------------------------------------------- *
 * Operator alerting and the Batch API hand-off (spec §10.1, §10.3.5)
 * -------------------------------------------------------------------------- */

/**
 * Tell whoever runs this deployment that something needs a human.
 *
 * `ADMIN_ALERT_EMAIL` is a Convex env var. When it is not set - which is the
 * normal case in development - this logs at error level instead, so the signal
 * still lands somewhere rather than being silently dropped. A failure to send
 * never fails the caller: the commissioner has already been notified through
 * the normal path by the time this runs.
 */
async function alertOperator(ctx: ActionCtx, subject: string, text: string): Promise<boolean> {
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) {
    console.error(`[operator alert] ${subject}: ${text}`);
    return false;
  }
  try {
    const result = await ctx.runAction(internal.emailService.sendPlainEmail, {
      to,
      subject,
      text,
      fromName: "FFSN Desk",
      relatedEntityType: "operator_alert",
    });
    if (!result.success) {
      console.error(`[operator alert] send failed (${result.error}): ${subject}: ${text}`);
    }
    return result.success;
  } catch (error) {
    console.error(`[operator alert] send threw for "${subject}"`, error);
    return false;
  }
}

/**
 * Convex env `BATCH_SCHEDULED_GENERATION`: on unless it is explicitly turned
 * off (spec §10.3.5).
 *
 * This deliberately mirrors `aiBatch.isBatchingEnabled`, which is the
 * authoritative check and re-runs at submission time. It cannot be imported:
 * `aiBatch.ts` is a "use node" module and this file runs in the V8 isolate.
 * The copy only decides whether the lookahead below bothers looking.
 */
export function batchScheduledGenerationEnabled(): boolean {
  const raw = process.env.BATCH_SCHEDULED_GENERATION;
  if (raw === undefined || raw.trim() === "") return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/**
 * Queue the batch submission for one row at `submitAt` (print - 3h).
 *
 * Returns false when the submission could not be queued, which tells the
 * caller to generate directly instead. `batchSubmittedAt` is stamped so a
 * later lookahead pass does not queue a second submission for the same
 * article; `aiBatch` re-stamps it with the real submission time.
 *
 * Nothing here is destructive by design: a submission that is queued but never
 * lands leaves the row `pending`, and the ordinary due-now pass writes the
 * article directly at print time.
 */
async function scheduleBatchSubmission(
  ctx: ActionCtx,
  scheduledContentId: Id<"scheduledContent">,
  submitAt: number,
): Promise<boolean> {
  try {
    // Release the claim first: `aiBatch.submitScheduledArticle` refuses a row
    // that is not `pending`, and with `submitAt` in the past it can start as
    // soon as this action yields.
    await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
      scheduledContentId,
      status: "pending",
    });
    await ctx.runMutation(internal.contentScheduling.markBatchSubmissionScheduled, {
      scheduledContentId,
      submitAt,
    });
    await ctx.scheduler.runAt(submitAt, internal.aiBatch.submitScheduledArticle, {
      scheduledContentId,
    });
    return true;
  } catch (error) {
    console.warn("Could not schedule the batch submission; generating directly instead", error);
    return false;
  }
}

/** The subset of a `scheduledContent` doc `deferForData`/`backlogForBlockedConnection` need. */
type DeferrableScheduledContent = {
  deferrals?: number;
  contentType: string;
  leagueId: Id<"leagues">;
  week?: number;
  /** Season backfill row (convex/seasonBackfill.ts) - see the notify guard below. */
  backfill?: boolean;
};

/**
 * Push a row out by 30 minutes because the league data it needs is not there
 * yet. After MAX_DEFERRALS the row fails rather than deferring forever.
 */
async function deferForData(
  ctx: any,
  scheduledContentId: Id<"scheduledContent">,
  scheduledContent: DeferrableScheduledContent,
  reason: string,
): Promise<{ success: boolean; message: string; deferred: boolean; willRetry: boolean }> {
  const deferrals = (scheduledContent.deferrals ?? 0) + 1;
  const exhausted = deferrals >= MAX_DEFERRALS;

  await ctx.runMutation(internal.contentScheduling.recordDeferral, {
    scheduledContentId,
    deferrals,
    reason,
    exhausted,
  });

  // A backfill row that never gets its data is the backfill tool's problem to
  // surface, not the commissioner's (owner directive, Sept 2026: zero
  // notifications or emails from the backfill) - the tool reads `deferred`/
  // `willRetry` on the return value below and cancels the row itself.
  if (exhausted && !scheduledContent.backfill) {
    await ctx.runMutation(internal.contentScheduling.notifyScheduleOutcome, {
      leagueId: scheduledContent.leagueId,
      outcome: "failed",
      contentType: scheduledContent.contentType,
      week: scheduledContent.week,
      errorMessage: `League data never became available (${reason})`,
    });
  }

  console.log(`Deferring scheduled content ${scheduledContentId} (${reason}), deferral ${deferrals}/${MAX_DEFERRALS}`);
  return {
    success: false,
    message: `Deferred: ${reason}`,
    deferred: true,
    willRetry: !exhausted,
  };
}

/**
 * Hold a row for a broken ESPN connection instead of failing or deferring it
 * (owner directive, Sept 2026). Unlike a plain `deferForData` call, this does
 * not spend a deferral or an attempt - the row is not stuck waiting on data
 * that will show up on its own, it is waiting on the commissioner to fix the
 * connection, and `resumeBacklog` is what brings it back once that happens.
 *
 * A backfill row is the one exception: it must never sit in `backlogged`
 * (owner directive, Sept 2026 - the backfill must produce zero notifications,
 * and nothing resumes a backlogged row but `resumeBacklog`, which the
 * backfill tool never calls). Defer it instead; the tool reads `deferred:
 * true` off the return value and cancels the row itself.
 */
async function backlogForBlockedConnection(
  ctx: ActionCtx,
  scheduledContentId: Id<"scheduledContent">,
  scheduledContent: DeferrableScheduledContent,
): Promise<{ success: boolean; message: string; deferred?: boolean; willRetry?: boolean }> {
  if (scheduledContent.backfill) {
    return await deferForData(ctx, scheduledContentId, scheduledContent, "espn_connection_blocked");
  }

  const message =
    "ESPN rejected this league's cookies, so the desk can't read fresh data. " +
    "This story is on hold and will generate automatically once the commissioner fixes the ESPN connection.";

  await ctx.runMutation(internal.contentScheduling.backlogScheduledContent, {
    scheduledContentId,
    errorMessage: message,
  });

  console.log(
    `Backlogging scheduled content ${scheduledContentId} (${scheduledContent.contentType}) for league ${scheduledContent.leagueId}: ESPN connection blocked`,
  );

  return { success: false, message };
}

/** Move one row to `backlogged` (see `backlogForBlockedConnection`). */
export const backlogScheduledContent = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledContentId);
    if (!row) return;

    await ctx.db.patch(args.scheduledContentId, {
      status: "backlogged",
      backlogReason: "espn_credentials_invalid",
      backloggedAt: Date.now(),
      errorMessage: args.errorMessage,
      updatedAt: Date.now(),
    });
  },
});

/** Stamp the execution-time period on the row and mirror it into contextData. */
export const stampExecutionPeriod = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    week: v.number(),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledContentId);
    if (!row) return;

    await ctx.db.patch(args.scheduledContentId, {
      week: args.week,
      seasonId: args.seasonId,
      contextData: {
        ...(row.contextData ?? {}),
        week: args.week,
        seasonId: args.seasonId,
      },
      updatedAt: Date.now(),
    });
  },
});

/** Record one data deferral (or fail the row once the budget is spent). */
export const recordDeferral = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    deferrals: v.number(),
    reason: v.string(),
    exhausted: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.scheduledContentId, {
      status: args.exhausted ? "failed" : "pending",
      deferrals: args.deferrals,
      nextRetryAt: args.exhausted ? undefined : Date.now() + THIRTY_MINUTES_MS,
      errorMessage: `Waiting on league data: ${args.reason}`,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Sweeper (spec section 9.2.5). A row left in `generating` for more than two
 * hours means the generation action died without ever reporting back; put it
 * back in the queue, or fail it if it is out of attempts.
 */
export const reclaimStuckGenerations = internalMutation({
  args: {
    olderThanMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ reclaimed: number; failed: number }> => {
    const cutoff = Date.now() - (args.olderThanMs ?? TWO_HOURS_MS);
    const stuckRows = await ctx.db
      .query("scheduledContent")
      .withIndex("by_status", (q) => q.eq("status", "generating"))
      .take(args.limit ?? 50);

    // Season backfill rows (convex/seasonBackfill.ts) are driven directly by
    // that tool, which watches its own generation rather than leaving a row
    // in `generating` for this sweeper to find.
    const stuck = stuckRows.filter((row) => !row.backfill);

    let reclaimed = 0;
    let failed = 0;

    for (const row of stuck) {
      const startedAt = row.lastAttemptAt ?? row.updatedAt ?? row._creationTime;
      if (startedAt > cutoff) continue;

      const attempts = row.attempts + 1;
      if (attempts >= row.maxAttempts) {
        await ctx.db.patch(row._id, {
          status: "failed",
          attempts,
          errorMessage: "Generation stalled and exhausted its retries",
          updatedAt: Date.now(),
        });
        failed += 1;
        await ctx.runMutation(internal.contentScheduling.notifyScheduleOutcome, {
          leagueId: row.leagueId,
          outcome: "failed",
          contentType: row.contentType,
          week: row.week,
          errorMessage: "Generation stalled and exhausted its retries",
        });
      } else {
        await ctx.db.patch(row._id, {
          status: "pending",
          attempts,
          nextRetryAt: Date.now(),
          errorMessage: "Generation stalled; requeued by the sweeper",
          updatedAt: Date.now(),
        });
        reclaimed += 1;
      }
    }

    return { reclaimed, failed };
  },
});

/* -------------------------------------------------------------------------- *
 * ESPN connection lifecycle (owner directive, Sept 2026): pause automated
 * content while a private league's cookies are rejected, file a backlog
 * instead of failing it, and resume in order once the connection is fixed.
 * Called by the credential-status transition (`leagues.setEspnCredentialStatus`
 * and friends) with `{ leagueId }` - not by anything in this file.
 * -------------------------------------------------------------------------- */

/** A resumed row is staggered this far apart so the spend cap and rate limits see a trickle, not a burst. */
const RESUME_STAGGER_MS = 3 * 60 * 1000;
/** A resumed row this old skips its interview window - the week it would have covered has already passed. */
const SKIP_COMMENT_REQUESTS_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Move every `backlogged` row for a league back to `pending`, oldest original
 * `scheduledFor` first, staggered `RESUME_STAGGER_MS` apart. A row whose
 * original print time is more than 48h in the past resumes with
 * `skipCommentRequests: true` - reaching out for comment on a week-old story
 * is exactly what the owner's directive rules out.
 *
 * Shared by `resumeBacklog` and `onEspnCredentialsRestored` as a plain helper
 * (not a nested `ctx.runMutation`) so both run as one transaction with
 * whatever else the caller patches (e.g. clearing `contentPausedAt`).
 */
async function resumeBacklogForLeague(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
): Promise<{ resumed: number; withoutInterviews: number }> {
  const rows = await ctx.db
    .query("scheduledContent")
    .withIndex("by_league_status", (q) => q.eq("leagueId", leagueId).eq("status", "backlogged"))
    .take(500);

  rows.sort((a, b) => a.scheduledFor - b.scheduledFor);

  const now = Date.now();
  let withoutInterviews = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const skipCommentRequests = now - row.scheduledFor > SKIP_COMMENT_REQUESTS_AFTER_MS;
    if (skipCommentRequests) withoutInterviews += 1;

    await ctx.db.patch(row._id, {
      status: "pending",
      resumedAt: now,
      nextRetryAt: undefined,
      scheduledFor: now + i * RESUME_STAGGER_MS,
      skipCommentRequests,
      updatedAt: now,
    });
  }

  return { resumed: rows.length, withoutInterviews };
}

/**
 * Called when a league's ESPN credentials transition to invalid. Stamps
 * `espnData.contentPausedAt` (once - a second call while already paused is a
 * no-op on that field) and tells the commissioner. Does not itself touch any
 * `scheduledContent` row: the scheduler gate in `processScheduledContent`
 * backlogs each one the moment it is next due, so a row already `pending`
 * simply becomes `backlogged` on its own next pass.
 */
export const onEspnCredentialsInvalid = internalMutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<{ pausedNow: boolean; waiting: number }> => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) return { pausedNow: false, waiting: 0 };

    const pausedNow = !league.espnData?.contentPausedAt;
    if (pausedNow && league.espnData) {
      await ctx.db.patch(args.leagueId, {
        espnData: {
          ...league.espnData,
          contentPausedAt: Date.now(),
        },
      });
    }

    const [pending, backlogged] = await Promise.all([
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league_status", (q) => q.eq("leagueId", args.leagueId).eq("status", "pending"))
        .take(500),
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league_status", (q) => q.eq("leagueId", args.leagueId).eq("status", "backlogged"))
        .take(500),
    ]);
    const waiting = pending.length + backlogged.length;

    await ctx.runMutation(internal.contentScheduling.notifyScheduleOutcome, {
      leagueId: args.leagueId,
      outcome: "espn_paused",
      contentType: "espn_connection",
      waiting,
    });

    return { pausedNow, waiting };
  },
});

/**
 * Called when a league's ESPN credentials transition back to valid. Clears
 * `espnData.contentPausedAt`, resumes every backlogged row (see
 * `resumeBacklogForLeague`), and tells the commissioner - all in one
 * transaction.
 */
export const onEspnCredentialsRestored = internalMutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<{ resumed: number; withoutInterviews: number }> => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) return { resumed: 0, withoutInterviews: 0 };

    if (league.espnData?.contentPausedAt) {
      await ctx.db.patch(args.leagueId, {
        espnData: {
          ...league.espnData,
          contentPausedAt: undefined,
        },
      });
    }

    const { resumed, withoutInterviews } = await resumeBacklogForLeague(ctx, args.leagueId);

    if (resumed > 0) {
      await ctx.runMutation(internal.contentScheduling.notifyScheduleOutcome, {
        leagueId: args.leagueId,
        outcome: "espn_restored",
        contentType: "espn_connection",
        resumed,
        withoutInterviews,
      });
    }

    return { resumed, withoutInterviews };
  },
});

/**
 * Public wrapper around `resumeBacklogForLeague` for callers that only need
 * the resume (e.g. a manual "retry now" from an operator tool) without the
 * pause/restore bookkeeping `onEspnCredentialsRestored` also does.
 */
export const resumeBacklog = internalMutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<{ resumed: number; withoutInterviews: number }> => {
    return await resumeBacklogForLeague(ctx, args.leagueId);
  },
});

/**
 * Resolves an NFL `week` number to the ESPN matchup period id the `matchups`
 * table's `matchupPeriod` column actually stores (audit fix: a multi-week
 * playoff round is stored under its OWN period id - e.g. period `16` holds
 * NFL weeks 17-18 in a 2-week-round league - so querying `matchupPeriod` by
 * the raw NFL week number finds nothing for any week inside a multi-week
 * round). Uses `weekToMatchupPeriod` (`convex/lib/espnSettings.ts`) against
 * this season's synced `matchupPeriods` map; falls back to `week` itself (the
 * historic 1:1 assumption) when the league has no map synced yet.
 */
async function resolveMatchupPeriodForWeek(
  ctx: { db: QueryCtx["db"] },
  leagueId: Id<"leagues">,
  seasonId: number,
  week: number,
): Promise<number> {
  const leagueSeason = await ctx.db
    .query("leagueSeasons")
    .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .first();
  const matchupPeriods = (leagueSeason?.settings as { matchupPeriods?: Record<string, number[]> } | undefined)
    ?.matchupPeriods;
  return weekToMatchupPeriod(matchupPeriods, week) ?? week;
}

/**
 * True when the league has at least one REAL matchup row for the target week - a round-one bye
 * (`isByeMatchup`; see `convex/lib/playoffs.ts`'s header comment) doesn't count, so a week that is
 * only byes reads as having no matchups rather than tricking a caller that took just the first row
 * into thinking the week is covered.
 */
export const hasMatchupsForWeek = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    week: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const matchupPeriod = await resolveMatchupPeriodForWeek(ctx, args.leagueId, args.seasonId, args.week);
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_period", (q) =>
        q.eq("leagueId", args.leagueId).eq("matchupPeriod", matchupPeriod),
      )
      .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
      .take(MAX_MATCHUPS_PER_WEEK);

    return matchups.some((matchup) => !isByeMatchup(matchup));
  },
});

/* -------------------------------------------------------------------------- *
 * Pre-generation quality gates (spec §11.1)
 * -------------------------------------------------------------------------- */

/**
 * Week finality (spec §11.1.1).
 *
 * A lookback story is only true once the week it looks back on is over. The
 * test is per matchup, not per league: ESPN sets `winner` as each game settles,
 * so a Monday-night game that has not been scored leaves exactly one row
 * unfinished - and that is the row a Tuesday 09:00 recap would get wrong.
 *
 * Two ways a matchup counts as finished:
 *   1. `winner` is set. This is the authoritative signal and needs no clock.
 *   2. Both sides scored and the scoring period's window has closed. ESPN
 *      occasionally leaves `winner` unset on a settled week; the week boundary
 *      from `nflSeasons.weekBoundaries` is what makes that safe to assume.
 *      With no boundary row for the season we fall back to requiring `winner`,
 *      which errs towards a late article rather than a wrong one.
 *
 * A week with no matchups at all is NOT final - there is nothing to be final
 * about, and the caller should defer for data rather than publish an empty
 * recap. `matchupPeriod` is the column, matching `hasMatchupsForWeek`.
 *
 * A round-one bye (`isByeMatchup`) is dropped before any of the above: it has no `winner` and
 * `awayScore` is always 0, so it used to read as an unfinished game forever and hold the whole week
 * (and everything gated on it - the recap, power rankings, ...) as `week_not_final` indefinitely.
 * Verified on the 2025 dev backfill: week 15's two byes were exactly that failure. A week that is
 * ONLY byes has no real matchups left after this filter and reports `no_matchups`, same as an empty
 * week.
 */
export const isWeekFinal = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    week: v.number(),
    /** Supplied by tests and by callers that already have a stable clock. */
    now: v.optional(v.number()),
  },
  returns: v.object({
    final: v.boolean(),
    matchups: v.number(),
    unfinished: v.number(),
    periodOver: v.boolean(),
    reason: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();

    // `args.week` is an NFL week; a multi-week playoff round's matchups are
    // stored under the ROUND's own matchup period id (see
    // `resolveMatchupPeriodForWeek`'s doc comment) - map through it so a
    // caller checking finality of the LAST week of a 2-week round actually
    // finds that round's matchup row, instead of finding nothing and
    // reporting `no_matchups`.
    const matchupPeriod = await resolveMatchupPeriodForWeek(ctx, args.leagueId, args.seasonId, args.week);
    const allMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_period", (q) =>
        q.eq("leagueId", args.leagueId).eq("matchupPeriod", matchupPeriod),
      )
      .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
      .take(MAX_MATCHUPS_PER_WEEK);
    const matchups = allMatchups.filter((matchup) => !isByeMatchup(matchup));

    const season = await ctx.db
      .query("nflSeasons")
      .withIndex("by_year", (q) => q.eq("year", args.seasonId))
      .first();
    const boundary = (season?.weekBoundaries as WeekBoundary[] | undefined)?.find(
      (entry) => entry.week === args.week,
    );
    const periodOver = boundary ? now > boundary.end : false;

    if (matchups.length === 0) {
      return {
        final: false,
        matchups: 0,
        unfinished: 0,
        periodOver,
        reason: "no_matchups",
      };
    }

    const unfinished = matchups.filter((matchup) => {
      if (matchup.winner !== undefined) return false;
      const bothScored = matchup.homeScore > 0 && matchup.awayScore > 0;
      return !(bothScored && periodOver);
    }).length;

    return {
      final: unfinished === 0,
      matchups: matchups.length,
      unfinished,
      periodOver,
      reason: unfinished === 0 ? "final" : "unfinished_matchups",
    };
  },
});

/**
 * Data completeness (spec §11.1.2 and §11.1.3).
 *
 * `computeMissingRequiredData` is the prompt layer's answer to the same
 * question, but it needs the assembled `LeagueDataContext` - which is exactly
 * the expensive thing this gate exists to avoid building for an article we are
 * about to defer. So the template's own `requiredData` vocabulary is read here
 * (the single source of truth for what a type needs) and each core requirement
 * is answered straight off an index instead.
 *
 * Only *core* inputs defer. Quotes, prior claims, injury reports, historical
 * seasons and rivalry records are all things a writer can honestly work
 * around; a recap with no matchups or a draft grade with no picks is not.
 */
export const checkDataCompleteness = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    contentType: v.string(),
    seasonId: v.number(),
    week: v.number(),
  },
  returns: v.object({
    complete: v.boolean(),
    missing: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const template = contentTemplates[args.contentType];
    const required = new Set(template?.requiredData ?? []);
    const isDraftType = DRAFT_CONTENT.has(args.contentType);
    const missing: string[] = [];

    const needs = (fields: Set<string>) =>
      [...required].some((field) => fields.has(field));

    // Teams. Everything that ranks, grades or recaps needs a roster of teams.
    if (needs(REQUIRES_TEAMS) || isDraftType) {
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
        .take(1);
      if (teams.length === 0) missing.push("teams");
    }

    // The week this article is about. A round-one bye (`isByeMatchup`) doesn't count as a matchup -
    // a week that is only byes must defer the same as an empty week, not read as "covered" off
    // whichever row `.take` happened to grab first.
    if (needs(REQUIRES_WEEK_MATCHUPS)) {
      const matchupPeriod = await resolveMatchupPeriodForWeek(ctx, args.leagueId, args.seasonId, args.week);
      const played = await ctx.db
        .query("matchups")
        .withIndex("by_league_period", (q) =>
          q.eq("leagueId", args.leagueId).eq("matchupPeriod", matchupPeriod),
        )
        .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
        .take(MAX_MATCHUPS_PER_WEEK);
      if (!played.some((matchup) => !isByeMatchup(matchup))) missing.push(`matchups_week_${args.week}`);
    }

    // The week a preview is about: the slate that has not been played yet. Same bye exclusion as
    // above - a bye is not a game to preview either.
    if (needs(REQUIRES_UPCOMING_MATCHUPS)) {
      const upcomingWeek = args.week + 1;
      const upcomingMatchupPeriod = await resolveMatchupPeriodForWeek(ctx, args.leagueId, args.seasonId, upcomingWeek);
      const upcoming = await ctx.db
        .query("matchups")
        .withIndex("by_league_period", (q) =>
          q.eq("leagueId", args.leagueId).eq("matchupPeriod", upcomingMatchupPeriod),
        )
        .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
        .take(MAX_MATCHUPS_PER_WEEK);
      // A preview may legitimately be written about the current week's slate
      // when that week has not started; accept either.
      if (!upcoming.some((matchup) => !isByeMatchup(matchup))) {
        const thisWeekMatchupPeriod = await resolveMatchupPeriodForWeek(ctx, args.leagueId, args.seasonId, args.week);
        const thisWeek = await ctx.db
          .query("matchups")
          .withIndex("by_league_period", (q) =>
            q.eq("leagueId", args.leagueId).eq("matchupPeriod", thisWeekMatchupPeriod),
          )
          .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
          .take(MAX_MATCHUPS_PER_WEEK);
        if (!thisWeek.some((matchup) => !isByeMatchup(matchup))) missing.push(`upcoming_matchups_week_${upcomingWeek}`);
      }
    }

    // The player universe a waiver or mock-draft story picks from (§11.1.3:
    // `mock_draft` additionally needs a non-empty free-agent pool).
    if (needs(REQUIRES_PLAYER_POOL) || args.contentType === "mock_draft") {
      const pool = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_season", (q) => q.eq("season", args.seasonId))
        .take(1);
      if (pool.length === 0) missing.push("free_agent_pool");
    }

    // Draft picks, and the ADP column they would be graded against.
    if (needs(REQUIRES_DRAFT_PICKS) || DRAFT_GRADED_CONTENT.has(args.contentType)) {
      const picks = await draftPicksWithAdp(ctx, args.leagueId, args.seasonId);

      if (picks.length === 0) {
        missing.push("draft_picks");
      } else if (
        DRAFT_GRADED_CONTENT.has(args.contentType) &&
        adpLooksLikePlaceholder(picks)
      ) {
        // ESPN stores one default ADP for every pick when it cannot join a
        // real one (production 2025: all 170 picks at 170.0). Grading against
        // that calls the first overall pick a 169-slot steal, so it counts as
        // a missing input rather than a bad one (spec §11.1.3).
        missing.push("draft_adp_placeholder");
      }
    }

    return { complete: missing.length === 0, missing };
  },
});

/**
 * The drafted players' ADP column, read straight off the draft transactions.
 *
 * Bounded twice over: at most {@link MAX_DRAFT_PICKS_SAMPLED} picks are
 * sampled, which is far more than the eight values
 * `adpLooksLikePlaceholder` needs to make its call and far fewer than a
 * full draft's worth of player lookups.
 */
async function draftPicksWithAdp(
  ctx: { db: QueryCtx["db"] },
  leagueId: Id<"leagues">,
  seasonId: number,
): Promise<Array<{ playerADP?: number | null }>> {
  const draftTransactions = await ctx.db
    .query("transactions")
    .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .filter((q) => q.eq(q.field("type"), "DRAFT"))
    .take(MAX_DRAFT_TRANSACTIONS);

  const playerIds: string[] = [];
  for (const transaction of draftTransactions) {
    for (const item of transaction.items ?? []) {
      if (playerIds.length >= MAX_DRAFT_PICKS_SAMPLED) break;
      playerIds.push(String(item.playerId));
    }
    if (playerIds.length >= MAX_DRAFT_PICKS_SAMPLED) break;
  }

  const picks: Array<{ playerADP?: number | null }> = [];
  for (const playerId of playerIds) {
    const player = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_espn_id_season", (q) =>
        q.eq("espnId", playerId).eq("season", seasonId),
      )
      .first();
    picks.push({ playerADP: player?.ownership?.averageDraftPosition ?? null });
  }

  return picks;
}

/**
 * Idempotency lookup (spec section 9.2.6): is there already a row for this
 * league/type/season/week that is pending, generating, or done? `cancelled` and
 * `failed` rows deliberately do not block a fresh attempt.
 */
export const findScheduledContentForPeriod = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    contentType: v.string(),
    seasonId: v.number(),
    week: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league_type_season_week", (q) =>
        q
          .eq("leagueId", args.leagueId)
          .eq("contentType", args.contentType)
          .eq("seasonId", args.seasonId)
          .eq("week", args.week),
      )
      .take(20);

    return rows.find((row) => row.status !== "cancelled" && row.status !== "failed") ?? null;
  },
});

/** Event dedupe (spec section 9.2.9): same league, same type, same event key. */
export const findScheduledContentForEvent = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    contentType: v.string(),
    eventKey: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league_type_event", (q) =>
        q.eq("leagueId", args.leagueId).eq("contentType", args.contentType).eq("eventKey", args.eventKey),
      )
      .take(10);

    return rows.find((row) => row.status !== "cancelled" && row.status !== "failed") ?? null;
  },
});

/** Rate limit (spec section 9.2.9): one article per type per league per window. */
export const countRecentEventContent = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    contentType: v.string(),
    since: v.number(),
  },
  handler: async (ctx, args): Promise<number> => {
    const rows = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) =>
        q.and(
          q.eq(q.field("contentType"), args.contentType),
          q.gte(q.field("createdAt"), args.since),
          q.neq(q.field("status"), "cancelled"),
        ),
      )
      .take(20);

    return rows.length;
  },
});

/**
 * Commissioner-facing notification for a scheduling outcome (spec section 9.2.10).
 * `notifyCommissioner` covers a finished article that was NOT auto-published
 * (it needs a look); `notifyFailures` covers failures and low-credit
 * cancellations. Low-credit notices dedupe on (league, week).
 */
export const notifyScheduleOutcome = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    outcome: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("low_credits"),
      // League Pass outcomes (spec §10.1).
      v.literal("no_pass"),
      v.literal("spend_cap"),
      // ESPN connection outcomes (owner directive, Sept 2026).
      v.literal("espn_paused"),
      v.literal("espn_restored"),
    ),
    contentType: v.string(),
    week: v.optional(v.number()),
    articleId: v.optional(v.id("aiContent")),
    errorMessage: v.optional(v.string()),
    creditCost: v.optional(v.number()),
    currentBalance: v.optional(v.number()),
    /** Measured automated spend this season, for the spend_cap notice. */
    spentUsd: v.optional(v.number()),
    capUsd: v.optional(v.number()),
    /** Rows waiting (pending + backlogged), for the espn_paused notice. */
    waiting: v.optional(v.number()),
    /** Rows brought back, for the espn_restored notice. */
    resumed: v.optional(v.number()),
    withoutInterviews: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ notified: boolean; reason?: string }> => {
    const preferences = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();

    const wanted =
      args.outcome === "completed"
        ? preferences?.notifyCommissioner !== false
        : preferences?.notifyFailures !== false;

    if (!wanted) return { notified: false, reason: "notifications disabled" };

    const league = await ctx.db.get(args.leagueId);
    if (!league) return { notified: false, reason: "league not found" };

    // `leagues.commissionerUserId` is a Clerk id; notifications key off users._id.
    const commissioner = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", league.commissionerUserId))
      .unique();

    if (!commissioner) return { notified: false, reason: "commissioner user row not found" };

    const weekLabel = args.week ? ` (week ${args.week})` : "";
    const typeLabel = args.contentType.replace(/_/g, " ");
    // Dedupe windows differ by outcome: a credit shortfall is a weekly nag,
    // but "your pass lapsed" and "you hit the season cap" are each worth
    // saying once per league (per season, for the cap) and no more.
    // espn_paused dedupes once per calendar day (owner directive: the desk
    // should say this at most once a day, not on every scheduler pass while
    // the connection stays broken); espn_restored has no dedupe key - it is a
    // one-time event per restore, like "completed"/"failed".
    const dedupeKey =
      args.outcome === "low_credits"
        ? `low_credits:${args.leagueId}:${args.week ?? "na"}`
        : args.outcome === "no_pass"
          ? `no_pass:${args.leagueId}`
          : args.outcome === "spend_cap"
            ? `spend_cap:${args.leagueId}:${passSeasonId(league)}`
            : args.outcome === "espn_paused"
              ? `espn_paused:${args.leagueId}:${Math.floor(Date.now() / (24 * 60 * 60 * 1000))}`
              : undefined;

    if (dedupeKey) {
      const existing = await ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissioner._id))
        .filter((q) => q.eq(q.field("relatedEntityId"), dedupeKey))
        .first();
      if (existing) return { notified: false, reason: "already notified this week" };
    }

    const content = {
      completed: {
        title: `Your ${typeLabel} is ready for review`,
        message: `The desk finished this week's ${typeLabel}${weekLabel}. It is waiting in drafts for your approval.`,
        priority: "medium" as const,
      },
      failed: {
        title: `${typeLabel} could not be generated`,
        message: `The desk could not file this week's ${typeLabel}${weekLabel}. ${args.errorMessage ?? ""}`.trim(),
        priority: "high" as const,
      },
      low_credits: {
        title: `Out of credits for this week's ${typeLabel}`,
        message: `The ${typeLabel}${weekLabel} needs ${args.creditCost ?? 0} credits and the league has ${args.currentBalance ?? 0}. Top up to keep the weekly content running.`,
        priority: "high" as const,
      },
      no_pass: {
        title: "Your League Pass is not active",
        message: `The desk held this week's ${typeLabel}${weekLabel} because the League Pass for ${league.name} is not active. Renew it and the calendar picks up where it left off.`,
        priority: "high" as const,
      },
      spend_cap: {
        title: "Automated content is paused",
        message: `Automated stories for ${league.name} have used $${(args.spentUsd ?? 0).toFixed(2)} of this season's $${(args.capUsd ?? 0).toFixed(2)} safety limit, so the desk paused the calendar and flagged it to us. Your credits and manual generation are unaffected.`,
        priority: "high" as const,
      },
      espn_paused: {
        title: "Automated content is paused",
        message: `ESPN rejected ${league.name}'s cookies, so the desk can't read fresh data for this league. ${args.waiting ?? 0} ${(args.waiting ?? 0) === 1 ? "story is" : "stories are"} waiting and will generate automatically once the connection is fixed.`,
        priority: "high" as const,
      },
      espn_restored: {
        title: "ESPN connection restored",
        message: `${args.resumed ?? 0} ${(args.resumed ?? 0) === 1 ? "story is" : "stories are"} being generated now${(args.withoutInterviews ?? 0) > 0 ? `; ${args.withoutInterviews} of them skip interviews because their week has passed` : ""}.`,
        priority: "medium" as const,
      },
    }[args.outcome];

    const actionUrl =
      args.outcome === "espn_paused" || args.outcome === "espn_restored"
        ? `/leagues/${args.leagueId}/settings`
        : args.articleId
          ? `/articles/${args.articleId}`
          : `/leagues/${args.leagueId}`;
    const actionText =
      args.outcome === "espn_paused"
        ? "Fix ESPN connection"
        : args.outcome === "completed"
          ? "Review article"
          : "Open league";

    await ctx.runMutation(internal.notifications.createNotification, {
      userId: commissioner._id,
      leagueId: args.leagueId,
      type: args.outcome === "completed" ? "article_generated" : "system_announcement",
      title: content.title,
      message: content.message,
      actionUrl,
      actionText,
      relatedEntityType: args.articleId ? ("ai_content" as const) : ("league" as const),
      relatedEntityId: dedupeKey ?? (args.articleId ?? args.leagueId),
      priority: content.priority,
      deliveryChannels: ["in_app" as const],
    });

    return { notified: true };
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
      v.literal("batched"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    attempts: v.optional(v.number()),
    lastAttemptAt: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    cancelReason: v.optional(v.string()),
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

/* -------------------------------------------------------------------------- *
 * Batch bookkeeping (spec §10.3.5)
 * -------------------------------------------------------------------------- */

/**
 * Mark that a batch submission has been queued for this row.
 *
 * `batchSubmittedAt` is the "one submission per row" latch that keeps the
 * lookahead pass from queueing a second one every fifteen minutes.
 * `aiBatch.submitScheduledArticle` re-stamps it with the real submission time
 * and adds `batchId` / `batchCustomId` when the batch is accepted.
 */
export const markBatchSubmissionScheduled = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    submitAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledContentId);
    if (!row) return null;
    await ctx.db.patch(args.scheduledContentId, {
      batchSubmittedAt: args.submitAt,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Rows whose print time is far enough ahead to be worth batching.
 *
 * The ordinary queue only looks at rows that are already due; this is the
 * lookahead that makes the batch path reachable at all. It deliberately
 * excludes rows that already have a submission queued (`batchSubmittedAt`) and
 * rows still cooling off from a retry.
 */
export const getBatchableScheduledContent = internalQuery({
  args: {
    fromTime: v.number(),
    toTime: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("scheduledContent")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .filter((q) =>
        q.and(
          q.gt(q.field("scheduledFor"), args.fromTime),
          q.lte(q.field("scheduledFor"), args.toTime),
          q.eq(q.field("batchSubmittedAt"), undefined),
          q.or(
            q.eq(q.field("nextRetryAt"), undefined),
            q.lte(q.field("nextRetryAt"), args.fromTime),
          ),
        ),
      )
      .take(args.limit ?? 20);
  },
});

/**
 * Every row currently waiting on a Message Batch.
 *
 * `aiBatch.pollBatches` asks for these every ten minutes; it is the seam that
 * lets that "use node" module read the queue without a database handle of its
 * own. Bounded, because a poll that has to page is a poll that is already
 * behind.
 */
export const getBatchedScheduledContent = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("scheduledContent")
      .withIndex("by_status", (q) => q.eq("status", "batched"))
      .take(args.limit ?? 100);
  },
});

/**
 * Direct-generation fallback for batches that never came back (spec §10.3.5).
 *
 * A row sitting in `batched` when its print time arrives means the batch is
 * still processing, errored, or expired. Put it back in the queue so the very
 * next pass generates it directly - a late article is recoverable, a missing
 * one is not. The batch fields are left in place: `aiBatch.pollBatches` uses
 * them to recognise a result it no longer needs.
 */
export const releaseDueBatchRows = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ released: v.number() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const dueRows = await ctx.db
      .query("scheduledContent")
      .withIndex("by_status", (q) => q.eq("status", "batched"))
      .filter((q) => q.lte(q.field("scheduledFor"), now))
      .take(args.limit ?? 20);

    // Season backfill rows (convex/seasonBackfill.ts) never go through
    // batching (processScheduledContent's batch lookahead only ever sees rows
    // this cron queue already excludes them from), but the contract with the
    // backfill tool is the same as the other sweepers: leave them alone.
    const stuck = dueRows.filter((row) => !row.backfill);

    for (const row of stuck) {
      await ctx.db.patch(row._id, {
        status: "pending",
        nextRetryAt: undefined,
        errorMessage: "Batch did not complete before print time; generating directly",
        updatedAt: now,
      });
    }

    if (stuck.length > 0) {
      console.log(`Released ${stuck.length} batched row(s) back to direct generation`);
    }
    return { released: stuck.length };
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

/**
 * A league's `contentSchedules` row for one type, if it has one. `scheduleWeeklyContentCron`
 * already has an equivalent for weekly types (it iterates `getWeeklySchedules`);
 * `triggerEventBasedContent`'s `draft_completed` branch uses this to find the `weekly_preview`
 * row's `_id`/`preferredPersona` when scheduling the week-1 preview, and `kickOffSeasonWelcome`
 * uses it to find the `season_welcome` row so an on-demand kickoff still carries the league's
 * own preferred persona/timezone. Narrowed to these two literal types (rather than `v.string()`)
 * so the `.eq("contentType", ...)` index call below stays typed against the schema's own union.
 */
export const getContentScheduleByType = internalQuery({
  args: { leagueId: v.id("leagues"), contentType: v.union(v.literal("weekly_preview"), v.literal("season_welcome")) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contentSchedules")
      .withIndex("by_league_type", (q) => q.eq("leagueId", args.leagueId).eq("contentType", args.contentType))
      .first();
  },
});

/**
 * Week-1 preview scheduling (owner directive, 2026-09-03 - see `convex/lib/weekOneGate.ts`'s
 * header). Shared by `scheduleWeeklyContentCron` (checked once a day until the window opens or
 * closes) and `triggerEventBasedContent`'s `draft_completed` branch (a second, earlier chance the
 * same day the draft finishes). Both dedupe through the same `findScheduledContentForPeriod` row
 * every other content type uses, so whichever path gets there first creates the only row.
 *
 * `processScheduledContent`'s own season-boundary gate
 * (`nflSeasonBoundaries.isContentGenerationAllowed`) only allows `weekly_preview` during
 * REGULAR_SEASON/PLAYOFFS - but the entire point of this gate is to fire BEFORE kickoff, while
 * the league is still in PRESEASON (or the dateless gap between preseason end and kickoff - see
 * `validateSeasonWelcomeContent`'s comment in `convex/nflSeasonBoundaries.ts` for that same gap).
 * `forcePeriod` is that action's own documented escape hatch for "write about a named period
 * instead of re-reading the clock" (its own doc comment); scheduled here to run at (as close as
 * Convex's scheduler gets to) the row's own `scheduledFor` instant so it claims the row well
 * ahead of the generic 15-minute sweep (`processScheduledContentCron`), which would otherwise
 * process it without `forcePeriod` and have the season-boundary gate reject it.
 */
async function scheduleWeekOnePreview(
  ctx: ActionCtx,
  args: {
    leagueId: Id<"leagues">;
    seasonId: number;
    contentScheduleId: Id<"contentSchedules">;
    preferredPersona?: string | null;
    now: number;
    /** draft-grades-row-time + 2h, for the `draft_completed` path only - overrides the gate's own
     * `now + 5 minutes` so the preview never prints before (or at the same moment as) the grades. */
    scheduledForOverride?: number;
  }
): Promise<{ scheduled: boolean; reason: string }> {
  const [leagueSeason, boundaries] = await Promise.all([
    ctx.runQuery(internal.contentScheduling.getLeagueSeasonDoc, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
    }),
    ctx.runQuery(internal.nflSeasonBoundaries.getNFLSeasonBoundaries, { year: args.seasonId }),
  ]);

  if (!boundaries) {
    return { scheduled: false, reason: "no_season_boundaries" };
  }

  const decision = weekOnePreviewDecision({
    now: args.now,
    drafted: leagueSeason?.draftInfo?.drafted === true,
    draftInProgress: leagueSeason?.draftInfo?.inProgress === true,
    kickoffAt: boundaries.phases.regularSeason.start,
    week1TuesdayAt: boundaries.weekBoundaries.find((w) => w.week === 1)?.start,
  });

  if (!decision.schedule) {
    return { scheduled: false, reason: decision.reason };
  }

  // Idempotency (spec section 9.2.6), same as every other content type - and the reason it is
  // safe for both callers to reach this function for the same league/season: whichever runs
  // first wins, and `findScheduledContentForPeriod` ignores a cancelled/failed row, so a bad
  // earlier attempt does not permanently block a retry while the window is still open.
  const existing = await ctx.runQuery(internal.contentScheduling.findScheduledContentForPeriod, {
    leagueId: args.leagueId,
    contentType: "weekly_preview",
    seasonId: args.seasonId,
    week: 1,
  });
  if (existing) {
    return { scheduled: false, reason: "already_scheduled" };
  }

  const scheduledFor = args.scheduledForOverride ?? decision.scheduledFor!;
  await ctx.runMutation(internal.contentScheduling.scheduleContentGeneration, {
    leagueId: args.leagueId,
    contentScheduleId: args.contentScheduleId,
    contentType: "weekly_preview",
    scheduledFor,
    week: 1,
    seasonId: args.seasonId,
    writerPersona: args.preferredPersona || defaultPersonaFor("weekly_preview"),
    contextData: {
      week: 1,
      seasonId: args.seasonId,
      additionalContext: { scheduleType: "week_one_preview" },
    },
  });

  return { scheduled: true, reason: decision.reason };
}

// Trigger event-based content generation (e.g., when a trade occurs)
export const triggerEventBasedContent = internalAction({
  args: {
    leagueId: v.id("leagues"),
    eventType: v.string(), // "trade_occurred", "season_ended", etc.
    eventData: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<{ scheduledJobs: number; skipped: number }> => {
    // Find all enabled content schedules that are triggered by this event
    const eventSchedules = await ctx.runQuery(internal.contentScheduling.getEventTriggeredSchedules, {
      leagueId: args.leagueId,
      eventType: args.eventType,
    });

    const eventKey = buildEventKey(args.eventType, args.eventData);
    const scheduledJobs = [];
    let skipped = 0;
    // Captured when this batch includes the draft-grades (draft_rankings) row - the week-1
    // preview step below prints 2 hours after it, never before (owner directive, 2026-09-03 -
    // see scheduleWeekOnePreview's header).
    let draftGradesScheduledFor: number | undefined;

    for (const schedule of eventSchedules) {
      if (!schedule.enabled) continue;

      // Dedupe (spec section 9.2.9): the same underlying event must never
      // produce a second article, however many times ESPN replays it.
      const duplicate = await ctx.runQuery(internal.contentScheduling.findScheduledContentForEvent, {
        leagueId: args.leagueId,
        contentType: schedule.contentType,
        eventKey,
      });
      if (duplicate) {
        console.log(`Skipping ${schedule.contentType} for league ${args.leagueId}: event ${eventKey} already scheduled`);
        skipped += 1;
        continue;
      }

      // Rate limit: at most one article of a type per league per 6 hours, so a
      // busy trade deadline does not bury the league in copy.
      const recent = await ctx.runQuery(internal.contentScheduling.countRecentEventContent, {
        leagueId: args.leagueId,
        contentType: schedule.contentType,
        since: Date.now() - SIX_HOURS_MS,
      });
      if (recent > 0) {
        console.log(`Skipping ${schedule.contentType} for league ${args.leagueId}: rate limited (${recent} in the last 6h)`);
        skipped += 1;
        continue;
      }

      const triggeredAt = Date.now();
      let scheduledFor: number;
      if (schedule.schedule.type === "event_triggered" && schedule.schedule.trigger === "draft_completed") {
        // draft_rankings (spec section 9.1) prints "the morning after" a
        // draft rather than a fixed delay after the event fires - see
        // nextMorningAfter's doc comment in convex/lib/draftDate.ts for the
        // exact rule. Every other event type (trade_occurred, etc.) keeps
        // its configured delayMinutes below.
        scheduledFor = nextMorningAfter(
          triggeredAt,
          schedule.timezone || DEFAULT_TIMEZONE,
          { hour: 9, minHoursAfter: 6 },
          convertUTCToTimeZone,
          convertTimeZoneToUTC,
        );
        draftGradesScheduledFor = scheduledFor;
      } else {
        const delayMs = schedule.schedule.type === "event_triggered"
          ? (schedule.schedule.delayMinutes || 0) * 60 * 1000
          : 0;
        scheduledFor = triggeredAt + delayMs;
      }

      const scheduledContentId = await ctx.runMutation(internal.contentScheduling.scheduleContentGeneration, {
        leagueId: args.leagueId,
        contentScheduleId: schedule._id,
        contentType: schedule.contentType,
        scheduledFor,
        eventKey,
        seasonId: args.eventData?.seasonId,
        writerPersona: schedule.preferredPersona || defaultPersonaFor(schedule.contentType),
        contextData: {
          triggerEvent: args.eventType,
          eventData: args.eventData,
          // Extract seasonId from eventData for draft_completed events
          seasonId: args.eventData?.seasonId,
        },
      });

      scheduledJobs.push(scheduledContentId);

      // If the target time is already here (or passed), process immediately
      // rather than waiting for the next scheduler tick.
      if (scheduledFor <= triggeredAt) {
        await ctx.scheduler.runAfter(0, internal.contentScheduling.processScheduledContent, {
          scheduledContentId: scheduledContentId.scheduledContentId,
        });
      }
    }

    // Week 1's preview (owner directive, 2026-09-03 - see convex/lib/weekOneGate.ts's header):
    // the draft completing is one of its two conditions, so this is the earlier of its two
    // chances to create that row (the other is scheduleWeeklyContentCron's daily check). Prints 2
    // hours after the draft-grades row when this run scheduled one, or on the gate's own
    // now+5-minute default otherwise (e.g. the league has draft_rankings disabled). A league with
    // no weekly_preview schedule at all (deleted, never seeded) has nothing to attach the row to
    // and is silently skipped - the same as any other league missing that row today.
    if (args.eventType === "draft_completed" && args.eventData?.seasonId !== undefined) {
      const weeklyPreviewSchedule = await ctx.runQuery(internal.contentScheduling.getContentScheduleByType, {
        leagueId: args.leagueId,
        contentType: "weekly_preview",
      });
      if (weeklyPreviewSchedule?.enabled) {
        const result = await scheduleWeekOnePreview(ctx, {
          leagueId: args.leagueId,
          seasonId: args.eventData.seasonId,
          contentScheduleId: weeklyPreviewSchedule._id,
          preferredPersona: weeklyPreviewSchedule.preferredPersona,
          now: Date.now(),
          scheduledForOverride:
            draftGradesScheduledFor !== undefined ? draftGradesScheduledFor + TWO_HOURS_MS : undefined,
        });
        if (!result.scheduled) {
          console.log(`Week-1 preview not scheduled for league ${args.leagueId}: ${result.reason}`);
        }
      }
    }

    return { scheduledJobs: scheduledJobs.length, skipped };
  },
});

/**
 * A stable identity for the real-world event behind an event-triggered article,
 * so replays of the same ESPN payload collapse to one row.
 */
function buildEventKey(eventType: string, eventData: any): string {
  if (!eventData) return eventType;
  if (eventData.tradeId) return `${eventType}:${eventData.tradeId}`;
  if (eventType === "draft_completed") return `${eventType}:${eventData.seasonId ?? "unknown"}`;
  if (eventData.seasonId !== undefined && eventData.week !== undefined) {
    return `${eventType}:${eventData.seasonId}:${eventData.week}`;
  }
  if (eventData.seasonId !== undefined) return `${eventType}:${eventData.seasonId}`;
  return eventType;
}

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

    // Reclaim anything an earlier pass abandoned mid-generation before we look
    // at the queue, so a stalled row rejoins this same run.
    try {
      const swept = await ctx.runMutation(internal.contentScheduling.reclaimStuckGenerations, {});
      if (swept.reclaimed || swept.failed) {
        console.log(`Sweeper: requeued ${swept.reclaimed}, failed ${swept.failed} stuck generations`);
      }
    } catch (error) {
      console.error("Sweeper failed to reclaim stuck generations:", error);
    }

    // A batch that has not come back by print time loses its turn: the row
    // goes back in the queue below and generates directly (spec §10.3.5).
    try {
      await ctx.runMutation(internal.contentScheduling.releaseDueBatchRows, {});
    } catch (error) {
      console.error("Failed to release overdue batched rows:", error);
    }

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

    // Lookahead (spec §10.3.5). Rows whose print time is still two to three
    // hours out are handed to `processScheduledContent` early; it runs the
    // same gates and then queues a Message Batch at print - 3h instead of
    // generating now. Batch is billed at 50%, and a submission that does not
    // land simply leaves the row pending for the due-now pass above.
    let batched = 0;
    if (batchScheduledGenerationEnabled()) {
      try {
        const now = Date.now();
        const upcoming = await ctx.runQuery(
          internal.contentScheduling.getBatchableScheduledContent,
          { fromTime: now + TWO_HOURS_MS, toTime: now + THREE_HOURS_MS, limit: 20 },
        );
        for (const row of upcoming) {
          try {
            const result = await ctx.runAction(internal.contentScheduling.processScheduledContent, {
              scheduledContentId: row._id,
            });
            if (result.success) batched++;
          } catch (error) {
            console.error(`Error pre-batching scheduled content ${row._id}:`, error);
          }
        }
      } catch (error) {
        console.error("Batch lookahead pass failed:", error);
      }
    }

    return { processed, errors, batched };
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

  // Season-dependent content only during active season phases. REGULAR_SEASON
  // only (owner directive, Sept 2026): a fantasy league's own playoffs are
  // still inside the NFL's REGULAR_SEASON phase (the NFL's own PLAYOFFS/
  // SUPER_BOWL phases start well after every real fantasy league has already
  // crowned a champion), so weekly programming never needs either of those.
  // `weeklyTargetWeekInSeason` (convex/lib/seasonWindow.ts) is the
  // league-relative half of this gate; this is the NFL-phase half.
  if (SEASON_DEPENDENT_CONTENT.has(contentType)) {
    const activePhasesForContent = ["REGULAR_SEASON"];
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

    // Make sure the current season's nflSeasons row exists before we rely on
    // it below - covers the window right after deploy, before the dedicated
    // 01:00 UTC seeding cron has had a chance to run.
    try {
      await ctx.runMutation(internal.nflSeasonSetup.ensureCurrentSeason, {});
    } catch (error) {
      console.warn("Failed to ensure current NFL season boundaries:", error);
    }

    // Get current NFL season phase for smart scheduling decisions
    let currentSeasonPhase: string = "UNKNOWN";
    try {
      const seasonPhaseInfo = await ctx.runQuery(internal.nflSeasonBoundaries.getNFLSeasonPhase, {});
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

        // Determine current season for league for context
        let seasonIdForLeague: number | undefined = undefined;
        try {
          const leagueSeason = await ctx.runQuery(internal.contentScheduling.getLeagueSeason, {
            leagueId: schedule.leagueId,
          });
          seasonIdForLeague = leagueSeason?.seasonId;
        } catch (e) {
          // ignore and proceed
        }

        // The week the article will be about, computed for the instant the job
        // will actually fire (not for "now"), so this matches what
        // processScheduledContent re-stamps and the idempotency key is stable.
        const weekAtRun = await getCurrentNFLWeek(ctx, nextScheduledTime);
        const targetWeek = resolveTargetWeek(schedule.contentType, weekAtRun);
        const targetSeason = seasonIdForLeague ?? nflSeasonYearFor(new Date(nextScheduledTime));

        // Week 1's preview never uses this schedule's generic Thursday-of-that-week slot (owner
        // directive, 2026-09-03 - see convex/lib/weekOneGate.ts's header): by the time `targetWeek`
        // resolves to 1 here, kickoff is at most a few days away, so `scheduleWeekOnePreview`'s own
        // gate decides both whether and exactly when to fire. This is also the ONLY place besides
        // `triggerEventBasedContent`'s `draft_completed` branch that may create a week-1
        // `weekly_preview` row - every other content type falls through to the generic path below.
        if (schedule.contentType === "weekly_preview" && targetWeek === 1) {
          const result = await scheduleWeekOnePreview(ctx, {
            leagueId: schedule.leagueId,
            seasonId: targetSeason,
            contentScheduleId: schedule._id,
            preferredPersona: schedule.preferredPersona,
            now: Date.now(),
          });
          if (result.scheduled) scheduled++;
          else skipped++;
          schedulingDetails.push({
            contentType: schedule.contentType,
            leagueId: schedule.leagueId,
            action: result.scheduled ? "scheduled" : "skipped",
            reason: `week_one_gate: ${result.reason}`,
          });
          continue;
        }

        // Weekly content only runs during the league's OWN season (owner
        // directive, Sept 2026) - the NFL calendar keeps going through the
        // playoffs and Super Bowl long after a 14+3 league's championship is
        // decided, and without this a row kept being created every week of
        // that gap, deferring on no_matchups_week_N up to MAX_DEFERRALS times
        // and then failing with a commissioner notification.
        const leagueSeasonDoc = await ctx.runQuery(internal.contentScheduling.getLeagueSeasonDoc, {
          leagueId: schedule.leagueId,
          seasonId: targetSeason,
        });
        const inSeason = weeklyTargetWeekInSeason({
          contentType: schedule.contentType,
          targetWeek,
          seasonEndWeek: resolveSeasonEndWeek(leagueSeasonDoc?.settings),
        });
        if (!inSeason.inSeason) {
          skipped++;
          schedulingDetails.push({
            contentType: schedule.contentType,
            leagueId: schedule.leagueId,
            action: "skipped",
            reason: inSeason.reason,
          });
          continue;
        }

        // Idempotency (spec section 9.2.6): one row per league/type/season/week,
        // whatever the 4-hour window would have said.
        const existingForPeriod = await ctx.runQuery(internal.contentScheduling.findScheduledContentForPeriod, {
          leagueId: schedule.leagueId,
          contentType: schedule.contentType,
          seasonId: targetSeason,
          week: targetWeek,
        });

        if (existingForPeriod) {
          schedulingDetails.push({
            contentType: schedule.contentType,
            leagueId: schedule.leagueId,
            action: "already_scheduled",
            reason: `existing ${existingForPeriod.status} row for season ${targetSeason} week ${targetWeek}`,
          });
          continue; // Skip if already scheduled
        }

        await ctx.runMutation(internal.contentScheduling.scheduleContentGeneration, {
          leagueId: schedule.leagueId,
          contentScheduleId: schedule._id,
          contentType: schedule.contentType,
          scheduledFor: nextScheduledTime,
          week: targetWeek,
          seasonId: targetSeason,
          writerPersona: schedule.preferredPersona || defaultPersonaFor(schedule.contentType),
          contextData: {
            week: targetWeek,
            seasonId: targetSeason,
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
      const totalSeasonDependent = weeklySchedules.filter((s: { contentType: string }) => SEASON_DEPENDENT_CONTENT.has(s.contentType)).length;
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
function calculateNextWeeklyOccurrence(schedule: {
  timezone?: string;
  schedule: { type: string; dayOfWeek?: number; hour?: number; minute?: number };
}, from: number = Date.now()): number {
  if (schedule.schedule.type !== "weekly") {
    throw new Error("Schedule is not weekly type");
  }
  const { dayOfWeek, hour, minute } = schedule.schedule;
  if (dayOfWeek === undefined || hour === undefined || minute === undefined) {
    throw new Error("Weekly schedule is missing dayOfWeek/hour/minute");
  }
  const timezone = schedule.timezone || DEFAULT_TIMEZONE;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const result = nextOccurrenceUtc(dayOfWeek, time, timezone, from);
  if (!Number.isFinite(result)) throw new Error("Invalid time conversion");
  return result;
}

// Helper function to get current NFL week using the robust season boundary system
async function getCurrentNFLWeek(ctx: any, at?: number): Promise<number> {
  try {
    return await ctx.runQuery(internal.nflSeasonBoundaries.getCurrentNFLWeek, at ? { date: at } : {});
  } catch (error) {
    console.error("Error getting current NFL week, falling back to default:", error);

    // Before falling back to the rough Sep-1 approximation below, try to
    // compute the week directly from the nflSeasons row's own week
    // boundaries, if a row for the current season exists.
    try {
      const nowMs = at ?? Date.now();
      const year = nflSeasonYearFor(new Date(nowMs));
      const boundaries = await ctx.runQuery(internal.nflSeasonBoundaries.getNFLSeasonBoundaries, { year });
      if (boundaries) {
        const match = boundaries.weekBoundaries.find(
          (b: { week: number; start: number; end: number }) => nowMs >= b.start && nowMs <= b.end
        );
        if (match) {
          return match.week;
        }
      }
    } catch (innerError) {
      console.error("Error computing NFL week from nflSeasons boundaries:", innerError);
    }

    // Fallback to simplified logic if season data is not available
    const now = new Date(at ?? Date.now());
    const seasonStart = new Date(now.getFullYear(), 8, 1); // September 1st as rough start
    const weeksSinceStart = Math.floor((now.getTime() - seasonStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return Math.max(1, Math.min(18, weeksSinceStart + 1)); // Weeks 1-18
  }
}

// ---------------------------------------------------------------------------
// Timezone helpers (spec section 9.2.1)
//
// A "zoned wall clock" is carried in a plain `Date` whose *local* getters
// (getFullYear/getHours/...) read back the wall-clock fields of the target
// timezone. That representation is host-timezone dependent on its own, but the
// pair of functions below is each other's exact inverse, so a round trip is
// stable no matter what timezone the Convex isolate runs in.
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEZONE = "America/New_York";

const WALL_CLOCK_PART_TYPES = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;

function wallClockPartsAt(instantMs: number, timeZone: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));

  const read = (type: (typeof WALL_CLOCK_PART_TYPES)[number]) => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing "${type}" in formatted parts for ${timeZone}`);
    return parseInt(part.value, 10);
  };

  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * The zone's UTC offset (ms, east positive) in effect at a given instant.
 * Computed by formatting the instant in the zone and comparing the resulting
 * wall clock, read as if it were UTC, against the instant itself.
 */
function zoneOffsetMsAt(instantMs: number, timeZone: string): number {
  const p = wallClockPartsAt(instantMs, timeZone);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Compare at second resolution: the formatted parts carry no milliseconds.
  return asIfUTC - Math.floor(instantMs / 1000) * 1000;
}

/** UTC instant -> a Date carrying that instant's wall clock in `timeZone`. */
export function convertUTCToTimeZone(dateUTC: Date, timeZone: string): Date {
  try {
    const p = wallClockPartsAt(dateUTC.getTime(), timeZone);
    return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
  } catch {
    return new Date(dateUTC.getTime());
  }
}

/**
 * A Date carrying a wall clock in `timeZone` -> the UTC instant it names.
 *
 * Solved for the offset rather than reformatted: guess the instant by reading
 * the wall clock as UTC, subtract the zone's offset there, then iterate twice so
 * a guess that lands on the wrong side of a DST transition settles on the right
 * offset. Nonexistent wall clocks (the spring-forward gap) resolve to the
 * instant one offset-step after the gap; ambiguous ones (fall back) resolve to
 * the first of the two, which is the standard convention.
 */
export function convertTimeZoneToUTC(dateInTZ: Date, timeZone: string): Date {
  const wallAsUTC = Date.UTC(
    dateInTZ.getFullYear(),
    dateInTZ.getMonth(),
    dateInTZ.getDate(),
    dateInTZ.getHours(),
    dateInTZ.getMinutes(),
    dateInTZ.getSeconds(),
    dateInTZ.getMilliseconds(),
  );

  try {
    let instant = wallAsUTC - zoneOffsetMsAt(wallAsUTC, timeZone);
    instant = wallAsUTC - zoneOffsetMsAt(instant, timeZone);
    instant = wallAsUTC - zoneOffsetMsAt(instant, timeZone);
    if (!Number.isFinite(instant)) throw new Error("Non-finite instant");
    return new Date(instant);
  } catch {
    // Unknown timezone id: treat the wall clock as UTC rather than throwing,
    // so a bad league setting degrades to a sane time instead of no content.
    return new Date(wallAsUTC);
  }
}

/**
 * The next UTC instant at which it is `time` ("HH:mm") on `dayOfWeek`
 * (0 = Sunday) in `timeZone`, strictly after `from` when today's slot has
 * already passed. Pure - exported for unit tests.
 */
export function nextOccurrenceUtc(
  dayOfWeek: number,
  time: string,
  timeZone: string,
  from: number = Date.now(),
): number {
  const [hourRaw, minuteRaw] = time.split(":");
  const hour = parseInt(hourRaw, 10);
  const minute = parseInt(minuteRaw ?? "0", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Invalid time "${time}", expected "HH:mm"`);
  }

  const localNow = convertUTCToTimeZone(new Date(from), timeZone);
  let daysUntilTarget = dayOfWeek - localNow.getDay();
  if (daysUntilTarget < 0) {
    daysUntilTarget += 7;
  } else if (daysUntilTarget === 0) {
    const nowMinutes = localNow.getHours() * 60 + localNow.getMinutes();
    if (nowMinutes >= hour * 60 + minute) daysUntilTarget = 7;
  }

  const target = new Date(localNow);
  target.setDate(target.getDate() + daysUntilTarget);
  target.setHours(hour, minute, 0, 0);
  return convertTimeZoneToUTC(target, timeZone).getTime();
}

/** The automatic-by-default preference values (spec section 9.1). */
function automaticDefaultPreferences(timezone: string) {
  return {
    contentEnabled: true,
    timezone,
    notifyCommissioner: true,
    notifyFailures: true,
    autoPublish: true,
    requireApproval: false,
  };
}

// Generic job dedupe for an arbitrary window
export const findExistingJobWithinWindow = internalQuery({
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
            q.eq(q.field("status"), "generating"),
            // A backlogged row already exists for this period/window - don't
            // schedule a second one behind it (owner directive, Sept 2026).
            q.eq(q.field("status"), "backlogged")
          )
        )
      )
      .first();

    return existingJobs;
  },
});

// Fetch season-based schedules
export const getSeasonBasedSchedules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allSchedules = await ctx.db
      .query("contentSchedules")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();
    return allSchedules.filter((s) => s.schedule.type === "season_based");
  },
});

// Fetch relative schedules
export const getRelativeSchedules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allSchedules = await ctx.db
      .query("contentSchedules")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();
    return allSchedules.filter((s) => s.schedule.type === "relative");
  },
});

// Daily cron: schedule season_based and relative content
export const scheduleSeasonAndRelativeContentCron = internalAction({
  args: {},
  handler: async (ctx) => {
    console.log("=== scheduleSeasonAndRelativeContentCron START ===");

    // Make sure the current season's nflSeasons row exists before we rely on
    // it below - covers the window right after deploy, before the dedicated
    // 01:00 UTC seeding cron has had a chance to run.
    try {
      await ctx.runMutation(internal.nflSeasonSetup.ensureCurrentSeason, {});
    } catch (error) {
      console.warn("Failed to ensure current NFL season boundaries:", error);
    }

    // Get current NFL season phase for intelligent filtering
    let currentSeasonPhase: string = "UNKNOWN";
    try {
      const seasonPhaseInfo = await ctx.runQuery(internal.nflSeasonBoundaries.getNFLSeasonPhase, {});
      currentSeasonPhase = seasonPhaseInfo?.phase || "UNKNOWN";
      console.log(`Current NFL season phase: ${currentSeasonPhase}`);
    } catch (error) {
      console.warn("Failed to get NFL season phase:", error);
    }
    
    const seasonBased = await ctx.runQuery(internal.contentScheduling.getSeasonBasedSchedules, {});
    const relative = await ctx.runQuery(internal.contentScheduling.getRelativeSchedules, {});

    let scheduled = 0;
    let skipped = 0;
    // One calendar-derivation summary log line per league per cron run (spec:
    // "log a one-line summary per league when the calendar is derived") -
    // several LEAGUE_RELATIVE_CONTENT_TYPES rows can derive the same league's
    // calendar in one pass; only the first logs it.
    const loggedCalendarForLeague = new Set<string>();

    // Helper to dedupe and schedule with intelligent filtering
    const maybeSchedule = async (schedule: any, scheduledFor: number, extraContext?: any) => {
      // Check if this content type should be scheduled based on current season phase and league state
      const shouldScheduleResult = await shouldScheduleContentForLeague(ctx, schedule, currentSeasonPhase, scheduledFor);
      
      if (!shouldScheduleResult.should) {
        console.log(`Skipping ${schedule.contentType} for league ${schedule.leagueId}: ${shouldScheduleResult.reason}`);
        skipped += 1;
        return;
      }

      const targetWeek: number | undefined = extraContext?.week;
      const targetSeason: number | undefined = extraContext?.seasonId;

      if (targetWeek !== undefined && targetSeason !== undefined) {
        // Week-scoped content (playoff_picture runs three weeks running), so the
        // per-season "already exists" check would wrongly swallow weeks 13-14.
        const existingForPeriod = await ctx.runQuery(internal.contentScheduling.findScheduledContentForPeriod, {
          leagueId: schedule.leagueId,
          contentType: schedule.contentType,
          seasonId: targetSeason,
          week: targetWeek,
        });
        if (existingForPeriod) {
          console.log(`Skipping ${schedule.contentType} for league ${schedule.leagueId}: season ${targetSeason} week ${targetWeek} already scheduled`);
          skipped += 1;
          return;
        }
      } else {
        // Check for duplicate content
        const existingCheck = await ctx.runQuery(internal.contentScheduling.checkExistingContent, {
          leagueId: schedule.leagueId,
          contentType: schedule.contentType,
          seasonId: targetSeason,
        });

        if (existingCheck.hasExistingContent || existingCheck.hasScheduledContent) {
          console.log(`Skipping ${schedule.contentType} for league ${schedule.leagueId}: content already exists or scheduled`);
          skipped += 1;
          return;
        }
      }

      // 4-hour dedupe window around target time
      const startTime = scheduledFor - 2 * 60 * 60 * 1000;
      const endTime = scheduledFor + 2 * 60 * 60 * 1000;
      const existing = await ctx.runQuery(internal.contentScheduling.findExistingJobWithinWindow, {
        contentScheduleId: schedule._id,
        startTime,
        endTime,
      });
      if (existing) {
        skipped += 1;
        return;
      }

      await ctx.runMutation(internal.contentScheduling.scheduleContentGeneration, {
        leagueId: schedule.leagueId,
        contentScheduleId: schedule._id,
        contentType: schedule.contentType,
        scheduledFor,
        week: targetWeek,
        seasonId: targetSeason,
        writerPersona: schedule.preferredPersona || defaultPersonaFor(schedule.contentType),
        contextData: extraContext,
      });
      scheduled += 1;
      console.log(`Scheduled ${schedule.contentType} for league ${schedule.leagueId} at ${new Date(scheduledFor)} (${shouldScheduleResult.reason})`);
    };

    // Process relative schedules (e.g., draft_date - offset)
    for (const s of relative) {
      try {
        const leagueSeason = await ctx.runQuery(internal.contentScheduling.getLeagueSeason, {
          leagueId: s.leagueId,
        });
        const seasonId = leagueSeason?.seasonId || new Date().getFullYear();
        const seasonData = await ctx.runQuery(internal.nflSeasonBoundaries.getNFLSeasonBoundaries, { year: seasonId });
        if (!seasonData) continue;

        if (s.schedule.type === "relative" && s.schedule.relativeTo === "draft_date") {
          // Find league draft date from leagueSeasons via internal query (ctx.db not available in actions)
          const ls = await ctx.runQuery(internal.contentScheduling.getLeagueSeasonDoc, { leagueId: s.leagueId, seasonId });

          // A completed draft has no "before the draft" window left to fill
          // (mock_draft's whole point is a pre-draft preview) - once ESPN
          // reports it drafted, there's nothing left to schedule here no
          // matter what draftSettings.date says.
          if (ls?.draftInfo?.drafted === true) { skipped += 1; continue; }

          // resolveScheduledDraftDate distinguishes the SCHEDULED start
          // (draftSettings.date) from draftInfo.draftDate, which is the
          // COMPLETION time (or the sentinel `1`) - only meaningful after
          // the draft, so it's a fallback for rows synced before
          // draftSettings started being resolved, not the primary source.
          const resolved = resolveScheduledDraftDate({
            draftSettings: ls?.draftSettings,
            draftInfo: ls?.draftInfo,
          });
          const draftDate = resolved.scheduledAt ?? resolved.completedAt;
          if (!draftDate) { skipped += 1; continue; }

          const tz = s.timezone || "America/New_York";
          const draftInTZ = convertUTCToTimeZone(new Date(draftDate), tz);
          // Apply offsetDays and set hour/minute
          const localTarget = new Date(draftInTZ);
          localTarget.setDate(localTarget.getDate() + (s.schedule.offsetDays || 0));
          localTarget.setHours(s.schedule.hour, s.schedule.minute, 0, 0);
          const scheduledFor = convertTimeZoneToUTC(localTarget, tz).getTime();

          // Skip once the computed slot is already in the past - e.g. a
          // mock_draft row (offsetDays: -7) whose 7-days-before instant has
          // already gone by. Without this, a draft date only recently made
          // available would immediately backfill a mock draft article for a
          // moment that already happened.
          if (scheduledFor <= Date.now()) { skipped += 1; continue; }

          await maybeSchedule(s, scheduledFor, {
            seasonId,
            additionalContext: { scheduleType: "relative", relativeTo: "draft_date" },
          });
        }
      } catch (e) {
        // skip silently
      }
    }

    // Process season_based schedules
    for (const s of seasonBased) {
      try {
        const leagueSeason = await ctx.runQuery(internal.contentScheduling.getLeagueSeason, {
          leagueId: s.leagueId,
        });
        const seasonId = leagueSeason?.seasonId || new Date().getFullYear();
        const seasonData = await ctx.runQuery(internal.nflSeasonBoundaries.getNFLSeasonBoundaries, { year: seasonId });
        if (!seasonData) { skipped += 1; continue; }
        const tz = s.timezone || "America/New_York";

        let baseDate: number | null = null;
        let targetWeek: number | undefined = undefined;
        // Map triggers to boundaries
        if (s.schedule.type !== "season_based") { skipped += 1; continue; }
        const trigger = s.schedule.trigger as string;

        // League-relative resolution (audit fix, convex/lib/leagueCalendar.ts):
        // for the five content types whose DEFAULT_SCHEDULES trigger encodes
        // a fixed NFL-week number (`week_9`, `weeks_12_14`, `week_14`,
        // `championship_week` -> NFL week 21, `champion_determined` ->
        // Super Bowl Sunday), derive THIS league's actual regular-season
        // length / playoff shape from its synced ESPN settings
        // (`leagueSeasons.settings`, populated by `espnSync.ts`'s
        // `buildSeasonSettings`) instead. Falls back to the fixed-trigger
        // switch below - unchanged - whenever the league has no synced
        // settings yet (no current-season sync has run with the parser).
        let usedLeagueCalendar = false;
        if (LEAGUE_RELATIVE_CONTENT_TYPES.has(s.contentType)) {
          const leagueSeasonDoc = await ctx.runQuery(internal.contentScheduling.getLeagueSeasonDoc, {
            leagueId: s.leagueId,
            seasonId,
          });
          const calendarInput = leagueCalendarInputFromSettings(leagueSeasonDoc?.settings);

          if (calendarInput) {
            const calendar = deriveLeagueCalendar(calendarInput);
            usedLeagueCalendar = true;

            switch (s.contentType) {
              case "mid_season_awards": {
                const wb = seasonData.weekBoundaries.find((w: WeekBoundary) => w.week === calendar.midSeasonWeek);
                baseDate = wb?.start ?? null;
                targetWeek = wb?.week;
                break;
              }
              case "hall_of_shame": {
                const wb = seasonData.weekBoundaries.find(
                  (w: WeekBoundary) => w.week === calendar.lastRegularSeasonWeek,
                );
                baseDate = wb?.start ?? null;
                targetWeek = wb?.week;
                break;
              }
              case "playoff_picture": {
                // Pick the earliest of the three playoff-picture weeks whose
                // slot has not gone by yet, so one row is created per week as
                // the range comes around (same "in-range" behaviour the old
                // weeks_12_14 trigger had, just on the league's own weeks).
                const now = Date.now();
                for (const week of calendar.playoffPictureWeeks) {
                  const wb = seasonData.weekBoundaries.find((w: WeekBoundary) => w.week === week);
                  if (!wb) continue;
                  if (wb.end < now) continue; // week already over
                  baseDate = wb.start;
                  targetWeek = week;
                  break;
                }
                break;
              }
              case "championship_manifesto": {
                // Playoffs' final round preview: the FIRST championship week,
                // which starts the Tuesday the preceding round's finality is
                // known (spec: schedule Tuesday 09:00 local of that week -
                // see the hour/delayDays on this type's DEFAULT_SCHEDULES entry).
                const firstChampionshipWeek = calendar.championshipWeeks[0];
                const wb = seasonData.weekBoundaries.find((w: WeekBoundary) => w.week === firstChampionshipWeek);
                baseDate = wb?.start ?? null;
                targetWeek = wb?.week;
                break;
              }
              case "season_recap": {
                // The Tuesday after the LAST championship week ends (spec) -
                // `wb.end` (that week's Monday-night close) + this type's
                // `delayDays: 1` lands the target on Tuesday.
                const wb = seasonData.weekBoundaries.find((w: WeekBoundary) => w.week === calendar.seasonEndWeek);
                baseDate = wb?.end ?? null;
                targetWeek = wb?.week;
                break;
              }
            }

            if (!loggedCalendarForLeague.has(s.leagueId)) {
              loggedCalendarForLeague.add(s.leagueId);
              const summary = describeLeagueCalendar(calendar, {
                regularSeasonMatchupPeriods: calendarInput.regularSeasonMatchupPeriods,
                playoffTeamCount: (leagueSeasonDoc?.settings as { playoffTeamCount?: number } | undefined)
                  ?.playoffTeamCount,
                playoffMatchupPeriodLength: calendarInput.playoffMatchupPeriodLength,
              });
              console.log(`league ${s.leagueId}: ${summary} (derived from synced settings)`);
            }
          } else {
            console.log(
              `league ${s.leagueId}: no parsed ESPN settings synced yet for ${s.contentType} - ` +
                `falling back to the fixed NFL-week schedule (${trigger})`,
            );
          }
        }

        if (!usedLeagueCalendar) {
          switch (trigger) {
            case "season_start":
              baseDate = seasonData.phases.regularSeason.start;
              break;
            case "champion_determined":
              // Use end of Super Bowl day as when champion is known
              baseDate = seasonData.phases.superBowl.end;
              break;
            case "championship_week": {
              const champWeek = seasonData.playoffStructure.championshipWeek;
              const wb = seasonData.weekBoundaries.find((w: WeekBoundary) => w.week === champWeek);
              baseDate = wb?.start ?? null;
              targetWeek = wb?.week;
              break;
            }
            default: {
              // Handle triggers like week_8
              const weekMatch = /^week_(\d+)$/.exec(trigger);
              if (weekMatch) {
                const weekNum = parseInt(weekMatch[1], 10);
                const wb = seasonData.weekBoundaries.find((w: WeekBoundary) => w.week === weekNum);
                baseDate = wb?.start ?? null;
                targetWeek = wb?.week;
                break;
              }

              // Handle in-range triggers like weeks_12_14 (playoff_picture): pick
              // the earliest week in the range whose slot has not gone by yet, so
              // one row is created per week as the range comes around.
              const rangeMatch = /^weeks_(\d+)_(\d+)$/.exec(trigger);
              if (rangeMatch) {
                const from = parseInt(rangeMatch[1], 10);
                const to = parseInt(rangeMatch[2], 10);
                const now = Date.now();
                for (let week = from; week <= to; week++) {
                  const wb = seasonData.weekBoundaries.find((w: WeekBoundary) => w.week === week);
                  if (!wb) continue;
                  if (wb.end < now) continue; // week already over
                  baseDate = wb.start;
                  targetWeek = week;
                  break;
                }
              }
              break;
            }
          }
        }

        if (!baseDate) { skipped += 1; continue; }

        // Apply optional delayDays, align to the requested weekday inside the
        // triggered week, and set hour/minute - all in the league timezone.
        const baseLocal = convertUTCToTimeZone(new Date(baseDate), tz);
        const localTarget = new Date(baseLocal);
        if (typeof s.schedule.delayDays === 'number') {
          localTarget.setDate(localTarget.getDate() + s.schedule.delayDays);
        }
        if (typeof s.schedule.dayOfWeek === 'number') {
          let forward = s.schedule.dayOfWeek - localTarget.getDay();
          if (forward < 0) forward += 7;
          localTarget.setDate(localTarget.getDate() + forward);
        }
        localTarget.setHours(s.schedule.hour, s.schedule.minute, 0, 0);
        const scheduledFor = convertTimeZoneToUTC(localTarget, tz).getTime();

        await maybeSchedule(s, scheduledFor, {
          seasonId,
          week: targetWeek,
          additionalContext: { scheduleType: "season_based", trigger },
        });
      } catch (e) {
        // skip this schedule
      }
    }

    console.log(`=== scheduleSeasonAndRelativeContentCron COMPLETE ===`);
    console.log(`Scheduled: ${scheduled}, Skipped: ${skipped}, Season Phase: ${currentSeasonPhase}`);
    
    return { scheduled, skipped, seasonPhase: currentSeasonPhase };
  },
});

// Helper function to determine if content should be scheduled for a specific league
async function shouldScheduleContentForLeague(
  ctx: any, 
  schedule: any, 
  currentSeasonPhase: string, 
  scheduledFor: number
): Promise<{ should: boolean; reason: string }> {
  const contentType = schedule.contentType;
  
  // Get league creation date
  let league;
  try {
    league = await ctx.runQuery(internal.contentScheduling.getLeagueById, {
      leagueId: schedule.leagueId,
    });
  } catch (e) {
    return { should: false, reason: "League not found" };
  }
  
  if (!league) {
    return { should: false, reason: "League not found" };
  }
  
  const leagueCreatedAt = league.createdAt;
  const now = Date.now();
  const leagueAge = now - leagueCreatedAt;
  const daysSinceCreation = leagueAge / (1000 * 60 * 60 * 24);
  
  // Season-specific content logic
  switch (contentType) {
    case "season_welcome":
      // Rings in every season, not just a league's first one (owner
      // directive, Sept 2026: "this can probably be repurposed... and should
      // be included in the subscription"). Allowed in PRESEASON or
      // OFFSEASON - OFFSEASON is the fallback `nflSeasonBoundaries` also
      // reports for the gap between preseason end and regular season start,
      // which is exactly when the `season_start` trigger lands - for either
      // a brand-new league, or inside that year's kickoff window.
      if (currentSeasonPhase === "PRESEASON" || currentSeasonPhase === "OFFSEASON") {
        // If league is brand new (less than 7 days old), allow season_welcome
        if (daysSinceCreation < 7) {
          return { should: true, reason: `new league in ${currentSeasonPhase} phase` };
        }
        // Aug 1 through Sep 30 of `scheduledFor`'s OWN year (audit finding:
        // this used to be Aug 1-31 of the wall-clock year, not scheduledFor's
        // - the season_start trigger lands Sep 8-10 depending on the year, so
        // the old window missed it every single year).
        const scheduledYear = new Date(scheduledFor).getFullYear();
        const kickoffWindowStart = new Date(scheduledYear, 7, 1).getTime(); // Aug 1
        const kickoffWindowEnd = new Date(scheduledYear, 9, 1).getTime(); // Oct 1 (exclusive)
        if (scheduledFor >= kickoffWindowStart && scheduledFor < kickoffWindowEnd) {
          return { should: true, reason: `new season start in ${currentSeasonPhase} phase` };
        }
      }
      return { should: false, reason: `wrong season phase for season_welcome: ${currentSeasonPhase}` };
      
    case "season_recap":
      // A fantasy season ends with the league's championship round (NFL weeks
      // ~15-18), which is inside the NFL's own REGULAR_SEASON phase. Timing is
      // resolved from the league's synced settings (leagueCalendar: the Tuesday
      // after seasonEndWeek) and gated by isWeekFinal, so the phase only has to
      // rule out the preseason.
      if (currentSeasonPhase === "PRESEASON" || currentSeasonPhase === "DRAFT") {
        return { should: false, reason: `season not started: ${currentSeasonPhase}` };
      }
      return { should: true, reason: `season underway or ended (${currentSeasonPhase}); date derives from the league's schedule` };
      
    case "championship_manifesto":
      // Same reasoning: the fantasy title game falls in the NFL regular season.
      // Gating on the NFL PLAYOFFS phase meant this never fired for any league.
      if (
        currentSeasonPhase === "REGULAR_SEASON" ||
        currentSeasonPhase === "PLAYOFFS" ||
        currentSeasonPhase === "SUPER_BOWL"
      ) {
        return { should: true, reason: `season underway (${currentSeasonPhase}); championship week derives from the league's schedule` };
      }
      return { should: false, reason: `not in season: ${currentSeasonPhase}` };
      
    case "mid_season_awards":
      // Only schedule during regular season (around week 8)
      if (currentSeasonPhase === "REGULAR_SEASON") {
        return { should: true, reason: `mid-season during ${currentSeasonPhase}` };
      }
      return { should: false, reason: `not regular season: ${currentSeasonPhase}` };
      
    case "mock_draft":
      // Schedule based on league's draft date, regardless of NFL season
      return { should: true, reason: "draft-dependent content, season-independent" };
      
    default:
      // For unknown content types, be conservative - only schedule during active season
      if (currentSeasonPhase === "REGULAR_SEASON" || currentSeasonPhase === "PLAYOFFS") {
        return { should: true, reason: `unknown content type, allowing during active season: ${currentSeasonPhase}` };
      }
      return { should: false, reason: `unknown content type, blocking during inactive season: ${currentSeasonPhase}` };
  }
}

// Helper query to get league by ID
export const getLeagueById = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.leagueId);
  },
});

// Helper query to get a league's current season from league.espnData
export const getLeagueSeason = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) return null;
    const seasonId = league.espnData?.seasonId || new Date().getFullYear();
    return { seasonId };
  },
});

// Fetch a specific league season document (used inside actions where ctx.db isn't available)
export const getLeagueSeasonDoc = internalQuery({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  handler: async (ctx, args) => {
    const ls = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();
    return ls;
  },
});

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
            q.eq(q.field("status"), "generating"),
            // A backlogged row already exists for this period/window - don't
            // schedule a second one behind it (owner directive, Sept 2026).
            q.eq(q.field("status"), "backlogged")
          )
        )
      )
      .first();

    return existingJobs;
  },
});

// Get scheduled content by ID
export const getById = internalQuery({
  args: {
    id: v.id("scheduledContent"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Check if content already exists for a league/season/content type combination
export const checkExistingContent = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    contentType: v.string(),
    seasonId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const targetSeason = args.seasonId || nflSeasonYearFor();

    // NFL season "targetSeason" runs from Aug 1 of that year through Jul 31
    // of the following year (not the calendar year) - e.g. content created
    // in January 2027 still belongs to the 2026 season.
    const seasonWindowStart = new Date(targetSeason, 7, 1).getTime(); // Aug 1 of targetSeason
    const seasonWindowEnd = new Date(targetSeason + 1, 7, 1).getTime(); // Aug 1 of targetSeason + 1

    // A row counts for `targetSeason` when its own `seasonId` says so
    // directly, or - for a legacy row written before that stamp existed -
    // when `seasonId` is absent and `createdAt` falls in the season window.
    // A row whose `seasonId` is set to a DIFFERENT season never counts,
    // whatever its `createdAt` says: this is what keeps a backfilled 2025
    // article (createdAt in 2026, seasonId 2025) from reading as "2026
    // content already exists" (audit finding: aiContent.seasonId used to be
    // stamped with the league's CURRENT season regardless of the period the
    // article was actually about).
    const seasonMatch = (q: any) =>
      q.or(
        q.eq(q.field("seasonId"), targetSeason),
        q.and(
          q.eq(q.field("seasonId"), undefined),
          q.gte(q.field("createdAt"), seasonWindowStart),
          q.lt(q.field("createdAt"), seasonWindowEnd),
        ),
      );

    // Check aiContent table for existing content of this type for this league/season
    const existingContent = await ctx.db
      .query("aiContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.and(q.eq(q.field("type"), args.contentType), seasonMatch(q)))
      .first();

    // Also check scheduled content table for pending/generating content
    const scheduledContent = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) =>
        q.and(
          q.eq(q.field("contentType"), args.contentType),
          q.or(
            q.eq(q.field("status"), "pending"),
            q.eq(q.field("status"), "generating"),
            // A backlogged row already exists for this period/window - don't
            // schedule a second one behind it (owner directive, Sept 2026).
            q.eq(q.field("status"), "backlogged")
          ),
          seasonMatch(q),
        )
      )
      .first();

    return {
      hasExistingContent: !!existingContent,
      hasScheduledContent: !!scheduledContent,
      existingContent,
      scheduledContent,
    };
  },
});
