import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import type { DataModel, Id } from "../../convex/_generated/dataModel";

const modules = import.meta.glob("../../convex/**/*.*s");

type TestCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, "storage">;

const SEASON = 2026;
const WEEK = 2;
// 2026-09-14 is a Monday; 20:15 ET that evening is 2026-09-15T00:15Z.
const MONDAY_KICKOFF = Date.UTC(2026, 8, 15, 0, 15);

async function seedLeague(ctx: TestCtx, opts: { wireEnabled?: boolean } = {}) {
  const now = Date.now();
  const leagueId = await ctx.db.insert("leagues", {
    name: "Live Engine Test League",
    platform: "espn",
    externalId: "8881",
    commissionerUserId: "clerk_commish_live",
    settings: { scoringType: "ppr", rosterSize: 16, playoffWeeks: 3, categories: [] },
    espnData: { seasonId: SEASON, currentScoringPeriod: WEEK, size: 10, lastSyncedAt: now, isPrivate: false },
    subscription: { tier: "season_pass", status: "active", creditsRemaining: 0, creditsMonthly: 0, paymentStatus: "completed", seasonYear: SEASON },
    lastSync: now,
    createdAt: now,
  });

  if (opts.wireEnabled !== undefined) {
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
      wireEnabled: opts.wireEnabled,
      createdAt: now,
      updatedAt: now,
    });
  }

  const homeTeamId = await ctx.db.insert("teams", {
    leagueId,
    externalId: "1",
    name: "Home Team",
    owner: "Home Manager",
    ownerInfo: { displayName: "Home Manager", id: "home-swid" },
    record: { wins: 0, losses: 0, ties: 0 },
    roster: [],
    seasonId: SEASON,
    createdAt: now,
    updatedAt: now,
  });
  const awayTeamId = await ctx.db.insert("teams", {
    leagueId,
    externalId: "2",
    name: "Away Team",
    owner: "Away Manager",
    ownerInfo: { displayName: "Away Manager", id: "away-swid" },
    record: { wins: 0, losses: 0, ties: 0 },
    roster: [],
    seasonId: SEASON,
    createdAt: now,
    updatedAt: now,
  });

  return { leagueId, homeTeamId, awayTeamId };
}

async function matchupPosts(ctx: TestCtx, leagueId: Id<"leagues">) {
  return ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId))
    .collect();
}

describe("processLeagueLiveSnapshot: matchup_live", () => {
  it("posts nothing on a matchup's first pull, but stores the snapshot", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));

    const result = await t.mutation(internal.wireLiveData.processLeagueLiveSnapshot, {
      leagueId,
      seasonId: SEASON,
      scoringPeriod: WEEK,
      matchups: [{ homeTeamId: "1", awayTeamId: "2", homeScore: 10, awayScore: 0, homePlayers: [], awayPlayers: [] }],
      checkMondayNeeds: false,
      now: Date.now(),
    });

    expect(result).toEqual({ matchupLivePosted: 0, mondayNeedsPosted: 0 });
    const posts = await t.run((ctx) => matchupPosts(ctx, leagueId));
    expect(posts).toHaveLength(0);

    const snapshot = await t.run((ctx) =>
      ctx.db
        .query("wireLiveSnapshots")
        .withIndex("by_league_period", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON).eq("scoringPeriod", WEEK))
        .first()
    );
    expect(snapshot?.matchups).toHaveLength(1);
    expect(snapshot?.matchups[0]).toMatchObject({ homeTeamId: "1", awayTeamId: "2", homeScore: 10, awayScore: 0 });
  });

  it("posts a matchup_live line the tick a blowout margin is first crossed, never again for the same trigger", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    const now = Date.now();

    // Seed a "previous" snapshot directly (margin 10 - not yet a blowout).
    await t.run((ctx) =>
      ctx.db.insert("wireLiveSnapshots", {
        leagueId,
        seasonId: SEASON,
        scoringPeriod: WEEK,
        takenAt: now - 60_000,
        matchups: [{ homeTeamId: "1", awayTeamId: "2", homeScore: 20, awayScore: 10, homePlayers: [], awayPlayers: [] }],
      })
    );

    const args = {
      leagueId,
      seasonId: SEASON,
      scoringPeriod: WEEK,
      matchups: [{ homeTeamId: "1", awayTeamId: "2", homeScore: 60, awayScore: 10, homePlayers: [], awayPlayers: [] }],
      checkMondayNeeds: false,
      now,
    };

    const first = await t.mutation(internal.wireLiveData.processLeagueLiveSnapshot, args);
    expect(first.matchupLivePosted).toBe(1);

    const posts = await t.run((ctx) => matchupPosts(ctx, leagueId));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: "matchup_live", persona: "curtis-vaughn" });
    expect(posts[0].text).toContain("Home Team");
    expect(posts[0].text).toContain("Away Team");

    // Same trigger, same day: dedupe key already exists, no second post.
    const second = await t.mutation(internal.wireLiveData.processLeagueLiveSnapshot, args);
    expect(second.matchupLivePosted).toBe(0);
    const postsAfter = await t.run((ctx) => matchupPosts(ctx, leagueId));
    expect(postsAfter).toHaveLength(1);
  });
});

