import { describe, expect, it } from "vitest";
import { buildFactsBlock, serializeFacts } from "../src/lib/ai/facts";
import type { FactsRequest } from "../src/lib/ai/facts";
import { InsufficientDataError, PromptBuilder } from "../src/lib/ai/prompt-builder";
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";
import {
  parseQuoteDirectives,
  stripQuoteDirectives,
  verifyArticle,
} from "../src/lib/ai/fact-verifier";
import type { Violation } from "../src/lib/ai/fact-verifier";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";
import {
  DEFAULT_PERSONA,
  contentTypePersonaMap,
  getPersona,
  personaPrompts,
} from "../src/lib/ai/persona-prompts";

/**
 * The prompt layer is pure TypeScript (no Convex, no network): FACTS in, prompt out,
 * article + FACTS in, violations out. These tests pin the three contracts the Broadcast
 * Desk depends on - FACTS id resolution (spec §4.1), contract-first prompt order (§4.3)
 * and the deterministic verifier's block/strip/warn split (§4.5).
 */

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

const standings = [
  {
    rank: 1,
    team: "Alpha",
    teamId: "3",
    wins: 3,
    losses: 1,
    ties: 0,
    pointsFor: 421.7,
    pointsAgainst: 400,
    streakType: "W",
    streakLength: 2,
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

/** Generic-query shape: raw ESPN ids in `teamA`/`teamB`, names in `teamAName`/`teamBName`. */
const genericLeagueData = {
  leagueName: "Test League",
  currentWeek: 4,
  season: 2025,
  scoringType: "PPR",
  teams,
  standings,
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

/** Weekly-recap-query shape: the team *names* live in `teamA`/`teamB`. */
const recapLeagueData = {
  ...genericLeagueData,
  recentMatchups: [
    {
      teamA: "Alpha",
      teamB: "Beta",
      scoreA: 128.4,
      scoreB: 121.9,
      week: 4,
      topPerformers,
    },
  ],
} as unknown as LeagueDataContext;

const request = {
  leagueId: "lg1",
  contentType: "weekly_recap",
  persona: "curtis-vaughn",
  userId: "u1",
  leagueData: genericLeagueData,
  commentResponses: [
    {
      userId: "u2",
      userName: "Ann",
      teamId: "cxt1",
      teamName: "Alpha",
      questionTopic: "the bench points",
      quotes: ["I set that lineup Wednesday."],
      rawResponse: "I set that lineup Wednesday.",
    },
  ],
  nonRespondents: [
    { userId: "u3", userName: "Bob", teamName: "Beta", status: "no_response" as const },
  ],
  relationships: [
    {
      userId: "u3",
      teamId: "cxt2",
      teamName: "Beta",
      managerName: "Bob",
      score: -60,
      tier: "feud" as const,
      recentEvents: [
        {
          type: "article_roast",
          delta: -10,
          evidence: "called the lineup indefensible",
          week: 3,
        },
      ],
    },
  ],
  priorClaims: [],
} satisfies FactsRequest & { userId: string };

const facts = buildFactsBlock(request);

describe("FACTS block", () => {
  it("resolves the generic matchup shape (ids in teamA/teamB)", () => {
    expect(facts.teams.map((team) => team.id)).toEqual(["T3", "T7"]);
    expect(facts.matchups[0].home.teamId).toBe("T3");
    expect(facts.matchups[0].away.teamId).toBe("T7");
    expect(facts.matchups[0].winnerTeamId).toBe("T3");
    expect(facts.matchups[0].margin).toBe(6.5);
    expect(facts.matchups[0].players[0]).toMatchObject({
      id: "M1Pp1",
      fantasyTeamId: "T3",
      nflTeam: "BUF",
      lineup: "starter",
    });
  });

  it("resolves the weekly-recap matchup shape (names in teamA/teamB) to the same ids", () => {
    const recapFacts = buildFactsBlock({ ...request, leagueData: recapLeagueData });
    expect(recapFacts.matchups[0].home.teamId).toBe("T3");
    expect(recapFacts.matchups[0].away.teamId).toBe("T7");
    expect(recapFacts.matchups[0].margin).toBe(6.5);
  });

  it("carries quotes, non-respondents, relationships and gaps", () => {
    expect(facts.quotes[0]).toMatchObject({ id: "Q1", speaker: "Ann", teamId: "T3" });
    expect(facts.nonRespondents[0]).toMatchObject({ speaker: "Bob", teamId: "T7" });
    expect(facts.relationships[0]).toMatchObject({ teamId: "T7", tier: "feud", score: -60 });
    expect(facts.missing.some((gap) => gap.startsWith("priorClaims"))).toBe(true);
    expect(facts.missing.some((gap) => gap.includes("Bob (T7)"))).toBe(true);
    expect(serializeFacts(facts).startsWith("<FACTS>")).toBe(true);
  });
});

describe("prompt assembly", () => {
  it("puts the grounding contract before the persona voice, and FACTS first in the user prompt", () => {
    const built = new PromptBuilder({ ...request, includeExamples: true }).build();
    const contractIndex = built.systemPrompt.indexOf("GROUNDING CONTRACT");
    const voiceIndex = built.systemPrompt.indexOf(getPersona("curtis-vaughn").voice);

    expect(contractIndex).toBe(0);
    expect(voiceIndex).toBeGreaterThan(contractIndex);
    expect(built.systemPrompt.indexOf("WHO YOU ARE")).toBeLessThan(voiceIndex);
    expect(built.systemPrompt).toContain("RELATIONSHIPS");
    expect(built.systemPrompt).toContain("MISSING DATA");
    expect(built.userPrompt.startsWith("<FACTS>")).toBe(true);
    expect(built.facts.matchups).toHaveLength(1);
  });

  it("throws InsufficientDataError instead of inventing matchups", () => {
    const emptyData = { ...genericLeagueData, recentMatchups: [] } as LeagueDataContext;
    expect(() => new PromptBuilder({ ...request, leagueData: emptyData }).build()).toThrow(
      InsufficientDataError
    );
    expect(() => new PromptBuilder({ ...request, leagueData: emptyData }).build()).toThrow(
      /Not enough data/
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Verifier                                                                     */
/* -------------------------------------------------------------------------- */

const cleanArticle: GeneratedArticleT = {
  title: "Alpha holds serve",
  summary: "Alpha beat Beta by six and a half.",
  tone: "analytical",
  sections: [
    {
      name: "introduction",
      content: "Alpha beat Beta 128.4 to 121.9, a margin of 6.5.\n\n:::quote{id=Q1}",
      wordCount: 10,
    },
  ],
  featuredTeams: [{ teamId: "T3", teamName: "Alpha", mentions: 3 }],
  featuredPlayers: [
    {
      playerId: "M1Pp1",
      playerName: "QB One",
      position: "QB",
      fantasyTeamId: "T3",
      nflTeam: "BUF",
      mentions: 2,
    },
  ],
  keyStats: [
    { stat: "PF", value: "421.7", context: "season points", source: "teams.T3.pointsFor" },
  ],
  quotes: [
    {
      quoteId: "Q1",
      speaker: "Ann",
      teamId: "T3",
      text: "I set that lineup Wednesday.",
      questionTopic: "the bench points",
      sectionName: "introduction",
      writerResponse: "She did, and it cost her nothing.",
    },
  ],
  managerMentions: [],
  claims: [],
};

function verify(overrides: Partial<GeneratedArticleT>): Violation[] {
  return verifyArticle({ ...cleanArticle, ...overrides }, facts);
}

/**
 * Swaps the article body for one section of raw prose. The clean article places its ledger quote
 * with a `:::quote{id=Q1}` directive, so a body without that directive has to drop `quotes[]` too
 * or every case below would also report `quote_not_placed` (spec §8.3).
 */
function prose(content: string): Partial<GeneratedArticleT> {
  return {
    sections: [{ name: "introduction", content, wordCount: content.split(" ").length }],
    quotes: [],
  };
}

describe("verifier", () => {
  it("passes a clean, fully grounded article", () => {
    expect(verifyArticle(cleanArticle, facts)).toEqual([]);
  });

  it("blocks a player id that is not in FACTS", () => {
    const violations = verify({
      featuredPlayers: [
        {
          playerId: "M1P404",
          playerName: "Ghost Back",
          position: "RB",
          fantasyTeamId: "T3",
          nflTeam: "BUF",
          mentions: 1,
        },
      ],
    });
    expect(violations).toContainEqual({
      kind: "unknown_player",
      detail: "Ghost Back (M1P404)",
      severity: "block",
    });
  });

  it("blocks a quote whose text differs from the ledger", () => {
    const violations = verify({
      quotes: [{ ...cleanArticle.quotes[0], text: "I set that lineup on Thursday." }],
    });
    const badQuote = violations.find((violation) => violation.kind === "bad_quote");
    expect(badQuote).toMatchObject({ severity: "block", section: "introduction" });
    expect(badQuote?.detail).toContain("Thursday");
  });

  it("blocks a non-respondent presented as a speaker", () => {
    const structured = verify({
      quotes: [{ ...cleanArticle.quotes[0], speaker: "Bob", teamId: "T7" }],
    });
    expect(
      structured.some(
        (violation) =>
          violation.kind === "ghost_speaker" &&
          violation.severity === "block" &&
          violation.detail.includes("did not respond")
      )
    ).toBe(true);

    // ...and the same manager appearing beside quotation marks in prose.
    const inProse = verify(prose('Bob said "no comment."'));
    expect(inProse).toEqual([
      {
        kind: "ghost_speaker",
        detail: "bob did not respond but appears beside quoted text",
        section: "introduction",
        severity: "block",
      },
    ]);
  });

  it("strips a keyStat whose source path does not resolve, or whose value disagrees", () => {
    expect(
      verify({
        keyStats: [
          { stat: "PF", value: "421.7", context: "c", source: "teams.T404.pointsFor" },
        ],
      })
    ).toContainEqual({
      kind: "bad_source_path",
      detail: "PF: teams.T404.pointsFor",
      severity: "strip",
    });

    const mismatch = verify({
      keyStats: [{ stat: "PF", value: "999.9", context: "c", source: "teams.T3.pointsFor" }],
    });
    expect(mismatch).toContainEqual({
      kind: "unverified_number",
      detail: "PF=999.9 but teams.T3.pointsFor=421.7",
      severity: "strip",
    });
  });

  it("strips a quoted span of 25+ characters that is in no ledger quote", () => {
    const violations = verify(
      prose('The room heard "a completely invented sentence of prose."')
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "bad_quote",
      severity: "strip",
      section: "introduction",
    });
  });

  it("warns on a decimal that is neither in FACTS nor derivable", () => {
    expect(verify(prose("Alpha left 77.7 points on the bench."))).toContainEqual({
      kind: "unverified_number",
      detail: "77.7",
      section: "introduction",
      severity: "warn",
    });
  });

  it("blocks a :::quote directive whose id is not in the ledger", () => {
    const violations = verify({
      sections: [
        {
          name: "introduction",
          content: "Alpha held on.\n\n:::quote{id=Q1}\n\nAnd again.\n\n:::quote{id=Q9}",
          wordCount: 8,
        },
      ],
    });
    expect(violations).toContainEqual({
      kind: "unknown_quote_directive",
      detail: ":::quote{id=Q9} has no ledger entry",
      section: "introduction",
      severity: "block",
    });
    // The real Q1 directive is still recognised, so the quote is not also reported as unplaced.
    expect(violations.some((violation) => violation.kind === "quote_not_placed")).toBe(false);
  });

  it("warns when a reported quote never appears as a directive in the body", () => {
    const violations = verify({
      sections: [
        { name: "introduction", content: "Alpha beat Beta by 6.5.", wordCount: 5 },
      ],
    });
    expect(violations).toContainEqual({
      kind: "quote_not_placed",
      detail:
        "Q1 (Ann) is in quotes[] but no :::quote{id=Q1} directive appears in the body",
      section: "introduction",
      severity: "warn",
    });
    // A warning only: the quote still renders in the trailing block.
    expect(violations.every((violation) => violation.severity === "warn")).toBe(true);
  });

  it("parses and strips quote directives without touching the prose around them", () => {
    const body = "Alpha held on.\n\n:::quote{id=Q1}\n\nAnd that was that.";
    expect(parseQuoteDirectives(body)).toEqual(["Q1"]);
    expect(stripQuoteDirectives(body, new Set(["Q1"]))).toBe(
      "Alpha held on.\n\n\nAnd that was that."
    );
    expect(stripQuoteDirectives(body, new Set(["Q9"]))).toBe(body);
  });

  it("strips a claim whose team id is not in FACTS, and keeps a claim that is", () => {
    const violations = verify({
      claims: [
        { text: "Alpha wins the title.", kind: "team_finish", subjectTeamId: "T3", maxRank: 1 },
        { text: "Gamma wins week 5.", kind: "team_win", subjectTeamId: "T404", week: 5 },
      ],
    });
    expect(violations).toEqual([
      {
        kind: "bad_claim",
        detail: 'claim "Gamma wins week 5." subjectTeamId T404 is not a FACTS team id',
        severity: "strip",
      },
    ]);
  });

  it("accepts a decimal that is the sum of two FACTS numbers", () => {
    // 128.4 + 121.9 = 250.3
    const violations = verify(prose("Alpha and Beta combined for 250.3 points."));
    expect(violations.filter((v) => v.kind === "unverified_number")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Writer roster                                                                */
/* -------------------------------------------------------------------------- */

describe("writer roster", () => {
  it("has six writers and exactly one interviewer", () => {
    expect(Object.keys(personaPrompts)).toHaveLength(6);
    expect(
      Object.values(personaPrompts)
        .filter((persona) => persona.isInterviewer)
        .map((persona) => persona.slug)
    ).toEqual(["sam-ortega"]);
    for (const persona of Object.values(personaPrompts)) {
      expect(Object.keys(persona.relationshipPosture).sort()).toEqual([
        "cold",
        "favorite",
        "feud",
        "neutral",
        "warm",
      ]);
    }
  });

  it("falls back to Curtis Vaughn for an unknown slug", () => {
    expect(DEFAULT_PERSONA).toBe("curtis-vaughn");
    expect(getPersona("does-not-exist").slug).toBe("curtis-vaughn");
  });

  it("ships no invented statistic in an example output", () => {
    for (const persona of Object.values(personaPrompts)) {
      for (const example of persona.exampleOutputs) {
        expect(example, `${persona.slug} example output`).not.toMatch(/\d\.\d/);
      }
    }
  });

  it("only routes content types to active writers", () => {
    const active = new Set(Object.keys(personaPrompts));
    for (const [contentType, slugs] of Object.entries(contentTypePersonaMap)) {
      expect(slugs.length, `${contentType} has no writer`).toBeGreaterThan(0);
      for (const slug of slugs) {
        expect(active.has(slug), `${contentType} -> ${slug}`).toBe(true);
      }
    }
  });
});


/* -------------------------------------------------------------------------- */
/* Look-ahead slate (weekly_preview)                                            */
/* -------------------------------------------------------------------------- */

/** The generic payload plus the one thing a preview is actually about: an unplayed game. */
const previewLeagueData = {
  ...genericLeagueData,
  upcomingMatchups: [
    {
      week: 5,
      teamA: "Alpha",
      teamB: "Beta",
      teamAId: "3",
      teamBId: "7",
      teamAOwner: "Ann",
      teamBOwner: "Bob",
      teamARecord: "3-1-0",
      teamBRecord: "1-3-0",
      teamAPointsFor: 421.7,
      teamBPointsFor: 358.2,
      projectedScoreA: 118.2,
      projectedScoreB: 109.4,
      headToHead: { teamAWins: 1, teamBWins: 0 },
    },
  ],
} as unknown as LeagueDataContext;

const previewRequest = {
  ...request,
  contentType: "weekly_preview",
  leagueData: previewLeagueData,
};

const previewFacts = buildFactsBlock(previewRequest);

describe("look-ahead slate", () => {
  it("resolves both sides to the same ids as the rest of FACTS and carries no score", () => {
    expect(previewFacts.upcoming).toHaveLength(1);
    expect(previewFacts.upcoming[0]).toMatchObject({
      id: "U1",
      week: 5,
      home: { teamId: "T3", record: "3-1-0", pointsFor: 421.7, projected: 118.2 },
      away: { teamId: "T7", record: "1-3-0", pointsFor: 358.2, projected: 109.4 },
      headToHead: { homeWins: 1, awayWins: 0 },
    });
    expect(Object.keys(previewFacts.upcoming[0].home)).not.toContain("score");
    expect(previewFacts.missing).not.toContain("upcoming matchups — not available");
  });

  it("names the gap and refuses when there is no unplayed game, rather than recapping", () => {
    const noSlate = { ...request, contentType: "weekly_preview" };
    expect(buildFactsBlock(noSlate).upcoming).toEqual([]);
    expect(buildFactsBlock(noSlate).missing).toContain("upcoming matchups — not available");
    expect(() => new PromptBuilder(noSlate).build()).toThrow(InsufficientDataError);
  });

  it("tells the writer plainly that the game has not been played", () => {
    const built = new PromptBuilder(previewRequest).build();
    expect(built.systemPrompt).toContain("LOOK-AHEAD — THIS ARTICLE IS A PREVIEW");
    expect(built.systemPrompt).toContain("Future tense only.");
    expect(built.userPrompt).toContain("WEEK 5 SLATE — NONE OF THESE GAMES HAS BEEN PLAYED.");
    expect(built.userPrompt).toContain("Projected: 118.2 - 109.4 (a projection, not a result)");
    expect(built.userPrompt).toContain("Alpha last time out: week 4, beat Beta 128.4-121.9");
  });

  it("verifies a preview article with no new violation kinds", () => {
    const previewArticle: GeneratedArticleT = {
      ...cleanArticle,
      title: "Alpha hosts Beta",
      summary: "Alpha is projected ahead of Beta.",
      sections: [
        {
          name: "introduction",
          content: "Alpha is projected for 118.2 and Beta for 109.4.",
          wordCount: 9,
        },
      ],
      featuredTeams: [
        { teamId: "T3", teamName: "Alpha", mentions: 2 },
        { teamId: "T7", teamName: "Beta", mentions: 2 },
      ],
      featuredPlayers: [],
      keyStats: [
        {
          stat: "projection",
          value: "118.2",
          context: "week 5",
          source: "upcoming.U1.home.projected",
        },
      ],
      quotes: [],
    };

    expect(verifyArticle(previewArticle, previewFacts)).toEqual([]);
  });
});
