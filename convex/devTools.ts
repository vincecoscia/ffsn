/**
 * Dev end-to-end tool (spec §11.3.12).
 *
 * `runScheduledPipelineNow` drives the entire unattended pipeline - calendar
 * row, pre-generation gates, League Pass check, spend cap, generation,
 * verification, editor pass, publish gate - against a real league, right now,
 * and hands back what came out. It is how the automation is exercised before a
 * prod deploy, and it deliberately runs the SAME code the cron runs
 * (`contentScheduling.processScheduledContent`, with batching off and the
 * period forced) rather than a parallel implementation that could drift.
 *
 * Everything here is `internal`, so none of it is reachable from a browser.
 * The dev-deployment guard below is the second lock: this thing writes
 * articles, spends real API budget, and quietly turns a league's pass on.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { defaultPersonaFor } from "./contentScheduling";
import { contentTemplates } from "../src/lib/ai/content-templates";

/**
 * `contentSchedules.contentType` is a union of the known types, but this tool
 * takes a plain string from the command line. Validate against the templates -
 * the same registry the pipeline uses - and narrow, so a typo fails here with
 * the list of valid types rather than at insert time with a validator error.
 */
function asContentType(value: string): Doc<"contentSchedules">["contentType"] {
  if (!(value in contentTemplates)) {
    throw new Error(
      `Unknown content type "${value}". Valid types: ${Object.keys(contentTemplates).sort().join(", ")}`,
    );
  }
  return value as Doc<"contentSchedules">["contentType"];
}

/* -------------------------------------------------------------------------- *
 * The guard
 * -------------------------------------------------------------------------- */

/**
 * Is this deployment one the dev tools may run on?
 *
 * Convex exposes `CONVEX_CLOUD_URL` to every function, but a deployment's
 * *name* does not say whether it is a dev or a prod deployment - both are
 * random word pairs. So the authoritative signal is an env var the operator
 * sets by hand, on the dev deployment only:
 *
 *   npx convex env set DEV_TOOLS_ENABLED 1
 *
 * Two weaker signals are accepted as a convenience because they cannot be
 * true on a hosted prod deployment: a `CONVEX_DEPLOYMENT` that starts with
 * `dev:` or `local:` (set by `npx convex dev`, and by convex-test), and a
 * loopback `CONVEX_CLOUD_URL` (`npx convex dev --local`).
 *
 * `CONVEX_DEPLOYMENT` starting with `prod:` refuses outright, whatever else is
 * set: an operator who copied `DEV_TOOLS_ENABLED=1` into prod by accident does
 * not get to find out the hard way.
 */
export function devToolsGuard(): { allowed: boolean; reason: string } {
  const deployment = (process.env.CONVEX_DEPLOYMENT ?? "").trim();
  const cloudUrl = (process.env.CONVEX_CLOUD_URL ?? "").trim();

  if (deployment.startsWith("prod:")) {
    return {
      allowed: false,
      reason: `refusing to run: CONVEX_DEPLOYMENT is "${deployment}" (a production deployment)`,
    };
  }

  if ((process.env.DEV_TOOLS_ENABLED ?? "").trim() === "1") {
    return { allowed: true, reason: "DEV_TOOLS_ENABLED=1" };
  }

  if (deployment.startsWith("dev:") || deployment.startsWith("local:")) {
    return { allowed: true, reason: `CONVEX_DEPLOYMENT is "${deployment}"` };
  }

  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(cloudUrl)) {
    return { allowed: true, reason: `CONVEX_CLOUD_URL is local (${cloudUrl})` };
  }

  return {
    allowed: false,
    reason:
      "refusing to run: this does not look like a dev deployment. " +
      "Set DEV_TOOLS_ENABLED=1 on the DEV deployment " +
      "(`npx convex env set DEV_TOOLS_ENABLED 1`) to enable it.",
  };
}

/* -------------------------------------------------------------------------- *
 * Helpers the action needs a database for
 * -------------------------------------------------------------------------- */

