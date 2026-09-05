import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { looksLikeDecline } from "../convex/lib/declineDetection";

const modules = import.meta.glob("../convex/**/*.*s");

/**
 * The interview flow after the manager speaks (Sept 2026 interview audit):
 *
 *  - `createCommentResponse` is an upsert, so the row Sam's close creates is merged, not
 *    duplicated, when the manager adds a reply to "anything else?";
 *  - a request whose manager spoke goes to print with what they gave us at the deadline
 *    instead of being "expired ... without your input";
 *  - `hasQuotableReply` is what keeps "...that's all, no further comment" from being
 *    recorded as a decline;
 *  - a bare "no comment" is a decline, never a quote.
 */

const CLERK = "clerk_flow";

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "Flow Test League",
      platform: "espn",
      externalId: "8888",
      commissionerUserId: CLERK,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: { seasonId: 2026, currentScoringPeriod: 2, size: 2, lastSyncedAt: now, isPrivate: false },
      subscription: {
        tier: "season_pass",
        status: "active",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "completed",
        seasonYear: 2026,
      },
      lastSync: now,
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      clerkId: CLERK,
      name: "Flow Manager",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });
    const requestId = await ctx.db.insert("commentRequests", {
      leagueId,
      targetUserId: userId,
      contentType: "weekly_recap",
      interviewerPersona: "sam-ortega",
      writerPersona: "mel-diaper",
      articleContext: { week: 2, seasonId: 2026, topic: "weekly recap week 2", focusAreas: [] },
      status: "active",
      scheduledSendTime: now,
      articleGenerationTime: now + 3_600_000,
      conversationState: "gathering_details",
      aiContext: { initialPrompt: "", conversationGoals: [], currentFocus: "weekly_recap" },
      autoEndCriteria: { maxMessages: 8, currentMessageCount: 0, minResponseLength: 30, lastActivityTime: now, inactivityTimeoutMinutes: 30 },
      priority: "medium",
      notificationsSent: [],
      createdAt: now,
      updatedAt: now,
    });
    return { leagueId, userId, requestId };
  });
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function reply(t: TestConvex<typeof schema>, ids: Seeded, content: string, quotableSegments: string[]) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", (q) => q.eq("commentRequestId", ids.requestId))
      .collect();
    await ctx.db.insert("commentConversations", {
      commentRequestId: ids.requestId,
      leagueId: ids.leagueId,
      userId: ids.userId,
      messageType: "user_response",
      content,
      messageOrder: existing.length,
      isRead: true,
      responseAnalysis: { quotableSegments, completeness: 70 },
      createdAt: Date.now(),
      threadDepth: 0,
    });
  });
}

function responseArgs(ids: Seeded, raw: string, quotes: string[]) {
  return {
    commentRequestId: ids.requestId,
    leagueId: ids.leagueId,
    userId: ids.userId,
    scheduledContentId: null,
    rawResponse: raw,
    processedResponse: raw,
    responseType: "mixed" as const,
    relevanceMetadata: {
      topicRelevance: 80,
      qualityScore: 80,
      originality: 75,
      usabilityRating: "high" as const,
      extractedQuotes: quotes,
    },
    userEngagementLevel: "high" as const,
    processedAt: Date.now(),
  };
}

async function responses(t: TestConvex<typeof schema>, requestId: Id<"commentRequests">) {
  return await t.run((ctx) =>
    ctx.db
      .query("commentResponses")
      .withIndex("by_comment_request", (q) => q.eq("commentRequestId", requestId))
      .collect()
  );
}

async function messages(t: TestConvex<typeof schema>, requestId: Id<"commentRequests">) {
  return await t.run((ctx) =>
    ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request_order", (q) => q.eq("commentRequestId", requestId))
      .collect()
  );
}

describe("createCommentResponse", () => {
  it("upserts: a second pass merges new quotes and keeps the manager's review decisions", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await t.mutation(internal.commentConversations.createCommentResponse, responseArgs(ids, "I trusted the matchup.", ["I trusted the matchup"]));
    let rows = await responses(t, ids.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0].quoteReview).toEqual([{ original: "I trusted the matchup", text: "I trusted the matchup", status: "pending" }]);
    // The approval prompt is posted once the row exists.
    expect((await messages(t, ids.requestId)).filter((m) => m.messageType === "quote_approval")).toHaveLength(1);

    // The manager withdraws the first quote, then adds a reply to "anything else?".
    await t.run(async (ctx) => {
      await ctx.db.patch(rows[0]._id, { quoteReview: [{ original: "I trusted the matchup", text: "I trusted the matchup", status: "withdrawn" }] });
    });
    await t.mutation(
      internal.commentConversations.createCommentResponse,
      responseArgs(ids, "I trusted the matchup.\n\nAnd Bijan bailed me out.", ["I trusted the matchup", "Bijan bailed me out"])
    );

    rows = await responses(t, ids.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawResponse).toContain("Bijan bailed me out");
    expect(rows[0].quoteReview).toEqual([
      { original: "I trusted the matchup", text: "I trusted the matchup", status: "withdrawn" },
      { original: "Bijan bailed me out", text: "Bijan bailed me out", status: "pending" },
    ]);
    expect((await messages(t, ids.requestId)).filter((m) => m.messageType === "quote_approval")).toHaveLength(1);
  });
});

