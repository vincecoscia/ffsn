/**
 * Quality gates for unattended publishing (spec §11), workstream Q-B.
 *
 * Four things are worth proving without a model in the loop:
 *   §11.1.1  a week is only "final" when every matchup of it has settled;
 *   §11.1.2  a row whose core data is missing defers instead of generating;
 *   §11.2.9  the publish gate holds an article on a strip and on a low editor
 *            facts score, whatever the league's auto-publish preference says;
 *   §11.3.10 the operator digest's arithmetic, over rows rather than a model.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { aggregateLeagueDigest, formatLeagueDigestLine } from "../convex/deskMetrics";
import { devToolsGuard } from "../convex/devTools";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2026;
const CLERK_COMMISSIONER = "clerk_commish_qb";

/** Mid-October 2026: comfortably inside the seeded 2026 regular season. */
const IN_SEASON = new Date(2026, 9, 14, 9, 0, 0);

function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

/**
 * One paid-up league with teams and a commissioner. `teams: 0` is how a test
 * asks for a league whose core data is missing.
 */
async function seedLeague(t: TestHarness, opts: { teams?: number } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Quality Gate League",
      platform: "espn",
      externalId: "9911",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 6,
        size: 10,
        // Fresh, so nothing in the pipeline reaches for the ESPN API.
        lastSyncedAt: now,
        isPrivate: false,
      },
      subscription: {
        tier: "season_pass",
        status: "active",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "completed" as const,
        seasonYear: SEASON,
        seasonId: SEASON,
      },
      lastSync: now,
      createdAt: now,
    });

    await ctx.db.insert("users", {
      clerkId: CLERK_COMMISSIONER,
      name: "Commish",
      email: "commish@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    for (let i = 1; i <= (opts.teams ?? 10); i++) {
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

    return leagueId;
  });
}

/**
 * Two matchups in `week`. `settled` decides whether they look like a finished
 * week: a settled pair carries a winner, an unsettled one carries neither a
 * winner nor a score, which is exactly a game that has not kicked off.
 */
async function seedWeek(
  t: TestHarness,
  leagueId: Id<"leagues">,
  week: number,
  opts: { settled: boolean; oneUnfinished?: boolean } = { settled: true }
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      const finished = opts.settled && !(opts.oneUnfinished && i === 1);
      await ctx.db.insert("matchups", {
        leagueId,
        seasonId: SEASON,
        matchupPeriod: week,
        scoringPeriod: week,
        homeTeamId: String(i * 2 + 1),
        awayTeamId: String(i * 2 + 2),
        homeScore: finished ? 110 + i : 0,
        awayScore: finished ? 100 + i : 0,
        winner: finished ? ("home" as const) : undefined,
        createdAt: now,
      });
    }
  });
}

async function seedAutomation(t: TestHarness, leagueId: Id<"leagues">) {
  await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });
  await t.mutation(internal.contentScheduling.createDefaultContentSchedules, {
    leagueId,
    timezone: "America/New_York",
  });
}

