import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2025;
const CLERK_ANN = "clerk_language_ann";
const CLERK_BOB = "clerk_language_bob";

/**
 * One league, two managers who have each claimed a team for the league's current season, plus a
 * league membership for each - same shape as tests/relationships.test.ts's own `setup`, since
 * `languageSettings.ts` resolves teams the same way (`teamClaims` -> Clerk id -> `users`).
 */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Language Rating Test League",
      platform: "espn",
      externalId: "9004",
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

describe("languageSettings: getLeagueLanguage", () => {
  it("defaults to clean with no clean team names when nothing has been set", async () => {
    const { t, leagueId } = await setup();

    const result = await t.query(internal.languageSettings.getLeagueLanguage, { leagueId });
    expect(result).toEqual({ languageRating: "clean", cleanTeamNames: [] });
  });

  it("returns a stored salty rating", async () => {
    const { t, leagueId } = await setup();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("leagueContentPreferences", {
        leagueId,
        contentEnabled: true,
        timezone: "America/New_York",
        currentMonthSpent: 0,
        budgetResetDate: now,
        notifyCommissioner: true,
        notifyFailures: true,
        languageRating: "salty",
        autoPublish: true,
        requireApproval: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.query(internal.languageSettings.getLeagueLanguage, { leagueId });
    expect(result.languageRating).toBe("salty");
  });

  it("only a manager with cleanLanguage set contributes their claimed team's name", async () => {
    const { t, leagueId, userBob } = await setup();

    // Bob opts down; Ann never touches the setting.
    await t.run(async (ctx) => {
      await ctx.db.patch(userBob, { preferences: { emailNotifications: true, cleanLanguage: true } });
    });

    const result = await t.query(internal.languageSettings.getLeagueLanguage, { leagueId });
    expect(result.languageRating).toBe("clean");
    expect(result.cleanTeamNames).toEqual(["Beta"]);
  });

  it("a manager without the flag contributes nothing", async () => {
    const { t, leagueId, userAnn } = await setup();

    await t.run(async (ctx) => {
      await ctx.db.patch(userAnn, { preferences: { emailNotifications: true, cleanLanguage: false } });
    });

    const result = await t.query(internal.languageSettings.getLeagueLanguage, { leagueId });
    expect(result.cleanTeamNames).toEqual([]);
  });
});

describe("contentScheduling: updateLeagueContentPreferences (languageRating)", () => {
  it("the commissioner can set the league's language rating", async () => {
    const { t, leagueId } = await setup();

    await t.withIdentity({ subject: CLERK_ANN }).mutation(
      api.contentScheduling.updateLeagueContentPreferences,
      { leagueId, languageRating: "unfiltered" }
    );

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("leagueContentPreferences")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .first()
    );
    expect(stored?.languageRating).toBe("unfiltered");

    const result = await t.query(internal.languageSettings.getLeagueLanguage, { leagueId });
    expect(result.languageRating).toBe("unfiltered");
  });
});

describe("users: updatePreferences (cleanLanguage)", () => {
  it("stores cleanLanguage on the authenticated user's preferences", async () => {
    const { t, userBob } = await setup();

    await t.withIdentity({ subject: CLERK_BOB }).mutation(api.users.updatePreferences, {
      preferences: { emailNotifications: true, cleanLanguage: true },
    });

    const stored = await t.run(async (ctx) => ctx.db.get(userBob));
    expect(stored?.preferences).toMatchObject({
      emailNotifications: true,
      cleanLanguage: true,
    });
  });
});
