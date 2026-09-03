import { describe, expect, it } from "vitest";
import { buildFactsBlock } from "../src/lib/ai/facts";
import type { FactsRequest } from "../src/lib/ai/facts";
import { PromptBuilder } from "../src/lib/ai/prompt-builder";
import type { LeagueDataContext, WaiverLedger } from "../src/lib/ai/prompt-builder";
import { verifyArticle } from "../src/lib/ai/fact-verifier";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";

/**
 * The FAAB/waiver ledger (owner goal, 2026-09-02: the waiver wire report must take FAAB spend into
 * account — winning bids, losing bids, each team's remaining budget, season highlights, and Sam's
 * interview questions should all use these numbers). This is the pure prompt-layer half: FACTS in,
 * `facts.waivers` W…/B… lines out, verified by the deterministic `faab_amount_unverified` check.
 *
 * The names below ("Gabe Coscia", "Moisty Loins", "Team Rive") match the owner's own worked example
 * in the goal so the exact rendered line can be asserted character for character. The winning
 * bid/period (Tank Bigsby, $41, week 5) matches the live ESPN fixture
 * (tests/fixtures/espn-transactions-public.json, player 4362478, scoring period 5) that
 * `convex/aiQueries.ts#buildWaiverLedger` is verified against in tests/waiverLedger.test.ts.
 */

const waiverTeams = [
  {
    id: "cxt1",
    name: "Gabe's Gang",
    manager: "Gabe Coscia",
    externalId: "1",
    record: { wins: 3, losses: 1, ties: 0, pointsFor: 400 },
    pointsFor: 400,
    pointsAgainst: 380,
    roster: [],
  },
  {
    id: "cxt2",
    name: "Moisty Loins",
    manager: "Manny",
    externalId: "2",
    record: { wins: 2, losses: 2, ties: 0, pointsFor: 390 },
    pointsFor: 390,
    pointsAgainst: 385,
    roster: [],
  },
  {
    id: "cxt3",
    name: "Team Rive",
    manager: "Riv",
    externalId: "3",
    record: { wins: 1, losses: 3, ties: 0, pointsFor: 370 },
    pointsFor: 370,
    pointsAgainst: 400,
    roster: [],
  },
] as unknown as LeagueDataContext["teams"];

const faabWaivers: WaiverLedger = {
  latestRun: {
    scoringPeriod: 4,
    claims: [
      {
        week: 4,
        player: { id: "4362478", name: "Tank Bigsby", pos: "RB", nflTeam: "JAX" },
        teamId: "cxt1",
        teamName: "Gabe's Gang",
        manager: "Gabe Coscia",
        bid: 23,
        competingBids: [
          { teamId: "cxt2", teamName: "Moisty Loins", bid: 17 },
          { teamId: "cxt3", teamName: "Team Rive", bid: 12 },
        ],
        dropped: { name: "Zach Charbonnet", pos: "RB" },
      },
    ],
  },
  budgets: [
    {
      teamId: "cxt1",
      teamName: "Gabe's Gang",
      manager: "Gabe Coscia",
      budget: 100,
      spent: 77,
      remaining: 23,
      acquisitions: 3,
    },
    {
      teamId: "cxt2",
      teamName: "Moisty Loins",
      manager: "Manny",
      budget: 100,
      spent: 39,
      remaining: 61,
      acquisitions: 7,
    },
  ],
  season: {
    biggestBid: { teamId: "cxt1", teamName: "Gabe's Gang", player: "Tank Bigsby", bid: 23, week: 4 },
    mostActive: { teamId: "cxt2", teamName: "Moisty Loins", acquisitions: 7 },
    lowestRemaining: [{ teamId: "cxt1", teamName: "Gabe's Gang", remaining: 23 }],
    totalSpent: 116,
    averageWinningBid: 19.3,
  },
  waiverType: "faab",
  budget: 100,
};

