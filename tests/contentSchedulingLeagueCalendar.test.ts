/**
 * `scheduleSeasonAndRelativeContentCron`'s league-relative calendar
 * resolution (spec: audit finding that `mid_season_awards`/`playoff_picture`/
 * `hall_of_shame`/`championship_manifesto`/`season_recap` all fired on fixed
 * NFL-week numbers - `week_9`, `weeks_12_14`, `week_14`, `championship_week`
 * (NFL week 21, the conference championship - two months after any real
 * fantasy championship), `champion_determined` (Super Bowl Sunday, also
 * months late) - that only happen to be right for a 14-week regular season
 * with three single-week playoff rounds. Every real league was stored as
 * exactly that shape (see `convex/lib/espnSettings.ts`'s header comment for
 * the production numbers), so this was silently wrong for every league with
 * a different regular-season length or a multi-week playoff round.
 *
 * Covers: the fixture league (14 regular weeks, 4 playoff teams, 2-week
 * rounds -> playoff picture wks 12-14, awards wk 7, hall of shame wk 14,
 * season end wk 18) lands scheduled rows on those derived weeks; a league
 * with no synced settings falls back to the old fixed-week behavior
 * unchanged.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildSeasonSettings } from "../convex/espnSync";
import fixture from "./fixtures/espn-settings-public-2025.json";

const modules = import.meta.glob("../convex/**/*.*s");

function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

const CLERK_COMMISSIONER = "clerk_commish_calendar_a";
const SEASON = 2026; // KNOWN_SEASONS has real week boundaries for this year (nflSeasonSetup.ts).
const TZ = "America/New_York";

async function seedLeague(t: TestHarness): Promise<Id<"leagues">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "League Calendar Test League",
      platform: "espn",
      externalId: "calendar-league-1",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 1,
        size: 12,
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
    for (let i = 1; i <= 12; i++) {
      await ctx.db.insert("teams", {
        leagueId,
        externalId: String(i),
        seasonId: SEASON,
        name: `Team ${i}`,
        owner: `Manager ${i}`,
        abbreviation: `T${i}`,
        record: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 },
        roster: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    return leagueId;
  });
}

/** Seeds a `leagueSeasons` row whose `.settings` is exactly what `espnSync.ts`'s `buildSeasonSettings` now produces from the real ESPN fixture (14 regular weeks / 4 playoff teams / 2-week rounds). */
async function seedFixtureLeagueSeason(t: TestHarness, leagueId: Id<"leagues">): Promise<void> {
  const { seasonSettings } = buildSeasonSettings(fixture.settings, "League Calendar Test League", 12);
  await t.run(async (ctx) => {
    await ctx.db.insert("leagueSeasons", {
      leagueId,
      seasonId: SEASON,
      settings: seasonSettings,
      createdAt: Date.now(),
    });
  });
}

/** Seeds a `leagueSeasons` row with only the legacy fields (no parser passthrough) - the "not synced with the parser yet" case. */
async function seedLegacyLeagueSeason(t: TestHarness, leagueId: Id<"leagues">): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("leagueSeasons", {
      leagueId,
      seasonId: SEASON,
      settings: {
        name: "Legacy League",
        size: 12,
        scoringType: "standard",
        playoffTeamCount: 6,
        playoffWeeks: 3,
        regularSeasonMatchupPeriods: 14,
      },
      createdAt: Date.now(),
    });
  });
}

async function seedAutomation(t: TestHarness, leagueId: Id<"leagues">): Promise<void> {
  await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
  await t.mutation(internal.contentScheduling.createDefaultContentSchedules, { leagueId, timezone: TZ });
}

async function enableSchedule(t: TestHarness, leagueId: Id<"leagues">, contentType: string): Promise<void> {
  await t.run(async (ctx) => {
    const schedule = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league_type", (q) => q.eq("leagueId", leagueId).eq("contentType", contentType as never))
      .first();
    if (schedule) await ctx.db.patch(schedule._id, { enabled: true });
  });
}

