import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { GenericActionCtx, GenericMutationCtx } from "convex/server";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import type { DataModel, Id } from "../../convex/_generated/dataModel";
import type { WireDigestData } from "../../src/lib/ai/wire/types";

const modules = import.meta.glob("../../convex/**/*.*s");

type TestCtx = GenericMutationCtx<DataModel> & Pick<GenericActionCtx<DataModel>, "storage">;

const SEASON = 2026;
const WINDOW_END = Date.UTC(2026, 8, 14, 4, 0); // Monday 04:00 UTC
const WINDOW_START = WINDOW_END - 24 * 60 * 60 * 1000;
const IN_WINDOW = WINDOW_START + 60 * 60 * 1000; // an hour into the window
const BEFORE_WINDOW = WINDOW_START - 60 * 60 * 1000;

interface SeedOpts {
  wireAlerts?: "off" | "my_roster" | "all";
  emailNotifications?: boolean;
  passActive?: boolean;
  wireEnabled?: boolean;
}

async function seedUserWithLeague(ctx: TestCtx, opts: SeedOpts = {}) {
  const now = Date.now();
  const clerkId = "clerk_digest_user";
  const userId = await ctx.db.insert("users", {
    clerkId,
    email: "manager@example.com",
    name: "Test Manager",
    hasCompletedOnboarding: true,
    preferences: {
      emailNotifications: opts.emailNotifications ?? true,
      wireAlerts: opts.wireAlerts,
    },
    createdAt: now,
    lastActiveAt: now,
  });

  const leagueId = await ctx.db.insert("leagues", {
    name: "Digest Test League",
    platform: "espn",
    externalId: "9991",
    commissionerUserId: "clerk_commish_digest",
    settings: { scoringType: "ppr", rosterSize: 16, playoffWeeks: 3, categories: [] },
    espnData: { seasonId: SEASON, currentScoringPeriod: 2, size: 10, lastSyncedAt: now, isPrivate: false },
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

  const teamId = await ctx.db.insert("teams", {
    leagueId,
    externalId: "1",
    name: "My Team",
    owner: "Test Manager",
    ownerInfo: { displayName: "Test Manager", id: "swid-1" },
    record: { wins: 0, losses: 0, ties: 0 },
    roster: [],
    seasonId: SEASON,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("teamClaims", {
    leagueId,
    teamId,
    seasonId: SEASON,
    userId: clerkId,
    status: "active",
    credits: 0,
    createdAt: now,
  });

  return { userId, leagueId, teamId };
}

async function seedOwnerOverlay(ctx: TestCtx, leagueId: Id<"leagues">, teamId: Id<"teams">, text: string, createdAt: number) {
  const eventId = await ctx.db.insert("wireEvents", {
    kind: "injury_status",
    dedupeKey: `digest-test:${createdAt}:${Math.random()}`,
    observedAt: createdAt,
    detectedAt: createdAt,
    players: [{ espnId: "1", name: "Star Player" }],
    facts: {},
    interest: 70,
    source: { type: "espn_injuries", fetchedAt: createdAt },
  });
  const globalPostId = await ctx.db.insert("wirePosts", {
    eventId,
    kind: "injury_status",
    persona: "dex-alvarez",
    text: "global card text",
    tags: ["REPORTED"],
    status: "take",
    interest: 70,
    createdAt,
    updatedAt: createdAt,
  });
  await ctx.db.insert("wireLeaguePosts", {
    leagueId,
    seasonId: SEASON,
    kind: "injury_status",
    persona: "dex-alvarez",
    text,
    tags: ["REPORTED"],
    globalPostId,
    impact: { teamId, variant: "owner", slots: {} },
    featuredTeams: [teamId],
    dedupeKey: `overlay:${globalPostId}:${teamId}:owner`,
    createdAt,
  });
}

describe("wireDigest.buildDigestForUser: skip rules", () => {
  it("skips a user who opted alerts off", async () => {
    const t = convexTest(schema, modules);
    const { userId, leagueId, teamId } = await t.run((ctx) => seedUserWithLeague(ctx, { wireAlerts: "off" }));
    await t.run((ctx) => seedOwnerOverlay(ctx, leagueId, teamId, "Something happened", IN_WINDOW));

    const result = await t.query(internal.wireDigest.buildDigestForUser, { userId, windowStart: WINDOW_START, windowEnd: WINDOW_END });
    expect(result).toBeNull();
  });

  it("skips a user with email notifications off", async () => {
    const t = convexTest(schema, modules);
    const { userId, leagueId, teamId } = await t.run((ctx) => seedUserWithLeague(ctx, { emailNotifications: false }));
    await t.run((ctx) => seedOwnerOverlay(ctx, leagueId, teamId, "Something happened", IN_WINDOW));

    const result = await t.query(internal.wireDigest.buildDigestForUser, { userId, windowStart: WINDOW_START, windowEnd: WINDOW_END });
    expect(result).toBeNull();
  });

  it("skips a league whose pass is not active", async () => {
    const t = convexTest(schema, modules);
    const { userId, leagueId, teamId } = await t.run((ctx) => seedUserWithLeague(ctx, { passActive: false }));
    await t.run((ctx) => seedOwnerOverlay(ctx, leagueId, teamId, "Something happened", IN_WINDOW));

    const result = await t.query(internal.wireDigest.buildDigestForUser, { userId, windowStart: WINDOW_START, windowEnd: WINDOW_END });
    expect(result).toBeNull();
  });

  it("skips a league with wireEnabled explicitly off", async () => {
    const t = convexTest(schema, modules);
    const { userId, leagueId, teamId } = await t.run((ctx) => seedUserWithLeague(ctx, { wireEnabled: false }));
    await t.run((ctx) => seedOwnerOverlay(ctx, leagueId, teamId, "Something happened", IN_WINDOW));

    const result = await t.query(internal.wireDigest.buildDigestForUser, { userId, windowStart: WINDOW_START, windowEnd: WINDOW_END });
    expect(result).toBeNull();
  });

  it("skips (returns null) when the only league has nothing in the window", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await t.run((ctx) => seedUserWithLeague(ctx));
    // No posts/alerts/questions/headlines seeded at all.

    const result = await t.query(internal.wireDigest.buildDigestForUser, { userId, windowStart: WINDOW_START, windowEnd: WINDOW_END });
    expect(result).toBeNull();
  });

  it("excludes an overlay outside the window", async () => {
    const t = convexTest(schema, modules);
    const { userId, leagueId, teamId } = await t.run((ctx) => seedUserWithLeague(ctx));
    await t.run((ctx) => seedOwnerOverlay(ctx, leagueId, teamId, "Too early", BEFORE_WINDOW));

    const result = await t.query(internal.wireDigest.buildDigestForUser, { userId, windowStart: WINDOW_START, windowEnd: WINDOW_END });
    expect(result).toBeNull();
  });

  it("returns null for a user that does not exist", async () => {
    const t = convexTest(schema, modules);
    const fakeId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { clerkId: "throwaway", hasCompletedOnboarding: true, createdAt: Date.now(), lastActiveAt: Date.now() });
      await ctx.db.delete(id);
      return id;
    });
    const result = await t.query(internal.wireDigest.buildDigestForUser, { userId: fakeId, windowStart: WINDOW_START, windowEnd: WINDOW_END });
    expect(result).toBeNull();
  });
});

