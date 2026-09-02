import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { contentTemplates } from "../src/lib/ai/content-templates";
import { creditCostFor, INTERVIEW_CREDITS_PER_MANAGER } from "../convex/credits";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2025;
const CLERK_COMMISSIONER = "clerk_commissioner_finalize";
const CLERK_MEMBER = "clerk_member_finalize";

/**
 * `scheduledContent.cancelReason` arrives with the automatic-by-default schema
 * change (spec §9.1). The low-credit path writes it only when the deployed
 * schema declares it, so the assertion is gated the same way rather than
 * failing the suite while the two workstreams land.
 */
const SCHEDULED_CONTENT_FIELDS = (
  schema.tables.scheduledContent.validator as unknown as {
    fields: Record<string, unknown>;
  }
).fields;
const HAS_CANCEL_REASON = "cancelReason" in SCHEDULED_CONTENT_FIELDS;

/**
 * One league with a commissioner (Clerk id on the league, `users` row for the
 * notification join), one other member, and a content-preferences row the test
 * can dial. `overrides` sets the preference fields under test.
 */
async function setup(
  overrides: Partial<{
    autoPublish: boolean;
    requireApproval: boolean;
    notifyCommissioner: boolean;
    notifyFailures: boolean;
    contentEnabled: boolean;
  }> = {},
  options: { withPreferences?: boolean; commissionerCredits?: number } = {}
) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Finalize Test League",
      platform: "espn",
      externalId: "7710",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 6,
        size: 2,
        lastSyncedAt: now,
        isPrivate: false,
      },
      subscription: {
        tier: "pro",
        status: "paid",
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
    const memberId = await ctx.db.insert("users", {
      clerkId: CLERK_MEMBER,
      name: "Member",
      email: "member@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    for (const clerkId of [CLERK_COMMISSIONER, CLERK_MEMBER]) {
      await ctx.db.insert("leagueMemberships", {
        leagueId,
        userId: clerkId,
        role: clerkId === CLERK_COMMISSIONER ? "commissioner" : "member",
        joinedAt: now,
      });
    }

    if (options.withPreferences !== false) {
      await ctx.db.insert("leagueContentPreferences", {
        leagueId,
        contentEnabled: overrides.contentEnabled ?? true,
        timezone: "America/New_York",
        currentMonthSpent: 0,
        budgetResetDate: now + 30 * 24 * 60 * 60 * 1000,
        notifyCommissioner: overrides.notifyCommissioner ?? true,
        notifyFailures: overrides.notifyFailures ?? true,
        autoPublish: overrides.autoPublish ?? true,
        requireApproval: overrides.requireApproval ?? false,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (options.commissionerCredits !== undefined) {
      await ctx.db.insert("userCredits", {
        userId: CLERK_COMMISSIONER,
        balance: options.commissionerCredits,
        totalEarned: options.commissionerCredits,
        totalSpent: 0,
        totalPurchased: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { leagueId, commissionerId, memberId };
  });

  return { t, ...ids };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function insertArticle(
  t: Setup["t"],
  leagueId: Setup["leagueId"],
  args: {
    status?: string;
    type?: string;
    reviewFlags?: Array<{
      kind: string;
      detail: string;
      section?: string;
      severity: "block" | "strip" | "warn";
    }>;
  } = {}
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("aiContent", {
      leagueId,
      type: args.type ?? "weekly_recap",
      persona: "curtis-vaughn",
      title: "Week 6: the tightest margin of the year",
      summary: "Two points decided it.",
      content: "Body copy.",
      metadata: { week: 6, featured_teams: [], credits_used: 10 },
      status: args.status ?? "draft",
      createdAt: Date.now(),
      reviewFlags: args.reviewFlags,
    })
  );
}

async function insertScheduledRow(
  t: Setup["t"],
  leagueId: Setup["leagueId"],
  args: { status?: "pending" | "generating"; attempts?: number; maxAttempts?: number } = {}
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const contentScheduleId = await ctx.db.insert("contentSchedules", {
      leagueId,
      contentType: "weekly_recap",
      enabled: true,
      timezone: "America/New_York",
      schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 },
      preferredPersona: "curtis-vaughn",
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("scheduledContent", {
      leagueId,
      contentScheduleId,
      contentType: "weekly_recap",
      scheduledFor: now,
      status: args.status ?? "generating",
      attempts: args.attempts ?? 1,
      maxAttempts: args.maxAttempts ?? 3,
      contextData: { week: 6, seasonId: SEASON },
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function notificationsFor(t: Setup["t"], userId: Setup["commissionerId"]) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("userNotifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()
  );
}

describe("finalizeGeneratedArticle", () => {
  it("publishes when autoPublish is on and nothing is flagged", async () => {
    const { t, leagueId, commissionerId, memberId } = await setup({ autoPublish: true });
    const articleId = await insertArticle(t, leagueId);

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });

    expect(result).toMatchObject({
      published: true,
      blockingFlags: 0,
      notifiedCommissioner: false,
      alreadyFinalized: false,
    });

    const article = await t.run((ctx) => ctx.db.get(articleId));
    expect(article?.status).toBe("published");
    expect(article?.publishedAt).toBeTypeOf("number");

    // Publishing fans readers out through notifyArticlePublished, which the
    // status handler schedules; every league member gets one.
    await t.finishAllScheduledFunctions(() => {});
    const readerNotifications = await notificationsFor(t, memberId);
    expect(readerNotifications.map((n) => n.type)).toEqual(["article_published"]);
    const commissionerNotifications = await notificationsFor(t, commissionerId);
    expect(commissionerNotifications.map((n) => n.type)).toEqual(["article_published"]);
  });

  it("keeps a block-flagged article in draft and tells the commissioner once", async () => {
    const { t, leagueId, commissionerId } = await setup({
      autoPublish: true,
      notifyCommissioner: true,
    });
    const articleId = await insertArticle(t, leagueId, {
      reviewFlags: [
        {
          kind: "quote_not_in_ledger",
          detail: "Quote Q2 is not in the ledger",
          section: "The tape",
          severity: "block",
        },
        { kind: "unknown_decimal", detail: "12.4 is not in FACTS", severity: "warn" },
      ],
    });

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });

    expect(result).toMatchObject({
      published: false,
      blockingFlags: 1,
      notifiedCommissioner: true,
    });

    const article = await t.run((ctx) => ctx.db.get(articleId));
    expect(article?.status).toBe("draft");

    const notifications = await notificationsFor(t, commissionerId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "article_generated",
      relatedEntityId: articleId,
    });
    expect(notifications[0].title).toContain("ready for your review");

    // Dedupe: a replayed finalize must not produce a second notice.
    await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });
    expect(await notificationsFor(t, commissionerId)).toHaveLength(1);
  });

  it("marks the scheduled row completed with the generated article", async () => {
    const { t, leagueId } = await setup({ autoPublish: true });
    const articleId = await insertArticle(t, leagueId);
    const scheduledContentId = await insertScheduledRow(t, leagueId);

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      scheduledContentId,
      generatedByUserId: "system",
    });
    expect(result.scheduledRowCompleted).toBe(true);

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row).toMatchObject({
      status: "completed",
      generatedContentId: articleId,
    });
    expect(row?.generatedAt).toBeTypeOf("number");
  });

  it("is idempotent: a second finalize of a published article does nothing", async () => {
    const { t, leagueId, commissionerId } = await setup({ autoPublish: true });
    const articleId = await insertArticle(t, leagueId);
    const scheduledContentId = await insertScheduledRow(t, leagueId);

    const first = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      scheduledContentId,
      generatedByUserId: "system",
    });
    expect(first.published).toBe(true);
    await t.finishAllScheduledFunctions(() => {});

    const publishedAt = (await t.run((ctx) => ctx.db.get(articleId)))?.publishedAt;
    const notificationsAfterFirst = await notificationsFor(t, commissionerId);

    const second = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      scheduledContentId,
      generatedByUserId: "system",
    });
    expect(second).toMatchObject({
      published: false,
      alreadyFinalized: true,
      scheduledRowCompleted: false,
    });
    await t.finishAllScheduledFunctions(() => {});

    const article = await t.run((ctx) => ctx.db.get(articleId));
    expect(article?.publishedAt).toBe(publishedAt);
    expect(await notificationsFor(t, commissionerId)).toHaveLength(
      notificationsAfterFirst.length
    );
  });

  it("respects requireApproval even when autoPublish is on", async () => {
    const { t, leagueId } = await setup({ autoPublish: true, requireApproval: true });
    const articleId = await insertArticle(t, leagueId);

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });

    expect(result.published).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(articleId)))?.status).toBe("draft");
  });
});