async function seedScheduledRow(
  t: TestHarness,
  leagueId: Id<"leagues">,
  contentType: "weekly_recap" | "trade_analysis",
  patch: { deferrals?: number } = {}
) {
  return await t.run(async (ctx) => {
    const schedule = await ctx.db
      .query("contentSchedules")
      .withIndex("by_league_type", (q) =>
        q.eq("leagueId", leagueId).eq("contentType", contentType)
      )
      .first();
    if (!schedule) throw new Error(`no ${contentType} schedule seeded`);

    const now = Date.now();
    return await ctx.db.insert("scheduledContent", {
      leagueId,
      contentScheduleId: schedule._id,
      contentType,
      scheduledFor: now,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      deferrals: patch.deferrals,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* §11.1.1 week finality                                                       */
/* -------------------------------------------------------------------------- */

describe("isWeekFinal (spec §11.1.1)", () => {
  it("is final when every matchup of the week carries a winner", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await seedWeek(t, leagueId, 5, { settled: true });

    const result = await t.query(internal.contentScheduling.isWeekFinal, {
      leagueId,
      seasonId: SEASON,
      week: 5,
    });

    expect(result).toMatchObject({ final: true, matchups: 2, unfinished: 0, reason: "final" });
  });

  it("is not final while one matchup of the week is unsettled", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    // Three of four sides played; the Monday night game has not.
    await seedWeek(t, leagueId, 5, { settled: true, oneUnfinished: true });

    const result = await t.query(internal.contentScheduling.isWeekFinal, {
      leagueId,
      seasonId: SEASON,
      week: 5,
    });

    expect(result).toMatchObject({
      final: false,
      matchups: 2,
      unfinished: 1,
      reason: "unfinished_matchups",
    });
  });

  it("is not final when the week has no matchups at all", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);

    const result = await t.query(internal.contentScheduling.isWeekFinal, {
      leagueId,
      seasonId: SEASON,
      week: 5,
    });

    // Nothing to be final about. The caller defers for data rather than
    // publishing a recap of an empty week.
    expect(result).toMatchObject({ final: false, matchups: 0, reason: "no_matchups" });
  });

  it("accepts a scored week with no winner once the scoring period has closed", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: SEASON });

    const boundary = await t.run(async (ctx) => {
      const season = await ctx.db
        .query("nflSeasons")
        .withIndex("by_year", (q) => q.eq("year", SEASON))
        .first();
      const week5 = season?.weekBoundaries.find((entry) => entry.week === 5);
      if (!week5) throw new Error("no week 5 boundary seeded");

      // Both sides scored, ESPN never stamped a winner.
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("matchups", {
          leagueId,
          seasonId: SEASON,
          matchupPeriod: 5,
          scoringPeriod: 5,
          homeTeamId: String(i * 2 + 1),
          awayTeamId: String(i * 2 + 2),
          homeScore: 110,
          awayScore: 100,
          createdAt: now,
        });
      }
      return week5;
    });

    const during = await t.query(internal.contentScheduling.isWeekFinal, {
      leagueId,
      seasonId: SEASON,
      week: 5,
      now: boundary.end - 1,
    });
    expect(during.final).toBe(false);

    const after = await t.query(internal.contentScheduling.isWeekFinal, {
      leagueId,
      seasonId: SEASON,
      week: 5,
      now: boundary.end + 1,
    });
    expect(after).toMatchObject({ final: true, periodOver: true });
  });
});

/* -------------------------------------------------------------------------- */
/* §11.1.1 / §11.1.2 deferral                                                  */
/* -------------------------------------------------------------------------- */

