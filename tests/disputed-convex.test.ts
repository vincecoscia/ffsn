import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2026;
const CLERK_ANN = "clerk_disputed_ann";
const CLERK_BOB = "clerk_disputed_bob";

/**
 * One league, two managers who have each claimed a team for the league's current season, plus a
 * league membership for each — same shape as tests/relationships.test.ts's own `setup`, since
 * `disputed.ts` and `disputedNode.ts` reuse the exact same relationship/team-claim machinery.
 */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Disputed Test League",
      platform: "espn",
      externalId: "9002",
      commissionerUserId: CLERK_ANN,
      settings: {
        scoringType: "PPR",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: [],
      },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 5,
        size: 2,
        lastSyncedAt: now,
        isPrivate: false,
      },
      subscription: {
        tier: "pro",
        status: "paid",
        creditsRemaining: 100,
        creditsMonthly: 100,
        paymentStatus: "completed",
        seasonYear: SEASON,
      },
      lastSync: now,
      createdAt: now,
    });

    const userAnn = await ctx.db.insert("users", {
      clerkId: CLERK_ANN,
      name: "Ann",
      email: "ann@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });
    const userBob = await ctx.db.insert("users", {
      clerkId: CLERK_BOB,
      name: "Bob",
      email: "bob@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    const teamAlpha = await ctx.db.insert("teams", {
      leagueId,
      externalId: "3",
      name: "Alpha",
      owner: "Ann",
      record: { wins: 3, losses: 1, ties: 0, pointsFor: 421.7 },
      roster: [],
      seasonId: SEASON,
      createdAt: now,
      updatedAt: now,
    });
    const teamBeta = await ctx.db.insert("teams", {
      leagueId,
      externalId: "7",
      name: "Beta",
      owner: "Bob",
      record: { wins: 1, losses: 3, ties: 0, pointsFor: 358.2 },
      roster: [],
      seasonId: SEASON,
      createdAt: now,
      updatedAt: now,
    });

    const claims = [
      { clerkId: CLERK_ANN, teamId: teamAlpha },
      { clerkId: CLERK_BOB, teamId: teamBeta },
    ];
    for (const { clerkId, teamId } of claims) {
      await ctx.db.insert("teamClaims", {
        leagueId,
        teamId,
        seasonId: SEASON,
        userId: clerkId,
        status: "active",
        credits: 0,
        createdAt: now,
      });
      await ctx.db.insert("leagueMemberships", {
        leagueId,
        userId: clerkId,
        role: clerkId === CLERK_ANN ? "commissioner" : "member",
        joinedAt: now,
      });
    }

    return { leagueId, userAnn, userBob, teamAlpha, teamBeta };
  });

  return { t, ...ids };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A bare "generating" desk_show draft row, the shape `disputed.createShowDraft` itself produces. */
async function insertDraft(
  t: Setup["t"],
  leagueId: Setup["leagueId"],
  args: { title?: string; managerMentions?: unknown } = {}
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("aiContent", {
      leagueId,
      type: "desk_show",
      persona: "curtis-vaughn",
      title: args.title ?? "Generating...",
      content: "",
      metadata: { featured_teams: [], credits_used: 0 },
      status: "generating",
      createdAt: Date.now(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      managerMentions: args.managerMentions as any,
    })
  );
}