const baseLeagueData = {
  leagueName: "Waiver Test League",
  currentWeek: 4,
  season: 2025,
  scoringType: "PPR",
  teams: waiverTeams,
  standings: [],
  recentMatchups: [],
  availablePlayers: [
    { playerId: "p999", playerName: "Depth Chart Guy", position: "RB", team: "ATL" },
  ],
  transactions: [],
  trades: [],
  leagueFormat: { waiverType: "faab", faabBudget: 100 },
  waivers: faabWaivers,
} as unknown as LeagueDataContext;

const waiverRequest = {
  leagueId: "lg1",
  contentType: "waiver_wire_report",
  persona: "nina-sharpe",
  userId: "u1",
  leagueData: baseLeagueData,
  priorClaims: [],
} satisfies FactsRequest & { userId: string };

describe("FACTS waivers (buildWaivers)", () => {
  const facts = buildFactsBlock(waiverRequest);

  it("assigns W…/B… ids and resolves team ids through the same TeamIndex as everything else", () => {
    expect(facts.waivers.isFaab).toBe(true);
    expect(facts.waivers.latestRun?.week).toBe(4);
    expect(facts.waivers.latestRun?.claims).toHaveLength(1);
    expect(facts.waivers.latestRun?.claims[0].id).toBe("W1");
    expect(facts.waivers.latestRun?.claims[0].teamId).toBe("T1");
    expect(facts.waivers.latestRun?.claims[0].competingBids).toEqual([
      { teamId: "T2", teamName: "Moisty Loins", bid: 17 },
      { teamId: "T3", teamName: "Team Rive", bid: 12 },
    ]);
    expect(facts.waivers.budgets[0].id).toBe("B1");
    expect(facts.waivers.budgets[1].id).toBe("B2");
  });

  it("renders the exact Broadcast-register lines from the owner's worked example", () => {
    expect(facts.waivers.latestRun?.claims[0].line).toBe(
      "W1 · Week 4 · Gabe Coscia won Tank Bigsby for $23 (outbid Moisty Loins $17, Team Rive $12); dropped Zach Charbonnet"
    );
    expect(facts.waivers.budgets[1].line).toBe("B2 · Moisty Loins: $61 of $100 left, 7 pickups");
  });

  it("non-FAAB league: isFaab is false, no claims/budgets, and the missing note names the format", () => {
    const priorityLeagueData = {
      ...baseLeagueData,
      leagueFormat: { waiverType: "waivers" },
      waivers: { ...faabWaivers, waiverType: "waivers", latestRun: undefined, budgets: [] },
    } as unknown as LeagueDataContext;
    const priorityFacts = buildFactsBlock({ ...waiverRequest, leagueData: priorityLeagueData });

    expect(priorityFacts.waivers.isFaab).toBe(false);
    expect(priorityFacts.waivers.latestRun).toBeUndefined();
    expect(priorityFacts.waivers.budgets).toHaveLength(0);
    expect(priorityFacts.missing.some((gap) => gap.startsWith("FAAB ledger"))).toBe(true);
  });

  it("empty ledger (FAAB league, no claims processed yet): missing note says so", () => {
    const emptyLedgerData = {
      ...baseLeagueData,
      waivers: { ...faabWaivers, latestRun: undefined, budgets: [] },
    } as unknown as LeagueDataContext;
    const emptyFacts = buildFactsBlock({ ...waiverRequest, leagueData: emptyLedgerData });

    expect(emptyFacts.waivers.isFaab).toBe(true);
    expect(emptyFacts.missing).toContain("waiver claims — no waiver claims recorded this season");
  });
});