describe("deadline handling", () => {
  it("expireRequest completes a request whose manager spoke, and expires one nobody answered", async () => {
    const t = convexTest(schema, modules);
    const spoke = await seed(t);
    await t.mutation(internal.commentConversations.createCommentResponse, responseArgs(spoke, "Fine week.", ["Fine week"]));
    await t.mutation(internal.commentRequests.expireRequest, { commentRequestId: spoke.requestId });
    const done = await t.run((ctx) => ctx.db.get(spoke.requestId));
    expect(done).toMatchObject({ status: "completed", conversationState: "response_complete" });
    const last = (await messages(t, spoke.requestId)).at(-1);
    expect(last?.messageType).toBe("system_message");
    expect(last?.content).toContain("going to print with what you gave us");
    expect(last?.content).not.toContain("without your input");

    const silent = await seed(t);
    await t.mutation(internal.commentRequests.expireRequest, { commentRequestId: silent.requestId });
    expect(await t.run((ctx) => ctx.db.get(silent.requestId))).toMatchObject({ status: "expired" });
    expect((await messages(t, silent.requestId)).at(-1)?.content).toContain("without your input");
  });

  it("expireCommentRequests (manual articles) applies the same rule", async () => {
    const t = convexTest(schema, modules);
    const spoke = await seed(t);
    const silent = await seed(t);
    await t.mutation(internal.commentConversations.createCommentResponse, responseArgs(spoke, "Fine week.", ["Fine week"]));
    await t.mutation(internal.aiContentWithComments.expireCommentRequests, {
      commentRequestIds: [spoke.requestId, silent.requestId],
    });
    expect(await t.run((ctx) => ctx.db.get(spoke.requestId))).toMatchObject({ status: "completed" });
    expect(await t.run((ctx) => ctx.db.get(silent.requestId))).toMatchObject({ status: "expired" });
  });

  it("a completed-at-deadline manager is quoted, not listed as a non-respondent", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.mutation(internal.commentConversations.createCommentResponse, responseArgs(ids, "Fine week.", ["Fine week"]));
    await t.mutation(internal.commentRequests.expireRequest, { commentRequestId: ids.requestId });

    const quoted = await t.query(internal.aiContentWithComments.getStructuredCommentResponses, { commentRequestIds: [ids.requestId] });
    expect(quoted).toHaveLength(1);
    expect(quoted[0].quotes).toEqual(["Fine week"]);
    const silent = await t.query(internal.aiContentWithComments.getNonRespondents, { commentRequestIds: [ids.requestId] });
    expect(silent).toHaveLength(0);
  });
});

describe("closed interviews", () => {
  it("completeConversation signs off in Sam's voice with no trailing question", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await reply(t, ids, "Fine week, moving on.", ["Fine week, moving on."]);
    await t.mutation(internal.commentConversations.completeConversation, { commentRequestId: ids.requestId, reason: "sufficient_response" });
    const all = await messages(t, ids.requestId);
    const signOff = all.find((m) => m.messageType === "ai_confirmation");
    expect(signOff).toBeTruthy();
    expect(signOff!.content).toContain("Flow");
    expect(signOff!.content).toContain("Mel");
    expect(signOff!.content).not.toContain("?");
    expect(all.some((m) => m.messageType === "system_message")).toBe(false);
    expect(await t.run((ctx) => ctx.db.get(ids.requestId))).toMatchObject({ status: "completed" });
  });

  it("takes no reply once the request is declined, expired or completed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run((ctx) => ctx.db.patch(ids.requestId, { status: "declined" }));
    const asManager = t.withIdentity({ subject: CLERK });
    await expect(
      asManager.mutation(api.commentConversations.sendUserResponse, { commentRequestId: ids.requestId, content: "Actually, one more thing." })
    ).rejects.toThrow("closed");
    expect((await messages(t, ids.requestId)).filter((m) => m.messageType === "user_response")).toHaveLength(0);
  });
});

describe("declines", () => {
  it("hasQuotableReply distinguishes an answer with a close from a bare decline", async () => {
    const t = convexTest(schema, modules);
    const answered = await seed(t);
    await reply(t, answered, "CMC was always the pick at 8. Thank you, no further comments.", ["CMC was always the pick at 8"]);
    expect(await t.query(internal.commentConversations.hasQuotableReply, { commentRequestId: answered.requestId })).toBe(true);

    const declined = await seed(t);
    await reply(t, declined, "No comment.", []);
    expect(await t.query(internal.commentConversations.hasQuotableReply, { commentRequestId: declined.requestId })).toBe(false);

    // A "quotable" segment that is not actually in the reply does not count.
    const forged = await seed(t);
    await reply(t, forged, "No comment.", ["lineup decisions"]);
    expect(await t.query(internal.commentConversations.hasQuotableReply, { commentRequestId: forged.requestId })).toBe(false);
  });

  it("looksLikeDecline is conservative", () => {
    for (const text of ["No comment.", "no comment", "Pass.", "I'd rather not.", "Not today, thanks.", "nope", "Nothing to add."]) {
      expect(looksLikeDecline(text), text).toBe(true);
    }
    for (const text of [
      "I had Waddle in there until about 11:40, then I got cute. No comment on Mel though.",
      "CMC was my target from the moment I knew I was pick 8. Thank you no further comments.",
      "We passed on Henry because the board fell that way.",
      "No, I started him because the matchup was soft.",
    ]) {
      expect(looksLikeDecline(text), text).toBe(false);
    }
  });
});
