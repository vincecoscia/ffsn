/**
 * The Wire — social layer data access (ffsn-the-wire-spec.md §17). Default-runtime internal
 * queries/mutations that `convex/wireSocial.ts` (a `"use node"` actions-only file, since it calls
 * `generateWriterReply` which imports `@anthropic-ai/sdk`) reaches through `ctx.runQuery` /
 * `ctx.runMutation` - actions have no `ctx.db` of their own.
 *
 * Thread model: a post's "root" is resolved on the fly rather than self-stamped - a target with no
 * `replyTo` of its own (an overlay, a routine post, a standalone `manager_post`, or any global
 * `wirePosts` row) IS the root ({scope, id: target._id}); a target that is itself a reply carries
 * its own `rootScope`/`rootId` already, inherited from ITS target the same way. Every reply row
 * (never the root itself) is stamped with that resolved root, so `by_root` alone returns a whole
 * thread's replies, flattened, regardless of nesting depth (spec §17: "replies to a reply are
 * flattened into the same list").
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { userByClerkId } from "./lib/teamClaims";
import { insertLeaguePostIfNew, parsePostKey } from "./lib/wireLeaguePosting";
import { capThreadContext } from "./lib/wireSocialRules";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const replyTargetRefValidator = v.object({
  scope: v.union(v.literal("global"), v.literal("league")),
  id: v.string(),
});

/* -------------------------------------------------------------------------- *
 * Reactions (spec §17.2): does a postKey point at a WRITER's post?
 * -------------------------------------------------------------------------- */

/** `null` for a manager's own post (or a malformed/missing key) - only a writer's post moves the
 *  relationship meter when reacted to. */
export const getWriterPostForReaction = internalQuery({
  args: { postKey: v.string() },
  returns: v.union(v.object({ persona: v.string(), text: v.string() }), v.null()),
  handler: async (ctx, { postKey }) => {
    const parsed = parsePostKey(postKey);
    if (!parsed) return null;

    if (parsed.scope === "global") {
      const id = ctx.db.normalizeId("wirePosts", parsed.id);
      if (!id) return null;
      const post = await ctx.db.get(id);
      if (!post) return null;
      return { persona: post.persona, text: post.text };
    }

    const id = ctx.db.normalizeId("wireLeaguePosts", parsed.id);
    if (!id) return null;
    const post = await ctx.db.get(id);
    if (!post || post.authorUserId || !post.persona) return null;
    return { persona: post.persona, text: post.text };
  },
});

/* -------------------------------------------------------------------------- *
 * Writer replies (spec §17.3): everything onManagerPost needs to decide, gate,
 * and build the model call, plus the two writes it makes when it answers.
 * -------------------------------------------------------------------------- */

const managerPostContextValidator = v.object({
  leagueId: v.id("leagues"),
  seasonId: v.number(),
  week: v.optional(v.number()),
  kind: v.string(),
  text: v.string(),
  authorUserId: v.string(),
  /** `null` when the poster's Clerk id has no `users` row (should not happen for a signed-in
   *  poster, but a caller must not assume it always resolves). */
  authorUsersId: v.union(v.id("users"), v.null()),
  authorTeamId: v.optional(v.id("teams")),
  replyTo: v.optional(replyTargetRefValidator),
  /** The resolved thread root - see this module's header comment. */
  rootScope: v.union(v.literal("global"), v.literal("league")),
  rootId: v.string(),
  createdAt: v.number(),
});

/** A manager_post/manager_reply's full context, or `null` if it was deleted (or somehow isn't a
 *  manager post at all) in the time between the post and the scheduled action running. */
export const getManagerPostContext = internalQuery({
  args: { leaguePostId: v.id("wireLeaguePosts") },
  returns: v.union(managerPostContextValidator, v.null()),
  handler: async (ctx, { leaguePostId }) => {
    const post = await ctx.db.get(leaguePostId);
    if (!post || post.deletedAt || !post.authorUserId) return null;

    const authorUser = await userByClerkId(ctx, post.authorUserId);
    return {
      leagueId: post.leagueId,
      seasonId: post.seasonId,
      week: post.week,
      kind: post.kind,
      text: post.text,
      authorUserId: post.authorUserId,
      authorUsersId: authorUser?._id ?? null,
      authorTeamId: post.authorTeamId,
      replyTo: post.replyTo,
      rootScope: post.rootScope ?? "league",
      rootId: post.rootId ?? (post._id as string),
      createdAt: post.createdAt,
    };
  },
});

