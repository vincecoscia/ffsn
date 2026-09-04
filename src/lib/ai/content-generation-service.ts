import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { generatePrompt, PromptBuilderOptions, LeagueDataContext, InsufficientDataError, languageSeedFor } from './prompt-builder';
import type { CleanTeam, LanguageRating } from './language';
import { cleanTeamViolations, countProfanity, MILD_PROFANITY, PROFANITY_WORDS, STRONG_PROFANITY, stripExemptPhrases } from './language';
import { enhancePromptWithComments } from './comment-integration';
import { contentTemplates } from './content-templates';
import { serializeFacts, type FactsBlock } from './facts';
import {
  findRegisterLeaks,
  parseQuoteDirectives,
  stripQuoteDirectives,
  verifyArticle,
  TITLE_SECTION,
  type Violation,
} from './fact-verifier';
import { shouldPublish } from './publish-gate';
import type {
  EditorFinding,
  EditorPassResult,
  EditorRegisterLeak,
  PublishGateFlag,
  PublishGateMetadata,
} from './publish-gate';
import { effectiveLanguageRange, getPersona } from './persona-prompts';
import type { RelationshipTier } from './persona-prompts';
import type { Id } from '../../../convex/_generated/dataModel';

/**
 * The publish gate and the editor-pass shapes live in `publish-gate.ts` (no SDK import, so Convex
 * can call them), and are re-exported here so the prompt layer has one import surface.
 */
export { shouldPublish };
export type {
  EditorFinding,
  EditorPassResult,
  EditorRegisterLeak,
  PublishGateFlag,
  PublishGateMetadata,
};


// Upper bound for the retry after a max_tokens truncation. Thinking tokens share this budget.
// Kept under ~21k: the Anthropic SDK refuses non-streaming requests it expects to run past ten
// minutes (about 21,333 tokens at its rate heuristic), and Convex actions time out at ten minutes.
const MAX_STRUCTURED_TOKENS = 21000;

/* ------------------------------------------------------------------------------------------- *
 * Model + effort routing (spec §10.3.1)
 *
 * Claude 5-family models reject sampling params (temperature/top_p); persona "heat" lives in the
 * system prompt instead. Model and effort are the only cost dials, and they are set per content
 * type so the eval matrix can move one type at a time without touching code.
 * ------------------------------------------------------------------------------------------- */

export type RouteModel = 'claude-opus-5' | 'claude-sonnet-5';
export type RouteEffort = 'low' | 'medium';
export interface GenerationRoute {
  model: RouteModel;
  effort: RouteEffort;
}

/** Everything that carries a quote or a grade stays here. */
export const DEFAULT_ROUTE: GenerationRoute = { model: 'claude-opus-5', effort: 'medium' };

/**
 * The shipped routes. A type absent from this table runs on {@link DEFAULT_ROUTE}; a routed type
 * reverts to Opus medium the moment the rubric matrix drops below `respectsTheFacts ≥ 4`.
 */
export const GENERATION_ROUTES: Record<string, GenerationRoute> = {
  // Sonnet 5, medium: short, low-stakes, no quotes and no grades.
  weekly_preview: { model: 'claude-sonnet-5', effort: 'medium' },
  waiver_wire_report: { model: 'claude-sonnet-5', effort: 'medium' },
  // Measured 2026-09-02: Sonnet scored 2/5 on voice and 3/5 on facts for Sam's team-name rankings
  // and 3/5 on facts for the trade block, below the §10.3 gate, so both stay on Opus.
  team_name_power_rankings: { model: 'claude-opus-5', effort: 'medium' },
  trade_block_tuesday: { model: 'claude-opus-5', effort: 'medium' },

  // Measured 2026-09-02: low effort did not reduce output tokens on these (playoff picture cost
  // more at low than at medium), so they run at medium like everything else on Opus.
  power_rankings: { model: 'claude-opus-5', effort: 'medium' },
  bank_statement: { model: 'claude-opus-5', effort: 'medium' },
  playoff_picture: { model: 'claude-opus-5', effort: 'medium' },
  emergency_hot_takes: { model: 'claude-opus-5', effort: 'medium' },

  // Opus 5, medium: quotes, grades, long form.
  weekly_recap: { model: 'claude-opus-5', effort: 'medium' },
  trade_analysis: { model: 'claude-opus-5', effort: 'medium' },
  trade_rumor_mill: { model: 'claude-opus-5', effort: 'medium' },
  rivalry_week_special: { model: 'claude-opus-5', effort: 'medium' },
  mid_season_awards: { model: 'claude-opus-5', effort: 'medium' },
  championship_manifesto: { model: 'claude-opus-5', effort: 'medium' },
  season_recap: { model: 'claude-opus-5', effort: 'medium' },
  season_welcome: { model: 'claude-opus-5', effort: 'medium' },
  custom_roast: { model: 'claude-opus-5', effort: 'medium' },
  commissioner_corner: { model: 'claude-opus-5', effort: 'medium' },
  hall_of_shame: { model: 'claude-opus-5', effort: 'medium' },
  player_glazing: { model: 'claude-opus-5', effort: 'medium' },
  mock_draft: { model: 'claude-opus-5', effort: 'medium' },
  draft_rankings: { model: 'claude-opus-5', effort: 'medium' },
  draft_strategy_guide: { model: 'claude-opus-5', effort: 'medium' },
};

function isRouteModel(value: unknown): value is RouteModel {
  return value === 'claude-opus-5' || value === 'claude-sonnet-5';
}
function isRouteEffort(value: unknown): value is RouteEffort {
  return value === 'low' || value === 'medium';
}

let overrideCache: { raw: string; routes: Record<string, GenerationRoute> } | null = null;

/**
 * `GENERATION_ROUTE_OVERRIDES` is a Convex env var holding the same JSON shape as
 * {@link GENERATION_ROUTES}. Malformed JSON, or an entry naming an unknown model or effort, is
 * logged and ignored — a bad env var must never take the desk offline.
 */
function routeOverrides(): Record<string, GenerationRoute> {
  const raw = process.env.GENERATION_ROUTE_OVERRIDES;
  if (!raw || raw.trim().length === 0) return {};
  if (overrideCache?.raw === raw) return overrideCache.routes;

  const routes: Record<string, GenerationRoute> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('GENERATION_ROUTE_OVERRIDES is not a JSON object; ignoring it');
    } else {
      for (const [contentType, value] of Object.entries(parsed as Record<string, unknown>)) {
        const model = (value as { model?: unknown } | null)?.model;
        const effort = (value as { effort?: unknown } | null)?.effort;
        if (isRouteModel(model) && isRouteEffort(effort)) {
          routes[contentType] = { model, effort };
        } else {
          console.warn(
            `Ignoring GENERATION_ROUTE_OVERRIDES entry for ${contentType}: ` +
              `expected { model: "claude-opus-5" | "claude-sonnet-5", effort: "low" | "medium" }`
          );
        }
      }
    }
  } catch (error) {
    console.warn('GENERATION_ROUTE_OVERRIDES is not valid JSON; ignoring it', error);
  }

  overrideCache = { raw, routes };
  return routes;
}

/** The model and effort this content type generates on, env override first. */
export function resolveRoute(contentType: string): GenerationRoute {
  return routeOverrides()[contentType] ?? GENERATION_ROUTES[contentType] ?? DEFAULT_ROUTE;
}

/** Sonnet-routed types fall back to Opus; Opus-routed types fall back to Sonnet. */
function fallbackModelFor(route: GenerationRoute): RouteModel {
  return route.model === 'claude-sonnet-5' ? 'claude-opus-5' : 'claude-sonnet-5';
}

/* ------------------------------------------------------------------------------------------- *
 * Cost accounting (spec §10.3.4)
 * ------------------------------------------------------------------------------------------- */

/** First-party list prices, USD per million tokens. */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
};

/** The subset of `Anthropic.Usage` that costs money. */
export interface CostUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Measured API cost of one call. Cache reads bill at 0.1x the input rate and cache writes at
 * 1.25x; `input_tokens` already excludes both. Message Batches bill at 50% of list.
 */
export function computeCostUsd(
  model: string,
  usage: CostUsage,
  opts?: { batch?: boolean }
): number {
  const price = MODEL_PRICES[model] ?? MODEL_PRICES['claude-opus-5'];
  const input = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const usd =
    (input * price.input +
      cacheRead * price.input * 0.1 +
      cacheWrite * price.input * 1.25 +
      output * price.output) /
    1_000_000;
  return opts?.batch ? usd * 0.5 : usd;
}

/** Running total across every call one article costs. */
interface CostLedger {
  usd: number;
  cacheReadTokens: number;
}

function accrue(ledger: CostLedger, message: Anthropic.Message, opts?: { batch?: boolean }): void {
  if (!message.usage) return;
  ledger.usd += computeCostUsd(message.model, message.usage, opts);
  ledger.cacheReadTokens += message.usage.cache_read_input_tokens || 0;
}

