import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");
const SEASON = 2026;
const CLERK_COMMISSIONER = "user_purge_commish";

/** A league, a member, a published article, and everything the app hangs off it. */
async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "Purge Test League",
      platform: "espn",
      externalId: "7711",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: { seasonId: SEASON, currentScoringPeriod: 1, size: 2, lastSyncedAt: now, isPrivate: false },
      subscription: { tier: "pro", status: "paid", creditsRemaining: 0, creditsMonthly: 0, paymentStatus: "completed", seasonYear: SEASON },
      lastSync: now,
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      clerkId: CLERK_COMMISSIONER,
      name: "Commish",
      email: "commish@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });
    const articleId = await ctx.db.insert("aiContent", {
      leagueId,
      type: "season_welcome",
      persona: "mel-diaper",
      title: "Ten Teams, Seven Seasons",
      content: "A kickoff piece.",
      metadata: { week: 1, featured_teams: [], credits_used: 25 },
      status: "published",
      createdAt: now,
    });
    // A second article that must survive untouched.
    const otherId = await ctx.db.insert("aiContent", {
      leagueId,
      type: "weekly_recap",
      persona: "curtis-vaughn",
      title: "Week 1 recap",
      content: "Something else.",
      metadata: { week: 1, featured_teams: [], credits_used: 10 },
      status: "published",
      createdAt: now,
    });
    await ctx.db.insert("articleReactions", { articleId, userId: CLERK_COMMISSIONER, reaction: "salty", createdAt: now });
    await ctx.db.insert("articleReactions", { articleId: otherId, userId: CLERK_COMMISSIONER, reaction: "fire", createdAt: now });
    await ctx.db.insert("relationshipEvents", {
      leagueId,
      userId,
      persona: "mel-diaper",
      type: "article_roast",
      delta: -6,
      articleId,
      week: 1,
      evidence: "Gabe Coscia should be BANNED",
      createdAt: now,
    });
    const postId = await ctx.db.insert("wireLeaguePosts", {
      leagueId,
      seasonId: SEASON,
      week: 1,
      kind: "article_published",
      persona: "mel-diaper",
      text: `NEW PIECE. "Ten Teams, Seven Seasons". /articles/${articleId}. Read it.`,
      tags: [],
      featuredTeams: [],
      dedupeKey: `article:${articleId}`,
      createdAt: now,
    });
    const replyId = await ctx.db.insert("wireLeaguePosts", {
      leagueId,
      seasonId: SEASON,
      week: 1,
      kind: "manager_reply",
      text: "lol",
      tags: [],
      featuredTeams: [],
      dedupeKey: `reply:${now}`,
      authorUserId: CLERK_COMMISSIONER,
      replyTo: { scope: "league", id: postId },
      rootScope: "league",
      rootId: postId,
      createdAt: now + 1,
    });
    await ctx.db.insert("wireReactions", { postKey: `league:${postId}`, scope: "league", leagueId, userId: CLERK_COMMISSIONER, reaction: "fire", createdAt: now });
    await ctx.db.insert("wireReactions", { postKey: `league:${replyId}`, scope: "league", leagueId, userId: CLERK_COMMISSIONER, reaction: "lol", createdAt: now });
    return { leagueId, articleId, otherId, postId, replyId };
  });
}

describe("adminTools.purgeArticle: an article and everything that points at it", () => {
  it("dry run counts everything and deletes nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const result = await t.mutation(internal.adminTools.purgeArticle, { articleId: ids.articleId, dryRun: true });
    expect(result).toEqual({ found: true, dryRun: true, reactions: 1, relationshipEvents: 1, wirePosts: 1, wireReplies: 1, wireReactions: 2 });
    const still = await t.run(async (ctx) => ({
      article: await ctx.db.get(ids.articleId),
      posts: (await ctx.db.query("wireLeaguePosts").collect()).length,
      reactions: (await ctx.db.query("wireReactions").collect()).length,
    }));
    expect(still.article).not.toBeNull();
    expect(still.posts).toBe(2);
    expect(still.reactions).toBe(2);
  });

  it("the real run removes the article, its reactions, its ledger rows and its Wire thread, and nothing else", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const result = await t.mutation(internal.adminTools.purgeArticle, { articleId: ids.articleId, dryRun: false });
    expect(result.found).toBe(true);
    expect(result.wirePosts + result.wireReplies).toBe(2);
    const after = await t.run(async (ctx) => ({
      article: await ctx.db.get(ids.articleId),
      other: await ctx.db.get(ids.otherId),
      articleReactions: await ctx.db.query("articleReactions").collect(),
      events: await ctx.db.query("relationshipEvents").collect(),
      posts: await ctx.db.query("wireLeaguePosts").collect(),
      wireReactions: await ctx.db.query("wireReactions").collect(),
    }));
    expect(after.article).toBeNull();
    expect(after.other).not.toBeNull();
    expect(after.articleReactions.map((r) => r.articleId)).toEqual([ids.otherId]);
    expect(after.events).toHaveLength(0);
    expect(after.posts).toHaveLength(0);
    expect(after.wireReactions).toHaveLength(0);
  });

  it("an unknown article is reported as not found", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.mutation(internal.adminTools.purgeArticle, { articleId: ids.articleId, dryRun: false });
    const again = await t.mutation(internal.adminTools.purgeArticle, { articleId: ids.articleId, dryRun: false });
    expect(again.found).toBe(false);
  });
});
