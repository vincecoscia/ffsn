// The "Disputed" episode producer: runs the fixed rundown turn by turn, verifies every turn against
// FACTS, and assembles the finished transcript. No Anthropic SDK import here — `call` is injected by
// the caller (`anthropic-caller.ts` in this package, or a fake in tests), so this module stays pure
// TypeScript and testable offline.

import { computeCostUsd } from "../content-generation-service";
import type { RouteEffort, RouteModel, WriterRelationshipContext } from "../content-generation-service";
import type { FactsBlock } from "../facts";
import { verifyArticle } from "../fact-verifier";
import type { Violation } from "../fact-verifier";
import { PROFANITY_WORDS, STRONG_PROFANITY, stripExemptPhrases } from "../language";
import type { LanguageRating } from "../language";
import { getPersona, getPersonaDisplay, personaPrompts } from "../persona-prompts";
import type { PersonaPrompt } from "../persona-prompts";
import { naturalizeTranscript } from "./edit-bay";
import type { EditCaller } from "./edit-bay";
import { buildTurnSystemPrompt, buildTurnUserPrompt, ceilingFor, directorInstructionFor, roleRulesFor } from "./prompts";
import { resolveFactsTeamId } from "./question";
import {
  DEBATER_SLUGS,
  HOST_SLUG,
  roleOf,
  type ArticleClaim,
  type DebaterSides,
  type DebaterSlug,
  type ManagerMention,
  type SegmentId,
  type ShowBrief,
  type ShowRole,
  type ShowSegment,
  type ShowStats,
  type ShowTranscript,
  type ShowTurn,
  type TurnKind,
  type TurnOutput,
  type WitnessSlug,
} from "./types";

/** Article shape the verifier accepts. Imported as a type only — this module never calls the SDK. */
type WrappedArticle = Parameters<typeof verifyArticle>[0];

export interface Route {
  model: RouteModel;
  effort: RouteEffort;
}

export interface TurnCallRequest {
  speaker: string;
  model: RouteModel;
  effort: RouteEffort;
  /**
   * The FACTS block, byte-identical for every turn of the episode AND every speaker on the same
   * model — send it as the FIRST system block with its own cache breakpoint (pilot follow-up,
   * 2026-09-03: keyed after a per-speaker system prompt, it was a separate ~30k-token cache write
   * per speaker; keyed first, one write per model covers the whole episode).
   */
  systemPrefix: string;
  /** The per-speaker prompt (contract + who-you-are + relationships + show rules + role). Small; send as the second (also cached) system block — same string every time this speaker is called. */
  system: string;
  /** TRANSCRIPT SO FAR + DIRECTOR + the output contract. Changes on every call. Never cached. */
  user: string;
  maxTokens: number;
}

export interface TurnCallResult {
  output: TurnOutput;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  model: string;
}

export interface TurnCaller {
  (req: TurnCallRequest): Promise<TurnCallResult>;
}

export interface ProduceBudgets {
  /** Debater turns in the main event. Default 8 (edit-bay follow-up, 2026-09-03: was 10, was 14). */
  mainEvent?: number;
  /** Consecutive jab-with-no-fact turns before Curtis redirects. Default 3. */
  heatThreshold?: number;
  /** Witnesses called to the stand in one episode. Default 6. */
  maxWitnessCalls?: number;
  /** Curtis redirects every this many debater turns, on top of heat-triggered redirects. Default 4 (was 5, was 6). */
  redirectEvery?: number;
}

export interface ProduceRoutes {
  debater: Route;
  host: Route;
  witness: Route;
}

export interface ProduceOptions {
  budgets?: ProduceBudgets;
  routes?: ProduceRoutes;
  /**
   * When set, the episode runs through the edit bay (pass two, `edit-bay.ts#naturalizeTranscript`)
   * after pass one assembles the transcript: `result.transcript` becomes the edited transcript and
   * `result.rawTranscript` stays the untouched pass-one version. Omitted, `rawTranscript ===
   * transcript` and behaviour is unchanged.
   */
  naturalize?: { call: EditCaller; targetRatio?: number };
  /** Reserved for callers that want a deterministic clock; the producer does not read it itself. */
  now?: () => number;
}

export interface ProduceEpisodeInput {
  facts: FactsBlock;
  /** `serializeFacts(facts)`, computed once and reused for every turn's user prompt. */
  factsText: string;
  brief: ShowBrief;
  relationshipsByWriter: Record<string, WriterRelationshipContext[]>;
  /** Defaults to the real `personaPrompts`; a test may pass a smaller stand-in roster. */
  personas?: Record<string, PersonaPrompt>;
  call: TurnCaller;
  options?: ProduceOptions;
}

export interface ProduceEpisodeResult {
  /** The final transcript: edited by the edit bay when `options.naturalize` was set, otherwise identical to `rawTranscript`. */
  transcript: ShowTranscript;
  /** The pass-one transcript, before any edit-bay pass. `transcript === rawTranscript` without `options.naturalize`. */
  rawTranscript: ShowTranscript;
  stats: ShowStats;
  managerMentions: Array<ManagerMention & { persona: string }>;
  claims: Array<ArticleClaim & { persona: string }>;
}

