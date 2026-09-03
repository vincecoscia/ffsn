import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { convertUTCToTimeZone, convertTimeZoneToUTC } from "../convex/contentScheduling";
import { nextMorningAfter, resolveScheduledDraftDate } from "../convex/lib/draftDate";

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * `convexTest` bound to this app's schema. Helpers take this rather than the
 * bare `ReturnType<typeof convexTest>`, which loses the schema's index names.
 */
function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

const CLERK_COMMISSIONER = "clerk_commish_draftdate_a";
const SEASON = 2026;
const TZ = "America/New_York";

function isoUTC(ms: number): string {
  return new Date(ms).toISOString();
}

/** `nextMorningAfter` bound to America/New_York 9am with a 6h floor, using this app's own timezone conversion pair. */
function nextMorningAfterNY(triggerMs: number): number {
  return nextMorningAfter(triggerMs, TZ, { hour: 9, minHoursAfter: 6 }, convertUTCToTimeZone, convertTimeZoneToUTC);
}

async function seedLeague(t: TestHarness, opts?: { seasonId?: number }) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "Draft Date Test League",
      platform: "espn",
      externalId: "9911",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: opts?.seasonId ?? SEASON,
        currentScoringPeriod: 1,
        size: 10,
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

    for (let i = 1; i <= 10; i++) {
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

    return { leagueId };
  });
}

/** Seed the season boundaries and the automatic-by-default content calendar. */
async function seedAutomation(t: TestHarness, leagueId: Awaited<ReturnType<typeof seedLeague>>["leagueId"]) {
  await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
  await t.mutation(internal.contentScheduling.createDefaultContentSchedules, {
    leagueId,
    timezone: TZ,
  });
}

async function enableSchedule(
  t: TestHarness,
  leagueId: Awaited<ReturnType<typeof seedLeague>>["leagueId"],
  contentType: string
) {
  await t.run(async (ctx) => {
    const schedule = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league_type", (q) => q.eq("leagueId", leagueId).eq("contentType", contentType as never))
      .first();
    if (schedule) {
      await ctx.db.patch(schedule._id, { enabled: true });
    }
  });
}

const REQUIRED_SETTINGS = {
  name: "Draft Date Test League",
  size: 10,
  scoringType: "ppr",
  playoffTeamCount: 6,
  playoffWeeks: 3,
  regularSeasonMatchupPeriods: 14,
};

describe("resolveScheduledDraftDate (spec: pre-draft/post-draft content timing)", () => {
  it("resolves a plausible draftSettings.date as scheduledAt", () => {
    const date = Date.UTC(2026, 7, 20, 0, 0, 0);
    const resolved = resolveScheduledDraftDate({
      draftSettings: { date, type: "SNAKE", timePerSelection: 90 },
    });
    expect(resolved.scheduledAt).toBe(date);
    expect(resolved.completedAt).toBeUndefined();
    expect(resolved.type).toBe("SNAKE");
    expect(resolved.isRolling).toBe(false);
  });

  it("treats a non-positive/sentinel draftSettings.date as not scheduled", () => {
    expect(resolveScheduledDraftDate({ draftSettings: { date: 0 } }).scheduledAt).toBeUndefined();
    expect(resolveScheduledDraftDate({ draftSettings: { date: -1 } }).scheduledAt).toBeUndefined();
    expect(resolveScheduledDraftDate({ draftSettings: {} }).scheduledAt).toBeUndefined();
    expect(resolveScheduledDraftDate({}).scheduledAt).toBeUndefined();
  });

  it("resolves draftInfo.draftDate as completedAt, but not the `1` sentinel", () => {
    const completeDate = Date.UTC(2026, 7, 20, 23, 0, 0);
    expect(
      resolveScheduledDraftDate({ draftInfo: { draftDate: completeDate, drafted: true } }).completedAt
    ).toBe(completeDate);

    // drafted flipped true before ESPN backfilled a real completeDate.
    expect(resolveScheduledDraftDate({ draftInfo: { draftDate: 1, drafted: true } }).completedAt).toBeUndefined();
  });

  it("prefers draftSettings.type, falling back to draftInfo.draftType", () => {
    expect(
      resolveScheduledDraftDate({ draftSettings: { type: "AUCTION" }, draftInfo: { draftType: "SNAKE" } }).type
    ).toBe("AUCTION");
    expect(resolveScheduledDraftDate({ draftInfo: { draftType: "SNAKE" } }).type).toBe("SNAKE");
  });

  it("flags a rolling draft: OFFLINE type, or a >=1h pick clock", () => {
    expect(resolveScheduledDraftDate({ draftSettings: { type: "OFFLINE" } }).isRolling).toBe(true);
    expect(resolveScheduledDraftDate({ draftSettings: { type: "SNAKE", timePerSelection: 3600 } }).isRolling).toBe(true);
    expect(resolveScheduledDraftDate({ draftSettings: { type: "SNAKE", timePerSelection: 3599 } }).isRolling).toBe(false);
    expect(resolveScheduledDraftDate({ draftSettings: { type: "SNAKE", timePerSelection: 90 } }).isRolling).toBe(false);
    expect(resolveScheduledDraftDate({}).isRolling).toBe(false);
  });
});

