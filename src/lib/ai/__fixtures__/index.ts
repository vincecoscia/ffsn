/**
 * Frozen eval fixtures (spec §8.7).
 *
 * Each `*.json` file is a recorded `LeagueDataContext` plus the comment/relationship ledger the
 * data layer would have passed alongside it, and each `*.expected.json` pins what the prompt layer
 * must make of it: FACTS counts, the exact `facts.missing` list per content type, and whether
 * `generatePrompt` is required to refuse with `InsufficientDataError`.
 *
 * The league, its ten managers and every number in it are invented. Nothing here is scraped from a
 * real league, and no real player is named.
 *
 * Consumed by `scripts/eval-articles.ts` and `tests/eval-fixtures.test.ts`. Fixtures are treated as
 * read-only: `Object.freeze` is deliberately not applied because the JSON imports are already
 * module-scoped singletons, so mutate nothing here.
 */

import type { GeneratedArticleT, PriorClaim } from "../content-generation-service";
import type { FactsRequest } from "../facts";
import type { InGameInjury, LeagueDataContext } from "../prompt-builder";

import draftDay from "./draft-day.json";
import draftDayExpected from "./draft-day.expected.json";
import emptyLeague from "./empty-league.json";
import emptyLeagueExpected from "./empty-league.expected.json";
import inGameInjury from "./in-game-injury.json";
import inGameInjuryExpected from "./in-game-injury.expected.json";
import richWeek from "./rich-week.json";
import richWeekExpected from "./rich-week.expected.json";
import sparseWeek from "./sparse-week.json";
import sparseWeekExpected from "./sparse-week.expected.json";

import cleanWeeklyRecap from "./samples/clean-weekly-recap.json";
import fabricatedQuote from "./samples/fabricated-quote.json";
import ghostSpeaker from "./samples/ghost-speaker.json";
import injuryBlame from "./samples/injury-blame.json";
import wrongFantasyTeam from "./samples/wrong-fantasy-team.json";

/**
 * The highest-volume content types the offline harness sweeps. `weekly_preview` is here because it
 * is the one look-ahead type: it must build from `upcomingMatchups` and refuse without them, and
 * only a sweep catches the regression where it quietly recaps last week instead.
 */
export const EVAL_CONTENT_TYPES = [
  "weekly_recap",
  "weekly_preview",
  "draft_rankings",
  "power_rankings",
  "trade_analysis",
] as const;

export type EvalContentType = (typeof EVAL_CONTENT_TYPES)[number];

export interface EvalFixture {
  name: string;
  description: string;
  leagueData: LeagueDataContext;
  commentResponses: NonNullable<FactsRequest["commentResponses"]>;
  nonRespondents: NonNullable<FactsRequest["nonRespondents"]>;
  relationships: NonNullable<FactsRequest["relationships"]>;
  priorClaims: PriorClaim[];
}

export interface FixtureExpectation {
  fixture: string;
  note: string;
  facts: {
    teams: number;
    matchups: number;
    matchupPlayers: number;
    standings: number;
    transactions: number;
    trades: number;
    draftPicks: number;
    quotes: number;
    nonRespondents: number;
    relationships: number;
    priorClaims: number;
    /** Players who left their game hurt (`facts.inGameInjuries`, The Wire spec §16.1). */
    inGameInjuries: number;
  };
  /** How many id references in FACTS failed to resolve to a team (`"T?"`). Always 0. */
  unresolvedTeamRefs: number;
  byType: Record<string, { missing: string[]; throws: string | null }>;
}

export interface EvalSample {
  name: string;
  fixture: string;
  contentType: string;
  persona: string;
  note: string;
  /** Every violation the deterministic verifier must report, in any order. */
  expected: Array<{ kind: string; severity: string; section?: string }>;
  article: GeneratedArticleT;
}

/** JSON imports widen to structural types; the fixtures are authored to these shapes. */
function asFixture(raw: unknown): EvalFixture {
  return raw as unknown as EvalFixture;
}

function asExpectation(raw: unknown): FixtureExpectation {
  return raw as unknown as FixtureExpectation;
}

function asSample(raw: unknown): EvalSample {
  return raw as unknown as EvalSample;
}

/**
 * rich-week with one in-game injury attached (The Wire spec §16.1). Composed here rather than
 * recorded as a second 19 KB copy of the same league, so the two payloads can never drift: the
 * JSON file carries only the injury list and the description.
 */
const inGameInjuryWeek: EvalFixture = {
  ...asFixture(richWeek),
  name: inGameInjury.name,
  description: inGameInjury.description,
  leagueData: {
    ...asFixture(richWeek).leagueData,
    inGameInjuries: inGameInjury.inGameInjuries as InGameInjury[],
  },
};

export const fixtures: EvalFixture[] = [
  asFixture(richWeek),
  asFixture(sparseWeek),
  asFixture(draftDay),
  asFixture(emptyLeague),
  inGameInjuryWeek,
];

export const fixturesByName: Record<string, EvalFixture> = Object.fromEntries(
  fixtures.map(fixture => [fixture.name, fixture])
);

export const expectations: Record<string, FixtureExpectation> = {
  "rich-week": asExpectation(richWeekExpected),
  "sparse-week": asExpectation(sparseWeekExpected),
  "draft-day": asExpectation(draftDayExpected),
  "empty-league": asExpectation(emptyLeagueExpected),
  "in-game-injury": asExpectation(inGameInjuryExpected),
};

export const samples: EvalSample[] = [
  asSample(cleanWeeklyRecap),
  asSample(fabricatedQuote),
  asSample(wrongFantasyTeam),
  asSample(ghostSpeaker),
  asSample(injuryBlame),
];

/**
 * `FactsRequest` with the prior claims narrowed to the prompt layer's `PriorClaim` (which requires
 * `articleId`), so the same object can be handed to `buildFactsBlock` and to `PromptBuilder`.
 */
export interface EvalRequest extends FactsRequest {
  priorClaims: PriorClaim[];
}

/** The `FactsRequest` / `PromptBuilderOptions` payload for one fixture and content type. */
export function factsRequestFor(fixture: EvalFixture, contentType: string): EvalRequest {
  return {
    contentType,
    leagueData: fixture.leagueData,
    commentResponses: fixture.commentResponses,
    nonRespondents: fixture.nonRespondents,
    relationships: fixture.relationships,
    priorClaims: fixture.priorClaims,
  };
}
