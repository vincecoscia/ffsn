import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { buildInGameInjuries, isInGameWindow, isWorseThanActive } from "../../convex/lib/inGameInjuries";

const modules = import.meta.glob("../../convex/**/*.*s");

const SEASON = 2026;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const CLERK = "clerk_ingame_test";

/**
 * In-game injuries (ffsn-the-wire-spec.md §16, owner ask 2026-09-05): a player hurt DURING his
 * game is never a lineup mistake. Coverage here mirrors the pure functions in
 * `convex/lib/inGameInjuries.ts`, the `getInGameInjuriesForWeek` query in
 * `convex/inGameInjuries.ts`, and the two consumers that must exclude such a player from a
 * "worst starter at the position" comparison: `aiQueries.getLeagueDataForAI`'s bench-impact
 * facts, and `commentRequests.buildConversationContext`'s interview `lineupDecisions`.
 */

describe("inGameInjuries: pure functions", () => {
  it("isInGameWindow: true from kickoff through 4.5h after, false before kickoff or beyond the window", () => {
    const kickoff = 10_000_000;
    expect(isInGameWindow(kickoff, kickoff)).toBe(true);
    expect(isInGameWindow(kickoff + 40 * MIN, kickoff)).toBe(true);
    expect(isInGameWindow(kickoff + 4.5 * HOUR, kickoff)).toBe(true);
    expect(isInGameWindow(kickoff - 1, kickoff)).toBe(false);
    expect(isInGameWindow(kickoff + 4.5 * HOUR + 1, kickoff)).toBe(false);
  });

  it("isWorseThanActive: anything but Active, case/whitespace-insensitive", () => {
    expect(isWorseThanActive("Active")).toBe(false);
    expect(isWorseThanActive(" active ")).toBe(false);
    expect(isWorseThanActive("Out")).toBe(true);
    expect(isWorseThanActive("Questionable")).toBe(true);
    expect(isWorseThanActive(undefined)).toBe(false);
  });

  it("buildInGameInjuries: joins rosters/kickoffs/events, marking `started` from the lineup slot", () => {
    const kickoff = 20_000_000;
    const hits = buildInGameInjuries({
      week: 3,
      rosters: [
        {
          fantasyTeamId: "1",
          fantasyTeamName: "Team One",
          players: [
            { espnId: "100", name: "Hurt Guy", lineupSlotId: 4, points: 2 },
            { espnId: "101", name: "Bench Guy On IR Check", lineupSlotId: 21, points: 0 },
            { espnId: "102", name: "Untouched Guy", lineupSlotId: 2, points: 9 },
          ],
        },
      ],
      nflTeamByEspnId: new Map([
        ["100", "KC"],
        ["101", undefined],
        ["102", "SF"],
      ]),
      kickoffByNflTeam: new Map([
        ["KC", kickoff],
        ["SF", kickoff - 5 * HOUR], // already outside the window when queried below
      ]),
      injuryEventsByEspnId: new Map([
        ["100", [{ observedAt: kickoff + 40 * MIN, status: "Out" }]],
        ["102", [{ observedAt: kickoff - 5 * HOUR + 40 * MIN, status: "Active" }]], // Active: never a hit
      ]),
    });

    expect(hits).toEqual([
      {
        espnId: "100",
        name: "Hurt Guy",
        position: undefined,
        nflTeam: "KC",
        fantasyTeamId: "1",
        fantasyTeamName: "Team One",
        week: 3,
        status: "Out",
        observedAt: kickoff + 40 * MIN,
        kickoffAt: kickoff,
        started: true,
        points: 2,
      },
    ]);
  });

  it("buildInGameInjuries: never a hit when the tag landed before kickoff", () => {
    const kickoff = 30_000_000;
    const hits = buildInGameInjuries({
      week: 3,
      rosters: [{ fantasyTeamId: "1", fantasyTeamName: "Team One", players: [{ espnId: "200", name: "Pre-Game Tag", lineupSlotId: 4, points: 3 }] }],
      nflTeamByEspnId: new Map([["200", "DAL"]]),
      kickoffByNflTeam: new Map([["DAL", kickoff]]),
      injuryEventsByEspnId: new Map([["200", [{ observedAt: kickoff - 3 * HOUR, status: "Out" }]]]),
    });
    expect(hits).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * getInGameInjuriesForWeek (the query)
 * -------------------------------------------------------------------------- */

async function seedQueryFixture(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const kickoffAt = now + 2 * HOUR;
    const leagueId = await ctx.db.insert("leagues", {
      name: "In-Game Injury Test League",
      platform: "espn",
      externalId: "8881",
      commissionerUserId: CLERK,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [], regularSeasonMatchupPeriods: 14 },
      espnData: { seasonId: SEASON, currentScoringPeriod: 3, size: 2, lastSyncedAt: now, isPrivate: false },
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

    const team = async (externalId: string, name: string) =>
      await ctx.db.insert("teams", {
        leagueId,
        externalId,
        seasonId: SEASON,
        name,
        owner: `Owner ${externalId}`,
        record: { wins: 0, losses: 0, ties: 0 },
        roster: [],
        createdAt: now,
        updatedAt: now,
      });
    const teamA = await team("1", "Team One");
    const teamB = await team("2", "Team Two");

    await ctx.db.insert("playersEnhanced", {
      espnId: "9001",
      season: SEASON,
      fullName: "Hurt Guy",
      defaultPositionId: 4,
      defaultPosition: "WR",
      eligibleSlots: [],
      eligiblePositions: ["WR"],
      proTeamId: 1,
      proTeamAbbrev: "KC",
      active: true,
      injured: false,
      droppable: true,
      ownership: { percentOwned: 60, percentStarted: 55 },
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("nflSchedules", {
      season: SEASON,
      week: 3,
      teamId: 12,
      teamAbbrev: "KC",
      opponent: "BUF",
      isHome: true,
      gameTime: kickoffAt,
      isByeWeek: false,
      createdAt: now,
    });
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 3,
      scoringPeriod: 3,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 80,
      awayScore: 70,
      winner: "home",
      homeRoster: {
        appliedStatTotal: 80,
        players: [{ lineupSlotId: 4, espnId: 9001, fullName: "Hurt Guy", position: "WR", points: 5, projectedPoints: 12 }],
      },
      awayRoster: { appliedStatTotal: 70, players: [] },
      createdAt: now,
    });

    return { leagueId, teamA, teamB, kickoffAt };
  });
}

async function seedInjuryEvent(t: ReturnType<typeof convexTest>, observedAt: number, dedupeSuffix: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("wireEvents", {
      kind: "injury_status",
      dedupeKey: `injury_status:9001:Out:${dedupeSuffix}`,
      observedAt,
      detectedAt: observedAt,
      players: [{ espnId: "9001", name: "Hurt Guy" }],
      primaryEspnId: "9001",
      facts: {
        kind: "injury_status",
        observedAt,
        players: [{ espnId: "9001", name: "Hurt Guy" }],
        statusFrom: "Active",
        statusTo: "Out",
        source: { type: "espn_injuries", fetchedAt: observedAt },
      },
      interest: 60,
      source: { type: "espn_injuries", fetchedAt: observedAt },
    });
  });
}

describe("getInGameInjuriesForWeek", () => {
  it("returns a starter tagged 40 minutes after his own kickoff, with started true", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, kickoffAt } = await seedQueryFixture(t);
    await seedInjuryEvent(t, kickoffAt + 40 * MIN, "during");

    const hits = await t.query(internal.inGameInjuries.getInGameInjuriesForWeek, { leagueId, seasonId: SEASON, week: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      espnId: "9001",
      name: "Hurt Guy",
      nflTeam: "KC",
      fantasyTeamId: "1",
      week: 3,
      status: "Out",
      started: true,
      points: 5,
    });
  });

  it("never returns him when the tag landed 3 hours before kickoff", async () => {
    const t = convexTest(schema, modules);
    const { leagueId, kickoffAt } = await seedQueryFixture(t);
    await seedInjuryEvent(t, kickoffAt - 3 * HOUR, "before");

    const hits = await t.query(internal.inGameInjuries.getInGameInjuriesForWeek, { leagueId, seasonId: SEASON, week: 3 });
    expect(hits).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- *
 * getLeagueDataForAI: the bench-impact exclusion (spec §16)
 * -------------------------------------------------------------------------- */

async function seedLeagueDataFixture(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const kickoffAt = now + 2 * HOUR;
    const leagueId = await ctx.db.insert("leagues", {
      name: "In-Game Injury League Data Test",
      platform: "espn",
      externalId: "8882",
      commissionerUserId: CLERK,
      // Only 2 teams seeded below - `playoffTeamCount` must match, or `buildPlayoffContext`
      // (always run by `getLeagueDataForAI`) tries to seed a bracket bigger than the league.
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [], regularSeasonMatchupPeriods: 14, playoffTeamCount: 2 },
      espnData: { seasonId: SEASON, currentScoringPeriod: 3, size: 2, lastSyncedAt: now, isPrivate: false },
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

    const team = async (externalId: string, name: string) =>
      await ctx.db.insert("teams", {
        leagueId,
        externalId,
        seasonId: SEASON,
        name,
        owner: `Owner ${externalId}`,
        record: { wins: 0, losses: 0, ties: 0 },
        roster: [],
        createdAt: now,
        updatedAt: now,
      });
    await team("1", "Team One");
    await team("2", "Team Two");

    await ctx.db.insert("playersEnhanced", {
      espnId: "9001",
      season: SEASON,
      fullName: "Hurt Guy",
      defaultPositionId: 4,
      defaultPosition: "WR",
      eligibleSlots: [],
      eligiblePositions: ["WR"],
      proTeamId: 1,
      proTeamAbbrev: "KC",
      active: true,
      injured: false,
      droppable: true,
      ownership: { percentOwned: 60, percentStarted: 55 },
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("nflSchedules", {
      season: SEASON,
      week: 3,
      teamId: 12,
      teamAbbrev: "KC",
      opponent: "BUF",
      isHome: true,
      gameTime: kickoffAt,
      isByeWeek: false,
      createdAt: now,
    });
    await ctx.db.insert("wireEvents", {
      kind: "injury_status",
      dedupeKey: "injury_status:9001:Out:leaguedata",
      observedAt: kickoffAt + 40 * MIN,
      detectedAt: kickoffAt + 40 * MIN,
      players: [{ espnId: "9001", name: "Hurt Guy" }],
      primaryEspnId: "9001",
      facts: {
        kind: "injury_status",
        observedAt: kickoffAt + 40 * MIN,
        players: [{ espnId: "9001", name: "Hurt Guy" }],
        statusFrom: "Active",
        statusTo: "Out",
        source: { type: "espn_injuries", fetchedAt: kickoffAt + 40 * MIN },
      },
      interest: 60,
      source: { type: "espn_injuries", fetchedAt: kickoffAt + 40 * MIN },
    });

    // Week 3, decided: Team One's WR room carries a starter hurt DURING the game (low score), a
    // second HEALTHY starting WR, and a bench WR who beats the healthy starter by 10+ (spec §16:
    // the comparison must land on the healthy starter, never the injured one).
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 3,
      scoringPeriod: 3,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 80,
      awayScore: 70,
      winner: "home",
      homeRoster: {
        appliedStatTotal: 80,
        players: [
          { lineupSlotId: 4, espnId: 9001, fullName: "Hurt Guy", position: "WR", points: 2, projectedPoints: 12 },
          { lineupSlotId: 4, espnId: 9002, fullName: "Healthy Guy", position: "WR", points: 12, projectedPoints: 10 },
          { lineupSlotId: 20, espnId: 9003, fullName: "Bench Guy", position: "WR", points: 25, projectedPoints: 8 },
        ],
      },
      awayRoster: { appliedStatTotal: 70, players: [] },
      createdAt: now,
    });

    return { leagueId };
  });
}

describe("aiQueries.getLeagueDataForAI: benchImpact excludes an in-game-injured starter", () => {
  it("names the healthy starter as wouldHaveReplacedPlayer, never the injured one", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await seedLeagueDataFixture(t);

    const result: any = await t.query(internal.aiQueries.getLeagueDataForAI, { leagueId, currentWeek: 3 });

    expect(result.inGameInjuries.some((h: any) => h.espnId === "9001" && h.started === true)).toBe(true);

    const matchup = result.recentMatchups.find((m: any) => m.matchupPeriod === 3);
    expect(matchup).toBeDefined();
    const benchImpact = matchup.topPerformers.find((p: any) => p.benchImpact);
    expect(benchImpact).toBeDefined();
    expect(benchImpact.playerName).toBe("Bench Guy");
    expect(benchImpact.wouldHaveReplacedPlayer).toBe("Healthy Guy");
    expect(benchImpact.wouldHaveReplacedPlayer).not.toBe("Hurt Guy");
  });
});

/* -------------------------------------------------------------------------- *
 * commentRequests.buildConversationContext: lineupDecisions excludes the same starter
 * -------------------------------------------------------------------------- */

async function seedInterviewFixture(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const kickoffAt = now + 2 * HOUR;
    const leagueId = await ctx.db.insert("leagues", {
      name: "In-Game Injury Interview League",
      platform: "espn",
      externalId: "8883",
      commissionerUserId: CLERK,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [], regularSeasonMatchupPeriods: 14 },
      espnData: { seasonId: SEASON, currentScoringPeriod: 3, size: 2, lastSyncedAt: now, isPrivate: false },
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
      name: "Ivy Interviewee",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    const teamA = await ctx.db.insert("teams", {
      leagueId,
      externalId: "1",
      seasonId: SEASON,
      name: "Team One",
      owner: "Owner 1",
      record: { wins: 0, losses: 0, ties: 0 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teams", {
      leagueId,
      externalId: "2",
      seasonId: SEASON,
      name: "Team Two",
      owner: "Owner 2",
      record: { wins: 0, losses: 0, ties: 0 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamClaims", {
      leagueId,
      teamId: teamA,
      seasonId: SEASON,
      userId: CLERK,
      status: "active",
      credits: 0,
      createdAt: now,
    });

    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 3,
      scoringPeriod: 3,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 80,
      awayScore: 70,
      winner: "home",
      homeRoster: {
        appliedStatTotal: 80,
        players: [
          { lineupSlotId: 4, espnId: 9001, fullName: "Hurt Guy", position: "WR", points: 2, projectedPoints: 12 },
          { lineupSlotId: 4, espnId: 9002, fullName: "Healthy Guy", position: "WR", points: 12, projectedPoints: 10 },
          { lineupSlotId: 20, espnId: 9003, fullName: "Bench Guy", position: "WR", points: 25, projectedPoints: 8 },
        ],
      },
      awayRoster: { appliedStatTotal: 70, players: [] },
      createdAt: now,
    });

    await ctx.db.insert("nflSchedules", {
      season: SEASON,
      week: 3,
      teamId: 12,
      teamAbbrev: "KC",
      opponent: "BUF",
      isHome: true,
      gameTime: kickoffAt,
      isByeWeek: false,
      createdAt: now,
    });
    await ctx.db.insert("playersEnhanced", {
      espnId: "9001",
      season: SEASON,
      fullName: "Hurt Guy",
      defaultPositionId: 4,
      defaultPosition: "WR",
      eligibleSlots: [],
      eligiblePositions: ["WR"],
      proTeamId: 1,
      proTeamAbbrev: "KC",
      active: true,
      injured: false,
      droppable: true,
      ownership: { percentOwned: 60, percentStarted: 55 },
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("wireEvents", {
      kind: "injury_status",
      dedupeKey: "injury_status:9001:Out:interview",
      observedAt: kickoffAt + 40 * MIN,
      detectedAt: kickoffAt + 40 * MIN,
      players: [{ espnId: "9001", name: "Hurt Guy" }],
      primaryEspnId: "9001",
      facts: {
        kind: "injury_status",
        observedAt: kickoffAt + 40 * MIN,
        players: [{ espnId: "9001", name: "Hurt Guy" }],
        statusFrom: "Active",
        statusTo: "Out",
        source: { type: "espn_injuries", fetchedAt: kickoffAt + 40 * MIN },
      },
      interest: 60,
      source: { type: "espn_injuries", fetchedAt: kickoffAt + 40 * MIN },
    });

    const commentRequestId = await ctx.db.insert("commentRequests", {
      leagueId,
      targetUserId: userId,
      contentType: "weekly_recap",
      interviewerPersona: "sam-ortega",
      writerPersona: "mel-diaper",
      articleContext: { week: 3, seasonId: SEASON, topic: "weekly_recap", focusAreas: [] },
      status: "pending",
      scheduledSendTime: now,
      articleGenerationTime: now + 3_600_000,
      conversationState: "not_started",
      aiContext: { initialPrompt: "", conversationGoals: [], currentFocus: "weekly_recap" },
      autoEndCriteria: { maxMessages: 8, currentMessageCount: 0, minResponseLength: 30, lastActivityTime: now, inactivityTimeoutMinutes: 30 },
      priority: "medium",
      notificationsSent: [],
      createdAt: now,
      updatedAt: now,
    });

    return { leagueId, commentRequestId };
  });
}

describe("commentRequests.buildConversationContext: lineupDecisions excludes an in-game-injured starter", () => {
  it("compares the bench player against the healthy starter, never the one who left hurt", async () => {
    const t = convexTest(schema, modules);
    const { commentRequestId } = await seedInterviewFixture(t);

    const context: any = await t.query(internal.commentRequests.buildConversationContext, { commentRequestId });
    expect(context).not.toBeNull();

    expect(context.inGameInjuries?.some((h: any) => h.espnId === "9001" && h.started === true)).toBe(true);
    expect(context.lineupDecisions).toEqual([
      expect.objectContaining({ benchedPlayer: "Bench Guy", startedPlayer: "Healthy Guy" }),
    ]);
    expect(context.lineupDecisions.some((d: any) => d.startedPlayer === "Hurt Guy")).toBe(false);
  });
});