/** Same request with `strict` removed from every tool definition. */
function withoutStrictTools(
  params: Anthropic.MessageCreateParamsNonStreaming
): Anthropic.MessageCreateParamsNonStreaming {
  if (!params.tools) return params;
  return {
    ...params,
    tools: params.tools.map(tool =>
      'strict' in tool ? ({ ...tool, strict: undefined } as typeof tool) : tool
    ),
  };
}

// Errors worth retrying on the fallback model: model not found, server errors, overloaded.
function shouldFallback(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 500 || status === 503 || status === 529;
}

/* ------------------------------------------------------------------------------------------- *
 * Shared generation types (spec §4.2). `convex/aiNode.ts` imports these shapes.
 * ------------------------------------------------------------------------------------------- */

export interface CommentResponseData {
  /** `Id<"users">` as a string. */
  userId: string;
  userName: string;
  /** `Id<"teams">` as a string. */
  teamId: string;
  teamName: string;
  /** What the interviewer asked about, e.g. "benching a starting WR". */
  questionTopic: string;
  /** Verbatim, post-approval. At least one. */
  quotes: string[];
  rawResponse: string;
}

export interface NonRespondent {
  userId: string;
  userName: string;
  teamName: string;
  status: "no_response" | "declined";
}

export interface RelationshipEventSummary {
  type: string;
  delta: number;
  evidence: string;
  week?: number;
}

export interface WriterRelationshipContext {
  userId: string;
  teamId: string;
  teamName: string;
  managerName: string;
  score: number;
  tier: RelationshipTier;
  recentEvents: RelationshipEventSummary[];
}

export interface PriorClaim {
  articleId: string;
  week?: number;
  claim: string;
  outcome?: "hit" | "miss" | "open";
}

/** The writer's standing record in this league, from `claims.getPriorClaimsForWriter` (spec §8.4). */
export interface PriorRecord {
  hits: number;
  misses: number;
  open: number;
}

export interface GenerationRequest {
  leagueId: Id<"leagues">;
  contentType: string;
  persona: string;
  leagueData: LeagueDataContext;
  customContext?: string;
  userId: string;
  /** The week the article is about, when the caller knows it (a preview covers the week AFTER leagueData.currentWeek). */
  week?: number;
  commentResponses?: CommentResponseData[];
  nonRespondents?: NonRespondent[];
  relationships?: WriterRelationshipContext[];
  priorClaims?: PriorClaim[];
  priorRecord?: PriorRecord;
  /** League-level language rating (owner ask, Sept 2026); defaults to "clean" when absent. */
  languageRating?: LanguageRating;
  /** Team names whose managers opted down to clean coverage, regardless of `languageRating`. */
  cleanTeamNames?: string[];
}

/** Verifier findings, attached to the article so the commissioner sees every flagged sentence. */
export type ReviewFlag = Violation;

/* ------------------------------------------------------------------------------------------- *
 * Structured output schema v2
 * ------------------------------------------------------------------------------------------- */

const ArticleSection = z.object({
  name: z.string().describe("The section heading as readers will see it, in the writer's voice"),
  content: z.string().describe("The section content"),
  // Self-reported and unreliable; the service recomputes it from `content` after parsing. Kept
  // optional so a model that omits it does not fail the whole article.
  wordCount: z.number().default(0).describe("Number of words in the content (may be omitted)"),
});

/**
 * Opus 5 sometimes wraps a forced tool call's arguments in a single container key
 * (`{"parameters": {...}}`). Unwrap that before validating.
 */
const WRAPPER_KEYS = new Set([
  'parameters',
  'input',
  'article',
  'arguments',
  'generate_article',
  'rewrite_sections',
  'report_edit',
]);
function unwrapToolInput(input: unknown): unknown {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const keys = Object.keys(input as Record<string, unknown>);
    if (keys.length === 1 && WRAPPER_KEYS.has(keys[0])) {
      const inner = (input as Record<string, unknown>)[keys[0]];
      if (inner && typeof inner === 'object') return inner;
    }
  }
  return input;
}

