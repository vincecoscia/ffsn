import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildInterviewFactBlock, type ConversationContext } from "../src/lib/ai/conversation-service";

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * Regression coverage for `commentRequests.buildConversationContext`, the CONTEXT Sam
 * Ortega interviews from. Every case here was first found by replaying the production
 * league through tests/interviewContextHarness.test.ts (Sept 2026):
 *
 *  - an unplayed week was answered with LAST season's game (opponent, score, bench, moves);
 *  - a player on IR (slot 21) counted as a starter, so a healthy bench player "should have
 *    started over" someone who was hurt;
 *  - standings came from `teams.record` (the last sync), not the week the story is about;
 *  - lost / withdrawn / pending waiver claims were listed as pickups with their bid;
 *  - last season's topic-label "quotes" were read back as "already on the record";
 *  - a season-old trade surfaced in a weekly recap as if it were this week's;
 *  - recap interviews went out before ESPN had finalized the week.
 */

const SEASON = 2026;
const PREV = 2025;
const CLERK = "clerk_interviewee";

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "Builder Test League",
      platform: "espn",
      externalId: "7777",
      commissionerUserId: CLERK,
      settings: {
        scoringType: "PPR",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: [],
        regularSeasonMatchupPeriods: 14,
      },
      espnData: { seasonId: SEASON, currentScoringPeriod: 2, size: 4, lastSyncedAt: now, isPrivate: false },
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

    const userId = await ctx.db.insert("users", {
      clerkId: CLERK,
      name: "Ava Interviewee",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    const team = async (seasonId: number, externalId: string, name: string, wins: number, losses: number) =>
      await ctx.db.insert("teams", {
        leagueId,
        externalId,
        seasonId,
        name,
        owner: `Owner ${externalId}`,
        // Deliberately NOT the record as of week 1: the builder must not read it.
        record: { wins, losses, ties: 0, pointsFor: 999, pointsAgainst: 999 },
        roster: [],
        createdAt: now,
        updatedAt: now,
      });

    const teamA = await team(SEASON, "1", "Ava's Avalanche", 9, 5);
    const teamB = await team(SEASON, "2", "Bruisers", 3, 11);
    const teamC = await team(SEASON, "3", "Cyclones", 12, 2);
    const teamD = await team(SEASON, "4", "Drifters", 6, 8);
    const prevTeamA = await team(PREV, "1", "Ava's Old Name", 14, 0);
    await team(PREV, "2", "Old Bruisers", 0, 14);

    for (const [teamId, seasonId] of [
      [teamA, SEASON],
      [prevTeamA, PREV],
    ] as const) {
      await ctx.db.insert("teamClaims", {
        leagueId,
        teamId,
        seasonId,
        userId: CLERK,
        status: "active",
        credits: 0,
        createdAt: now,
      });
    }

    const player = (lineupSlotId: number, espnId: number, fullName: string, position: string, points: number, projectedPoints: number) => ({
      lineupSlotId,
      espnId,
      fullName,
      position,
      points,
      projectedPoints,
    });

    // Week 1, decided: A beat B 120.5-98.2. A's roster carries a hurt WR on IR (slot 21)
    // with a live projection, a bench WR who outscored the worst starting WR, and one
    // under- and one over-performing starter.
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 1,
      scoringPeriod: 1,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 120.5,
      awayScore: 98.2,
      winner: "home",
      homeRoster: {
        appliedStatTotal: 120.5,
        players: [
          player(0, 11, "Quincy Quarter", "QB", 20.0, 18.0),
          player(2, 12, "Rudy Rusher", "RB", 6.0, 14.0),
          player(4, 13, "Wes Wideout", "WR", 30.0, 12.0),
          player(4, 14, "Walt Weakside", "WR", 4.0, 11.0),
          player(20, 15, "Benny Bench", "WR", 22.0, 9.0),
          player(21, 16, "Ira Injured", "WR", 0.0, 14.0),
        ],
      },
      awayRoster: { appliedStatTotal: 98.2, players: [] },
      createdAt: now,
    });
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 1,
      scoringPeriod: 1,
      homeTeamId: "3",
      awayTeamId: "4",
      homeScore: 100.0,
      awayScore: 90.0,
      winner: "home",
      createdAt: now,
    });
    // Week 2, not decided yet (no winner, no scores): A plays C.
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 2,
      scoringPeriod: 2,
      homeTeamId: "3",
      awayTeamId: "1",
      homeScore: 0,
      awayScore: 0,
      createdAt: now,
    });
    // LAST season's week 2 - the game the old lookup would have answered with.
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: PREV,
      matchupPeriod: 2,
      scoringPeriod: 2,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 150.0,
      awayScore: 80.0,
      winner: "home",
      homeRoster: {
        appliedStatTotal: 150.0,
        players: [player(20, 99, "Last Year's Bench Star", "RB", 40.0, 10.0)],
      },
      createdAt: now,
    });

    // Week 2 waiver claims for team 1: one executed, one lost, one withdrawn, one pending.
    const playerRow = async (espnId: number, fullName: string) =>
      await ctx.db.insert("playersEnhanced", {
        espnId: String(espnId),
        season: SEASON,
        fullName,
        defaultPositionId: 2,
        defaultPosition: "RB",
        eligibleSlots: [2, 20],
        eligiblePositions: ["RB"],
        proTeamId: 1,
        active: true,
        injured: false,
        droppable: true,
        ownership: { percentOwned: 50, percentStarted: 20 },
        createdAt: now,
        updatedAt: now,
      });
    await playerRow(101, "Won Claim");
    await playerRow(102, "Lost Claim");
    await playerRow(103, "Withdrawn Claim");
    await playerRow(104, "Pending Claim");
    await playerRow(105, "Dropped Guy");

    const tx = async (
      espnTransactionId: string,
      playerId: number,
      bidAmount: number,
      status: string,
      outcome: "executed" | "failed" | "cancelled" | "pending",
      isPending = false
    ) =>
      await ctx.db.insert("transactions", {
        leagueId,
        seasonId: SEASON,
        espnTransactionId,
        bidAmount,
        executionType: "PROCESS",
        isActingAsTeamOwner: false,
        isLeagueManager: false,
        isPending,
        items: [
          { fromLineupSlotId: 0, fromTeamId: 0, isKeeper: false, overallPickNumber: 0, playerId, toLineupSlotId: 20, toTeamId: 1, type: "ADD" },
          { fromLineupSlotId: 20, fromTeamId: 1, isKeeper: false, overallPickNumber: 0, playerId: 105, toLineupSlotId: 0, toTeamId: 0, type: "DROP" },
        ],
        type: "WAIVER",
        proposedDate: now,
        status,
        outcome,
        scoringPeriod: 2,
        teamId: 1,
        createdAt: now,
      });
    await tx("t-won", 101, 12, "EXECUTED", "executed");
    await tx("t-lost", 102, 30, "FAILED_INVALIDPLAYERSOURCE", "failed");
    await tx("t-withdrawn", 103, 5, "CANCELED", "cancelled");
    await tx("t-pending", 104, 9, "PENDING", "pending", true);

    // A trade from week 1 (this week or last for a week-2 story) and one from last season.
    const trade = async (seasonId: number, week: number | undefined, withName: string) =>
      await ctx.db.insert("trades", {
        leagueId,
        seasonId,
        tradeDate: now - 1000,
        week,
        status: "completed",
        teamA: { teamId: "1", teamName: "Ava's Avalanche", manager: "Owner 1" },
        teamB: { teamId: "4", teamName: withName, manager: "Owner 4" },
        playersFromTeamA: [{ playerId: "201", playerName: "Sent Player", position: "RB", team: "DAL" }],
        playersFromTeamB: [{ playerId: "202", playerName: "Got Player", position: "WR", team: "PHI" }],
        createdAt: now,
        updatedAt: now,
      });
    await trade(SEASON, 1, "Drifters");
    await trade(PREV, 9, "Old Drifters");

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

    return { leagueId, userId, teamA, teamB, teamC, teamD, contentScheduleId };
  });
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function requestFor(
  t: ReturnType<typeof convexTest>,
  ids: Seeded,
  contentType: string,
  week: number | undefined,
  seasonId: number | undefined = SEASON
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("commentRequests", {
      leagueId: ids.leagueId,
      targetUserId: ids.userId,
      contentType,
      interviewerPersona: "sam-ortega",
      writerPersona: "mel-diaper",
      articleContext: { week, seasonId, topic: contentType, focusAreas: [] },
      status: "pending",
      scheduledSendTime: now,
      articleGenerationTime: now + 3_600_000,
      conversationState: "not_started",
      aiContext: { initialPrompt: "", conversationGoals: [], currentFocus: contentType },
      autoEndCriteria: { maxMessages: 8, currentMessageCount: 0, minResponseLength: 30, lastActivityTime: now, inactivityTimeoutMinutes: 30 },
      priority: "medium",
      notificationsSent: [],
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function contextFor(t: ReturnType<typeof convexTest>, requestId: Id<"commentRequests">) {
  const context = await t.query(internal.commentRequests.buildConversationContext, { commentRequestId: requestId });
  expect(context).not.toBeNull();
  return context! as unknown as ConversationContext;
}

describe("buildConversationContext (Sam's CONTEXT block)", () => {
  it("reports a decided week from its own season with IR excluded and standings as of that week", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const context = await contextFor(t, await requestFor(t, ids, "weekly_recap", 1));

    expect(context.seasonId).toBe(SEASON);
    expect(context.teamName).toBe("Ava's Avalanche");
    expect(context.teamPerformance.score).toBe(120.5);
    expect(context.opponentScore).toBe(98.2);
    expect(context.opponentName).toBe("Bruisers");
    expect(context.teamPerformance.won).toBe(true);
    expect(context.margin).toBe(22.3);
    expect(context.upcomingOpponentName).toBeUndefined();

    // IR is neither a starter nor the bench.
    const named = [
      ...context.teamPerformance.underperformers.map((p) => p.player),
      ...context.teamPerformance.overperformers.map((p) => p.player),
      ...(context.lineupDecisions ?? []).map((d) => d.startedPlayer),
    ];
    expect(named).not.toContain("Ira Injured");
    expect(context.teamPerformance.underperformers.map((p) => p.player)).toEqual(["Rudy Rusher", "Walt Weakside"]);
    expect(context.teamPerformance.overperformers.map((p) => p.player)).toEqual(["Wes Wideout"]);
    expect(context.benchPoints).toBe(22);
    expect(context.topBenchPlayer?.player).toBe("Benny Bench");
    // The bench WR is compared with the worst *starting* WR, not the IR one.
    expect(context.lineupDecisions).toEqual([
      expect.objectContaining({ benchedPlayer: "Benny Bench", startedPlayer: "Walt Weakside", pointGain: 18 }),
    ]);

    // Standings as of week 1 from the decided games, not teams.record (9-5 / 12-2 ...).
    const standing = context.leagueContext.standings.find((s) => s.teamId === context.teamPerformance.teamId);
    expect(standing).toMatchObject({ rank: 1, record: "1-0" });
    expect(context.leagueContext.standings.map((s) => `${s.teamName} ${s.record}`)).toEqual([
      "Ava's Avalanche 1-0",
      "Cyclones 1-0",
      "Bruisers 0-1",
      "Drifters 0-1",
    ]);

    const block = buildInterviewFactBlock(context);
    expect(block).toContain("Week 1 result: Won 120.5-98.2 over Bruisers (margin 22.3)");
    // The synced record (9-5) is not this week's, so no ESPN seed is quoted.
    expect(block).toContain("Standing: #1 by record (1-0)");
    expect(block).not.toContain("playoff seed");
    expect(context.playoffSeed).toBeUndefined();
    expect(block).not.toContain("Ira Injured");
  });

  it("never answers an undecided week with another season's game; it names the opponent only", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const context = await contextFor(t, await requestFor(t, ids, "weekly_preview", 2));

    expect(context.seasonId).toBe(SEASON);
    expect(context.teamPerformance.score).toBe(0);
    expect(context.opponentScore).toBeUndefined();
    expect(context.margin).toBeUndefined();
    expect(context.benchPoints).toBeUndefined();
    expect(context.topBenchPlayer).toBeUndefined();
    expect(context.upcomingOpponentName).toBe("Cyclones");
    // Standings as of the story's week still count week 1.
    const standing = context.leagueContext.standings.find((s) => s.teamId === context.teamPerformance.teamId);
    expect(standing).toMatchObject({ record: "1-0" });

    const block = buildInterviewFactBlock(context);
    expect(block).toContain("Week 2 matchup: vs Cyclones (not played yet - no result to cite)");
    expect(block).not.toContain("150");
    expect(block).not.toContain("Last Year's Bench Star");
    expect(block).not.toContain("result:");
  });

  it("lists only executed waiver moves, never lost, withdrawn or pending claims", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const context = await contextFor(t, await requestFor(t, ids, "weekly_recap", 2));

    expect(context.transactionsThisWeek).toEqual([
      expect.objectContaining({ type: "WAIVER", playersAdded: ["Won Claim"], playersDropped: ["Dropped Guy"], bidAmount: 12 }),
    ]);
    const block = buildInterviewFactBlock(context);
    expect(block).not.toContain("Lost Claim");
    expect(block).not.toContain("$30");
  });

  it("surfaces only this week's or last week's trade in a weekly story, and any trade in a trade story", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const recap = await contextFor(t, await requestFor(t, ids, "weekly_recap", 2));
    expect(recap.tradesThisWeek?.map((tr) => tr.withTeam)).toEqual(["Drifters"]);

    const laterRecap = await contextFor(t, await requestFor(t, ids, "weekly_recap", 5));
    expect(laterRecap.tradesThisWeek).toEqual([]);

    const tradeStory = await contextFor(t, await requestFor(t, ids, "trade_analysis", 5));
    expect(tradeStory.tradesThisWeek?.map((tr) => tr.withTeam)).toEqual(["Drifters"]);
  });

  it("never hands Sam a writer's line from a later week than the story's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const [week, evidence] of [
        [1, "Week 1 line about this manager."],
        [5, "A line the writer has not written yet."],
      ] as const) {
        await ctx.db.insert("relationshipEvents", {
          leagueId: ids.leagueId,
          userId: ids.userId,
          persona: "mel-diaper",
          type: "article_roast",
          delta: -6,
          evidence,
          week,
          createdAt: now,
        });
      }
    });
    const context = await contextFor(t, await requestFor(t, ids, "weekly_recap", 2));
    expect(context.writerContext?.recentMentions.map((m) => m.week)).toEqual([1]);
  });

  it("reports a tie as a tie, never as a loss", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("matchups", {
        leagueId: ids.leagueId,
        seasonId: SEASON,
        matchupPeriod: 3,
        scoringPeriod: 3,
        homeTeamId: "1",
        awayTeamId: "4",
        homeScore: 101.5,
        awayScore: 101.5,
        winner: "tie",
        createdAt: Date.now(),
      });
    });
    const context = await contextFor(t, await requestFor(t, ids, "weekly_recap", 3));
    expect(context.tie).toBe(true);
    expect(context.teamPerformance.won).toBe(false);
    const block = buildInterviewFactBlock(context);
    expect(block).toContain("Week 3 result: Tied 101.5-101.5 with Drifters");
    expect(block).not.toContain("Lost");
    // The tie counts in the standings tally too.
    const standing = context.leagueContext.standings.find((s) => s.teamId === context.teamPerformance.teamId);
    expect(standing?.record).toBe("1-0-1");
  });

  it("quotes ESPN's playoff seed only when the synced record is exactly this week's", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // Make the synced record match week 1 (1-0) and carry a seed.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.teamA, {
        record: { wins: 1, losses: 0, ties: 0, pointsFor: 120.5, pointsAgainst: 98.2, playoffSeed: 2 },
      });
    });
    const fresh = await contextFor(t, await requestFor(t, ids, "weekly_recap", 1));
    expect(fresh.playoffSeed).toBe(2);
    expect(buildInterviewFactBlock(fresh)).toContain("Standing: #1 by record (1-0), ESPN playoff seed #2");
    // A week-2 story asked before week 2 is decided still has a 1-0 tally, so the seed
    // stays; a story about a week the sync has not caught up to would not.
    const later = await contextFor(t, await requestFor(t, ids, "weekly_recap", 2));
    expect(later.playoffSeed).toBe(2);
  });

  it("writes no 'Week 0' when the request has no week", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const context = await contextFor(t, await requestFor(t, ids, "draft_rankings", undefined));
    const block = buildInterviewFactBlock(context);
    expect(block).not.toMatch(/Week (0|undefined)/);
    expect(block).toContain(`Story: draft rankings - ${SEASON} season`);
  });

  it("only reads back prior quotes from this season that the manager verifiably typed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const response = async (requestId: Id<"commentRequests">, raw: string, extractedQuotes: string[], approved?: string[]) =>
      await t.run(async (ctx) => {
        const now = Date.now();
        await ctx.db.insert("commentResponses", {
          commentRequestId: requestId,
          leagueId: ids.leagueId,
          userId: ids.userId,
          scheduledContentId: null,
          rawResponse: raw,
          processedResponse: raw,
          responseType: "mixed",
          relevanceMetadata: { topicRelevance: 80, qualityScore: 80, originality: 75, usabilityRating: "high", extractedQuotes },
          integrationStatus: "pending",
          approvedQuotes: approved,
          userEngagementLevel: "high",
          createdAt: now,
          updatedAt: now,
          processedAt: now,
        });
      });

    // Last season: a label-shaped ledger (the 2025 data), must be ignored entirely.
    await response(await requestFor(t, ids, "weekly_recap", 3, PREV), "I benched him because of the weather report.", ["bench management", "weather"]);
    // This season, week 1: a label AND a verbatim span - only the span may be quoted.
    await response(
      await requestFor(t, ids, "weekly_recap", 1),
      "Honestly I trusted the matchup and it paid off big time this week.",
      ["lineup confidence", "I trusted the matchup and it paid off"]
    );

    const context = await contextFor(t, await requestFor(t, ids, "weekly_recap", 2));
    expect(context.priorQuotes).toEqual([
      expect.objectContaining({ week: 1, text: "I trusted the matchup and it paid off" }),
    ]);
    const block = buildInterviewFactBlock(context);
    expect(block).not.toContain("bench management");
    expect(block).not.toContain("lineup confidence");
    expect(block).not.toContain("weather");
  });
});

