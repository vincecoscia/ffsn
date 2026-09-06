import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import type { Doc } from "../convex/_generated/dataModel";
import { internal } from "../convex/_generated/api";
import {
  DEFAULT_SCHEDULES,
  convertTimeZoneToUTC,
  nextOccurrenceUtc,
  resolveTargetWeek,
} from "../convex/contentScheduling";
import { contentTypePersonaMap } from "../src/lib/ai/persona-prompts";

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * `convexTest` bound to this app's schema. Helpers take this rather than the
 * bare `ReturnType<typeof convexTest>`, which loses the schema's index names.
 */
function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

const CLERK_COMMISSIONER = "clerk_commish_auto_a";
const SEASON = 2026;

/** Mid-October 2026: comfortably inside the seeded 2026 regular season. */
const IN_SEASON = new Date(2026, 9, 14, 9, 0, 0);

function isoUTC(ms: number): string {
  return new Date(ms).toISOString();
}

async function seedLeague(
  t: TestHarness,
  opts?: { balance?: number; lastSyncedAt?: number; subscriptionStatus?: string; teams?: number }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Automatic Defaults Test League",
      platform: "espn",
      externalId: "7788",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 6,
        size: 10,
        lastSyncedAt: opts?.lastSyncedAt ?? now,
        isPrivate: false,
      },
      subscription: {
        tier: "season_pass",
        status: opts?.subscriptionStatus ?? "active",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "completed",
        seasonYear: SEASON,
      },
      lastSync: now,
      createdAt: now,
    });

    const commissionerId = await ctx.db.insert("users", {
      clerkId: CLERK_COMMISSIONER,
      name: "Commish",
      email: "commish@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    // Every real league has teams. The data-completeness gate (spec §11.1.2)
    // reads them, and a league with none is not a state the pipeline should
    // treat as writable - so the fixture has them too.
    for (let i = 1; i <= (opts?.teams ?? 10); i++) {
      await ctx.db.insert("teams", {
        leagueId,
        externalId: String(i),
        seasonId: SEASON,
        name: `Team ${i}`,
        owner: `Manager ${i}`,
        abbreviation: `T${i}`,
        record: { wins: 3, losses: 2, ties: 0, pointsFor: 600 + i, pointsAgainst: 590 + i },
        roster: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    if (opts?.balance !== undefined) {
      await ctx.db.insert("userCredits", {
        userId: CLERK_COMMISSIONER,
        balance: opts.balance,
        totalEarned: opts.balance,
        totalSpent: 0,
        totalPurchased: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { leagueId, commissionerId };
  });
}

/**
 * Seed the season boundaries and the automatic-by-default calendar (including
 * the `leagueContentPreferences` row `processScheduledContent` gates on).
 */
async function seedAutomation(
  t: TestHarness,
  leagueId: Awaited<ReturnType<typeof seedLeague>>["leagueId"]
) {
  await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
  await t.mutation(internal.contentScheduling.createDefaultContentSchedules, {
    leagueId,
    timezone: "America/New_York",
  });
}

/** One pending scheduled row for a league, on that league's own schedule config. */
async function seedScheduledRow(
  t: TestHarness,
  leagueId: Awaited<ReturnType<typeof seedLeague>>["leagueId"],
  contentType: Doc<"contentSchedules">["contentType"]
) {
  return await t.run(async (ctx) => {
    const schedule = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league_type", (q) =>
        q.eq("leagueId", leagueId).eq("contentType", contentType)
      )
      .first();

    const now = Date.now();
    const contentScheduleId =
      schedule?._id ??
      (await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType,
        enabled: true,
        timezone: "America/New_York",
        schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 },
        preferredPersona: "dex-alvarez",
        createdAt: now,
        updatedAt: now,
      }));

    return await ctx.db.insert("scheduledContent", {
      leagueId,
      contentScheduleId,
      contentType,
      scheduledFor: now,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("timezone conversion (spec 9.2.1)", () => {
  it("resolves Tuesday 09:00 America/New_York across the DST boundary", () => {
    // Summer (EDT, UTC-4) -> 13:00Z. Wednesday July 1 2026 is the `from`, so the
    // next Tuesday is July 7.
    const july = nextOccurrenceUtc(2, "09:00", "America/New_York", Date.UTC(2026, 6, 1, 12, 0));
    expect(isoUTC(july)).toBe("2026-07-07T13:00:00.000Z");

    // Winter (EST, UTC-5) -> 14:00Z.
    const january = nextOccurrenceUtc(2, "09:00", "America/New_York", Date.UTC(2026, 0, 1, 12, 0));
    expect(isoUTC(january)).toBe("2026-01-06T14:00:00.000Z");
  });

  it("resolves Tuesday 09:00 America/Los_Angeles across the DST boundary", () => {
    const july = nextOccurrenceUtc(2, "09:00", "America/Los_Angeles", Date.UTC(2026, 6, 1, 12, 0));
    expect(isoUTC(july)).toBe("2026-07-07T16:00:00.000Z");

    const january = nextOccurrenceUtc(2, "09:00", "America/Los_Angeles", Date.UTC(2026, 0, 1, 12, 0));
    expect(isoUTC(january)).toBe("2026-01-06T17:00:00.000Z");
  });

  it("leaves UTC alone in both halves of the year", () => {
    expect(isoUTC(nextOccurrenceUtc(2, "09:00", "UTC", Date.UTC(2026, 6, 1, 12, 0))))
      .toBe("2026-07-07T09:00:00.000Z");
    expect(isoUTC(nextOccurrenceUtc(2, "09:00", "UTC", Date.UTC(2026, 0, 1, 12, 0))))
      .toBe("2026-01-06T09:00:00.000Z");
  });

  it("round-trips a wall clock through the offset solve", () => {
    // 09:00 on Tuesday July 7 2026, expressed as a zoned wall clock.
    const wall = new Date(2026, 6, 7, 9, 0, 0, 0);
    expect(isoUTC(convertTimeZoneToUTC(wall, "America/New_York").getTime()))
      .toBe("2026-07-07T13:00:00.000Z");
    expect(isoUTC(convertTimeZoneToUTC(wall, "UTC").getTime()))
      .toBe("2026-07-07T09:00:00.000Z");
  });

  it("falls back to UTC rather than throwing on an unknown timezone", () => {
    const wall = new Date(2026, 6, 7, 9, 0, 0, 0);
    expect(isoUTC(convertTimeZoneToUTC(wall, "Not/AZone").getTime()))
      .toBe("2026-07-07T09:00:00.000Z");
  });
});

describe("default content calendar (spec 9.1)", () => {
  it("creates every schedule with its roster writer and the right enabled flags", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);

    const result = await t.mutation(internal.contentScheduling.createDefaultContentSchedules, {
      leagueId,
      timezone: "America/Chicago",
    });
    expect(result.success).toBe(true);

    const schedules = await t.run((ctx) =>
      ctx.db
        .query("contentSchedules")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );

    const byType = new Map(schedules.map((s) => [s.contentType as string, s]));
    expect(schedules).toHaveLength(Object.keys(DEFAULT_SCHEDULES).length);

    // Nothing carries the retired "analyst" placeholder, and every row gets the
    // content type's first-choice writer from the roster.
    for (const schedule of schedules) {
      expect(schedule.preferredPersona).not.toBe("analyst");
      expect(schedule.preferredPersona).toBe(contentTypePersonaMap[schedule.contentType]?.[0]);
      expect(schedule.timezone).toBe("America/Chicago");
    }

    expect(byType.get("weekly_recap")?.preferredPersona).toBe("curtis-vaughn");
    expect(byType.get("power_rankings")?.preferredPersona).toBe("nina-sharpe");
    expect(byType.get("trade_analysis")?.preferredPersona).toBe("dex-alvarez");
    expect(byType.get("draft_rankings")?.preferredPersona).toBe("mel-diaper");

    // The §9.1 calendar times.
    expect(byType.get("weekly_recap")?.schedule).toMatchObject({ type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 });
    expect(byType.get("power_rankings")?.schedule).toMatchObject({ type: "weekly", dayOfWeek: 3, hour: 9 });
    expect(byType.get("waiver_wire_report")?.schedule).toMatchObject({ type: "weekly", dayOfWeek: 3, hour: 12 });
    expect(byType.get("weekly_preview")?.schedule).toMatchObject({ type: "weekly", dayOfWeek: 4, hour: 9 });
    expect(byType.get("trade_analysis")?.schedule).toMatchObject({ type: "event_triggered", delayMinutes: 30 });
    expect(byType.get("draft_rankings")?.schedule).toMatchObject({ type: "event_triggered", delayMinutes: 60 });

    // On by default.
    for (const type of [
      "season_welcome", "weekly_recap", "power_rankings", "waiver_wire_report", "weekly_preview",
      "trade_analysis", "draft_rankings", "mid_season_awards", "playoff_picture", "season_recap",
    ]) {
      expect(byType.get(type)?.enabled).toBe(true);
    }

    // Created disabled, so the commissioner can switch them on without us
    // inventing a schedule row later.
    for (const type of [
      "championship_manifesto", "rivalry_week_special", "emergency_hot_takes",
      "custom_roast", "mock_draft", "hall_of_shame", "commissioner_corner",
    ]) {
      expect(byType.get(type)?.enabled).toBe(false);
    }
  });

  it("writes automatic-by-default preferences that no commissioner has touched", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);

    await t.mutation(internal.contentScheduling.createDefaultContentSchedules, {
      leagueId,
      timezone: "Europe/London",
    });

    const preferences = await t.run((ctx) =>
      ctx.db
        .query("leagueContentPreferences")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .first()
    );

    expect(preferences).toMatchObject({
      contentEnabled: true,
      autoPublish: true,
      requireApproval: false,
      notifyCommissioner: true,
      notifyFailures: true,
      timezone: "Europe/London",
    });
    expect(preferences?.preferencesTouchedAt).toBeUndefined();
  });

  it("applyAutomaticDefaults migrates untouched rows and stale personas, and skips touched ones", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);
    const other = await t.run(async (ctx) => {
      const now = Date.now();
      const otherLeagueId = await ctx.db.insert("leagues", {
        name: "Already Configured League",
        platform: "espn",
        externalId: "7789",
        commissionerUserId: "clerk_other",
        settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
        subscription: {
          tier: "season_pass", status: "paid", creditsRemaining: 0, creditsMonthly: 0,
          paymentStatus: "completed", seasonYear: SEASON,
        },
        lastSync: now,
        createdAt: now,
      });

      // Legacy row: opt-in defaults, stale persona, never migrated.
      await ctx.db.insert("leagueContentPreferences", {
        leagueId,
        contentEnabled: false,
        timezone: "America/New_York",
        currentMonthSpent: 0,
        budgetResetDate: now,
        notifyCommissioner: false,
        notifyFailures: false,
        autoPublish: false,
        requireApproval: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: "weekly_recap",
        enabled: true,
        timezone: "America/New_York",
        schedule: { type: "weekly", dayOfWeek: 2, hour: 11, minute: 0 },
        preferredPersona: "analyst",
        createdAt: now,
        updatedAt: now,
      });

      // A commissioner who deliberately turned content off must stay off.
      await ctx.db.insert("leagueContentPreferences", {
        leagueId: otherLeagueId,
        contentEnabled: false,
        timezone: "America/Denver",
        currentMonthSpent: 0,
        budgetResetDate: now,
        notifyCommissioner: false,
        notifyFailures: false,
        autoPublish: false,
        requireApproval: true,
        preferencesTouchedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      return { otherLeagueId };
    });

    const migrated = await t.mutation(internal.contentScheduling.applyAutomaticDefaults, {});
    expect(migrated.isDone).toBe(true);
    expect(migrated.preferencesUpdated).toBe(1);
    expect(migrated.schedulesUpdated).toBe(1);

    const [untouched, touched, schedule] = await t.run(async (ctx) => [
      await ctx.db
        .query("leagueContentPreferences")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .first(),
      await ctx.db
        .query("leagueContentPreferences")
        .withIndex("by_league", (q) => q.eq("leagueId", other.otherLeagueId))
        .first(),
      await ctx.db
        .query("contentSchedules")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .first(),
    ]);

    expect(untouched).toMatchObject({
      contentEnabled: true, autoPublish: true, requireApproval: false,
      notifyCommissioner: true, notifyFailures: true,
    });
    expect(touched).toMatchObject({ contentEnabled: false, autoPublish: false });
    expect(schedule?.preferredPersona).toBe("curtis-vaughn");
  });
});

describe("scheduling correctness (spec 9.2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a second weekly cron pass creates no duplicate row for the same league/type/season/week", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const { leagueId } = await seedLeague(t);
    await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
    await t.mutation(internal.contentScheduling.createDefaultContentSchedules, {
      leagueId,
      timezone: "America/New_York",
    });

    const first = await t.action(internal.contentScheduling.scheduleWeeklyContentCron, {});
    expect(first.scheduled).toBeGreaterThan(0);

    const afterFirst = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );

    // Every row carries the period it will be written for, which is what the
    // idempotency index keys on.
    for (const row of afterFirst) {
      expect(row.week).toBeGreaterThan(0);
      expect(row.seasonId).toBe(SEASON);
    }

    const second = await t.action(internal.contentScheduling.scheduleWeeklyContentCron, {});
    expect(second.scheduled).toBe(0);

    const afterSecond = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(afterSecond).toHaveLength(afterFirst.length);

    // One row per enabled weekly content type, no more.
    const recaps = afterSecond.filter((r) => r.contentType === "weekly_recap");
    expect(recaps).toHaveLength(1);
  });

  it("cancels with cancelReason no_pass when the League Pass is not active", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    // A commissioner with plenty of credits: under the pass model credits are
    // irrelevant to automated content, and only the pass decides.
    const { leagueId, commissionerId } = await seedLeague(t, {
      balance: 1000,
      subscriptionStatus: "pending",
    });
    await seedAutomation(t, leagueId);
    const scheduledContentId = await seedScheduledRow(t, leagueId, "trade_analysis");

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/League Pass is not active/);

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelReason).toBe("no_pass");
    // The period was re-stamped before the gate ran.
    expect(row?.seasonId).toBe(SEASON);
    expect(row?.week).toBeGreaterThan(0);

    // Nothing was charged - that is the whole point of the pass.
    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .collect()
    );
    expect(transactions).toHaveLength(0);

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissionerId))
        .collect()
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toMatch(/League Pass/i);

    // One notice per league, however many rows come due while it is lapsed.
    await t.mutation(internal.contentScheduling.notifyScheduleOutcome, {
      leagueId,
      outcome: "no_pass",
      contentType: "power_rankings",
      week: row?.week,
    });
    const afterRepeat = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissionerId))
        .collect()
    );
    expect(afterRepeat).toHaveLength(1);
  });

  it("cancels with cancelReason spend_cap once the season's automated spend is used up", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const { leagueId, commissionerId } = await seedLeague(t, { balance: 1000 });
    await seedAutomation(t, leagueId);

    // $60 of pass-funded articles and interviews: past the $60 default cap.
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("aiContent", {
          leagueId,
          type: "weekly_recap",
          persona: "curtis-vaughn",
          title: `Filed story ${i}`,
          content: "Body copy.",
          metadata: { week: i + 1, featured_teams: [], credits_used: 0 },
          status: "published",
          createdAt: now - (3 - i) * 24 * 60 * 60 * 1000,
          seasonId: SEASON,
          generationStats: {
            blocks: 0,
            strips: 0,
            warns: 0,
            sectionsRegenerated: 0,
            costUsd: 20,
            billing: "pass",
          },
        });
      }
      // A manual article does NOT count against the automation cap.
      await ctx.db.insert("aiContent", {
        leagueId,
        type: "custom_roast",
        persona: "walt-brennan",
        title: "Somebody paid for this one",
        content: "Body copy.",
        metadata: { week: 3, featured_teams: [], credits_used: 30 },
        status: "published",
        createdAt: now,
        seasonId: SEASON,
        generationStats: {
          blocks: 0,
          strips: 0,
          warns: 0,
          sectionsRegenerated: 0,
          costUsd: 40,
          billing: "credits",
        },
      });
    });

    const scheduledContentId = await seedScheduledRow(t, leagueId, "trade_analysis");

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/spend cap/i);

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelReason).toBe("spend_cap");

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissionerId))
        .collect()
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toMatch(/paused/i);

    // The roll-up itself: automated and manual spend are kept apart, and only
    // the automated half is measured against the cap.
    const spend = await t.query(internal.deskMetrics.getLeagueSeasonSpend, {
      leagueId,
      seasonId: SEASON,
    });
    expect(spend.automatedUsd).toBeCloseTo(60, 4);
    expect(spend.manualUsd).toBeCloseTo(40, 4);
    expect(spend.totalUsd).toBeCloseTo(100, 4);
  });

  it("generates directly when the pass is live and the league is under the cap", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const { leagueId } = await seedLeague(t, { balance: 0 });
    await seedAutomation(t, leagueId);
    const scheduledContentId = await seedScheduledRow(t, leagueId, "trade_analysis");

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });
    expect(result.success).toBe(true);
    expect(result.contentId).toBeDefined();

    // A zero balance is fine: the pass paid for this one.
    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .collect()
    );
    expect(transactions).toHaveLength(0);
  });

  it("hands a row with hours to spare to the batch API instead of generating it", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const { leagueId } = await seedLeague(t);
    await seedAutomation(t, leagueId);

    // Print is two and a half hours out: comfortably inside the batch window.
    const printAt = Date.now() + 2.5 * 60 * 60 * 1000;
    const scheduledContentId = await seedScheduledRow(t, leagueId, "trade_analysis");
    await t.run((ctx) => ctx.db.patch(scheduledContentId, { scheduledFor: printAt }));

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Batch submission scheduled/);
    // Nothing was generated: no article, no attempt spent.
    expect(result.contentId).toBeUndefined();

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    // Back to pending so `aiBatch.submitScheduledArticle` will accept it, and
    // so the due-now pass writes it directly if the batch never lands.
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    // Latched, so the next lookahead pass does not queue a second submission.
    expect(row?.batchSubmittedAt).toBeDefined();

    const articles = await t.run((ctx) =>
      ctx.db
        .query("aiContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(articles).toHaveLength(0);
  });

  it("releases a batch that has not come back by print time", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);
    const overdue = await seedScheduledRow(t, leagueId, "trade_analysis");
    const upcoming = await seedScheduledRow(t, leagueId, "power_rankings");

    await t.run(async (ctx) => {
      await ctx.db.patch(overdue, {
        status: "batched",
        scheduledFor: Date.now() - 60 * 1000,
        batchId: "msgbatch_overdue",
      });
      await ctx.db.patch(upcoming, {
        status: "batched",
        scheduledFor: Date.now() + 60 * 60 * 1000,
        batchId: "msgbatch_upcoming",
      });
    });

    expect(await t.mutation(internal.contentScheduling.releaseDueBatchRows, {})).toEqual({
      released: 1,
    });

    const rows = await t.run(async (ctx) => ({
      overdue: await ctx.db.get(overdue),
      upcoming: await ctx.db.get(upcoming),
    }));
    // The overdue one rejoins the direct queue; the one still in its window is
    // left for `aiBatch.pollBatches`.
    expect(rows.overdue?.status).toBe("pending");
    expect(rows.upcoming?.status).toBe("batched");
  });

  it("the sweeper requeues a stalled generation and fails one that is out of attempts", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);

    const { retryable, exhausted, recent } = await t.run(async (ctx) => {
      const now = Date.now();
      const schedule = await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: "weekly_recap",
        enabled: true,
        timezone: "America/New_York",
        schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 },
        preferredPersona: "curtis-vaughn",
        createdAt: now,
        updatedAt: now,
      });

      const base = {
        leagueId,
        contentScheduleId: schedule,
        contentType: "weekly_recap",
        scheduledFor: now - 3 * 60 * 60 * 1000,
        status: "generating" as const,
        maxAttempts: 3,
        createdAt: now - 3 * 60 * 60 * 1000,
        updatedAt: now - 3 * 60 * 60 * 1000,
      };

      return {
        // Stuck for three hours with retries left.
        retryable: await ctx.db.insert("scheduledContent", {
          ...base,
          attempts: 0,
          lastAttemptAt: now - 3 * 60 * 60 * 1000,
        }),
        // Stuck for three hours and out of retries.
        exhausted: await ctx.db.insert("scheduledContent", {
          ...base,
          attempts: 2,
          lastAttemptAt: now - 3 * 60 * 60 * 1000,
        }),
        // Started ten minutes ago: still legitimately running, leave it alone.
        recent: await ctx.db.insert("scheduledContent", {
          ...base,
          attempts: 0,
          lastAttemptAt: now - 10 * 60 * 1000,
        }),
      };
    });

    const swept = await t.mutation(internal.contentScheduling.reclaimStuckGenerations, {});
    expect(swept).toEqual({ reclaimed: 1, failed: 1 });

    const rows = await t.run(async (ctx) => ({
      retryable: await ctx.db.get(retryable),
      exhausted: await ctx.db.get(exhausted),
      recent: await ctx.db.get(recent),
    }));

    expect(rows.retryable?.status).toBe("pending");
    expect(rows.retryable?.attempts).toBe(1);
    expect(rows.retryable?.nextRetryAt).toBeDefined();
    expect(rows.exhausted?.status).toBe("failed");
    expect(rows.exhausted?.attempts).toBe(3);
    expect(rows.recent?.status).toBe("generating");
  });

  it("cancels with cancelReason out_of_season for a weekly type whose target week is past the league's season end, with no commissioner notification", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // NFL week 19 (still PLAYOFFS phase, so the NFL-boundary gate lets it
    // through) - weekly_recap's lookback resolves this to target week 18,
    // one past the 17-week fallback season end (no leagueSeasons row is
    // seeded here, so resolveSeasonEndWeek falls back to 17).
    vi.setSystemTime(new Date(2027, 0, 17, 12, 0, 0));

    const { leagueId, commissionerId } = await seedLeague(t);
    await seedAutomation(t, leagueId);
    const scheduledContentId = await seedScheduledRow(t, leagueId, "weekly_recap");

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Not in season/);

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelReason).toBe("out_of_season");
    // Re-stamped before the season-window check ran.
    expect(row?.week).toBe(18);

    // Expected, not a failure - the commissioner hears nothing about it.
    const notifications = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissionerId))
        .collect()
    );
    expect(notifications).toHaveLength(0);
  });

  it("stamps lookback content with the week it is about, not the week it runs in", () => {
    // Tuesday-morning recaps execute inside the following NFL week.
    expect(resolveTargetWeek("weekly_recap", 7)).toBe(6);
    expect(resolveTargetWeek("power_rankings", 7)).toBe(6);
    expect(resolveTargetWeek("weekly_preview", 7)).toBe(7);
    expect(resolveTargetWeek("playoff_picture", 13)).toBe(13);
    expect(resolveTargetWeek("weekly_recap", 1)).toBe(1);
  });
});

