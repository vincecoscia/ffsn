import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { espnConnectionBlocked, FRESHNESS_EXEMPT_CONTENT } from "../convex/lib/espnConnection";

const modules = import.meta.glob("../convex/**/*.*s");

/** Mid-October 2026: comfortably inside the seeded 2026 regular season, so
 * the NFL season-boundary gate never interferes with the ESPN connection gate
 * these tests are actually about (see `tests/contentScheduling.test.ts`). */
const IN_SEASON = new Date(2026, 9, 14, 9, 0, 0);

/**
 * Coverage for the owner's directive (Sept 2026): "with no valid private
 * token we should pause all content generation and file a backlog of content
 * that needs to be generated. Reach out for comment articles should NOT reach
 * out for comment for weeks old content and just generate after the key issue
 * has been fixed."
 *
 * Covers: the gate decision itself (`espnConnectionBlocked`), the scheduler
 * gate in `processScheduledContent`, `resumeBacklog`'s ordering/stagger/
 * interview-skip, the `onEspnCredentialsInvalid`/`onEspnCredentialsRestored`
 * pause/resume + notification hooks (called by `espnCredentialLifecycle.ts`
 * with `{ leagueId }`), the interview gates in
 * `contentSchedulingIntegration.onContentScheduled` and
 * `commentRequests.createRequestsForScheduledContent`, and the manual
 * generation gate in `aiContent.createGenerationRequest`.
 */

function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

const CLERK_COMMISSIONER = "clerk_commish_espn_gate";
const SEASON = 2026;