/**
 * Turn the league's pass on for the run, if it is not already on.
 *
 * Automated content is gated on an active League Pass (spec §10.1), so a dev
 * league that was never paid for could never exercise the pipeline. Guarded by
 * `devToolsGuard` at the call site AND here, because this is the one mutation
 * in the file that changes billing state.
 */
export const ensurePassActiveForDev = internalMutation({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  returns: v.object({ changed: v.boolean(), status: v.string() }),
  handler: async (ctx, args) => {
    const guard = devToolsGuard();
    if (!guard.allowed) throw new Error(`devTools.ensurePassActiveForDev ${guard.reason}`);

    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const status = league.subscription.status;
    if (status === "active" || status === "paid") {
      return { changed: false, status };
    }

    await ctx.db.patch(args.leagueId, {
      subscription: {
        ...league.subscription,
        status: "active",
        paymentStatus: "completed" as const,
        seasonId: league.subscription.seasonId ?? args.seasonId,
      },
    });
    return { changed: true, status: "active" };
  },
});

/**
 * A scheduled row for the requested period, bypassing the calendar entirely.
 *
 * The row still points at a real `contentSchedules` config, because
 * `processScheduledContent` reads it for the writer and the enabled flag; one
 * is created (disabled types included) when the league has none for the type.
 * `scheduledFor` is now, so the row is due and no batch lookahead applies.
 */
