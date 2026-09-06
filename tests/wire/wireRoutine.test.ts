import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import type { DataModel } from "../../convex/_generated/dataModel";

const modules = import.meta.glob("../../convex/**/*.*s");

type TestCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, "storage">;

const SEASON = 2026;
const CLERK_COMMISH = "clerk_commish_routine";

async function seedLeague(ctx: TestCtx) {
  const now = Date.now();
  const leagueId = await ctx.db.insert("leagues", {
    name: "Routine Test League",
    platform: "espn",
    externalId: "8881",
    commissionerUserId: CLERK_COMMISH,
    settings: { scoringType: "ppr", rosterSize: 16, playoffWeeks: 3, categories: [] },
    espnData: { seasonId: SEASON, currentScoringPeriod: 1, size: 10, lastSyncedAt: now, isPrivate: false },
    subscription: {
      tier: "season_pass",
      status: "active",
      creditsRemaining: 0,
      creditsMonthly: 0,
      paymentStatus: "completed",
      seasonYear: SEASON,
    },
    lastSync: now,
    createdAt: now,
  });

  const baseTeam = { leagueId, record: { wins: 0, losses: 0, ties: 0 }, roster: [] as never[], seasonId: SEASON, createdAt: now, updatedAt: now };
  const team1 = await ctx.db.insert("teams", { ...baseTeam, externalId: "1", name: "Team One", owner: "Manager One" });
  const team2 = await ctx.db.insert("teams", { ...baseTeam, externalId: "2", name: "Team Two", owner: "Manager Two" });
  const team3 = await ctx.db.insert("teams", { ...baseTeam, externalId: "3", name: "Team Three", owner: "Manager Three" });
  const team4 = await ctx.db.insert("teams", { ...baseTeam, externalId: "4", name: "Team Four", owner: "Manager Four" });

  return { leagueId, team1, team2, team3, team4 };
}

describe("wireRoutine: transactions", () => {
  it("waiver_processed reports the bid and counts the same player's failed claims as losing bids", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("playersEnhanced", {
        espnId: "9301",
        season: SEASON,
        fullName: "Waiver Wire Guy",
        defaultPositionId: 2,
        defaultPosition: "RB",
        eligibleSlots: [2],
        eligiblePositions: ["RB"],
        proTeamId: 1,
        active: true,
        injured: false,
        droppable: true,
        ownership: { percentOwned: 12, percentStarted: 4 },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("transactions", {
        leagueId,
        seasonId: SEASON,
        espnTransactionId: "txn-win",
        bidAmount: 14,
        executionType: "EXECUTE",
        isActingAsTeamOwner: true,
        isLeagueManager: false,
        isPending: false,
        items: [
          { fromLineupSlotId: 0, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 9301, toLineupSlotId: 20, toTeamId: 1, type: "ADD" },
        ],
        type: "WAIVER",
        proposedDate: now,
        processDate: now,
        status: "EXECUTED",
        scoringPeriod: 1,
        teamId: 1,
        outcome: "executed",
        createdAt: now,
      });
      await ctx.db.insert("transactions", {
        leagueId,
        seasonId: SEASON,
        espnTransactionId: "txn-lose",
        bidAmount: 8,
        executionType: "EXECUTE",
        isActingAsTeamOwner: true,
        isLeagueManager: false,
        isPending: false,
        items: [
          { fromLineupSlotId: 0, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 9301, toLineupSlotId: 20, toTeamId: 2, type: "ADD" },
        ],
        type: "WAIVER",
        proposedDate: now,
        processDate: now,
        status: "FAILED",
        scoringPeriod: 1,
        teamId: 2,
        outcome: "failed",
        createdAt: now,
      });
    });

    await t.mutation(internal.wireRoutine.onTransactionsUpserted, {
      leagueId,
      seasonId: SEASON,
      espnTransactionIds: ["txn-win", "txn-lose"],
    });

    const posts = await t.run((ctx) =>
      ctx.db
        .query("wireLeaguePosts")
        .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    const waiverPost = posts.find((p) => p.kind === "waiver_processed");
    expect(waiverPost).toBeDefined();
    expect(waiverPost!.text).toContain("$14");
    expect(waiverPost!.text).toMatch(/1 losing bid/);

    // The failed claim never gets its own routine post.
    expect(posts.filter((p) => p.kind === "waiver_processed")).toHaveLength(1);
  });

  it("only processes transactions inside the last 7 days", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

    await t.run(async (ctx) => {
      await ctx.db.insert("transactions", {
        leagueId,
        seasonId: SEASON,
        espnTransactionId: "txn-old",
        bidAmount: 5,
        executionType: "EXECUTE",
        isActingAsTeamOwner: true,
        isLeagueManager: false,
        isPending: false,
        items: [
          { fromLineupSlotId: 0, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId: 9302, toLineupSlotId: 20, toTeamId: 1, type: "ADD" },
        ],
        type: "WAIVER",
        proposedDate: eightDaysAgo,
        processDate: eightDaysAgo,
        status: "EXECUTED",
        scoringPeriod: 1,
        teamId: 1,
        outcome: "executed",
        createdAt: eightDaysAgo,
      });
    });

    await t.mutation(internal.wireRoutine.onTransactionsUpserted, {
      leagueId,
      seasonId: SEASON,
      espnTransactionIds: ["txn-old"],
    });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").collect());
    expect(posts).toHaveLength(0);
  });
});

