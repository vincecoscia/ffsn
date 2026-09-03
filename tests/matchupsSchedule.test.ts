/**
 * `api.matchups.getScheduleBySeason` (spec: replace the schedule page's 18
 * `getByLeagueAndPeriod` round trips with one slim per-season query; see
 * `convex/lib/matchupSummary.ts`'s header comment for the status/score/
 * projected rules this asserts end to end).
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { MatchupSummary } from "../convex/lib/matchupSummary";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2026;
const OTHER_SEASON = 2025;
const CLERK_COMMISSIONER = "clerk_schedule_commissioner";
const CLERK_OUTSIDER = "clerk_schedule_outsider";

async function seedLeague(t: ReturnType<typeof convexTest>): Promise<Id<"leagues">> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    const leagueId = await ctx.db.insert("leagues", {
      name: "Schedule Test League",
      platform: "espn",
      externalId: "schedule-league-1",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: {
        scoringType: "PPR",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: ["QB", "RB", "WR", "TE", "K", "DEF"],
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

    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: CLERK_COMMISSIONER,
      role: "commissioner",
      joinedAt: now,
    });

    return leagueId;
  });
}

async function seedMatchups(t: ReturnType<typeof convexTest>, leagueId: Id<"leagues">) {
  const now = Date.now();

  await t.run(async (ctx) => {
    // Week 2: final, with a winner - `doc.homeScore`/`doc.awayScore` are canonical.
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 2,
      scoringPeriod: 2,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 120.5,
      awayScore: 99.25,
      winner: "home",
      createdAt: now,
    });

    // Week 1: live via homePointsByScoringPeriod alone - doc.homeScore/awayScore still 0,
    // no winner yet.
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 1,
      scoringPeriod: 1,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 0,
      awayScore: 0,
      homePointsByScoringPeriod: { "1": 14.4 },
      createdAt: now,
    });

    // Week 3: scheduled - zeros everywhere, plus a roster with an IR player that must be
    // excluded from the projected total (146.2 - 11.8 IR = 134.4, matching the prod audit finding).
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: SEASON,
      matchupPeriod: 3,
      scoringPeriod: 3,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 0,
      awayScore: 0,
      homeRoster: {
        appliedStatTotal: 0,
        players: [
          {
            lineupSlotId: 0, // QB starter
            espnId: 1,
            fullName: "Starter QB",
            position: "QB",
            points: 0,
            projectedPoints: 134.4,
          },
          {
            lineupSlotId: 21, // IR - must be excluded from the projected total
            espnId: 2,
            fullName: "Injured RB",
            position: "RB",
            points: 0,
            projectedPoints: 11.8,
          },
        ],
      },
      createdAt: now,
    });

    // A different season - must not come back.
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: OTHER_SEASON,
      matchupPeriod: 1,
      scoringPeriod: 1,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 80,
      awayScore: 70,
      winner: "home",
      createdAt: now,
    });
  });
}

async function seedLeagueSeason(
  t: ReturnType<typeof convexTest>,
  leagueId: Id<"leagues">,
  seasonId: number,
  draftSettings: { keeperCount?: number; keeperCountFuture?: number }
) {
  const now = Date.now();
  await t.run(async (ctx) =>
    ctx.db.insert("leagueSeasons", {
      leagueId,
      seasonId,
      settings: {},
      draftInfo: { drafted: false, inProgress: false },
      draftSettings,
      createdAt: now,
    })
  );
}

describe("matchups.getScheduleBySeason - pre-draft redraft projections", () => {
  it("hides projected points for a pre-draft redraft league season, but leaves pairings/status alone", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    await seedMatchups(t, leagueId);
    await seedLeagueSeason(t, leagueId, SEASON, { keeperCount: 0, keeperCountFuture: 0 });

    const result = await t
      .withIdentity({ subject: CLERK_COMMISSIONER })
      .query(api.matchups.getScheduleBySeason, { leagueId, seasonId: SEASON });

    expect(result).toHaveLength(3);
    const [week1, week2, week3] = result;

    // Projections are hidden everywhere...
    expect(week1.homeProjected).toBeNull();
    expect(week1.awayProjected).toBeNull();
    expect(week3.homeProjected).toBeNull();
    expect(week3.awayProjected).toBeNull();

    // ...but pairings/status/scores are untouched.
    expect(week1.status).toBe("live");
    expect(week2.status).toBe("final");
    expect(week2.winner).toBe("home");
    expect(week2.homeScore).toBe(120.5);
    expect(week3.status).toBe("scheduled");
    expect(week3.homeTeamId).toBe("1");
    expect(week3.awayTeamId).toBe("2");
  });

  it("keeps projected points when the league season is a keeper league (keeperCount > 0)", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    await seedMatchups(t, leagueId);
    await seedLeagueSeason(t, leagueId, SEASON, { keeperCount: 1, keeperCountFuture: 0 });

    const result = await t
      .withIdentity({ subject: CLERK_COMMISSIONER })
      .query(api.matchups.getScheduleBySeason, { leagueId, seasonId: SEASON });

    const week3 = result.find((m: MatchupSummary) => m.matchupPeriod === 3)!;
    expect(week3.homeProjected).toBe(134.4);
  });
});

describe("matchups.getScheduleBySeason", () => {
  it("returns [] when signed out", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    await seedMatchups(t, leagueId);

    const result = await t.query(api.matchups.getScheduleBySeason, { leagueId, seasonId: SEASON });
    expect(result).toEqual([]);
  });

  it("returns [] for a signed-in user who is not a member of the league", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    await seedMatchups(t, leagueId);

    const result = await t
      .withIdentity({ subject: CLERK_OUTSIDER })
      .query(api.matchups.getScheduleBySeason, { leagueId, seasonId: SEASON });
    expect(result).toEqual([]);
  });

  it("returns only the requested season's matchups, sorted, summarized, and roster-free", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    await seedMatchups(t, leagueId);

    const result = await t
      .withIdentity({ subject: CLERK_COMMISSIONER })
      .query(api.matchups.getScheduleBySeason, { leagueId, seasonId: SEASON });

    expect(result).toHaveLength(3);
    expect(result.map((m: MatchupSummary) => m.matchupPeriod)).toEqual([1, 2, 3]);

    // No roster fields leak through.
    for (const m of result) {
      expect(m).not.toHaveProperty("homeRoster");
      expect(m).not.toHaveProperty("awayRoster");
    }

    const [week1, week2, week3] = result;

    // Week 1: live via the points-by-period map alone.
    expect(week1.status).toBe("live");
    expect(week1.winner).toBeNull();
    expect(week1.homeScore).toBe(0);
    expect(week1.awayScore).toBe(0);
    expect(week1.homeProjected).toBeNull();
    expect(week1.awayProjected).toBeNull();

    // Week 2: final, official scores used as-is.
    expect(week2.status).toBe("final");
    expect(week2.winner).toBe("home");
    expect(week2.homeScore).toBe(120.5);
    expect(week2.awayScore).toBe(99.25);

    // Week 3: scheduled, IR excluded from the projected total.
    expect(week3.status).toBe("scheduled");
    expect(week3.winner).toBeNull();
    expect(week3.homeScore).toBe(0);
    expect(week3.awayScore).toBe(0);
    expect(week3.homeProjected).toBe(134.4);
    expect(week3.awayProjected).toBeNull();
  });
});