describe("nextMorningAfter (spec: draft_rankings prints the morning after)", () => {
  it("an evening trigger prints the next morning", () => {
    // Jan 6 2026 21:00 EST -> next 9am clearing the 6h floor is Jan 7 09:00 EST.
    const trigger = Date.UTC(2026, 0, 7, 2, 0, 0);
    expect(isoUTC(nextMorningAfterNY(trigger))).toBe("2026-01-07T14:00:00.000Z");
  });

  it("a trigger inside the 6h floor before 9am rolls to the following morning", () => {
    // Jan 6 2026 05:00 EST: same-day 9am is only 4h later, short of the 6h
    // floor, so this rolls to Jan 7 09:00 EST rather than printing same-day.
    const trigger = Date.UTC(2026, 0, 6, 10, 0, 0);
    expect(isoUTC(nextMorningAfterNY(trigger))).toBe("2026-01-07T14:00:00.000Z");
  });

  it("a trigger early enough (>=6h before 9am) prints the same day", () => {
    // Jan 6 2026 01:30 EST: same-day 9am is 7.5h later, clearing the floor.
    const trigger = Date.UTC(2026, 0, 6, 6, 30, 0);
    expect(isoUTC(nextMorningAfterNY(trigger))).toBe("2026-01-06T14:00:00.000Z");
  });

  it("exactly at the 6h floor still counts as clearing it", () => {
    // Jan 6 2026 03:00 EST + 6h = Jan 6 09:00 EST exactly.
    const trigger = Date.UTC(2026, 0, 6, 8, 0, 0);
    expect(isoUTC(nextMorningAfterNY(trigger))).toBe("2026-01-06T14:00:00.000Z");
  });

  it("crosses a local-midnight boundary correctly", () => {
    // June 30 2026 23:30 EDT -> July 1 09:00 EDT.
    const trigger = Date.UTC(2026, 6, 1, 3, 30, 0);
    expect(isoUTC(nextMorningAfterNY(trigger))).toBe("2026-07-01T13:00:00.000Z");
  });

  it("survives the US spring-forward transition", () => {
    // March 7 2026 15:00 EST -> rolls to March 8 09:00 EDT (spring-forward day).
    const trigger = Date.UTC(2026, 2, 7, 20, 0, 0);
    expect(isoUTC(nextMorningAfterNY(trigger))).toBe("2026-03-08T13:00:00.000Z");
  });

  it("survives the US fall-back transition", () => {
    // Oct 31 2026 17:00 EDT -> rolls to Nov 1 09:00 EST (fall-back day).
    const trigger = Date.UTC(2026, 9, 31, 21, 0, 0);
    expect(isoUTC(nextMorningAfterNY(trigger))).toBe("2026-11-01T14:00:00.000Z");
  });

  it("leaves UTC arithmetic simple (no offset)", () => {
    // 21:00 UTC -> next 9am UTC clearing 6h is the following day.
    const trigger = Date.UTC(2026, 5, 10, 21, 0, 0);
    expect(isoUTC(nextMorningAfter(trigger, "UTC", { hour: 9, minHoursAfter: 6 }, convertUTCToTimeZone, convertTimeZoneToUTC)))
      .toBe("2026-06-11T09:00:00.000Z");
  });
});

