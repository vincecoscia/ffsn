import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * Regression coverage for the manager-targeting bug in
 * `contentSchedulingIntegration.onContentScheduled` and
 * `commentRequests.createRequestsForScheduledContent`: both used to treat
 * `teams.owner` as a Clerk id (it is always an ESPN owner display name, e.g.
 * "Gabe Coscia") and loaded every season's `teams` rows for a league instead
 * of just the article's season. The real manager <-> team link is the
 * `teamClaims` table (`userId` there is a Clerk id, keyed to `users.clerkId`).
 */

const SEASON = 2026;
const PREV_SEASON = 2025;
const WEEK = 6;
const CLERK_CURRENT = "clerk_manager_current";
const CLERK_PREV = "clerk_manager_prev";

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Targeting Test League",
      platform: "espn",
      externalId: "5150",
      commissionerUserId: CLERK_CURRENT,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: WEEK,
        size: 2,
        lastSyncedAt: now,
        isPrivate: false,
      },
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

    const userCurrent = await ctx.db.insert("users", {
      clerkId: CLERK_CURRENT,
      name: "Current Manager",
      email: "current@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });
    const userPrev = await ctx.db.insert("users", {
      clerkId: CLERK_PREV,
      name: "Prev Manager",
      email: "prev@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    // Same externalId across two seasons' worth of `teams` documents - teams
    // are per-season rows (spec section 2), so `by_season` must scope to the
    // article's season or these collide.
    const prevTeamA = await ctx.db.insert("teams", {
      leagueId,
      externalId: "1",
      seasonId: PREV_SEASON,
      name: "Alpha (last year)",
      owner: "Prev Owner A",
      record: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });
    const currTeamA = await ctx.db.insert("teams", {
      leagueId,
      externalId: "1",
      seasonId: SEASON,
      name: "Alpha",
      owner: "Current Owner A",
      // wins + losses > 10, used below to prove the priority calculation in
      // createRequestsForScheduledContent resolved *this* season's team.
      record: { wins: 8, losses: 3, ties: 0, pointsFor: 900, pointsAgainst: 850 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });
    const currTeamB = await ctx.db.insert("teams", {
      leagueId,
      externalId: "2",
      seasonId: SEASON,
      name: "Beta",
      owner: "Current Owner B",
      record: { wins: 3, losses: 8, ties: 0, pointsFor: 700, pointsAgainst: 780 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });

    // Active claim for last season's team - must never surface when the
    // article is about `SEASON`, even though it is `status: "active"`.
    await ctx.db.insert("teamClaims", {
      leagueId,
      teamId: prevTeamA,
      seasonId: PREV_SEASON,
      userId: CLERK_PREV,
      status: "active",
      credits: 0,
      createdAt: now,
    });
    // The only claim that should ever be selected for this article.
    await ctx.db.insert("teamClaims", {
      leagueId,
      teamId: currTeamA,
      seasonId: SEASON,
      userId: CLERK_CURRENT,
      status: "active",
      credits: 0,
      createdAt: now,
    });
    // currTeamB is deliberately left unclaimed.

    // Both current-season teams played in the target week. `winner` marks the
    // week as final: createRequestsForScheduledContent defers a recap's
    // interviews until ESPN has stamped one (see tests/interviewContextBuilder.test.ts).
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: WEEK,
      scoringPeriod: WEEK,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 110.4,
      awayScore: 98.2,
      winner: "home",
      createdAt: now,
    });

    const contentScheduleId = await ctx.db.insert("contentSchedules", {
      leagueId,
      contentType: "weekly_recap",
      enabled: true,
      timezone: "America/New_York",
      schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 },
      preferredPersona: "curtis-vaughn",
      createdAt: now,
      updatedAt: now,
    });

    const scheduledContentId = await ctx.db.insert("scheduledContent", {
      leagueId,
      contentScheduleId,
      contentType: "weekly_recap",
      scheduledFor: now + 60 * 60 * 1000,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      contextData: { week: WEEK, seasonId: SEASON },
      createdAt: now,
      updatedAt: now,
    });

    return {
      leagueId,
      userCurrent,
      userPrev,
      prevTeamA,
      currTeamA,
      currTeamB,
      scheduledContentId,
      contentScheduleId,
    };
  });
}