describe("wireRoutine: matchups", () => {
  it("week_final + game_of_week + top_score + low_score fire once every matchup in the period is final", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("matchups", {
        leagueId,
        seasonId: SEASON,
        matchupPeriod: 1,
        scoringPeriod: 1,
        homeTeamId: "1",
        awayTeamId: "2",
        homeScore: 120,
        awayScore: 100,
        winner: "home",
        updatedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("matchups", {
        leagueId,
        seasonId: SEASON,
        matchupPeriod: 1,
        scoringPeriod: 1,
        homeTeamId: "3",
        awayTeamId: "4",
        homeScore: 90,
        awayScore: 88,
        winner: "home",
        updatedAt: now,
        createdAt: now,
      });
    });

    await t.mutation(internal.wireRoutine.onMatchupsUpdated, { leagueId, seasonId: SEASON, matchupPeriod: 1 });

    const posts = await t.run((ctx) =>
      ctx.db
        .query("wireLeaguePosts")
        .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId))
        .collect()
    );

    const weekFinal = posts.find((p) => p.kind === "week_final");
    const gameOfWeek = posts.find((p) => p.kind === "game_of_week");
    const topScore = posts.find((p) => p.kind === "top_score");
    const lowScore = posts.find((p) => p.kind === "low_score");

    expect(weekFinal).toBeDefined();
    expect(gameOfWeek).toBeDefined();
    // The closer game (margin 2) is game of the week, not the 20-point blowout.
    expect(gameOfWeek!.text).toContain("Team Three");
    expect(topScore).toBeDefined();
    expect(topScore!.text).toContain("Team One");
    expect(lowScore).toBeDefined();
    expect(lowScore!.text).toContain("Team Four");
  });

  it("does nothing while any matchup in the period is undecided", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("matchups", {
        leagueId,
        seasonId: SEASON,
        matchupPeriod: 1,
        scoringPeriod: 1,
        homeTeamId: "1",
        awayTeamId: "2",
        homeScore: 50,
        awayScore: 40,
        updatedAt: now,
        createdAt: now,
      });
    });

    await t.mutation(internal.wireRoutine.onMatchupsUpdated, { leagueId, seasonId: SEASON, matchupPeriod: 1 });

    const posts = await t.run((ctx) => ctx.db.query("wireLeaguePosts").collect());
    expect(posts).toHaveLength(0);
  });

  it("is idempotent on replay: calling twice never doubles the posts", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("matchups", {
        leagueId,
        seasonId: SEASON,
        matchupPeriod: 1,
        scoringPeriod: 1,
        homeTeamId: "1",
        awayTeamId: "2",
        homeScore: 120,
        awayScore: 100,
        winner: "home",
        updatedAt: now,
        createdAt: now,
      });
    });

    await t.mutation(internal.wireRoutine.onMatchupsUpdated, { leagueId, seasonId: SEASON, matchupPeriod: 1 });
    const firstCount = (await t.run((ctx) => ctx.db.query("wireLeaguePosts").collect())).length;
    expect(firstCount).toBeGreaterThan(0);

    await t.mutation(internal.wireRoutine.onMatchupsUpdated, { leagueId, seasonId: SEASON, matchupPeriod: 1 });
    const secondCount = (await t.run((ctx) => ctx.db.query("wireLeaguePosts").collect())).length;
    expect(secondCount).toBe(firstCount);
  });
});

describe("wireRoutine: article published", () => {
  it("the routine post's text carries no raw path, and its `article` ref points at the published article", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();
    const clerkMember = "clerk_member_article_routine";

    // getLeagueMembership (queried by wire.getLeaguePosts/getRecentForTicker) needs a membership
    // row; seedLeague's own subscription is already `status: "active"`, which hasActivePass needs.
    await t.run((ctx) =>
      ctx.db.insert("leagueMemberships", { leagueId, userId: clerkMember, role: "member", joinedAt: now })
    );

    const title = "Ten Teams, Seven Seasons, And One Trophy Nobody Can Pry Loose";
    const persona = "curtis-vaughn";
    const articleId = await t.run((ctx) =>
      ctx.db.insert("aiContent", {
        leagueId,
        type: "recap",
        persona,
        title,
        content: "Article body.",
        metadata: { week: 1, featured_teams: [], credits_used: 0 },
        status: "published",
        createdAt: now,
      })
    );

    await t.mutation(internal.wireRoutine.onArticlePublished, { articleId });

    const asMember = t.withIdentity({ subject: clerkMember });

    const posts = await asMember.query(api.wire.getLeaguePosts, {
      leagueId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const post = posts.page.find((p) => p.kind === "article_published");
    expect(post).toBeDefined();
    expect(post!.text).not.toContain("/articles/");
    expect(post!.article).toEqual({ id: articleId, title, persona });

    const ticker = await asMember.query(api.wire.getRecentForTicker, { leagueId, limit: 10 });
    const tickerItem = ticker.find((item) => item._id === post!._id);
    expect(tickerItem).toBeDefined();
    expect(tickerItem!.text).not.toContain("/articles/");
    expect(tickerItem!.article).toEqual({ id: articleId, title, persona });
  });
});
