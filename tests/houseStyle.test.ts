import { describe, expect, it } from "vitest";
import { buildHouseStyleBlock, GROUNDING_CONTRACT, PromptBuilder } from "../src/lib/ai/prompt-builder";
import { MILD_PROFANITY, STRONG_PROFANITY } from "../src/lib/ai/language";
import { personaPrompts } from "../src/lib/ai/persona-prompts";
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
    expect(block).toContain("salty: Mild profanity is allowed — damn, hell, ass, crap");
    expect(block).not.toContain("clean: No profanity of any kind.");
    expect(block).not.toContain("unfiltered: Strong profanity is allowed");
  });

  it("emits only the unfiltered tier text for languageRating: unfiltered", () => {
    const block = buildHouseStyleBlock({ languageRating: "unfiltered" });
    expect(block).toContain("unfiltered: Strong profanity is allowed");
    expect(block).not.toContain("clean: No profanity of any kind.");
    expect(block).not.toContain("salty: Mild profanity is allowed");
  });

  it("derives who carries the rating from the persona allowances, and says nobody swears at clean", () => {
    expect(buildHouseStyleBlock({ languageRating: "clean" })).toContain("At clean nobody on the desk swears");
    for (const rating of ["salty", "unfiltered"] as const) {
      const block = buildHouseStyleBlock({ languageRating: rating });
      expect(block).toContain(`Who carries it at ${rating}:`);
      expect(block).toContain(`Mel Diaper (${personaPrompts["mel-diaper"].language.floor![rating]} to ${personaPrompts["mel-diaper"].language.allowance[rating]} per piece)`);
      expect(block).toContain(`Reggie Banks (${personaPrompts["reggie-banks"].language.floor![rating]} to ${personaPrompts["reggie-banks"].language.allowance[rating]} per piece)`);
      expect(block).toContain("a piece under the bottom of that range is out of character");
      expect(block).toContain("Curtis Vaughn (at most 1)");
      expect(block).toContain("most pieces none");
      // The old hard lock is gone: nobody is named as never swearing above clean.
      expect(block).not.toContain("Dex Alvarez and Sam Ortega stay clean");
      expect(block).not.toContain("never swear at");
    }
  });

  it("lists the exact tier words so the prompt and the counter agree", () => {
    const salty = buildHouseStyleBlock({ languageRating: "salty" });
    for (const word of MILD_PROFANITY) expect(salty).toContain(word);
    expect(salty).not.toContain("fuck");
    const unfiltered = buildHouseStyleBlock({ languageRating: "unfiltered" });
    for (const word of [...MILD_PROFANITY, ...STRONG_PROFANITY]) expect(unfiltered).toContain(word);
  });

  it("bans slurs at every rating", () => {
    for (const rating of ["clean", "salty", "unfiltered"] as const) {
      expect(buildHouseStyleBlock({ languageRating: rating })).toContain("no slurs of any kind");
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

describe("buildSystemPrompt — language as a persona trait (owner ask, 2026-09-03)", () => {
  it("renders the writer's LANGUAGE trait inside WHO YOU ARE and the rating samples under VOICE SAMPLES above clean", () => {
    const built = new PromptBuilder({ ...baseRequest, persona: "mel-diaper", languageRating: "unfiltered" }).build();
    const prompt = built.systemPrompt;
    const whoYouAre = prompt.indexOf("WHO YOU ARE");
    const trait = prompt.indexOf("Your language (this league runs unfiltered; your range for a piece is 4 to 12 — fewer than 4 is out of character");
    const quotes = prompt.indexOf("QUOTES");
    expect(trait).toBeGreaterThan(whoYouAre);
    expect(trait).toBeLessThan(quotes);
    expect(prompt).toContain("The uncut Mel.");
    for (const sample of personaPrompts["mel-diaper"].language.samples!.unfiltered!) {
      expect(prompt.indexOf(sample)).toBeGreaterThan(prompt.indexOf("VOICE SAMPLES"));
    }
  });

  it("renders nothing about the trait at clean, and only the salty trait at salty", () => {
    const clean = new PromptBuilder({ ...baseRequest, persona: "mel-diaper" }).build().systemPrompt;
    expect(clean).not.toContain("Your language (this league runs");
    expect(clean).not.toContain("The uncut Mel.");
    for (const sample of personaPrompts["mel-diaper"].language.samples!.unfiltered!) expect(clean).not.toContain(sample);

    const salty = new PromptBuilder({ ...baseRequest, persona: "mel-diaper", languageRating: "salty" }).build().systemPrompt;
    expect(salty).toContain("Your language (this league runs salty; your range for a piece is 3 to 6");
    expect(salty).not.toContain("The uncut Mel.");
    expect(salty).not.toContain("WHAT THE FUCK WAS THE PLAN");
  });

  it("gives the reserved desk a once-a-piece trait rather than a hard lock", () => {
    const curtis = new PromptBuilder({ ...baseRequest, persona: "curtis-vaughn", languageRating: "unfiltered" }).build().systemPrompt;
    expect(curtis).toContain("your allowance is 1 per piece");
    expect(curtis).toContain("That's bullshit. We'll");
  });
});

describe("persona language profiles", () => {
  const writers = Object.values(personaPrompts).filter((persona) => persona.isWriter);

  it("every writer has a trait and at least one sample for every rating it has an allowance at", () => {
    for (const persona of writers) {
      for (const rating of ["salty", "unfiltered"] as const) {
        const allowance = persona.language.allowance[rating];
        expect(allowance, `${persona.slug} ${rating}`).toBeGreaterThanOrEqual(0);
        if (allowance > 0) {
          expect(persona.language[rating], `${persona.slug} ${rating} trait`).toBeTruthy();
          expect((persona.language.samples?.[rating] ?? []).length, `${persona.slug} ${rating} samples`).toBeGreaterThan(0);
        }
      }
      expect(persona.language.allowance.unfiltered).toBeGreaterThanOrEqual(persona.language.allowance.salty);
      for (const rating of ["salty", "unfiltered"] as const) {
        expect(persona.language.floor?.[rating] ?? 0, `${persona.slug} ${rating} floor <= ceiling`).toBeLessThanOrEqual(persona.language.allowance[rating]);
      }
    }
  });

  it("keeps the reserved desk at one per piece and the debaters carrying the rating", () => {
    for (const slug of ["curtis-vaughn", "sam-ortega", "nina-sharpe", "dex-alvarez"]) {
      expect(personaPrompts[slug].language.allowance.unfiltered, slug).toBe(1);
      expect(personaPrompts[slug].language.floor, `${slug} has no floor`).toBeUndefined();
    }
    expect(personaPrompts["mel-diaper"].language.floor?.unfiltered).toBeGreaterThanOrEqual(3);
    expect(personaPrompts["reggie-banks"].language.floor?.unfiltered).toBeGreaterThanOrEqual(3);
    expect(personaPrompts["mel-diaper"].language.allowance.unfiltered).toBeGreaterThanOrEqual(4);
    expect(personaPrompts["reggie-banks"].language.allowance.unfiltered).toBeGreaterThanOrEqual(4);
  });

  it("language samples follow the placeholder rule: no digits, and salty samples use no strong word", () => {
    for (const persona of writers) {
      for (const sample of persona.language.samples?.salty ?? []) {
        expect(sample, `${persona.slug} salty`).not.toMatch(/\d/);
        for (const word of STRONG_PROFANITY) expect(sample.toLowerCase(), `${persona.slug} salty sample uses ${word}`).not.toMatch(new RegExp(`\\b${word}\\b`));
      }
      for (const sample of persona.language.samples?.unfiltered ?? []) expect(sample, `${persona.slug} unfiltered`).not.toMatch(/\d/);
    }
  });
});

describe("buildUserPrompt — per-piece LANGUAGE line (the trigger that made the setting real on the show)", () => {
  it("tells a carrier the piece contains their moments, and the reserved desk that most pieces use none", () => {
    const mel = new PromptBuilder({ ...baseRequest, persona: "mel-diaper", languageRating: "unfiltered" }).build().userPrompt;
    expect(mel).toContain("LANGUAGE: this league runs unfiltered and you carry it — your range for this piece is 4 to 12. Fewer than 4 is out of character");
    expect(mel).toContain('at least one of them is a "fuck"');
    expect(mel).toContain("Never in the title, headline, summary or first sentence; never against a person.");
    const melSalty = new PromptBuilder({ ...baseRequest, persona: "mel-diaper", languageRating: "salty" }).build().userPrompt;
    expect(melSalty).toContain("your range for this piece is 3 to 6");
    expect(melSalty).not.toContain('"fuck"');

    const curtis = new PromptBuilder({ ...baseRequest, persona: "curtis-vaughn", languageRating: "salty" }).build().userPrompt;
    expect(curtis).toContain("LANGUAGE: this league runs salty. Your allowance for this piece is 1, and most of your pieces use none");
  });

  it("says nothing about language at clean", () => {
    const clean = new PromptBuilder({ ...baseRequest, persona: "mel-diaper" }).build().userPrompt;
    expect(clean).not.toContain("LANGUAGE:");
  });
});