describe("onContentScheduled manager targeting", () => {
  it("targets only the current season's claimed manager, skipping an unclaimed team and a prior season's claim", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const result = await t.mutation(internal.contentSchedulingIntegration.onContentScheduled, {
      scheduledContentId: ids.scheduledContentId,
      leagueId: ids.leagueId,
      contentType: "weekly_recap",
      scheduledTime: Date.now() + 60 * 60 * 1000,
      writerPersona: "curtis-vaughn",
    });

    expect(result).toMatchObject({
      scheduled: true,
      requests: 1,
      // Both current-season teams played this week (by_unique_matchup scoped
      // to leagueId+seasonId+matchupPeriod), so `teams` reflects both -
      // `currTeamB`'s owner never even had a lookup attempted since it's
      // resolved purely from `teamClaims`.
      teams: 2,
      // Only currTeamA's claim counts: prevTeamA's claim is for PREV_SEASON.
      claimed: 1,
      targeted: 1,
    });
  });

  it("reports no claimed managers (not silent teams.owner mismatches) when nobody has claimed a team for the season", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { leagueId, scheduledContentId } = await t.run(async (ctx) => {
      const leagueId = await ctx.db.insert("leagues", {
        name: "No Claims League",
        platform: "espn",
        externalId: "5151",
        commissionerUserId: CLERK_CURRENT,
        settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
        espnData: {
          seasonId: SEASON,
          currentScoringPeriod: WEEK,
          size: 1,
          lastSyncedAt: now,
          isPrivate: false,
        },
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

      await ctx.db.insert("teams", {
        leagueId,
        externalId: "1",
        seasonId: SEASON,
        name: "Solo",
        owner: "Unclaimed Owner",
        record: { wins: 5, losses: 5, ties: 0 },
        roster: [],
        createdAt: now,
        updatedAt: now,
      });

      const contentScheduleId = await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: "draft_rankings",
        enabled: true,
        timezone: "America/New_York",
        schedule: { type: "event_triggered", trigger: "draft_completed", delayMinutes: 60 },
        preferredPersona: "mel-diaper",
        createdAt: now,
        updatedAt: now,
      });

      const scheduledContentId = await ctx.db.insert("scheduledContent", {
        leagueId,
        contentScheduleId,
        contentType: "draft_rankings",
        scheduledFor: now + 60 * 60 * 1000,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        contextData: { seasonId: SEASON },
        createdAt: now,
        updatedAt: now,
      });

      return { leagueId, scheduledContentId };
    });

    const result = await t.mutation(internal.contentSchedulingIntegration.onContentScheduled, {
      scheduledContentId,
      leagueId,
      contentType: "draft_rankings",
      scheduledTime: now + 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      scheduled: false,
      reason: "no claimed managers",
      teams: 1,
      claimed: 0,
      targeted: 0,
    });
  });
});

describe("onContentScheduled send time", () => {
  it("sends a recap's requests one window (24h) before print", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const scheduledTime = Date.now() + 48 * 60 * 60 * 1000;
    const result = await t.mutation(internal.contentSchedulingIntegration.onContentScheduled, {
      scheduledContentId: ids.scheduledContentId,
      leagueId: ids.leagueId,
      contentType: "weekly_recap",
      scheduledTime,
      writerPersona: "curtis-vaughn",
    });
    expect(result).toMatchObject({ scheduled: true, sendAt: scheduledTime - 24 * 60 * 60 * 1000 });
  });

  it("sends an event article's requests immediately, not at print minus the window", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const now = Date.now();
    const tradeRow = await t.run((ctx) =>
      ctx.db.insert("scheduledContent", {
        leagueId: ids.leagueId,
        contentScheduleId: ids.contentScheduleId,
        contentType: "trade_analysis",
        scheduledFor: now + 15 * 60 * 1000,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        contextData: { seasonId: SEASON, eventData: { teamA: { teamId: "1" }, teamB: { teamId: "2" } } },
        createdAt: now,
        updatedAt: now,
      })
    );
    const result = (await t.mutation(internal.contentSchedulingIntegration.onContentScheduled, {
      scheduledContentId: tradeRow,
      leagueId: ids.leagueId,
      contentType: "trade_analysis",
      scheduledTime: now + 15 * 60 * 1000,
      writerPersona: "mel-diaper",
    })) as { scheduled: boolean; sendAt?: number; requests?: number };
    expect(result.scheduled).toBe(true);
    expect(result.requests).toBe(1); // only Alpha's manager has claimed a side
    expect(result.sendAt).toBeGreaterThanOrEqual(now);
    expect(result.sendAt!).toBeLessThan(now + 5000);
  });
});

describe("createRequestsForScheduledContent manager resolution", () => {
  it("resolves the target's team via teamClaims for the article's season, not teams.owner === userId", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const requestIds = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: ids.scheduledContentId,
      targetUserIds: [ids.userCurrent],
      writerPersona: "curtis-vaughn",
    });
    expect(requestIds).toHaveLength(1);

    const requests = await t.run((ctx) =>
      ctx.db
        .query("commentRequests")
        .withIndex("by_scheduled_content", (q) => q.eq("scheduledContentId", ids.scheduledContentId))
        .collect()
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].targetUserId).toBe(ids.userCurrent);
    // currTeamA has 8+3=11 games, which only resolves correctly if the fixed
    // lookup found *this season's* claimed team (prevTeamA's 0+0 record, or a
    // failed lookup defaulting to "medium", would both read as not-high).
    expect(requests[0].priority).toBe("high");
  });
});
