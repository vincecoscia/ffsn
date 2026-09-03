/**
 * Season backfill (brief A, owner request Sept 2026): the owner ran FFSN for a season but stopped
 * generating content partway through - this tool generates the WHOLE season's automatic content
 * now, written as of each historical week (never the league's live current data), without asking
 * managers for comment, and published quietly (no reader notification/email storm) and backdated
 * so the feed reads chronologically. The same tool works on the CURRENT season too (e.g. to print
 * one missed week).
 *
 * *** This spends real API budget and publishes to a LIVE league. It is meant to be run by the
 * operator against prod, not exercised in dev. ***
 *
 *   # 1. See what would happen, at zero cost:
 *   npx convex run --prod seasonBackfill:planSeasonBackfill '{"leagueId":"<id>","seasonId":2025}'
 *
 *   # 2. Dry-run the action too (same plan, from the action's own resolution path):
 *   npx convex run --prod seasonBackfill:runSeasonBackfill '{"leagueId":"<id>","seasonId":2025,"dryRun":true}'
 *
 *   # 3. Run it for real. Each call processes ONE article and reschedules itself after `gapMs`
 *   #    (default 60s) until the plan is exhausted - watch `npx convex logs --prod` for the
 *   #    `[backfill] ...` line each hop prints.
 *   npx convex run --prod seasonBackfill:runSeasonBackfill '{"leagueId":"<id>","seasonId":2025}'
 *
 *   # 4. Check on it any time (also works mid-run):
 *   npx convex run --prod seasonBackfill:getSeasonBackfillStatus '{"leagueId":"<id>","seasonId":2025}'
 *
 * Kill switch: the self-rescheduling chain checks `SEASON_BACKFILL_STOP` before every hop.
 *   npx convex env set --prod SEASON_BACKFILL_STOP 1      # stop it
 *   npx convex env remove --prod SEASON_BACKFILL_STOP     # let it run again (or a fresh call)
 *
 * Cost: about $0.20-0.35 per article (measured, see project memory) - a full 14+3-week season is
 * roughly 55-60 articles, i.e. $15-20. `planSeasonBackfill`'s `estimatedUsd` gives the exact count
 * for a given league/season/filter before anything is spent.
 *
 * Every article this tool produces is BACKDATED: `scheduledContent.scheduledFor` (and, once
 * published, `aiContent.publishedAt`) is stamped to when the article would actually have printed
 * during that season, not to the moment this tool ran - see `convex/lib/seasonBackfillPlan.ts` for
 * the print-time math.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation, internalAction, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
// Plain function/data exports (not registered Convex functions), imported as values exactly like
// convex/devTools.ts already does - see this repo's gotcha about a cross-module VALUE import of an
// `internal`-referencing module's REGISTERED functions (query/mutation/action objects), which is a
// different risk than importing a plain `Record` or a plain `(x: string) => string` function.
import { DEFAULT_SCHEDULES, defaultPersonaFor } from "./contentScheduling";
import { contentTemplates } from "../src/lib/ai/content-templates";
import { deriveLeagueCalendar, describeLeagueCalendar, leagueCalendarInputFromSettings } from "./lib/leagueCalendar";
import {
  buildSeasonBackfillPlan,
  localMidnightUtc,
  type SeasonBackfillPlanItem,
} from "./lib/seasonBackfillPlan";
import { leagueCurrentSeason } from "./lib/season";

/** `contentSchedules.contentType` is a literal union; this tool builds one from a plain string. */
function asContentType(value: string): Doc<"contentSchedules">["contentType"] {
  if (!(value in contentTemplates)) {
    throw new Error(`Unknown content type "${value}". Valid types: ${Object.keys(contentTemplates).sort().join(", ")}`);
  }
  return value as Doc<"contentSchedules">["contentType"];
}

/**
 * The real week-1 Tuesday for a handful of recent seasons, interpreted at 00:00 in the league's
 * timezone - the fallback for a season `nflSeasons` has no row for (per project memory, prod only
 * ever had a 2026 row; 2025 - the season this tool exists to backfill - has none).
 */
const NFL_WEEK1_TUESDAY: Record<number, string> = {
  2023: "2023-09-05",
  2024: "2024-09-03",
  2025: "2025-09-02",
  2026: "2026-09-08",
};