async function seedLeague(
  t: TestHarness,
  opts?: {
    isPrivate?: boolean;
    credentialStatus?: "valid" | "invalid" | "unknown";
    contentPausedAt?: number;
    balance?: number;
  }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "ESPN Gate Test League",
      platform: "espn",
      externalId: "9911",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 6,
        size: 10,
        lastSyncedAt: now,
        isPrivate: opts?.isPrivate ?? false,
        credentialStatus: opts?.credentialStatus,
        contentPausedAt: opts?.contentPausedAt,
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

    const commissionerId = await ctx.db.insert("users", {
      clerkId: CLERK_COMMISSIONER,
      name: "Commish",
      email: "commish@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: CLERK_COMMISSIONER,
      role: "commissioner",
      joinedAt: now,
    });

    for (let i = 1; i <= 10; i++) {
      await ctx.db.insert("teams", {
        leagueId,
        externalId: String(i),
        seasonId: SEASON,
        name: `Team ${i}`,
        owner: `Manager ${i}`,
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

async function seedAutomation(t: TestHarness, leagueId: Awaited<ReturnType<typeof seedLeague>>["leagueId"]) {
  await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
  await t.mutation(internal.contentScheduling.createDefaultContentSchedules, {
    leagueId,
    timezone: "America/New_York",
  });
}

async function seedScheduledRow(
  t: TestHarness,
  leagueId: Awaited<ReturnType<typeof seedLeague>>["leagueId"],
  contentType: string,
  overrides?: Partial<{ scheduledFor: number; status: "pending" | "backlogged"; skipCommentRequests: boolean }>
) {
  return await t.run(async (ctx) => {
    const schedule = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league_type", (q) =>
        q.eq("leagueId", leagueId).eq("contentType", contentType as never)
      )
      .first();

    const now = Date.now();
    const contentScheduleId =
      schedule?._id ??
      (await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: contentType as never,
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
      scheduledFor: overrides?.scheduledFor ?? now,
      status: overrides?.status ?? "pending",
      attempts: 0,
      maxAttempts: 3,
      skipCommentRequests: overrides?.skipCommentRequests,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("espnConnectionBlocked (gate decision)", () => {
  it("blocks only a private league whose stored cookies were rejected", () => {
    expect(
      espnConnectionBlocked({ espnData: { isPrivate: true, credentialStatus: "invalid" } })
    ).toBe(true);
  });

  it("never blocks a public league, even with a stale invalid status", () => {
    expect(
      espnConnectionBlocked({ espnData: { isPrivate: false, credentialStatus: "invalid" } })
    ).toBe(false);
  });

  it("does not block a private league that is unprobed or confirmed valid", () => {
    expect(espnConnectionBlocked({ espnData: { isPrivate: true, credentialStatus: "unknown" } })).toBe(false);
    expect(espnConnectionBlocked({ espnData: { isPrivate: true, credentialStatus: "valid" } })).toBe(false);
    expect(espnConnectionBlocked({ espnData: { isPrivate: true } })).toBe(false);
  });

  it("handles a league with no espnData or no league at all", () => {
    expect(espnConnectionBlocked({ espnData: undefined })).toBe(false);
    expect(espnConnectionBlocked(null)).toBe(false);
    expect(espnConnectionBlocked(undefined)).toBe(false);
  });

  it("freshness-exempt types are never gated, even for a blocked league", () => {
    const blocked = { espnData: { isPrivate: true, credentialStatus: "invalid" as const } };
    expect(espnConnectionBlocked(blocked)).toBe(true);
    for (const exempt of FRESHNESS_EXEMPT_CONTENT) {
      // This is exactly the condition `processScheduledContent` and
      // `aiContent`'s manual-generation gate evaluate.
      expect(!FRESHNESS_EXEMPT_CONTENT.has(exempt) && espnConnectionBlocked(blocked)).toBe(false);
    }
    // A non-exempt type on the same league IS gated.
    expect(!FRESHNESS_EXEMPT_CONTENT.has("weekly_recap") && espnConnectionBlocked(blocked)).toBe(true);
  });
});

describe("processScheduledContent: ESPN connection gate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backlogs a blocked private league's row before any attempt, credit, or sync", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const { leagueId } = await seedLeague(t, { isPrivate: true, credentialStatus: "invalid", balance: 1000 });
    await seedAutomation(t, leagueId);
    const scheduledContentId = await seedScheduledRow(t, leagueId, "trade_analysis");

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/espn/i);

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("backlogged");
    expect(row?.backlogReason).toBe("espn_credentials_invalid");
    expect(row?.backloggedAt).toBeDefined();
    expect(row?.errorMessage).toBeDefined();
    // Nothing was spent chasing this row.
    expect(row?.attempts).toBe(0);

    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .collect()
    );
    expect(transactions).toHaveLength(0);

    const articles = await t.run((ctx) =>
      ctx.db
        .query("aiContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(articles).toHaveLength(0);
  });

  it("does not backlog a public league even with the same rejected-cookie status", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    // Public leagues have no cookies to reject - `isPrivate: false` must never
    // be gated, whatever `credentialStatus` happens to say.
    const { leagueId } = await seedLeague(t, { isPrivate: false, credentialStatus: "invalid" });
    await seedAutomation(t, leagueId);
    const scheduledContentId = await seedScheduledRow(t, leagueId, "trade_analysis");

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).not.toBe("backlogged");
    expect(row?.backlogReason).toBeUndefined();
    // It got far enough to start real generation (League Pass is active).
    expect(result.success).toBe(true);
    expect(result.contentId).toBeDefined();
  });

  it("generates a freshness-exempt type on schedule even when the league is blocked", async () => {
    const t = makeTest();
    // Deliberately no fake timers here: `season_welcome` is itself gated to
    // preseason / the first 2 weeks of the regular season by the (unrelated)
    // NFL season-boundary check that runs before the ESPN gate, so this needs
    // the ambient "today" rather than `IN_SEASON` (which the other two tests
    // in this block use to clear a *different* boundary restriction on
    // `trade_analysis`). What this test actually asserts - that the ESPN gate
    // itself never backlogs a freshness-exempt type - does not depend on it.
    const { leagueId } = await seedLeague(t, { isPrivate: true, credentialStatus: "invalid" });
    await seedAutomation(t, leagueId);
    // season_welcome is freshness-exempt and ships enabled by default.
    const scheduledContentId = await seedScheduledRow(t, leagueId, "season_welcome");

    await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });

    // Whatever else may or may not gate this row (season boundary, data
    // completeness, ...), the ESPN connection gate specifically must never be
    // the reason - that is the one thing `FRESHNESS_EXEMPT_CONTENT` promises.
    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).not.toBe("backlogged");
    expect(row?.backlogReason).toBeUndefined();
    expect(row?.cancelReason).not.toBe("espn_credentials_invalid");
  });
});