function countWordsIn(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

const KeyStat = z.object({
  stat: z.string(),
  value: z.string(),
  context: z.string(),
  source: z
    .string()
    .describe("Dotted path into <FACTS>, e.g. 'matchups.M1.players.M1P3.points' or 'teams.T3.pointsFor'"),
});

const ArticleQuote = z.object({
  quoteId: z.string().describe("The id from facts.quotes. Must exist."),
  speaker: z.string(),
  teamId: z.string().describe("The FACTS team id of the speaker's team"),
  text: z.string().describe("VERBATIM from facts.quotes[].text. No paraphrase, no trimming."),
  questionTopic: z.string(),
  sectionName: z.string().describe("Which article section this quote appears in"),
  writerResponse: z
    .string()
    .describe("Your in-voice reply to this quote as it appears in the article, 1-3 sentences"),
});

/**
 * A prediction the writer made in this article (spec §8.4). `convex/claims.ts` resolves these
 * later and feeds the outcome back as `priorClaims` / `priorRecord`, so the fields exist to make
 * the claim machine-resolvable: team ids are FACTS ids, never names.
 */
export const ArticleClaim = z.object({
  text: z.string().describe("The prediction, phrased exactly as you wrote it in the article"),
  kind: z
    .enum(["team_win", "team_finish", "player_points", "trade_verdict", "general"])
    .describe(
      "team_win: a named team beats a named opponent in a week. team_finish: a team finishes above/below a rank. " +
        "player_points: a named player clears a point total. trade_verdict: who wins a trade. general: anything else."
    ),
  subjectTeamId: z.string().optional().describe("FACTS team id of the team the claim is about"),
  opponentTeamId: z.string().optional().describe("FACTS team id of the opponent, for team_win"),
  subjectPlayer: z.string().optional().describe("Player name exactly as it appears in FACTS"),
  week: z.number().optional().describe("The week the claim resolves in"),
  minRank: z.number().optional().describe("Best finishing rank the claim allows, for team_finish"),
  maxRank: z.number().optional().describe("Worst finishing rank the claim allows, for team_finish"),
  minPoints: z.number().optional().describe("Point total the player must clear, for player_points"),
});

export type ArticleClaimT = z.infer<typeof ArticleClaim>;

const ManagerMention = z.object({
  teamId: z.string().describe("MUST be a FACTS team id"),
  managerName: z.string(),
  stance: z.enum(["roast", "praise", "neutral"]),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  evidence: z.string().describe("The sentence from your article that carries the stance"),
});

const GeneratedArticle = z.object({
  title: z.string().describe("Article title"),
  summary: z.string().describe("Brief 2-3 sentence summary"),
  sections: z.array(ArticleSection).describe("Article sections as defined in the template"),
  featuredTeams: z
    .array(
      z.object({
        teamId: z.string().describe("MUST be a FACTS team id (T3, T7, ...)"),
        teamName: z.string(),
        mentions: z.number(),
      })
    )
    .describe("Teams prominently featured"),
  featuredPlayers: z
    .array(
      z.object({
        playerId: z.string().describe("MUST be a FACTS player id"),
        playerName: z.string(),
        position: z.string(),
        fantasyTeamId: z.string().describe("MUST be the player's FACTS fantasyTeamId"),
        nflTeam: z.string(),
        mentions: z.number(),
      })
    )
    .describe("Players prominently featured"),
  keyStats: z.array(KeyStat).optional().describe("Key statistics, each with its FACTS source path"),
  quotes: z.array(ArticleQuote).describe("Every ledger quote used in the article. Empty array if none."),
  managerMentions: z
    .array(ManagerMention)
    .describe("Every manager you roasted, praised or treated neutrally, with the sentence that did it"),
  claims: z
    .array(ArticleClaim)
    .optional()
    .describe(
      "Explicit predictions only, phrased as you wrote them. Empty array if you made none. " +
        "Team ids are FACTS ids."
    ),
  tone: z.enum(["humorous", "analytical", "dramatic", "casual", "professional"]),
});

export type GeneratedArticleT = z.infer<typeof GeneratedArticle>;

const RegeneratedSections = z.object({
  sections: z.array(ArticleSection).describe("Only the sections you were asked to rewrite"),
});

export interface GeneratedContent {
  title: string;
  content: string;
  summary: string;
  metadata: {
    week?: number;
    featuredTeams: string[];
    featuredPlayers: string[];
    tags: string[];
    creditsUsed: number;
    generationTime: number;
    modelUsed: string;
    promptTokens: number;
    completionTokens: number;
    /** Measured API cost of every call this article took, cache and batch pricing applied. */
    costUsd: number;
    /** The route the article actually generated on (spec §10.3.1). */
    route: GenerationRoute;
    /** Input tokens served from the prompt cache, summed across the calls. */
    cacheReadTokens: number;
    quotes: GeneratedArticleT["quotes"];
    managerMentions: GeneratedArticleT["managerMentions"];
    /** Explicit predictions, stored on `aiContent.claims` with `outcome: "open"` (spec §8.4). */
    claims: ArticleClaimT[];
    reviewFlags: ReviewFlag[];
    factsMissing: string[];
    verifierStats: VerifierStats;
    /**
     * The §11.2.7 editor pass, verbatim. `null` when the pass was disabled (`FACT_CHECK_LLM="0"`)
     * or failed; `convex/aiContent.ts` reads `factsScore` through `shouldPublish`.
     */
    editor: EditorPassResult | null;
  };
}

/** Desk metrics (spec §8.7). Stored as `aiContent.generationStats`. */
export interface VerifierStats {
  blocks: number;
  strips: number;
  warns: number;
  sectionsRegenerated: number;
  /** teams + matchups + players across matchups + transactions + trades + quotes. */
  factsCount: number;
  /** Words in the assembled body. */
  wordCount: number;
  /** Quotes offered in the ledger. */
  quotesOffered: number;
  /** Quotes still standing in `quotes[]` after verification. */
  quotesUsed: number;
  /** Whole-article regenerations this piece took: the thin retry, or the §11.2.8 hold retry. */
  fullRegenerations: number;
}

/* ------------------------------------------------------------------------------------------- *
 * Strip helpers
 * ------------------------------------------------------------------------------------------- */

function removeSentencesContaining(content: string, needle: string): string {
  const trimmed = needle.trim();
  if (trimmed.length === 0) return content;
  const sentences = content.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(sentence => !sentence.includes(trimmed));
  return kept.length === sentences.length ? content : kept.join(' ').trim();
}

/**
 * One `clean_team_language` strip per sentence that names an opted-down team (or its GM) and carries
 * profanity, section by section. `applyStrips` removes the quoted sentence from the named section.
 * Pure and exported for tests; `cleanTeams` empty (every league at clean) short-circuits to nothing.
 */
export function cleanTeamArticleViolations(
  article: Pick<GeneratedArticleT, 'sections'>,
  cleanTeams: ReadonlyArray<CleanTeam>,
  allTeamNames: ReadonlyArray<string>
): Violation[] {
  if (cleanTeams.length === 0) return [];
  const out: Violation[] = [];
  for (const section of article.sections) {
    for (const hit of cleanTeamViolations(section.content, cleanTeams, allTeamNames)) {
      out.push({
        kind: 'clean_team_language',
        detail: `"${hit.sentence.replace(/"/g, '')}" swears about ${hit.team}, whose manager asked for clean coverage; the sentence was removed`,
        section: section.name,
        severity: 'strip',
      });
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One `language_over_rating` strip per sentence the rating does not allow, section by section, in
 * reading order: at clean any tracked word; at salty any strong word, plus mild words once the
 * writer's allowance for the piece is spent; at unfiltered any tracked word once it is spent. Team
 * names never count. Mirrors the producer's per-turn enforcement for the show. Pure and exported for
 * tests.
 */
export function languageArticleViolations(
  article: Pick<GeneratedArticleT, 'sections'>,
  opts: { rating: LanguageRating; allowance: number; teamNames: ReadonlyArray<string> }
): Violation[] {
  const out: Violation[] = [];
  const outOfTier: ReadonlyArray<string> =
    opts.rating === 'clean' ? PROFANITY_WORDS : opts.rating === 'salty' ? STRONG_PROFANITY : [];
  const inTier: ReadonlyArray<string> = opts.rating === 'salty' ? MILD_PROFANITY : opts.rating === 'unfiltered' ? PROFANITY_WORDS : [];
  const has = (sentence: string, words: ReadonlyArray<string>): string[] => {
    const scrubbed = stripExemptPhrases(sentence, opts.teamNames);
    return words.filter(word => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(scrubbed));
  };
  let used = 0;
  for (const section of article.sections) {
    for (const sentence of section.content.split(/(?<=[.!?])\s+/)) {
      const bad = has(sentence, outOfTier);
      if (bad.length > 0) {
        out.push({
          kind: 'language_over_rating',
          detail: `"${sentence.trim().replace(/"/g, '')}" carries ${bad.join(', ')}, outside the league's ${opts.rating} rating; the sentence was removed`,
          section: section.name,
          severity: 'strip',
        });
        continue;
      }
      if (inTier.length === 0) continue;
      const counts = countProfanity(sentence, opts.teamNames);
      const carried = opts.rating === 'salty' ? counts.mild : counts.mild + counts.strong;
      if (carried === 0) continue;
      if (used + carried > opts.allowance) {
        out.push({
          kind: 'language_over_rating',
          detail: `"${sentence.trim().replace(/"/g, '')}" carries ${has(sentence, inTier).join(', ')}, past this writer's allowance of ${opts.allowance} for this piece; the sentence was removed`,
          section: section.name,
          severity: 'strip',
        });
        continue;
      }
      used += carried;
    }
  }
  return out;
}

/** Applies every `strip` (and every unfixable `block`) to a copy of the article. */
function applyStrips(article: GeneratedArticleT, violations: Violation[]): GeneratedArticleT {
  const next: GeneratedArticleT = JSON.parse(JSON.stringify(article));
  const actionable = violations.filter(v => v.severity === 'strip' || v.severity === 'block');
  if (actionable.length === 0) return next;

  const badQuoteIds = new Set<string>();
  const badTeamIds = new Set<string>();
  const badPlayerIds = new Set<string>();

  for (const violation of actionable) {
    switch (violation.kind) {
      case 'bad_source_path':
      case 'unverified_number': {
        const statName = violation.detail.split(/[:=]/)[0]?.trim();
        next.keyStats = (next.keyStats ?? []).filter(stat => stat.stat !== statName);
        break;
      }
      case 'bad_quote':
      case 'ghost_speaker': {
        const quoted = violation.detail.match(/["“]([^"“”]+)["”]/)?.[1];
        for (const section of next.sections) {
          if (violation.section && section.name !== violation.section) continue;
          if (quoted) section.content = removeSentencesContaining(section.content, quoted);
        }
        const idMatch = violation.detail.match(/\b(Q\d+)\b/);
        if (idMatch) badQuoteIds.add(idMatch[1]);
        if (!quoted && !idMatch) {
          // Ghost speaker named in prose: drop every sentence naming them alongside a quote mark.
          const speaker = violation.detail.split(':')[0]?.replace(/ did not respond.*/i, '').trim();
          if (speaker) {
            for (const section of next.sections) {
              if (violation.section && section.name !== violation.section) continue;
              section.content = section.content
                .split(/(?<=[.!?])\s+/)
                .filter(sentence => !(sentence.includes(speaker) && /["“”]/.test(sentence)))
                .join(' ')
                .trim();
            }
            next.quotes = next.quotes.filter(quote => quote.speaker !== speaker);
          }
        }
        break;
      }
      case 'unknown_team': {
        const id = violation.detail.match(/\(([^)]+)\)$/)?.[1];
        if (id) badTeamIds.add(id);
        break;
      }
      case 'unknown_player':
      case 'wrong_fantasy_team': {
        const id = violation.detail.match(/\(([^)]+)\)$/)?.[1];
        if (id) badPlayerIds.add(id);
        break;
      }
      case 'unknown_quote_directive': {
        const idMatch = violation.detail.match(/:::quote\{id=([A-Za-z0-9_-]+)\}/);
        if (idMatch) badQuoteIds.add(idMatch[1]);
        break;
      }
      case 'bad_claim': {
        // The claim is stripped, never the section it sits in (spec §8.4).
        const text = violation.detail.match(/claim "([^"]+)"/)?.[1];
        if (text) next.claims = (next.claims ?? []).filter(claim => claim.text !== text);
        break;
      }
      case 'llm_contradicted':
      case 'clean_team_language':
      case 'language_over_rating': {
        const sentence = violation.detail.match(/"([^"]+)"/)?.[1];
        if (sentence) {
          for (const section of next.sections) {
            if (violation.section && section.name !== violation.section) continue;
            section.content = removeSentencesContaining(section.content, sentence);
          }
        }
        break;
      }
    }
  }

  if (badQuoteIds.size > 0) {
    next.quotes = next.quotes.filter(quote => !badQuoteIds.has(quote.quoteId));
    // A quote that did not survive must not leave a dangling `:::quote{id=…}` behind.
    for (const section of next.sections) {
      section.content = stripQuoteDirectives(section.content, badQuoteIds);
    }
  }
  if (badTeamIds.size > 0) next.featuredTeams = next.featuredTeams.filter(team => !badTeamIds.has(team.teamId));
  if (badPlayerIds.size > 0) {
    next.featuredPlayers = next.featuredPlayers.filter(player => !badPlayerIds.has(player.playerId));
  }

  return next;
}

/**
 * Ledger quote ids named anywhere in a set of violations. Only the quote kinds are read: a
 * `data_speak` violation quotes the leaked token itself, and "Q1" leaking into the prose must not
 * delete quote Q1 from the article.
 */
const QUOTE_BEARING_KINDS = new Set(['bad_quote', 'ghost_speaker', 'unknown_quote_directive']);
function quoteIdsIn(violations: Violation[]): Set<string> {
  const ids = new Set<string>();
  for (const violation of violations) {
    if (!QUOTE_BEARING_KINDS.has(violation.kind)) continue;
    const direct = violation.detail.match(/:::quote\{id=([A-Za-z0-9_-]+)\}/)?.[1];
    if (direct) ids.add(direct);
    const ledger = violation.detail.match(/\b(Q\d+)\b/)?.[1];
    if (ledger) ids.add(ledger);
  }
  return ids;
}

/**
 * Section regeneration must not lose a pull quote that was never the problem. Any directive the
 * original section carried — except for quotes the verifier rejected — is put back.
 */
function preserveQuoteDirectives(original: string, rewritten: string, dropped: Set<string>): string {
  const kept = parseQuoteDirectives(original).filter(id => !dropped.has(id));
  if (kept.length === 0) return stripQuoteDirectives(rewritten, dropped);
  const cleaned = stripQuoteDirectives(rewritten, dropped);
  const present = new Set(parseQuoteDirectives(cleaned));
  const missing = kept.filter(id => !present.has(id));
  if (missing.length === 0) return cleaned;
  return `${cleaned.trimEnd()}\n\n${missing.map(id => `:::quote{id=${id}}`).join('\n')}`;
}

/** Desk metric: how many facts the writer was given (spec §8.7). */
function countFacts(facts: FactsBlock): number {
  const players = facts.matchups.reduce((total, matchup) => total + matchup.players.length, 0);
  return (
    facts.teams.length +
    facts.matchups.length +
    players +
    facts.transactions.length +
    facts.trades.length +
    facts.quotes.length
  );
}

function countWords(body: string): number {
  return body.trim().split(/\s+/).filter(Boolean).length;
}

/* ------------------------------------------------------------------------------------------- *
 * Editor pass (spec §11.2.7)
 *
 * One Sonnet 5 call per article, on by default for every content type. It is the second reader the
 * desk cannot hire: it re-reads the body against <FACTS> and against the writer's own voice and
 * reports contradictions, unsupported claims, register leaks the deterministic patterns cannot
 * anticipate, and two 1-5 scores. `factsScore < 3` holds the article; `voiceScore < 3` only warns.
 *
 * It replaces the §8.6 opt-in fact-check pass, whose findings are a subset of this one's.
 * ------------------------------------------------------------------------------------------- */

const EditorFindingSchema = z.object({
  claim: z
    .string()
    .describe("The sentence from the article body, copied verbatim, that carries the claim"),
  sectionName: z.string().describe("The heading of the section the sentence is in"),
  factPath: z
    .string()
    .optional()
    .describe("Dotted path into <FACTS> that settles it, e.g. 'teams.T3.pointsFor'"),
});

const EditorReport = z.object({
  contradictions: z
    .array(EditorFindingSchema)
    .default([])
    .describe("Sentences <FACTS> carries something different about. Empty array if none."),
  unsupported: z
    .array(EditorFindingSchema)
    .default([])
    .describe("Sentences <FACTS> neither carries nor denies. Empty array if none."),
  registerLeaks: z
    .array(
      z.object({
        phrase: z.string().describe("The exact phrase, copied from the body or the title"),
        sectionName: z.string().describe("The section heading, or the title"),
      })
    )
    .default([])
    .describe("Phrases that read as data-pipeline language rather than broadcast English"),
  factsScore: z.coerce
    .number()
    .describe("1-5. 5 = every factual sentence is in <FACTS>. 3 = nothing wrong, some slack."),
  voiceScore: z.coerce.number().describe("1-5. How much this reads like the writer described above."),
  incompleteSections: z
    .array(z.string())
    .default([])
    .describe("Headings of sections that stop early, repeat themselves, or say nothing"),
});

const EDITOR_SYSTEM = `You are the desk editor for a fantasy football network. You read one article
against the <FACTS> block it was written from, and you are the last person to see it before it
publishes with nobody watching.

Report:
- contradictions: a factual sentence that <FACTS> says something different about. Give the factPath.
- unsupported: a factual sentence <FACTS> neither carries nor denies.
- registerLeaks: phrases that belong to the data, not to broadcasting — field names (pointsFor,
  benchImpact, nflTeam), internal ids (T3, M1, Q2), timestamps, "the ledger", "the payload", "the
  data feed", "per the sheet", or any sentence that describes where a number came from instead of
  what it means. NOT leaks: hand-offs to another desk ("Numbers desk has more on that", "Insider
  desk is working it"), ":::quote{id=…}" lines (renderer markup for a pull quote), "on the record",
  "did not respond to a request for comment", stating that a number is a projection, and the draft
  desk's own vocabulary on draft grades ("ADP", "value against ADP", a "delta" of picks).
- incompleteSections: headings whose body stops early, repeats another section, or says nothing.
- factsScore 1-5: 5 = every factual sentence resolves to <FACTS>; 3 = nothing is wrong but some
  claims are loose; 1 = the article invents things.
- voiceScore 1-5: how much it reads like the writer described in the prompt below.

Opinions, predictions, jokes and stated uncertainty are not factual claims — skip them. Arithmetic
on two <FACTS> numbers is supported. When <FACTS> carries a playoffs block (seeds, bracket, byes,
alive, eliminated, champion, runnerUp), it supports claims about titles, eliminations, byes and who
is still in contention; a team's record is its regular-season record, so a playoff win never
changes it and a sentence that adds one to the record is a contradiction. Copy each claim verbatim from the body. Report nothing you are
not sure about; a short list of real findings is the goal.`;

/** §11.2.7: on for every type unless the deployment turns it off with `FACT_CHECK_LLM="0"`. */
export function editorPassEnabled(): boolean {
  return process.env.FACT_CHECK_LLM !== '0';
}

/** Scores arrive as 1-5; anything else is clamped rather than thrown away. */
function clampScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return 3;
  return Math.min(5, Math.max(1, Math.round(score)));
}

function editorHoldReason(report: EditorPassResult): string {
  const parts: string[] = [];
  if (report.contradictions.length > 0) parts.push(`${report.contradictions.length} contradiction(s)`);
  if (report.unsupported.length > 0) parts.push(`${report.unsupported.length} unsupported claim(s)`);
  if (report.incompleteSections.length > 0) {
    parts.push(`incomplete: ${report.incompleteSections.join(', ')}`);
  }
  if (report.registerLeaks.length > 0) parts.push(`${report.registerLeaks.length} register leak(s)`);
  return parts.length > 0 ? parts.join('; ') : 'no reason given';
}

/**
 * Runs the editor and turns its report into violations. Every failure of the pass itself —
 * transport, refusal, malformed output — is logged and swallowed: it must never cost an article.
 */
async function runEditorPass(
  anthropic: Anthropic,
  prepared: PreparedArticleRequest,
  article: GeneratedArticleT,
  ledger: CostLedger
): Promise<{ result: EditorPassResult; violations: Violation[] } | null> {
  const spentBefore = ledger.usd;
  try {
    const body = article.sections
      .map(section => `## ${section.name}\n${section.content}`)
      .join('\n\n');
    const persona = getPersona(prepared.request.persona);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: 'claude-sonnet-5',
      max_tokens: 900,
      output_config: { effort: 'low' },
      system: `${EDITOR_SYSTEM}\n\nTHE WRITER\n${persona.voice}`,
      messages: [
        {
          role: 'user' as const,
          content: `${serializeFacts(prepared.facts)}\n\nTITLE\n${article.title}\n\nARTICLE BODY\n\n${body}`,
        },
      ],
      tools: [
        {
          name: 'report_edit',
          strict: true,
          description: 'Report the edit: findings, register leaks and the two scores',
          input_schema: { ...zodToJsonSchema(EditorReport, { $refStrategy: "none" }), type: 'object' } as const,
        },
      ],
      tool_choice: { type: 'tool' as const, name: 'report_edit' },
    };

    let message: Anthropic.Message;
    try {
      message = await anthropic.messages.create(params);
    } catch (error) {
      if (error instanceof Anthropic.BadRequestError && /strict/i.test(error.message)) {
        message = await anthropic.messages.create(withoutStrictTools(params));
      } else {
        throw error;
      }
    }
    accrue(ledger, message);

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
    if (!toolUse) {
      console.warn('Editor pass returned no tool call; continuing without it');
      return null;
    }
    const parsed = EditorReport.safeParse(unwrapToolInput(toolUse.input));
    if (!parsed.success) {
      console.warn('Editor pass returned an unusable report; continuing without it', {
        issues: parsed.error.issues.slice(0, 3).map(issue => issue.message),
      });
      return null;
    }

    const result: EditorPassResult = {
      contradictions: parsed.data.contradictions,
      unsupported: parsed.data.unsupported,
      registerLeaks: parsed.data.registerLeaks,
      factsScore: clampScore(parsed.data.factsScore),
      voiceScore: clampScore(parsed.data.voiceScore),
      incompleteSections: parsed.data.incompleteSections,
      model: message.model || 'claude-sonnet-5',
      costUsd: ledger.usd - spentBefore,
    };

    // Where a finding lands. The editor names the heading it read, which is usually one of ours;
    // when it is not, the phrase itself is looked up so the rewrite still has an address.
    const sectionNames = new Set(article.sections.map(section => section.name));
    const locate = (name: string, phrase?: string): string | undefined => {
      if (sectionNames.has(name)) return name;
      if (phrase) {
        const holder = article.sections.find(section => section.content.includes(phrase));
        if (holder) return holder.name;
        if (article.title.includes(phrase)) return TITLE_SECTION;
      }
      return undefined;
    };

    // Calibration (dev end-to-end, 2026-09-02): the editor stripped a sentence that FACTS supported
    // (a defense's 21.0 for the right team) and would have held a sound article. A single LLM
    // judgment is not enough to cut copy; a contradiction only strips when the editor also scores
    // the article's facts 3 or lower, and a register leak only forces a rewrite when the
    // deterministic pattern check agrees. Everything else is a warning the digest will show.
    const contradictionSeverity: Violation['severity'] = result.factsScore <= 3 ? 'strip' : 'warn';
    const violations: Violation[] = [
      ...result.contradictions.map(finding => ({
        kind: 'llm_contradicted' as const,
        detail: `"${finding.claim}"${finding.factPath ? ` (${finding.factPath})` : ''}`,
        section: locate(finding.sectionName, finding.claim),
        severity: contradictionSeverity,
      })),
      ...result.unsupported.map(finding => ({
        kind: 'llm_unsupported' as const,
        detail: `"${finding.claim}"${finding.factPath ? ` (${finding.factPath})` : ''}`,
        section: locate(finding.sectionName, finding.claim),
        severity: 'warn' as const,
      })),
      // The editor's register leaks are the same violation as the deterministic ones, so they feed
      // the same single section rewrite (spec §11.2.7).
      ...result.registerLeaks.map(leak => ({
        kind: 'data_speak' as const,
        detail: `"${leak.phrase}" is pipeline language, not something a broadcaster says. Remove it and write the same point in plain English.`,
        section: locate(leak.sectionName, leak.phrase),
        severity: (findRegisterLeaks(leak.phrase).length > 0 ? 'block' : 'warn') as Violation['severity'],
      })),
    ];

    // A low facts score with nothing cited behind it is an editor that lost its notes (the
    // rubric parse is known to drop findings), not a verdict: it is logged as a warning, never a
    // hold. A low score WITH findings still holds the piece.
    const editorFindings = result.contradictions.length + result.unsupported.length + result.registerLeaks.length;
    if (result.factsScore < 3 && editorFindings > 0) {
      violations.push({
        kind: 'editor_hold',
        detail: `the editor scored the facts ${result.factsScore}/5: ${editorHoldReason(result)}`,
        severity: 'strip',
      });
    } else if (result.factsScore < 3) {
      violations.push({
        kind: 'editor_hold',
        detail: `the editor scored the facts ${result.factsScore}/5 but cited nothing; not holding on an unexplained score`,
        severity: 'warn',
      });
    }
    if (result.voiceScore < 3) {
      violations.push({
        kind: 'editor_voice',
        detail: `the editor scored the voice ${result.voiceScore}/5 for ${persona.name}`,
        severity: 'warn',
      });
    }

    return { result, violations };
  } catch (error) {
    console.warn('Editor pass failed; keeping the deterministic result', error);
    return null;
  }
}

/**
 * A register leak in the title has no section to rewrite, so the title is derived from the body
 * instead (spec §11.2.4). Deterministic and free: the first clean sentence of the body, else the
 * summary, else a section heading.
 */
export function retitleFromBody(article: GeneratedArticleT): string | null {
  const firstSentence = (text: string): string =>
    (text ?? '')
      .replace(/^[ \t]*:::quote\{id=[A-Za-z0-9_-]+\}[ \t]*$/gm, '')
      .trim()
      .split(/(?<=[.!?])\s+/)[0] ?? '';

  const candidates = [
    firstSentence(article.sections?.[0]?.content ?? ''),
    firstSentence(article.summary ?? ''),
    ...(article.sections ?? []).map(section => section.name),
  ];

  for (const candidate of candidates) {
    const cleaned = candidate.replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
    if (cleaned.length < 8) continue;
    if (findRegisterLeaks(cleaned).length > 0) continue;
    if (cleaned.length <= 70) return cleaned;
    const clipped = cleaned.slice(0, 70);
    const cut = clipped.lastIndexOf(' ');
    return (cut > 20 ? clipped.slice(0, cut) : clipped).trim();
  }
  return null;
}

/* ------------------------------------------------------------------------------------------- *
 * Request preparation — the one place the article request is built (spec §10.3.5)
 *
 * `prepareArticleRequest` returns exactly what the direct path sends, so `convex/aiBatch.ts` can
 * put the same `params` into a Message Batch and finish the article with
 * `completeArticleFromMessage` on the other side. Nothing in this module imports Convex.
 * ------------------------------------------------------------------------------------------- */

const OUTPUT_CONTRACT = `OUTPUT CONTRACT
Return one call to the generate_article tool. Requirements:
- sections[].name is the heading a reader sees, written in your voice — never a template field name.
- featuredTeams[].teamId and featuredPlayers[].playerId/fantasyTeamId are ids copied from <FACTS>.
- keyStats[].source is the dotted <FACTS> path the number came from, e.g. "teams.T3.pointsFor".
- Use only the ledger quotes that belong in this story. You are not required to use every quote,
  and you must never tack an unrelated quote onto the end of a piece to use it up.
- quotes[] lists every ledger quote you used, text copied character-for-character from facts.quotes,
  with your in-voice reply to it in writerResponse. Each of those quotes is placed in the body with
  its own ":::quote{id=…}" directive line and is never repeated inside quotation marks.
- managerMentions[] lists every manager you roasted or praised, with the exact sentence as evidence.
- claims[] lists every explicit prediction you made, phrased as you wrote it, with FACTS team ids in
  subjectTeamId/opponentTeamId. If you predicted nothing, claims is an empty array. Do not put
  opinions, grades or descriptions of the present in claims — only statements about what will happen.
- Word counts are ceilings. A shorter accurate section beats a padded one.`;

/**
 * The system prompt is byte-stable per persona (contract + voice + quote rules, no timestamps),
 * so it is worth a cache breakpoint: repeat generations for the same writer read it at 0.1x.
 */
// Article system prompts are NOT cached on purpose: the template and missing-data blocks make the
// prompt differ per content type, so the matrix run saw zero cache reads and paid the 25% write
// premium on every call. The interviewer keeps caching (its system prompt is stable and its calls
// cluster in time) - see conversation-service.ts.

function articleParams(
  model: string,
  maxTokens: number,
  effort: RouteEffort,
  systemPrompt: string,
  userPrompt: string
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: maxTokens,
    output_config: { effort },
    system: systemPrompt,
    messages: [{ role: 'user' as const, content: userPrompt }],
    tools: [
      {
        name: 'generate_article',
        strict: true,
        description: 'Generate a structured fantasy football article',
        input_schema: { ...zodToJsonSchema(GeneratedArticle, { $refStrategy: "none" }), type: 'object' } as const,
      },
    ],
    tool_choice: { type: 'tool' as const, name: 'generate_article' },
  };
}

export interface PreparedArticleRequest {
  /** Exactly what the direct path sends, and exactly what a batch request should carry. */
  params: Anthropic.MessageCreateParamsNonStreaming;
  facts: FactsBlock;
  systemPrompt: string;
  /** The user turn as sent: the prose prompt plus the output contract. */
  userPrompt: string;
  route: GenerationRoute;
  maxTokens: number;
  /** Kept so `completeArticleFromMessage` can finish the article without the caller's help. */
  request: GenerationRequest;
  /** `Date.now()` at prepare time; the direct path reports it as `metadata.generationTime`. */
  startedAt: number;
}

/** Build the FACTS block, both prompts and the request params for one article. */
export async function prepareArticleRequest(
  request: GenerationRequest
): Promise<PreparedArticleRequest> {
  const startedAt = Date.now();

  const promptOptions: PromptBuilderOptions = {
    leagueId: request.leagueId,
    contentType: request.contentType,
    persona: request.persona,
    leagueData: {
      ...request.leagueData,
      memorableMoments: request.leagueData.memorableMoments || [],
    },
    customContext: request.customContext,
    includeExamples: true,
    commentResponses: request.commentResponses,
    nonRespondents: request.nonRespondents,
    relationships: request.relationships,
    priorClaims: request.priorClaims,
    priorRecord: request.priorRecord,
    languageRating: request.languageRating,
    cleanTeamNames: request.cleanTeamNames,
  };

  const built = await generatePrompt(promptOptions);
  const { systemPrompt, facts, maxTokens } = built;
  let prose = built.userPrompt;

  // The FACTS ledger is normative; this is only a readable rendering of the same quotes.
  if (request.commentResponses && request.commentResponses.length > 0) {
    prose = enhancePromptWithComments(prose, {
      commentResponses: request.commentResponses,
      nonRespondents: request.nonRespondents ?? [],
      contentType: request.contentType,
      week: request.leagueData.currentWeek,
    });
  }

  const userPrompt = `${prose}\n\n${OUTPUT_CONTRACT}`;
  const route = resolveRoute(request.contentType);

  return {
    params: articleParams(route.model, maxTokens, route.effort, systemPrompt, userPrompt),
    facts,
    systemPrompt,
    userPrompt,
    route,
    maxTokens,
    request,
    startedAt,
  };
}

/* ------------------------------------------------------------------------------------------- *
 * Model calls
 * ------------------------------------------------------------------------------------------- */

/**
 * Runs a request on the routed model, retrying on the route's fallback for transport failures and
 * for safety refusals. Never sends temperature — Claude 5-family models reject sampling params.
 * Every discarded attempt is billed, so its usage lands in `ledger`.
 */
async function createWithFallback(
  anthropic: Anthropic,
  route: GenerationRoute,
  build: (model: string) => Anthropic.MessageCreateParamsNonStreaming,
  ledger: CostLedger
): Promise<Anthropic.Message> {
  const fallback = fallbackModelFor(route);
  let message: Anthropic.Message;

  try {
    message = await anthropic.messages.create(build(route.model));
  } catch (error: unknown) {
    // Strict tool schemas guarantee the tool input validates, which removes a whole class of
    // parse failures. If the API rejects a schema feature under strict mode, retry without it.
    if (error instanceof Anthropic.BadRequestError && /strict/i.test(error.message)) {
      console.warn('Strict tool schema rejected by the API; retrying without strict:', error.message);
      message = await anthropic.messages.create(withoutStrictTools(build(route.model)));
    } else if (!shouldFallback(error)) {
      console.error('Claude API call failed:', error);
      throw error;
    } else {
      console.warn(`${route.model} failed, trying ${fallback}...`);
      message = await anthropic.messages.create(build(fallback));
    }
  }

  if (message.stop_reason === 'refusal') {
    console.warn(
      `${message.model} refused (category: ${message.stop_details?.category ?? 'unknown'}), trying ${fallback}...`
    );
    accrue(ledger, message);
    message = await anthropic.messages.create(build(fallback));
    if (message.stop_reason === 'refusal') {
      throw new Error(
        `Content generation was refused by the model (category: ${message.stop_details?.category ?? 'unknown'})`
      );
    }
  }

  return message;
}

/** Locate and validate the generate_article tool call, reporting why it is unusable. */
function parseArticleToolCall(
  message: Anthropic.Message
): { success: true; data: GeneratedArticleT } | { success: false; error: string } {
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  );
  if (!toolUse) {
    return { success: false, error: `no tool_use block (stop_reason ${message.stop_reason})` };
  }
  const result = GeneratedArticle.safeParse(unwrapToolInput(toolUse.input));
  if (result.success) {
    // Never trust the self-reported count.
    result.data.sections = result.data.sections.map(section => ({
      ...section,
      wordCount: countWordsIn(section.content),
    }));
    return { success: true, data: result.data };
  }

  const issues = result.error.issues
    .slice(0, 3)
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  // Diagnostics: what did the model actually send? A text block alongside an empty tool
  // input usually means it explained a refusal or a data gap in prose instead of writing.
  const inputKeys =
    toolUse.input && typeof toolUse.input === 'object'
      ? Object.keys(toolUse.input as Record<string, unknown>)
      : [typeof toolUse.input];
  const textBlocks = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text.slice(0, 400));
  console.warn('Unusable generate_article tool call', {
    stopReason: message.stop_reason,
    inputKeys,
    inputPreview: JSON.stringify(toolUse.input).slice(0, 600),
    textBlocks,
    outputTokens: message.usage?.output_tokens,
  });
  return { success: false, error: `${issues} (stop_reason ${message.stop_reason})` };
}