const DEFAULT_BUDGETS: Required<ProduceBudgets> = {
  mainEvent: 8,
  heatThreshold: 3,
  maxWitnessCalls: 6,
  redirectEvery: 4,
};

const DEFAULT_ROUTES: ProduceRoutes = {
  debater: { model: "claude-opus-5", effort: "medium" },
  host: { model: "claude-sonnet-5", effort: "low" },
  witness: { model: "claude-sonnet-5", effort: "low" },
};

/** Output budget per call. Short turns; thinking tokens (effort) share this same ceiling. */
const MAX_TOKENS_BY_ROLE: Record<ShowRole, number> = { host: 500, witness: 650, debater: 900 };

/**
 * Which of `TurnOutput`'s optional fields are meaningful for a given turn kind. Everything else the
 * model returns for that turn is dropped rather than trusted — a stray `claim` on a witness turn, a
 * `verdict` from a debater, and so on.
 */
const ALLOWED_OPTIONAL_FIELDS: Record<TurnKind, ReadonlySet<string>> = {
  cold_open: new Set(["question", "sides", "managerMentions"]),
  opening: new Set(["claim", "managerMentions"]),
  argument: new Set(["witnessRequested", "agreesWithOpponent", "managerMentions"]),
  witness: new Set(["managerMentions"]),
  redirect: new Set(["witnessRequested", "managerMentions"]),
  grade: new Set(["verdict", "managerMentions"]),
  ledger: new Set(["managerMentions"]),
  jab: new Set(["managerMentions"]),
  close: new Set(["managerMentions"]),
};

function sanitizeTurnOutput(kind: TurnKind, output: TurnOutput): TurnOutput {
  const allowed = ALLOWED_OPTIONAL_FIELDS[kind];
  return {
    text: output.text,
    jab: output.jab,
    factsCited: output.factsCited ?? [],
    witnessRequested: allowed.has("witnessRequested") ? output.witnessRequested : undefined,
    agreesWithOpponent: allowed.has("agreesWithOpponent") ? output.agreesWithOpponent : undefined,
    managerMentions: allowed.has("managerMentions") ? output.managerMentions : undefined,
    claim: allowed.has("claim") ? output.claim : undefined,
    question: allowed.has("question") ? output.question : undefined,
    verdict: allowed.has("verdict") ? output.verdict : undefined,
    sides: allowed.has("sides") ? output.sides : undefined,
  };
}

/**
 * Same `kind`, `subjectTeamId`, `opponentTeamId` and `week` (spec follow-up, 2026-09-03: the pilot's
 * debaters made the identical prediction, so the ledger couldn't score a winner). `undefined` is
 * treated as equal to `undefined` on each field — two claims that both omit `week`, say, still count
 * as duplicates if everything else matches.
 */
/**
 * Two claims are the SAME claim only when every field that decides the outcome matches. Same
 * kind, subject and week with different rank or point bounds are opposed claims, not duplicates
 * (third pilot, 2026-09-03: Mel's "top four" and Reggie's "fifth or worse" were both `team_finish`
 * on the same team and week, and the coarser check threw Reggie's away).
 */
function isDuplicateClaim(a: ArticleClaim, b: ArticleClaim): boolean {
  return (
    a.kind === b.kind &&
    a.subjectTeamId === b.subjectTeamId &&
    a.opponentTeamId === b.opponentTeamId &&
    a.subjectPlayer === b.subjectPlayer &&
    a.week === b.week &&
    a.minRank === b.minRank &&
    a.maxRank === b.maxRank &&
    a.minPoints === b.minPoints
  );
}

/**
 * When the cold open's own output carries no `sides`, this derives one deterministically from the
 * hot seat so every later instruction still has a `mySide`/`opponentSide` to work with.
 */
function deriveFallbackSides(hotSeat: ShowBrief["hotSeat"], facts: FactsBlock): DebaterSides {
  const team = facts.teams.find((candidate) => candidate.id === hotSeat.teamId);
  return {
    "mel-diaper": `The process says no: judge the ${hotSeat.teamName} on the draft board and the lineup card its GM set, not the standings.`,
    "reggie-banks": team?.record
      ? `The scoreboard says yes: judge the ${hotSeat.teamName} on results, and the results are ${team.record}.`
      : `The scoreboard says yes: judge the ${hotSeat.teamName} on results.`,
  };
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Reggie's catchphrase, restricted to his last jab (pilot follow-up, 2026-09-03: the pilot used it
 * mid-argument). Case-insensitive, matches with any prefix ("You can take that to the bank",
 * "Book it — take that to the bank").
 */
export const CATCHPHRASE_PATTERN = /take that to the bank/i;