describe("processLeagueLiveSnapshot: monday_needs", () => {
  async function seedMondaySchedule(ctx: TestCtx) {
    await ctx.db.insert("nflSchedules", {
      season: SEASON,
      week: WEEK,
      teamId: 12,
      teamAbbrev: "KC",
      opponent: "LV",
      isHome: true,
      gameTime: MONDAY_KICKOFF,
      isByeWeek: false,
      createdAt: Date.now(),
    });
  }

  async function seedPlayer(ctx: TestCtx, espnId: string, proTeamAbbrev: string, fullName: string) {
    const now = Date.now();
    await ctx.db.insert("playersEnhanced", {
      espnId,
      season: SEASON,
      fullName,
      defaultPositionId: 2,
      defaultPosition: "RB",
      eligibleSlots: [],
      eligiblePositions: ["RB"],
      proTeamId: 12,
      proTeamAbbrev,
      active: true,
      injured: false,
      droppable: true,
      ownership: { percentOwned: 80, percentStarted: 70 },
      createdAt: now,
      updatedAt: now,
    });
  }

  it("posts the deficit and the Monday starters for the trailing team", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    await t.run(seedMondaySchedule);
    await t.run((ctx) => seedPlayer(ctx, "555", "KC", "Monday Guy"));

    const result = await t.mutation(internal.wireLiveData.processLeagueLiveSnapshot, {
      leagueId,
      seasonId: SEASON,
      scoringPeriod: WEEK,
      matchups: [
        {
          homeTeamId: "1",
          awayTeamId: "2",
          homeScore: 50,
          awayScore: 80,
          homePlayers: [{ espnId: "555", points: 10, lineupSlotId: 2 }],
          awayPlayers: [],
        },
      ],
      checkMondayNeeds: true,
      now: Date.now(),
    });

    expect(result.mondayNeedsPosted).toBe(1);
    const posts = await t.run((ctx) => matchupPosts(ctx, leagueId));
    const mondayPost = posts.find((p) => p.kind === "monday_needs");
    expect(mondayPost).toBeDefined();
    expect(mondayPost!.persona).toBe("nina-sharpe");
    expect(mondayPost!.text).toContain("Monday Guy");
    expect(mondayPost!.text).toContain("30");
    expect(mondayPost!.text).toContain("Home Team");
  });

  it("skips a matchup with no starters on a Monday team", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    await t.run(seedMondaySchedule);
    // A trailing-team player whose NFL team is NOT playing Monday.
    await t.run((ctx) => seedPlayer(ctx, "556", "SEA", "Sunday Guy"));

    const result = await t.mutation(internal.wireLiveData.processLeagueLiveSnapshot, {
      leagueId,
      seasonId: SEASON,
      scoringPeriod: WEEK,
      matchups: [
        {
          homeTeamId: "1",
          awayTeamId: "2",
          homeScore: 50,
          awayScore: 80,
          homePlayers: [{ espnId: "556", points: 10, lineupSlotId: 2 }],
          awayPlayers: [],
        },
      ],
      checkMondayNeeds: true,
      now: Date.now(),
    });

    expect(result.mondayNeedsPosted).toBe(0);
  });

  it("skips a bench player on a Monday team (only starters count)", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    await t.run(seedMondaySchedule);
    await t.run((ctx) => seedPlayer(ctx, "557", "KC", "Bench Guy"));

    const result = await t.mutation(internal.wireLiveData.processLeagueLiveSnapshot, {
      leagueId,
      seasonId: SEASON,
      scoringPeriod: WEEK,
      matchups: [
        {
          homeTeamId: "1",
          awayTeamId: "2",
          homeScore: 50,
          awayScore: 80,
          homePlayers: [{ espnId: "557", points: 10, lineupSlotId: 20 }], // bench slot
          awayPlayers: [],
        },
      ],
      checkMondayNeeds: true,
      now: Date.now(),
    });

    expect(result.mondayNeedsPosted).toBe(0);
  });

  it("never checks monday_needs when checkMondayNeeds is false", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await t.run((ctx) => seedLeague(ctx));
    await t.run(seedMondaySchedule);
    await t.run((ctx) => seedPlayer(ctx, "555", "KC", "Monday Guy"));

    const result = await t.mutation(internal.wireLiveData.processLeagueLiveSnapshot, {
      leagueId,
      seasonId: SEASON,
      scoringPeriod: WEEK,
      matchups: [
        {
          homeTeamId: "1",
          awayTeamId: "2",
          homeScore: 50,
          awayScore: 80,
          homePlayers: [{ espnId: "555", points: 10, lineupSlotId: 2 }],
          awayPlayers: [],
        },
      ],
      checkMondayNeeds: false,
      now: Date.now(),
    });

    expect(result.mondayNeedsPosted).toBe(0);
  });
});