/**
 * The direct path's create step: the routed call plus the truncation and unusable-output retries.
 * Only discarded attempts are billed into `ledger`; the returned message is charged by
 * `completeArticleFromMessage`, which is the single place batch pricing is applied.
 */
async function createArticleMessage(
  anthropic: Anthropic,
  prepared: PreparedArticleRequest,
  ledger: CostLedger
): Promise<Anthropic.Message> {
  const { route, maxTokens, systemPrompt, userPrompt } = prepared;
  const build = (model: string, tokens: number) =>
    articleParams(model, tokens, route.effort, systemPrompt, userPrompt);

  // Thinking tokens (output_config.effort) count against max_tokens, so a long article can be
  // cut off mid tool call. The API then returns a partial or missing tool_use input, which
  // surfaces as a Zod error on required fields. Retry once with a larger budget before giving up.
  let message = await createWithFallback(anthropic, route, model => build(model, maxTokens), ledger);
  if (message.stop_reason === 'max_tokens') {
    accrue(ledger, message);
    const bigger = Math.min(maxTokens * 2, MAX_STRUCTURED_TOKENS);
    console.warn(`Structured output hit max_tokens (${maxTokens}); retrying with ${bigger}`);
    message = await createWithFallback(anthropic, route, model => build(model, bigger), ledger);
    if (message.stop_reason === 'max_tokens') {
      accrue(ledger, message);
      throw new Error(
        `Article output exceeded the ${bigger}-token budget twice; shorten the template ceilings`
      );
    }
  }

  const parsed = parseArticleToolCall(message);
  if (!parsed.success) {
    accrue(ledger, message);
    const fallback = fallbackModelFor(route);
    console.warn(
      `Structured output unusable on ${message.model} (${parsed.error}); retrying on ${fallback}`
    );
    message = await anthropic.messages.create(
      build(fallback, Math.min(maxTokens * 2, MAX_STRUCTURED_TOKENS))
    );
    const retry = parseArticleToolCall(message);
    if (!retry.success) {
      accrue(ledger, message);
      throw new Error(`No usable structured output received: ${retry.error}`);
    }
  }

  return message;
}

