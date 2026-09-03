/**
 * Broadcast Desk relationship meter (spec §6).
 *
 * Every manager has a running score with every writer persona, scoped to a league.
 * Writers roasting a manager and managers jabbing a writer move the score; the score
 * changes how the writer treats that manager in the next article.
 *
 * Storage: `writerRelationships` (one row per league × manager × persona, created lazily)
 * and `relationshipEvents`. A missing row reads as `{ score: 0, tier: "neutral" }` - no
 * row is created until the first event.
 *
 * The ledger is append-only, with one exception: reaction rows (type "reaction") mirror
 * the reader's CURRENT `articleReactions` row for an article, not the history of taps.
 * `syncReactionEvent` reconciles - deletes and, if a reaction is still set, re-inserts -
 * so there is at most one reaction row per (article, reader, persona), and none once the
 * reaction is removed. Every other event type is append-only as before.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireLeagueMember } from "./lib/auth";
import { leagueCurrentSeason } from "./lib/season";
import {
  relationshipEventTypeValidator,
  relationshipTierValidator,
  writerRelationshipContextValidator,
} from "./validators";

/* -------------------------------------------------------------------------- */
/* Constants                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The six selectable writers (spec §3), in roster order.
 *
 * Hard-coded here rather than imported from `src/lib/ai/persona-prompts.ts`: that module
 * carries prompt copy and pulls in app-side types, and Convex isolate code should not
 * depend on it. Keep this list in sync with `personaPrompts` when the roster changes.
 */
export const ACTIVE_WRITERS = [
  "curtis-vaughn",
  "sam-ortega",
  "nina-sharpe",
  "dex-alvarez",
  "mel-diaper",
  "walt-brennan",
] as const;

export type ActiveWriter = (typeof ACTIVE_WRITERS)[number];

export type RelationshipTier = "feud" | "cold" | "neutral" | "warm" | "favorite";

/** Score deltas per event (spec §6.2). */
export const DELTAS = {
  article_roast: { 1: -3, 2: -6, 3: -10 },
  article_praise: { 1: 3, 2: 6, 3: 10 },
  interview_jab: { hostile: -8, dismissive: -4 },
  interview_praise: { friendly: 6 },
  reaction: { salty: -2, respect: 2, fire: 1, lol: 1 },
} as const;

/** Weekly decay: move 15% toward 0, at least 1 point, never crossing 0. */
export const DECAY_RATE = 0.15;
export const DECAY_MIN_STEP = 1;

export const SCORE_MIN = -100;
export const SCORE_MAX = 100;

/** Ledger `evidence` is capped so a single sentence can't bloat the row. */
const EVIDENCE_MAX_CHARS = 280;

/** Tier thresholds (spec §6.1): feud ≤ -50 · cold -49..-15 · neutral -14..14 · warm 15..49 · favorite ≥ 50. */
export function tierForScore(score: number): RelationshipTier {
  if (score <= -50) return "feud";
  if (score <= -15) return "cold";
  if (score <= 14) return "neutral";
  if (score <= 49) return "warm";
  return "favorite";
}

export function clampScore(score: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(score)));
}

function truncateEvidence(evidence: string): string {
  const trimmed = evidence.trim();
  return trimmed.length > EVIDENCE_MAX_CHARS
    ? `${trimmed.slice(0, EVIDENCE_MAX_CHARS - 1)}…`
    : trimmed;
}

/* -------------------------------------------------------------------------- */
/* Shared validators                                                            */
/* -------------------------------------------------------------------------- */

const relationshipEventDetailValidator = v.object({
  type: relationshipEventTypeValidator,
  delta: v.number(),
  evidence: v.string(),
  week: v.optional(v.number()),
  articleId: v.optional(v.id("aiContent")),
  createdAt: v.number(),
});

const writerMeterValidator = v.object({
  persona: v.string(),
  score: v.number(),
  tier: relationshipTierValidator,
  eventCount: v.number(),
  lastEventAt: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
  recentEvents: v.array(relationshipEventDetailValidator),
});