async function scheduledWeekFor(
  t: TestHarness,
  leagueId: Id<"leagues">,
  contentType: string
): Promise<number | undefined> {
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("scheduledContent")
      .withIndex("by_league_type_season_week", (q) => q.eq("leagueId", leagueId).eq("contentType", contentType as never))
      .first()
  );
  return row?.week;
}

describe("scheduleSeasonAndRelativeContentCron: league-relative calendar resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules mid_season_awards / hall_of_shame / playoff_picture on the fixture league's derived weeks (7 / 14 / 12), not the fixed 9 / 14 / 12-14 defaults", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await seedFixtureLeagueSeason(t, leagueId);
    await seedAutomation(t, leagueId);
    await enableSchedule(t, leagueId, "hall_of_shame");

    // Deep in the REGULAR_SEASON phase (mid_season_awards/hall_of_shame's
    // gate requires it), well before any of weeks 7/12/14 have passed.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0)); // Sept 15, 2026

    await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});

    expect(await scheduledWeekFor(t, leagueId, "mid_season_awards")).toBe(7); // ceil(14/2)
    expect(await scheduledWeekFor(t, leagueId, "hall_of_shame")).toBe(14); // lastRegularSeasonWeek
    expect(await scheduledWeekFor(t, leagueId, "playoff_picture")).toBe(12); // earliest of [12,13,14]
  });

  it("falls back to the fixed NFL-week defaults (9 / 14 / 12) when the league has no leagueSeasons row synced with the parser yet", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    // No leagueSeasons row at all - the "league has no settings" fallback case.
    await seedAutomation(t, leagueId);
    await enableSchedule(t, leagueId, "hall_of_shame");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));

    await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});

    expect(await scheduledWeekFor(t, leagueId, "mid_season_awards")).toBe(9);
    expect(await scheduledWeekFor(t, leagueId, "hall_of_shame")).toBe(14);
    expect(await scheduledWeekFor(t, leagueId, "playoff_picture")).toBe(12);
  });

  it("also falls back when leagueSeasons.settings has only the legacy fields (no playoffRounds/playoffMatchupPeriodLength - not re-synced with the new parser yet)", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await seedLegacyLeagueSeason(t, leagueId);
    await seedAutomation(t, leagueId);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));

    await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});

    expect(await scheduledWeekFor(t, leagueId, "mid_season_awards")).toBe(9);
    expect(await scheduledWeekFor(t, leagueId, "playoff_picture")).toBe(12);
  });

  it("schedules season_recap on the Tuesday after the fixture league's last championship week (18), not Super Bowl Sunday", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await seedFixtureLeagueSeason(t, leagueId);
    await seedAutomation(t, leagueId);

    // season_recap's gate requires OFFSEASON (well after the real Super Bowl).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2027, 2, 1, 12, 0, 0)); // March 1, 2027

    await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});

    expect(await scheduledWeekFor(t, leagueId, "season_recap")).toBe(18);
  });

  it("re-running the cron does not duplicate an already-scheduled league-relative row (idempotency preserved)", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await seedFixtureLeagueSeason(t, leagueId);
    await seedAutomation(t, leagueId);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));

    const first = await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});
    const second = await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});
    expect(second.scheduled).toBe(0);
    expect(first.scheduled).toBeGreaterThan(0);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league_type_season_week", (q) => q.eq("leagueId", leagueId).eq("contentType", "mid_season_awards" as never))
        .collect()
    );
    expect(rows).toHaveLength(1);
  });
});

/**
 * `isWeekFinal` / `hasMatchupsForWeek`'s week -> ESPN matchup period mapping
 * (spec: these queries used to filter `matchups.matchupPeriod` by the raw
 * NFL week number, which only works when every matchup period is exactly one
 * NFL week. A 2-week playoff round is stored under its OWN period id - e.g.
 * period 16 holds NFL weeks 17-18 in the fixture league - so querying by
 * week 17 or 18 directly found nothing).
 */