/** Rewrites only the sections a `block` violation landed in, once, on the article's own route. */
async function regenerateSections(
  anthropic: Anthropic,
  prepared: PreparedArticleRequest,
  article: GeneratedArticleT,
  sectionNames: string[],
  blockViolations: Violation[],
  ledger: CostLedger
): Promise<GeneratedArticleT['sections']> {
  const { facts, systemPrompt, route, maxTokens } = prepared;
  const droppedQuoteIds = quoteIdsIn(blockViolations);
  const surrounding = article.sections
    .filter(section => !sectionNames.includes(section.name))
    .map(section => `## ${section.name}\n${section.content}`)
    .join('\n\n');

  const prompt = `${serializeFacts(facts)}

PRIOR ATTEMPT VIOLATIONS — a fact-checker rejected part of your article. Every item below is a
statement that is not supported by <FACTS>, or a phrase that gives away the machinery. Rewrite only
the listed sections so that none of these remain. Do not restate the offending claim in softer
language; remove it and write what <FACTS> actually supports.

${blockViolations.map(v => `- [${v.kind}] ${v.section ? `${v.section}: ` : ''}${v.detail}`).join('\n')}
${
  blockViolations.some(v => v.kind === 'data_speak')
    ? `\nREGISTER — the [data_speak] items above are the words themselves, not the facts. The reader never
sees the data you were given: no field names, no ids, no timestamps, no talk of feeds, ledgers or
sheets. Name the team, the manager and the number the way you would say them on air.\n`
    : ''
}
REWRITE THESE SECTIONS (same headings, same voice, same ceilings):
${sectionNames
  .map(name => {
    const directives = parseQuoteDirectives(
      article.sections.find(section => section.name === name)?.content ?? ''
    );
    const keep = directives.filter(id => !droppedQuoteIds.has(id));
    return keep.length > 0
      ? `- ${name} — keep these pull-quote directive lines exactly as they are: ${keep
          .map(id => `:::quote{id=${id}}`)
          .join(' ')}`
      : `- ${name}`;
  })
  .join('\n')}

Pull quotes: a ":::quote{id=…}" line is how a ledger quote is printed. Keep the ones listed above,
each on its own line, and do not add a directive for any other id.

READ-ONLY CONTEXT — the rest of the article. Do not rewrite or repeat these:
${surrounding || '(no other sections)'}`;

  const build = (model: string, tokens: number): Anthropic.MessageCreateParamsNonStreaming => ({
    model,
    max_tokens: tokens,
    output_config: { effort: route.effort },
    system: systemPrompt,
    messages: [{ role: 'user' as const, content: prompt }],
    tools: [
      {
        name: 'rewrite_sections',
        strict: true,
        description: 'Rewrite the listed article sections so they are fully grounded in <FACTS>',
        input_schema: { ...zodToJsonSchema(RegeneratedSections, { $refStrategy: "none" }), type: 'object' } as const,
      },
    ],
    tool_choice: { type: 'tool' as const, name: 'rewrite_sections' },
  });

  let message = await createWithFallback(anthropic, route, model => build(model, maxTokens), ledger);
  accrue(ledger, message);
  if (message.stop_reason === 'max_tokens') {
    const bigger = Math.min(maxTokens * 2, MAX_STRUCTURED_TOKENS);
    console.warn(`Section rewrite hit max_tokens (${maxTokens}); retrying with ${bigger}`);
    message = await createWithFallback(anthropic, route, model => build(model, bigger), ledger);
    accrue(ledger, message);
    // Still truncated: give up on the rewrite and let the strip policy handle the sections.
    if (message.stop_reason === 'max_tokens') return [];
  }

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  );
  if (!toolUse) return [];
  const parsed = RegeneratedSections.safeParse(unwrapToolInput(toolUse.input));
  if (!parsed.success) {
    console.warn('Section rewrite returned an unusable tool call; falling back to strip policy');
    return [];
  }
  return parsed.data.sections
    .filter(section => sectionNames.includes(section.name))
    .map(section => ({ ...section, wordCount: countWordsIn(section.content) }));
}