describe("createRequestsForScheduledContent week finality", () => {
  // Pin the clock to a Tuesday late morning in New York so quiet hours never depend on
  // when the suite happens to run.
  const TUESDAY_11_ET = Date.parse("2026-09-15T15:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TUESDAY_11_ET);
  });
  afterEach(() => vi.useRealTimers());

  async function scheduled(t: ReturnType<typeof convexTest>, ids: Seeded, week: number, hoursAhead: number) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("scheduledContent", {
        leagueId: ids.leagueId,
        contentScheduleId: ids.contentScheduleId,
        contentType: "weekly_recap",
        scheduledFor: now + hoursAhead * 3_600_000,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        contextData: { week, seasonId: SEASON },
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  it("creates the requests once the week is final", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const result = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: await scheduled(t, ids, 1, 12),
      targetUserIds: [ids.userId],
      writerPersona: "mel-diaper",
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("moves the print time out so managers get the full window, on the schedule's hour", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const DAY = 24 * 3_600_000;
    // The recap is due in 3 hours but the window is 24 hours.
    const scheduledContentId = await scheduled(t, ids, 1, 3);
    const before = (await t.run((ctx) => ctx.db.get(scheduledContentId)))!.scheduledFor;
    const result = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId,
      targetUserIds: [ids.userId],
      requestTimeBeforeGeneration: DAY,
      writerPersona: "mel-diaper",
    });
    expect(result).toHaveLength(1);
    const row = (await t.run((ctx) => ctx.db.get(scheduledContentId)))!;
    expect(row.scheduledFor).toBeGreaterThanOrEqual(Date.now() + DAY - 1000);
    expect(row.scheduledFor).toBeGreaterThan(before);
    // Aligned to the schedule's 09:00 New York slot.
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(row.scheduledFor));
    expect(local).toBe("09:00");
    const request = (await t.run((ctx) => ctx.db.query("commentRequests").collect()))[0];
    expect(request.articleGenerationTime).toBe(row.scheduledFor);
  });

  it("waits for 07:00 league time when the week goes final overnight, then prints a day later", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const DAY = 24 * 3_600_000;
    // Tuesday 01:30 ET: Monday night just settled. The recap is due at 09:00 ET today.
    vi.setSystemTime(Date.parse("2026-09-15T05:30:00Z"));
    const scheduledContentId = await scheduled(t, ids, 1, 7.5);
    const deferred = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId,
      targetUserIds: [ids.userId],
      requestTimeBeforeGeneration: DAY,
      writerPersona: "mel-diaper",
    });
    expect(deferred).toMatchObject({ created: false, reason: "quiet_hours_deferred", retryAt: Date.parse("2026-09-15T11:00:00Z") });
    expect(await t.run((ctx) => ctx.db.query("commentRequests").collect())).toHaveLength(0);

    // 07:00 ET: the interviews go out, and the print time moves to Wednesday 09:00 ET.
    vi.setSystemTime(Date.parse("2026-09-15T11:00:00Z"));
    const created = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId,
      targetUserIds: [ids.userId],
      requestTimeBeforeGeneration: DAY,
      writerPersona: "mel-diaper",
    });
    expect(created).toHaveLength(1);
    const row = (await t.run((ctx) => ctx.db.get(scheduledContentId)))!;
    expect(row.scheduledFor).toBe(Date.parse("2026-09-16T13:00:00Z"));
  });

  it("asks every manager who played, whatever list was queued when the row was created", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // A second manager claims the Bruisers (they played week 1 against Ava).
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("users", { clerkId: "clerk_second", name: "Ben Bruiser", hasCompletedOnboarding: true, createdAt: now, lastActiveAt: now });
      await ctx.db.insert("teamClaims", { leagueId: ids.leagueId, teamId: ids.teamB, seasonId: SEASON, userId: "clerk_second", status: "active", credits: 0, createdAt: now });
    });
    const result = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: await scheduled(t, ids, 1, 30),
      targetUserIds: [ids.userId], // the stale one-manager list
      requestTimeBeforeGeneration: 24 * 3_600_000,
      writerPersona: "mel-diaper",
    });
    expect(result).toHaveLength(2);
  });

  it("does not hold a commissioner's manual trigger for quiet hours", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    vi.setSystemTime(Date.parse("2026-09-15T05:30:00Z")); // 01:30 ET
    const result = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: await scheduled(t, ids, 1, 2),
      targetUserIds: [ids.userId],
      requestTimeBeforeGeneration: 60 * 60 * 1000, // the 1h manual window
      writerPersona: "mel-diaper",
    });
    expect(result).toHaveLength(1);
  });

  it("leaves the print time alone when the window already fits", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const scheduledContentId = await scheduled(t, ids, 1, 30);
    const before = (await t.run((ctx) => ctx.db.get(scheduledContentId)))!.scheduledFor;
    await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId,
      targetUserIds: [ids.userId],
      requestTimeBeforeGeneration: 24 * 3_600_000,
      writerPersona: "mel-diaper",
    });
    expect((await t.run((ctx) => ctx.db.get(scheduledContentId)))!.scheduledFor).toBe(before);
  });

  it("defers while the week is still undecided and there is interview window left", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const result = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: await scheduled(t, ids, 2, 12),
      targetUserIds: [ids.userId],
      writerPersona: "mel-diaper",
    });
    expect(result).toMatchObject({ created: false, reason: "week_not_final_deferred" });
    const requests = await t.run((ctx) => ctx.db.query("commentRequests").collect());
    expect(requests).toHaveLength(0);
  });

  it("prints without interviews when the week is still undecided inside the last hour", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const result = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: await scheduled(t, ids, 2, 1),
      targetUserIds: [ids.userId],
      writerPersona: "mel-diaper",
    });
    expect(result).toMatchObject({ created: false, reason: "week_not_final" });
  });
});