describe("processScheduledContent defers (spec §11.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers a recap with week_not_final instead of writing an unfinished week", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const leagueId = await seedLeague(t);
    await seedAutomation(t, leagueId);

    // Every week of the season has matchups (so the older `no_matchups` gate
    // passes), and every week has one game still to play - whichever week the
    // execution-time stamp lands on, the finality gate is the one that fires.
    for (let week = 1; week <= 18; week++) {
      await seedWeek(t, leagueId, week, { settled: true, oneUnfinished: true });
    }

    const scheduledContentId = await seedScheduledRow(t, leagueId, "weekly_recap");
    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });

    expect(result).toMatchObject({ success: false, deferred: true, willRetry: true });
    expect(result.message).toBe("Deferred: week_not_final");

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("pending");
    expect(row?.deferrals).toBe(1);
    expect(row?.errorMessage).toMatch(/week_not_final/);
    // The deferral budget is separate from the retry budget: a long Monday
    // night must never cost the article an attempt.
    expect(row?.attempts).toBe(0);

    // Nothing was written.
    const articles = await t.run((ctx) =>
      ctx.db
        .query("aiContent")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(articles).toHaveLength(0);
  });

  it("generates once every matchup of the week has settled", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const leagueId = await seedLeague(t);
    await seedAutomation(t, leagueId);
    for (let week = 1; week <= 18; week++) {
      await seedWeek(t, leagueId, week, { settled: true });
    }

    const scheduledContentId = await seedScheduledRow(t, leagueId, "weekly_recap");
    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });

    expect(result.success).toBe(true);
    expect(result.contentId).toBeDefined();
  });

  it("defers with data_incomplete when the league has no teams", async () => {
    const t = makeTest();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(IN_SEASON);

    const leagueId = await seedLeague(t, { teams: 0 });
    await seedAutomation(t, leagueId);

    // `deferrals: 1` means this row has already spent its one re-sync, so the
    // gate answers from the database alone and no ESPN call is attempted.
    const scheduledContentId = await seedScheduledRow(t, leagueId, "trade_analysis", {
      deferrals: 1,
    });

    const result = await t.action(internal.contentScheduling.processScheduledContent, {
      scheduledContentId,
    });

    expect(result).toMatchObject({ success: false, deferred: true, willRetry: true });
    expect(result.message).toMatch(/^Deferred: data_incomplete/);

    const row = await t.run((ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("pending");
    expect(row?.deferrals).toBe(2);
    expect(row?.errorMessage).toMatch(/data_incomplete:teams/);
  });

  it("reports the missing core inputs per content type", async () => {
    const t = makeTest();
    const withTeams = await seedLeague(t);
    await seedWeek(t, withTeams, 5, { settled: true });

    const complete = await t.query(internal.contentScheduling.checkDataCompleteness, {
      leagueId: withTeams,
      contentType: "weekly_recap",
      seasonId: SEASON,
      week: 5,
    });
    expect(complete).toEqual({ complete: true, missing: [] });

    // The same league, a week nobody has played.
    const emptyWeek = await t.query(internal.contentScheduling.checkDataCompleteness, {
      leagueId: withTeams,
      contentType: "weekly_recap",
      seasonId: SEASON,
      week: 9,
    });
    expect(emptyWeek.complete).toBe(false);
    expect(emptyWeek.missing).toContain("matchups_week_9");
  });

  it("counts a one-value ADP column as a missing draft input (spec §11.1.3)", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);

    await t.run(async (ctx) => {
      const now = Date.now();
      // Twelve drafted players, every one of them at ESPN's placeholder ADP.
      const items = [];
      for (let i = 1; i <= 12; i++) {
        await ctx.db.insert("playersEnhanced", {
          espnId: String(i),
          season: SEASON,
          fullName: `Player ${i}`,
          defaultPositionId: 2,
          defaultPosition: "RB",
          eligibleSlots: [2],
          eligiblePositions: ["RB"],
          proTeamId: 1,
          active: true,
          injured: false,
          droppable: true,
          ownership: { percentOwned: 90, percentStarted: 80, averageDraftPosition: 170 },
          createdAt: now,
          updatedAt: now,
        });
        items.push({
          fromLineupSlotId: 0,
          fromTeamId: 0,
          isKeeper: false,
          overallPickNumber: i,
          playerId: i,
          toLineupSlotId: 0,
          toTeamId: 1,
          type: "ADD",
        });
      }
      await ctx.db.insert("transactions", {
        leagueId,
        seasonId: SEASON,
        espnTransactionId: "draft-1",
        bidAmount: 0,
        executionType: "EXECUTE",
        isActingAsTeamOwner: false,
        isLeagueManager: true,
        isPending: false,
        items,
        type: "DRAFT",
        proposedDate: now,
        status: "EXECUTED",
        scoringPeriod: 0,
        teamId: 1,
        createdAt: now,
      });
    });

    const graded = await t.query(internal.contentScheduling.checkDataCompleteness, {
      leagueId,
      contentType: "draft_rankings",
      seasonId: SEASON,
      week: 1,
    });
    expect(graded.complete).toBe(false);
    expect(graded.missing).toContain("draft_adp_placeholder");
  });
});

/* -------------------------------------------------------------------------- */
/* §11.2.9 publish gate                                                        */
/* -------------------------------------------------------------------------- */

