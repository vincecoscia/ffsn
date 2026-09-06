import { describe, expect, it } from "vitest";
import { factsRequestFor, fixturesByName, samples } from "../src/lib/ai/__fixtures__";
import { applyStrips } from "../src/lib/ai/content-generation-service";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";
import { buildFactsBlock, serializeFacts } from "../src/lib/ai/facts";
import { findInjuryBlame, verifyArticle } from "../src/lib/ai/fact-verifier";
import { PromptBuilder } from "../src/lib/ai/prompt-builder";

/**
 * In-game injuries are not lineup mistakes (owner, 2026-09-05; The Wire spec §16.1). A player who
 * left his game hurt scores like a bad start, and a recap working from points-per-slot invents a
 * blunder out of it. These tests pin the prompt layer's half of the rule on the recorded fixture:
 * the FACTS entry, the retired bench swap, the house-style line, the readable block, and the
 * verifier strip that removes one blaming sentence and leaves the rest of the article intact.
 */

const fixture = fixturesByName["in-game-injury"];
const baseline = fixturesByName["rich-week"];
const sample = samples.find((candidate) => candidate.name === "injury-blame")!;
const BLAME_SENTENCE = (sample as unknown as { blameSentence: string }).blameSentence;

const facts = buildFactsBlock(factsRequestFor(fixture, "weekly_recap"));
const baselineFacts = buildFactsBlock(factsRequestFor(baseline, "weekly_recap"));

function player(name: string, block = facts) {
  return block.matchups.flatMap((matchup) => matchup.players).find((entry) => entry.name === name);
}

describe("FACTS: facts.inGameInjuries", () => {
  it("carries the injury with the team resolved the way every performer is", () => {
    expect(facts.inGameInjuries).toEqual([
      {
        playerId: "Pp203",
        name: "Cole Vandermeer",
        position: "WR",
        teamId: "T10",
        teamName: "Sable Ridge Sentinels",
        week: 7,
        status: "OUT",
        minutesAfterKickoff: 38,
        started: true,
        points: 6.2,
      },
    ]);
    expect(serializeFacts(facts)).toContain('"inGameInjuries"');
  });

  it("tags the performer who left hurt and retires the bench swap that would have replaced him", () => {
    expect(player("Cole Vandermeer")).toMatchObject({ id: "M1Pp203", lineup: "starter", leftGameInjured: true });
    expect(player("Cole Vandermeer")?.benchImpact).toBeUndefined();
    // Duke Ellery's 24.1 on the bench "would have replaced" the injured starter: not a story now.
    expect(player("Duke Ellery")?.benchImpact).toBeUndefined();
    expect(player("Duke Ellery")?.leftGameInjured).toBeUndefined();
  });

  it("is an empty list, with the bench swap intact, when nobody left hurt", () => {
    expect(baselineFacts.inGameInjuries).toEqual([]);
    expect(player("Cole Vandermeer", baselineFacts)?.leftGameInjured).toBeUndefined();
    expect(player("Duke Ellery", baselineFacts)?.benchImpact).toEqual({ wouldHaveReplaced: "Cole Vandermeer", pointGain: 17.9 });
  });
});

describe("prompt: the rule and the readable block", () => {
  const built = new PromptBuilder({
    ...factsRequestFor(fixture, "weekly_recap"),
    leagueId: "eval_in-game-injury",
    persona: "mel-diaper",
  }).build();

  it("puts the house-style line in the system prompt", () => {
    expect(built.systemPrompt).toContain("An in-game injury is never the manager's decision.");
    expect(built.systemPrompt).toContain("6. facts.inGameInjuries lists players who left their game hurt.");
  });

  it("renders the injury as part of the game and the replacement as the story", () => {
    expect(built.userPrompt).toContain("IN-GAME INJURIES (facts.inGameInjuries) — part of the game, never a lineup decision");
    expect(built.userPrompt).toContain(
      "- Cole Vandermeer (WR, Sable Ridge Sentinels): left hurt, OUT, 38 minutes after kickoff, started, 6.2 points."
    );
    expect(built.userPrompt).toContain("the bench, the waiver wire, the next man up");
    // The matchup rendering tags the starter and drops the "would have replaced" note behind him.
    expect(built.userPrompt).toContain("Cole Vandermeer (WR) - 6.2 pts [STARTER — LEFT GAME INJURED, not a lineup call]");
    expect(built.userPrompt).not.toContain("would have replaced Cole Vandermeer");
  });

  it("renders nothing of the kind when nobody left hurt", () => {
    const clean = new PromptBuilder({
      ...factsRequestFor(baseline, "weekly_recap"),
      leagueId: "eval_rich-week",
      persona: "mel-diaper",
    }).build();
    expect(clean.userPrompt).not.toContain("IN-GAME INJURIES");
    expect(clean.userPrompt).not.toContain("LEFT GAME INJURED");
    expect(clean.userPrompt).toContain("Cole Vandermeer (WR) - 6.2 pts [STARTER] —");
  });
});