describe("season backfill rows never notify (owner directive, Sept 2026)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels with cancelReason no_pass but sends no commissioner notification for a backfill row", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const { leagueId, commissionerId } = await seedLeague(t, { subscriptionStatus: "pending" });
    await seedAutomation(t, leagueId);
    const scheduledContentId = await seedScheduledRow(t, leagueId, "trade_analysis");
    await t.run((ctx) => ctx.db.patch(scheduledContentId, { backfill: true }));

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });
    expect(result.success).toBe(false);

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelReason).toBe("no_pass");

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissionerId))
        .collect()
    );
    expect(notifications).toHaveLength(0);
  });

  it("getPendingScheduledContent, reclaimStuckGenerations and releaseDueBatchRows all ignore backfill rows", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);
    const backfillId = await seedScheduledRow(t, leagueId, "weekly_recap");
    const normalId = await seedScheduledRow(t, leagueId, "power_rankings");
    await t.run((ctx) => ctx.db.patch(backfillId, { backfill: true }));

    const pending = await t.query(internal.contentScheduling.getPendingScheduledContent, {});
    const pendingIds = pending.map((row) => row._id);
    expect(pendingIds).toContain(normalId);
    expect(pendingIds).not.toContain(backfillId);

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(backfillId, { status: "generating", lastAttemptAt: now - 3 * 60 * 60 * 1000 });
      await ctx.db.patch(normalId, { status: "generating", lastAttemptAt: now - 3 * 60 * 60 * 1000 });
    });
    const swept = await t.mutation(internal.contentScheduling.reclaimStuckGenerations, {});
    expect(swept.reclaimed).toBe(1); // only the non-backfill row
    const rows = await t.run(async (ctx) => ({
      backfill: await ctx.db.get(backfillId),
      normal: await ctx.db.get(normalId),
    }));
    expect(rows.backfill?.status).toBe("generating"); // untouched
    expect(rows.normal?.status).toBe("pending");

    await t.run(async (ctx) => {
      const dueAt = Date.now() - 1000;
      await ctx.db.patch(backfillId, { status: "batched", scheduledFor: dueAt });
      await ctx.db.patch(normalId, { status: "batched", scheduledFor: dueAt });
    });
    const released = await t.mutation(internal.contentScheduling.releaseDueBatchRows, {});
    expect(released.released).toBe(1); // only the non-backfill row
    const afterRelease = await t.run(async (ctx) => ({
      backfill: await ctx.db.get(backfillId),
      normal: await ctx.db.get(normalId),
    }));
    expect(afterRelease.backfill?.status).toBe("batched"); // untouched
    expect(afterRelease.normal?.status).toBe("pending");
  });
});

