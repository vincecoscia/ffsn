import { describe, expect, it } from "vitest";
import {
  EVAL_CONTENT_TYPES,
  expectations,
  factsRequestFor,
  fixtures,
  fixturesByName,
  samples,
} from "../src/lib/ai/__fixtures__";
import { buildFactsBlock } from "../src/lib/ai/facts";
import { verifyArticle } from "../src/lib/ai/fact-verifier";
import { InsufficientDataError, PromptBuilder } from "../src/lib/ai/prompt-builder";
import { getPersona, personaPrompts } from "../src/lib/ai/persona-prompts";

/**
 * The offline half of the eval harness (spec §8.7), run as tests so a change to the prompt layer
 * that silently moves a fact, a gap or a prompt section fails CI rather than an eval nobody ran.
 * `scripts/eval-articles.ts` runs the same checks with a printed table and a live mode.
 */

const ACTIVE_WRITERS = Object.values(personaPrompts)
  .filter((persona) => persona.isWriter)
  .map((persona) => persona.slug);

describe("eval fixtures", () => {
  it("ships the four fixtures the harness sweeps, each with an expectation file", () => {
    expect(fixtures.map((fixture) => fixture.name)).toEqual([
      "rich-week",
      "sparse-week",
      "draft-day",
      "empty-league",
    ]);
    for (const fixture of fixtures) {
      expect(expectations[fixture.name], `${fixture.name} expectation`).toBeDefined();
      expect(expectations[fixture.name].fixture).toBe(fixture.name);
      expect(fixture.leagueData.leagueName.length).toBeGreaterThan(0);
    }
  });

  it.each(fixtures.map((fixture) => fixture.name))(
    "%s: FACTS counts match the expectation file and every reference resolves",
    (name) => {
      const fixture = fixturesByName[name];
      const expected = expectations[name];
      const facts = buildFactsBlock(factsRequestFor(fixture, "weekly_recap"));

      expect({
        teams: facts.teams.length,
        matchups: facts.matchups.length,
        matchupPlayers: facts.matchups.reduce((total, matchup) => total + matchup.players.length, 0),
        standings: facts.standings.length,
        transactions: facts.transactions.length,
        trades: facts.trades.length,
        draftPicks: facts.draftPicks?.length ?? 0,
        quotes: facts.quotes.length,
        nonRespondents: facts.nonRespondents.length,
        relationships: facts.relationships.length,
        priorClaims: facts.priorClaims.length,
      }).toEqual(expected.facts);

      const refs = [
        ...facts.matchups.flatMap((matchup) => [
          matchup.home.teamId,
          matchup.away.teamId,
          ...matchup.players.map((player) => player.fantasyTeamId),
        ]),
        ...facts.standings.map((row) => row.teamId),
        ...facts.transactions.map((row) => row.teamId),
        ...facts.trades.flatMap((trade) => trade.sides.map((side) => side.teamId)),
        ...(facts.draftPicks ?? []).map((pick) => pick.teamId),
        ...facts.quotes.map((quote) => quote.teamId),
        ...facts.nonRespondents.map((entry) => entry.teamId),
        ...facts.relationships.map((entry) => entry.teamId),
      ];
      expect(refs.filter((id) => id === "T?")).toEqual([]);
    }
  );

  it("keeps both matchup shapes covered: ids in teamA/teamB, and names in teamA/teamB", () => {
    // rich-week is the generic-query shape (ESPN ids with names alongside)...
    const rich = fixturesByName["rich-week"].leagueData.recentMatchups?.[0];
    expect(rich?.teamA).toBe("1");
    expect((rich as unknown as { teamAName?: string }).teamAName).toBe("Gravel Pit Grinders");

    // ...and sparse-week is the weekly-recap shape, where the names are in teamA/teamB.
    const sparse = fixturesByName["sparse-week"].leagueData.recentMatchups?.[0];
    expect(sparse?.teamA).toBe("Gravel Pit Grinders");

    // Both land on the same ids.
    for (const name of ["rich-week", "sparse-week"]) {
      const facts = buildFactsBlock(factsRequestFor(fixturesByName[name], "weekly_recap"));
      expect(facts.matchups[0].home.teamId).toBe("T1");
    }
  });

  it("carries the week-8 slate into facts.upcoming with resolved ids and no scores", () => {
    const facts = buildFactsBlock(factsRequestFor(fixturesByName["rich-week"], "weekly_preview"));

    expect(facts.upcoming).toHaveLength(5);
    expect(facts.upcoming.map((game) => game.id)).toEqual(["U1", "U2", "U3", "U4", "U5"]);
    expect(facts.upcoming.every((game) => game.week === 8)).toBe(true);
    expect(facts.upcoming[0]).toMatchObject({
      home: { teamId: "T1", record: "7-0-0", pointsFor: 812.4, projected: 124.8 },
      away: { teamId: "T2", record: "5-2-0", pointsFor: 788.9, projected: 122.1 },
      headToHead: { homeWins: 1, awayWins: 0 },
    });

    // Nothing on an unplayed game may carry a score, and every side resolves to a real team.
    for (const game of facts.upcoming) {
      expect(Object.keys(game.home)).not.toContain("score");
      expect(Object.keys(game.away)).not.toContain("score");
      expect([game.home.teamId, game.away.teamId]).not.toContain("T?");
    }

    // Every other content type sees the same payload with an empty slate in FACTS.
    const recap = buildFactsBlock(factsRequestFor(fixturesByName["sparse-week"], "weekly_recap"));
    expect(recap.upcoming).toEqual([]);
  });

  it("previews the slate rather than recapping last week", () => {
    const built = new PromptBuilder({
      ...factsRequestFor(fixturesByName["rich-week"], "weekly_preview"),
      leagueId: "eval_rich-week",
      persona: "curtis-vaughn",
    }).build();

    expect(built.systemPrompt).toContain("LOOK-AHEAD — THIS ARTICLE IS A PREVIEW");
    expect(built.systemPrompt).toContain("Last week's results (facts.matchups) are context, never the subject.");
    expect(built.userPrompt).toContain("WEEK 8 SLATE — NONE OF THESE GAMES HAS BEEN PLAYED.");
    // Last week is present, but only as the one context line per side.
    expect(built.userPrompt).toContain("Gravel Pit Grinders last time out: week 7, beat Sable Ridge Sentinels 134.2-128.9");
    expect(built.userPrompt).toContain("Head-to-head on record: Gravel Pit Grinders leads 1-0");
  });

  it("refuses a preview when the payload has no unplayed games", () => {
    expect(() =>
      new PromptBuilder({
        ...factsRequestFor(fixturesByName["sparse-week"], "weekly_preview"),
        leagueId: "eval_sparse-week",
        persona: "curtis-vaughn",
      }).build()
    ).toThrow(InsufficientDataError);
  });

  it("carries the separated player keys through to FACTS", () => {
    const facts = buildFactsBlock(factsRequestFor(fixturesByName["rich-week"], "weekly_recap"));
    const ellery = facts.matchups[0].players.find((player) => player.name === "Duke Ellery");
    expect(ellery).toMatchObject({
      fantasyTeamId: "T10",
      nflTeam: "CAR",
      lineup: "bench",
      benchImpact: { wouldHaveReplaced: "Cole Vandermeer", pointGain: 17.9 },
    });
    // The legacy `team` key never reaches FACTS.
    expect(Object.keys(ellery ?? {})).not.toContain("team");
  });
});