describe("verifier: injury_blame strips the sentence and leaves the article intact", () => {
  const rundown = "The rundown, tightest first";

  it("reports exactly the recorded violation on the sample", () => {
    const violations = verifyArticle(sample.article, facts);
    expect(violations.map((violation) => `${violation.kind}/${violation.severity}`)).toEqual(["injury_blame/strip"]);
    expect(violations[0]).toMatchObject({ section: rundown });
    expect(violations[0].detail).toContain(`"${BLAME_SENTENCE}"`);
    expect(violations[0].detail).toContain("Cole Vandermeer left his game hurt");
  });

  it("applyStrips removes only the blaming sentence", () => {
    const violations = verifyArticle(sample.article, facts);
    const stripped = applyStrips(sample.article, violations);

    const before = sample.article.sections.find((section) => section.name === rundown)!;
    const after = stripped.sections.find((section) => section.name === rundown)!;
    expect(before.content).toContain(BLAME_SENTENCE);
    expect(after.content).not.toContain(BLAME_SENTENCE);
    expect(after.content).not.toContain("lineup mistake");
    // Everything else in the section survived, in order.
    expect(after.content).toBe(before.content.replace(`${BLAME_SENTENCE} `, ""));
    expect(after.content).toContain("Quarry Road Quakers 118.7, Milltown Mudlarks 112.3.");
    expect(after.content).toContain("Cass Lindqvist had 33.4 and Bo Tremaine had 4.8.");

    // The other sections, the quotes and the structured fields are untouched.
    for (const section of sample.article.sections) {
      if (section.name === rundown) continue;
      expect(stripped.sections.find((candidate) => candidate.name === section.name)).toEqual(section);
    }
    expect(stripped.quotes).toEqual(sample.article.quotes);
    expect(stripped.featuredPlayers).toEqual(sample.article.featuredPlayers);
    expect(stripped.keyStats).toEqual(sample.article.keyStats);

    // And the stripped article is clean.
    expect(verifyArticle(stripped, facts)).toEqual([]);
  });

  it("leaves the same sentence about a healthy starter alone", () => {
    const healthy = "Dana Whitlock started Rex Dolan over Wes Trombley and it was the lineup mistake of the week.";
    const article: GeneratedArticleT = {
      ...sample.article,
      sections: sample.article.sections.map((section) =>
        section.name === rundown ? { ...section, content: section.content.replace(BLAME_SENTENCE, healthy) } : section
      ),
    };
    const violations = verifyArticle(article, facts);
    expect(violations.filter((violation) => violation.kind === "injury_blame")).toEqual([]);
  });

  it("leaves a neutral injury sentence alone, and does not call it an unsupported injury", () => {
    const neutral = "Cole Vandermeer left in the second quarter with a knee injury and finished with 6.2.";
    const article: GeneratedArticleT = {
      ...sample.article,
      sections: sample.article.sections.map((section) =>
        section.name === rundown ? { ...section, content: section.content.replace(BLAME_SENTENCE, neutral) } : section
      ),
    };
    const violations = verifyArticle(article, facts);
    expect(violations.filter((violation) => violation.kind === "injury_blame")).toEqual([]);
    expect(violations.filter((violation) => violation.kind === "unsupported_injury")).toEqual([]);
  });

  it("reports nothing on the same article when FACTS carries no injury", () => {
    // Without the injury the swap is real, so the only difference is the missing keyStat path.
    const violations = verifyArticle(sample.article, baselineFacts);
    expect(violations.filter((violation) => violation.kind === "injury_blame")).toEqual([]);
  });

  it("names the player by full name, last name or FACTS id, and needs the blame wording", () => {
    const injured = [{ id: "Pp203", name: "Cole Vandermeer" }];
    expect(findInjuryBlame("Starting Vandermeer was indefensible.", injured)).toHaveLength(1);
    expect(findInjuryBlame("Why on earth would you start Pp203 there?", injured)).toHaveLength(1);
    expect(findInjuryBlame("That slot cost them the game; p203 never should have played.", injured)).toHaveLength(1);
    expect(findInjuryBlame("Cole Vandermeer left hurt after 38 minutes.", injured)).toEqual([]);
    expect(findInjuryBlame("Starting Duke Ellery was the mistake of the week.", injured)).toEqual([]);
  });
});
