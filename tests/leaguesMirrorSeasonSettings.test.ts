/**
 * `internal.leagues.mirrorSeasonSettings` (spec: audit finding that
 * `leagues.settings` was written once by the setup wizard and never
 * refreshed, which is what let `dataProcessing.ts`'s playoff-week math go
 * stale/negative - see `tests/dataProcessing.test.ts`'s
 * "getEnrichedLeagueData playoff probabilities" block for the consumer side
 * of that bug).
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { parseEspnLeagueSettings } from "../convex/lib/espnSettings";
import fixture from "./fixtures/espn-settings-public-2025.json";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2025;

async function seedLeague(t: ReturnType<typeof convexTest>): Promise<Id<"leagues">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name: "Mirror Test League",
      platform: "espn",
      externalId: "mirror-league-1",
      commissionerUserId: "clerk_mirror_commish",
      settings: {
        scoringType: "PPR",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: ["QB", "RB", "WR", "TE", "K", "DEF"],
        rosterComposition: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BE: 7 },
        playoffTeamCount: 6,
        regularSeasonMatchupPeriods: 14,
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
    })
  );
}

describe("leagues.mirrorSeasonSettings", () => {
  it("patches the mirrored subset of a real parsed settings object onto leagues.settings", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const parsed = parseEspnLeagueSettings(fixture.settings);

    const before = Date.now();
    await t.mutation(internal.leagues.mirrorSeasonSettings, {
      leagueId,
      seasonId: SEASON,
      settings: parsed,
    });

    const league = await t.run((ctx) => ctx.db.get(leagueId));
    expect(league?.settings).toMatchObject({
      // Refreshed from the sync (matches the real fixture: 14 weeks, 4
      // playoff teams - a real season could legitimately differ from what
      // the setup wizard stored at creation time).
      regularSeasonMatchupPeriods: 14,
      playoffTeamCount: 4,
      playoffMatchupPeriodLength: 2,
      playoffRounds: 2,
      playoffSeedingRule: "TOTAL_POINTS_SCORED",
      playoffReseed: false,
      scoringType: "standard",
      scoringSystem: "H2H_POINTS",
      divisions: [{ id: 0, name: "Texas", size: 12 }],
      waiverType: "faab",
      faabBudget: 200,
      waiverHours: 24,
      tradeDeadline: 1764784800000,
      // Untouched fields the setup wizard originally wrote.
      rosterSize: 16,
      categories: ["QB", "RB", "WR", "TE", "K", "DEF"],
      rosterComposition: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BE: 7 },
    });
    expect(league?.settings.matchupPeriods?.["15"]).toEqual([15, 16]);
    expect(league?.settings.lineupSlots).toBeDefined();
    expect(league?.settings.settingsSyncedAt).toBeGreaterThanOrEqual(before);
  });

  it("spreads existing settings first, so a field the parsed input didn't have is left as-is", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("leagues", {
        name: "Sparse Mirror League",
        platform: "espn",
        externalId: "mirror-league-sparse",
        commissionerUserId: "clerk_mirror_commish",
        settings: {
          scoringType: "half-ppr",
          rosterSize: 16,
          playoffWeeks: 3,
          categories: [],
          playoffTeamCount: 6,
          regularSeasonMatchupPeriods: 14,
          waiverType: "waivers",
          faabBudget: 0,
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
    });

    // A parsed settings object that only knows about playoffReseed - every
    // other mirrorable field came back undefined this sync (e.g. a partial
    // ESPN response).
    const sparse = parseEspnLeagueSettings({
      scheduleSettings: { playoffReseed: true },
    });

    await t.mutation(internal.leagues.mirrorSeasonSettings, {
      leagueId,
      seasonId: SEASON,
      settings: sparse,
    });

    const league = await t.run((ctx) => ctx.db.get(leagueId));
    // The one field the sparse input actually had.
    expect(league?.settings.playoffReseed).toBe(true);
    // Everything else survives untouched - not reset to undefined/defaults.
    expect(league?.settings).toMatchObject({
      scoringType: "half-ppr",
      waiverType: "waivers",
      faabBudget: 0,
      playoffTeamCount: 6,
      regularSeasonMatchupPeriods: 14,
    });
  });

  it("stamps settingsSyncedAt even when called again with identical input (idempotent)", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const parsed = parseEspnLeagueSettings(fixture.settings);

    await t.mutation(internal.leagues.mirrorSeasonSettings, { leagueId, seasonId: SEASON, settings: parsed });
    const firstSyncedAt = (await t.run((ctx) => ctx.db.get(leagueId)))?.settings.settingsSyncedAt;

    await new Promise((resolve) => setTimeout(resolve, 2));
    await t.mutation(internal.leagues.mirrorSeasonSettings, { leagueId, seasonId: SEASON, settings: parsed });
    const secondSyncedAt = (await t.run((ctx) => ctx.db.get(leagueId)))?.settings.settingsSyncedAt;

    expect(firstSyncedAt).toBeDefined();
    expect(secondSyncedAt).toBeGreaterThanOrEqual(firstSyncedAt!);
  });

  it("throws for a league that doesn't exist", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    await t.run((ctx) => ctx.db.delete(leagueId));

    await expect(
      t.mutation(internal.leagues.mirrorSeasonSettings, {
        leagueId,
        seasonId: SEASON,
        settings: parseEspnLeagueSettings(undefined),
      })
    ).rejects.toThrow();
  });
});