function generateTags(contentType: string, persona: string): string[] {
  const tags = [contentType, persona];

  const contentTypeTags: Record<string, string[]> = {
    weekly_recap: ['recap', 'weekly', 'matchups'],
    power_rankings: ['rankings', 'power', 'standings'],
    trade_analysis: ['trade', 'analysis', 'transaction'],
    waiver_wire_report: ['waiver', 'pickups', 'free-agents'],
    mock_draft: ['draft', 'mock', 'preseason'],
    rivalry_week_special: ['rivalry', 'matchup', 'hype'],
    championship_manifesto: ['championship', 'finals', 'playoffs'],
  };

  if (contentTypeTags[contentType]) {
    tags.push(...contentTypeTags[contentType]);
  }

  return tags;
}

/* ------------------------------------------------------------------------------------------- *
 * Completion — parse → verify → (rare) section regeneration → optional fact-check → assemble
 *
 * Shared by the direct path and by `convex/aiBatch.ts`. `opts.batch` says the message came back
 * from a Message Batch and is billed at 50%; the direct sub-calls it may make (a section rewrite,
 * the fact-check pass) are always billed at list.
 * ------------------------------------------------------------------------------------------- */

export async function completeArticleFromMessage(
  message: Anthropic.Message,
  prepared: PreparedArticleRequest,
  apiKey: string,
  opts?: { batch?: boolean; startedAt?: number }
): Promise<GeneratedContent> {
  const { facts, request, route } = prepared;
  const ledger: CostLedger = { usd: 0, cacheReadTokens: 0 };
  accrue(ledger, message, { batch: opts?.batch });

  const parsed = parseArticleToolCall(message);
  if (!parsed.success) {
    throw new Error(`No usable structured output received: ${parsed.error}`);
  }

  const anthropic = new Anthropic({ apiKey });
  const template = contentTemplates[request.contentType];
  let article = parsed.data;
  /** Deterministic findings. Recomputed from scratch after every change to the article. */
  let deterministic = verifyArticle(article, facts, { template });
  /** Editor findings. Kept apart because a rewritten section retires the ones that named it. */
  let editorViolations: Violation[] = [];
  let editor: EditorPassResult | null = null;
  let sectionsRegenerated = 0;

  // --- Editor pass (spec §11.2.7) ------------------------------------------------------------
  // On by default for every content type, and run *before* the rewrite so its register leaks and
  // contradictions are fixed by the same single regeneration the deterministic blocks trigger.
  if (editorPassEnabled()) {
    const outcome = await runEditorPass(anthropic, prepared, article, ledger);
    if (outcome) {
      editor = outcome.result;
      editorViolations = outcome.violations;
    } else {
      // A silent no-op here is how a broken editor schema went unnoticed on the first dev run.
      // Publishing still proceeds on the deterministic checks, but the digest must see it.
      editorViolations = [
        {
          kind: 'editor_unavailable',
          severity: 'warn',
          detail: 'Editor pass was enabled but did not complete; the article shipped on the deterministic checks alone',
        },
      ];
    }
  }

  // --- Register leak in the title (spec §11.2.4) ---------------------------------------------
  // The title has no section to rewrite, so it is derived from the body. No model call.
  if ([...deterministic, ...editorViolations].some(v => v.kind === 'data_speak' && v.section === TITLE_SECTION)) {
    const retitled = retitleFromBody(article);
    if (retitled) {
      console.warn(`Register leak in the title; retitled from the body: "${article.title}" -> "${retitled}"`);
      article = { ...article, title: retitled };
      deterministic = verifyArticle(article, facts, { template });
      editorViolations = editorViolations.filter(
        v => !(v.kind === 'data_speak' && v.section === TITLE_SECTION)
      );
    }
  }

  // --- One section rewrite for every block, deterministic or editor (spec §11.2.4) -----------
  const sectionNames = new Set(article.sections.map(section => section.name));
  const blocks = [...deterministic, ...editorViolations].filter(v => v.severity === 'block');
  const blockedSections = [
    ...new Set(blocks.filter(v => v.section && sectionNames.has(v.section)).map(v => v.section as string)),
  ];

  if (blockedSections.length > 0) {
    console.warn(`Verifier blocked ${blockedSections.length} section(s); regenerating once`);
    try {
      const rewritten = await regenerateSections(
        anthropic,
        prepared,
        article,
        blockedSections,
        blocks,
        ledger
      );
      if (rewritten.length > 0) {
        const droppedQuoteIds = quoteIdsIn(blocks);
        article = {
          ...article,
          sections: article.sections.map(section => {
            const replacement = rewritten.find(candidate => candidate.name === section.name);
            if (!replacement) return section;
            // A rewrite must not silently lose a pull quote that was never the problem.
            return {
              ...replacement,
              content: preserveQuoteDirectives(section.content, replacement.content, droppedQuoteIds),
            };
          }),
        };
        sectionsRegenerated = rewritten.length;
        deterministic = verifyArticle(article, facts, { template });
        // Editor findings that named a rewritten section described text that no longer exists.
        const rewrittenNames = new Set(rewritten.map(section => section.name));
        editorViolations = editorViolations.filter(v => !(v.section && rewrittenNames.has(v.section)));
      }
    } catch (regenerationError) {
      console.warn('Section regeneration failed; falling through to strip', regenerationError);
    }
  }

  // The manager opt-down ("keep it clean about my team"), enforced (owner ask, 2026-09-03): a
  // sentence that names an opted-down team, or its GM, and swears is stripped. Prompt-only until
  // then, which that night's evidence says is no enforcement at all. Nothing to do at clean.
  const optDownViolations = cleanTeamArticleViolations(
    article,
    (request.languageRating ?? 'clean') === 'clean'
      ? []
      : facts.teams
          .filter(team => (request.cleanTeamNames ?? []).includes(team.name))
          .map(team => ({ name: team.name, manager: team.manager })),
    facts.teams.map(team => team.name)
  );

  // The league's rating and the writer's effective allowance for THIS piece, enforced (owner ask,
  // 2026-09-04): the same seed the prompt used decides whether a reserved-desk writer had their one.
  const rating: LanguageRating = request.languageRating ?? 'clean';
  const ratingViolations = languageArticleViolations(article, {
    rating,
    allowance:
      rating === 'clean'
        ? 0
        : effectiveLanguageRange(getPersona(request.persona), rating, languageSeedFor(request.leagueData, request.contentType)).ceiling,
    teamNames: facts.teams.map(team => team.name),
  });

  const violations = [...deterministic, ...editorViolations, ...optDownViolations, ...ratingViolations];

  // Thin-article guard. Missing *required sections* are reported by the verifier (spec §11.2.5);
  // what is left here is the word floor: under 30% of the template's ceiling is what a writer
  // produces when the data is missing and the contract forbids inventing — correct, unpublishable.
  {
    const ceiling = template?.estimatedWords ?? 0;
    const words = article.sections.reduce((sum, section) => sum + countWordsIn(section.content), 0);
    const alreadyThin = violations.some(v => v.kind === 'thin_article');
    if (!alreadyThin && ceiling > 0 && words < Math.round(ceiling * 0.3)) {
      violations.push({
        kind: 'thin_article',
        severity: 'strip',
        detail: `Article has ${article.sections.length} of ${template?.sections.length ?? 0} sections and ${words} words (ceiling ${ceiling}); held for review`,
      });
    }
  }

  if (violations.some(v => v.severity === 'block' || v.severity === 'strip')) {
    article = applyStrips(article, violations);
  }

  // --- Assemble ----------------------------------------------------------------------------
  const title = article.title;
  const summary = article.summary;
  let content = `# ${title}\n\n`;
  article.sections.forEach(section => {
    content += `## ${section.name}\n\n${section.content}\n\n`;
  });

  const stats: VerifierStats = {
    blocks: violations.filter(v => v.severity === 'block').length,
    strips: violations.filter(v => v.severity === 'strip').length,
    warns: violations.filter(v => v.severity === 'warn').length,
    sectionsRegenerated,
    factsCount: countFacts(facts),
    wordCount: countWords(content),
    quotesOffered: facts.quotes.length,
    quotesUsed: article.quotes?.length ?? 0,
    // Set by `generateContent`, which is the only place a whole article is generated twice.
    fullRegenerations: 0,
  };

  const factsTeamById = new Map(facts.teams.map(team => [team.id, team]));
  const featuredTeams = [...article.featuredTeams]
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 5)
    .map(team => factsTeamById.get(team.teamId)?.teamId || team.teamName);

  const featuredPlayers = [...article.featuredPlayers]
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 10)
    .map(player => player.playerName);

  const metadata: GeneratedContent['metadata'] = {
    // The week the article is ABOUT: a preview or playoff picture is written off the prior week's
    // results (leagueData.currentWeek) but covers the week the caller asked for.
    week: request.week ?? request.leagueData.currentWeek,
    featuredTeams,
    featuredPlayers,
    tags: generateTags(request.contentType, request.persona),
    creditsUsed: contentTemplates[request.contentType]?.creditCost ?? 0,
    generationTime: Date.now() - (opts?.startedAt ?? prepared.startedAt),
    modelUsed: message.model || route.model,
    promptTokens: message.usage?.input_tokens ?? 0,
    completionTokens: message.usage?.output_tokens ?? 0,
    costUsd: ledger.usd,
    route,
    cacheReadTokens: ledger.cacheReadTokens,
    quotes: article.quotes ?? [],
    managerMentions: article.managerMentions ?? [],
    claims: article.claims ?? [],
    reviewFlags: violations,
    factsMissing: facts.missing,
    verifierStats: stats,
    editor,
  };

  console.log('=== completeArticleFromMessage SUCCESS ===', {
    ...stats,
    model: metadata.modelUsed,
    effort: route.effort,
    costUsd: Number(metadata.costUsd.toFixed(4)),
    cacheReadTokens: metadata.cacheReadTokens,
    editor: editor ? { factsScore: editor.factsScore, voiceScore: editor.voiceScore } : 'off',
    publish: shouldPublish(metadata),
  });

  return { title, content, summary, metadata };
}

