import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2025;
const CLERK_COMMISSIONER = "clerk_desk_commissioner";
const CLERK_MEMBER = "clerk_desk_member";

/**
 * `getDeskMetrics` reads only `aiContent`, so the seed is one league, one commissioner, one plain
 * member (for the negative auth case) and the articles themselves. The two articles are built to
 * make every branch of the maths visible:
 *
 *   Mel      1,000 words, 4 ungrounded findings, 4 of 6 ledger quotes used, 200 facts
 *   Curtis     500 words, 0 ungrounded findings, no quotes offered, 250 facts
 *
 * League-wide that is 4 findings over 1,500 words (2.67 per 1k), 4/6 quote fidelity, and
 * 1,500 words over 450 facts (3.33 words per fact).
 */
async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();

  const leagueId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("leagues", {
      name: "Desk Metrics Test League",
      platform: "espn",
      externalId: "9101",
      commissionerUserId: CLERK_COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 7,
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

    await ctx.db.insert("leagueMemberships", {
      leagueId: id,
      userId: CLERK_COMMISSIONER,
      role: "commissioner",
      joinedAt: now,
    });
    await ctx.db.insert("leagueMemberships", {
      leagueId: id,
      userId: CLERK_MEMBER,
      role: "member",
      joinedAt: now,
    });

    return id;
  });

  return { t, leagueId, now };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function insertArticle(
  t: Setup["t"],
  leagueId: Setup["leagueId"],
  args: {
    persona: string;
    title: string;
    content: string;
    createdAt: number;
    generationStats?: {
      blocks: number;
      strips: number;
      warns: number;
      sectionsRegenerated: number;
      factsCount?: number;
      wordCount?: number;
      quotesOffered?: number;
      quotesUsed?: number;
    };
    reviewFlags?: Array<{
      kind: string;
      detail: string;
      section?: string;
      severity: "block" | "strip" | "warn";
    }>;
  }
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("aiContent", {
      leagueId,
      type: "weekly_recap",
      persona: args.persona,
      title: args.title,
      content: args.content,
      metadata: { week: 7, featured_teams: [], credits_used: 10 },
      status: "published",
      createdAt: args.createdAt,
      generationStats: args.generationStats,
      reviewFlags: args.reviewFlags,
    })
  );
}

async function seedTwoArticles(t: Setup["t"], leagueId: Setup["leagueId"], now: number) {
  const melId = await insertArticle(t, leagueId, {
    persona: "mel-diaper",
    title: "Nineteen picks of air",
    content: "body",
    createdAt: now - 60_000,
    generationStats: {
      blocks: 1,
      strips: 3,
      warns: 2,
      sectionsRegenerated: 1,
      factsCount: 200,
      wordCount: 1000,
      quotesOffered: 6,
      quotesUsed: 4,
    },
    reviewFlags: [
      { kind: "bad_quote", detail: "not in the ledger", section: "grades", severity: "block" },
      { kind: "unverified_number", detail: "77.7", section: "grades", severity: "warn" },
    ],
  });

  const curtisId = await insertArticle(t, leagueId, {
    persona: "curtis-vaughn",
    title: "Top of the show",
    content: "body",
    createdAt: now - 30_000,
    generationStats: {
      blocks: 0,
      strips: 0,
      warns: 0,
      sectionsRegenerated: 0,
      factsCount: 250,
      wordCount: 500,
    },
    reviewFlags: [],
  });

  return { melId, curtisId };
}