describe("resumeBacklog", () => {
  it("resumes oldest-first, staggered 3 minutes apart, skipping interviews only past 48h", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t, { isPrivate: true, credentialStatus: "invalid" });
    const now = Date.now();

    // Seeded out of order on purpose - original scheduledFor must drive the
    // resumed order, not insertion order.
    const recent = await seedScheduledRow(t, leagueId, "power_rankings", {
      status: "backlogged",
      scheduledFor: now - 60 * 60 * 1000, // 1h old
    });
    const oldest = await seedScheduledRow(t, leagueId, "weekly_recap", {
      status: "backlogged",
      scheduledFor: now - 72 * 60 * 60 * 1000, // 72h old - past the 48h cutoff
    });
    const middle = await seedScheduledRow(t, leagueId, "waiver_wire_report", {
      status: "backlogged",
      scheduledFor: now - 6 * 60 * 60 * 1000, // 6h old
    });
    // A pending row must be left untouched.
    const untouched = await seedScheduledRow(t, leagueId, "weekly_preview", { status: "pending" });

    const result = await t.mutation(internal.contentScheduling.resumeBacklog, { leagueId });
    expect(result.resumed).toBe(3);
    expect(result.withoutInterviews).toBe(1);

    const rows = await t.run(async (ctx) => ({
      oldest: await ctx.db.get(oldest),
      middle: await ctx.db.get(middle),
      recent: await ctx.db.get(recent),
      untouched: await ctx.db.get(untouched),
    }));

    for (const key of ["oldest", "middle", "recent"] as const) {
      expect(rows[key]?.status).toBe("pending");
      expect(rows[key]?.resumedAt).toBeDefined();
      expect(rows[key]?.nextRetryAt).toBeUndefined();
    }

    // Oldest original scheduledFor resumes first, then middle, then recent.
    expect(rows.oldest!.scheduledFor).toBeLessThan(rows.middle!.scheduledFor);
    expect(rows.middle!.scheduledFor).toBeLessThan(rows.recent!.scheduledFor);
    // Staggered ~3 minutes apart.
    expect(rows.middle!.scheduledFor - rows.oldest!.scheduledFor).toBe(3 * 60 * 1000);
    expect(rows.recent!.scheduledFor - rows.middle!.scheduledFor).toBe(3 * 60 * 1000);

    // Only the row that was more than 48h past its original print time skips
    // interviews.
    expect(rows.oldest?.skipCommentRequests).toBe(true);
    expect(rows.middle?.skipCommentRequests).toBe(false);
    expect(rows.recent?.skipCommentRequests).toBe(false);

    expect(rows.untouched?.status).toBe("pending");
    expect(rows.untouched?.resumedAt).toBeUndefined();
  });

  it("is a no-op for a league with nothing backlogged", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t);
    const result = await t.mutation(internal.contentScheduling.resumeBacklog, { leagueId });
    expect(result).toEqual({ resumed: 0, withoutInterviews: 0 });
  });
});

describe("onEspnCredentialsInvalid / onEspnCredentialsRestored", () => {
  it("pauses once, counts waiting rows, and notifies the commissioner (deduped same day)", async () => {
    const t = makeTest();
    const { leagueId, commissionerId } = await seedLeague(t, { isPrivate: true, credentialStatus: "invalid" });
    await seedScheduledRow(t, leagueId, "trade_analysis", { status: "pending" });
    await seedScheduledRow(t, leagueId, "weekly_recap", { status: "backlogged" });

    const first = await t.mutation(internal.contentScheduling.onEspnCredentialsInvalid, { leagueId });
    expect(first.pausedNow).toBe(true);
    expect(first.waiting).toBe(2);

    const league = await t.run((ctx) => ctx.db.get(leagueId));
    expect(league?.espnData?.contentPausedAt).toBeDefined();

    // Calling it again the same day must not re-stamp contentPausedAt or send
    // a second notification.
    const pausedAtFirst = league?.espnData?.contentPausedAt;
    const second = await t.mutation(internal.contentScheduling.onEspnCredentialsInvalid, { leagueId });
    expect(second.pausedNow).toBe(false);

    const leagueAfter = await t.run((ctx) => ctx.db.get(leagueId));
    expect(leagueAfter?.espnData?.contentPausedAt).toBe(pausedAtFirst);

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissionerId))
        .collect()
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toMatch(/paused/i);
    expect(notifications[0].actionUrl).toBe(`/leagues/${leagueId}/settings`);
  });

  it("clears the pause, resumes the backlog, and notifies the commissioner with resume counts", async () => {
    const t = makeTest();
    const { leagueId, commissionerId } = await seedLeague(t, {
      isPrivate: true,
      credentialStatus: "valid",
      contentPausedAt: Date.now() - 60 * 60 * 1000,
    });
    const now = Date.now();
    await seedScheduledRow(t, leagueId, "weekly_recap", {
      status: "backlogged",
      scheduledFor: now - 72 * 60 * 60 * 1000,
    });
    await seedScheduledRow(t, leagueId, "power_rankings", {
      status: "backlogged",
      scheduledFor: now - 60 * 60 * 1000,
    });

    const result = await t.mutation(internal.contentScheduling.onEspnCredentialsRestored, { leagueId });
    expect(result.resumed).toBe(2);
    expect(result.withoutInterviews).toBe(1);

    const league = await t.run((ctx) => ctx.db.get(leagueId));
    expect(league?.espnData?.contentPausedAt).toBeUndefined();

    const backlogged = await t.run((ctx) =>
      ctx.db
        .query("scheduledContent")
        .withIndex("by_league_status", (q) => q.eq("leagueId", leagueId).eq("status", "backlogged"))
        .collect()
    );
    expect(backlogged).toHaveLength(0);

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissionerId))
        .collect()
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toMatch(/restored/i);
  });

  it("onEspnCredentialsRestored sends no notification when nothing was backlogged", async () => {
    const t = makeTest();
    const { leagueId, commissionerId } = await seedLeague(t, { isPrivate: true, credentialStatus: "valid" });

    const result = await t.mutation(internal.contentScheduling.onEspnCredentialsRestored, { leagueId });
    expect(result).toEqual({ resumed: 0, withoutInterviews: 0 });

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_user", (q) => q.eq("userId", commissionerId))
        .collect()
    );
    expect(notifications).toHaveLength(0);
  });
});