describe("aiContent: updateGeneratedContent (Disputed)", () => {
  it("stores the transcript and stamps each claim with its own persona, else the article's", async () => {
    const { t, leagueId } = await setup();
    const articleId = await insertDraft(t, leagueId);

    const transcript = {
      schema: "ffsn.transcript.v1" as const,
      show: "disputed" as const,
      week: 5,
      question: "Is Ann a good manager, or a lucky one?",
      hotSeat: {
        teamId: "T3",
        teamName: "Alpha",
        managerName: "Ann",
        why: "the desk disagrees about her",
      },
      language: "salty" as const,
      segments: [
        {
          id: "cold_open",
          title: "Cold Open",
          turns: [
            { speaker: "curtis-vaughn", kind: "cold_open", text: "Let's get into it.", jab: false, factsCited: [] },
          ],
        },
      ],
    };

    await t.mutation(internal.aiContent.updateGeneratedContent, {
      articleId,
      title: "Disputed · Week 5",
      content: "# Disputed",
      summary: transcript.question,
      metadata: {
        week: 5,
        featuredTeams: [],
        featuredPlayers: [],
        tags: [],
        creditsUsed: 0,
        generationTime: 1000,
        modelUsed: "claude-opus-5",
        promptTokens: 100,
        completionTokens: 200,
        claims: [
          { text: "Mel says Ann wins out.", kind: "team_win", subjectTeamId: "T3", week: 5, persona: "mel-diaper" },
          { text: "A claim with no explicit speaker.", kind: "general" },
        ],
        transcript,
      },
    });

    const stored = await t.run((ctx) => ctx.db.get(articleId));
    expect(stored?.transcript).toEqual(transcript);
    expect(stored?.claims).toHaveLength(2);
    expect(stored?.claims?.[0]).toMatchObject({ persona: "mel-diaper", outcome: "open" });
    // No persona on the claim itself falls back to the article's own byline (curtis-vaughn).
    expect(stored?.claims?.[1]).toMatchObject({ persona: "curtis-vaughn", outcome: "open" });
  });
});

describe("relationships: recordArticleMentions (Disputed, multi-speaker)", () => {
  it("moves the mentioning speaker's meter, not the article's own byline", async () => {
    const { t, leagueId, userAnn, userBob, teamAlpha, teamBeta } = await setup();
    const articleId = await insertDraft(t, leagueId, {
      managerMentions: [
        {
          teamId: "T3",
          managerName: "Ann",
          stance: "roast",
          intensity: 2,
          evidence: "Mel roasts Ann's bench.",
          persona: "mel-diaper",
        },
        {
          teamId: "T7",
          managerName: "Bob",
          stance: "praise",
          intensity: 2,
          evidence: "Nina praises Bob's waiver work.",
          persona: "nina-sharpe",
        },
      ],
    });

    const result = await t.mutation(internal.relationships.recordArticleMentions, { articleId });
    expect(result).toEqual({ recorded: 2, skipped: 0, unresolved: [] });

    const rows = await t.run((ctx) => ctx.db.query("writerRelationships").collect());
    expect(rows).toHaveLength(2);

    const byPersona = new Map(rows.map((row) => [row.persona, row]));
    expect(byPersona.get("mel-diaper")).toMatchObject({ userId: userAnn, teamId: teamAlpha, score: -6 });
    expect(byPersona.get("nina-sharpe")).toMatchObject({ userId: userBob, teamId: teamBeta, score: 6 });
    // The article's own byline (curtis-vaughn, the host) never made a mention and stays untouched.
    expect(byPersona.get("curtis-vaughn")).toBeUndefined();
  });
});