const managerMetersValidator = v.object({
  userId: v.id("users"),
  managerName: v.string(),
  teamId: v.union(v.id("teams"), v.null()),
  teamName: v.string(),
  writers: v.array(writerMeterValidator),
});

const recordResultValidator = v.object({
  recorded: v.boolean(),
  score: v.number(),
  tier: relationshipTierValidator,
});

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                             */
/* -------------------------------------------------------------------------- */

type RelationshipEventType =
  | "article_roast"
  | "article_praise"
  | "interview_jab"
  | "interview_praise"
  | "reaction"
  | "decay"
  | "manual";

interface ApplyEventArgs {
  leagueId: Id<"leagues">;
  userId: Id<"users">;
  persona: string;
  type: RelationshipEventType;
  delta: number;
  evidence: string;
  teamId?: Id<"teams">;
  articleId?: Id<"aiContent">;
  commentRequestId?: Id<"commentRequests">;
  week?: number;
}

/**
 * Idempotency (spec §6.3): an event carrying the same `articleId` (or `commentRequestId`)
 * plus the same `type` and `evidence` is a replay and must not move the score twice.
 * Events with neither id (e.g. `manual`) are always recorded.
 */
async function isDuplicateEvent(
  ctx: MutationCtx,
  args: ApplyEventArgs
): Promise<boolean> {
  const evidence = truncateEvidence(args.evidence);

  if (args.articleId) {
    const existing = await ctx.db
      .query("relationshipEvents")
      .withIndex("by_article", (q) => q.eq("articleId", args.articleId))
      .take(200);
    return existing.some(
      (e) =>
        e.userId === args.userId &&
        e.persona === args.persona &&
        e.type === args.type &&
        e.evidence === evidence
    );
  }

  if (args.commentRequestId) {
    const recent = await ctx.db
      .query("relationshipEvents")
      .withIndex("by_league_user_persona", (q) =>
        q
          .eq("leagueId", args.leagueId)
          .eq("userId", args.userId)
          .eq("persona", args.persona)
      )
      .order("desc")
      .take(100);
    return recent.some(
      (e) =>
        e.commentRequestId === args.commentRequestId &&
        e.type === args.type &&
        e.evidence === evidence
    );
  }

  return false;
}

/**
 * Upsert the relationship row, append the ledger entry, recompute the tier.
 * Shared by `recordEvent` and `recordArticleMentions` so the mutations stay in one
 * transaction instead of nesting `ctx.runMutation`. Reaction events do NOT go through
 * here - `reconcileReactionForUser` below reconciles the ledger against current state
 * instead of appending, so `isDuplicateEvent` never sees `type: "reaction"`.
 */