/**
 * Week-1 Tuesday resolution (spec order): `nflSeasons.weekBoundaries`'s week-1 `start` when that
 * season row exists; else `NFL_WEEK1_TUESDAY`; else the caller's explicit `week1TuesdayIso`; else
 * throw with a message telling the operator what to pass.
 */
async function resolveWeek1Tuesday(
  ctx: QueryCtx,
  args: { seasonId: number; timezone: string; week1TuesdayIso?: string }
): Promise<number> {
  const boundaries = await ctx.db
    .query("nflSeasons")
    .withIndex("by_year", (q) => q.eq("year", args.seasonId))
    .first();
  const week1 = boundaries?.weekBoundaries.find((w) => w.week === 1);
  // `nflSeasons` boundaries are stamped at UTC midnight (verified on dev and prod: week 1 of 2025
  // starts "2025-09-02T00:00:00Z"), which is Monday evening in a US timezone - taking the instant
  // as-is put every print time one day early. Keep only the calendar DATE and re-anchor it at
  // local midnight, the same way the fallback table is read.
  if (week1) return localMidnightUtc(new Date(week1.start).toISOString().slice(0, 10), args.timezone);

  const fallbackIso = NFL_WEEK1_TUESDAY[args.seasonId];
  if (fallbackIso) return localMidnightUtc(fallbackIso, args.timezone);

  if (args.week1TuesdayIso) return localMidnightUtc(args.week1TuesdayIso, args.timezone);

  throw new Error(
    `No week-1 Tuesday known for season ${args.seasonId}: no nflSeasons row, and it isn't in ` +
      `NFL_WEEK1_TUESDAY. Pass week1TuesdayIso (e.g. "2025-09-02") explicitly.`
  );
}

const DEFAULT_TIMEZONE_FALLBACK = "America/New_York";

/* -------------------------------------------------------------------------- *
 * planSeasonBackfill
 * -------------------------------------------------------------------------- */

const planItemValidator = v.object({
  index: v.number(),
  contentType: v.string(),
  week: v.number(),
  asOfWeek: v.number(),
  printAt: v.number(),
  status: v.union(v.literal("planned"), v.literal("exists"), v.literal("unsupported")),
  reason: v.optional(v.string()),
});

export const planSeasonBackfill = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    types: v.optional(v.array(v.string())),
    weeks: v.optional(v.array(v.number())),
    week1TuesdayIso: v.optional(v.string()),
    /** Regenerate items that already have an article (requires `types` or `weeks`, so a full-season
     *  re-run can never happen by accident). The old article stays; the new one supersedes it. */
    force: v.optional(v.boolean()),
  },
  returns: v.object({
    calendar: v.string(),
    week1Tuesday: v.number(),
    items: v.array(planItemValidator),
    counts: v.object({ planned: v.number(), exists: v.number(), unsupported: v.number() }),
    estimatedUsd: v.number(),
  }),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const preferences = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();
    const timezone = preferences?.timezone?.trim() || DEFAULT_TIMEZONE_FALLBACK;

    const week1Tuesday = await resolveWeek1Tuesday(ctx, {
      seasonId: args.seasonId,
      timezone,
      week1TuesdayIso: args.week1TuesdayIso,
    });

    const seasonRow = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();
    const calendarInput = leagueCalendarInputFromSettings(seasonRow?.settings);
    // Fallback shape (convex/lib/leagueCalendar.ts's header): 14-week regular season, 3 single-week
    // playoff rounds - used whenever the season's real ESPN settings aren't parseable yet.
    const calendar = deriveLeagueCalendar(
      calendarInput ?? { regularSeasonMatchupPeriods: 14, playoffRounds: 3, playoffMatchupPeriodLength: 1 }
    );

    // Existing articles for this season: stamped rows (aiContent.seasonId) PLUS legacy rows that
    // predate the seasonId stamp, whose createdAt falls inside the season's calendar window.
    const stamped = await ctx.db
      .query("aiContent")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .take(500);
    const seasonWindowStart = new Date(args.seasonId, 7, 1).getTime(); // Aug 1 of seasonId
    const seasonWindowEnd = new Date(args.seasonId + 1, 7, 1).getTime(); // Aug 1 of seasonId + 1
    const legacy = await ctx.db
      .query("aiContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) =>
        q.and(
          q.eq(q.field("seasonId"), undefined),
          q.gte(q.field("createdAt"), seasonWindowStart),
          q.lt(q.field("createdAt"), seasonWindowEnd)
        )
      )
      .take(500);
    if (args.force && !args.types && !args.weeks) {
      throw new Error("force requires a types or weeks filter (refusing to regenerate a whole season)");
    }
    // A failed article is not "existing" content: the item is planned again on the next run.
    const existing = args.force
      ? []
      : [...stamped, ...legacy]
          .filter((a) => a.status !== "failed")
          .map((a) => ({ contentType: a.type, week: a.metadata.week }));

    // hasTradesForSeason: the `trades` table (never populated in prod - espnSync.storeTrades's only
    // caller is commented out) OR a real TRADE_ACCEPT transaction.
    const tradeRows = await ctx.db
      .query("trades")
      .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .take(1);
    let hasTradesForSeason = tradeRows.length > 0;
    if (!hasTradesForSeason) {
      const seasonTransactions = await ctx.db
        .query("transactions")
        .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
        .take(500);
      hasTradesForSeason = seasonTransactions.some((t) => t.type === "TRADE_ACCEPT");
    }

    const isCurrentSeason = args.seasonId === leagueCurrentSeason(league);

    const items = buildSeasonBackfillPlan({
      seasonId: args.seasonId,
      calendar,
      week1Tuesday,
      timezone,
      existing,
      types: args.types,
      weeks: args.weeks,
      hasTradesForSeason,
      isCurrentSeason,
    });

    const counts = { planned: 0, exists: 0, unsupported: 0 };
    for (const item of items) counts[item.status] += 1;

    return {
      calendar: describeLeagueCalendar(calendar, {
        regularSeasonMatchupPeriods: calendarInput?.regularSeasonMatchupPeriods ?? 14,
        playoffMatchupPeriodLength: calendarInput?.playoffMatchupPeriodLength ?? 1,
      }),
      week1Tuesday,
      items,
      counts,
      estimatedUsd: Math.round(counts.planned * 0.3 * 100) / 100,
    };
  },
});