describe("wireDigest.buildDigestForUser: shape", () => {
  it("builds yourTeam, alerts, openQuestions and headlines for a league with activity", async () => {
    const t = convexTest(schema, modules);
    const { userId, leagueId, teamId } = await t.run((ctx) => seedUserWithLeague(ctx));

    await t.run((ctx) => seedOwnerOverlay(ctx, leagueId, teamId, "Your guy is Out for 6-8 weeks.", IN_WINDOW));

    const questionId = await t.run((ctx) =>
      ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "sam_question",
        persona: "sam-ortega",
        text: "Bold call benching your RB1 - what's the plan?",
        tags: [],
        featuredTeams: [teamId],
        dedupeKey: `sam_question:test:${teamId}`,
        replyTo: { scope: "league", id: "deskpost1" },
        rootScope: "league",
        rootId: "deskpost1",
        createdAt: IN_WINDOW,
      })
    );

    await t.run((ctx) =>
      ctx.db.insert("userNotifications", {
        userId,
        leagueId,
        type: "wire_alert",
        title: "Your starter is OUT",
        message: "He will not play today.",
        status: "unread",
        priority: "high",
        deliveryChannels: ["in_app"],
        deliveryStatus: { inApp: { delivered: true } },
        createdAt: IN_WINDOW,
        updatedAt: IN_WINDOW,
      })
    );

    await t.run(async (ctx) => {
      const eventId = await ctx.db.insert("wireEvents", {
        kind: "news",
        dedupeKey: "headline-test-1",
        observedAt: IN_WINDOW,
        detectedAt: IN_WINDOW,
        players: [{ espnId: "2", name: "Headline Player" }],
        facts: {},
        interest: 90,
        source: { type: "espn_news", fetchedAt: IN_WINDOW },
      });
      await ctx.db.insert("wirePosts", {
        eventId,
        kind: "news",
        persona: "dex-alvarez",
        text: "A league-wide headline everyone should see.",
        tags: ["REPORTED"],
        status: "take",
        interest: 90,
        createdAt: IN_WINDOW,
        updatedAt: IN_WINDOW,
      });
    });

    const result = (await t.query(internal.wireDigest.buildDigestForUser, {
      userId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    })) as WireDigestData | null;

    expect(result).not.toBeNull();
    expect(result!.leagues).toHaveLength(1);
    const league = result!.leagues[0];
    expect(league.teamName).toBe("My Team");
    expect(league.yourTeam).toHaveLength(1);
    expect(league.yourTeam[0].text).toContain("6-8 weeks");
    expect(league.alerts).toHaveLength(1);
    expect(league.alerts[0].title).toBe("Your starter is OUT");
    expect(league.openQuestions).toHaveLength(1);
    expect(league.openQuestions[0].postId).toBe(questionId);
    // The overlay's own global post (interest 70) and the dedicated headline post (interest 90)
    // both qualify - sorted by interest desc, so the higher-interest one leads.
    expect(league.headlines.length).toBeGreaterThanOrEqual(1);
    expect(league.headlines[0].text).toContain("headline");
    expect(league.wireUrl).toContain(String(leagueId));
    expect(result!.settingsUrl).toContain("/dashboard/settings/notifications");
  });

  it("excludes a sam_question that already has a manager reply", async () => {
    const t = convexTest(schema, modules);
    const { userId, leagueId, teamId } = await t.run((ctx) => seedUserWithLeague(ctx));

    const questionId = await t.run((ctx) =>
      ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "sam_question",
        persona: "sam-ortega",
        text: "Answered already?",
        tags: [],
        featuredTeams: [teamId],
        dedupeKey: "sam_question:answered",
        replyTo: { scope: "league", id: "deskpost2" },
        rootScope: "league",
        rootId: "deskpost2",
        createdAt: IN_WINDOW,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "manager_reply",
        text: "Yes, here's why.",
        tags: [],
        authorUserId: "clerk_digest_user",
        authorTeamId: teamId,
        replyTo: { scope: "league", id: String(questionId) },
        rootScope: "league",
        rootId: "deskpost2",
        featuredTeams: [],
        dedupeKey: "manager-reply-1",
        createdAt: IN_WINDOW + 1000,
      })
    );

    const result = (await t.query(internal.wireDigest.buildDigestForUser, {
      userId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    })) as WireDigestData | null;

    // Nothing else in the window and the question is answered - the whole digest is empty.
    expect(result).toBeNull();
  });

  it("excludes an overlay whose variant is not owner (an opponent-framed overlay)", async () => {
    const t = convexTest(schema, modules);
    const { userId, leagueId, teamId } = await t.run((ctx) => seedUserWithLeague(ctx));

    const eventId = await t.run((ctx) =>
      ctx.db.insert("wireEvents", {
        kind: "injury_status",
        dedupeKey: "opponent-overlay-test",
        observedAt: IN_WINDOW,
        detectedAt: IN_WINDOW,
        players: [{ espnId: "3", name: "Rival Player" }],
        facts: {},
        interest: 70,
        source: { type: "espn_injuries", fetchedAt: IN_WINDOW },
      })
    );
    const globalPostId = await t.run((ctx) =>
      ctx.db.insert("wirePosts", {
        eventId,
        kind: "injury_status",
        persona: "dex-alvarez",
        text: "global",
        tags: ["REPORTED"],
        status: "take",
        interest: 70,
        createdAt: IN_WINDOW,
        updatedAt: IN_WINDOW,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("wireLeaguePosts", {
        leagueId,
        seasonId: SEASON,
        kind: "injury_status",
        persona: "dex-alvarez",
        text: "Your opponent's guy just went down.",
        tags: ["REPORTED"],
        globalPostId,
        impact: { teamId, variant: "opponent", slots: {} },
        featuredTeams: [teamId],
        dedupeKey: `overlay:${globalPostId}:${teamId}:opponent`,
        createdAt: IN_WINDOW,
      })
    );

    const result = (await t.query(internal.wireDigest.buildDigestForUser, {
      userId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    })) as WireDigestData | null;

    // The opponent-framed overlay never counts as "your team", and a league earns a digest block
    // only on team-specific content (an owner overlay, an alert, an open question) - the shared
    // headlines alone never justify one. So with nothing else in the window there is no digest.
    expect(result).toBeNull();
  });
});