describe("League Pass coverage (spec §10.1)", () => {
  it("charges nothing for a system generation, however empty the commissioner's balance", async () => {
    // Zero credits, and a scheduled row: exactly the shape that used to fail
    // the article with "low_credits". Under the pass it just generates.
    const { t, leagueId, commissionerId } = await setup({}, { commissionerCredits: 0 });
    const articleId = await insertArticle(t, leagueId, { status: "generating" });
    const scheduledContentId = await insertScheduledRow(t, leagueId);

    await t.action(internal.aiContent.generateContentAction, {
      articleId,
      leagueId,
      contentType: "weekly_recap",
      persona: "curtis-vaughn",
      userId: "system",
      seasonId: SEASON,
      week: 6,
      scheduledContentId,
    });

    // weekly_recap takes the prepared path, so the action hands off and
    // returns; what matters is that nothing was billed on the way through.
    const article = await t.run((ctx) => ctx.db.get(articleId));
    expect(article?.status).toBe("generating");

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).not.toBe("cancelled");

    const credits = await t.run((ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .first()
    );
    expect(credits?.balance).toBe(0);

    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .collect()
    );
    expect(transactions).toHaveLength(0);

    // No article, no failure: nothing to tell the commissioner about.
    expect(await notificationsFor(t, commissionerId)).toHaveLength(0);
  });

  it("leaves a funded commissioner's balance untouched too", async () => {
    const cost = contentTemplates["weekly_recap"].creditCost;
    const { t, leagueId } = await setup({}, { commissionerCredits: cost + 5 });
    const articleId = await insertArticle(t, leagueId, { status: "generating" });

    await t.action(internal.aiContent.generateContentAction, {
      articleId,
      leagueId,
      contentType: "weekly_recap",
      persona: "curtis-vaughn",
      userId: "system",
      seasonId: SEASON,
      week: 6,
    });

    const credits = await t.run((ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .first()
    );
    expect(credits?.balance).toBe(cost + 5);
    expect((await t.run((ctx) => ctx.db.get(articleId)))?.status).toBe("generating");
  });

  it("still records a shortfall when something credit-funded cannot be paid for", async () => {
    // markGenerationLowCredits is no longer on the automatic path, but it is
    // still the shared bookkeeping for a credit-funded generation that runs
    // short, and it still notifies exactly once per league per week.
    const { t, leagueId, commissionerId } = await setup({}, { commissionerCredits: 1 });
    const articleId = await insertArticle(t, leagueId, { status: "generating" });
    const scheduledContentId = await insertScheduledRow(t, leagueId);

    const args = {
      articleId,
      leagueId,
      contentType: "weekly_recap",
      scheduledContentId,
      required: contentTemplates["weekly_recap"].creditCost,
      available: 1,
    };
    await t.mutation(internal.aiContent.markGenerationLowCredits, args);
    await t.mutation(internal.aiContent.markGenerationLowCredits, args);

    const article = await t.run((ctx) => ctx.db.get(articleId));
    expect(article?.status).toBe("failed");

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("cancelled");
    if (HAS_CANCEL_REASON) {
      expect((row as { cancelReason?: string }).cancelReason).toBe("low_credits");
    }

    expect(await notificationsFor(t, commissionerId)).toHaveLength(1);
  });
});