function containsCatchphrase(text: string): boolean {
  return CATCHPHRASE_PATTERN.test(text);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

const ALWAYS_CLEAN_SPEAKERS = new Set(["curtis-vaughn", "dex-alvarez", "sam-ortega"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The profanity a turn may not carry: every listed word for an always-clean speaker or at "clean",
 * the strong tier at "salty", nothing at "unfiltered". Words inside a team name are facts and never
 * count (the first Salty pilot, 2026-09-03, counted a team name as two strong hits).
 */
function languageViolations(
  speaker: string,
  text: string,
  rating: LanguageRating,
  teamNames: ReadonlyArray<string>
): string[] {
  const forbidden =
    ALWAYS_CLEAN_SPEAKERS.has(speaker) || rating === "clean"
      ? PROFANITY_WORDS
      : rating === "salty"
        ? STRONG_PROFANITY
        : [];
  if (forbidden.length === 0) return [];
  const scrubbed = stripExemptPhrases(text, teamNames);
  return forbidden.filter((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(scrubbed));
}

/** Drops the sentence(s) matching `pattern`, leaving the rest of the text as-is. */
function stripSentenceMatching(text: string, pattern: RegExp): string {
  const sentences = splitSentences(text);
  const kept = sentences.filter((sentence) => !pattern.test(sentence));
  return kept.length === sentences.length ? text : kept.join(" ").trim();
}

/**
 * Same as {@link stripSentenceMatching}, but a sentence is judged only after its team-name mentions
 * are scrubbed — so a turn with a genuine language violation in one sentence never also loses an
 * innocent sentence elsewhere purely for naming a team whose real, FACTS-spelled name happens to
 * contain a tracked word. Team names are always fine to print (house style, clean tier); only the
 * strip action needs this — `languageViolations` above already exempts team names when it decides
 * whether a retry is owed in the first place, but its own strip call operated on the raw text, so a
 * clean sentence that only *named* a crude team could be dropped alongside the real offender.
 */
function stripSentenceMatchingExempt(text: string, pattern: RegExp, teamNames: ReadonlyArray<string>): string {
  const sentences = splitSentences(text);
  const kept = sentences.filter((sentence) => !pattern.test(stripExemptPhrases(sentence, teamNames)));
  return kept.length === sentences.length ? text : kept.join(" ").trim();
}

/**
 * `verifyArticle` kinds that structurally cannot fire against the one-section, no-template article
 * a turn is wrapped as (see `wrapAsArticle` below) — kept here, and filtered defensively rather than
 * just trusted to stay silent, so a future change to `fact-verifier.ts` cannot start blocking every
 * turn on a check this producer never intended to run:
 *  - unknown_team, wrong_fantasy_team: only fire from `article.featuredTeams` / `featuredPlayers`,
 *    which the wrapped turn always leaves empty.
 *  - quote_not_placed: only fires from a non-empty `article.quotes`, which the wrapped turn never has
 *    (a turn speaks its quotes in `text`, not through the article pull-quote system).
 *  - thin_article, sections_missing, records_before_kickoff: only fire when a `template` option is
 *    passed to `verifyArticle`; the producer never passes one (a turn is not a templated article).
 *  - editor_hold, editor_voice, editor_unavailable, llm_contradicted, llm_unsupported: only ever
 *    produced by the optional LLM editor pass in `content-generation-service.ts`, which this build
 *    does not run.
 */
const FULL_ARTICLE_ONLY_KINDS = new Set<string>([
  "unknown_team",
  "wrong_fantasy_team",
  "quote_not_placed",
  "thin_article",
  "sections_missing",
  "records_before_kickoff",
  "editor_hold",
  "editor_voice",
  "editor_unavailable",
  "llm_contradicted",
  "llm_unsupported",
]);

/**
 * Every word of every desk member's name, lower-cased ("Simone", "Sam", "Ortega", ...). The
 * verifier's prose sweep reads a capitalised name it cannot find in FACTS as an unknown player;
 * on a show the desk address each other by name in nearly every turn ("Nina Sharpe, grade it",
 * "Ask Nina"), which is not a fabricated player (third pilot, 2026-09-03).
 */
export const DESK_NAME_WORDS = new Set<string>(
  Object.values(personaPrompts).flatMap((persona) =>
    persona.name
      .replace(/["“”]/g, " ")
      .split(/\s+/)
      .map((word) => word.toLowerCase())
      .filter((word) => word.length > 2)
  )
);

function mentionsDeskMember(detail: string): boolean {
  return detail
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^a-z]+/)
    .some((word) => DESK_NAME_WORDS.has(word));
}

/**
 * Exported so `edit-bay.ts`'s guard can run the same verifier check pass one does, against the
 * edit's rewritten text, without duplicating this filtering logic.
 */
export function relevantViolations(violations: Violation[]): Violation[] {
  return violations.filter((violation) => {
    if (FULL_ARTICLE_ONLY_KINDS.has(violation.kind)) return false;
    if (violation.kind === "unknown_player" && mentionsDeskMember(violation.detail)) return false;
    return true;
  });
}

/**
 * Wraps one turn (or, from `edit-bay.ts`, one edited segment's concatenated text) as the smallest
 * article `verifyArticle` accepts: one section, everything else empty. Exported so the edit bay's
 * guard runs the identical verifier check pass one does, rather than a second hand-rolled wrapper.
 */
export function wrapAsArticle(segmentId: SegmentId, sanitized: TurnOutput): WrappedArticle {
  const content = sanitized.text;
  return {
    title: "",
    summary: "",
    tone: "analytical",
    sections: [{ name: segmentId, content, wordCount: wordCount(content) }],
    featuredTeams: [],
    featuredPlayers: [],
    keyStats: [],
    quotes: [],
    managerMentions: sanitized.managerMentions ?? [],
    claims: sanitized.claim ? [sanitized.claim] : [],
  };
}

// `output` carries the sanitised `TurnOutput` alongside the assembled `ShowTurn` so a caller can
// read a kind-specific field `ShowTurn` itself does not carry (`question`, on the cold-open turn).
type TurnAttempt = { turn: ShowTurn; output: TurnOutput } | { dropped: true; wasDebater: boolean };

export async function produceEpisode(input: ProduceEpisodeInput): Promise<ProduceEpisodeResult> {
  const { facts, factsText, brief, relationshipsByWriter, call } = input;
  const personas = input.personas ?? personaPrompts;
  const budgets: Required<ProduceBudgets> = { ...DEFAULT_BUDGETS, ...input.options?.budgets };
  const routes: ProduceRoutes = input.options?.routes ?? DEFAULT_ROUTES;

  /**
   * Every persona on this desk carries their own relationship reading of each manager (that spread
   * is what picks the hot seat in the first place — see `question.ts`), so a speaker's own
   * RELATIONSHIPS block must come from `relationshipsByWriter[speaker]`, not from the single shared
   * `facts.relationships` a normal article request would carry for one writer. Verification still
   * reads the base `facts` below — relationships never affect what is factually verifiable.
   */
  function factsFor(speaker: string): FactsBlock {
    const raw = relationshipsByWriter[speaker] ?? [];
    if (raw.length === 0) return facts;
    return {
      ...facts,
      relationships: raw.map((entry) => ({
        teamId: resolveFactsTeamId(facts, entry.teamId, entry.teamName) ?? entry.teamId,
        manager: entry.managerName,
        score: entry.score,
        tier: entry.tier,
        recentEvents: entry.recentEvents ?? [],
      })),
    };
  }

  const systemPromptCache = new Map<string, string>();
  function systemPromptFor(speaker: string): string {
    const cached = systemPromptCache.get(speaker);
    if (cached !== undefined) return cached;
    const persona = personas[speaker] ?? getPersona(speaker);
    const built = buildTurnSystemPrompt(persona, factsFor(speaker), roleRulesFor(speaker), brief);
    systemPromptCache.set(speaker, built);
    return built;
  }

  const allTurns: ShowTurn[] = []; // running transcript, oldest first, across every segment so far
  // Each speaker's own most recent turn text, so an `argument` instruction can show a debater their
  // own last turn (their previous argument, or their opening statement the first time) and tell them
  // not to repeat its prediction or sign-off (pilot follow-up, 2026-09-03).
  const lastTurnTextBySpeaker = new Map<string, string>();

  const stats: ShowStats = {
    turns: 0,
    witnessCalls: 0,
    redirects: 0,
    retries: 0,
    dropped: 0,
    agreements: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    modelsUsed: [],
    catchphraseStripped: 0,
    languageStripped: 0,
    duplicateClaimsDropped: 0,
    violations: [],
  };
  const modelsUsed = new Set<string>();

  function renderSoFar(): string {
    return allTurns.map((turn) => `${getPersonaDisplay(turn.speaker).name}: ${turn.text}`).join("\n");
  }

  async function callTurn(
    speaker: string,
    system: string,
    directorInstruction: string,
    kind: TurnKind
  ): Promise<TurnCallResult> {
    const role = roleOf(speaker);
    const route = routes[role];
    // FACTS (`cachedPrefix`) moves to the system side, as the first system block, so every speaker
    // on the same model shares one cache entry for it (pilot follow-up, 2026-09-03: keyed after the
    // per-speaker system prompt instead, it was a separate ~30k-token write per speaker). Only the
    // ever-changing `suffix` goes in the user turn now — nothing there is worth caching.
    const { cachedPrefix, suffix } = buildTurnUserPrompt({
      factsText,
      transcriptSoFar: renderSoFar(),
      directorInstruction,
      brief,
      kind,
    });
    const result = await call({
      speaker,
      model: route.model,
      effort: route.effort,
      systemPrefix: cachedPrefix,
      system,
      user: suffix,
      maxTokens: MAX_TOKENS_BY_ROLE[role],
    });
    stats.promptTokens += result.usage.input;
    stats.completionTokens += result.usage.output;
    stats.costUsd += computeCostUsd(result.model, {
      input_tokens: result.usage.input,
      output_tokens: result.usage.output,
      cache_read_input_tokens: result.usage.cacheRead ?? 0,
      cache_creation_input_tokens: result.usage.cacheWrite ?? 0,
    });
    modelsUsed.add(result.model);
    return result;
  }

  function recordWordCeilingWarning(speaker: string, kind: TurnKind, text: string): void {
    const role = roleOf(speaker);
    const ceiling = ceilingFor(role, kind);
    const words = wordCount(text);
    if (words > ceiling * 1.5) {
      stats.violations.push({
        speaker,
        kind,
        detail: `${words} words, over 1.5x the ${ceiling}-word ceiling for a ${role} turn`,
        severity: "warn",
      });
    }
  }

  /**
   * Runs one turn end to end: call, sanitise, verify, retry once on a `block`, drop on a second
   * `block`. Every `strip`/`warn` finding is kept in `stats.violations` regardless of outcome.
   *
   * A non-jab Reggie turn also gets a narrower, independent check: his catchphrase is reserved for
   * the last jab (pilot follow-up, 2026-09-03: the pilot used it mid-argument). If it slips in here,
   * one retry with an explicit instruction not to; if it survives that too, the offending sentence is
   * stripped deterministically rather than spending a third call on it.
   */
  /**
   * A turn whose model call fails outright (network error, unusable output after the caller's own
   * retries) is dropped like a twice-blocked turn, so one bad call never throws away the twenty
   * turns before it (the third pilot episode, 2026-09-03, died on a single "Connection error"). The
   * episode still aborts after `MAX_CONSECUTIVE_CALL_FAILURES` failures in a row: at that point the
   * API is down, not flaky, and a transcript of nothing but Curtis redirects is worse than an error.
   */
  const MAX_CONSECUTIVE_CALL_FAILURES = 3;
  let consecutiveCallFailures = 0;

  async function produceTurn(
    kind: TurnKind,
    speaker: string,
    segmentId: SegmentId,
    directorInstruction: string
  ): Promise<TurnAttempt> {
    try {
      const attempt = await produceTurnUnguarded(kind, speaker, segmentId, directorInstruction);
      consecutiveCallFailures = 0;
      return attempt;
    } catch (error) {
      consecutiveCallFailures++;
      const message = error instanceof Error ? error.message : String(error);
      stats.violations.push({ speaker, kind: "call_failed", detail: message.slice(0, 240), severity: "block" });
      if (consecutiveCallFailures >= MAX_CONSECUTIVE_CALL_FAILURES) {
        throw new Error(
          `Disputed aborted after ${consecutiveCallFailures} consecutive failed turn calls; last failure (${speaker}, ${kind}): ${message}`
        );
      }
      stats.dropped++;
      return { dropped: true, wasDebater: roleOf(speaker) === "debater" };
    }
  }

  async function produceTurnUnguarded(
    kind: TurnKind,
    speaker: string,
    segmentId: SegmentId,
    directorInstruction: string
  ): Promise<TurnAttempt> {
    const system = systemPromptFor(speaker);

    let result = await callTurn(speaker, system, directorInstruction, kind);
    let sanitized = sanitizeTurnOutput(kind, result.output);
    let violations = relevantViolations(verifyArticle(wrapAsArticle(segmentId, sanitized), facts));
    let blocks = violations.filter((violation) => violation.severity === "block");
    let retried = false;

    if (blocks.length > 0) {
      retried = true;
      stats.retries++;
      const violationText = blocks.map((violation) => `- [${violation.kind}] ${violation.detail}`).join("\n");
      const retryInstruction = `${directorInstruction}\n\nYour previous attempt was rejected:\n${violationText}\nFix these specific problems and answer again.`;
      result = await callTurn(speaker, system, retryInstruction, kind);
      sanitized = sanitizeTurnOutput(kind, result.output);
      violations = relevantViolations(verifyArticle(wrapAsArticle(segmentId, sanitized), facts));
      blocks = violations.filter((violation) => violation.severity === "block");
    }

    for (const violation of violations) {
      stats.violations.push({ speaker, kind: violation.kind, detail: violation.detail, severity: violation.severity });
    }

    if (blocks.length > 0) {
      stats.dropped++;
      return { dropped: true, wasDebater: roleOf(speaker) === "debater" };
    }

    if (speaker === "reggie-banks" && kind !== "jab" && containsCatchphrase(sanitized.text)) {
      retried = true;
      const catchphraseInstruction = `${directorInstruction}\n\nDo not use your catchphrase here; it is reserved for your last jab.`;
      result = await callTurn(speaker, system, catchphraseInstruction, kind);
      sanitized = sanitizeTurnOutput(kind, result.output);
      if (containsCatchphrase(sanitized.text)) {
        sanitized = { ...sanitized, text: stripSentenceMatching(sanitized.text, CATCHPHRASE_PATTERN) };
        stats.catchphraseStripped++;
        stats.violations.push({
          speaker,
          kind: "catchphrase_stripped",
          detail: `"take that to the bank" is reserved for the last jab; the sentence carrying it was removed from a ${kind} turn`,
          severity: "warn",
        });
      }
    }

    // The league's language rating is enforced the way the catchphrase is: one retry that names
    // the words, then the sentence carrying them comes out. The prompt states the rating; this is
    // what makes it true.
    const rating: LanguageRating = brief.languageRating ?? "clean";
    const teamNames = facts.teams.map((team) => team.name);
    let offending = languageViolations(speaker, sanitized.text, rating, teamNames);
    if (offending.length > 0) {
      retried = true;
      const languageInstruction = `${directorInstruction}\n\nThat turn breaks the league's language rating (${rating}) for you: ${offending.join(", ")}. Say the same thing without those words.`;
      result = await callTurn(speaker, system, languageInstruction, kind);
      sanitized = sanitizeTurnOutput(kind, result.output);
      offending = languageViolations(speaker, sanitized.text, rating, teamNames);
      if (offending.length > 0) {
        const pattern = new RegExp(`\\b(?:${offending.map(escapeRegExp).join("|")})\\b`, "i");
        sanitized = { ...sanitized, text: stripSentenceMatchingExempt(sanitized.text, pattern, teamNames) };
        stats.languageStripped++;
        stats.violations.push({
          speaker,
          kind: "language_stripped",
          detail: `${offending.join(", ")} is outside the ${rating} rating for ${speaker}; the sentence carrying it was removed`,
          severity: "warn",
        });
      }
    }

    recordWordCeilingWarning(speaker, kind, sanitized.text);

    const turn: ShowTurn = {
      speaker,
      kind,
      text: sanitized.text,
      jab: sanitized.jab,
      factsCited: sanitized.factsCited ?? [],
      witnessRequested: sanitized.witnessRequested,
      agreesWithOpponent: sanitized.agreesWithOpponent,
      managerMentions: sanitized.managerMentions,
      claim: sanitized.claim,
      verdict: sanitized.verdict,
      model: result.model,
      retried: retried || undefined,
    };
    return { turn, output: sanitized };
  }

  function pushTurn(turn: ShowTurn): void {
    allTurns.push(turn);
    stats.turns++;
    lastTurnTextBySpeaker.set(turn.speaker, turn.text);
  }

  const segments: ShowSegment[] = [];

  /* ---------------------------------------------------------------------- *
   * 1. COLD OPEN — Curtis opens the show, sets the episode's question, and resolves each debater's
   *    side of it (spec follow-up, 2026-09-03: without this Mel and Reggie could both open on the
   *    same side and the binary question dissolved). Falls back to a deterministic pair of sides
   *    from the hot seat when the model's own output carries none, or the turn is dropped outright.
   * ---------------------------------------------------------------------- */
  let question = brief.fallbackQuestion;
  let sides: DebaterSides | undefined;
  {
    const instruction = directorInstructionFor("cold_open", { brief });
    const attempt = await produceTurn("cold_open", HOST_SLUG, "cold_open", instruction);
    const turns: ShowTurn[] = [];
    if (!("dropped" in attempt)) {
      pushTurn(attempt.turn);
      turns.push(attempt.turn);
      if (attempt.output.question) question = attempt.output.question;
      sides = attempt.output.sides;
    }
    segments.push({ id: "cold_open", title: "Cold Open", turns });
  }
  const resolvedSides: DebaterSides = sides ?? deriveFallbackSides(brief.hotSeat, facts);

  /* ---------------------------------------------------------------------- *
   * 2. OPENING STATEMENTS — Mel then Reggie, each staking a claim. Reggie sees Mel's opening and
   *    claim and must contradict it (spec follow-up, 2026-09-03: the pilot had both debaters make
   *    the identical prediction, so the ledger couldn't score a winner).
   * ---------------------------------------------------------------------- */
  const openingClaims: Partial<Record<DebaterSlug, ArticleClaim>> = {};
  let melOpeningTurn: ShowTurn | undefined;
  {
    const turns: ShowTurn[] = [];
    for (const speaker of DEBATER_SLUGS) {
      const instruction = directorInstructionFor("opening", {
        brief,
        question,
        mySide: resolvedSides[speaker],
        melsOpening:
          speaker === "reggie-banks" && melOpeningTurn
            ? { text: melOpeningTurn.text, claim: melOpeningTurn.claim }
            : undefined,
      });
      let attempt = await produceTurn("opening", speaker, "opening_statements", instruction);
      if (!("dropped" in attempt) && !attempt.turn.claim) {
        // A missing claim is not a verifier violation (nothing in `verifyArticle` checks for one),
        // so this retry is independent of `produceTurn`'s own block-violation retry above.
        const retryInstruction = `${instruction}\n\nYour previous attempt did not include a claim. State your position as a resolvable "claim" this time.`;
        const retryAttempt = await produceTurn("opening", speaker, "opening_statements", retryInstruction);
        if (!("dropped" in retryAttempt)) attempt = retryAttempt;
      }

      // Opposed-claims retry: Reggie's opening claim must contradict Mel's, never restate it.
      if (
        !("dropped" in attempt) &&
        speaker === "reggie-banks" &&
        attempt.turn.claim &&
        melOpeningTurn?.claim &&
        isDuplicateClaim(attempt.turn.claim, melOpeningTurn.claim)
      ) {
        const dupInstruction = `${instruction}\n\nYour claim duplicates Mel's; take the other side of it or make a different claim that proves your side.`;
        const dupAttempt = await produceTurn("opening", speaker, "opening_statements", dupInstruction);
        if (!("dropped" in dupAttempt)) attempt = dupAttempt;
        if (!("dropped" in attempt)) {
          // A duplicate-claim retry happened regardless of outcome; `produceTurn`'s own `retried`
          // flag on the (possibly brand-new) turn only reflects ITS internal verifier-block retry,
          // so it is overwritten here rather than trusted.
          attempt.turn.retried = true;
        }
        if (!("dropped" in attempt) && attempt.turn.claim && isDuplicateClaim(attempt.turn.claim, melOpeningTurn.claim)) {
          // Still duplicates (or the retry was itself dropped, leaving the original duplicate in
          // place): drop the claim, keep the turn's text.
          attempt.turn.claim = undefined;
          stats.duplicateClaimsDropped++;
          stats.violations.push({
            speaker,
            kind: "duplicate_claim",
            detail: "Reggie's opening claim duplicated Mel's after a retry; the claim was dropped, the turn text was kept",
            severity: "warn",
          });
        }
      }

      if (!("dropped" in attempt)) {
        pushTurn(attempt.turn);
        turns.push(attempt.turn);
        if (attempt.turn.claim) openingClaims[speaker] = attempt.turn.claim;
        if (speaker === "mel-diaper") melOpeningTurn = attempt.turn;
      }
    }
    segments.push({ id: "opening_statements", title: "Opening Statements", turns });
  }

  /* ---------------------------------------------------------------------- *
   * 3. MAIN EVENT — the debater budget, alternating Mel/Reggie, with witnesses called in and Curtis
   *    redirecting on heat or every `budgets.redirectEvery`th debater turn (default 4).
   * ---------------------------------------------------------------------- */
  {
    const turns: ShowTurn[] = [];
    let currentDebater: DebaterSlug = "mel-diaper";
    let debaterTurnsUsed = 0;
    let heat = 0;
    let agreementsUsed = 0;
    let witnessCallCount = 0;

    const callWitness = async (slug: WitnessSlug, requestedBy: string): Promise<void> => {
      if (witnessCallCount >= budgets.maxWitnessCalls) return;
      witnessCallCount++;
      stats.witnessCalls++;
      const instruction = directorInstructionFor("witness", { brief, question, requestedBy });
      const attempt = await produceTurn("witness", slug, "main_event", instruction);
      if (!("dropped" in attempt)) {
        pushTurn(attempt.turn);
        turns.push(attempt.turn);
        heat = attempt.turn.jab && attempt.turn.factsCited.length === 0 ? heat + 1 : 0;
      }
    };

    const callRedirect = async (): Promise<void> => {
      stats.redirects++;
      const instruction = directorInstructionFor("redirect", { brief, question });
      const attempt = await produceTurn("redirect", HOST_SLUG, "main_event", instruction);
      heat = 0;
      if ("dropped" in attempt) return;
      pushTurn(attempt.turn);
      turns.push(attempt.turn);
      if (attempt.turn.witnessRequested) await callWitness(attempt.turn.witnessRequested, HOST_SLUG);
    };

    while (debaterTurnsUsed < budgets.mainEvent) {
      const speaker = currentDebater;
      debaterTurnsUsed++;
      const opponent: DebaterSlug = speaker === "mel-diaper" ? "reggie-banks" : "mel-diaper";
      const instruction = directorInstructionFor("argument", {
        brief,
        question,
        agreementsUsed,
        previousTurnText: lastTurnTextBySpeaker.get(speaker),
        mySide: resolvedSides[speaker],
        opponentSide: resolvedSides[opponent],
      });
      const attempt = await produceTurn("argument", speaker, "main_event", instruction);

      if ("dropped" in attempt) {
        // Rejected twice; Curtis takes the floor instead of leaving a hole in the rundown.
        await callRedirect();
      } else {
        const turn = attempt.turn;
        if (turn.agreesWithOpponent) {
          if (agreementsUsed >= 1) {
            turn.agreesWithOpponent = false;
            stats.violations.push({
              speaker,
              kind: "agreement_capped",
              detail: "a second agreement this episode was stripped; only one is allowed",
              severity: "warn",
            });
          } else {
            agreementsUsed++;
          }
        }
        pushTurn(turn);
        turns.push(turn);
        heat = turn.jab && turn.factsCited.length === 0 ? heat + 1 : 0;

        if (turn.witnessRequested) await callWitness(turn.witnessRequested, speaker);

        if (heat >= budgets.heatThreshold || debaterTurnsUsed % budgets.redirectEvery === 0) {
          await callRedirect();
        }
      }

      currentDebater = currentDebater === "mel-diaper" ? "reggie-banks" : "mel-diaper";
    }

    stats.agreements = agreementsUsed;
    segments.push({ id: "main_event", title: "Main Event", turns });
  }

  /* ---------------------------------------------------------------------- *
   * 4. VERDICT — Nina grades the claims, Curtis reads the ledger.
   * ---------------------------------------------------------------------- */
  {
    const turns: ShowTurn[] = [];
    const gradeInstruction = directorInstructionFor("grade", { brief, question, openingClaims });
    let gradeAttempt = await produceTurn("grade", "nina-sharpe", "verdict", gradeInstruction);
    if (!("dropped" in gradeAttempt) && !gradeAttempt.turn.verdict) {
      const retryInstruction = `${gradeInstruction}\n\nYour previous attempt did not include a "verdict" naming a winner. Include one this time.`;
      const retryAttempt = await produceTurn("grade", "nina-sharpe", "verdict", retryInstruction);
      if (!("dropped" in retryAttempt)) gradeAttempt = retryAttempt;
    }
    if (!("dropped" in gradeAttempt)) {
      pushTurn(gradeAttempt.turn);
      turns.push(gradeAttempt.turn);
    }

    const ledgerInstruction = directorInstructionFor("ledger", { brief });
    const ledgerAttempt = await produceTurn("ledger", HOST_SLUG, "verdict", ledgerInstruction);
    if (!("dropped" in ledgerAttempt)) {
      pushTurn(ledgerAttempt.turn);
      turns.push(ledgerAttempt.turn);
    }

    segments.push({ id: "verdict", title: "Verdict", turns });
  }

  /* ---------------------------------------------------------------------- *
   * 5. LAST JABS — one shot each, then Curtis signs off.
   * ---------------------------------------------------------------------- */
  {
    const turns: ShowTurn[] = [];
    for (const speaker of DEBATER_SLUGS) {
      const instruction = directorInstructionFor("jab", { brief, jabSpeaker: speaker, mySide: resolvedSides[speaker] });
      const attempt = await produceTurn("jab", speaker, "last_jabs", instruction);
      if (!("dropped" in attempt)) {
        pushTurn(attempt.turn);
        turns.push(attempt.turn);
      }
    }
    const closeInstruction = directorInstructionFor("close", { brief });
    const closeAttempt = await produceTurn("close", HOST_SLUG, "last_jabs", closeInstruction);
    if (!("dropped" in closeAttempt)) {
      pushTurn(closeAttempt.turn);
      turns.push(closeAttempt.turn);
    }
    segments.push({ id: "last_jabs", title: "Last Jabs", turns });
  }

  const rawTranscript: ShowTranscript = {
    schema: "ffsn.transcript.v1",
    show: "disputed",
    week: brief.week,
    question,
    hotSeat: brief.hotSeat,
    sides: resolvedSides,
    language: brief.languageRating ?? "clean",
    segments,
  };

  const managerMentions: Array<ManagerMention & { persona: string }> = [];
  const claims: Array<ArticleClaim & { persona: string }> = [];
  for (const turn of allTurns) {
    for (const mention of turn.managerMentions ?? []) managerMentions.push({ ...mention, persona: turn.speaker });
    if (turn.claim) claims.push({ ...turn.claim, persona: turn.speaker });
  }

  // Pass two: the edit bay. Optional — without it `transcript` stays the same object as
  // `rawTranscript`, and its cost/usage never touch `stats`.
  let transcript: ShowTranscript = rawTranscript;
  if (input.options?.naturalize) {
    const { call, targetRatio } = input.options.naturalize;
    const naturalizeResult = await naturalizeTranscript(rawTranscript, { call, targetRatio, facts });
    transcript = naturalizeResult.transcript;
    stats.promptTokens += naturalizeResult.stats.promptTokens;
    stats.completionTokens += naturalizeResult.stats.completionTokens;
    stats.costUsd += naturalizeResult.stats.costUsd;
    for (const usedModel of naturalizeResult.stats.modelsUsed) modelsUsed.add(usedModel);
  }

  stats.modelsUsed = [...modelsUsed];

  return { transcript, rawTranscript, stats, managerMentions, claims };
}

export function renderTranscriptMarkdown(transcript: ShowTranscript): string {
  const lines: string[] = [];
  const teamSuffix = transcript.hotSeat ? ` · ${transcript.hotSeat.teamName}` : "";
  lines.push(`# Disputed · Week ${transcript.week ?? "?"}${teamSuffix}`);
  lines.push("");
  lines.push(transcript.question);
  for (const segment of transcript.segments) {
    lines.push("");
    lines.push(`## ${segment.title}`);
    for (const turn of segment.turns) {
      const display = getPersonaDisplay(turn.speaker);
      const plate = turn.interrupts ? `${display.name} (${display.role}), cutting in:` : `${display.name} (${display.role}):`;
      lines.push("");
      lines.push(`**${plate}** ${turn.text}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTranscriptPlain(transcript: ShowTranscript): string {
  const lines: string[] = [];
  lines.push(`Disputed - Week ${transcript.week ?? "?"}`);
  lines.push(transcript.question);
  for (const segment of transcript.segments) {
    lines.push("");
    lines.push(segment.title.toUpperCase());
    for (const turn of segment.turns) {
      const display = getPersonaDisplay(turn.speaker);
      const plate = turn.interrupts ? `${display.name} (${display.role}), cutting in:` : `${display.name} (${display.role}):`;
      lines.push(`${plate} ${turn.text}`);
    }
  }
  return lines.join("\n");
}
