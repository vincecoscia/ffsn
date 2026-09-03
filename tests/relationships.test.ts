import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { ACTIVE_WRITERS, tierForScore } from "../convex/relationships";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2025;
const CLERK_ANN = "clerk_manager_ann";
const CLERK_BOB = "clerk_manager_bob";

/**
 * One league, two managers who have each claimed a team for the league's current
 * season, and a membership row for each (the meter queries go through
 * `requireLeagueMember`). `teamClaims.userId` is a Clerk id, `writerRelationships.userId`
 * is a `users` id - the seed keeps both so the join in `relationships.ts` is exercised.
 */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Broadcast Desk Test League",
      platform: "espn",
      externalId: "9001",
      commissionerUserId: CLERK_ANN,
      settings: {
        scoringType: "PPR",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: [],
      },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 5,
        size: 2,
        lastSyncedAt: now,
        isPrivate: false,
      },
      subscription: {
        tier: "pro",
        status: "paid",
        creditsRemaining: 100,
        creditsMonthly: 100,
        paymentStatus: "completed",
        seasonYear: SEASON,
      },
      lastSync: now,
      createdAt: now,
    });

    const userAnn = await ctx.db.insert("users", {
      clerkId: CLERK_ANN,
      name: "Ann",
      email: "ann@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });
    const userBob = await ctx.db.insert("users", {
      clerkId: CLERK_BOB,
      name: "Bob",
      email: "bob@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    const teamAlpha = await ctx.db.insert("teams", {
      leagueId,
      externalId: "3",
      name: "Alpha",
      owner: "Ann",
      record: { wins: 3, losses: 1, ties: 0, pointsFor: 421.7 },
      roster: [],
      seasonId: SEASON,
      createdAt: now,
      updatedAt: now,
    });
    const teamBeta = await ctx.db.insert("teams", {
      leagueId,
      externalId: "7",
      name: "Beta",
      owner: "Bob",
      record: { wins: 1, losses: 3, ties: 0, pointsFor: 358.2 },
      roster: [],
      seasonId: SEASON,
      createdAt: now,
      updatedAt: now,
    });

    const claims = [
      { clerkId: CLERK_ANN, teamId: teamAlpha },
      { clerkId: CLERK_BOB, teamId: teamBeta },
    ];
    for (const { clerkId, teamId } of claims) {
      await ctx.db.insert("teamClaims", {
        leagueId,
        teamId,
        seasonId: SEASON,
        userId: clerkId,
        status: "active",
        credits: 0,
        createdAt: now,
      });
      await ctx.db.insert("leagueMemberships", {
        leagueId,
        userId: clerkId,
        role: clerkId === CLERK_ANN ? "commissioner" : "member",
        joinedAt: now,
      });
    }

    return { leagueId, userAnn, userBob, teamAlpha, teamBeta };
  });

  return { t, ...ids };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** An article by `persona`, optionally carrying the structured `managerMentions`. */
async function insertArticle(
  t: Setup["t"],
  leagueId: Setup["leagueId"],
  args: {
    persona: string;
    title: string;
    week?: number;
    managerMentions?: Array<{
      teamId: string;
      managerName: string;
      stance: "roast" | "praise" | "neutral";
      intensity: number;
      evidence: string;
    }>;
  }
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("aiContent", {
      leagueId,
      type: "weekly_recap",
      persona: args.persona,
      title: args.title,
      content: "body",
      metadata: { week: args.week, featured_teams: [], credits_used: 1 },
      status: "published",
      createdAt: Date.now(),
      managerMentions: args.managerMentions,
    })
  );
}