async function applyEvent(
  ctx: MutationCtx,
  args: ApplyEventArgs
): Promise<{ recorded: boolean; score: number; tier: RelationshipTier }> {
  const existingRow = await ctx.db
    .query("writerRelationships")
    .withIndex("by_league_user_persona", (q) =>
      q
        .eq("leagueId", args.leagueId)
        .eq("userId", args.userId)
        .eq("persona", args.persona)
    )
    .unique();

  if (await isDuplicateEvent(ctx, args)) {
    const score = existingRow?.score ?? 0;
    return { recorded: false, score, tier: tierForScore(score) };
  }

  const evidence = truncateEvidence(args.evidence);
  const now = Date.now();
  const previousScore = existingRow?.score ?? 0;
  const score = clampScore(previousScore + args.delta);
  const tier = tierForScore(score);
  const isDecay = args.type === "decay";

  if (existingRow) {
    await ctx.db.patch(existingRow._id, {
      score,
      tier,
      // Decay is bookkeeping, not an interaction: it must not inflate the
      // manager's event count or look like fresh contact with the writer.
      eventCount: isDecay ? existingRow.eventCount : existingRow.eventCount + 1,
      lastEventAt: isDecay ? existingRow.lastEventAt : now,
      teamId: args.teamId ?? existingRow.teamId,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("writerRelationships", {
      leagueId: args.leagueId,
      userId: args.userId,
      teamId: args.teamId,
      persona: args.persona,
      score,
      tier,
      eventCount: isDecay ? 0 : 1,
      lastEventAt: isDecay ? undefined : now,
      updatedAt: now,
    });
  }

  await ctx.db.insert("relationshipEvents", {
    leagueId: args.leagueId,
    userId: args.userId,
    persona: args.persona,
    type: args.type,
    delta: args.delta,
    articleId: args.articleId,
    commentRequestId: args.commentRequestId,
    week: args.week,
    evidence,
    createdAt: now,
  });

  return { recorded: true, score, tier };
}

/** Resolve a Clerk subject to the `users` row it belongs to. */
async function userByClerkId(
  ctx: QueryCtx | MutationCtx,
  clerkId: string
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .unique();
}

function managerNameFor(user: Doc<"users"> | null): string {
  return user?.name ?? user?.email ?? "Unknown manager";
}

/**
 * Manager -> team for a league season, via `teamClaims` (whose `userId` is a Clerk id).
 * `teams.owner` is an ESPN owner string and is never compared to a Convex user id.
 */
async function teamForUser(
  ctx: QueryCtx | MutationCtx,
  leagueId: Id<"leagues">,
  user: Doc<"users"> | null,
  seasonId: number
): Promise<Doc<"teams"> | null> {
  if (!user) return null;
  const claims = await ctx.db
    .query("teamClaims")
    .withIndex("by_user", (q) => q.eq("userId", user.clerkId))
    .take(50);
  const inLeague = claims.filter(
    (c) => c.leagueId === leagueId && c.status === "active"
  );
  if (inLeague.length === 0) return null;
  const claim =
    inLeague.find((c) => c.seasonId === seasonId) ??
    inLeague.sort((a, b) => b.seasonId - a.seasonId)[0];
  return await ctx.db.get(claim.teamId);
}

/** Team -> the manager who claimed it for a season. */
async function userForTeam(
  ctx: QueryCtx | MutationCtx,
  teamId: Id<"teams">,
  seasonId: number
): Promise<Doc<"users"> | null> {
  const claim = await ctx.db
    .query("teamClaims")
    .withIndex("by_team_season", (q) =>
      q.eq("teamId", teamId).eq("seasonId", seasonId)
    )
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();
  if (!claim) return null;
  return await userByClerkId(ctx, claim.userId);
}

async function recentEventsFor(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  userId: Id<"users">,
  persona: string,
  limit: number,
  includeDecay: boolean
): Promise<Array<Doc<"relationshipEvents">>> {
  const events = await ctx.db
    .query("relationshipEvents")
    .withIndex("by_league_user_persona", (q) =>
      q.eq("leagueId", leagueId).eq("userId", userId).eq("persona", persona)
    )
    .order("desc")
    .take(Math.max(limit * 4, 20));
  const filtered = includeDecay
    ? events
    : events.filter((e) => e.type !== "decay");
  return filtered.slice(0, limit);
}

function toEventDetail(event: Doc<"relationshipEvents">) {
  return {
    type: event.type,
    delta: event.delta,
    evidence: event.evidence,
    week: event.week,
    articleId: event.articleId,
    createdAt: event.createdAt,
  };
}

async function buildManagerMeters(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  user: Doc<"users">,
  seasonId: number,
  eventLimit: number
) {
  const team = await teamForUser(ctx, leagueId, user, seasonId);
  const rows = await ctx.db
    .query("writerRelationships")
    .withIndex("by_league_user", (q) =>
      q.eq("leagueId", leagueId).eq("userId", user._id)
    )
    .take(50);
  const byPersona = new Map(rows.map((r) => [r.persona, r]));

  const writers = [];
  for (const persona of ACTIVE_WRITERS) {
    const row = byPersona.get(persona);
    const events = row
      ? await recentEventsFor(ctx, leagueId, user._id, persona, eventLimit, true)
      : [];
    writers.push({
      persona,
      score: row?.score ?? 0,
      tier: row?.tier ?? tierForScore(0),
      eventCount: row?.eventCount ?? 0,
      lastEventAt: row?.lastEventAt,
      updatedAt: row?.updatedAt,
      recentEvents: events.map(toEventDetail),
    });
  }

  return {
    userId: user._id,
    managerName: managerNameFor(user),
    teamId: team?._id ?? null,
    teamName: team?.name ?? "Unclaimed team",
    writers,
  };
}

/* -------------------------------------------------------------------------- */
/* Internal mutations                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Record one relationship event and move the score. Idempotent per
 * (articleId | commentRequestId) + type + evidence.
 */
export const recordEvent = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    persona: v.string(),
    type: relationshipEventTypeValidator,
    delta: v.number(),
    evidence: v.string(),
    teamId: v.optional(v.id("teams")),
    articleId: v.optional(v.id("aiContent")),
    commentRequestId: v.optional(v.id("commentRequests")),
    week: v.optional(v.number()),
  },
  returns: recordResultValidator,
  handler: async (ctx, args) => {
    return await applyEvent(ctx, args);
  },
});