describe("season_welcome NFL-boundary gap fix (spec: audit finding)", () => {
  it("allows season_welcome in the gap between preseason end and regular season start (2026: Sep 9 09:00 local)", async () => {
    const t = makeTest();
    await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
    const { leagueId } = await seedLeague(t);

    const result = await t.query(internal.nflSeasonBoundaries.isContentGenerationAllowed, {
      contentType: "season_welcome",
      leagueId,
      date: new Date(2026, 8, 9, 9, 0, 0).getTime(),
    });
    expect(result.allowed).toBe(true);
  });

  it("still refuses season_welcome well before the kickoff lookahead window", async () => {
    const t = makeTest();
    await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
    const { leagueId } = await seedLeague(t);

    const result = await t.query(internal.nflSeasonBoundaries.isContentGenerationAllowed, {
      contentType: "season_welcome",
      leagueId,
      date: new Date(2026, 5, 1).getTime(), // June 1: well before preseason even starts
    });
    expect(result.allowed).toBe(false);
  });
});

describe("kickOffSeasonWelcome (spec: season kickoff every season, covered by the pass)", () => {
  it("creates a system-billed article the first time, and is a no-op the second", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);

    const first = await t.mutation(internal.contentScheduling.kickOffSeasonWelcome, {
      leagueId,
      seasonId: SEASON,
    });
    expect(first.started).toBe(true);
    expect(first.reason).toBeUndefined();

    const articles = await t.run((ctx) =>
      ctx.db.query("aiContent").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(articles).toHaveLength(1);
    expect(articles[0].type).toBe("season_welcome");
    // Billed to the pass, not a manager's credits.
    expect(articles[0].metadata.credits_used).toBe(0);

    const second = await t.mutation(internal.contentScheduling.kickOffSeasonWelcome, {
      leagueId,
      seasonId: SEASON,
    });
    expect(second.started).toBe(false);
    expect(second.reason).toMatch(/already/);

    const articlesAfter = await t.run((ctx) =>
      ctx.db.query("aiContent").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(articlesAfter).toHaveLength(1);
  });

  it("goes through the scheduled-row + interview path when a manager has claimed a team, instead of printing five seconds later", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);
    await seedAutomation(t, leagueId); // seeds the DEFAULT_SCHEDULES rows, including season_welcome's

    await t.run(async (ctx) => {
      const now = Date.now();
      const team = await ctx.db
        .query("teams")
        .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", SEASON))
        .first();
      await ctx.db.insert("users", {
        clerkId: "clerk_kickoff_claimed_manager",
        name: "Claimed Manager",
        hasCompletedOnboarding: true,
        createdAt: now,
        lastActiveAt: now,
      });
      await ctx.db.insert("teamClaims", {
        leagueId,
        teamId: team!._id,
        seasonId: SEASON,
        userId: "clerk_kickoff_claimed_manager",
        status: "active",
        credits: 0,
        createdAt: now,
      });
    });

    const before = Date.now();
    const result = await t.mutation(internal.contentScheduling.kickOffSeasonWelcome, {
      leagueId,
      seasonId: SEASON,
    });
    expect(result.started).toBe(true);

    // No article yet - it only prints once the interview window has run.
    const articles = await t.run((ctx) =>
      ctx.db.query("aiContent").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(articles).toHaveLength(0);

    const scheduledRows = await t.run((ctx) =>
      ctx.db.query("scheduledContent").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(scheduledRows).toHaveLength(1);
    expect(scheduledRows[0]).toMatchObject({ contentType: "season_welcome", status: "pending" });
    // Created for "now" - `createRequestsForScheduledContent` (queued below, not run here) is
    // what pushes `scheduledFor` out to now + the 24h interview window once it actually sends
    // the requests (convex/lib/interviewees.ts / commentRequests.ts's print-time alignment).
    expect(scheduledRows[0].scheduledFor).toBeGreaterThanOrEqual(before);
    expect(scheduledRows[0].scheduledFor).toBeLessThan(before + 60 * 1000);

    // `onContentScheduled` queues the interview request synchronously (it's a nested mutation,
    // not itself scheduled); only the resulting `createRequestsForScheduledContent` call is on
    // the scheduler. Inspecting the queue rather than running it keeps this test from cascading
    // into `sendInitialRequests`' real AI call.
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const queuedInterview = jobs.find((j: { name: string }) => j.name.includes("createRequestsForScheduledContent"));
    expect(queuedInterview).toBeDefined();
  });
});