/* ------------------------------------------------------------------------------------------- *
 * Service
 * ------------------------------------------------------------------------------------------- */

export class ContentGenerationService {
  /** prepare → create (with the truncation / unusable retries) → complete. */
  async generateContent(request: GenerationRequest, apiKey: string): Promise<GeneratedContent> {
    console.log('=== ContentGenerationService.generateContent START ===');
    const route = resolveRoute(request.contentType);
    console.log('Request:', {
      contentType: request.contentType,
      persona: request.persona,
      model: route.model,
      effort: route.effort,
      hasCustomContext: !!request.customContext,
      commentResponses: request.commentResponses?.length ?? 0,
      nonRespondents: request.nonRespondents?.length ?? 0,
      relationships: request.relationships?.length ?? 0,
    });

    try {
      const prepared = await prepareArticleRequest(request);
      const anthropic = new Anthropic({ apiKey });

      // Attempts that were thrown away still cost money; they are added to the article's total.
      const discarded: CostLedger = { usd: 0, cacheReadTokens: 0 };
      let generated: GeneratedContent | undefined;
      let current = prepared;
      /** §11.2.8: an article gets one whole-article regeneration, never two. */
      let fullRegenerations = 0;
      /** Opus 5 medium is the rescue route for both retries below. */
      const onOpusMedium = (from: PreparedArticleRequest): PreparedArticleRequest => ({
        ...from,
        route: { model: 'claude-opus-5', effort: 'medium' },
        params: { ...from.params, model: 'claude-opus-5', output_config: { effort: 'medium' } },
      });
      const discard = (attempt: GeneratedContent): void => {
        discarded.usd += attempt.metadata.costUsd;
        discarded.cacheReadTokens += attempt.metadata.cacheReadTokens;
      };
      const stripCount = (attempt: GeneratedContent): number =>
        (attempt.metadata.reviewFlags ?? []).filter(flag => flag.severity === 'strip').length;
      for (let attempt = 0; attempt < 2; attempt++) {
        const message = await createArticleMessage(anthropic, current, discarded);
        generated = await completeArticleFromMessage(message, current, apiKey);
        const thin = (generated.metadata.reviewFlags ?? []).some(flag => flag.kind === 'thin_article');
        // Measured 2026-09-02: a model occasionally returns one section (or none) and stops. One
        // fresh attempt fixes it far more often than a review does. Sonnet-routed types were the
        // repeat offenders on the real-league test, so the retry always runs on Opus 5 at medium:
        // the cheap route keeps its savings when it works and is rescued when it does not.
        if (thin && attempt === 0) {
          console.warn('Thin article on first attempt; regenerating once on claude-opus-5', {
            contentType: request.contentType,
            persona: request.persona,
            model: current.route.model,
            words: generated.metadata.verifierStats?.wordCount,
            // What the model actually wrote, so a thin attempt can be told apart from a refusal-in-
            // prose (the unfiltered Mel eval, 2026-09-03, came back at 13 words with no record of what).
            preview: generated.content.slice(0, 200),
          });
          discard(generated);
          fullRegenerations++;
          current = onOpusMedium(current);
          continue;
        }
        break;
      }
      if (!generated) throw new Error('No article produced');

      // --- One full regeneration before holding (spec §11.2.8) --------------------------------
      // A `strip` survived, or the editor held it. Rather than hand the commissioner a half-empty
      // article, write it again from scratch on Opus 5 medium and keep the better of the two. The
      // thin retry above is the same regeneration, so an article never pays for both.
      const gate = shouldPublish(generated.metadata);
      if (!gate.ok && fullRegenerations === 0) {
        console.warn('Article would be held; regenerating in full once on claude-opus-5', {
          contentType: request.contentType,
          persona: request.persona,
          reasons: gate.reasons,
        });
        try {
          const retryPrepared = onOpusMedium(current);
          const retryMessage = await createArticleMessage(anthropic, retryPrepared, discarded);
          const second = await completeArticleFromMessage(retryMessage, retryPrepared, apiKey);
          fullRegenerations++;
          // The better article wins, judged the way the publish gate will judge it: one that
          // publishes beats one that is held; among held ones, fewer hold reasons, then fewer
          // strips, then more words. Measured 2026-09-03 on draft grades: a first pass with one
          // stripped sentence and all five sections was being replaced by a regeneration that
          // came back with two sections (fewer strips, but thin), and the piece was then held
          // for the missing sections instead of for one sentence.
          const rank = (attempt: GeneratedContent): number[] => {
            const g = shouldPublish(attempt.metadata);
            return [g.ok ? 1 : 0, -g.reasons.length, -stripCount(attempt), attempt.metadata.verifierStats?.wordCount ?? 0];
          };
          const secondWins = ((a: number[], b: number[]) => {
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
            return true; // a full tie goes to the second attempt, which was written knowing more
          })(rank(second), rank(generated));
          if (secondWins) {
            discard(generated);
            generated = second;
          } else {
            console.warn('Full regeneration was not better; keeping the first article', {
              first: rank(generated),
              second: rank(second),
            });
            discard(second);
          }
        } catch (retryError) {
          console.warn('Full regeneration failed; keeping the first article', retryError);
        }
      }
      if (generated.metadata.verifierStats) {
        generated.metadata.verifierStats.fullRegenerations = fullRegenerations;
      }

      generated.metadata.costUsd += discarded.usd;
      generated.metadata.cacheReadTokens += discarded.cacheReadTokens;
      return generated;
    } catch (error) {
      if (error instanceof InsufficientDataError) {
        console.error('Generation refused for lack of data:', error.message);
        throw error;
      }
      console.error('=== ContentGenerationService.generateContent ERROR ===');
      console.error('Content generation failed:', error);
      throw new Error('Failed to generate content. Please try again.');
    }
  }

