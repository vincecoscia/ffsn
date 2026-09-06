import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import type { DataModel, Id } from "../../convex/_generated/dataModel";
import { MANAGER_POSTS_PER_HOUR } from "../../src/lib/ai/wire/types";

/**
 * The Wire's social layer (ffsn-the-wire-spec.md §17): reactions (and the relationship-meter sync
 * they trigger), manager posting/replying/deleting, and the manager statements the article
 * writers may quote. `onManagerPost` itself is a "use node" action that calls the model - its gate
 * logic is unit-tested directly in tests/wire/wireSocialRules.test.ts; here we only need
 * `wire.postAsManager` to land the post and schedule it, never to actually run it.
 */

const modules = import.meta.glob("../../convex/**/*.*s");

type TestCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, "storage">;

const SEASON = 2026;
const CLERK_COMMISH = "clerk_commish_social";
const CLERK_ANN = "clerk_ann_social";
const CLERK_BOB = "clerk_bob_social";
const CLERK_NOTEAM = "clerk_noteam_social";
const CLERK_OUTSIDER = "clerk_outsider_social";

async function seedLeague(
  ctx: TestCtx,
  opts: { passActive?: boolean; wireEnabled?: boolean; languageRating?: "clean" | "salty" | "unfiltered" } = {}
) {
  const now = Date.now();

  const leagueId = await ctx.db.insert("leagues", {
    name: "Wire Social Test League",
    platform: "espn",
    externalId: "8001",
    commissionerUserId: CLERK_COMMISH,
    settings: { scoringType: "ppr", rosterSize: 16, playoffWeeks: 3, categories: [] },
    espnData: { seasonId: SEASON, currentScoringPeriod: 1, size: 10, lastSyncedAt: now, isPrivate: false },
    subscription: {
      tier: "season_pass",
      status: opts.passActive === false ? "pending" : "active",
      creditsRemaining: 0,
      creditsMonthly: 0,
      paymentStatus: "completed",
      seasonYear: SEASON,
    },
    lastSync: now,
    createdAt: now,
  });

  await ctx.db.insert("leagueContentPreferences", {
    leagueId,
    contentEnabled: true,
    timezone: "America/New_York",
    currentMonthSpent: 0,
    budgetResetDate: now,
    notifyCommissioner: true,
    notifyFailures: true,
    autoPublish: true,
    requireApproval: false,
    languageRating: opts.languageRating ?? "clean",
    wireEnabled: opts.wireEnabled,
    createdAt: now,
    updatedAt: now,
  });

  for (const clerkId of [CLERK_COMMISH, CLERK_ANN, CLERK_BOB, CLERK_NOTEAM]) {
    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: clerkId,
      role: clerkId === CLERK_COMMISH ? "commissioner" : "member",
      joinedAt: now,
    });
  }

  const userCommish = await ctx.db.insert("users", {
    clerkId: CLERK_COMMISH,
    name: "Casey Commish",
    email: "commish@example.com",
    hasCompletedOnboarding: true,
    createdAt: now,
    lastActiveAt: now,
  });
  const userAnn = await ctx.db.insert("users", {
    clerkId: CLERK_ANN,
    name: "Ann Manager",
    email: "ann@example.com",
    hasCompletedOnboarding: true,
    createdAt: now,
    lastActiveAt: now,
  });
  const userBob = await ctx.db.insert("users", {
    clerkId: CLERK_BOB,
    name: "Bob Manager",
    email: "bob@example.com",
    hasCompletedOnboarding: true,
    createdAt: now,
    lastActiveAt: now,
  });
  await ctx.db.insert("users", {
    clerkId: CLERK_NOTEAM,
    name: "No Team",
    email: "noteam@example.com",
    hasCompletedOnboarding: true,
    createdAt: now,
    lastActiveAt: now,
  });

  const emptyRecord = { wins: 0, losses: 0, ties: 0, pointsFor: 0 };
  const teamCommish = await ctx.db.insert("teams", {
    leagueId,
    externalId: "1",
    name: "Commish Crew",
    owner: "Casey",
    record: emptyRecord,
    roster: [],
    seasonId: SEASON,
    createdAt: now,
    updatedAt: now,
  });
  const teamAnn = await ctx.db.insert("teams", {
    leagueId,
    externalId: "2",
    name: "Ann's Aces",
    owner: "Ann",
    record: emptyRecord,
    roster: [],
    seasonId: SEASON,
    createdAt: now,
    updatedAt: now,
  });
  const teamBob = await ctx.db.insert("teams", {
    leagueId,
    externalId: "3",
    name: "Bob's Best",
    owner: "Bob",
    record: emptyRecord,
    roster: [],
    seasonId: SEASON,
    createdAt: now,
    updatedAt: now,
  });

  for (const [clerkId, teamId] of [
    [CLERK_COMMISH, teamCommish],
    [CLERK_ANN, teamAnn],
    [CLERK_BOB, teamBob],
  ] as const) {
    await ctx.db.insert("teamClaims", {
      leagueId,
      teamId,
      seasonId: SEASON,
      userId: clerkId,
      status: "active",
      credits: 0,
      createdAt: now,
    });
  }

  return { leagueId, userCommish, userAnn, userBob, teamCommish, teamAnn, teamBob };
}