describe("manual generation pricing (spec §10.1)", () => {
  it("charges the template price for a plain manual generation", async () => {
    const { t, leagueId } = await setup({}, { commissionerCredits: 500 });
    const cost = creditCostFor("power_rankings");
    expect(cost).toBe(contentTemplates["power_rankings"].creditCost);

    const asCommissioner = t.withIdentity({ subject: CLERK_COMMISSIONER });
    await asCommissioner.mutation(api.aiContent.createGenerationRequest, {
      leagueId,
      type: "power_rankings",
      persona: "nina-sharpe",
    });

    const credits = await t.run((ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .first()
    );
    expect(credits?.balance).toBe(500 - cost);
  });

  it("adds 5 credits per manager asked when the requester turns comments on", async () => {
    const { t, leagueId } = await setup({}, { commissionerCredits: 500 });
    const asked = ["clerk_a", "clerk_b", "clerk_c"];
    const cost = creditCostFor("weekly_recap", asked.length);
    expect(cost).toBe(
      contentTemplates["weekly_recap"].creditCost + asked.length * INTERVIEW_CREDITS_PER_MANAGER
    );

    const asCommissioner = t.withIdentity({ subject: CLERK_COMMISSIONER });
    const articleId = await asCommissioner.mutation(api.aiContent.createGenerationWithComments, {
      leagueId,
      type: "weekly_recap",
      persona: "curtis-vaughn",
      requestComments: true,
      articleGenerationTime: Date.now() + 6 * 60 * 60 * 1000,
      targetUserIds: asked,
    });

    const credits = await t.run((ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_COMMISSIONER))
        .first()
    );
    expect(credits?.balance).toBe(500 - cost);

    // And the article records what it actually cost, so a refund gives back
    // the interviews too.
    const article = await t.run((ctx) => ctx.db.get(articleId));
    expect(article?.metadata.credits_used).toBe(cost);
    expect(article?.commentRequestConfig?.creditsDeductedUpFront).toBe(cost);
  });
});