describe("deskMetrics.getDeskMetrics", () => {
  it("computes ungrounded rate, quote fidelity and padding index per writer and league-wide", async () => {
    const { t, leagueId, now } = await setup();
    const { melId } = await seedTwoArticles(t, leagueId, now);

    const asCommissioner = t.withIdentity({ subject: CLERK_COMMISSIONER });
    const metrics = await asCommissioner.query(api.deskMetrics.getDeskMetrics, { leagueId, now });

    expect(metrics.sinceDays).toBeNull();
    expect(metrics.truncated).toBe(false);

    // 4 findings over 1,500 words; 4 of 6 quotes; 1,500 words over 450 facts.
    expect(metrics.league).toEqual({
      articles: 2,
      ungroundedPer1k: 2.67,
      quoteFidelity: 0.667,
      paddingIndex: 3.33,
    });

    const mel = metrics.perWriter.find((writer) => writer.persona === "mel-diaper");
    expect(mel).toEqual({
      persona: "mel-diaper",
      articles: 1,
      ungroundedPer1k: 4,
      quoteFidelity: 0.667,
      paddingIndex: 5,
    });

    // No quotes were offered to Curtis, which is not the same as a fidelity of zero.
    const curtis = metrics.perWriter.find((writer) => writer.persona === "curtis-vaughn");
    expect(curtis).toEqual({
      persona: "curtis-vaughn",
      articles: 1,
      ungroundedPer1k: 0,
      quoteFidelity: null,
      paddingIndex: 2,
    });

    // Newest flag first, carrying enough to open the article it came from.
    expect(metrics.recentFlags).toHaveLength(2);
    expect(metrics.recentFlags[0]).toMatchObject({
      articleId: melId,
      title: "Nineteen picks of air",
      persona: "mel-diaper",
      severity: "block",
      kind: "bad_quote",
      section: "grades",
    });
    expect(metrics.recentFlags.map((flag) => flag.severity)).toEqual(["block", "warn"]);
  });

  it("falls back to the stored body and the review flags when generationStats is absent", async () => {
    const { t, leagueId, now } = await setup();
    await insertArticle(t, leagueId, {
      persona: "walt-brennan",
      title: "An old column",
      // Six words, and two findings the verifier acted on (the warn does not count).
      content: "one two three four five six",
      createdAt: now - 1000,
      reviewFlags: [
        { kind: "bad_quote", detail: "invented", severity: "block" },
        { kind: "bad_source_path", detail: "teams.T404.pointsFor", severity: "strip" },
        { kind: "unknown_player", detail: "Ghost Back", severity: "warn" },
      ],
    });

    const metrics = await t
      .withIdentity({ subject: CLERK_COMMISSIONER })
      .query(api.deskMetrics.getDeskMetrics, { leagueId, now });

    expect(metrics.perWriter).toEqual([
      {
        persona: "walt-brennan",
        articles: 1,
        // 2 of 6 words -> 333.33 per 1,000.
        ungroundedPer1k: 333.33,
        quoteFidelity: null,
        paddingIndex: null,
      },
    ]);
    expect(metrics.recentFlags).toHaveLength(3);
  });

  it("honours sinceDays and returns empty metrics when the window is empty", async () => {
    const { t, leagueId, now } = await setup();
    await seedTwoArticles(t, leagueId, now);
    await insertArticle(t, leagueId, {
      persona: "nina-sharpe",
      title: "Two numbers, one caveat",
      content: "body",
      createdAt: now - 40 * 24 * 60 * 60 * 1000,
      generationStats: {
        blocks: 5,
        strips: 5,
        warns: 0,
        sectionsRegenerated: 0,
        factsCount: 10,
        wordCount: 100,
      },
    });

    const asCommissioner = t.withIdentity({ subject: CLERK_COMMISSIONER });

    const recent = await asCommissioner.query(api.deskMetrics.getDeskMetrics, {
      leagueId,
      sinceDays: 7,
      now,
    });
    expect(recent.sinceDays).toBe(7);
    expect(recent.perWriter.map((writer) => writer.persona).sort()).toEqual([
      "curtis-vaughn",
      "mel-diaper",
    ]);

    const everything = await asCommissioner.query(api.deskMetrics.getDeskMetrics, { leagueId, now });
    expect(everything.perWriter).toHaveLength(3);

    const emptyWindow = await asCommissioner.query(api.deskMetrics.getDeskMetrics, {
      leagueId,
      sinceDays: 0.0001,
      now,
    });
    expect(emptyWindow.perWriter).toEqual([]);
    expect(emptyWindow.league).toEqual({
      articles: 0,
      ungroundedPer1k: null,
      quoteFidelity: null,
      paddingIndex: null,
    });
    expect(emptyWindow.recentFlags).toEqual([]);
  });

  it("refuses a league member who is not the commissioner, and anyone signed out", async () => {
    const { t, leagueId, now } = await setup();
    await seedTwoArticles(t, leagueId, now);

    await expect(
      t.withIdentity({ subject: CLERK_MEMBER }).query(api.deskMetrics.getDeskMetrics, { leagueId, now })
    ).rejects.toThrow(/commissioner role required/);

    await expect(
      t.query(api.deskMetrics.getDeskMetrics, { leagueId, now })
    ).rejects.toThrow(/not a member of this league/);
  });
});