describe("reconcileDefaultContentSchedules (spec: audit finding - stale calendars)", () => {
  it("adds only the DEFAULT_SCHEDULES types a league is missing, never touching an existing row's enabled flag or times", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);

    // Simulate an old default set: only two of the current DEFAULT_SCHEDULES
    // types exist, and one of them was hand-edited by the commissioner
    // (moved earlier, switched off) - reconcile must leave it exactly alone.
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: "weekly_recap",
        enabled: false,
        timezone: "America/Chicago",
        schedule: { type: "weekly", dayOfWeek: 1, hour: 7, minute: 30 },
        preferredPersona: "curtis-vaughn",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: "draft_rankings",
        enabled: true,
        timezone: "America/Chicago",
        schedule: { type: "event_triggered", trigger: "draft_completed", delayMinutes: 60 },
        preferredPersona: "mel-diaper",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("leagueContentPreferences", {
        leagueId,
        contentEnabled: true,
        timezone: "America/Chicago",
        notifyCommissioner: true,
        notifyFailures: true,
        autoPublish: true,
        requireApproval: false,
        currentMonthSpent: 0,
        budgetResetDate: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.mutation(internal.contentScheduling.reconcileDefaultContentSchedules, {
      leagueId,
    });

    expect(result.leaguesChecked).toBe(1);
    expect(result.isDone).toBe(true);
    expect(result.added).toHaveLength(Object.keys(DEFAULT_SCHEDULES).length - 2);
    expect(result.added.some((a) => a.contentType === "weekly_recap")).toBe(false);
    expect(result.added.some((a) => a.contentType === "draft_rankings")).toBe(false);
    expect(result.added.some((a) => a.contentType === "playoff_picture" && a.enabled === true)).toBe(true);

    const schedules = await t.run((ctx) =>
      ctx.db.query("contentSchedules").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(schedules).toHaveLength(Object.keys(DEFAULT_SCHEDULES).length);

    const recap = schedules.find((s) => s.contentType === "weekly_recap");
    expect(recap?.enabled).toBe(false);
    expect(recap?.schedule).toMatchObject({ dayOfWeek: 1, hour: 7, minute: 30 });

    const playoffPicture = schedules.find((s) => s.contentType === "playoff_picture");
    expect(playoffPicture?.timezone).toBe("America/Chicago");
    expect(playoffPicture?.preferredPersona).toBe(contentTypePersonaMap["playoff_picture"]?.[0]);
  });

  it("dryRun reports what would be added without writing anything", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);

    const result = await t.mutation(internal.contentScheduling.reconcileDefaultContentSchedules, {
      leagueId,
      dryRun: true,
    });
    expect(result.added).toHaveLength(Object.keys(DEFAULT_SCHEDULES).length);

    const schedules = await t.run((ctx) =>
      ctx.db.query("contentSchedules").withIndex("by_league", (q) => q.eq("leagueId", leagueId)).collect()
    );
    expect(schedules).toHaveLength(0);
  });
});