describe("isWeekFinal / hasMatchupsForWeek: NFL week -> ESPN matchup period mapping", () => {
  it("1:1 league (no multi-week rounds): unchanged behaviour - week N maps directly to matchupPeriod N", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
    await t.run(async (ctx) => {
      await ctx.db.insert("leagueSeasons", {
        leagueId,
        seasonId: SEASON,
        settings: {
          name: "1:1 League",
          size: 10,
          scoringType: "standard",
          playoffTeamCount: 6,
          playoffWeeks: 3,
          regularSeasonMatchupPeriods: 13,
          playoffRounds: 3,
          playoffMatchupPeriodLength: 1,
          // Straight 1:1 map: period N -> week [N].
          matchupPeriods: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i + 1), [i + 1]])),
        },
        createdAt: Date.now(),
      });
      await ctx.db.insert("matchups", {
        leagueId,
        seasonId: SEASON,
        matchupPeriod: 5,
        scoringPeriod: 5,
        homeTeamId: "1",
        awayTeamId: "2",
        homeScore: 100,
        awayScore: 90,
        winner: "home",
        createdAt: Date.now(),
      });
    });

    const result = await t.query(internal.contentScheduling.isWeekFinal, { leagueId, seasonId: SEASON, week: 5 });
    expect(result.matchups).toBe(1);
    expect(result.final).toBe(true);
    expect(result.reason).toBe("final");

    const hasMatchups = await t.query(internal.contentScheduling.hasMatchupsForWeek, {
      leagueId,
      seasonId: SEASON,
      week: 5,
    });
    expect(hasMatchups).toBe(true);
  });

  it("2-week playoff round: week 18 (the LAST NFL week of the round) finds the matchup row stored under ESPN period 16, not week 18 itself", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
    await seedFixtureLeagueSeason(t, leagueId); // 14 reg / 4 playoff teams / 2-week rounds; period 16 -> weeks [17, 18]
    await t.run(async (ctx) => {
      await ctx.db.insert("matchups", {
        leagueId,
        seasonId: SEASON,
        matchupPeriod: 16,
        scoringPeriod: 18,
        homeTeamId: "1",
        awayTeamId: "2",
        homeScore: 210,
        awayScore: 195,
        winner: "home",
        createdAt: Date.now(),
      });
    });

    // The OLD behaviour (querying matchupPeriod === week directly) would find
    // nothing for week 18 - only a period-16 row exists - and report
    // `no_matchups`/`false`. The fix maps week 18 -> period 16 first.
    const result = await t.query(internal.contentScheduling.isWeekFinal, { leagueId, seasonId: SEASON, week: 18 });
    expect(result.matchups).toBe(1);
    expect(result.final).toBe(true);
    expect(result.reason).toBe("final");

    const hasMatchups = await t.query(internal.contentScheduling.hasMatchupsForWeek, {
      leagueId,
      seasonId: SEASON,
      week: 18,
    });
    expect(hasMatchups).toBe(true);
  });

  it("2-week playoff round: not final while the round's matchup has no winner yet and the week has not passed", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
    await seedFixtureLeagueSeason(t, leagueId);
    await t.run(async (ctx) => {
      await ctx.db.insert("matchups", {
        leagueId,
        seasonId: SEASON,
        matchupPeriod: 16,
        scoringPeriod: 17,
        homeTeamId: "1",
        awayTeamId: "2",
        homeScore: 50,
        awayScore: 40, // in progress: scored but no winner yet
        createdAt: Date.now(),
      });
    });

    const result = await t.query(internal.contentScheduling.isWeekFinal, {
      leagueId,
      seasonId: SEASON,
      week: 18,
      now: new Date(2026, 11, 1).getTime(), // Dec 1, 2026 - long before week 18 (~early Jan 2027)
    });
    expect(result.matchups).toBe(1);
    expect(result.final).toBe(false);
    expect(result.reason).toBe("unfinished_matchups");
  });
});
