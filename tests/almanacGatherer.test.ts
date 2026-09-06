import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

const PREV_SEASON = 2023;
const CURRENT_SEASON = 2024;

/**
 * A two-season league: 2023 is complete (a decided CHAMPIONSHIP game, a stored `champion` row
 * whose `owner` reads "Unknown" - the real prod pattern for 2020-2024, per
 * `convex/aiQueries.ts#espnManagerName`'s header), 2024 is the in-progress current season.
 */
async function seedTwoSeasonLeague(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Almanac Gatherer Test League",
      platform: "espn",
      externalId: "almanac-1",
      commissionerUserId: "clerk_almanac_commish",
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 2, categories: [] },
      espnData: {
        seasonId: CURRENT_SEASON,
        currentScoringPeriod: 1,
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
        seasonYear: CURRENT_SEASON,
      },
      lastSync: now,
      createdAt: now,
    });

    // 2023: complete, with a corrupted-owner (but valid record) stored champion - the real prod
    // shape: teamId/record are trustworthy, "owner" just never got backfilled with a name.
    await ctx.db.insert("leagueSeasons", {
      leagueId,
      seasonId: PREV_SEASON,
      settings: {},
      champion: {
        teamId: "1",
        teamName: "Cameron's Comets",
        owner: "Unknown",
        record: { wins: 10, losses: 3, ties: 0 },
        pointsFor: 1500,
      },
      runnerUp: {
        teamId: "2",
        teamName: "Runner-Up Rockets",
        owner: "Unknown",
        record: { wins: 8, losses: 5, ties: 0 },
        pointsFor: 1400,
      },
      createdAt: now,
    });
    await ctx.db.insert("leagueSeasons", {
      leagueId,
      seasonId: CURRENT_SEASON,
      settings: {},
      createdAt: now,
    });

    await ctx.db.insert("teams", {
      leagueId,
      externalId: "1",
      seasonId: PREV_SEASON,
      name: "Cameron's Comets",
      owner: "Cameron Coscia", // the real manager name - never trust `champion.owner` above.
      record: { wins: 10, losses: 3, ties: 0, pointsFor: 1500, pointsAgainst: 1300, playoffSeed: 1 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teams", {
      leagueId,
      externalId: "2",
      seasonId: PREV_SEASON,
      name: "Runner-Up Rockets",
      owner: "Riley Runnerup",
      record: { wins: 8, losses: 5, ties: 0, pointsFor: 1400, pointsAgainst: 1350, playoffSeed: 2 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: PREV_SEASON,
      matchupPeriod: 1,
      scoringPeriod: 1,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 100.5,
      awayScore: 90.5,
      winner: "home",
      createdAt: now,
    });
    await ctx.db.insert("matchups", {
      leagueId,
      seasonId: PREV_SEASON,
      matchupPeriod: 16,
      scoringPeriod: 16,
      homeTeamId: "1",
      awayTeamId: "2",
      homeScore: 130.5,
      awayScore: 115.2,
      winner: "home",
      playoffTier: "CHAMPIONSHIP",
      createdAt: now,
    });

    // 2024 (current season): both teams still around, no results yet.
    await ctx.db.insert("teams", {
      leagueId,
      externalId: "1",
      seasonId: CURRENT_SEASON,
      name: "Cameron's Comets",
      owner: "Cameron Coscia",
      record: { wins: 0, losses: 0, ties: 0 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teams", {
      leagueId,
      externalId: "2",
      seasonId: CURRENT_SEASON,
      name: "Runner-Up Rockets",
      owner: "Riley Runnerup",
      record: { wins: 0, losses: 0, ties: 0 },
      roster: [],
      createdAt: now,
      updatedAt: now,
    });

    return { leagueId };
  });
}

describe("getLeagueAlmanac", () => {
  it("resolves the manager from the team row when the stored champion says Unknown, and reports the final's margin", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await seedTwoSeasonLeague(t);

    const almanac = await t.query(internal.aiQueries.getLeagueAlmanac, { leagueId });

    expect(almanac.seasonsCovered).toEqual([PREV_SEASON]);
    expect(almanac.currentSeason).toBe(CURRENT_SEASON);

    const season = almanac.seasons.find((s) => s.season === PREV_SEASON)!;
    expect(season.champion?.manager).toBe("Cameron Coscia");
    expect(season.champion?.team).toBe("Cameron's Comets");
    expect(season.runnerUp?.manager).toBe("Riley Runnerup");
    expect(season.final).toMatchObject({ winnerScore: 130.5, loserScore: 115.2, margin: 15.3, week: 16 });

    const champion = almanac.managers.find((m) => m.key === "cameron coscia");
    expect(champion?.titles).toEqual([PREV_SEASON]);
    expect(champion?.currentTeamId).toBe("T1");
    expect(almanac.records.mostTitles).toMatchObject({ manager: "Cameron Coscia", count: 1 });
  });

  it("accepts an explicit seasonId, independent of the league's live current season", async () => {
    const t = convexTest(schema, modules);
    const { leagueId } = await seedTwoSeasonLeague(t);

    const almanac = await t.query(internal.aiQueries.getLeagueAlmanac, { leagueId, seasonId: PREV_SEASON });
    // Asking "as of PREV_SEASON" means PREV_SEASON itself is the current (uncompleted) season,
    // so there is nothing completed on record yet.
    expect(almanac.seasonsCovered).toEqual([]);
    expect(almanac.currentSeason).toBe(PREV_SEASON);
  });
});
