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
  opts?: { balance?: number; lastSyncedAt?: number; subscriptionStatus?: string }
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

  it("stamps lookback content with the week it is about, not the week it runs in", () => {
    // Tuesday-morning recaps execute inside the following NFL week.
    expect(resolveTargetWeek("weekly_recap", 7)).toBe(6);
    expect(resolveTargetWeek("power_rankings", 7)).toBe(6);
    expect(resolveTargetWeek("weekly_preview", 7)).toBe(7);
    expect(resolveTargetWeek("playoff_picture", 13)).toBe(13);
    expect(resolveTargetWeek("weekly_recap", 1)).toBe(1);
  });
});