/**
 * Read the article's stored `managerMentions`, resolve each team to the manager who
 * claimed it, and record an `article_roast` / `article_praise` event per mention.
 * Neutral mentions are skipped. Called by `generateContentAction` after the save.
 */
export const recordArticleMentions = internalMutation({
  args: { articleId: v.id("aiContent") },
  returns: v.object({
    recorded: v.number(),
    skipped: v.number(),
    unresolved: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) {
      return { recorded: 0, skipped: 0, unresolved: [] };
    }
    const mentions = article.managerMentions ?? [];
    if (mentions.length === 0) {
      return { recorded: 0, skipped: 0, unresolved: [] };
    }

    const league = await ctx.db.get(article.leagueId);
    const seasonId = leagueCurrentSeason(league);
    const week = article.metadata?.week;

    let recorded = 0;
    let skipped = 0;
    const unresolved: string[] = [];
    const userCache = new Map<string, Doc<"users"> | null>();

    for (const mention of mentions) {
      if (mention.stance === "neutral") {
        skipped++;
        continue;
      }

      // `teamId` may arrive as a Convex team id or as a FACTS id ("T" + externalId).
      let teamId = ctx.db.normalizeId("teams", mention.teamId);
      if (!teamId) {
        const externalId = mention.teamId.startsWith("T")
          ? mention.teamId.slice(1)
          : mention.teamId;
        const team = await ctx.db
          .query("teams")
          .withIndex("by_external", (q) =>
            q
              .eq("leagueId", article.leagueId)
              .eq("externalId", externalId)
              .eq("seasonId", seasonId)
          )
          .first();
        teamId = team?._id ?? null;
      }
      if (!teamId) {
        unresolved.push(mention.teamId);
        continue;
      }

      const cacheKey = teamId as string;
      let user = userCache.get(cacheKey);
      if (user === undefined) {
        user = await userForTeam(ctx, teamId, seasonId);
        userCache.set(cacheKey, user);
      }
      if (!user) {
        unresolved.push(mention.teamId);
        continue;
      }

      const intensity = Math.min(3, Math.max(1, Math.round(mention.intensity))) as 1 | 2 | 3;
      const table =
        mention.stance === "roast" ? DELTAS.article_roast : DELTAS.article_praise;
      const result = await applyEvent(ctx, {
        leagueId: article.leagueId,
        userId: user._id,
        persona: article.persona,
        type: mention.stance === "roast" ? "article_roast" : "article_praise",
        delta: table[intensity],
        evidence: mention.evidence,
        teamId,
        articleId: article._id,
        week,
      });
      if (result.recorded) recorded++;
      else skipped++;
    }

    return { recorded, skipped, unresolved };
  },
});