describe("publish gate (spec §11.2.9)", () => {
  async function seedArticle(
    t: TestHarness,
    leagueId: Id<"leagues">,
    args: {
      reviewFlags?: Array<{
        kind: string;
        detail: string;
        severity: "block" | "strip" | "warn";
      }>;
      factsScore?: number;
      contradictions?: Array<{ claim: string; sectionName: string }>;
      wordCount?: number;
    } = {}
  ) {
    const wordCount = args.wordCount ?? 900;
    return await t.run(async (ctx) => {
      await ctx.db.insert("leagueContentPreferences", {
        leagueId,
        contentEnabled: true,
        timezone: "UTC",
        currentMonthSpent: 0,
        budgetResetDate: Date.now(),
        notifyCommissioner: true,
        notifyFailures: true,
        autoPublish: true,
        requireApproval: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      return await ctx.db.insert("aiContent", {
        leagueId,
        type: "weekly_recap",
        persona: "curtis-vaughn",
        title: "Week 5: the tightest margin of the year",
        content: Array.from({ length: wordCount }, (_, i) => `word${i}`).join(" "),
        metadata: { week: 5, featured_teams: [], credits_used: 0 },
        status: "draft",
        createdAt: Date.now(),
        reviewFlags: args.reviewFlags,
        generationStats: {
          blocks: (args.reviewFlags ?? []).filter((f) => f.severity === "block").length,
          strips: (args.reviewFlags ?? []).filter((f) => f.severity === "strip").length,
          warns: (args.reviewFlags ?? []).filter((f) => f.severity === "warn").length,
          sectionsRegenerated: 0,
          wordCount,
          editor:
            args.factsScore === undefined
              ? undefined
              : {
                  factsScore: args.factsScore,
                  voiceScore: 4,
                  contradictions: args.contradictions ?? [],
                  unsupported: [],
                  registerLeaks: [],
                  incompleteSections: [],
                },
        },
      });
    });
  }

  it("publishes a clean article", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    const articleId = await seedArticle(t, leagueId, { factsScore: 5 });

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });

    expect(result.published).toBe(true);
    expect(result.holdReasons).toEqual([]);
  });

  it("holds an article carrying a strip, with the reason named", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    const articleId = await seedArticle(t, leagueId, {
      factsScore: 5,
      reviewFlags: [
        { kind: "bad_number", detail: "Team 3 scored 141.2, not 151.2", severity: "strip" },
      ],
    });

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });

    expect(result.published).toBe(false);
    expect(result.holdReasons.join(" ")).toMatch(/removed text|bad_number/);

    const article = await t.run((ctx) => ctx.db.get(articleId));
    expect(article?.status).toBe("draft");
  });

  it("holds an article the editor scored below 3 on the facts with something cited", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    // No verifier findings at all - the editor is the only thing holding it, and it cited a claim.
    const articleId = await seedArticle(t, leagueId, {
      factsScore: 2,
      contradictions: [{ claim: "Ghost Back scored 40", sectionName: "introduction" }],
    });

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });

    expect(result.published).toBe(false);
    expect(result.blockingFlags).toBe(0);
    expect(result.holdReasons.join(" ")).toMatch(/editor scored the facts 2\/5/);
  });

  it("publishes an article the editor scored 2/5 without citing anything", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    // A low score with no findings is the rubric parse losing its notes, not a verdict.
    const articleId = await seedArticle(t, leagueId, { factsScore: 2 });

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });

    expect(result.published).toBe(true);
  });

  it("holds an article that came in under the word floor", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    // weekly_recap's ceiling is 1600 words, so the floor is 480.
    const articleId = await seedArticle(t, leagueId, { factsScore: 5, wordCount: 120 });

    const result = await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
    });

    expect(result.published).toBe(false);
    expect(result.holdReasons.join(" ")).toMatch(/word floor/);
  });

  it("persists the editor's verdict passed at finalize time", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    const articleId = await seedArticle(t, leagueId);

    await t.mutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId,
      generatedByUserId: "system",
      editor: {
        factsScore: 4,
        voiceScore: 3,
        contradictions: [],
        unsupported: [{ claim: "Team 4 is on a five-game run", sectionName: "the_chase" }],
        registerLeaks: [],
        incompleteSections: [],
        model: "claude-sonnet-5",
        costUsd: 0.02,
      },
    });

    const article = await t.run((ctx) => ctx.db.get(articleId));
    expect(article?.generationStats?.editor?.factsScore).toBe(4);
    expect(article?.generationStats?.editor?.unsupported?.[0]?.sectionName).toBe("the_chase");
  });
});

/* -------------------------------------------------------------------------- */
/* §11.3.10 operator digest                                                    */
/* -------------------------------------------------------------------------- */