/** The post a manager_reply answers, normalized across the two post tables. `null` when it no
 *  longer exists or was deleted - `onManagerPost` treats that as "nothing to answer". */
export const getReplyTarget = internalQuery({
  args: { scope: v.union(v.literal("global"), v.literal("league")), id: v.string() },
  returns: v.union(
    v.object({
      persona: v.optional(v.string()),
      authorUserId: v.optional(v.string()),
      text: v.string(),
      /** Set only for a global post - the fact card behind it, for `card` in `WriterReplyInput`. */
      cardEventId: v.optional(v.id("wireEvents")),
    }),
    v.null()
  ),
  handler: async (ctx, { scope, id }) => {
    if (scope === "global") {
      const normalized = ctx.db.normalizeId("wirePosts", id);
      if (!normalized) return null;
      const post = await ctx.db.get(normalized);
      if (!post) return null;
      return { persona: post.persona, text: post.text, cardEventId: post.eventId };
    }
    const normalized = ctx.db.normalizeId("wireLeaguePosts", id);
    if (!normalized) return null;
    const post = await ctx.db.get(normalized);
    if (!post || post.deletedAt) return null;
    return { persona: post.persona, authorUserId: post.authorUserId, text: post.text };
  },
});

/** The raw `WireFactCard` blob behind a global post's event, for the writer-reply call's `card` -
 *  the only facts the writer may restate when the thread root is a global post. */
export const getEventFacts = internalQuery({
  args: { eventId: v.id("wireEvents") },
  returns: v.any(),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    return event?.facts ?? null;
  },
});

const replyGateCountsValidator = v.object({
  repliesToManagerLastHour: v.number(),
  repliesInLeagueToday: v.number(),
  repliesInThreadToManager: v.number(),
  lastSamChaseAt: v.optional(v.number()),
});

/**
 * Every count `wireSocialRules.replyGateReason` / `shouldSamChase` needs, resolved in one pass
 * (spec §17.3). Bounded like every other rate-limit scan in this feature
 * (`convex/lib/wireLeaguePosting.ts`'s `RATE_LIMIT_SCAN_CAP`): a manager posting fast enough to
 * blow past these bounds has long since hit the plain `MANAGER_POSTS_PER_HOUR` cap in `wire.ts`.
 */
export const getReplyGateCounts = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    authorUserId: v.string(),
    rootScope: v.union(v.literal("global"), v.literal("league")),
    rootId: v.string(),
    now: v.number(),
  },
  returns: replyGateCountsValidator,
  handler: async (ctx, { leagueId, authorUserId, rootScope, rootId, now }) => {
    // Cross-thread: this author's own posts (however many threads they sit in), and every
    // writer_reply that answered each one directly.
    const authorPosts = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_author_created", (q) => q.eq("leagueId", leagueId).eq("authorUserId", authorUserId))
      .order("desc")
      .take(30);

    let repliesToManagerLastHour = 0;
    let lastSamChaseAt: number | undefined;
    for (const post of authorPosts) {
      const directReplies = await ctx.db
        .query("wireLeaguePosts")
        .withIndex("by_league_reply", (q) => q.eq("leagueId", leagueId).eq("replyTo.id", post._id))
        .order("desc")
        .take(20);
      for (const reply of directReplies) {
        if (reply.kind !== "writer_reply") continue;
        if (reply.createdAt > now - HOUR_MS) repliesToManagerLastHour++;
        if (reply.persona === "sam-ortega" && (lastSamChaseAt === undefined || reply.createdAt > lastSamChaseAt)) {
          lastSamChaseAt = reply.createdAt;
        }
      }
    }

    // League-wide: every writer_reply posted anywhere in this league in the last 24h.
    const recentLeaguePosts = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId).gt("createdAt", now - DAY_MS))
      .take(500);
    const repliesInLeagueToday = recentLeaguePosts.filter((row) => row.kind === "writer_reply").length;

    // Single-thread: every reply in this thread, so we can tell which writer_reply rows already
    // answered THIS author within it.
    const threadRows = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_root", (q) => q.eq("leagueId", leagueId).eq("rootId", rootId))
      .take(200);
    const managerPostIdsInThread = new Set(
      threadRows.filter((row) => row.authorUserId === authorUserId).map((row) => row._id as string)
    );
    if (rootScope === "league") {
      const rootNormalized = ctx.db.normalizeId("wireLeaguePosts", rootId);
      const root = rootNormalized ? await ctx.db.get(rootNormalized) : null;
      if (root?.authorUserId === authorUserId) managerPostIdsInThread.add(rootId);
    }
    const repliesInThreadToManager = threadRows.filter(
      (row) => row.kind === "writer_reply" && row.replyTo && managerPostIdsInThread.has(row.replyTo.id)
    ).length;

    return { repliesToManagerLastHour, repliesInLeagueToday, repliesInThreadToManager, lastSamChaseAt };
  },
});