describe("scheduleSeasonAndRelativeContentCron: mock_draft from draftSettings.date (spec 9.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules mock_draft 7 days before the scheduled draft at 9am league time", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 1, 12, 0, 0))); // Aug 1 2026, well before the draft

    const { leagueId } = await seedLeague(t);
    await seedAutomation(t, leagueId);
    await enableSchedule(t, leagueId, "mock_draft");

    const draftDate = Date.UTC(2026, 7, 29, 0, 0, 0); // Aug 28 2026 20:00 EDT
    await t.run(async (ctx) => {
      await ctx.db.insert("leagueSeasons", {
        leagueId,
        seasonId: SEASON,
        settings: REQUIRED_SETTINGS,
        draftSettings: { date: draftDate, type: "SNAKE", timePerSelection: 90 },
        createdAt: Date.now(),
      });
    });

    const result = await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});
    expect(result.scheduled).toBeGreaterThan(0);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    const mockDraftRows = rows.filter((r) => r.contentType === "mock_draft");
    expect(mockDraftRows).toHaveLength(1);
    // 7 days before Aug 28 2026 20:00 EDT, at 9:00 EDT local -> Aug 21 2026 09:00 EDT.
    expect(isoUTC(mockDraftRows[0].scheduledFor)).toBe("2026-08-21T13:00:00.000Z");

    // A second pass must not create a duplicate.
    const second = await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});
    const rowsAfterSecond = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(rowsAfterSecond.filter((r) => r.contentType === "mock_draft")).toHaveLength(1);
    void second;
  });

  it("skips once the computed mock_draft slot is already in the past", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { leagueId } = await seedLeague(t);
    await seedAutomation(t, leagueId);
    await enableSchedule(t, leagueId, "mock_draft");

    const draftDate = Date.UTC(2026, 7, 29, 0, 0, 0); // Aug 28 2026 20:00 EDT
    await t.run(async (ctx) => {
      await ctx.db.insert("leagueSeasons", {
        leagueId,
        seasonId: SEASON,
        settings: REQUIRED_SETTINGS,
        draftSettings: { date: draftDate, type: "SNAKE", timePerSelection: 90 },
        createdAt: Date.now(),
      });
    });

    // Now is after the computed mock_draft slot (Aug 21 2026 13:00 UTC), but
    // still before the draft itself.
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 25, 12, 0, 0)));

    await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});

    const rows = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(rows.filter((r) => r.contentType === "mock_draft")).toHaveLength(0);
  });

  it("skips once the draft is already complete, regardless of draftSettings.date", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 1, 12, 0, 0)));

    const { leagueId } = await seedLeague(t);
    await seedAutomation(t, leagueId);
    await enableSchedule(t, leagueId, "mock_draft");

    const draftDate = Date.UTC(2026, 7, 29, 0, 0, 0);
    await t.run(async (ctx) => {
      await ctx.db.insert("leagueSeasons", {
        leagueId,
        seasonId: SEASON,
        settings: REQUIRED_SETTINGS,
        draftSettings: { date: draftDate, type: "SNAKE", timePerSelection: 90 },
        draftInfo: { draftDate: draftDate, drafted: true, inProgress: false },
        createdAt: Date.now(),
      });
    });

    await t.action(internal.contentScheduling.scheduleSeasonAndRelativeContentCron, {});

    const rows = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(rows.filter((r) => r.contentType === "mock_draft")).toHaveLength(0);
  });
});

describe("triggerEventBasedContent: draft_completed times draft_rankings for the morning after (spec 9.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules draft_rankings at the next-morning instant, not a fixed delay", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Sept 1 2026 21:00 EDT -> next-morning floor lands on Sept 2 09:00 EDT.
    const triggerMs = Date.UTC(2026, 8, 2, 1, 0, 0);
    vi.setSystemTime(new Date(triggerMs));

    const { leagueId } = await seedLeague(t);
    await seedAutomation(t, leagueId); // draft_rankings ships enabled by default

    await t.action(internal.contentScheduling.triggerEventBasedContent, {
      leagueId,
      eventType: "draft_completed",
      eventData: { seasonId: SEASON, draftType: "SNAKE" },
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    const draftRankingsRows = rows.filter((r) => r.contentType === "draft_rankings");
    expect(draftRankingsRows).toHaveLength(1);
    expect(isoUTC(draftRankingsRows[0].scheduledFor)).toBe("2026-09-02T13:00:00.000Z");
    // Well over an hour out - not the old fixed 60-minute delay.
    expect(draftRankingsRows[0].scheduledFor - triggerMs).toBeGreaterThan(6 * 60 * 60 * 1000);
  });

  it("still applies the configured delayMinutes for a non-draft event (trade_occurred)", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const triggerMs = Date.UTC(2026, 8, 2, 1, 0, 0);
    vi.setSystemTime(new Date(triggerMs));

    const { leagueId } = await seedLeague(t);
    await seedAutomation(t, leagueId);

    await t.action(internal.contentScheduling.triggerEventBasedContent, {
      leagueId,
      eventType: "trade_occurred",
      eventData: { seasonId: SEASON },
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    const tradeRows = rows.filter((r) => r.contentType === "trade_analysis");
    expect(tradeRows).toHaveLength(1);
    // trade_analysis keeps its 30-minute delayMinutes, unaffected by the
    // draft_completed-only next-morning rule.
    expect(tradeRows[0].scheduledFor).toBe(triggerMs + 30 * 60 * 1000);
  });
});