/**
 * Reconcile the ledger + score for one (article, user) pair against the reader's
 * CURRENT `articleReactions` row - never against whatever reaction triggered the
 * call. `toggleReaction` schedules `syncReactionEvent` with `runAfter(0)`, so two
 * rapid taps can run their scheduled mutations out of order; reconciling against
 * stored state (rather than an in-flight "add this reaction" instruction) makes
 * every run converge on the correct result regardless of order.
 *
 * There may be several legacy `type: "reaction"` rows for this (article, user,
 * persona) left over from the old append-only behavior - "reset then apply"
 * collapses them: delete every existing row, then insert exactly one fresh row
 * matching the current reaction (or none, if the reaction was removed). Inserting
 * fresh rather than patching keeps the surviving entry sorted as the newest event.
 *
 * Shared by `syncReactionEvent` (called after every reaction change) and
 * `reconcileReactionEvents` (the one-time backfill over legacy duplicates).
 */
async function reconcileReactionForUser(
  ctx: MutationCtx,
  article: Doc<"aiContent">,
  user: Doc<"users">
): Promise<{ recorded: boolean; score: number; tier: RelationshipTier }> {
  const existingRows = (
    await ctx.db
      .query("relationshipEvents")
      .withIndex("by_article", (q) => q.eq("articleId", article._id))
      .take(500)
  ).filter(
    (e) =>
      e.userId === user._id &&
      e.persona === article.persona &&
      e.type === "reaction"
  );

  const current = await ctx.db
    .query("articleReactions")
    .withIndex("by_article_user", (q) =>
      q.eq("articleId", article._id).eq("userId", user.clerkId)
    )
    .unique();

  const targetDelta = current ? DELTAS.reaction[current.reaction] : 0;
  const evidence = current
    ? truncateEvidence(`Reacted "${current.reaction}" to "${article.title}"`)
    : undefined;

  const relationshipRow = await ctx.db
    .query("writerRelationships")
    .withIndex("by_league_user_persona", (q) =>
      q
        .eq("leagueId", article.leagueId)
        .eq("userId", user._id)
        .eq("persona", article.persona)
    )
    .unique();

  const isNoop =
    (existingRows.length === 0 && !current) ||
    (existingRows.length === 1 &&
      current !== null &&
      existingRows[0].evidence === evidence);
  if (isNoop) {
    const score = relationshipRow?.score ?? 0;
    return { recorded: false, score, tier: tierForScore(score) };
  }

  for (const existing of existingRows) {
    await ctx.db.delete(existing._id);
  }

  const now = Date.now();
  if (current) {
    await ctx.db.insert("relationshipEvents", {
      leagueId: article.leagueId,
      userId: user._id,
      persona: article.persona,
      type: "reaction",
      delta: targetDelta,
      articleId: article._id,
      week: article.metadata?.week,
      evidence: evidence!,
      createdAt: now,
    });
  }

  const priorDelta = existingRows.reduce((sum, e) => sum + e.delta, 0);
  const score = clampScore(
    (relationshipRow?.score ?? 0) - priorDelta + targetDelta
  );
  const tier = tierForScore(score);
  const eventCount = Math.max(
    0,
    (relationshipRow?.eventCount ?? 0) - existingRows.length + (current ? 1 : 0)
  );
  const lastEventAt = current ? now : relationshipRow?.lastEventAt;

  const league = await ctx.db.get(article.leagueId);
  const team = await teamForUser(
    ctx,
    article.leagueId,
    user,
    leagueCurrentSeason(league)
  );

  if (relationshipRow) {
    await ctx.db.patch(relationshipRow._id, {
      score,
      tier,
      eventCount,
      lastEventAt,
      teamId: team?._id ?? relationshipRow.teamId,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("writerRelationships", {
      leagueId: article.leagueId,
      userId: user._id,
      teamId: team?._id,
      persona: article.persona,
      score,
      tier,
      eventCount,
      lastEventAt,
      updatedAt: now,
    });
  }

  return { recorded: true, score, tier };
}

/**
 * A reader reaction on an article moves that article writer's relationship with the
 * reacting manager. Called from `articleEngagement.toggleReaction` after every
 * add/switch/remove. Does NOT take the reaction as an argument - it reads the truth
 * from `articleReactions` and reconciles the ledger to match (see
 * `reconcileReactionForUser`). `userId` is the reactor's Clerk id (the
 * `articleReactions.userId` convention).
 */
export const syncReactionEvent = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    userId: v.string(),
  },
  returns: recordResultValidator,
  handler: async (ctx, args) => {
    const neutral = { recorded: false, score: 0, tier: tierForScore(0) };
    const article = await ctx.db.get(args.articleId);
    if (!article) return neutral;

    const user = await userByClerkId(ctx, args.userId);
    if (!user) return neutral;

    return await reconcileReactionForUser(ctx, article, user);
  },
});