/* -------------------------------------------------------------------------- *
 * Processing one item
 * -------------------------------------------------------------------------- */

/**
 * The league's `contentSchedules` row for this type, creating one from `DEFAULT_SCHEDULES` when
 * missing - the exact same source `createDefaultContentSchedules` uses at league import, so a
 * backfilled league's calendar row ends up indistinguishable from an organically-created one. A
 * DISABLED existing row is never enabled here: the commissioner's opt-out is respected, and the
 * item is reported skipped instead.
 */
export const ensureScheduleRow = internalMutation({
  args: { leagueId: v.id("leagues"), contentType: v.string() },
  returns: v.union(
    v.object({ status: v.literal("disabled") }),
    v.object({ status: v.literal("ok"), contentScheduleId: v.id("contentSchedules") })
  ),
  handler: async (ctx, args) => {
    const contentType = asContentType(args.contentType);

    const existing = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league_type", (q) => q.eq("leagueId", args.leagueId).eq("contentType", contentType))
      .first();
    if (existing) {
      if (!existing.enabled) return { status: "disabled" as const };
      return { status: "ok" as const, contentScheduleId: existing._id };
    }

    const config = DEFAULT_SCHEDULES[contentType];
    if (!config) throw new Error(`No DEFAULT_SCHEDULES entry for "${contentType}"`);

    const preferences = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();
    const timezone = preferences?.timezone?.trim() || DEFAULT_TIMEZONE_FALLBACK;

    const now = Date.now();
    const contentScheduleId = await ctx.db.insert("contentSchedules", {
      leagueId: args.leagueId,
      contentType,
      enabled: config.enabled,
      timezone,
      schedule: config.schedule,
      preferredPersona: defaultPersonaFor(contentType),
      createdAt: now,
      updatedAt: now,
    });

    if (!config.enabled) return { status: "disabled" as const };
    return { status: "ok" as const, contentScheduleId };
  },
});

/**
 * The backfill row for one plan item - `backfill: true`, `skipCommentRequests: true`,
 * `scheduledFor` in the PAST (the backdate), and `maxAttempts: 1` (a backfill row is never worth
 * the cron's ordinary retry budget; a failure here just gets reported and the operator re-runs
 * that one item by hand). Idempotent on `by_league_type_season_week`: a pending/generating/
 * completed row for this exact (league, type, season, week) is reused rather than duplicated.
 */
