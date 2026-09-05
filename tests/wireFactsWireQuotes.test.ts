import { describe, expect, it } from "vitest";
import { formatCommentsForPrompt } from "../src/lib/ai/comment-integration";
import { withQuoteSources, type GeneratedArticleT } from "../src/lib/ai/content-generation-service";
import { buildFactsBlock, type FactsRequest } from "../src/lib/ai/facts";
import { verifyArticle } from "../src/lib/ai/fact-verifier";
import { PromptBuilder, type LeagueDataContext } from "../src/lib/ai/prompt-builder";

/**
 * Wire statements as article quotes (spec §17.4): a manager's public post on The Wire reaches the
 * article writers through the same ledger as an interview quote — same Q ids, same verifier, same
 * pull-quote directive — carrying `source: "wire"` so the prompt attributes it as said on The Wire
 * and the stored article keeps the provenance.
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
  { rank: 1, team: "Alpha", teamId: "3", wins: 3, losses: 1, ties: 0, pointsFor: 421.7, pointsAgainst: 400, streakType: "W", streakLength: 2 },
  { rank: 2, team: "Beta", teamId: "7", wins: 1, losses: 3, ties: 0, pointsFor: 358.2, pointsAgainst: 410, streakType: "L", streakLength: 2 },
];

const topPerformers = [
  { playerId: "p1", playerName: "QB One", position: "QB", points: 40.8, projectedPoints: 22.1, fantasyTeamName: "Alpha", nflTeam: "BUF", isStarter: true },
];

const leagueData = {
  leagueName: "Test League",
  currentWeek: 4,
  season: 2025,
  scoringType: "PPR",
  teams,
  standings,
  recentMatchups: [
    { teamA: "3", teamB: "7", teamAName: "Alpha", teamBName: "Beta", scoreA: 128.4, scoreB: 121.9, week: 4, topPerformers },
  ],
  transactions: [],
  trades: [],
} as unknown as LeagueDataContext;

const request = {
  leagueId: "lg1",
  contentType: "weekly_recap",
  persona: "curtis-vaughn",
  userId: "u1",
  leagueData,
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
    {
      userId: "u3",
      userName: "Bob",
      teamId: "cxt2",
      teamName: "Beta",
      questionTopic: "the week 4 loss",
      quotes: ["Refs took that one from me.", "Not worried."],
      rawResponse: "Refs took that one from me. Not worried.",
      source: "wire" as const,
    },
  ],
  nonRespondents: [],
  relationships: [],
  priorClaims: [],
} satisfies FactsRequest & { userId: string };

const facts = buildFactsBlock(request);

const wireArticle: GeneratedArticleT = {
  title: "Alpha holds off Beta",
  summary: "Alpha beat Beta by 6.5. Bob blamed the refs on The Wire.",
  tone: "analytical",
  sections: [
    {
      name: "introduction",
      content: "Alpha beat Beta 128.4 to 121.9, a margin of 6.5. Bob said on The Wire that the refs took it.\n\n:::quote{id=Q2}",
      wordCount: 20,
    },
  ],
  featuredTeams: [{ teamId: "T3", teamName: "Alpha", mentions: 3 }],
  featuredPlayers: [
    { playerId: "M1Pp1", playerName: "QB One", position: "QB", fantasyTeamId: "T3", nflTeam: "BUF", mentions: 2 },
  ],
  keyStats: [],
  quotes: [
    {
      quoteId: "Q2",
      speaker: "Bob",
      teamId: "T7",
      text: "Refs took that one from me.",
      questionTopic: "the week 4 loss",
      sectionName: "introduction",
      writerResponse: "The box score has a different culprit.",
      source: "wire",
    },
  ],
  managerMentions: [],
  claims: [],
};

describe("FACTS ledger with wire statements", () => {
  it("assigns Q ids across interview and wire responses and carries the source", () => {
    expect(facts.quotes).toEqual([
      { id: "Q1", speaker: "Ann", teamId: "T3", questionTopic: "the bench points", text: "I set that lineup Wednesday.", source: "interview" },
      { id: "Q2", speaker: "Bob", teamId: "T7", questionTopic: "the week 4 loss", text: "Refs took that one from me.", source: "wire" },
      { id: "Q3", speaker: "Bob", teamId: "T7", questionTopic: "the week 4 loss", text: "Not worried.", source: "wire" },
    ]);
  });

  it("tells the writer how to attribute a wire quote, and shows the source in FACTS", () => {
    const built = new PromptBuilder(request).build();
    expect(built.systemPrompt).toContain('A quote whose source is "wire" is something the manager posted publicly on The Wire');
    expect(built.systemPrompt).toContain("never as told to Sam or to the sideline, and never as an interview");
    expect(built.userPrompt).toContain('"source": "wire"');
  });

  it("renders a wire response as posted on The Wire in the readable ledger", () => {
    const rendered = formatCommentsForPrompt({ commentResponses: request.commentResponses, contentType: "weekly_recap" });
    expect(rendered).toContain("## Ann — Alpha\nAsked about: the bench points");
    expect(rendered).toContain("## Bob — Beta\nPosted on The Wire, the league's live feed — not an interview. About: the week 4 loss");
  });
});

describe("verifier with wire quotes", () => {
  it("accepts a verbatim wire quote attributed as said on The Wire", () => {
    expect(verifyArticle(wireArticle, facts)).toEqual([]);
  });

  it("still rejects a paraphrase of a wire quote", () => {
    const paraphrased: GeneratedArticleT = {
      ...wireArticle,
      quotes: [{ ...wireArticle.quotes[0], text: "The refs took that one from me." }],
    };
    const violations = verifyArticle(paraphrased, facts);
    expect(violations.some(violation => violation.kind === "bad_quote" && violation.severity === "block")).toBe(true);
  });

  it("still rejects a wire quote attributed to the wrong speaker", () => {
    const misattributed: GeneratedArticleT = {
      ...wireArticle,
      quotes: [{ ...wireArticle.quotes[0], speaker: "Ann", teamId: "T3" }],
    };
    expect(verifyArticle(misattributed, facts).some(violation => violation.kind === "ghost_speaker")).toBe(true);
  });
});

describe("withQuoteSources", () => {
  it("carries source from the ledger by id, and only for wire quotes", () => {
    const stored = withQuoteSources(
      [
        { ...wireArticle.quotes[0], source: undefined },
        { quoteId: "Q1", speaker: "Ann", teamId: "T3", text: "I set that lineup Wednesday.", questionTopic: "the bench points", sectionName: "introduction", writerResponse: "Fine.", source: "interview" },
        { quoteId: "Q9", speaker: "Ghost", teamId: "T3", text: "…", questionTopic: "x", sectionName: "introduction", writerResponse: "…", source: "wire" },
      ],
      facts
    );
    expect(stored[0].source).toBe("wire");
    expect("source" in stored[1]).toBe(false);
    expect("source" in stored[2]).toBe(false);
  });
});