describe("aiContent: createGenerationRequest desk_show guard", () => {
  it("throws the show-producer error for desk_show and deducts no credits", async () => {
    const { t, leagueId } = await setup();
    // Deliberately no userCredits row: if the show-kind guard did not run before the credit
    // check, this would fail on "Insufficient credits" instead — the wrong diagnosis.

    await expect(
      t.withIdentity({ subject: CLERK_ANN }).mutation(api.aiContent.createGenerationRequest, {
        leagueId,
        type: "desk_show",
        persona: "curtis-vaughn",
      })
    ).rejects.toThrow(/Disputed is produced by the desk show producer/);

    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", CLERK_ANN))
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
});

describe("disputed: createShowDraft + getEpisode", () => {
  it("round-trips a draft row through to a saved episode", async () => {
    const { t, leagueId } = await setup();

    const articleId = await t.mutation(internal.disputed.createShowDraft, {
      leagueId,
      week: 5,
      seasonId: SEASON,
      title: "Disputed · Week 5",
    });

    const fresh = await t.query(internal.disputed.getEpisode, { articleId });
    expect(fresh).toMatchObject({ title: "Disputed · Week 5", status: "generating", content: "" });
    expect(fresh?.transcript).toBeUndefined();

    const transcript = {
      schema: "ffsn.transcript.v1" as const,
      show: "disputed" as const,
      week: 5,
      question: "Is Ann a good manager, or a lucky one?",
      segments: [] as never[],
    };

    await t.mutation(internal.aiContent.updateGeneratedContent, {
      articleId,
      title: "Disputed · Week 5",
      content: "# Disputed",
      summary: transcript.question,
      metadata: {
        week: 5,
        featuredTeams: [],
        featuredPlayers: [],
        tags: [],
        creditsUsed: 0,
        generationTime: 500,
        modelUsed: "claude-opus-5",
        promptTokens: 10,
        completionTokens: 20,
        transcript,
      },
    });

    const done = await t.query(internal.disputed.getEpisode, { articleId });
    expect(done).toMatchObject({ title: "Disputed · Week 5", status: "draft", content: "# Disputed" });
    expect(done?.transcript).toEqual(transcript);
  });
});

describe("disputed: getRecentQuotesForShow", () => {
  it("returns the league's processed quotes, and [] for a league with none", async () => {
    const { t, leagueId, userAnn } = await setup();
    const now = Date.now();

    const commentRequestId = await t.run((ctx) =>
      ctx.db.insert("commentRequests", {
        leagueId,
        targetUserId: userAnn,
        contentType: "desk_show",
        articleContext: { topic: "This week's biggest blowup" },
        status: "completed",
        scheduledSendTime: now,
        articleGenerationTime: now,
        conversationState: "response_complete",
        aiContext: { initialPrompt: "What happened this week?", conversationGoals: [] },
        autoEndCriteria: {
          maxMessages: 10,
          currentMessageCount: 1,
          minResponseLength: 10,
          lastActivityTime: now,
          inactivityTimeoutMinutes: 30,
        },
        priority: "medium",
        notificationsSent: [],
        createdAt: now,
        updatedAt: now,
      })
    );

    await t.run((ctx) =>
      ctx.db.insert("commentResponses", {
        commentRequestId,
        leagueId,
        userId: userAnn,
        scheduledContentId: null,
        rawResponse: "We got robbed this week.",
        processedResponse: "We got robbed this week.",
        responseType: "opinion",
        relevanceMetadata: { topicRelevance: 90, qualityScore: 80, originality: 70, usabilityRating: "high" },
        integrationStatus: "pending",
        userEngagementLevel: "high",
        createdAt: now,
        updatedAt: now,
        processedAt: now,
      })
    );

    const quotes = await t.query(internal.disputed.getRecentQuotesForShow, { leagueId });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      userName: "Ann",
      teamName: "Alpha",
      quotes: ["We got robbed this week."],
    });

    // A second, unrelated league with no comment responses at all.
    const otherLeagueId = await t.run((ctx) =>
      ctx.db.insert("leagues", {
        name: "Quiet League",
        platform: "espn",
        externalId: "9003",
        commissionerUserId: CLERK_BOB,
        settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
        espnData: {
          seasonId: SEASON,
          currentScoringPeriod: 5,
          size: 2,
          lastSyncedAt: now,
          isPrivate: false,
        },
        subscription: {
          tier: "pro",
          status: "paid",
          creditsRemaining: 100,
          creditsMonthly: 100,
          paymentStatus: "completed",
          seasonYear: SEASON,
        },
        lastSync: now,
        createdAt: now,
      })
    );

    const empty = await t.query(internal.disputed.getRecentQuotesForShow, { leagueId: otherLeagueId });
    expect(empty).toEqual([]);
  });
});
