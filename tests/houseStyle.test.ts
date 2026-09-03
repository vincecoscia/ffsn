import { describe, expect, it } from "vitest";
import { buildHouseStyleBlock, GROUNDING_CONTRACT, PromptBuilder } from "../src/lib/ai/prompt-builder";
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";
import type { FactsRequest } from "../src/lib/ai/facts";

describe("buildHouseStyleBlock — HOUSE STYLE (team-first rules)", () => {
  it("always contains the team-first house style rules", () => {
    const block = buildHouseStyleBlock();
    expect(block).toContain("HOUSE STYLE");
    expect(block).toContain(
      "The team is the subject of results, records, scores, points and standings. Refer to a team by its team name, exactly as FACTS spells it."
    );
    expect(block).toContain("The manager is that team's general manager.");
    expect(block).toContain("Never write the manager as the one who scored, lost, or won; the team did that.");
    expect(block).toContain(
      "Headlines, titles, summaries and the first sentence name the team, not the manager."
    );
  });
});

describe("buildHouseStyleBlock — LANGUAGE tier text", () => {
  it("defaults to the clean tier when no rating is given", () => {
    const block = buildHouseStyleBlock();
    expect(block).toContain("LANGUAGE");
    expect(block).toContain("clean: No profanity of any kind.");
    expect(block).not.toContain("salty: Mild profanity is allowed");
    expect(block).not.toContain("unfiltered: Strong profanity is allowed");
  });

  it("emits only the salty tier text for languageRating: salty", () => {
    const block = buildHouseStyleBlock({ languageRating: "salty" });
    expect(block).toContain(
      "salty: Mild profanity is allowed (the mild tier: damn, hell, ass, crap, pissed, screwed, sucks)"
    );
    expect(block).not.toContain("clean: No profanity of any kind.");
    expect(block).not.toContain("unfiltered: Strong profanity is allowed");
  });

  it("emits only the unfiltered tier text for languageRating: unfiltered", () => {
    const block = buildHouseStyleBlock({ languageRating: "unfiltered" });
    expect(block).toContain("unfiltered: Strong profanity is allowed");
    expect(block).not.toContain("clean: No profanity of any kind.");
    expect(block).not.toContain("salty: Mild profanity is allowed");
  });

  it("always names the desk members who never swear, regardless of rating", () => {
    for (const rating of ["clean", "salty", "unfiltered"] as const) {
      const block = buildHouseStyleBlock({ languageRating: rating });
      expect(block).toContain("Curtis Vaughn, Dex Alvarez and Sam Ortega stay clean");
      expect(block).toContain("Nina Sharpe allows herself one dry one at unfiltered");
    }
  });
});

describe("buildHouseStyleBlock — clean-teams opt-down", () => {
  it("adds the clean-teams line only when cleanTeamNames is non-empty", () => {
    const withNames = buildHouseStyleBlock({ cleanTeamNames: ["Gravel Pit Grinders", "Ashby Avengers"] });
    expect(withNames).toContain(
      "These teams' managers asked for clean coverage; about them, and about their managers, write as if the rating were clean: Gravel Pit Grinders, Ashby Avengers."
    );

    expect(buildHouseStyleBlock()).not.toContain("asked for clean coverage");
    expect(buildHouseStyleBlock({ cleanTeamNames: [] })).not.toContain("asked for clean coverage");
  });
});

describe("buildHouseStyleBlock — show surface", () => {
  it("adds the show-only language line only when surface is 'show'", () => {
    expect(buildHouseStyleBlock()).not.toContain("In the show, cut-ins and reactions follow the same rating.");
    expect(buildHouseStyleBlock({ surface: "article" })).not.toContain(
      "In the show, cut-ins and reactions follow the same rating."
    );
    expect(buildHouseStyleBlock({ surface: "show" })).toContain(
      "In the show, cut-ins and reactions follow the same rating."
    );
  });
});

/* -------------------------------------------------------------------------- *
 * buildSystemPrompt integration — same minimal fixture shape as fact-verifier.test.ts.
 * -------------------------------------------------------------------------- */

const teams = [
  {
    id: "cxt1",
    name: "Alpha",
    manager: "Ann",
    externalId: "3",
    record: { wins: 3, losses: 1, ties: 0, pointsFor: 421.7 },
    pointsFor: 421.7,
    pointsAgainst: 400,
    roster: [{ playerId: "p1", playerName: "QB One", position: "QB", team: "BUF" }],
  },
  {
    id: "cxt2",
    name: "Beta",
    manager: "Bob",
    externalId: "7",
    record: { wins: 1, losses: 3, ties: 0, pointsFor: 358.2 },
    pointsFor: 358.2,
    pointsAgainst: 410,
    roster: [],
  },
];

const topPerformers = [
  {
    playerId: "p1",
    playerName: "QB One",
    position: "QB",
    points: 40.8,
    projectedPoints: 22.1,
    fantasyTeamName: "Alpha",
    nflTeam: "BUF",
    isStarter: true,
  },
];

const leagueData = {
  leagueName: "Test League",
  currentWeek: 4,
  season: 2025,
  scoringType: "PPR",
  teams,
  standings: [
    {
      rank: 1,
      team: "Alpha",
      teamId: "3",
      wins: 3,
      losses: 1,
      ties: 0,
      pointsFor: 421.7,
      pointsAgainst: 400,
    },
  ],
  recentMatchups: [
    {
      teamA: "3",
      teamB: "7",
      teamAName: "Alpha",
      teamBName: "Beta",
      scoreA: 128.4,
      scoreB: 121.9,
      week: 4,
      topPerformers,
    },
  ],
  transactions: [],
  trades: [],
} as unknown as LeagueDataContext;

const baseRequest = {
  leagueId: "lg1",
  contentType: "weekly_recap",
  persona: "curtis-vaughn",
  leagueData,
  commentResponses: [],
  nonRespondents: [],
  relationships: [],
  priorClaims: [],
} satisfies FactsRequest;

describe("buildSystemPrompt — house style placement", () => {
  it("places HOUSE STYLE right after GROUNDING CONTRACT and before WHO YOU ARE", () => {
    const built = new PromptBuilder(baseRequest).build();
    const contractIndex = built.systemPrompt.indexOf("GROUNDING CONTRACT");
    const houseStyleIndex = built.systemPrompt.indexOf("HOUSE STYLE");
    const whoYouAreIndex = built.systemPrompt.indexOf("WHO YOU ARE");

    expect(contractIndex).toBe(0);
    expect(built.systemPrompt.indexOf(GROUNDING_CONTRACT)).toBe(0);
    expect(houseStyleIndex).toBeGreaterThan(contractIndex);
    expect(whoYouAreIndex).toBeGreaterThan(houseStyleIndex);
  });

  it("defaults to the clean tier when PromptBuilderOptions carries no languageRating", () => {
    const built = new PromptBuilder(baseRequest).build();
    expect(built.systemPrompt).toContain("clean: No profanity of any kind.");
  });

  it("threads languageRating and cleanTeamNames from PromptBuilderOptions into the emitted block", () => {
    const built = new PromptBuilder({
      ...baseRequest,
      languageRating: "unfiltered",
      cleanTeamNames: ["Alpha"],
    }).build();

    expect(built.systemPrompt).toContain("unfiltered: Strong profanity is allowed");
    expect(built.systemPrompt).toContain("write as if the rating were clean: Alpha.");
  });
});