export const createBackfillRow = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    contentScheduleId: v.id("contentSchedules"),
    contentType: v.string(),
    seasonId: v.number(),
    week: v.number(),
    printAt: v.number(),
    force: v.optional(v.boolean()),
  },
  returns: v.object({ scheduledContentId: v.id("scheduledContent"), reused: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league_type_season_week", (q) =>
        q
          .eq("leagueId", args.leagueId)
          .eq("contentType", args.contentType)
          .eq("seasonId", args.seasonId)
          .eq("week", args.week)
      )
      .first();
    if (!args.force && existing && (existing.status === "pending" || existing.status === "generating" || existing.status === "completed")) {
      return { scheduledContentId: existing._id, reused: true };
    }

    const now = Date.now();
    const scheduledContentId = await ctx.db.insert("scheduledContent", {
      leagueId: args.leagueId,
      contentScheduleId: args.contentScheduleId,
      contentType: args.contentType,
      scheduledFor: args.printAt,
      status: "pending",
      attempts: 0,
      maxAttempts: 1,
      seasonId: args.seasonId,
      week: args.week,
      contextData: { seasonId: args.seasonId, week: args.week },
      skipCommentRequests: true,
      backfill: true,
      createdAt: now,
      updatedAt: now,
    });
    return { scheduledContentId, reused: false };
  },
});