async function seedGlobalWriterPost(ctx: TestCtx) {
  const now = Date.now();
  const eventId = await ctx.db.insert("wireEvents", {
    kind: "injury_status",
    dedupeKey: `social-test:${now}:${Math.random()}`,
    observedAt: now,
    detectedAt: now,
    players: [{ espnId: "9501", name: "Wire Test Player" }],
    facts: {
      kind: "injury_status",
      observedAt: now,
      players: [{ espnId: "9501", name: "Wire Test Player" }],
      statusTo: "Out",
      source: { type: "espn_injuries", fetchedAt: now },
    },
    interest: 70,
    source: { type: "espn_injuries", fetchedAt: now },
  });
  return await ctx.db.insert("wirePosts", {
    eventId,
    kind: "injury_status",
    persona: "dex-alvarez",
    text: "Wire Test Player: out for the season.",
    tags: ["REPORTED"],
    status: "take",
    interest: 70,
    createdAt: now,
    updatedAt: now,
  });
}

/** A writer routine post (persona set, no author) - the kind of league post a manager can reply to. */
async function seedWriterLeaguePost(ctx: TestCtx, leagueId: Id<"leagues">) {
  const now = Date.now();
  return await ctx.db.insert("wireLeaguePosts", {
    leagueId,
    seasonId: SEASON,
    kind: "week_final",
    persona: "curtis-vaughn",
    text: "Week 1 is in the books.",
    tags: ["FINAL"],
    featuredTeams: [],
    dedupeKey: `week_final:social-test:${now}:${Math.random()}`,
    createdAt: now,
  });
}

describe("wire.react", () => {
  it("toggles: reacting the same way twice removes it, keeping reactionCounts in sync", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const postId = await t.run((ctx) => seedGlobalWriterPost(ctx));

    const asAnn = t.withIdentity({ subject: CLERK_ANN });

    const first = await asAnn.mutation(api.wire.react, {
      leagueId,
      scope: "global",
      postId: postId as unknown as string,
      reaction: "fire",
    });
    expect(first.mine).toBe("fire");
    let post = await t.run((ctx) => ctx.db.get(postId));
    expect(post?.reactionCounts).toEqual({ fire: 1, lol: 0, salty: 0, respect: 0 });

    const second = await asAnn.mutation(api.wire.react, {
      leagueId,
      scope: "global",
      postId: postId as unknown as string,
      reaction: "fire",
    });
    expect(second.mine).toBeNull();
    post = await t.run((ctx) => ctx.db.get(postId));
    expect(post?.reactionCounts).toEqual({ fire: 0, lol: 0, salty: 0, respect: 0 });
  });

  it("replacing: a different reaction on the same post swaps it", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const postId = await t.run((ctx) => seedGlobalWriterPost(ctx));
    const asAnn = t.withIdentity({ subject: CLERK_ANN });

    await asAnn.mutation(api.wire.react, { leagueId, scope: "global", postId: postId as unknown as string, reaction: "fire" });
    const swapped = await asAnn.mutation(api.wire.react, {
      leagueId,
      scope: "global",
      postId: postId as unknown as string,
      reaction: "lol",
    });
    expect(swapped.mine).toBe("lol");

    const post = await t.run((ctx) => ctx.db.get(postId));
    expect(post?.reactionCounts).toEqual({ fire: 0, lol: 1, salty: 0, respect: 0 });
  });

  it("two managers' reactions accumulate independently", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const postId = await t.run((ctx) => seedGlobalWriterPost(ctx));

    await t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.react, {
      leagueId,
      scope: "global",
      postId: postId as unknown as string,
      reaction: "fire",
    });
    await t.withIdentity({ subject: CLERK_BOB }).mutation(api.wire.react, {
      leagueId,
      scope: "global",
      postId: postId as unknown as string,
      reaction: "salty",
    });

    const post = await t.run((ctx) => ctx.db.get(postId));
    expect(post?.reactionCounts).toEqual({ fire: 1, lol: 0, salty: 1, respect: 0 });
  });

  it("refuses a post that does not belong to this league", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const { leagueId: otherLeagueId } = await t.run((ctx) => seedLeague(ctx));
    const otherLeaguePostId = await t.run((ctx) => seedWriterLeaguePost(ctx, otherLeagueId));

    await expect(
      t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.react, {
        leagueId,
        scope: "league",
        postId: otherLeaguePostId as unknown as string,
        reaction: "fire",
      })
    ).rejects.toThrow();
  });
});