export const createDevScheduledRow = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    contentType: v.string(),
    seasonId: v.number(),
    week: v.number(),
    persona: v.optional(v.string()),
  },
  returns: v.id("scheduledContent"),
  handler: async (ctx, args): Promise<Id<"scheduledContent">> => {
    const guard = devToolsGuard();
    if (!guard.allowed) throw new Error(`devTools.createDevScheduledRow ${guard.reason}`);

    const now = Date.now();
    const persona = args.persona ?? defaultPersonaFor(args.contentType);

    const contentType = asContentType(args.contentType);

    const existing = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league_type", (q) =>
        q.eq("leagueId", args.leagueId).eq("contentType", contentType),
      )
      .first();

    let contentScheduleId: Id<"contentSchedules">;
    if (existing) {
      contentScheduleId = existing._id;
      // The row must be enabled for the run, and must carry the writer the
      // caller asked for. Both are restored to nothing - this is a dev
      // deployment, and a permanently enabled schedule there is harmless.
      if (!existing.enabled || existing.preferredPersona !== persona) {
        await ctx.db.patch(existing._id, {
          enabled: true,
          preferredPersona: persona,
          updatedAt: now,
        });
      }
    } else {
      contentScheduleId = await ctx.db.insert("contentSchedules", {
        leagueId: args.leagueId,
        contentType,
        enabled: true,
        timezone: "UTC",
        schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 },
        preferredPersona: persona,
        createdAt: now,
        updatedAt: now,
      });
    }

    return await ctx.db.insert("scheduledContent", {
      leagueId: args.leagueId,
      contentScheduleId,
      contentType: args.contentType,
      scheduledFor: now,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      seasonId: args.seasonId,
      week: args.week,
      contextData: { seasonId: args.seasonId, week: args.week },
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Everything the tool reports back about one run. */
export const getDevRunResult = internalQuery({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    articleId: v.optional(v.id("aiContent")),
  },
  returns: v.object({
    rowStatus: v.string(),
    rowError: v.optional(v.string()),
    deferrals: v.optional(v.number()),
    articleStatus: v.optional(v.string()),
    articleTitle: v.optional(v.string()),
    wordCount: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    reviewFlags: v.optional(
      v.array(v.object({ kind: v.string(), severity: v.string(), detail: v.string() })),
    ),
    editorFactsScore: v.optional(v.number()),
    editorVoiceScore: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledContentId);
    const articleId = args.articleId ?? row?.generatedContentId;
    const article = articleId ? await ctx.db.get(articleId) : null;

    return {
      rowStatus: row?.status ?? "missing",
      rowError: row?.errorMessage,
      deferrals: row?.deferrals,
      articleStatus: article?.status,
      articleTitle: article?.title,
      wordCount:
        article?.generationStats?.wordCount ??
        (article ? article.content.split(/\s+/).filter(Boolean).length : undefined),
      costUsd: article?.generationStats?.costUsd,
      reviewFlags: article?.reviewFlags?.map((flag) => ({
        kind: flag.kind,
        severity: flag.severity,
        detail: flag.detail,
      })),
      editorFactsScore: article?.generationStats?.editor?.factsScore,
      editorVoiceScore: article?.generationStats?.editor?.voiceScore,
    };
  },
});

/* -------------------------------------------------------------------------- *
 * The tool
 * -------------------------------------------------------------------------- */

/** How long the tool waits for an article to leave `generating`. */
const DEFAULT_TIMEOUT_MS = 240_000;
/** How often it looks. */
const POLL_INTERVAL_MS = 3_000;

/**
 * Run the whole scheduled pipeline for one league/type/period, now.
 *
 *   npx convex run devTools:runScheduledPipelineNow \
 *     '{"leagueId":"<id>","contentType":"weekly_recap","seasonId":2026,"week":5}'
 *
 * Returns the scheduled row, the article it produced (if it got that far), the
 * verifier's findings, what it cost, and whether the publish gate let it out.
 * `notes` is the running commentary: which gate deferred it, whether the pass
 * had to be switched on, whether the poll timed out.
 */
export const runScheduledPipelineNow = internalAction({
  args: {
    leagueId: v.id("leagues"),
    contentType: v.string(),
    seasonId: v.number(),
    week: v.number(),
    persona: v.optional(v.string()),
    /** Override the poll budget for a slow type. */
    timeoutMs: v.optional(v.number()),
  },
  returns: v.object({
    scheduledContentId: v.id("scheduledContent"),
    articleId: v.optional(v.id("aiContent")),
    status: v.string(),
    reviewFlags: v.optional(
      v.array(v.object({ kind: v.string(), severity: v.string(), detail: v.string() })),
    ),
    costUsd: v.optional(v.number()),
    published: v.optional(v.boolean()),
    notes: v.array(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    scheduledContentId: Id<"scheduledContent">;
    articleId?: Id<"aiContent">;
    status: string;
    reviewFlags?: Array<{ kind: string; severity: string; detail: string }>;
    costUsd?: number;
    published?: boolean;
    notes: string[];
  }> => {
    const guard = devToolsGuard();
    if (!guard.allowed) {
      throw new Error(`devTools.runScheduledPipelineNow ${guard.reason}`);
    }

    const notes: string[] = [`dev guard: ${guard.reason}`];

    // 1. The pass. Automated content is gated on it, so a dev league that was
    //    never paid for would stop at the gate rather than exercise it.
    const pass = await ctx.runMutation(internal.devTools.ensurePassActiveForDev, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
    });
    notes.push(
      pass.changed
        ? "League Pass was not active; switched it on for this dev run"
        : `League Pass already ${pass.status}`,
    );

    // 2. The row, bypassing the calendar.
    const scheduledContentId: Id<"scheduledContent"> = await ctx.runMutation(
      internal.devTools.createDevScheduledRow,
      {
        leagueId: args.leagueId,
        contentType: args.contentType,
        seasonId: args.seasonId,
        week: args.week,
        persona: args.persona,
      },
    );
    notes.push(`scheduled row created for ${args.contentType} ${args.seasonId} week ${args.week}`);

    // 3. The real pipeline. Same action the cron calls: batching off (a batch
    //    would come back hours later and defeat the point) and the period
    //    forced, so the tool writes about the week that was asked for rather
    //    than the week the clock happens to be in.
    const run = await ctx.runAction(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
      forcePeriod: { seasonId: args.seasonId, week: args.week },
      disableBatching: true,
      awaitGeneration: true,
    });
    notes.push(`processScheduledContent: ${run.message ?? (run.success ? "dispatched" : "refused")}`);

    const articleId = run.contentId as Id<"aiContent"> | undefined;

    // 4. Wait for the article to leave `generating`. The prepared content
    //    types (mock_draft, weekly_recap, season_welcome, draft_rankings)
    //    chain a scheduled data-prep step, so awaiting the generation action
    //    only guarantees the chain started.
    const deadline = Date.now() + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let result = await ctx.runQuery(internal.devTools.getDevRunResult, {
      scheduledContentId,
      articleId,
    });

    while (
      (result.articleStatus === "generating" || (articleId && !result.articleStatus)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      result = await ctx.runQuery(internal.devTools.getDevRunResult, {
        scheduledContentId,
        articleId,
      });
    }

    if (result.articleStatus === "generating") {
      notes.push(`still generating after ${(args.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s; gave up waiting`);
    }
    if (!articleId && result.rowStatus === "pending") {
      notes.push(`deferred: ${result.rowError ?? "unknown reason"} (deferral ${result.deferrals ?? 0})`);
    }
    if (result.rowStatus === "cancelled") {
      notes.push(`cancelled: ${result.rowError ?? "unknown reason"}`);
    }
    if (result.articleTitle) notes.push(`title: ${result.articleTitle}`);
    if (typeof result.wordCount === "number") notes.push(`${result.wordCount} words`);
    if (typeof result.editorFactsScore === "number") {
      notes.push(
        `editor: facts ${result.editorFactsScore}/5, voice ${result.editorVoiceScore ?? "n/a"}/5`,
      );
    }

    // A deferred or cancelled run never produced an article; a run that did
    // reports the id `processScheduledContent` handed back.
    const status = result.articleStatus ?? result.rowStatus;

    return {
      scheduledContentId,
      articleId,
      status,
      reviewFlags: result.reviewFlags,
      costUsd: result.costUsd,
      published: result.articleStatus ? result.articleStatus === "published" : undefined,
      notes,
    };
  },
});

/* ============================================================================ *
 * The Wire (ffsn-the-wire-spec.md §11 "Dev tool") - synthesize an event and run
 * detect -> take -> overlay on the dev deployment only, same guard as above.
 * ============================================================================ */

/**
 * Wipe every Wire table on the dev deployment (same guard as everything here). Exists because the
 * first dev poll (2026-09-05) ingested ~100 August notes before the cold-start rule shipped; run it
 * once, then `wireSourcesNode.pollEspnInjuries` re-seeds its cursor cleanly. Bounded: 500 rows per
 * table per call, rescheduling itself while anything is left.
 */
export const resetWire = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), more: v.boolean(), reason: v.string() }),
  handler: async (ctx) => {
    const guard = devToolsGuard();
    if (!guard.allowed) return { deleted: 0, more: false, reason: guard.reason };
    let deleted = 0;
    let more = false;
    for (const table of ["wireLeaguePosts", "wirePosts", "wireEvents", "wireSourceState"] as const) {
      const rows = await ctx.db.query(table).take(500);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        deleted++;
      }
      if (rows.length === 500) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.devTools.resetWire, {});
    return { deleted, more, reason: guard.reason };
  },
});