/** Cancel a backfill row that will never otherwise resolve (deferred, timed out, or refused outright) - the cron ignores `backfill: true` rows, so a pending one would sit forever. A no-op once the row is already terminal. */
export const cancelBackfillRow = internalMutation({
  args: { scheduledContentId: v.id("scheduledContent"), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledContentId);
    if (!row) return null;
    if (row.status === "completed" || row.status === "cancelled" || row.status === "failed") return null;
    await ctx.db.patch(args.scheduledContentId, {
      status: "cancelled",
      cancelReason: "backfill_skipped",
      errorMessage: args.message,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** How often `runSeasonBackfill` polls a dispatched generation before giving up on it. */
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 420_000;
const DEFAULT_GAP_MS = 60_000;

type ProcessOutcome = {
  outcome: string;
  articleId?: Id<"aiContent">;
  title?: string;
  costUsd?: number;
};

/** Process exactly one plan item end to end: schedule row, backfill row, the real pipeline, then poll it to a terminal state. Never throws - every failure mode ends in a logged outcome string. */
async function processPlanItem(
  ctx: {
    runQuery: <T>(ref: any, args: any) => Promise<T>;
    runMutation: <T>(ref: any, args: any) => Promise<T>;
    runAction: <T>(ref: any, args: any) => Promise<T>;
  },
  args: { leagueId: Id<"leagues">; seasonId: number; pollTimeoutMs?: number; force?: boolean },
  item: SeasonBackfillPlanItem
): Promise<ProcessOutcome> {
  const label = `${args.seasonId} ${item.contentType} wk${item.week}`;

  const scheduleResult = await ctx.runMutation<
    { status: "disabled" } | { status: "ok"; contentScheduleId: Id<"contentSchedules"> }
  >(internal.seasonBackfill.ensureScheduleRow, { leagueId: args.leagueId, contentType: item.contentType });
  if (scheduleResult.status === "disabled") {
    console.log(`[backfill] ${label} -> skipped (schedule disabled)`);
    return { outcome: "skipped: schedule disabled" };
  }

  const { scheduledContentId } = await ctx.runMutation<{ scheduledContentId: Id<"scheduledContent">; reused: boolean }>(
    internal.seasonBackfill.createBackfillRow,
    {
      leagueId: args.leagueId,
      contentScheduleId: scheduleResult.contentScheduleId,
      contentType: item.contentType,
      seasonId: args.seasonId,
      week: item.week,
      printAt: item.printAt,
      force: args.force,
    }
  );

  const run = await ctx.runAction<{ success: boolean; message?: string; contentId?: string; deferred?: boolean }>(
    internal.contentScheduling.processScheduledContent,
    {
      scheduledContentId,
      forcePeriod: { seasonId: args.seasonId, week: item.week },
      disableBatching: true,
      awaitGeneration: false,
    }
  );

  const articleId = run.contentId as Id<"aiContent"> | undefined;
  const deadline = Date.now() + (args.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);

  type RunResult = {
    rowStatus: string;
    rowError?: string;
    deferrals?: number;
    articleStatus?: string;
    articleTitle?: string;
    costUsd?: number;
  };
  let result = await ctx.runQuery<RunResult>(internal.devTools.getDevRunResult, { scheduledContentId, articleId });

  // A row that comes back "pending" right after dispatch was deferred (stale data, week not final
  // yet) or refused into a state that leaves it pending - a SUCCESSFUL dispatch always leaves the
  // row "generating" (processScheduledContent's own comment: "Leave status as generating"), never
  // reverts it, so "pending" here can only mean one of those. Nothing will ever pick it back up
  // (the cron ignores backfill rows), so cancel it now rather than let it sit forever.
  if (result.rowStatus === "pending") {
    const message = result.rowError ?? run.message ?? "processScheduledContent deferred or refused";
    await ctx.runMutation(internal.seasonBackfill.cancelBackfillRow, { scheduledContentId, message });
    console.log(`[backfill] ${label} -> deferred/refused: ${message}`);
    return { outcome: `deferred_or_refused: ${message}` };
  }

  if (result.rowStatus === "cancelled" || result.rowStatus === "failed") {
    const message = result.rowError ?? "unknown reason";
    console.log(`[backfill] ${label} -> ${result.rowStatus}: ${message}`);
    return { outcome: `${result.rowStatus}: ${message}`, articleId };
  }

  while (
    (result.rowStatus === "generating" || (articleId !== undefined && !result.articleStatus) || result.articleStatus === "generating") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    result = await ctx.runQuery<RunResult>(internal.devTools.getDevRunResult, { scheduledContentId, articleId });
  }

  if (result.rowStatus === "generating" || result.articleStatus === "generating") {
    const message = `still generating after ${(args.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS) / 1000}s`;
    await ctx.runMutation(internal.seasonBackfill.cancelBackfillRow, { scheduledContentId, message });
    console.log(`[backfill] ${label} -> timed out: ${message}`);
    return { outcome: `timed_out: ${message}`, articleId };
  }

  if (result.rowStatus === "cancelled" || result.rowStatus === "failed" || result.articleStatus === "failed") {
    const message = result.rowError ?? "unknown reason";
    console.log(`[backfill] ${label} -> ${result.articleStatus ?? result.rowStatus}: ${message}`);
    return { outcome: `${result.articleStatus ?? result.rowStatus}: ${message}`, articleId };
  }

  const outcome = result.articleStatus ?? result.rowStatus;
  const costLabel = typeof result.costUsd === "number" ? ` $${result.costUsd.toFixed(2)}` : "";
  const titleLabel = result.articleTitle ? ` "${result.articleTitle}"` : "";
  console.log(`[backfill] ${label} -> ${outcome}${titleLabel}${costLabel}`);
  return { outcome, articleId, title: result.articleTitle, costUsd: result.costUsd };
}

/* -------------------------------------------------------------------------- *
 * runSeasonBackfill
 * -------------------------------------------------------------------------- */

type SeasonBackfillPlan = {
  calendar: string;
  week1Tuesday: number;
  items: SeasonBackfillPlanItem[];
  counts: { planned: number; exists: number; unsupported: number };
  estimatedUsd: number;
};

// Explicit return type (Convex guideline: a same-file ctx.runQuery/runMutation/scheduler self-call
// otherwise makes TypeScript infer this handler - and everything that reads its result - as `any`).
type RunSeasonBackfillResult =
  | ({ dryRun: true } & SeasonBackfillPlan)
  | { outcome: string; remaining: number }
  | {
      processedIndex: number;
      contentType: string;
      week: number;
      outcome: string;
      articleId?: Id<"aiContent">;
      title?: string;
      costUsd?: number;
      nextIndex?: number;
      remaining: number;
    };

export const runSeasonBackfill = internalAction({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    dryRun: v.optional(v.boolean()),
    types: v.optional(v.array(v.string())),
    weeks: v.optional(v.array(v.number())),
    week1TuesdayIso: v.optional(v.string()),
    /** Regenerate items that already have an article (requires `types` or `weeks`, so a full-season
     *  re-run can never happen by accident). The old article stays; the new one supersedes it. */
    force: v.optional(v.boolean()),
    startIndex: v.optional(v.number()),
    maxItems: v.optional(v.number()),
    gapMs: v.optional(v.number()),
    pollTimeoutMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<RunSeasonBackfillResult> => {
    const plan: SeasonBackfillPlan = await ctx.runQuery(internal.seasonBackfill.planSeasonBackfill, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
      types: args.types,
      weeks: args.weeks,
      week1TuesdayIso: args.week1TuesdayIso,
      force: args.force,
    });

    if (args.dryRun) {
      return { dryRun: true as const, ...plan };
    }

    // Kill switch, checked before every hop (spec: brief A deliverable 4). Set with
    // `npx convex env set --prod SEASON_BACKFILL_STOP 1`; unset with `env remove` when done.
    if ((process.env.SEASON_BACKFILL_STOP ?? "").trim() === "1") {
      console.log(`[backfill] ${args.seasonId}: SEASON_BACKFILL_STOP=1 - stopping`);
      return { outcome: "stopped: SEASON_BACKFILL_STOP=1", remaining: plan.counts.planned };
    }

    const startIndex = args.startIndex ?? 0;
    const item = plan.items.find((i) => i.index >= startIndex && i.status === "planned");

    if (!item) {
      console.log(`[backfill] ${args.seasonId}: nothing left to process at/after index ${startIndex}`);
      return { outcome: "done", remaining: 0 };
    }

    const processed = await processPlanItem(ctx, args, item);

    const remainingItems = plan.items.filter((i) => i.index > item.index && i.status === "planned");
    const remainingBudget = args.maxItems === undefined ? undefined : args.maxItems - 1;
    const budgetLeft = remainingBudget === undefined || remainingBudget > 0;

    let nextIndex: number | undefined;
    if (remainingItems.length > 0 && budgetLeft) {
      nextIndex = item.index + 1;
      await ctx.scheduler.runAfter(args.gapMs ?? DEFAULT_GAP_MS, internal.seasonBackfill.runSeasonBackfill, {
        ...args,
        startIndex: nextIndex,
        maxItems: remainingBudget,
      });
    }

    return {
      processedIndex: item.index,
      contentType: item.contentType,
      week: item.week,
      outcome: processed.outcome,
      articleId: processed.articleId,
      title: processed.title,
      costUsd: processed.costUsd,
      nextIndex,
      remaining: remainingItems.length,
    };
  },
});

/* -------------------------------------------------------------------------- *
 * getSeasonBackfillStatus
 * -------------------------------------------------------------------------- */

export const getSeasonBackfillStatus = internalQuery({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  returns: v.object({
    items: v.array(
      v.object({
        contentType: v.string(),
        week: v.optional(v.number()),
        rowStatus: v.string(),
        error: v.optional(v.string()),
        articleId: v.optional(v.id("aiContent")),
        articleStatus: v.optional(v.string()),
        title: v.optional(v.string()),
        costUsd: v.optional(v.number()),
        publishedAt: v.optional(v.number()),
        reviewFlagsCount: v.number(),
      })
    ),
    totals: v.object({
      published: v.number(),
      held: v.number(),
      failed: v.number(),
      skipped: v.number(),
      totalUsd: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    // A by-league scan filtered in code (no index on `backfill` alone) - bounded, and this table
    // never gets remotely close to 1000 rows for one league.
    const rows = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .take(1000);
    const backfillRows = rows.filter((row) => row.backfill === true && row.seasonId === args.seasonId);

    const items = await Promise.all(
      backfillRows.map(async (row) => {
        const article = row.generatedContentId ? await ctx.db.get(row.generatedContentId) : null;
        return {
          contentType: row.contentType,
          week: row.week,
          rowStatus: row.status,
          error: row.errorMessage,
          articleId: row.generatedContentId,
          articleStatus: article?.status,
          title: article?.title,
          costUsd: article?.generationStats?.costUsd,
          publishedAt: article?.publishedAt,
          reviewFlagsCount: article?.reviewFlags?.length ?? 0,
        };
      })
    );

    // Mutually exclusive buckets: a row is exactly one of these, never counted twice.
    const totals = {
      published: items.filter((i) => i.articleStatus === "published").length,
      // An article exists (survived the publish gate check or was held for review) but never published.
      held: items.filter((i) => i.articleStatus === "draft").length,
      failed: items.filter((i) => i.rowStatus === "failed" || i.articleStatus === "failed").length,
      skipped: items.filter((i) => i.rowStatus === "cancelled").length,
      totalUsd: Math.round(items.reduce((sum, i) => sum + (i.costUsd ?? 0), 0) * 100) / 100,
    };

    return { items, totals };
  },
});