describe("reaction -> relationship sync (spec §17.2)", () => {
  it("a reaction on a writer's global post leaves exactly one ledger row; removing it deletes the row", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, userAnn } = await t.run((ctx) => seedLeague(ctx));
    const postId = await t.run((ctx) => seedGlobalWriterPost(ctx));
    const asAnn = t.withIdentity({ subject: CLERK_ANN });

    await asAnn.mutation(api.wire.react, { leagueId, scope: "global", postId: postId as unknown as string, reaction: "fire" });
    await t.finishAllScheduledFunctions(() => {});

    let events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      leagueId,
      userId: userAnn,
      persona: "dex-alvarez",
      type: "reaction",
      delta: 1,
      wirePostKey: `global:${postId}`,
    });
    expect(events[0].evidence).toContain("dex-alvarez");

    const relRow = await t.run((ctx) =>
      ctx.db
        .query("writerRelationships")
        .withIndex("by_league_user_persona", (q) => q.eq("leagueId", leagueId).eq("userId", userAnn).eq("persona", "dex-alvarez"))
        .unique()
    );
    expect(relRow?.score).toBe(1);

    // Un-react (tap fire again) - the ledger row must disappear, not just zero out.
    await asAnn.mutation(api.wire.react, { leagueId, scope: "global", postId: postId as unknown as string, reaction: "fire" });
    await t.finishAllScheduledFunctions(() => {});

    events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(0);
  });

  it("a lol reaction (zero delta) never leaves a ledger row", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const postId = await t.run((ctx) => seedGlobalWriterPost(ctx));

    await t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.react, {
      leagueId,
      scope: "global",
      postId: postId as unknown as string,
      reaction: "lol",
    });
    await t.finishAllScheduledFunctions(() => {});

    const events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(0);
  });

  it("a reaction on a manager's own post moves nothing", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, userAnn, teamAnn } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();
    const annPostId = await t.run((ctx) =>
      ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "manager_post",
        text: "Anybody want to trade for my WR2?",
        tags: [],
        featuredTeams: [teamAnn],
        dedupeKey: `manager:${CLERK_ANN}:${now}`,
        authorUserId: CLERK_ANN,
        authorTeamId: teamAnn,
        createdAt: now,
      })
    );
    void userAnn;

    await t.withIdentity({ subject: CLERK_BOB }).mutation(api.wire.react, {
      leagueId,
      scope: "league",
      postId: annPostId as unknown as string,
      reaction: "fire",
    });
    await t.finishAllScheduledFunctions(() => {});

    const events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(0);
    // The reaction itself still lands, just moves no meter.
    const post = await t.run((ctx) => ctx.db.get(annPostId));
    expect(post?.reactionCounts).toEqual({ fire: 1, lol: 0, salty: 0, respect: 0 });
  });
});