describe("relationships: recordEvent", () => {
  it("creates the row, appends the ledger entry, and skips an identical replay", async () => {
    const { t, leagueId, userAnn } = await setup();
    const articleId = await insertArticle(t, leagueId, {
      persona: "mel-diaper",
      title: "Mel torches the Alphas",
      week: 5,
    });

    const args = {
      leagueId,
      userId: userAnn,
      persona: "mel-diaper",
      type: "article_roast" as const,
      delta: -20,
      evidence: "nineteen picks of air",
      articleId,
      week: 5,
    };

    const first = await t.mutation(internal.relationships.recordEvent, args);
    expect(first).toEqual({ recorded: true, score: -20, tier: "cold" });

    // Same articleId + type + evidence: a replay of the same generation run.
    const replay = await t.mutation(internal.relationships.recordEvent, args);
    expect(replay).toEqual({ recorded: false, score: -20, tier: "cold" });

    const { rows, events } = await t.run(async (ctx) => ({
      rows: await ctx.db.query("writerRelationships").collect(),
      events: await ctx.db.query("relationshipEvents").collect(),
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: userAnn,
      persona: "mel-diaper",
      score: -20,
      tier: "cold",
      eventCount: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "article_roast",
      delta: -20,
      evidence: "nineteen picks of air",
      week: 5,
    });
  });

  it("clamps the score at -100 and +100", async () => {
    const { t, leagueId, userAnn } = await setup();
    const base = {
      leagueId,
      userId: userAnn,
      persona: "walt-brennan",
      type: "manual" as const,
    };

    const floor = await t.mutation(internal.relationships.recordEvent, {
      ...base,
      delta: -500,
      evidence: "a season of grievances",
    });
    expect(floor).toEqual({ recorded: true, score: -100, tier: "feud" });

    const ceiling = await t.mutation(internal.relationships.recordEvent, {
      ...base,
      delta: 500,
      evidence: "a season of forgiveness",
    });
    expect(ceiling).toEqual({ recorded: true, score: 100, tier: "favorite" });
  });
});

describe("relationships: tierForScore", () => {
  const boundaries: Array<[number, string]> = [
    [-100, "feud"],
    [-50, "feud"],
    [-49, "cold"],
    [-15, "cold"],
    [-14, "neutral"],
    [0, "neutral"],
    [14, "neutral"],
    [15, "warm"],
    [49, "warm"],
    [50, "favorite"],
    [100, "favorite"],
  ];

  it.each(boundaries)("score %i is %s", (score, tier) => {
    expect(tierForScore(score)).toBe(tier);
  });
});

describe("relationships: recordArticleMentions", () => {
  it("records one event per non-neutral mention, resolving 'T<externalId>' to the claiming manager", async () => {
    const { t, leagueId, userAnn, teamAlpha } = await setup();
    const articleId = await insertArticle(t, leagueId, {
      persona: "mel-diaper",
      title: "Mel torches the Alphas",
      week: 5,
      managerMentions: [
        {
          teamId: "T3",
          managerName: "Ann",
          stance: "roast",
          intensity: 3,
          evidence: "Ann spent a first-rounder on nineteen picks of air.",
        },
        {
          teamId: "T7",
          managerName: "Bob",
          stance: "neutral",
          intensity: 1,
          evidence: "Bob started the roster he drafted.",
        },
      ],
    });

    const result = await t.mutation(internal.relationships.recordArticleMentions, {
      articleId,
    });
    expect(result).toEqual({ recorded: 1, skipped: 1, unresolved: [] });

    const { rows, events } = await t.run(async (ctx) => ({
      rows: await ctx.db.query("writerRelationships").collect(),
      events: await ctx.db.query("relationshipEvents").collect(),
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: userAnn,
      teamId: teamAlpha,
      persona: "mel-diaper",
      score: -10,
      tier: "neutral",
      eventCount: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "article_roast",
      delta: -10,
      userId: userAnn,
      week: 5,
    });
  });
});

describe("relationships: syncReactionEvent", () => {
  async function relationshipRowFor(
    t: Setup["t"],
    leagueId: Setup["leagueId"],
    userId: Setup["userAnn"],
    persona: string
  ) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("writerRelationships")
        .withIndex("by_league_user_persona", (q) =>
          q.eq("leagueId", leagueId).eq("userId", userId).eq("persona", persona)
        )
        .unique()
    );
  }

  it("add, switch, replay, and remove all converge on at most one ledger row", async () => {
    const { t, leagueId, userAnn } = await setup();
    const articleId = await insertArticle(t, leagueId, {
      persona: "nina-sharpe",
      title: "Nina grades the week",
      week: 5,
    });

    // add: a fresh salty reaction moves the score and appends one row.
    await t.run(async (ctx) => {
      await ctx.db.insert("articleReactions", {
        articleId,
        userId: CLERK_ANN,
        reaction: "salty",
        createdAt: Date.now(),
      });
    });

    const added = await t.mutation(internal.relationships.syncReactionEvent, {
      articleId,
      userId: CLERK_ANN,
    });
    expect(added).toEqual({ recorded: true, score: -2, tier: "neutral" });

    let events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "reaction", delta: -2, persona: "nina-sharpe" });
    expect(events[0].evidence).toContain("salty");
    expect(await relationshipRowFor(t, leagueId, userAnn, "nina-sharpe")).toMatchObject({
      score: -2,
      eventCount: 1,
    });

    // switch: salty -> fire must undo the -2 and apply the +1, not just add +1.
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("articleReactions")
        .withIndex("by_article_user", (q) =>
          q.eq("articleId", articleId).eq("userId", CLERK_ANN)
        )
        .unique();
      await ctx.db.patch(existing!._id, { reaction: "fire" });
    });

    const switched = await t.mutation(internal.relationships.syncReactionEvent, {
      articleId,
      userId: CLERK_ANN,
    });
    expect(switched).toEqual({ recorded: true, score: 1, tier: "neutral" });

    events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].evidence).toContain("fire");
    expect(await relationshipRowFor(t, leagueId, userAnn, "nina-sharpe")).toMatchObject({
      score: 1,
      eventCount: 1,
    });

    // replay: syncing again with nothing changed is a no-op.
    const replay = await t.mutation(internal.relationships.syncReactionEvent, {
      articleId,
      userId: CLERK_ANN,
    });
    expect(replay).toEqual({ recorded: false, score: 1, tier: "neutral" });
    events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(1);

    // remove: deleting the reaction must reverse its delta, not leave it recorded.
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("articleReactions")
        .withIndex("by_article_user", (q) =>
          q.eq("articleId", articleId).eq("userId", CLERK_ANN)
        )
        .unique();
      await ctx.db.delete(existing!._id);
    });

    const removed = await t.mutation(internal.relationships.syncReactionEvent, {
      articleId,
      userId: CLERK_ANN,
    });
    expect(removed).toEqual({ recorded: true, score: 0, tier: "neutral" });
    events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(0);
    expect(await relationshipRowFor(t, leagueId, userAnn, "nina-sharpe")).toMatchObject({
      score: 0,
      eventCount: 0,
    });
  });

  it("collapses legacy duplicate ledger rows (salty then fire) into the row matching the current reaction", async () => {
    const { t, leagueId, userAnn } = await setup();
    const articleId = await insertArticle(t, leagueId, {
      persona: "nina-sharpe",
      title: "Nina grades the week",
      week: 5,
    });

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("articleReactions", {
        articleId,
        userId: CLERK_ANN,
        reaction: "fire",
        createdAt: now,
      });
      await ctx.db.insert("writerRelationships", {
        leagueId,
        userId: userAnn,
        persona: "nina-sharpe",
        score: -1,
        tier: "neutral",
        eventCount: 2,
        lastEventAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("relationshipEvents", {
        leagueId,
        userId: userAnn,
        persona: "nina-sharpe",
        type: "reaction",
        delta: -2,
        articleId,
        week: 5,
        evidence: `Reacted "salty" to "Nina grades the week"`,
        createdAt: now,
      });
      await ctx.db.insert("relationshipEvents", {
        leagueId,
        userId: userAnn,
        persona: "nina-sharpe",
        type: "reaction",
        delta: 1,
        articleId,
        week: 5,
        evidence: `Reacted "fire" to "Nina grades the week"`,
        createdAt: now + 1,
      });
    });

    const result = await t.mutation(internal.relationships.syncReactionEvent, {
      articleId,
      userId: CLERK_ANN,
    });
    expect(result).toEqual({ recorded: true, score: 1, tier: "neutral" });

    const events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].evidence).toContain("fire");
    expect(await relationshipRowFor(t, leagueId, userAnn, "nina-sharpe")).toMatchObject({
      score: 1,
      eventCount: 1,
    });
  });

  it("end to end through toggleReaction: salty then fire collapses to one row, toggling fire again clears it", async () => {
    const { t, leagueId, userAnn } = await setup();
    const articleId = await insertArticle(t, leagueId, {
      persona: "nina-sharpe",
      title: "Nina grades the week",
      week: 5,
    });

    const asAnn = t.withIdentity({ subject: CLERK_ANN });

    await asAnn.mutation(api.articleEngagement.toggleReaction, {
      articleId,
      reaction: "salty",
    });
    await asAnn.mutation(api.articleEngagement.toggleReaction, {
      articleId,
      reaction: "fire",
    });
    await t.finishAllScheduledFunctions(() => {});

    expect(await relationshipRowFor(t, leagueId, userAnn, "nina-sharpe")).toMatchObject({
      score: 1,
      eventCount: 1,
    });
    let events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].evidence).toContain("fire");

    // Tapping fire again removes the reaction.
    await asAnn.mutation(api.articleEngagement.toggleReaction, {
      articleId,
      reaction: "fire",
    });
    await t.finishAllScheduledFunctions(() => {});

    expect(await relationshipRowFor(t, leagueId, userAnn, "nina-sharpe")).toMatchObject({
      score: 0,
      eventCount: 0,
    });
    events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(0);
  });
});