describe("updateLeagueSeason: post-draft follow-up syncs (owner's intent: notice a live draft within hours)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function scheduledSyncTimes(t: TestHarness): Promise<number[]> {
    const jobs = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    return jobs
      .filter((j: { name: string }) => j.name.includes("syncOneLeagueCurrentSeason"))
      .map((j: { scheduledTime: number }) => j.scheduledTime)
      .sort((a: number, b: number) => a - b);
  }

  it("schedules exactly three follow-up syncs at +3h/+8h/+24h around the scheduled draft", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.UTC(2026, 8, 1, 12, 0, 0); // Sept 1 2026 -> nflSeasonYearFor() === 2026
    vi.setSystemTime(new Date(now));

    const { leagueId } = await seedLeague(t);
    const scheduledAt = now + 5 * 24 * 60 * 60 * 1000; // 5 days out

    await t.mutation(internal.espnSync.updateLeagueSeason, {
      leagueId,
      seasonId: SEASON,
      seasonData: {
        settings: REQUIRED_SETTINGS,
        draftSettings: { date: scheduledAt, type: "SNAKE", timePerSelection: 90 },
      },
    });

    const season = await t.run((ctx) =>
      ctx.db
        .query("leagueSeasons")
        .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON))
        .first()
    );
    expect(season?.postDraftSyncScheduledFor).toBe(scheduledAt);

    const times = await scheduledSyncTimes(t);
    expect(times).toEqual([
      scheduledAt + 3 * 60 * 60 * 1000,
      scheduledAt + 8 * 60 * 60 * 1000,
      scheduledAt + 24 * 60 * 60 * 1000,
    ]);
  });

  it("does not schedule duplicates when the routine sync repeats with the same draft date", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    vi.setSystemTime(new Date(now));

    const { leagueId } = await seedLeague(t);
    const scheduledAt = now + 5 * 24 * 60 * 60 * 1000;
    const seasonData = {
      settings: REQUIRED_SETTINGS,
      draftSettings: { date: scheduledAt, type: "SNAKE", timePerSelection: 90 },
    };

    await t.mutation(internal.espnSync.updateLeagueSeason, { leagueId, seasonId: SEASON, seasonData });
    await t.mutation(internal.espnSync.updateLeagueSeason, { leagueId, seasonId: SEASON, seasonData });
    await t.mutation(internal.espnSync.updateLeagueSeason, { leagueId, seasonId: SEASON, seasonData });

    const times = await scheduledSyncTimes(t);
    expect(times).toHaveLength(3);
  });

  it("schedules again when the draft date changes (rescheduled draft)", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    vi.setSystemTime(new Date(now));

    const { leagueId } = await seedLeague(t);
    const firstDate = now + 5 * 24 * 60 * 60 * 1000;
    const secondDate = now + 9 * 24 * 60 * 60 * 1000;

    await t.mutation(internal.espnSync.updateLeagueSeason, {
      leagueId,
      seasonId: SEASON,
      seasonData: { settings: REQUIRED_SETTINGS, draftSettings: { date: firstDate, type: "SNAKE" } },
    });
    await t.mutation(internal.espnSync.updateLeagueSeason, {
      leagueId,
      seasonId: SEASON,
      seasonData: { settings: REQUIRED_SETTINGS, draftSettings: { date: secondDate, type: "SNAKE" } },
    });

    const season = await t.run((ctx) =>
      ctx.db
        .query("leagueSeasons")
        .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON))
        .first()
    );
    expect(season?.postDraftSyncScheduledFor).toBe(secondDate);

    const times = await scheduledSyncTimes(t);
    // Three for the original date, three for the rescheduled one.
    expect(times).toHaveLength(6);
    expect(times).toContain(firstDate + 3 * 60 * 60 * 1000);
    expect(times).toContain(secondDate + 24 * 60 * 60 * 1000);
  });

  it("does not schedule follow-ups once ESPN reports the draft as complete", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    vi.setSystemTime(new Date(now));

    const { leagueId } = await seedLeague(t);
    const scheduledAt = now + 5 * 24 * 60 * 60 * 1000;

    await t.mutation(internal.espnSync.updateLeagueSeason, {
      leagueId,
      seasonId: SEASON,
      seasonData: {
        settings: REQUIRED_SETTINGS,
        draftSettings: { date: scheduledAt, type: "SNAKE" },
        draftInfo: { draftDate: now, draftType: "SNAKE", drafted: true, inProgress: false },
      },
    });

    const times = await scheduledSyncTimes(t);
    expect(times).toHaveLength(0);
  });

  it("does not schedule follow-ups for a scheduled draft date already in the past", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.UTC(2026, 8, 1, 12, 0, 0);
    vi.setSystemTime(new Date(now));

    const { leagueId } = await seedLeague(t);
    const pastDate = now - 24 * 60 * 60 * 1000;

    await t.mutation(internal.espnSync.updateLeagueSeason, {
      leagueId,
      seasonId: SEASON,
      seasonData: { settings: REQUIRED_SETTINGS, draftSettings: { date: pastDate, type: "SNAKE" } },
    });

    const times = await scheduledSyncTimes(t);
    expect(times).toHaveLength(0);
  });
});
