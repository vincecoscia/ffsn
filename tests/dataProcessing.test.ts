import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// `calculateTeamMetrics` calls into this pure-function helper module (not a
// Convex function, so it can't be broken via seeded data the way the other
// two steps' DB-driven logic can - see the second describe block below for
// why). Mocking `calculateStrengthOfSchedule` here - with a pass-through to
// the real implementation except for one sentinel team id - gives a
// deterministic, fast way to make exactly one step of
// `processLeagueDataAfterSync` throw so the resilience (try/catch-per-step)
// behavior can be verified without weakening the production code or
// depending on unenforced platform resource limits (convex-test does not
// enforce the 8192-array-values or 1MB-document limits, and the three step
// mutations are written defensively enough that realistic missing/malformed
// data never throws - confirmed by hand before writing this test).
const FAIL_TRIGGER_TEAM_ID = "FAIL_TRIGGER";

vi.mock("../src/lib/ai/data-aggregation-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai/data-aggregation-helpers")>();
  return {
    ...actual,
    calculateStrengthOfSchedule: (
      teamId: string,
      ...rest: Parameters<typeof actual.calculateStrengthOfSchedule> extends [string, ...infer R] ? R : never
    ) => {
      if (teamId === FAIL_TRIGGER_TEAM_ID) {
        throw new Error("mocked calculateStrengthOfSchedule failure");
      }
      return actual.calculateStrengthOfSchedule(teamId, ...rest);
    },
  };
});

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2026;

async function seedLeague(t: ReturnType<typeof convexTest>, externalId: string) {
  const now = Date.now();
  return await t.run(async (ctx) => {
    const leagueId = await ctx.db.insert("leagues", {
      name: "Data Processing Test League",
      platform: "espn",
      externalId,
      commissionerUserId: "clerk_commish",
      settings: {
        scoringType: "standard",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: [],
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
    return leagueId;
  });
}

async function seedTeam(
  t: ReturnType<typeof convexTest>,
  leagueId: Id<"leagues">,
  externalId: string,
  name: string,
  owner: string
) {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("teams", {
      leagueId,
      externalId,
      name,
      owner,
      record: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
      roster: [],
      seasonId: SEASON,
      createdAt: now,
      updatedAt: now,
    })
  );
}

// Three close games between team "1" and team "2" - enough to clear
// `detectRivalries`'s `minGames: 3` threshold, all within its 10-point
// closeness window. Team "1" wins two of three (see the hand-computed
// expectations in the first test below).
async function seedRivalryMatchups(t: ReturnType<typeof convexTest>, leagueId: Id<"leagues">) {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 1,
      scoringPeriod: 1,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 100.5,
      awayScore: 95.5,
      createdAt: now,
    });
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 2,
      scoringPeriod: 2,
      homeTeamId: "2",
      awayTeamId: "1",
      homeScore: 98,
      awayScore: 100,
      createdAt: now,
    });
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 3,
      scoringPeriod: 3,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 90,
      awayScore: 95,
      createdAt: now,
    });
  });
}