describe("prompt assembly: waiver ledger", () => {
  it("the waiver_wire_report user prompt carries the no-estimate rule and the W… line", () => {
    const built = new PromptBuilder(waiverRequest).build();
    expect(built.userPrompt).toContain(
      "Every dollar figure and every claim below must come from one of these lines; never estimate a bid or a remaining budget."
    );
    expect(built.userPrompt).toContain(
      "W1 · Week 4 · Gabe Coscia won Tank Bigsby for $23 (outbid Moisty Loins $17, Team Rive $12); dropped Zach Charbonnet"
    );
    expect(built.userPrompt).toContain("B2 · Moisty Loins: $61 of $100 left, 7 pickups");
  });

  it("a non-FAAB league's waiver prompt never mentions a dollar figure", () => {
    const priorityLeagueData = {
      ...baseLeagueData,
      leagueFormat: { waiverType: "waivers" },
      waivers: { ...faabWaivers, waiverType: "waivers", latestRun: undefined, budgets: [] },
    } as unknown as LeagueDataContext;
    const built = new PromptBuilder({ ...waiverRequest, leagueData: priorityLeagueData }).build();
    const waiverSection = built.userPrompt.slice(built.userPrompt.indexOf("WAIVER TYPE:"));
    expect(waiverSection).toContain("this league does not use FAAB");
    expect(waiverSection.split("FAAB WAIVER LEDGER")[0]).not.toMatch(/\$\d/);
  });

  it("weekly_recap and power_rankings get an optional one-line waiver hook, never the FAAB ledger rules block", () => {
    const recapData = { ...baseLeagueData, recentMatchups: [
      { teamA: "1", teamB: "2", teamAName: "Gabe's Gang", teamBName: "Moisty Loins", scoreA: 100, scoreB: 90, week: 4 },
    ] } as unknown as LeagueDataContext;
    const recapBuilt = new PromptBuilder({ ...waiverRequest, contentType: "weekly_recap", persona: "curtis-vaughn", leagueData: recapData }).build();
    expect(recapBuilt.userPrompt).toContain("facts.waivers");
    expect(recapBuilt.userPrompt).not.toContain("Every dollar figure and every claim below must come from");

    const rankingsBuilt = new PromptBuilder({ ...waiverRequest, contentType: "power_rankings", persona: "nina-sharpe", leagueData: recapData }).build();
    expect(rankingsBuilt.userPrompt).toContain("FAAB remaining is a standings-adjacent fact");
  });
});

/* -------------------------------------------------------------------------- *
 * Verifier: faab_amount_unverified (spec: dollar amounts in a waiver article must match a W/B line)
 * -------------------------------------------------------------------------- */

const facts = buildFactsBlock(waiverRequest);

function articleWithBody(content: string): GeneratedArticleT {
  return {
    title: "Waiver Wire Report",
    summary: "The week's claims.",
    sections: [{ name: "Claims", content, wordCount: content.split(/\s+/).length }],
    featuredTeams: [],
    featuredPlayers: [],
    quotes: [],
    managerMentions: [],
    tone: "analytical",
  };
}

describe("verifier: faab_amount_unverified", () => {
  it("flags an invented $40 that matches no W/B line", () => {
    const article = articleWithBody("Somebody spent $40 on a corpse this week.");
    const violations = verifyArticle(article, facts);
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: "faab_amount_unverified", detail: "$40", severity: "warn" })
    );
  });

  it("accepts $23 (the real winning bid from the ledger)", () => {
    const article = articleWithBody("Gabe Coscia paid $23 for Tank Bigsby, outbidding the field.");
    const violations = verifyArticle(article, facts);
    expect(violations.some((v) => v.kind === "faab_amount_unverified")).toBe(false);
  });

  it("accepts every other ledger figure: losing bids, budgets remaining, and the season total", () => {
    const article = articleWithBody(
      "Moisty Loins bid $17 and lost, Team Rive tried $12. Moisty Loins still has $61 of a $100 budget. League-wide FAAB spend sits at $116."
    );
    const violations = verifyArticle(article, facts);
    expect(violations.filter((v) => v.kind === "faab_amount_unverified")).toHaveLength(0);
  });

  it("joins waiver-ledger player and drop names to the known-names index (no unknown_player warning)", () => {
    const article = articleWithBody(
      "Tank Bigsby was the prize, and Zach Charbonnet had to go to make room for him."
    );
    const violations = verifyArticle(article, facts);
    expect(violations.filter((v) => v.kind === "unknown_player")).toHaveLength(0);
  });
});