describe("wire.postAsManager", () => {
  it("refuses a non-member of the league", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));

    await expect(
      t.withIdentity({ subject: CLERK_OUTSIDER }).mutation(api.wire.postAsManager, { leagueId, text: "Hello league" })
    ).rejects.toThrow();
  });

  it("refuses a member with no claimed team", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));

    await expect(
      t.withIdentity({ subject: CLERK_NOTEAM }).mutation(api.wire.postAsManager, { leagueId, text: "Hello league" })
    ).rejects.toThrow("Claim your team to post on The Wire");
  });

  it("refuses profanity on a league rated Clean", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx, { languageRating: "clean" }));

    await expect(
      t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.postAsManager, {
        leagueId,
        text: "This roster sucks this year",
      })
    ).rejects.toThrow();
  });

  it("enforces MANAGER_POSTS_PER_HOUR", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const asAnn = t.withIdentity({ subject: CLERK_ANN });

    for (let i = 0; i < MANAGER_POSTS_PER_HOUR; i++) {
      await asAnn.mutation(api.wire.postAsManager, { leagueId, text: `Post number ${i}` });
    }

    await expect(
      asAnn.mutation(api.wire.postAsManager, { leagueId, text: "One too many" })
    ).rejects.toThrow(`Slow down: ${MANAGER_POSTS_PER_HOUR} posts an hour`);
  });

  it("threads a reply to a global writer post: replyTo/rootScope/rootId, surfaced by getGlobalPosts", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const globalPostId = await t.run((ctx) => seedGlobalWriterPost(ctx));

    const { postId: replyId } = await t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.postAsManager, {
      leagueId,
      text: "Brutal news for my roster",
      replyTo: { scope: "global", id: globalPostId as unknown as string },
    });

    const stored = await t.run((ctx) => ctx.db.get(replyId));
    expect(stored?.kind).toBe("manager_reply");
    expect(stored?.replyTo).toEqual({ scope: "global", id: globalPostId });
    expect(stored?.rootScope).toBe("global");
    expect(stored?.rootId).toBe(globalPostId as unknown as string);

    const asAnn = t.withIdentity({ subject: CLERK_ANN });
    const globalPage = await asAnn.query(api.wire.getGlobalPosts, {
      leagueId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const seeded = globalPage.page.find((p) => p._id === globalPostId);
    expect(seeded?.replies).toHaveLength(1);
    expect(seeded?.replies[0]).toMatchObject({
      kind: "manager_reply",
      text: "Brutal news for my roster",
    });
    expect(seeded?.replies[0].author?.displayName).toBe("Ann Manager");
    expect(seeded?.reactions).toEqual({ counts: { fire: 0, lol: 0, salty: 0, respect: 0 }, mine: undefined });
  });

  it("threads a reply-to-a-reply into the same flattened list, and getLeaguePosts exposes root posts with author/canDelete", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));

    const { postId: rootId } = await t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.postAsManager, {
      leagueId,
      text: "Anyone want to trade for my WR2?",
    });

    const { postId: bobReplyId } = await t.withIdentity({ subject: CLERK_BOB }).mutation(api.wire.postAsManager, {
      leagueId,
      text: "I'll take a look",
      replyTo: { scope: "league", id: rootId as unknown as string },
    });
    const bobReply = await t.run((ctx) => ctx.db.get(bobReplyId));
    expect(bobReply?.rootScope).toBe("league");
    expect(bobReply?.rootId).toBe(rootId as unknown as string);

    // A third reply, answering Bob's reply, must still resolve to the SAME root.
    const { postId: annReplyId } = await t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.postAsManager, {
      leagueId,
      text: "Sounds good, DMing you",
      replyTo: { scope: "league", id: bobReplyId as unknown as string },
    });
    const annReply = await t.run((ctx) => ctx.db.get(annReplyId));
    expect(annReply?.rootScope).toBe("league");
    expect(annReply?.rootId).toBe(rootId as unknown as string);

    const asAnn = t.withIdentity({ subject: CLERK_ANN });
    const leaguePage = await asAnn.query(api.wire.getLeaguePosts, {
      leagueId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    // Only the ROOT post is listed at the top level - both replies nest under it.
    expect(leaguePage.page.map((p) => p._id)).toEqual([rootId]);
    const root = leaguePage.page[0];
    expect(root.author?.displayName).toBe("Ann Manager");
    expect(root.canDelete).toBe(true); // viewer is Ann, the author
    expect(root.replies.map((r) => r.text)).toEqual(["I'll take a look", "Sounds good, DMing you"]);

    const asBob = t.withIdentity({ subject: CLERK_BOB });
    const asBobPage = await asBob.query(api.wire.getLeaguePosts, {
      leagueId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(asBobPage.page[0].canDelete).toBe(false); // Bob is neither the author nor the commissioner
  });
});