const threadTurnValidator = v.object({
  author: v.union(v.literal("writer"), v.literal("manager")),
  text: v.string(),
});

/** The thread's turns, oldest first, capped at `limit` (`MAX_THREAD_CONTEXT`) - the most recent
 *  turns win when a thread runs long, since a reply answers what was just said. */
export const getThreadContext = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    rootScope: v.union(v.literal("global"), v.literal("league")),
    rootId: v.string(),
    limit: v.number(),
  },
  returns: v.array(threadTurnValidator),
  handler: async (ctx, { leagueId, rootScope, rootId, limit }) => {
    const turns: Array<{ author: "writer" | "manager"; text: string; createdAt: number }> = [];

    if (rootScope === "global") {
      const normalized = ctx.db.normalizeId("wirePosts", rootId);
      const root = normalized ? await ctx.db.get(normalized) : null;
      if (root) turns.push({ author: "writer", text: root.text, createdAt: root.createdAt });
    } else {
      const normalized = ctx.db.normalizeId("wireLeaguePosts", rootId);
      const root = normalized ? await ctx.db.get(normalized) : null;
      if (root) {
        turns.push({
          author: root.authorUserId ? "manager" : "writer",
          text: root.deletedAt ? "[deleted]" : root.text,
          createdAt: root.createdAt,
        });
      }
    }

    const replies = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_root", (q) => q.eq("leagueId", leagueId).eq("rootId", rootId))
      .order("asc")
      .take(200);
    for (const reply of replies) {
      turns.push({
        author: reply.kind === "writer_reply" ? "writer" : "manager",
        text: reply.deletedAt ? "[deleted]" : reply.text,
        createdAt: reply.createdAt,
      });
    }

    turns.sort((a, b) => a.createdAt - b.createdAt);
    const capped = capThreadContext(turns, Math.max(1, Math.min(limit, 50)));
    return capped.map(({ author, text }) => ({ author, text }));
  },
});

/**
 * Insert the writer's reply (idempotent on `writer_reply:<leaguePostId>` via
 * `insertLeaguePostIfNew`) - exempt from the general per-league rate limit
 * (`LEAGUE_LIMIT_EXEMPT_KINDS` includes `"writer_reply"`; it has its own limits, checked before
 * this is ever called).
 */
export const insertWriterReply = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    week: v.optional(v.number()),
    persona: v.string(),
    text: v.string(),
    authorTeamId: v.optional(v.id("teams")),
    replyToId: v.id("wireLeaguePosts"),
    rootScope: v.union(v.literal("global"), v.literal("league")),
    rootId: v.string(),
    generationStats: v.object({ costUsd: v.number(), model: v.string(), effort: v.string() }),
  },
  returns: v.object({ inserted: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const { inserted } = await insertLeaguePostIfNew(ctx, now, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
      week: args.week,
      kind: "writer_reply",
      persona: args.persona,
      text: args.text,
      tags: [],
      featuredTeams: args.authorTeamId ? [args.authorTeamId] : [],
      dedupeKey: `writer_reply:${args.replyToId}`,
      generationStats: args.generationStats,
      replyTo: { scope: "league", id: args.replyToId },
      rootScope: args.rootScope,
      rootId: args.rootId,
    });
    return { inserted };
  },
});

/** Tag the manager's own post with how the writer read it - spec §17.3: recorded even when the
 *  writer's answer failed verification and nothing was posted. */
export const patchManagerPostSentiment = internalMutation({
  args: {
    leaguePostId: v.id("wireLeaguePosts"),
    sentiment: v.union(v.literal("jab"), v.literal("thanks"), v.literal("neutral")),
  },
  returns: v.null(),
  handler: async (ctx, { leaguePostId, sentiment }) => {
    const post = await ctx.db.get(leaguePostId);
    if (post) await ctx.db.patch(leaguePostId, { sentiment });
    return null;
  },
});