describe("interview cost accounting (spec §10.3.4)", () => {
  it("accumulates each reported call onto the request and ignores nonsense", async () => {
    const { t, leagueId, memberId } = await setup();
    const commentRequestId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("commentRequests", {
        leagueId,
        targetUserId: memberId,
        contentType: "weekly_recap",
        articleContext: { week: 6, seasonId: SEASON },
        status: "active",
        scheduledSendTime: now,
        articleGenerationTime: now + 6 * 60 * 60 * 1000,
        conversationState: "initial_request_sent",
        aiContext: { initialPrompt: "How was week 6?", conversationGoals: [] },
        autoEndCriteria: {
          maxMessages: 10,
          currentMessageCount: 1,
          minResponseLength: 20,
          lastActivityTime: now,
          inactivityTimeoutMinutes: 30,
        },
        priority: "medium",
        notificationsSent: [],
        createdAt: now,
        updatedAt: now,
      });
    });

    const first = await t.mutation(internal.aiContent.addInterviewCost, {
      commentRequestId,
      costUsd: 0.023,
    });
    expect(first.totalUsd).toBeCloseTo(0.023, 6);

    const second = await t.mutation(internal.aiContent.addInterviewCost, {
      commentRequestId,
      costUsd: 0.035,
    });
    expect(second.totalUsd).toBeCloseTo(0.058, 6);

    // A zero or negative report is a bug upstream, not a credit.
    const ignored = await t.mutation(internal.aiContent.addInterviewCost, {
      commentRequestId,
      costUsd: -1,
    });
    expect(ignored.totalUsd).toBeCloseTo(0.058, 6);
  });
});

describe("retry loop (spec section 9.2.5)", () => {
  it("stops at the retry cap instead of scheduling another attempt", async () => {
    const { t, leagueId } = await setup();
    const articleId = await insertArticle(t, leagueId, { status: "generating" });

    await t.action(internal.aiContentHelpers.retryFailedGeneration, {
      articleId,
      leagueId,
      contentType: "weekly_recap",
      persona: "curtis-vaughn",
      userId: "system",
      retryCount: 3,
    });

    expect((await t.run((ctx) => ctx.db.get(articleId)))?.status).toBe("failed");
  });

  it("never retries a scheduled article - the cron owns those", async () => {
    const { t, leagueId } = await setup();
    const articleId = await insertArticle(t, leagueId, { status: "generating" });
    const scheduledContentId = await insertScheduledRow(t, leagueId);

    await t.action(internal.aiContentHelpers.retryFailedGeneration, {
      articleId,
      leagueId,
      contentType: "weekly_recap",
      persona: "curtis-vaughn",
      userId: "system",
      retryCount: 0,
      scheduledContentId,
    });

    // Untouched: no generation was started and the article was not failed.
    expect((await t.run((ctx) => ctx.db.get(articleId)))?.status).toBe("generating");
  });

  it("hands a failed scheduled row back to the cron as pending, then fails it", async () => {
    const { t, leagueId, commissionerId } = await setup({ notifyFailures: true });
    const articleId = await insertArticle(t, leagueId, { status: "generating" });
    // `processScheduledContent` already spent attempt 1 when it dispatched
    // this generation, which is why the row arrives as "generating".
    const scheduledContentId = await insertScheduledRow(t, leagueId, {
      status: "generating",
      attempts: 1,
      maxAttempts: 2,
    });

    const first = await t.mutation(internal.aiContent.recordScheduledGenerationFailure, {
      scheduledContentId,
      leagueId,
      contentType: "weekly_recap",
      articleId,
      errorMessage: "model timeout",
      retryable: true,
    });
    expect(first).toMatchObject({ status: "pending", attempts: 1, notified: false });

    const pendingRow = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(pendingRow?.nextRetryAt).toBeTypeOf("number");
    expect(pendingRow!.nextRetryAt!).toBeGreaterThan(Date.now());

    const second = await t.mutation(internal.aiContent.recordScheduledGenerationFailure, {
      scheduledContentId,
      leagueId,
      contentType: "weekly_recap",
      articleId,
      errorMessage: "model timeout",
      retryable: true,
    });
    expect(second).toMatchObject({ status: "failed", attempts: 2, notified: true });

    const notifications = await notificationsFor(t, commissionerId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toContain("could not write");
  });
});