/**
 * One-time backfill: collapse every legacy duplicate `type: "reaction"` ledger row
 * (from the old append-only behavior, before `syncReactionEvent` existed) down to at
 * most one row per (article, user, persona), matching each reader's current reaction.
 * Batched across transactions by `_creationTime` cursor, mirroring `decayRelationships`.
 */
export const reconcileReactionEvents = internalMutation({
  args: {
    after: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    reconciled: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ scanned: number; reconciled: number; isDone: boolean }> => {
    const batchSize = Math.min(Math.max(args.batchSize ?? 200, 1), 200);
    const after = args.after ?? -1;

    const rows = await ctx.db
      .query("relationshipEvents")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", after))
      .take(batchSize);

    // Capture the cursor from the batch as READ, before `reconcileReactionForUser`
    // deletes/re-inserts any rows in it (a re-inserted row gets a NEW
    // `_creationTime`, which must not push the cursor backward or forward here).
    const lastReadCreationTime =
      rows.length > 0 ? rows[rows.length - 1]._creationTime : after;

    const seen = new Set<string>();
    let reconciled = 0;
    for (const eventRow of rows) {
      if (eventRow.type !== "reaction" || !eventRow.articleId) continue;
      const key = `${eventRow.articleId}:${eventRow.userId}:${eventRow.persona}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const article = await ctx.db.get(eventRow.articleId);
      if (!article) continue;
      const user = await ctx.db.get(eventRow.userId);
      if (!user) continue;

      const result = await reconcileReactionForUser(ctx, article, user);
      if (result.recorded) reconciled++;
    }

    const isDone = rows.length < batchSize;
    if (!isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.relationships.reconcileReactionEvents,
        { after: lastReadCreationTime, batchSize }
      );
    }

    return { scanned: rows.length, reconciled, isDone };
  },
});

/**
 * Weekly cooldown (spec §6.2): every non-zero score moves 15% toward 0, at least one
 * point, never crossing 0. Batched across transactions by `_creationTime` cursor.
 */
export const decayRelationships = internalMutation({
  args: {
    after: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    decayed: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ processed: number; decayed: number; isDone: boolean }> => {
    // Each row costs ~2 reads + 2 writes (row patch + ledger insert); keep the
    // batch well inside a single mutation transaction.
    const batchSize = Math.min(Math.max(args.batchSize ?? 100, 1), 200);
    const after = args.after ?? -1;

    const rows = await ctx.db
      .query("writerRelationships")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", after))
      .take(batchSize);

    let decayed = 0;
    for (const row of rows) {
      if (row.score === 0) continue;
      const magnitude = Math.abs(row.score);
      const step = Math.max(DECAY_MIN_STEP, Math.round(magnitude * DECAY_RATE));
      const nextMagnitude = Math.max(0, magnitude - step);
      const nextScore = Math.sign(row.score) * nextMagnitude;
      if (nextScore === row.score) continue;

      await applyEvent(ctx, {
        leagueId: row.leagueId,
        userId: row.userId,
        persona: row.persona,
        type: "decay",
        delta: nextScore - row.score,
        evidence: "Weekly cooldown",
      });
      decayed++;
    }

    const isDone = rows.length < batchSize;
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.relationships.decayRelationships, {
        after: rows[rows.length - 1]._creationTime,
        batchSize,
      });
    }

    return { processed: rows.length, decayed, isDone };
  },
});

/* -------------------------------------------------------------------------- */
/* Internal queries (prompt layer)                                              */
/* -------------------------------------------------------------------------- */

/**
 * `WriterRelationshipContext[]` for one writer, for the RELATIONSHIPS section of the
 * system prompt (spec §4.4). Decay entries are excluded from `recentEvents` - the
 * writer should remember what a manager did, not the weekly cooldown.
 * Passing `userIds` returns an entry per requested manager, neutral when no row exists.
 */
export const getRelationshipsForWriter = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    persona: v.string(),
    userIds: v.optional(v.array(v.id("users"))),
  },
  returns: v.array(writerRelationshipContextValidator),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    const seasonId = leagueCurrentSeason(league);

    let userIds: Array<Id<"users">>;
    const rowByUser = new Map<string, Doc<"writerRelationships">>();

    if (args.userIds && args.userIds.length > 0) {
      userIds = args.userIds;
      for (const userId of userIds) {
        const row = await ctx.db
          .query("writerRelationships")
          .withIndex("by_league_user_persona", (q) =>
            q
              .eq("leagueId", args.leagueId)
              .eq("userId", userId)
              .eq("persona", args.persona)
          )
          .unique();
        if (row) rowByUser.set(userId, row);
      }
    } else {
      const rows = await ctx.db
        .query("writerRelationships")
        .withIndex("by_league_persona", (q) =>
          q.eq("leagueId", args.leagueId).eq("persona", args.persona)
        )
        .take(200);
      for (const row of rows) rowByUser.set(row.userId, row);
      userIds = rows.map((r) => r.userId);
    }

    const contexts = [];
    for (const userId of userIds) {
      const row = rowByUser.get(userId);
      const user = await ctx.db.get(userId);
      if (!user) continue;
      const team =
        (row?.teamId ? await ctx.db.get(row.teamId) : null) ??
        (await teamForUser(ctx, args.leagueId, user, seasonId));
      const events = row
        ? await recentEventsFor(ctx, args.leagueId, userId, args.persona, 3, false)
        : [];
      const score = row?.score ?? 0;
      contexts.push({
        userId: userId as string,
        teamId: (team?._id ?? "") as string,
        teamName: team?.name ?? "Unclaimed team",
        managerName: managerNameFor(user),
        score,
        tier: row?.tier ?? tierForScore(score),
        recentEvents: events.map((e) => ({
          type: e.type,
          delta: e.delta,
          evidence: e.evidence,
          week: e.week,
        })),
      });
    }

    return contexts;
  },
});

/**
 * Roasts and praise a writer aimed at one manager recently, with the article title
 * joined. Sam Ortega uses these to build an opener or follow-up (spec §5).
 * `currentWeek` bounds the window to `sinceWeeks`; without it the most recent
 * `limit` mentions are returned regardless of week.
 */
export const getRecentWriterMentions = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    persona: v.string(),
    sinceWeeks: v.optional(v.number()),
    currentWeek: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      type: v.union(v.literal("article_roast"), v.literal("article_praise")),
      stance: v.union(v.literal("roast"), v.literal("praise")),
      delta: v.number(),
      evidence: v.string(),
      week: v.optional(v.number()),
      articleId: v.optional(v.id("aiContent")),
      articleTitle: v.optional(v.string()),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const sinceWeeks = args.sinceWeeks ?? 3;
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 25);

    const events = await ctx.db
      .query("relationshipEvents")
      .withIndex("by_league_user_persona", (q) =>
        q
          .eq("leagueId", args.leagueId)
          .eq("userId", args.userId)
          .eq("persona", args.persona)
      )
      .order("desc")
      .take(50);

    const mentions = events.filter(
      (e) => e.type === "article_roast" || e.type === "article_praise"
    );
    const windowed =
      args.currentWeek === undefined
        ? mentions
        : mentions.filter(
            (e) => e.week === undefined || e.week > args.currentWeek! - sinceWeeks
          );

    const titles = new Map<string, string | undefined>();
    const results = [];
    for (const event of windowed.slice(0, limit)) {
      let articleTitle: string | undefined;
      if (event.articleId) {
        if (!titles.has(event.articleId)) {
          const article = await ctx.db.get(event.articleId);
          titles.set(event.articleId, article?.title);
        }
        articleTitle = titles.get(event.articleId);
      }
      results.push({
        type: event.type as "article_roast" | "article_praise",
        stance: (event.type === "article_roast" ? "roast" : "praise") as
          | "roast"
          | "praise",
        delta: event.delta,
        evidence: event.evidence,
        week: event.week,
        articleId: event.articleId,
        articleTitle,
        createdAt: event.createdAt,
      });
    }
    return results;
  },
});

/* -------------------------------------------------------------------------- */
/* Public queries (meter UI)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in manager's meter against every active writer, with their last 5 events.
 * Identity comes from the auth token, never from an argument.
 */
export const getMyRelationships = query({
  args: { leagueId: v.id("leagues") },
  returns: v.union(managerMetersValidator, v.null()),
  handler: async (ctx, args) => {
    const { identity } = await requireLeagueMember(ctx, args.leagueId);
    const user = await userByClerkId(ctx, identity.subject);
    if (!user) return null;
    const league = await ctx.db.get(args.leagueId);
    return await buildManagerMeters(
      ctx,
      args.leagueId,
      user,
      leagueCurrentSeason(league),
      5
    );
  },
});

/** The same shape for any team in a league the caller belongs to. */
export const getTeamRelationships = query({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
  },
  returns: v.union(managerMetersValidator, v.null()),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    const team = await ctx.db.get(args.teamId);
    if (!team || team.leagueId !== args.leagueId) return null;

    const league = await ctx.db.get(args.leagueId);
    const seasonId = leagueCurrentSeason(league);
    const user = await userForTeam(ctx, args.teamId, seasonId);
    if (!user) return null;

    const meters = await buildManagerMeters(ctx, args.leagueId, user, seasonId, 5);
    // Prefer the requested team over the manager's current-season claim.
    return { ...meters, teamId: team._id, teamName: team.name };
  },
});

/** Every manager × every active writer, for the league homepage grid. */
export const getLeagueRelationshipMatrix = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    writers: v.array(v.string()),
    rows: v.array(
      v.object({
        userId: v.id("users"),
        managerName: v.string(),
        teamId: v.union(v.id("teams"), v.null()),
        teamName: v.string(),
        cells: v.array(
          v.object({
            persona: v.string(),
            score: v.number(),
            tier: relationshipTierValidator,
          })
        ),
      })
    ),
  }),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    const seasonId = leagueCurrentSeason(league);

    const claims = await ctx.db
      .query("teamClaims")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .take(200);
    const activeClaims = claims.filter(
      (c) => c.status === "active" && c.seasonId === seasonId
    );

    const rows = [];
    const seen = new Set<string>();
    for (const claim of activeClaims) {
      const user = await userByClerkId(ctx, claim.userId);
      if (!user || seen.has(user._id)) continue;
      seen.add(user._id);

      const team = await ctx.db.get(claim.teamId);
      const relationshipRows = await ctx.db
        .query("writerRelationships")
        .withIndex("by_league_user", (q) =>
          q.eq("leagueId", args.leagueId).eq("userId", user._id)
        )
        .take(50);
      const byPersona = new Map(relationshipRows.map((r) => [r.persona, r]));

      rows.push({
        userId: user._id,
        managerName: managerNameFor(user),
        teamId: team?._id ?? null,
        teamName: team?.name ?? "Unclaimed team",
        cells: ACTIVE_WRITERS.map((persona) => {
          const row = byPersona.get(persona);
          const score = row?.score ?? 0;
          return { persona, score, tier: row?.tier ?? tierForScore(score) };
        }),
      });
    }

    rows.sort((a, b) => a.teamName.localeCompare(b.teamName));
    return { writers: [...ACTIVE_WRITERS], rows };
  },
});