// Two transactions for team "1" (one a waiver claim) and one trade between
// team "1" and team "2" - enough for `updateManagerActivity` to produce a
// distinct, hand-checkable row per team.
async function seedManagerActivityInputs(t: ReturnType<typeof convexTest>, leagueId: Id<"leagues">) {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("transactions", {
      leagueId,
      seasonId: SEASON,
      espnTransactionId: "txn-1",
      bidAmount: 0,
      executionType: "EXECUTE",
      isActingAsTeamOwner: true,
      isLeagueManager: false,
      isPending: false,
      items: [],
      type: "WAIVER",
      proposedDate: now,
      status: "EXECUTED",
      scoringPeriod: 1,
      teamId: 1,
      createdAt: now,
    });
    await ctx.db.insert("transactions", {
      leagueId,
      seasonId: SEASON,
      espnTransactionId: "txn-2",
      bidAmount: 0,
      executionType: "EXECUTE",
      isActingAsTeamOwner: true,
      isLeagueManager: false,
      isPending: false,
      items: [],
      type: "FREEAGENT",
      proposedDate: now,
      status: "EXECUTED",
      scoringPeriod: 1,
      teamId: 1,
      createdAt: now,
    });
    await ctx.db.insert("trades", {
      leagueId,
      seasonId: SEASON,
      tradeDate: now,
      status: "completed",
      teamA: { teamId: "1", teamName: "Team One", manager: "Owner One" },
      teamB: { teamId: "2", teamName: "Team Two", manager: "Owner Two" },
      playersFromTeamA: [],
      playersFromTeamB: [],
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("processLeagueDataAfterSync", () => {
  it("upserts rivalries and manager activity idempotently and reports all steps ok", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, "1001");
    await seedTeam(t, leagueId, "1", "Team One", "Owner One");
    await seedTeam(t, leagueId, "2", "Team Two", "Owner Two");
    await seedTeam(t, leagueId, "3", "Team Three", "Owner Three");
    await seedTeam(t, leagueId, "4", "Team Four", "Owner Four");
    await seedRivalryMatchups(t, leagueId);
    await seedManagerActivityInputs(t, leagueId);

    const first = await t.mutation(internal.dataProcessing.processLeagueDataAfterSync, {
      leagueId,
      seasonId: SEASON,
    });

    expect(first).toMatchObject({
      leagueId,
      seasonId: SEASON,
      steps: { teamMetrics: "ok", rivalries: "ok", managerActivity: "ok" },
    });

    // Exactly one rivalry, with the hand-computed head-to-head record:
    // team "1" (sorted first, so `teamA`) won weeks 1 and 2, team "2" won
    // week 3.
    const rivalriesAfterFirst = await t.run((ctx) =>
      ctx.db.query("rivalries").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(rivalriesAfterFirst).toHaveLength(1);
    expect(rivalriesAfterFirst[0]).toMatchObject({
      teamA: { teamId: "1" },
      teamB: { teamId: "2" },
      allTimeRecord: { teamAWins: 2, teamBWins: 1, ties: 0 },
    });
    const rivalryId = rivalriesAfterFirst[0]._id;

    // One manager-activity row per team with activity this season: team "1"
    // (2 transactions incl. 1 waiver, 1 trade) and team "2" (0 transactions,
    // 1 trade).
    const activityAfterFirst = await t.run((ctx) =>
      ctx.db
        .query("managerActivity")
        .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON))
        .collect()
    );
    expect(activityAfterFirst).toHaveLength(2);
    const team1ActivityFirst = activityAfterFirst.find((a) => a.teamId === "1");
    const team2ActivityFirst = activityAfterFirst.find((a) => a.teamId === "2");
    expect(team1ActivityFirst).toMatchObject({ totalTransactions: 2, trades: 1, waiverClaims: 1 });
    expect(team2ActivityFirst).toMatchObject({ totalTransactions: 0, trades: 1, waiverClaims: 0 });
    const team1ActivityId = team1ActivityFirst!._id;
    const team2ActivityId = team2ActivityFirst!._id;

    // Run again with identical input data - this must patch the same rows,
    // not insert duplicates.
    const second = await t.mutation(internal.dataProcessing.processLeagueDataAfterSync, {
      leagueId,
      seasonId: SEASON,
    });
    expect(second.steps).toEqual({ teamMetrics: "ok", rivalries: "ok", managerActivity: "ok" });

    const rivalriesAfterSecond = await t.run((ctx) =>
      ctx.db.query("rivalries").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(rivalriesAfterSecond).toHaveLength(1);
    expect(rivalriesAfterSecond[0]._id).toBe(rivalryId);
    expect(rivalriesAfterSecond[0].allTimeRecord).toEqual({ teamAWins: 2, teamBWins: 1, ties: 0 });

    const activityAfterSecond = await t.run((ctx) =>
      ctx.db
        .query("managerActivity")
        .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON))
        .collect()
    );
    expect(activityAfterSecond).toHaveLength(2);
    const team1ActivitySecond = activityAfterSecond.find((a) => a.teamId === "1");
    const team2ActivitySecond = activityAfterSecond.find((a) => a.teamId === "2");
    // Same document patched in place, not a new row.
    expect(team1ActivitySecond!._id).toBe(team1ActivityId);
    expect(team2ActivitySecond!._id).toBe(team2ActivityId);
    expect(team1ActivitySecond).toMatchObject({ totalTransactions: 2, trades: 1, waiverClaims: 1 });
    expect(team2ActivitySecond).toMatchObject({ totalTransactions: 0, trades: 1, waiverClaims: 0 });
  });

  it("keeps a different league's / prior season's manager activity row untouched (the by_team-only lookup this replaces would have cross-matched it)", async () => {
    const t = convexTest(schema, modules);
    const otherLeagueId = await seedLeague(t, "2001");
    const now = Date.now();
    // A managerActivity row for teamId "1" that belongs to a DIFFERENT
    // league and a DIFFERENT season - the externalId "1" is reused every
    // season and across leagues, which is exactly what made the old
    // `by_team`-only existing-row lookup unsafe.
    const otherRowId = await t.run((ctx) =>
      ctx.db.insert("managerActivity", {
        leagueId: otherLeagueId,
        userId: "someone-else",
        teamId: "1",
        seasonId: SEASON - 1,
        totalTransactions: 999,
        trades: 999,
        waiverClaims: 999,
        lineupChanges: 0,
        lastActiveAt: now,
        loginCount: 0,
        weeklyHighScores: 0,
        weeklyLowScores: 0,
        createdAt: now,
        updatedAt: now,
      })
    );

    const leagueId = await seedLeague(t, "1002");
    await seedTeam(t, leagueId, "1", "Team One", "Owner One");
    await seedTeam(t, leagueId, "2", "Team Two", "Owner Two");
    await seedManagerActivityInputs(t, leagueId);

    await t.mutation(internal.dataProcessing.processLeagueDataAfterSync, { leagueId, seasonId: SEASON });

    // The other league's row is untouched.
    const otherRow = await t.run((ctx) => ctx.db.get(otherRowId));
    expect(otherRow).toMatchObject({ totalTransactions: 999, trades: 999, waiverClaims: 999 });

    // This league/season got its own new row for team "1", not a patch of
    // the other league's row.
    const thisLeagueActivity = await t.run((ctx) =>
      ctx.db
        .query("managerActivity")
        .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON))
        .collect()
    );
    const team1Activity = thisLeagueActivity.find((a) => a.teamId === "1");
    expect(team1Activity).toBeDefined();
    expect(team1Activity!._id).not.toBe(otherRowId);
    expect(team1Activity).toMatchObject({ totalTransactions: 2, trades: 1, waiverClaims: 1 });
  });

  it("catches a single step's failure and still completes the other steps", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, "1003");
    // This team's externalId trips the mocked calculateStrengthOfSchedule
    // failure above, so `calculateTeamMetrics` throws partway through its
    // per-team loop.
    await seedTeam(t, leagueId, FAIL_TRIGGER_TEAM_ID, "Broken Team", "Owner Broken");
    await seedTeam(t, leagueId, "1", "Team One", "Owner One");
    await seedTeam(t, leagueId, "2", "Team Two", "Owner Two");
    await seedRivalryMatchups(t, leagueId);
    await seedManagerActivityInputs(t, leagueId);

    const result = await t.mutation(internal.dataProcessing.processLeagueDataAfterSync, {
      leagueId,
      seasonId: SEASON,
    });

    expect(result.steps.teamMetrics).toMatch(/^error:.*mocked calculateStrengthOfSchedule failure/);
    expect(result.steps.rivalries).toBe("ok");
    expect(result.steps.managerActivity).toBe("ok");

    // Confirm the other two steps didn't just report "ok" - they actually
    // did their work despite calculateTeamMetrics throwing first.
    const rivalries = await t.run((ctx) =>
      ctx.db.query("rivalries").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(rivalries).toHaveLength(1);

    const activity = await t.run((ctx) =>
      ctx.db
        .query("managerActivity")
        .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON))
        .collect()
    );
    expect(activity.find((a) => a.teamId === "1")).toMatchObject({
      totalTransactions: 2,
      trades: 1,
      waiverClaims: 1,
    });
  });
});