describe("relationships: reconcileReactionEvents (backfill)", () => {
  it("collapses legacy duplicate ledger rows across two articles into one row each", async () => {
    const { t, leagueId, userAnn, userBob } = await setup();
    const articleA = await insertArticle(t, leagueId, {
      persona: "nina-sharpe",
      title: "Article A",
      week: 5,
    });
    const articleB = await insertArticle(t, leagueId, {
      persona: "dex-alvarez",
      title: "Article B",
      week: 5,
    });

    await t.run(async (ctx) => {
      const now = Date.now();

      // Article A / Ann: legacy salty(-2) then fire(+1); current reaction is fire.
      await ctx.db.insert("articleReactions", {
        articleId: articleA,
        userId: CLERK_ANN,
        reaction: "fire",
        createdAt: now,
      });
      await ctx.db.insert("writerRelationships", {
        leagueId,
        userId: userAnn,
        persona: "nina-sharpe",
        score: -1,
        tier: "neutral",
        eventCount: 2,
        lastEventAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("relationshipEvents", {
        leagueId,
        userId: userAnn,
        persona: "nina-sharpe",
        type: "reaction",
        delta: -2,
        articleId: articleA,
        week: 5,
        evidence: `Reacted "salty" to "Article A"`,
        createdAt: now,
      });
      await ctx.db.insert("relationshipEvents", {
        leagueId,
        userId: userAnn,
        persona: "nina-sharpe",
        type: "reaction",
        delta: 1,
        articleId: articleA,
        week: 5,
        evidence: `Reacted "fire" to "Article A"`,
        createdAt: now + 1,
      });

      // Article B / Bob: legacy salty(-2) then respect(+2); current reaction is respect.
      await ctx.db.insert("articleReactions", {
        articleId: articleB,
        userId: CLERK_BOB,
        reaction: "respect",
        createdAt: now,
      });
      await ctx.db.insert("writerRelationships", {
        leagueId,
        userId: userBob,
        persona: "dex-alvarez",
        score: 0,
        tier: "neutral",
        eventCount: 2,
        lastEventAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("relationshipEvents", {
        leagueId,
        userId: userBob,
        persona: "dex-alvarez",
        type: "reaction",
        delta: -2,
        articleId: articleB,
        week: 5,
        evidence: `Reacted "salty" to "Article B"`,
        createdAt: now,
      });
      await ctx.db.insert("relationshipEvents", {
        leagueId,
        userId: userBob,
        persona: "dex-alvarez",
        type: "reaction",
        delta: 2,
        articleId: articleB,
        week: 5,
        evidence: `Reacted "respect" to "Article B"`,
        createdAt: now + 1,
      });
    });

    const result = await t.mutation(internal.relationships.reconcileReactionEvents, {});
    await t.finishAllScheduledFunctions(() => {});
    expect(result.reconciled).toBe(2);
    expect(result.isDone).toBe(true);

    const events = await t.run((ctx) => ctx.db.query("relationshipEvents").collect());
    expect(events).toHaveLength(2);
    const byArticle = new Map(events.map((e) => [e.articleId, e]));
    expect(byArticle.get(articleA)).toMatchObject({ delta: 1 });
    expect(byArticle.get(articleB)).toMatchObject({ delta: 2 });

    const rows = await t.run((ctx) => ctx.db.query("writerRelationships").collect());
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    expect(byUser.get(userAnn)).toMatchObject({ score: 1, eventCount: 1 });
    expect(byUser.get(userBob)).toMatchObject({ score: 2, eventCount: 1 });
  });
});

describe("relationships: decayRelationships", () => {
  it("moves -40 to -34 and never crosses zero", async () => {
    const { t, leagueId, userAnn, userBob } = await setup();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("writerRelationships", {
        leagueId,
        userId: userAnn,
        persona: "mel-diaper",
        score: -40,
        tier: "cold",
        eventCount: 4,
        lastEventAt: now,
        updatedAt: now,
      });
      // One point from neutral: the minimum step of 1 must land on 0, not -1.
      await ctx.db.insert("writerRelationships", {
        leagueId,
        userId: userBob,
        persona: "mel-diaper",
        score: 1,
        tier: "neutral",
        eventCount: 1,
        lastEventAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(internal.relationships.decayRelationships, {});
    expect(result).toEqual({ processed: 2, decayed: 2, isDone: true });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("writerRelationships").collect()
    );
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    expect(byUser.get(userAnn)).toMatchObject({ score: -34, tier: "cold" });
    expect(byUser.get(userBob)).toMatchObject({ score: 0, tier: "neutral" });
    // Decay is bookkeeping: it must not look like fresh contact with the writer.
    expect(byUser.get(userAnn)?.eventCount).toBe(4);
    expect(byUser.get(userBob)?.eventCount).toBe(1);

    // A second pass keeps the zeroed row at zero rather than pushing it negative.
    await t.mutation(internal.relationships.decayRelationships, {});
    const after = await t.run(async (ctx) =>
      ctx.db.query("writerRelationships").collect()
    );
    expect(after.find((row) => row.userId === userBob)?.score).toBe(0);
    expect(after.find((row) => row.userId === userAnn)?.score).toBe(-29);
  });
});

describe("relationships: meter queries", () => {
  it("getMyRelationships requires auth and reads a missing row as neutral zero", async () => {
    const { t, leagueId } = await setup();

    await expect(
      t.query(api.relationships.getMyRelationships, { leagueId })
    ).rejects.toThrow(/not a member of this league/);

    const asAnn = t.withIdentity({ subject: CLERK_ANN });
    const meters = await asAnn.query(api.relationships.getMyRelationships, {
      leagueId,
    });

    expect(meters).not.toBeNull();
    expect(meters?.teamName).toBe("Alpha");
    expect(meters?.managerName).toBe("Ann");
    expect(meters?.writers.map((writer) => writer.persona)).toEqual([
      ...ACTIVE_WRITERS,
    ]);
    for (const writer of meters?.writers ?? []) {
      expect(writer).toMatchObject({
        score: 0,
        tier: "neutral",
        eventCount: 0,
        recentEvents: [],
      });
    }

    // No row is created just by reading the meter.
    const rows = await t.run(async (ctx) =>
      ctx.db.query("writerRelationships").collect()
    );
    expect(rows).toHaveLength(0);
  });

  it("getRecentWriterMentions joins the article title", async () => {
    const { t, leagueId, userAnn } = await setup();
    const articleId = await insertArticle(t, leagueId, {
      persona: "mel-diaper",
      title: "Mel torches the Alphas",
      week: 5,
    });
    await t.mutation(internal.relationships.recordEvent, {
      leagueId,
      userId: userAnn,
      persona: "mel-diaper",
      type: "article_roast",
      delta: -6,
      evidence: "nineteen picks of air",
      articleId,
      week: 5,
    });

    const mentions = await t.query(internal.relationships.getRecentWriterMentions, {
      leagueId,
      userId: userAnn,
      persona: "mel-diaper",
    });

    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      type: "article_roast",
      stance: "roast",
      delta: -6,
      evidence: "nineteen picks of air",
      week: 5,
      articleId,
      articleTitle: "Mel torches the Alphas",
    });
  });
});
