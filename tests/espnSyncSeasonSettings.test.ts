/**
 * `convex/espnSync.ts`'s settings-passthrough fix (spec: audit finding that
 * every one of the six `seasonData.settings`-building call sites read ESPN
 * field names that don't exist - `scheduleSettings.regularSeasonMatchupPeriods`,
 * `scheduleSettings.playoffWeekCount`, `scoringSettings.scoringType === 1` -
 * and so every league was stored as the same hard-coded 14/3/standard
 * defaults; see `convex/lib/espnSettings.ts`'s header comment for the
 * production numbers that proved it).
 *
 * Covers the two pieces of the fix that don't require mocking a live ESPN
 * fetch:
 *  1. `buildSeasonSettings` (the shared helper every sync call site now uses)
 *     produces the full parsed passthrough against a real ESPN response.
 *  2. `updateLeagueSeason`'s extended args validator actually stores that
 *     passthrough on `leagueSeasons.settings` (it used to require exactly the
 *     legacy 7-field shape and would have rejected this object outright).
 *  3. The exact `parsed` value `buildSeasonSettings` hands back is a valid
 *     `internal.leagues.mirrorSeasonSettings` argument that mirrors onto
 *     `leagues.settings` - the wiring the sync actions (`syncLeagueData`,
 *     `syncAllLeagueData`'s current-year branch, `syncOneLeagueCurrentSeasonBody`)
 *     now do after every current-season `updateLeagueSeason` call. The action
 *     bodies themselves aren't exercised here (that needs a mocked
 *     `fetchEspn` cascade well beyond this fix's scope) - `mirrorSeasonSettings`
 *     itself already has full coverage in `tests/leaguesMirrorSeasonSettings.test.ts`.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildSeasonSettings } from "../convex/espnSync";
import fixture from "./fixtures/espn-settings-public-2025.json";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2025;

async function seedLeague(t: ReturnType<typeof convexTest>): Promise<Id<"leagues">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("leagues", {
      name: "Season Settings Test League",
      platform: "espn",
      externalId: "season-settings-league-1",
      commissionerUserId: "clerk_season_settings_commish",
      settings: {
        scoringType: "PPR",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: ["QB", "RB", "WR", "TE", "K", "DEF"],
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

describe("buildSeasonSettings", () => {
  it("passes through the full parsed shape against the real ESPN fixture", () => {
    const { seasonSettings, parsed } = buildSeasonSettings(fixture.settings, "fallback name", 12);

    // Legacy required fields - correct now, not the old always-false numeric
    // comparison / nonexistent-field defaults.
    expect(seasonSettings.regularSeasonMatchupPeriods).toBe(14);
    expect(seasonSettings.playoffTeamCount).toBe(4);
    expect(seasonSettings.scoringType).toBe("standard");
    // playoffRounds (2) x playoffMatchupPeriodLength (2) - a count, not a week list.
    expect(seasonSettings.playoffWeeks).toBe(4);

    // New parsed passthrough fields.
    expect(seasonSettings.playoffMatchupPeriodLength).toBe(2);
    expect(seasonSettings.playoffRounds).toBe(2);
    expect(seasonSettings.playoffSeedingRule).toBe("TOTAL_POINTS_SCORED");
    expect(seasonSettings.divisions).toEqual([{ id: 0, name: "Texas", size: 12 }]);
    expect((seasonSettings.matchupPeriods as Record<string, number[]>)["15"]).toEqual([15, 16]);
    expect(seasonSettings.waiverType).toBe("faab");

    // `parsed` is the raw ParsedLeagueSettings - the exact shape
    // `internal.leagues.mirrorSeasonSettings` expects.
    expect(parsed.regularSeasonMatchupPeriods).toBe(14);
    expect(parsed.playoffRounds).toBe(2);
  });

  it("falls back to the provided name/size when ESPN's settings blob omits them", () => {
    const { seasonSettings } = buildSeasonSettings(undefined, "Fallback League", 8);
    expect(seasonSettings.name).toBe("Fallback League");
    expect(seasonSettings.size).toBe(8);
    // No parsed data at all -> the historic defaults, not garbage.
    expect(seasonSettings.regularSeasonMatchupPeriods).toBe(14);
    expect(seasonSettings.playoffTeamCount).toBe(6);
    expect(seasonSettings.playoffWeeks).toBe(3);
    expect(seasonSettings.scoringType).toBe("standard");
  });
});

describe("updateLeagueSeason settings passthrough", () => {
  it("stores the full buildSeasonSettings output on leagueSeasons.settings (14 / 4 / 2 / TOTAL_POINTS_SCORED / divisions Texas)", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const { seasonSettings } = buildSeasonSettings(fixture.settings, "Season Settings Test League", 12);

    await t.mutation(internal.espnSync.updateLeagueSeason, {
      leagueId,
      seasonId: SEASON,
      seasonData: { settings: seasonSettings as never },
    });

    const season = await t.run((ctx) =>
      ctx.db
        .query("leagueSeasons")
        .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON))
        .first()
    );

    expect(season?.settings).toMatchObject({
      regularSeasonMatchupPeriods: 14,
      playoffTeamCount: 4,
      playoffMatchupPeriodLength: 2,
      playoffRounds: 2,
      playoffSeedingRule: "TOTAL_POINTS_SCORED",
      scoringType: "standard",
      waiverType: "faab",
      faabBudget: 200,
    });
    expect(season?.settings.divisions).toEqual([{ id: 0, name: "Texas", size: 12 }]);
    expect(season?.settings.matchupPeriods["16"]).toEqual([17, 18]);
  });

  it("is a valid input to mirrorSeasonSettings, and the mirror lands on leagues.settings (the wiring syncLeagueData / syncAllLeagueData / syncOneLeagueCurrentSeasonBody now do)", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const { seasonSettings, parsed } = buildSeasonSettings(fixture.settings, "Season Settings Test League", 12);

    await t.mutation(internal.espnSync.updateLeagueSeason, {
      leagueId,
      seasonId: SEASON,
      seasonData: { settings: seasonSettings as never },
    });
    await t.mutation(internal.leagues.mirrorSeasonSettings, {
      leagueId,
      seasonId: SEASON,
      settings: parsed,
    });

    const league = await t.run((ctx) => ctx.db.get(leagueId));
    expect(league?.settings).toMatchObject({
      regularSeasonMatchupPeriods: 14,
      playoffTeamCount: 4,
      playoffMatchupPeriodLength: 2,
      playoffRounds: 2,
      scoringType: "standard",
    });
    expect(league?.settings.matchupPeriods?.["16"]).toEqual([17, 18]);
    expect(league?.settings.settingsSyncedAt).toBeDefined();
  });
});
