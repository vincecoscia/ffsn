import { describe, expect, it } from "vitest";
import { buildFactsBlock, serializeFacts } from "../src/lib/ai/facts";
import type { FactsBlock, FactsPlayoffs, FactsRequest } from "../src/lib/ai/facts";
import { InsufficientDataError, PromptBuilder } from "../src/lib/ai/prompt-builder";
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";
import {
  findRegisterLeaks,
  parseQuoteDirectives,
  resolvePath,
  stripQuoteDirectives,
  verifyArticle,
  verifyRequiredSections,
  TITLE_SECTION,
} from "../src/lib/ai/fact-verifier";
import type { Violation } from "../src/lib/ai/fact-verifier";
import { shouldPublish } from "../src/lib/ai/publish-gate";
import { contentTemplates } from "../src/lib/ai/content-templates";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";
import {
  DEFAULT_PERSONA,
  contentTypePersonaMap,
  getPersona,
  personaPrompts,
} from "../src/lib/ai/persona-prompts";
// The standings comparator and the league-format builder live in the Convex query that assembles
// a league's payload; both are plain, side-effect-free functions, so they are directly importable
// and testable here without a convex-test harness (audit: format/seeding).
import { compareStandingsForSeeding, computeLeagueFormat } from "../convex/aiQueries";
import espnSettingsFixture from "./fixtures/espn-settings-public-2025.json";

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

  it("accepts a known player cited by bare ESPN id, and still checks the team", () => {
    // The fixture's first matchup player is "M1Pp1" on T3; a writer may cite him as "p1".
    const base = { playerName: "Any Name", position: "RB", nflTeam: "BUF", mentions: 1 };
    expect(verify({ featuredPlayers: [{ ...base, playerId: "p1", fantasyTeamId: "T3" }] })).not.toContainEqual(
      expect.objectContaining({ kind: "unknown_player" })
    );
    expect(verify({ featuredPlayers: [{ ...base, playerId: "p1", fantasyTeamId: "T7" }] })).toContainEqual(
      expect.objectContaining({ kind: "wrong_fantasy_team" })
    );
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
/* Register check (spec §11.2.4)                                                */
/* -------------------------------------------------------------------------- */

describe("register check", () => {
  const leaks = (content: string): Violation[] =>
    verify(prose(content)).filter((violation) => violation.kind === "data_speak");

  it("blocks a FACTS field name in the prose", () => {
    const violations = leaks("Alpha leads the league in pointsFor and it is not close.");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ severity: "block", section: "introduction" });
    expect(violations[0].detail).toContain("pointsFor");
    expect(leaks("Beta's benchImpact was the story.")[0]?.detail).toContain("benchImpact");
    expect(leaks("His nflTeam plays Sunday.")[0]?.detail).toContain("nflTeam");
  });

  it("blocks prompt-layer jargon", () => {
    expect(leaks("The ledger says Ann answered.")[0]).toMatchObject({
      kind: "data_speak",
      severity: "block",
    });
    expect(leaks("Nothing in the payload backs that up.")).toHaveLength(1);
    expect(leaks("Per the sheet, Alpha is fine.")).toHaveLength(1);
    expect(leaks("The data feed had it first.")).toHaveLength(1);
    expect(leaks("It is not in the FACTS block.")).toHaveLength(1);
  });

  it("blocks an ISO-8601 timestamp", () => {
    const violations = leaks("The trade landed 2026-09-02T14:31:00Z, which is late.");
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain("2026-09-02T14:31:00Z");
    expect(leaks("Filed 2026-09-02.")).toHaveLength(1);
  });

  it("blocks an internal id in the body and in the title, and never a real word", () => {
    const inBody = leaks("T3 beat T7 by six and a half.");
    expect(inBody).toHaveLength(2);
    expect(inBody.every((violation) => violation.severity === "block")).toBe(true);

    const inTitle = verify({ title: "M1 was the game of the week" }).filter(
      (violation) => violation.kind === "data_speak"
    );
    expect(inTitle).toHaveLength(1);
    expect(inTitle[0].section).toBe(TITLE_SECTION);

    // Player initials and ids inside longer tokens are not internal ids.
    expect(leaks("TJ Watt and M1Pp204 aside, Alpha won.").map((v) => v.detail).join()).not.toContain(
      '"TJ"'
    );
  });

  it("leaves the pull-quote directive and ordinary English alone", () => {
    // The directive is markup for the renderer: its id must not read as a leak.
    expect(verifyArticle(cleanArticle, facts)).toEqual([]);
    expect(findRegisterLeaks("Here are the facts: Alpha won.")).toEqual([]);
    expect(findRegisterLeaks("Alpha came through in the fourth quarter.")).toEqual([]);
    // ...but the same phrase about the data is pipeline talk.
    expect(findRegisterLeaks("Only two quotes came through before deadline.")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Required sections (spec §11.2.5)                                             */
/* -------------------------------------------------------------------------- */

describe("required sections", () => {
  const template = contentTemplates.weekly_recap;
  const requiredCount = template.sections.filter((section) => section.required).length;

  const withSections = (count: number): GeneratedArticleT => ({
    ...cleanArticle,
    quotes: [],
    sections: Array.from({ length: count }, (_, index) => ({
      name: `section ${index + 1}`,
      content: "Alpha won the game and Beta did not.",
      wordCount: 8,
    })),
  });

  it("holds an article with fewer sections than the template has required ones", () => {
    const violations = verifyRequiredSections(withSections(requiredCount - 1), template);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "thin_article", severity: "strip" });
    expect(violations[0].detail).toContain(`${requiredCount} required`);
  });

  it("only warns when every required section is there but an optional one is not", () => {
    const violations = verifyRequiredSections(withSections(requiredCount), template);
    expect(violations).toEqual([
      {
        kind: "sections_missing",
        detail: `${requiredCount} of ${template.sections.length} template sections; every required section is present`,
        severity: "warn",
      },
    ]);
  });

  it("says nothing about a full article, or when no template was passed", () => {
    expect(verifyRequiredSections(withSections(template.sections.length), template)).toEqual([]);
    expect(verifyRequiredSections(withSections(1), undefined)).toEqual([]);
  });

  it("reports through verifyArticle only when the template is supplied", () => {
    const thin = withSections(1);
    expect(verifyArticle(thin, facts).some((v) => v.kind === "thin_article")).toBe(false);
    expect(
      verifyArticle(thin, facts, { template }).some((v) => v.kind === "thin_article")
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Verifier noise (spec §11.3.11)                                               */
/* -------------------------------------------------------------------------- */

describe("verifier noise", () => {
  const unknownNouns = (content: string): string[] =>
    verify(prose(content))
      .filter((violation) => violation.kind === "unknown_player")
      .map((violation) => violation.detail);

  it("ignores a sentence opener that only looks like a name", () => {
    expect(unknownNouns("The Grinders had it won at halftime.")).toEqual([]);
    expect(unknownNouns("Because Alpha started fast, Beta never led.")).toEqual([]);
    expect(unknownNouns("Here Comes the bench discourse again.")).toEqual([]);
    expect(unknownNouns("Now Alpha has to do it twice.")).toEqual([]);
  });

  it("ignores anything that is part of a FACTS name, and still flags a real unknown", () => {
    // "QB One" is a FACTS player; "Alpha" is a FACTS team.
    expect(unknownNouns("QB One carried Alpha again.")).toEqual([]);
    expect(unknownNouns("Marcus Wembley went off for someone else.")).toEqual(["Marcus Wembley"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Publish gate (spec §11.2.9)                                                  */
/* -------------------------------------------------------------------------- */

describe("shouldPublish", () => {
  const clean = {
    tags: ["weekly_recap", "curtis-vaughn"],
    reviewFlags: [] as Violation[],
    verifierStats: { wordCount: 1200 },
    editor: {
      contradictions: [],
      unsupported: [],
      registerLeaks: [],
      factsScore: 4,
      voiceScore: 4,
      incompleteSections: [],
      model: "claude-sonnet-5",
      costUsd: 0.02,
    },
  };

  it("publishes a clean article", () => {
    expect(shouldPublish(clean)).toEqual({ ok: true, reasons: [] });
  });

  it("holds on a block", () => {
    const gate = shouldPublish({
      ...clean,
      reviewFlags: [{ kind: "data_speak", detail: '"T3"', severity: "block" }],
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("data_speak");
  });

  it("holds on a strip", () => {
    const gate = shouldPublish({
      ...clean,
      reviewFlags: [{ kind: "llm_contradicted", detail: '"Beta won."', severity: "strip" }],
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("llm_contradicted");
  });

  it("holds when a required section is missing", () => {
    const gate = shouldPublish({
      ...clean,
      reviewFlags: [{ kind: "thin_article", detail: "2 sections", severity: "strip" }],
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain("a required section is missing");
  });

  it("holds when the editor scored the facts below 3 with something cited, and publishes at 3", () => {
    const cited = { contradictions: [{ claim: "Ghost Back scored 40", sectionName: "introduction" }] };
    expect(shouldPublish({ ...clean, editor: { ...clean.editor, ...cited, factsScore: 2 } })).toMatchObject({
      ok: false,
      reasons: ["the editor scored the facts 2/5"],
    });
    // A low score with nothing cited is the rubric parse losing its notes, not a verdict.
    expect(shouldPublish({ ...clean, editor: { ...clean.editor, factsScore: 2 } }).ok).toBe(true);
    expect(shouldPublish({ ...clean, editor: { ...clean.editor, factsScore: 3 } }).ok).toBe(true);
    // Voice never blocks.
    expect(shouldPublish({ ...clean, editor: { ...clean.editor, voiceScore: 1 } }).ok).toBe(true);
  });

  it("holds an article under 30% of its template ceiling", () => {
    const gate = shouldPublish({ ...clean, verifierStats: { wordCount: 100 } });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("under the 480-word floor");
    // 30% exactly publishes.
    expect(shouldPublish({ ...clean, verifierStats: { wordCount: 480 } }).ok).toBe(true);
  });

  it("names every reason at once, and needs no editor pass to decide", () => {
    const gate = shouldPublish({
      tags: ["weekly_recap"],
      reviewFlags: [
        { kind: "bad_quote", detail: "x", severity: "block" },
        { kind: "thin_article", detail: "y", severity: "strip" },
      ],
      verifierStats: { wordCount: 40 },
    });
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Writer roster                                                                */
/* -------------------------------------------------------------------------- */

describe("writer roster", () => {
  it("has at least six writers and exactly one interviewer", () => {
    expect(Object.keys(personaPrompts).length).toBeGreaterThanOrEqual(6);
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

  it("warns on a record beside a team only in a preview written before kickoff", () => {
    const beforeKickoff = buildFactsBlock({
      ...previewRequest,
      leagueData: {
        ...previewLeagueData,
        currentWeek: 0,
        playerBoard: { basis: "upcoming_projection", throughWeek: 0, entries: [] },
      },
    });
    expect(beforeKickoff.board).toEqual({ basis: "this week's projections", throughWeek: 0, positions: [] });
    const body = prose("Alpha (0-0) hosts Beta.");
    const template = contentTemplates.weekly_preview;
    const hits = (facts: FactsBlock) =>
      verifyArticle({ ...cleanArticle, ...body }, facts, { template }).filter(
        violation => violation.kind === "records_before_kickoff"
      );
    expect(hits(beforeKickoff)).toMatchObject([{ severity: "warn", section: "introduction" }]);
    expect(hits(previewFacts)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* League format (audit: divisions, playoff structure, roster shape, scoring,   */
/* waivers — the writers had no way to know any of these before).              */
/* -------------------------------------------------------------------------- */

describe("league format", () => {
  it("orders standings by ESPN's playoff seed, not by wins", () => {
    // Bay Blitz (7-1, seed 1) and Ridge Runners (8-0, seed 3): the most-win team is NOT seed 1,
    // which is exactly the DIVISION_WINNERS scenario the audit flagged — a wins/PF comparator gets
    // this league's seeding wrong.
    const bayBlitz = { record: { wins: 7, losses: 1, ties: 0, pointsFor: 1000, playoffSeed: 1 } };
    const riverKings = { record: { wins: 6, losses: 2, ties: 0, pointsFor: 950, playoffSeed: 2 } };
    const ridgeRunners = { record: { wins: 8, losses: 0, ties: 0, pointsFor: 1100, playoffSeed: 3 } };
    const canyonWolves = { record: { wins: 5, losses: 3, ties: 0, pointsFor: 880, playoffSeed: 4 } };
    const noSeedYet = { record: { wins: 4, losses: 4, ties: 0, pointsFor: 700 } };

    const sorted = [ridgeRunners, canyonWolves, noSeedYet, bayBlitz, riverKings].sort(
      compareStandingsForSeeding
    );
    expect(sorted).toEqual([bayBlitz, riverKings, ridgeRunners, canyonWolves, noSeedYet]);
  });

  it("parses a real ESPN settings blob (leagueSeasons.settings' actual shape), not a flat guess", () => {
    // `leagueSeasons.settings` stores ESPN's raw, deeply nested `view=mSettings` response —
    // `computeLeagueFormat` must run it through `parseEspnLeagueSettings` rather than reading flat
    // top-level keys that only exist on the separately-mirrored `leagues.settings`. This fixture
    // (2-week playoff rounds, TOTAL_POINTS_SCORED seeding, a numeric division id) is a real
    // production league's settings subtree.
    const format = computeLeagueFormat(espnSettingsFixture.settings, undefined);

    expect(format.regularSeasonMatchupPeriods).toBe(14);
    expect(format.playoffTeamCount).toBe(4);
    expect(format.playoffMatchupPeriodLength).toBe(2);
    expect(format.playoffRounds).toBe(2);
    expect(format.playoffSeedingRule).toBe("TOTAL_POINTS_SCORED");
    expect(format.waiverType).toBe("faab");
    expect(format.faabBudget).toBe(200);
    expect(format.tradeDeadline).toBe(1764784800000);
    // ESPN's division id is numeric (0); `computeLeagueFormat` normalizes it to the string form
    // used everywhere else this feature compares a division id (`teams.divisionId` stringified).
    expect(format.divisions).toEqual([{ id: "0", name: "Texas", size: 12 }]);
    expect(typeof format.divisions?.[0].id).toBe("string");
    // Two-week playoff rounds starting week 15: championship is week 18.
    expect(format.fantasyChampionshipWeek).toBe(18);
  });

  // A fixture league with 2 divisions (East, West), 4 playoff teams, a 13-week regular season,
  // 2-week playoff rounds, half-PPR, superflex, and FAAB 100 — everything the format audit's spec
  // list of gaps names.
  const formatLeagueFormat = {
    scoringType: "half_ppr",
    receptionPoints: 0.5,
    regularSeasonMatchupPeriods: 13,
    playoffTeamCount: 4,
    playoffMatchupPeriodLength: 2,
    playoffRounds: 2,
    playoffSeedingRule: "DIVISION_WINNERS",
    divisions: [
      { id: "1", name: "East" },
      { id: "2", name: "West" },
    ],
    lineupSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BE: 6 },
    isSuperflex: true,
    hasIdp: false,
    waiverType: "faab",
    faabBudget: 100,
    // Derived by `convex/aiQueries.ts#computeLeagueFormat` (regular season + 2 playoff rounds of
    // 2 weeks each = weeks 14-17); `facts.ts#buildFormat` reads it rather than recomputing it.
    fantasyChampionshipWeek: 17,
    playoffWeeksRange: "Weeks 14-17",
  };

  const formatLeagueData = {
    leagueName: "Format League",
    currentWeek: 14,
    season: 2025,
    scoringType: "half_ppr",
    leagueFormat: formatLeagueFormat,
    teams: [
      {
        id: "ft1", name: "Bay Blitz", manager: "Jo", externalId: "1",
        record: { wins: 7, losses: 1, ties: 0, pointsFor: 1000 },
        pointsFor: 1000, pointsAgainst: 700, division: "East",
      },
      {
        id: "ft2", name: "Ridge Runners", manager: "Ivy", externalId: "2",
        record: { wins: 8, losses: 0, ties: 0, pointsFor: 1100 },
        pointsFor: 1100, pointsAgainst: 650, division: "East",
      },
      {
        id: "ft3", name: "River Kings", manager: "Sam", externalId: "3",
        record: { wins: 6, losses: 2, ties: 0, pointsFor: 950 },
        pointsFor: 950, pointsAgainst: 720, division: "West",
      },
      {
        id: "ft4", name: "Canyon Wolves", manager: "Lee", externalId: "4",
        record: { wins: 5, losses: 3, ties: 0, pointsFor: 880 },
        pointsFor: 880, pointsAgainst: 800, division: "West",
      },
    ],
    // Already in seed order, as the fixed `getLeagueDataForAI` sort produces it — note rank 3 is
    // Ridge Runners, this league's best record, which is the point of the test above.
    standings: [
      { rank: 1, team: "Bay Blitz", teamId: "1", wins: 7, losses: 1, ties: 0, pointsFor: 1000, pointsAgainst: 700, playoffSeed: 1, division: "East" },
      { rank: 2, team: "River Kings", teamId: "3", wins: 6, losses: 2, ties: 0, pointsFor: 950, pointsAgainst: 720, playoffSeed: 2, division: "West" },
      { rank: 3, team: "Ridge Runners", teamId: "2", wins: 8, losses: 0, ties: 0, pointsFor: 1100, pointsAgainst: 650, playoffSeed: 3, division: "East" },
      { rank: 4, team: "Canyon Wolves", teamId: "4", wins: 5, losses: 3, ties: 0, pointsFor: 880, pointsAgainst: 800, playoffSeed: 4, division: "West" },
    ],
    divisionStandings: [
      {
        division: "East",
        teams: [
          { rank: 1, teamId: "1", team: "Bay Blitz", record: "7-1-0", pointsFor: 1000 },
          { rank: 3, teamId: "2", team: "Ridge Runners", record: "8-0-0", pointsFor: 1100 },
        ],
      },
      {
        division: "West",
        teams: [
          { rank: 2, teamId: "3", team: "River Kings", record: "6-2-0", pointsFor: 950 },
          { rank: 4, teamId: "4", team: "Canyon Wolves", record: "5-3-0", pointsFor: 880 },
        ],
      },
    ],
    availablePlayers: [
      {
        playerId: "fa1",
        playerName: "Free Agent One",
        position: "RB",
        team: "KC",
        proTeam: "KC",
        ownership: { percentOwned: 12, percentChange: 4 },
      },
    ],
    recentMatchups: [],
    trades: [],
    transactions: [],
  } as unknown as LeagueDataContext;

  const formatRequest = {
    leagueId: "lg2",
    contentType: "playoff_picture",
    persona: "nina-sharpe",
    userId: "u1",
    leagueData: formatLeagueData,
    priorClaims: [],
  } satisfies FactsRequest & { userId: string };

  const formatFacts = buildFactsBlock(formatRequest);

  it("carries division names on both teams and standings", () => {
    expect(formatFacts.teams.find((team) => team.id === "T1")?.division).toBe("East");
    expect(formatFacts.teams.find((team) => team.id === "T3")?.division).toBe("West");
    expect(formatFacts.standings.find((row) => row.teamId === "T3")?.division).toBe("West");
    expect(formatFacts.standings.map((row) => row.seed)).toEqual([1, 2, 3, 4]);
  });

  it("builds the FORMAT block in plain English — no ESPN enum, no raw field ever reaches it", () => {
    expect(formatFacts.format).toMatchObject({
      scoring: "Half-PPR (0.5 points per reception)",
      regularSeasonWeeks: 13,
      playoffTeamCount: 4,
      playoffRounds: 2,
      playoffRoundLengthWeeks: 2,
      playoffWeeksRange: "Weeks 14-17",
      seedingRule: "division winners are seeded first, then the rest of the field by record",
      waiverType: "FAAB waivers, $100 season budget",
      isSuperflex: true,
    });
    expect(formatFacts.format.rosterShape).toContain("superflex");
    expect(formatFacts.format.rosterShape).toContain("1QB");
    expect(formatFacts.format.divisions).toEqual([
      { id: "1", name: "East" },
      { id: "2", name: "West" },
    ]);
  });

  it("tells the playoff_picture writer the real field size and seeding rule, never assuming six", () => {
    const built = new PromptBuilder(formatRequest).build();
    expect(built.userPrompt).toContain("The field is 4 teams.");
    expect(built.userPrompt).toContain("Seeding rule: division winners are seeded first");
    expect(built.userPrompt).toContain("STANDINGS BY DIVISION");
    expect(built.userPrompt).not.toContain("not in the payload");
  });

  it("tells the waiver_wire_report writer the FAAB budget", () => {
    const built = new PromptBuilder({
      ...formatRequest,
      contentType: "waiver_wire_report",
    }).build();
    expect(built.userPrompt).toContain("FAAB waivers, $100 season budget");
  });

  it("does not flag division names as unknown proper nouns", () => {
    const divisionArticle: GeneratedArticleT = {
      title: "Playoff race tightens",
      summary: "The playoff picture is set.",
      tone: "analytical",
      sections: [
        {
          name: "introduction",
          content: "East sits atop the standings while West chases the final spot.",
          wordCount: 11,
        },
      ],
      featuredTeams: [],
      featuredPlayers: [],
      keyStats: [],
      quotes: [],
      managerMentions: [],
      claims: [],
    };
    const violations = verifyArticle(divisionArticle, formatFacts);
    expect(
      violations.some(
        (violation) =>
          violation.kind === "unknown_player" && (violation.detail === "East" || violation.detail === "West")
      )
    ).toBe(false);
  });

  it("falls back to a plain field-size warning when the payload has no playoff team count", () => {
    const noFormatData = {
      ...formatLeagueData,
      leagueFormat: undefined,
    } as unknown as LeagueDataContext;
    const noFormatFacts = buildFactsBlock({ ...formatRequest, leagueData: noFormatData });
    expect(noFormatFacts.format.playoffTeamCount).toBeUndefined();
    expect(noFormatFacts.missing).toContain(
      "playoff field size — not in the payload; do not assume a number of playoff teams"
    );

    const built = new PromptBuilder({ ...formatRequest, leagueData: noFormatData }).build();
    expect(built.userPrompt).toContain("The payload does not say how many teams make the playoffs");
  });
});

/* -------------------------------------------------------------------------- */
/* Playoffs (owner ask, Sept 2026): a knocked-out team is not a contender.     */
/* The full bracket is exercised in tests/playoffFacts.test.ts; this pins the  */
/* kind on the small fixture above.                                            */
/* -------------------------------------------------------------------------- */

describe("eliminated as contender", () => {
  const decidedPlayoffs: FactsPlayoffs = {
    mode: "final",
    fieldSize: 2,
    byes: 0,
    playoffStartWeek: 4,
    championshipWeek: 4,
    seeds: [
      { teamId: "T3", seed: 1, record: "3-1-0", pointsFor: 421.7 },
      { teamId: "T7", seed: 2, record: "1-3-0", pointsFor: 358.2 },
    ],
    bubble: [],
    bracket: [
      {
        week: 4,
        round: "Championship",
        games: [
          {
            id: "B1",
            home: "T3",
            away: "T7",
            homeSeed: 1,
            awaySeed: 2,
            homeScore: 128.4,
            awayScore: 121.9,
            winner: "T3",
            status: "final",
          },
        ],
      },
    ],
    consolation: [],
    alive: ["T3"],
    eliminated: ["T7"],
    champion: "T3",
    runnerUp: "T7",
  };
  const decided: FactsBlock = { ...facts, playoffs: decidedPlayoffs };

  it("blocks a sentence that keeps the beaten finalist in the title chase", () => {
    const violations = verifyArticle({ ...cleanArticle, ...prose("Beta is still alive after that.") }, decided);
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: "eliminated_as_contender", severity: "block", section: "introduction" })
    );
  });

  it("leaves negation, the past tense and the champion alone", () => {
    for (const body of [
      "Beta is no longer a contender.",
      "Beta was a contender until Sunday.",
      "Alpha is the only contender left.",
    ]) {
      const violations = verifyArticle({ ...cleanArticle, ...prose(body) }, decided);
      expect(violations.filter((violation) => violation.kind === "eliminated_as_contender"), body).toEqual([]);
    }
  });

  it("says nothing while the seeds are only a projection", () => {
    const projected: FactsBlock = {
      ...facts,
      playoffs: { ...decidedPlayoffs, mode: "projected", alive: [], eliminated: ["T7"] },
    };
    const violations = verifyArticle({ ...cleanArticle, ...prose("Beta is still a contender.") }, projected);
    expect(violations.filter((violation) => violation.kind === "eliminated_as_contender")).toEqual([]);
  });

  it("resolves a bracket game by id without naming its round, and the champion by id", () => {
    expect(resolvePath(decided, "playoffs.bracket.B1.homeScore")).toBe(128.4);
    expect(resolvePath(decided, "playoffs.bracket.0.games.B1.winner")).toBe("T3");
    expect(resolvePath(decided, "playoffs.champion")).toBe("T3");
    expect(resolvePath(decided, "playoffs.bracket.B9.homeScore")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* In-game injuries are not lineup mistakes (owner, 2026-09-05; Wire §16.1).  */
/* The recorded fixture is exercised in tests/inGameInjury.test.ts; this pins */
/* the kind on the small fixture above.                                       */
/* -------------------------------------------------------------------------- */

describe("injury blame", () => {
  const kickoffAt = 1760893200000;
  const injuredData = {
    ...genericLeagueData,
    recentMatchups: [
      {
        ...(genericLeagueData.recentMatchups ?? [])[0],
        topPerformers: [
          ...topPerformers,
          {
            playerId: "p2",
            playerName: "RB Two",
            position: "RB",
            points: 3.1,
            projectedPoints: 14,
            fantasyTeamName: "Alpha",
            nflTeam: "BUF",
            isStarter: true,
          },
        ],
      },
    ],
    inGameInjuries: [
      {
        espnId: "p1",
        name: "QB One",
        position: "QB",
        nflTeam: "BUF",
        fantasyTeamId: "3",
        fantasyTeamName: "Alpha",
        week: 4,
        status: "OUT",
        observedAt: kickoffAt + 38 * 60_000,
        kickoffAt,
        started: true,
        points: 40.8,
      },
    ],
  } as unknown as LeagueDataContext;
  const injured = buildFactsBlock({ ...request, leagueData: injuredData });

  it("carries the injury in FACTS and tags the performer", () => {
    expect(injured.inGameInjuries).toEqual([
      expect.objectContaining({ playerId: "Pp1", name: "QB One", teamId: "T3", minutesAfterKickoff: 38, started: true, points: 40.8 }),
    ]);
    expect(injured.matchups[0].players[0]).toMatchObject({ id: "M1Pp1", leftGameInjured: true });
    expect(injured.matchups[0].players[1].leftGameInjured).toBeUndefined();
    expect(facts.inGameInjuries).toEqual([]);
  });

  it("strips a sentence that blames the GM for starting a player who left hurt", () => {
    const body = "Ann should have benched QB One; starting him was the mistake of the week.";
    const violations = verifyArticle({ ...cleanArticle, ...prose(body) }, injured);
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: "injury_blame", severity: "strip", section: "introduction" })
    );
    expect(violations.find((violation) => violation.kind === "injury_blame")?.detail).toContain(`"${body}"`);
  });

  it("leaves the same sentence about a healthy starter alone", () => {
    const body = "Ann should have benched RB Two; starting him was the mistake of the week.";
    const violations = verifyArticle({ ...cleanArticle, ...prose(body) }, injured);
    expect(violations.filter((violation) => violation.kind === "injury_blame")).toEqual([]);
  });

  it("leaves a neutral injury sentence alone", () => {
    const body = "QB One left in the second quarter with a knee injury and finished with 40.8.";
    const violations = verifyArticle({ ...cleanArticle, ...prose(body) }, injured);
    expect(violations.filter((violation) => violation.kind === "injury_blame")).toEqual([]);
    expect(violations.filter((violation) => violation.kind === "unsupported_injury")).toEqual([]);
  });

  it("says nothing when FACTS carries no injury", () => {
    const body = "Ann should have benched QB One; starting him was the mistake of the week.";
    const violations = verifyArticle({ ...cleanArticle, ...prose(body) }, facts);
    expect(violations.filter((violation) => violation.kind === "injury_blame")).toEqual([]);
  });
});