export const latestWireEventForPlayer = internalQuery({
  args: { espnId: v.string() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { espnId }) => {
    const events = await ctx.db.query("wireEvents").withIndex("by_detected").order("desc").take(50);
    return events.find((event) => event.players.some((p) => p.espnId === espnId)) ?? null;
  },
});

export const wirePostForEvent = internalQuery({
  args: { eventId: v.id("wireEvents") },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { eventId }) => {
    return await ctx.db
      .query("wirePosts")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .first();
  },
});

export const leaguePostsForGlobalPost = internalQuery({
  args: { postId: v.id("wirePosts"), leagueId: v.id("leagues") },
  returns: v.array(v.any()),
  handler: async (ctx, { postId, leagueId }) => {
    return await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_global_post_league", (q) => q.eq("globalPostId", postId).eq("leagueId", leagueId))
      .take(10);
  },
});

export const runWireEventNow = internalAction({
  args: {
    kind: v.union(v.literal("injury_status"), v.literal("injury_note"), v.literal("news")),
    espnId: v.string(),
    statusTo: v.optional(v.string()),
    statusFrom: v.optional(v.string()),
    note: v.optional(v.string()),
    leagueId: v.optional(v.id("leagues")),
  },
  returns: v.object({
    event: v.union(v.any(), v.null()),
    globalPost: v.union(v.any(), v.null()),
    leaguePosts: v.array(v.any()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    event: { _id: Id<"wireEvents"> } | null;
    globalPost: { _id: Id<"wirePosts">; status: string } | null;
    leaguePosts: unknown[];
  }> => {
    const guard = devToolsGuard();
    if (!guard.allowed) {
      throw new Error(`devTools.runWireEventNow ${guard.reason}`);
    }

    const now = Date.now();

    if (args.kind === "news") {
      // A synthetic espnNews row, upserted through the real writer (news.ts), then ingested
      // directly (rather than waiting on that mutation's own auto-scheduled hook) so this action
      // can hand back the result inline.
      const articleEspnId = `dev-${now}`;
      await ctx.runMutation(internal.news.storeNewsArticles, {
        articles: [
          {
            espnId: articleEspnId,
            type: "Story",
            headline: args.note ?? `Dev synthetic news for ${args.espnId}`,
            description: args.note,
            lastModified: new Date(now).toISOString(),
            published: new Date(now).toISOString(),
            premium: false,
            links: {},
            images: [],
            categories: {
              teams: [],
              athletes: [{ id: Number(args.espnId), name: args.espnId, position: undefined }],
              leagues: [],
            },
          },
        ],
      });
      await ctx.runMutation(internal.wireDetect.ingestNews, { espnIds: [articleEspnId] });
    } else {
      const status = args.statusTo ?? "Questionable";
      // injuryEntryToCard treats `previousStatus === status` (or absent, defaulting to "Active")
      // as an unchanged-status note; giving it a different value forces the status-change path.
      const previousStatus = args.kind === "injury_status" ? (args.statusFrom ?? "Active") : status;
      await ctx.runMutation(internal.wireDetect.ingestInjuryEntries, {
        entries: [
          {
            entry: {
              id: `dev-${now}`,
              status,
              date: new Date(now).toISOString(),
              shortComment: args.note,
              athlete: { espnId: args.espnId, name: args.espnId },
            },
            previousStatus,
          },
        ],
        fetchedAt: now,
      });
    }

    // Explicit annotations on every same-file `internal.devTools.*` call below: per this repo's
    // Convex guidelines, a same-file `ctx.runQuery`/`ctx.runMutation` reference otherwise hits a
    // TypeScript circularity limitation.
    const event: { _id: Id<"wireEvents"> } | null = await ctx.runQuery(internal.devTools.latestWireEventForPlayer, {
      espnId: args.espnId,
    });
    const eventId = event?._id;
    let globalPost: { _id: Id<"wirePosts">; status: string } | null = eventId
      ? await ctx.runQuery(internal.devTools.wirePostForEvent, { eventId })
      : null;

    if (globalPost?.status === "take_pending") {
      await ctx.runAction(internal.wireGenerate.flushTakeBatch, {});
      globalPost = eventId ? await ctx.runQuery(internal.devTools.wirePostForEvent, { eventId }) : null;
    }

    let leaguePosts: unknown[] = [];
    const postId = globalPost?._id;
    if (args.leagueId && postId) {
      await ctx.runMutation(internal.wireOverlay.fanOutGlobalPostForLeague, {
        postId,
        leagueId: args.leagueId,
      });
      leaguePosts = await ctx.runQuery(internal.devTools.leaguePostsForGlobalPost, {
        postId,
        leagueId: args.leagueId,
      });
    }

    return { event, globalPost, leaguePosts };
  },
});