describe("wire.deletePost", () => {
  it("the author may delete their own post", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const { postId } = await t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.postAsManager, {
      leagueId,
      text: "Deleting this later",
    });

    await t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.deletePost, { leagueId, postId });

    const stored = await t.run((ctx) => ctx.db.get(postId));
    expect(stored?.deletedAt).toBeDefined();
    expect(stored?.deletedBy).toBe("author");
  });

  it("the commissioner may delete another member's post", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const { postId } = await t.withIdentity({ subject: CLERK_BOB }).mutation(api.wire.postAsManager, {
      leagueId,
      text: "Bob's post",
    });

    await t.withIdentity({ subject: CLERK_COMMISH }).mutation(api.wire.deletePost, { leagueId, postId });

    const stored = await t.run((ctx) => ctx.db.get(postId));
    expect(stored?.deletedBy).toBe("commissioner");
  });

  it("refuses another member who is neither the author nor the commissioner", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const { postId } = await t.withIdentity({ subject: CLERK_BOB }).mutation(api.wire.postAsManager, {
      leagueId,
      text: "Bob's post",
    });

    await expect(
      t.withIdentity({ subject: CLERK_ANN }).mutation(api.wire.deletePost, { leagueId, postId })
    ).rejects.toThrow();

    const stored = await t.run((ctx) => ctx.db.get(postId));
    expect(stored?.deletedAt).toBeUndefined();
  });
});

describe("wire.getManagerStatementsForArticle", () => {
  it("shape: one entry per author, source 'wire', capped at 6 quotes total across authors", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, teamAnn, teamBob, teamCommish } = await t.run((ctx) => seedLeague(ctx));

    // Ann's posts are the newest (visited first), then Bob's, then Casey's - explicit
    // timestamps so the 6-quote cap lands deterministically across exactly two authors.
    const since = Date.now() - 1000;
    await t.run(async (ctx) => {
      const authors: Array<[string, Id<"teams">]> = [
        [CLERK_ANN, teamAnn],
        [CLERK_BOB, teamBob],
        [CLERK_COMMISH, teamCommish],
      ];
      let t0 = since + 900;
      for (const [clerkId, teamId] of authors) {
        for (let i = 0; i < 3; i++) {
          await ctx.db.insert("wireLeaguePosts", {
            leagueId,
            seasonId: SEASON,
            kind: "manager_post",
            text: `${clerkId} statement ${i}`,
            tags: [],
            featuredTeams: [teamId],
            dedupeKey: `manager:${clerkId}:${t0}`,
            authorUserId: clerkId,
            authorTeamId: teamId,
            createdAt: t0,
          });
          t0 -= 1;
        }
      }
    });

    const entries = await t.query(internal.wire.getManagerStatementsForArticle, { leagueId, since });

    const totalQuotes = entries.reduce((sum, e) => sum + e.quotes.length, 0);
    expect(totalQuotes).toBeLessThanOrEqual(6);
    expect(totalQuotes).toBe(6);
    for (const entry of entries) {
      expect(entry.source).toBe("wire");
      expect(entry.questionTopic).toBe("said on The Wire");
      expect(entry.quotes.length).toBeGreaterThan(0);
      expect(entry.rawResponse).toBe(entry.quotes.join("\n"));
    }
    // Ann and Bob's statements are the newest - Casey's are cut off entirely by the cap.
    expect(entries.map((e) => e.teamName).sort()).toEqual(["Ann's Aces", "Bob's Best"]);
  });

  it("ignores deleted posts and posts outside the window", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, teamAnn } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "manager_post",
        text: "too old",
        tags: [],
        featuredTeams: [teamAnn],
        dedupeKey: "manager:old",
        authorUserId: CLERK_ANN,
        authorTeamId: teamAnn,
        createdAt: now - 10_000,
      });
      await ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "manager_post",
        text: "deleted",
        tags: [],
        featuredTeams: [teamAnn],
        dedupeKey: "manager:deleted",
        authorUserId: CLERK_ANN,
        authorTeamId: teamAnn,
        deletedAt: now,
        deletedBy: "author",
        createdAt: now,
      });
    });

    const entries = await t.query(internal.wire.getManagerStatementsForArticle, {
      leagueId,
      since: now - 1000,
    });
    expect(entries).toEqual([]);
  });
});

describe("deskMetrics.getLeagueSeasonSpend includes writer_reply cost (spec §17.4)", () => {
  it("sums a writer_reply row's generationStats.costUsd into automatedUsd/totalUsd", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));

    await t.run((ctx) =>
      ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "writer_reply",
        persona: "dex-alvarez",
        text: "Ice cold, but that's the business.",
        tags: [],
        featuredTeams: [],
        dedupeKey: "writer_reply:test-1",
        generationStats: { costUsd: 0.0123, model: "claude-sonnet-5", effort: "low" },
        createdAt: Date.now(),
      })
    );

    const spend = await t.query(internal.deskMetrics.getLeagueSeasonSpend, { leagueId, seasonId: SEASON });
    expect(spend.automatedUsd).toBeCloseTo(0.0123, 6);
    expect(spend.totalUsd).toBeCloseTo(0.0123, 6);
  });
});
