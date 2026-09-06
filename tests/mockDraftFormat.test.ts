import { describe, expect, it } from "vitest";
import { draftTypeFromEspn, reversesEveryRound } from "../src/lib/ai/draftType";
import { PromptBuilder, type LeagueDataContext } from "../src/lib/ai/prompt-builder";
import { buildFactsBlock } from "../src/lib/ai/facts";
import { verifyArticle } from "../src/lib/ai/fact-verifier";
import { contentTemplates } from "../src/lib/ai/content-templates";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";

function leagueData(overrides: Partial<LeagueDataContext> = {}): LeagueDataContext {
  return {
    leagueName: "Format League",
    currentWeek: 0,
    currentSeason: 2026,
    teams: [
      { id: "t1", externalId: "1", name: "Halyard Bay", owner: "Hal Jones", manager: "Hal", record: { wins: 0, losses: 0, ties: 0 }, roster: [] },
      { id: "t2", externalId: "2", name: "Ridge Runners", owner: "Rita Park", manager: "Rita", record: { wins: 0, losses: 0, ties: 0 }, roster: [] },
      { id: "t3", externalId: "3", name: "Gravel Pit", owner: "Gus Lane", manager: "Gus", record: { wins: 0, losses: 0, ties: 0 }, roster: [] },
    ],
    totalTeams: 3,
    rosterSize: 16,
    standings: [],
    recentMatchups: [],
    upcomingMatchups: [],
    trades: [],
    transactions: [],
    draftOrder: [
      { position: 1, teamId: "1", teamName: "Halyard Bay", manager: "Hal" },
      { position: 2, teamId: "2", teamName: "Ridge Runners", manager: "Rita" },
      { position: 3, teamId: "3", teamName: "Gravel Pit", manager: "Gus" },
    ],
    draftType: "Snake",
    leagueType: "Redraft",
    availablePlayers: [
      { playerId: "4430807", playerName: "Bijan Robinson", position: "RB", ownership: { averageDraftPosition: 2.4 } },
      { playerId: "4426515", playerName: "Puka Nacua", position: "WR", ownership: { averageDraftPosition: 5.3 } },
    ],
    ...overrides,
  } as LeagueDataContext;
}

function prose(data: LeagueDataContext): string {
  const built = new PromptBuilder({ leagueId: "lg_format", contentType: "mock_draft", persona: "mel-diaper", leagueData: data }).build();
  return built.userPrompt.slice(built.userPrompt.indexOf("</FACTS>"));
}

function article(sections: Array<[string, string]>): GeneratedArticleT {
  return {
    title: "Mock",
    summary: "A mock.",
    sections: sections.map(([name, content]) => ({ name, content, wordCount: content.split(/\s+/).length })),
    featuredTeams: [],
    featuredPlayers: [],
    quotes: [],
    managerMentions: [],
    claims: [],
    tone: "dramatic",
  };
}

describe("draft type comes from ESPN, never assumed silently", () => {
  it("maps ESPN's vocabulary and flags anything unreported", () => {
    expect(draftTypeFromEspn("SNAKE")).toEqual({ draftType: "Snake", assumed: false });
    expect(draftTypeFromEspn("auction")).toEqual({ draftType: "Auction", assumed: false });
    expect(draftTypeFromEspn(undefined, "OFFLINE")).toEqual({ draftType: "Offline", assumed: false });
    expect(draftTypeFromEspn(undefined, undefined)).toEqual({ draftType: "Snake", assumed: true });
    expect(draftTypeFromEspn("SOMETHING_NEW")).toEqual({ draftType: "Snake", assumed: true });
    expect(reversesEveryRound("Snake")).toBe(true);
    expect(reversesEveryRound("Offline")).toBe(true);
    expect(reversesEveryRound("Auction")).toBe(false);
  });

  it("a snake draft prints round two's order turned, pick numbers continuing", () => {
    const text = prose(leagueData());
    expect(text).toContain("SNAKE DRAFT: the order reverses every round");
    expect(text).toContain("DRAFT ORDER (round 1):\n1. Halyard Bay (Hal) | 2. Ridge Runners (Rita) | 3. Gravel Pit (Gus)");
    expect(text).toContain("DRAFT ORDER (round 2, the snake turned - pick numbers 4-6):\n4. Gravel Pit (Gus) | 5. Ridge Runners (Rita) | 6. Halyard Bay (Hal)");
    expect(text).toContain("round two runs backwards exactly as DRAFT ORDER (round 2) prints it");
    expect(text).not.toContain("did not report a draft type");
  });

  it("an auction gets tiers and dollars, no slot numbering, and no slot check", () => {
    const data = leagueData({ draftType: "Auction", draftSettings: { auctionBudget: 200 } as LeagueDataContext["draftSettings"] });
    const text = prose(data);
    expect(text).toContain("AUCTION DRAFT: there is no pick order");
    expect(text).toContain("$200");
    expect(text).toContain("NOMINATION ORDER:");
    expect(text).toContain("top price tier");
    // The slot-numbering rule is the snake's; the auction text only mentions "1.01" to forbid it.
    expect(text).not.toContain("numbered the way a draft board reads");
    expect(text).not.toContain("DRAFT ORDER (round 2");
    const facts = buildFactsBlock({ contentType: "mock_draft", leagueData: data });
    expect(facts.mockDraft?.draftType).toBe("Auction");
    const violations = verifyArticle(article([["Tiers", "Bijan Robinson goes for $60 to Halyard Bay."]]), facts, { template: contentTemplates.mock_draft });
    expect(violations.some((v) => v.kind === "round_incomplete")).toBe(false);
  });

  it("an offline draft is run as a snake and says so; an unreported type is owned up to once", () => {
    expect(prose(leagueData({ draftType: "Offline" }))).toContain("OFFLINE DRAFT: ESPN does not run this one");
    const assumed = leagueData({ draftTypeAssumed: true });
    expect(prose(assumed)).toContain("ESPN did not report a draft type for this season; this mock treats it as a snake");
    const facts = buildFactsBlock({ contentType: "mock_draft", leagueData: assumed });
    expect(facts.mockDraft?.draftTypeAssumed).toBe(true);
    expect(facts.missing.some((line) => line.startsWith("draft type — ESPN did not report one"))).toBe(true);
    // A snake still gets the slot check.
    const snakeFacts = buildFactsBlock({ contentType: "mock_draft", leagueData: leagueData() });
    const violations = verifyArticle(article([["Round one", "1.01 Halyard Bay takes Bijan Robinson, ADP 2.4."]]), snakeFacts, { template: contentTemplates.mock_draft });
    expect(violations.filter((v) => v.kind === "round_incomplete").map((v) => v.detail.slice(0, 7))).toEqual(["round 1", "round 2"]);
  });
});