  /** Quality gate. Over-generation and verifier blocks both count as issues. */
  async validateContent(content: GeneratedContent): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    const wordCount = content.content.split(/\s+/).length;
    const ceiling = contentTemplates[content.metadata.tags[0]]?.estimatedWords || 1000;
    if (wordCount > ceiling * 1.25) {
      issues.push(`Content over the ceiling: ${wordCount} words (ceiling ~${ceiling})`);
    }

    const placeholders = ['[INSERT', '[TODO', 'PLACEHOLDER', '{INSERT'];
    placeholders.forEach(placeholder => {
      if (content.content.includes(placeholder)) {
        issues.push(`Contains placeholder text: ${placeholder}`);
      }
    });

    if (!content.title || content.title.length < 5) {
      issues.push('Invalid or missing title');
    }

    const blocking = content.metadata.reviewFlags.filter(flag => flag.severity !== 'warn');
    if (blocking.length > 0) {
      issues.push(`${blocking.length} unresolved fact-check finding(s)`);
    }

    return { valid: issues.length === 0, issues };
  }
}

// Singleton instance
export const contentGenerationService = new ContentGenerationService();

// Helper function for generating content in Convex actions
export async function generateAIContent(request: GenerationRequest, apiKey: string): Promise<GeneratedContent> {
  return contentGenerationService.generateContent(request, apiKey);
}