describe("eval sweep: every fixture x writer x content type", () => {
  for (const fixture of fixtures) {
    for (const contentType of EVAL_CONTENT_TYPES) {
      const expected = expectations[fixture.name].byType[contentType];

      it(`${fixture.name}/${contentType}: facts.missing is exactly the recorded list`, () => {
        const facts = buildFactsBlock(factsRequestFor(fixture, contentType));
        expect(facts.missing).toEqual(expected.missing);
      });

      it(`${fixture.name}/${contentType}: ${expected.throws ? "every writer refuses" : "every writer builds a contract-first prompt"}`, () => {
        for (const persona of ACTIVE_WRITERS) {
          const options = {
            ...factsRequestFor(fixture, contentType),
            leagueId: `eval_${fixture.name}`,
            persona,
          };

          if (expected.throws) {
            expect(() => new PromptBuilder(options).build(), `${persona}`).toThrow(
              InsufficientDataError
            );
            continue;
          }

          const built = new PromptBuilder(options).build();
          const system = built.systemPrompt;

          // §4.4 order: contract, voice, quotes, relationships, template, gaps.
          expect(system.indexOf("GROUNDING CONTRACT"), `${persona} contract`).toBe(0);
          let previous = 0;
          for (const heading of ["WHO YOU ARE", "QUOTES", "RELATIONSHIPS", "TEMPLATE", "MISSING DATA"]) {
            const index = system.indexOf(`\n${heading}`);
            if (index < 0) continue; // RELATIONSHIPS / MISSING DATA are only emitted when they apply
            expect(index, `${persona} ${heading}`).toBeGreaterThan(previous);
            previous = index;
          }

          const voice = getPersona(persona).voice;
          expect(system.indexOf(voice), `${persona} voice`).toBeGreaterThan(0);
          expect(built.userPrompt.startsWith("<FACTS>"), `${persona} FACTS first`).toBe(true);
        }
      });
    }
  }
});

describe("recorded sample articles", () => {
  it("covers a clean article, a fabricated quote, a wrong fantasy team and a ghost speaker", () => {
    expect(samples.map((sample) => sample.name)).toEqual([
      "clean-weekly-recap",
      "fabricated-quote",
      "wrong-fantasy-team",
      "ghost-speaker",
    ]);
  });

  it.each(samples.map((sample) => sample.name))(
    "%s: the verifier reports exactly the recorded violations",
    (name) => {
      const sample = samples.find((candidate) => candidate.name === name)!;
      const fixture = fixturesByName[sample.fixture];
      expect(fixture, `${name} names a real fixture`).toBeDefined();

      const facts = buildFactsBlock(factsRequestFor(fixture, sample.contentType));
      const violations = verifyArticle(sample.article, facts);

      expect(violations.map((violation) => `${violation.kind}/${violation.severity}`).sort()).toEqual(
        sample.expected.map((violation) => `${violation.kind}/${violation.severity}`).sort()
      );

      for (const expectation of sample.expected) {
        expect(
          violations.some(
            (violation) =>
              violation.kind === expectation.kind &&
              violation.severity === expectation.severity &&
              (expectation.section === undefined || violation.section === expectation.section)
          ),
          `${name} expected ${expectation.kind}/${expectation.severity}`
        ).toBe(true);
      }
    }
  );
});