describe("operator digest aggregation (spec §11.3.10)", () => {
  const SINCE = 1_000_000;
  const IN = SINCE + 1_000;
  const OUT = SINCE - 1_000;

  it("counts outcomes, flags, batch fallbacks and the decline rate", () => {
    const digest = aggregateLeagueDigest({
      since: SINCE,
      articles: [
        { status: "published", createdAt: IN, reviewFlags: [{ kind: "quote_not_placed" }] },
        { status: "published", createdAt: IN },
        {
          status: "draft",
          createdAt: IN,
          reviewFlags: [{ kind: "bad_number" }, { kind: "bad_number" }, { kind: "data_speak" }],
        },
        { status: "failed", createdAt: IN },
        // Outside the window: everything about it is ignored.
        { status: "published", createdAt: OUT, reviewFlags: [{ kind: "bad_number" }] },
      ],
      scheduledRows: [
        { status: "pending", updatedAt: IN, deferrals: 2, errorMessage: "Waiting on league data: week_not_final" },
        { status: "pending", updatedAt: IN, deferrals: 1, errorMessage: "Waiting on league data: data_incomplete:teams" },
        { status: "failed", updatedAt: IN, deferrals: 6, errorMessage: "Waiting on league data: espn_sync_failed" },
        {
          status: "completed",
          updatedAt: IN,
          batchSubmittedAt: IN,
          errorMessage: "Batch did not complete before print time; generating directly",
        },
        // Outside the window.
        { status: "pending", updatedAt: OUT, deferrals: 3 },
      ],
      commentRequests: [
        { status: "declined", createdAt: IN },
        { status: "completed", createdAt: IN },
        { status: "expired", createdAt: IN },
        { status: "declined", createdAt: OUT },
      ],
    });

    expect(digest.published).toBe(2);
    expect(digest.held).toBe(1);
    // One failed article, plus one scheduled row that ran out of deferrals
    // without ever producing one.
    expect(digest.failed).toBe(2);
    expect(digest.deferred).toBe(2);
    expect(digest.batchFallbacks).toBe(1);
    expect(digest.topFlagKinds).toEqual([
      { kind: "bad_number", count: 2 },
      { kind: "data_speak", count: 1 },
      { kind: "quote_not_placed", count: 1 },
    ]);
    expect(digest.interviewsRequested).toBe(3);
    expect(digest.interviewsDeclined).toBe(1);
    expect(digest.declineRate).toBeCloseTo(0.333, 3);
    expect(digest.active).toBe(true);
  });

  it("reports a quiet league as inactive, and no decline rate when nobody was asked", () => {
    const digest = aggregateLeagueDigest({
      since: SINCE,
      articles: [{ status: "published", createdAt: OUT }],
      scheduledRows: [],
      commentRequests: [],
    });

    expect(digest.active).toBe(false);
    // Nobody asked is not the same statement as "nobody declined".
    expect(digest.declineRate).toBeNull();
    expect(digest.topFlagKinds).toEqual([]);
  });

  it("caps the flag list at five kinds, worst first", () => {
    const kinds = ["a", "b", "c", "d", "e", "f", "g"];
    const digest = aggregateLeagueDigest({
      since: SINCE,
      articles: kinds.map((kind, i) => ({
        status: "draft",
        createdAt: IN,
        reviewFlags: Array.from({ length: kinds.length - i }, () => ({ kind })),
      })),
      scheduledRows: [],
      commentRequests: [],
    });

    expect(digest.topFlagKinds).toHaveLength(5);
    expect(digest.topFlagKinds.map((entry) => entry.kind)).toEqual(["a", "b", "c", "d", "e"]);
    expect(digest.topFlagKinds[0].count).toBe(7);
  });

  it("renders a league line an operator can read at a glance", () => {
    const line = formatLeagueDigestLine(
      "Quality Gate League",
      aggregateLeagueDigest({
        since: SINCE,
        articles: [{ status: "published", createdAt: IN }],
        scheduledRows: [],
        commentRequests: [{ status: "declined", createdAt: IN }],
      }),
      {
        automatedUsd: 12.5,
        interviewUsd: 2.5,
        capUsd: 60,
        weeklyRunRateUsd: 3.75,
        projectedSeasonUsd: 67.5,
      }
    );

    expect(line).toMatch(/Quality Gate League/);
    expect(line).toMatch(/published 1 · held 0 · failed 0 · deferred 0/);
    expect(line).toMatch(/\$15\.00 of \$60\.00 cap \(25%\)/);
    expect(line).toMatch(/interview declines 100% \(1\/1\)/);
  });

  it("reads one league's window straight off the database", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("aiContent", {
        leagueId,
        type: "weekly_recap",
        persona: "curtis-vaughn",
        title: "Filed",
        content: "Body copy.",
        metadata: { week: 5, featured_teams: [], credits_used: 0 },
        status: "published",
        createdAt: now - 60_000,
        seasonId: SEASON,
        generationStats: {
          blocks: 0,
          strips: 0,
          warns: 0,
          sectionsRegenerated: 0,
          costUsd: 0.2,
          billing: "pass" as const,
        },
      });
      await ctx.db.insert("aiContent", {
        leagueId,
        type: "power_rankings",
        persona: "nina-sharpe",
        title: "Held",
        content: "Body copy.",
        metadata: { week: 5, featured_teams: [], credits_used: 0 },
        status: "draft",
        createdAt: now - 60_000,
        seasonId: SEASON,
        reviewFlags: [{ kind: "bad_number", detail: "…", severity: "strip" as const }],
      });
      // A week old: outside the digest window, inside the season spend.
      await ctx.db.insert("aiContent", {
        leagueId,
        type: "weekly_preview",
        persona: "dex-alvarez",
        title: "Last week",
        content: "Body copy.",
        metadata: { week: 4, featured_teams: [], credits_used: 0 },
        status: "published",
        createdAt: now - 7 * 24 * 60 * 60 * 1000,
        seasonId: SEASON,
        generationStats: {
          blocks: 0,
          strips: 0,
          warns: 0,
          sectionsRegenerated: 0,
          costUsd: 0.3,
          billing: "pass" as const,
        },
      });
    });

    const row = await t.query(internal.deskMetrics.getLeagueDigest, {
      leagueId,
      since: now - 24 * 60 * 60 * 1000,
      now,
    });

    expect(row.leagueName).toBe("Quality Gate League");
    expect(row.digest).toMatchObject({ published: 1, held: 1, failed: 0, deferred: 0 });
    expect(row.digest.topFlagKinds).toEqual([{ kind: "bad_number", count: 1 }]);
    // Spend is the whole season, not the window.
    expect(row.spend.automatedUsd).toBeCloseTo(0.5, 4);
    expect(row.spend.capUsd).toBe(60);
    expect(row.spend.overCap).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* §11.3.12 dev-only guard                                                     */
/* -------------------------------------------------------------------------- */

describe("dev tools guard (spec §11.3.12)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a production deployment even with DEV_TOOLS_ENABLED set", () => {
    vi.stubEnv("CONVEX_DEPLOYMENT", "prod:sleepy-otter-42");
    vi.stubEnv("DEV_TOOLS_ENABLED", "1");
    expect(devToolsGuard().allowed).toBe(false);
  });

  it("allows a dev deployment, and an explicit opt-in", () => {
    vi.stubEnv("CONVEX_DEPLOYMENT", "dev:sleepy-otter-42");
    vi.stubEnv("DEV_TOOLS_ENABLED", "");
    expect(devToolsGuard().allowed).toBe(true);

    vi.stubEnv("CONVEX_DEPLOYMENT", "");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://sleepy-otter-42.convex.cloud");
    vi.stubEnv("DEV_TOOLS_ENABLED", "1");
    expect(devToolsGuard().allowed).toBe(true);
  });

  it("refuses an unrecognised deployment with no opt-in", () => {
    vi.stubEnv("CONVEX_DEPLOYMENT", "");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://sleepy-otter-42.convex.cloud");
    vi.stubEnv("DEV_TOOLS_ENABLED", "");
    const guard = devToolsGuard();
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toMatch(/DEV_TOOLS_ENABLED=1/);
  });
});