describe("interview gate: onContentScheduled / createRequestsForScheduledContent", () => {
  it("onContentScheduled skips outreach when the league is blocked", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t, { isPrivate: true, credentialStatus: "invalid" });
    const scheduledContentId = await seedScheduledRow(t, leagueId, "weekly_recap");

    const result = await t.mutation(internal.contentSchedulingIntegration.onContentScheduled, {
      scheduledContentId,
      leagueId,
      contentType: "weekly_recap",
      scheduledTime: Date.now() + 60 * 60 * 1000,
      writerPersona: "curtis-vaughn",
    });

    expect(result).toEqual({ scheduled: false, reason: "espn_connection_blocked" });
  });

  it("createRequestsForScheduledContent refuses a blocked league, a skip-flagged row, and a non-pending row", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t, { isPrivate: true, credentialStatus: "invalid" });
    const blockedRow = await seedScheduledRow(t, leagueId, "weekly_recap");

    const blocked = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: blockedRow,
      targetUserIds: [],
    });
    expect(blocked).toEqual({ created: false, reason: "espn_connection_blocked" });

    // Same league, now unblocked, but the row itself is flagged to skip.
    const { leagueId: openLeagueId } = await seedLeague(t, { isPrivate: false });
    const skipRow = await seedScheduledRow(t, openLeagueId, "weekly_recap", { skipCommentRequests: true });
    const skipped = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: skipRow,
      targetUserIds: [],
    });
    expect(skipped).toEqual({ created: false, reason: "skip_comment_requests" });

    const doneRow = await seedScheduledRow(t, openLeagueId, "power_rankings");
    await t.run((ctx) => ctx.db.patch(doneRow, { status: "completed" }));
    const notPending = await t.mutation(internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: doneRow,
      targetUserIds: [],
    });
    expect(notPending).toEqual({ created: false, reason: "row_not_pending" });
  });
});

describe("manual generation gate: createGenerationRequest", () => {
  it("throws ESPN_CONNECTION_BROKEN for a blocked private league, before any credit is spent", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t, { isPrivate: true, credentialStatus: "invalid" });
    // Deliberately no userCredits row - if the gate did not run first, this
    // would fail on "Insufficient credits" instead, which would be the wrong
    // diagnosis for the same symptom.

    await expect(
      t.withIdentity({ subject: CLERK_COMMISSIONER }).mutation(api.aiContent.createGenerationRequest, {
        leagueId,
        type: "weekly_recap",
        persona: "curtis-vaughn",
      })
    ).rejects.toThrow(/ESPN_CONNECTION_BROKEN/);

    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .collect()
    );
    expect(transactions).toHaveLength(0);
  });

  it("does not throw ESPN_CONNECTION_BROKEN for a freshness-exempt type on the same blocked league", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t, {
      isPrivate: true,
      credentialStatus: "invalid",
      balance: 1000,
    });

    const articleId = await t
      .withIdentity({ subject: CLERK_COMMISSIONER })
      .mutation(api.aiContent.createGenerationRequest, {
        leagueId,
        type: "season_welcome",
        persona: "curtis-vaughn",
      });
    expect(articleId).toBeDefined();

    // It ran the whole way through, including the credit deduction the ESPN
    // gate would have pre-empted.
    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .collect()
    );
    expect(transactions).toHaveLength(1);
  });

  it("does not throw ESPN_CONNECTION_BROKEN for a non-exempt type on a public league", async () => {
    const t = makeTest();
    const { leagueId } = await seedLeague(t, {
      isPrivate: false,
      credentialStatus: "invalid",
      balance: 1000,
    });

    const articleId = await t
      .withIdentity({ subject: CLERK_COMMISSIONER })
      .mutation(api.aiContent.createGenerationRequest, {
        leagueId,
        type: "weekly_recap",
        persona: "curtis-vaughn",
      });
    expect(articleId).toBeDefined();
  });
});
