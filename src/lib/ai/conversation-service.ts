/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Sam Ortega's interview engine (spec §5).
 *
 * One dedicated sideline reporter conducts every comment request regardless of who
 * writes the article. She asks at most two questions - a grounded opener and one
 * optional follow-up - and always closes with "Anything else you want on the record?".
 * That close is a template, not a model call (spec §10.3.2): see `buildClosingMessage`
 * and `shouldUseTemplatedClose`.
 *
 * Every question must contain at least one verified fact from CONTEXT, and she may
 * never state a fact that is not in CONTEXT. The CONTEXT block is built verbatim from
 * `convex/commentRequests.ts:buildConversationContext`; nothing here invents data.
 *
 * Runs in the Node runtime via `convex/aiNode.ts`. Convex isolate modules may import
 * `ConversationContext` from here as a *type only*.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { computeCostUsd } from './content-generation-service';
import type { RelationshipTier } from './persona-prompts';
import type { InGameInjury } from './prompt-builder';

/** Sam asks; Opus writes the questions. Reply analysis is a classification job (spec §10.3.2). */
const QUESTION_MODELS = ['claude-opus-5', 'claude-sonnet-5'] as const;
const ANALYSIS_MODELS = ['claude-sonnet-5', 'claude-opus-5'] as const;

/** The seven selectable writers plus the interviewer, for `writerSentiment` gating. */
const WRITER_ROSTER: Record<string, string[]> = {
  'curtis-vaughn': ['curtis vaughn', 'curtis', 'vaughn'],
  'sam-ortega': ['simone ortega', 'sam ortega', 'ortega', 'sam'],
  'nina-sharpe': ['nina sharpe', 'nina', 'sharpe'],
  'dex-alvarez': ['dex alvarez', 'dex', 'alvarez'],
  'mel-diaper': ['mel diaper', 'mel', 'diaper'],
  'reggie-banks': ['reggie banks', 'reggie', 'banks'],
  'walt-brennan': ['walt brennan', 'walt', 'brennan'],
};

export const INTERVIEWER_SLUG = 'sam-ortega';

// Conversation context interface
export interface ConversationContext {
  userId: string;
  leagueId: string;
  scheduledContentId: string | undefined;
  contentType: string; // Support all content types from templates
  week: number;
  seasonId: number;
  leagueName?: string;

  /* --- Identity (spec §5) --------------------------------------------------- */
  /** The manager being interviewed, `users.name`. */
  managerName?: string;
  /** Their team's name; the same value as `teamPerformance.teamName`, hoisted for the prompt. */
  teamName?: string;
  /** Slug of the interviewer (always `sam-ortega`) and of the writer this runs for. */
  interviewerPersona?: string;
  writerPersona?: string;

  /* --- The matchup (spec §5) ------------------------------------------------ */
  opponentName?: string;
  opponentScore?: number;
  /**
   * The opponent in a matchup that has not been decided yet (a preview, or a recap asked
   * for before ESPN finalized the week). Never paired with a score: Sam may name who they
   * play, not how it went.
   */
  upcomingOpponentName?: string;
  /** True when the decided matchup ended level; `teamPerformance.won` is false then. */
  tie?: boolean;
  /** ESPN's playoff seed, present only when the synced record is as fresh as this week. */
  playoffSeed?: number;
  /** Absolute point margin of the result, `|teamScore - opponentScore|`. */
  margin?: number;
  /** Total points left on the bench (lineupSlotId 20). */
  benchPoints?: number;
  topBenchPlayer?: {
    player: string;
    position: string;
    points: number;
    projectedPoints?: number;
  };
  /** Bench players who outscored the worst starter at the same position. */
  lineupDecisions?: Array<{
    benchedPlayer: string;
    benchedPoints: number;
    startedPlayer: string;
    startedPoints: number;
    position: string;
    pointGain: number;
  }>;
  /**
   * This manager's players who left their game hurt this week (The Wire spec §16.1). Never a
   * lineup decision: the CONTEXT block drops the lineup line and the under-projection line for
   * such a player, and Sam is told to ask how the team replaces the production, never why he
   * was started.
   */
  inGameInjuries?: InGameInjury[];

  /* --- League activity (spec §5) -------------------------------------------- */
  transactionsThisWeek?: Array<{
    type: string;
    playersAdded: string[];
    playersDropped: string[];
    bidAmount?: number;
    timestamp?: number;
  }>;
  tradesThisWeek?: Array<{
    withTeam: string;
    gave: string[];
    received: string[];
    timestamp?: number;
  }>;
  /* --- FAAB ledger (waiver_wire_report interviews) --------------------------- */
  // Populated by commentRequests.buildConversationContext from the waiver ledger.
  // Every dollar figure Sam uses must come from here; she never estimates a bid.
  waiverBudget?: { budget?: number; spent?: number; remaining?: number; acquisitions?: number };
  waiverClaimsThisRun?: Array<{
    scoringPeriod: number;
    player: string;
    position?: string;
    result: "won" | "lost";
    bid: number;
    competingBids: Array<{ teamName: string; bid: number }>;
  }>;
  waiverSeasonHighlights?: {
    biggestBid?: { teamName: string; player: string; bid: number; week: number };
    mostActive?: { teamName: string; acquisitions: number };
    lowestRemaining: Array<{ teamName: string; remaining: number }>;
  };
  rivalry?: {
    opponent: string;
    /** e.g. "2-7" from this manager's point of view, ties appended when non-zero. */
    allTimeRecord: string;
  };
  /** What this manager has already said on the record, so Sam doesn't re-ask. */
  priorQuotes?: Array<{
    week?: number;
    text: string;
    askedAbout?: string;
  }>;

  /* --- The writer this interview feeds (spec §5/§6) ------------------------- */
  writerContext?: {
    persona: string;
    name: string;
    relationship: { score: number; tier: RelationshipTier };
    recentMentions: Array<{
      week?: number;
      stance: 'roast' | 'praise';
      evidence: string;
      articleTitle?: string;
    }>;
  };

  draftData?: {
    draftType?: string;
    draftOrder?: any[];
    userDraftPicks?: Array<{
      isRookie?: boolean;
      perceivedValue: number;
      pickNumber: number;
      playerADP: number | null;
      playerName: string;
      playerPosition: string;
      playerProjectedPoints: number | null;
      playerTeam: string;
      roundNumber: number;
      roundPickNumber: number;
      teamName: string;
      teamOwner: string;
    }>;
    allDraftPicks?: Array<{
      isRookie?: boolean;
      perceivedValue: number;
      pickNumber: number;
      playerADP: number | null;
      playerName: string;
      playerPosition: string;
      playerProjectedPoints: number | null;
      playerTeam: string;
      roundNumber: number;
      roundPickNumber: number;
      teamName: string;
      teamOwner: string;
    }>;
  };
  teamPerformance: {
    teamId: string;
    teamName: string;
    score: number;
    projectedScore?: number;
    won: boolean;
    underperformers: Array<{
      player: string;
      position: string;
      expectedPts: number;
      actualPts: number;
    }>;
    overperformers: Array<{
      player: string;
      position: string;
      expectedPts: number;
      actualPts: number;
    }>;
    keyDecisions?: Array<{
      type: "start_sit" | "waiver_pickup" | "trade";
      description: string;
      impact: string;
    }>;
  };
  leagueContext: {
    standings: Array<{
      teamId: string;
      teamName: string;
      rank: number;
      record: string;
    }>;
    recentTrades?: Array<{
      date: number;
      teams: string[];
      players: string[];
    }>;
    rivalries?: Array<{
      team1: string;
      team2: string;
      intensity: number;
    }>;
    playoffContext?: {
      isPlayoffWeek: boolean;
      userInPlayoffs: boolean;
      playoffImplications: string;
    };
  };
  conversationHistory?: Array<{
    role: "ai" | "user";
    content: string;
    timestamp: number;
  }>;
}

/** How the manager talked about a named writer (spec §5/§6). */
export interface WriterSentiment {
  persona: string;
  sentiment: 'hostile' | 'dismissive' | 'neutral' | 'friendly';
  evidence: string;
}

/** What one interviewer call spent (spec §10.3.4). */
export interface InterviewUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * One line per interviewer call so token spend is visible in Convex logs and in the cost model
 * (scripts/measure-interview.ts). Thinking tokens are included in output_tokens.
 */
function recordInterviewUsage(
  response: Anthropic.Message,
  label: string
): { usage?: InterviewUsage; costUsd: number } {
  const usage = response.usage;
  if (!usage) return { costUsd: 0 };
  const costUsd = computeCostUsd(response.model, usage);
  console.log(
    `[interview usage] model=${response.model} input=${usage.input_tokens} output=${usage.output_tokens}` +
      (usage.cache_read_input_tokens ? ` cache_read=${usage.cache_read_input_tokens}` : '') +
      ` cost=$${costUsd.toFixed(4)} call=${label}`
  );
  return {
    usage: {
      model: response.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    },
    costUsd,
  };
}

/**
 * Sam's system prompt is byte-stable, so it carries a cache breakpoint: a manager's second and
 * third turn read it at 0.1x input. Nothing volatile (no timestamps, no ids) may move into it.
 */
function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export interface ResponseAnalysisResult {
  responseQuality: number; // 0-100
  completeness: number; // 0-100
  relevantTopics: string[];
  needsFollowUp: boolean;
  suggestedFollowUps?: string[];
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  /** Verbatim spans of the reply, guaranteed substrings of it. Never topic labels. */
  quotableSegments: string[];
  offTopicScore: number; // 0-100, higher means more off-topic
  /** Only personas actually named in context or in the reply. */
  writerSentiment: WriterSentiment[];
  /**
   * True only when the reply as a whole refuses to comment ("no comment", "not today, Sam").
   * A reply that says anything about the team is not a decline, whatever it ends with.
   * `commentConversations.processUserResponse` records a decline on this OR on the phrase
   * detector in convex/lib/declineDetection.ts.
   */
  isDecline: boolean;
  /** Undefined when the local heuristic fallback answered instead of a model. */
  usage?: InterviewUsage;
  /** Measured API cost of this analysis. 0 when no model call was made. */
  costUsd: number;
}

// AI response structure
export interface AIConversationResult {
  question: string;
  confidence: number;
  intent: "initial" | "follow_up" | "clarification" | "closing";
  expectedResponseType: "opinion" | "analysis" | "story" | "explanation" | "mixed";
  contextualReasons: string[];
  shouldEndAfterResponse: boolean;
  /** True when the manager declined / said "no comment" - the request is marked declined. */
  shouldRecordDecline: boolean;
  suggestedFollowUpTopics?: string[];
  detectedAbuse?: {
    type: "off_topic" | "spam" | "inappropriate" | "questioning_ai";
    severity: "low" | "medium" | "high";
    reason: string;
  };
  /** Undefined for the templated close, which makes no model call. */
  usage?: InterviewUsage;
  /** Measured API cost of this turn. 0 for the templated close. */
  costUsd: number;
}

/* -------------------------------------------------------------------------- */
/* The templated close (spec §10.3.2)                                          */
/*                                                                             */
/* The last thing Sam says is the same three sentences every time, so it is    */
/* not worth a model call. All three variants end on the sanctioned closing    */
/* question, so `postQuoteApprovalMessage` still fires off `intent: "closing"`.*/
/* -------------------------------------------------------------------------- */

export const CLOSING_QUESTION = 'Anything else you want on the record?';

const CLOSING_VARIANTS: Array<(name: string) => string> = [
  (name) => `Thanks${name}. That's everything I needed. ${CLOSING_QUESTION}`,
  (name) => `Appreciate the time${name}. I've got what I need for the story. ${CLOSING_QUESTION}`,
  (name) => `Got it${name}. I'll let you get back to your lineup. ${CLOSING_QUESTION}`,
];

/** First token of a manager's name, or `undefined` when there isn't one to use. */
export function managerFirstName(managerName?: string): string | undefined {
  const first = managerName?.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : undefined;
}

/** One of three closing lines, all ending with "Anything else you want on the record?". */
export function buildClosingMessage(managerFirstName?: string): string {
  const suffix = managerFirstName ? `, ${managerFirstName}` : '';
  const variant = CLOSING_VARIANTS[Math.floor(Math.random() * CLOSING_VARIANTS.length)];
  return variant(suffix);
}

/**
 * True once the follow-up has been asked and answered: the opener and the follow-up are both on
 * the transcript with a reply after each. The only thing left to say is the close, and the close
 * is a template. `convex/commentConversations.ts` may call this to skip the action entirely.
 */
export function shouldUseTemplatedClose(context: ConversationContext): boolean {
  const history = context.conversationHistory ?? [];
  const asked = history.filter((m) => m.role === 'ai').length;
  const answered = history.filter((m) => m.role === 'user').length;
  return asked >= 2 && answered >= 2;
}

// Zod schema for structured conversation output
// Tolerant on purpose: Opus 5 occasionally returns `confidence` as a string or omits a boolean,
// and a hard parse failure here used to throw the (already paid for) Opus answer away and fall back
// to Sonnet - every question billed twice. Defaults keep the contract; the tool description asks
// for the strict shape.
const ConversationResponse = z.object({
  question: z.string().describe("The single question to ask, containing at least one verified fact from CONTEXT"),
  confidence: z.coerce.number().min(0).max(100).catch(70).describe("Confidence in the question's relevance (0-100)"),
  intent: z.enum(["initial", "follow_up", "clarification", "closing"]).describe("The purpose of this message"),
  expectedResponseType: z.enum(["opinion", "analysis", "story", "explanation", "mixed"]).catch("mixed").describe("What kind of response we're hoping for"),
  contextualReasons: z.array(z.string()).default([]).describe("Which CONTEXT facts this question is built on"),
  shouldEndAfterResponse: z.coerce.boolean().default(false).describe("Whether to end the conversation after getting a response"),
  shouldRecordDecline: z.coerce.boolean().default(false).describe("True only if the manager declined to comment, said no comment, or refused to engage on substance"),
  suggestedFollowUpTopics: z.array(z.string()).optional().describe("Potential follow-up topics if conversation continues"),
});

/**
 * Validate a forced tool call's input. Unwraps the single-key container Opus 5 sometimes adds
 * (`{"parameters": {...}}`) and logs the exact Zod issues on failure so a fallback is never silent.
 */
function parseInterviewToolInput<T extends z.ZodTypeAny>(schema: T, input: unknown, label: string): z.infer<T> {
  let candidate = input;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const keys = Object.keys(candidate as Record<string, unknown>);
    if (keys.length === 1 && ['parameters', 'input', 'arguments'].includes(keys[0])) {
      const inner = (candidate as Record<string, unknown>)[keys[0]];
      if (inner && typeof inner === 'object') candidate = inner;
    }
  }
  const result = schema.safeParse(candidate);
  if (!result.success) {
    console.warn(`[interview] ${label}: tool input failed validation`, {
      issues: result.error.issues.slice(0, 4).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      keys: candidate && typeof candidate === 'object' ? Object.keys(candidate as Record<string, unknown>) : typeof candidate,
    });
    throw new Error(`${label}: unusable structured output`);
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Verbatim helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Curly quotes and dashes normalized so a model's re-typed span still matches. */
function foldPunctuation(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-');
}

/**
 * Lowercase + whitespace-collapse `text`, keeping a map back to the original offsets so a
 * matched span can be returned as the raw characters the manager actually typed.
 */
function normalizeWithMap(text: string): { normalized: string; offsets: number[] } {
  const folded = foldPunctuation(text);
  const chars: string[] = [];
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i];
    if (/\s/.test(ch)) {
      pendingSpace = chars.length > 0;
      continue;
    }
    if (pendingSpace) {
      chars.push(' ');
      offsets.push(i);
      pendingSpace = false;
    }
    chars.push(ch.toLowerCase());
    offsets.push(i);
  }
  return { normalized: chars.join(''), offsets };
}

function normalizeForMatch(text: string): string {
  return foldPunctuation(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Returns the exact substring of `raw` that a model-proposed segment corresponds to, or
 * `null` when the segment is not actually contained in `raw`. This is the code-side
 * enforcement behind "quotation marks mean verbatim" (spec §5).
 */
export function matchVerbatimSegment(raw: string, segment: string): string | null {
  const needle = normalizeForMatch(segment);
  if (needle.length === 0) return null;
  const { normalized, offsets } = normalizeWithMap(raw);
  const at = normalized.indexOf(needle);
  if (at === -1) return null;
  const start = offsets[at];
  const end = offsets[at + needle.length - 1] + 1;
  return foldPunctuation(raw).slice(start, end).trim();
}

/** Drop every proposed segment that is not verbatim in `raw`; de-duplicate the rest. */
export function keepVerbatimSegments(raw: string, segments: string[]): string[] {
  const kept: string[] = [];
  for (const segment of segments ?? []) {
    const exact = matchVerbatimSegment(raw, segment);
    if (exact && !kept.includes(exact)) kept.push(exact);
  }
  return kept;
}

/** Personas Sam is allowed to attribute sentiment to for this reply. */
function allowedPersonas(context: ConversationContext, reply: string): Set<string> {
  const allowed = new Set<string>([INTERVIEWER_SLUG]);
  const writer = context.writerContext?.persona ?? context.writerPersona;
  if (writer) allowed.add(writer);
  const haystack = ` ${reply.toLowerCase()} `;
  for (const [slug, aliases] of Object.entries(WRITER_ROSTER)) {
    if (haystack.includes(slug)) {
      allowed.add(slug);
      continue;
    }
    if (aliases.some((alias) => new RegExp(`\\b${alias}\\b`).test(haystack))) {
      allowed.add(slug);
    }
  }
  return allowed;
}

function fmt(n: number | undefined, digits = 1): string {
  if (n === undefined || Number.isNaN(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

/** A record with no games in it ("0-0", "0-0-0") is not a standing worth stating. */
function hasGames(record: string | undefined): boolean {
  return !!record && !/^0-0(-0)?$/.test(record.trim());
}

/**
 * The CONTEXT block exactly as Sam sees it. Exported so the interview harness and its
 * checks (`src/lib/ai/interview-checks.ts`) verify questions against the same text the
 * model was given, rather than a copy that can drift.
 */
export function buildInterviewFactBlock(context: ConversationContext): string {
  return conversationService.factBlock(context);
}

/** Lower-cased names of this manager's players who left their game hurt (spec §16.1). */
function injuredPlayerNames(context: ConversationContext): Set<string> {
  return new Set((context.inGameInjuries ?? []).map((entry) => entry.name.trim().toLowerCase()));
}

/** How long after kickoff the injury tag landed, in plain English. */
function minutesAfterKickoffLabel(entry: InGameInjury): string {
  const minutes = Math.round((entry.observedAt - entry.kickoffAt) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? `${minutes} minutes after kickoff` : 'at kickoff';
}

/**
 * The rule Sam is handed when one of this manager's players left his game hurt (spec §16.1):
 * the injury is never the lineup call, so the question is the replacement, not the regret.
 * `null` when nobody did. Pure and exported so the checks and the harness see the same text.
 */
export function buildInGameInjuryRule(context: ConversationContext): string | null {
  const injuries = context.inGameInjuries ?? [];
  if (injuries.length === 0) return null;
  const names = injuries.map((entry) => entry.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const each = names.length === 1 ? names[0] : 'any of them';
  return `IN-GAME INJURY RULE
${list} left the game hurt. That is never the manager's decision: never ask why they started ${each} or whether they regret it; ask how they replace the production (bench cover, the waiver wire, the next man up), one question.`;
}

export class ConversationService {
  /** The templated close, shaped as a normal interviewer turn. No model call, no cost. */
  private templatedClose(context: ConversationContext): AIConversationResult {
    return {
      question: buildClosingMessage(managerFirstName(context.managerName)),
      confidence: 100,
      intent: 'closing',
      expectedResponseType: 'opinion',
      contextualReasons: ['Templated close: the follow-up was asked and answered (spec §10.3.2)'],
      shouldEndAfterResponse: true,
      shouldRecordDecline: false,
      detectedAbuse: this.detectAbusePatterns(context),
      costUsd: 0,
    };
  }

  async generateConversationQuestion(
    context: ConversationContext,
    apiKey: string
  ): Promise<AIConversationResult> {
    // Sam's last line is the same three sentences every time; callers that have not learned to
    // check `shouldUseTemplatedClose` still get the saving here.
    if (shouldUseTemplatedClose(context)) return this.templatedClose(context);

    const anthropic = new Anthropic({ apiKey });
    const { systemPrompt, userPrompt } = this.buildConversationPrompts(context);

    const systemTokens = this.estimateTokens(systemPrompt);
    const userTokens = this.estimateTokens(userPrompt);
    if (systemTokens + userTokens > 15000) {
      console.warn(`Very high token usage for interview question: ${systemTokens + userTokens} estimated input tokens`, {
        systemTokens,
        userTokens,
        conversationLength: context.conversationHistory?.length ?? 0,
      });
    }

    const call = async (model: string) => {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 2000,
        output_config: { effort: 'low' },
        system: cachedSystem(systemPrompt),
        messages: [{ role: 'user', content: userPrompt }],
        tools: [{
          name: "generate_conversation_question",
          description: "Ask the manager one grounded, on-the-record question",
          input_schema: {
            type: "object",
            properties: (zodToJsonSchema(ConversationResponse, { $refStrategy: "none" }) as unknown as { properties: Record<string, unknown> }).properties,
            required: (zodToJsonSchema(ConversationResponse, { $refStrategy: "none" }) as unknown as { required: string[] }).required,
          },
        }],
        tool_choice: { type: "tool", name: "generate_conversation_question" },
      });

      const spend = recordInterviewUsage(response, 'question');
      const toolUse = response.content.find((c) => c.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error('No structured output received');
      }
      return {
        data: parseInterviewToolInput(ConversationResponse, (toolUse as unknown as { input: unknown }).input, 'question'),
        ...spend,
      };
    };

    const { data, usage, costUsd } = await this.withRetriesAndFallback(
      call,
      'interview question',
      QUESTION_MODELS
    );

    return {
      ...data,
      detectedAbuse: this.detectAbusePatterns(context),
      usage,
      costUsd,
    };
  }

  async analyzeUserResponse(
    userResponse: string,
    context: ConversationContext,
    apiKey: string
  ): Promise<ResponseAnalysisResult> {
    const anthropic = new Anthropic({ apiKey });

    const personaOptions = Array.from(allowedPersonas(context, userResponse));

    const ResponseAnalysisSchema = z.object({
      responseQuality: z.coerce.number().min(0).max(100).catch(50).describe("Quality and quotability score (0-100)"),
      completeness: z.coerce.number().min(0).max(100).catch(50).describe("Completeness of thought score (0-100)"),
      relevantTopics: z.array(z.string()).default([]).describe("Topic labels for the reply. These are NEVER quotes and are never printed."),
      needsFollowUp: z.coerce.boolean().default(false).describe("Whether one follow-up question would yield better material"),
      suggestedFollowUps: z.array(z.string()).optional().describe("Suggested follow-up topics if needed"),
      sentiment: z.enum(["positive", "negative", "neutral", "mixed"]).describe("Overall sentiment of the response"),
      quotableSegments: z.array(z.string()).describe(
        "Printable spans copied CHARACTER FOR CHARACTER from the reply. Each string must appear in the reply exactly as written - do not fix spelling, punctuation, capitalization, or word order, and never join text from two different sentences. Return an empty array rather than a paraphrase."
      ),
      offTopicScore: z.number().min(0).max(100).describe("How off-topic the response is (0=on-topic, 100=completely off-topic)"),
      isDecline: z.coerce.boolean().default(false).describe(
        "True ONLY when the reply as a whole refuses to comment - 'no comment', 'not today', 'leave me out of it' - and says nothing about the team. False whenever the manager said anything about their team, even if they end with 'no further comment'."
      ),
      writerSentiment: z.array(z.object({
        persona: z.enum(personaOptions.length > 0 ? (personaOptions as [string, ...string[]]) : ['sam-ortega']).describe("Writer slug the manager talked about"),
        sentiment: z.enum(["hostile", "dismissive", "neutral", "friendly"]).describe("How the manager talked about that writer"),
        evidence: z.string().describe("The span of the reply that shows it, copied verbatim"),
      })).describe(
        "One entry per writer the manager actually named or clearly referred to in this reply. Empty array when they named nobody. Never invent a writer."
      ),
    });

    const analysisPrompt = `Analyze this manager's on-the-record reply for the FFSN newsroom.

CONTEXT
${this.buildFactBlock(context)}

WRITERS YOU MAY ATTRIBUTE SENTIMENT TO: ${personaOptions.join(', ')}

MANAGER'S REPLY (the only source of quotes):
"""
${userResponse}
"""

Rules:
1. quotableSegments must be exact substrings of the reply above. Copy, never retype. If nothing is
   printable as written, return an empty array.
2. relevantTopics are labels for internal routing. They are not quotes and must not duplicate
   quotableSegments.
3. writerSentiment only covers writers actually named or unmistakably referred to in the reply, and
   only from the list above. "hostile" is an insult or an attack, "dismissive" waves the writer off,
   "friendly" is praise or warmth, "neutral" is a plain mention.
4. Do not judge whether the manager's decisions were good or bad.
5. isDecline is true only for a reply that refuses to comment and says nothing about the team.
   "No comment." is a decline. "Joe Burrow killed me, no further comment." is an answer.`;

    const call = async (model: string) => {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1500,
        output_config: { effort: 'low' },
        system: cachedSystem(
          "You are a newsroom transcript analyst. You never paraphrase inside a quote and never invent an attribution. Return structured data only."
        ),
        messages: [{ role: 'user', content: analysisPrompt }],
        tools: [{
          name: "analyze_response",
          description: "Analyze a manager's interview reply",
          input_schema: {
            type: "object",
            properties: (zodToJsonSchema(ResponseAnalysisSchema, { $refStrategy: "none" }) as unknown as { properties: Record<string, unknown> }).properties,
            required: (zodToJsonSchema(ResponseAnalysisSchema, { $refStrategy: "none" }) as unknown as { required: string[] }).required,
          },
        }],
        tool_choice: { type: "tool", name: "analyze_response" },
      });

      const spend = recordInterviewUsage(response, 'analysis');
      const toolUse = response.content.find((c) => c.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error('No structured analysis received from AI');
      }
      return {
        data: parseInterviewToolInput(ResponseAnalysisSchema, (toolUse as unknown as { input: unknown }).input, 'analysis'),
        ...spend,
      };
    };

    let analysis: z.infer<typeof ResponseAnalysisSchema>;
    let usage: InterviewUsage | undefined;
    let costUsd = 0;
    try {
      // Reading a reply is a classification job: Sonnet 5 at low effort, Opus only as a fallback.
      const result = await this.withRetriesAndFallback(call, 'response analysis', ANALYSIS_MODELS);
      analysis = result.data;
      usage = result.usage;
      costUsd = result.costUsd;
    } catch (error) {
      console.warn('AI analysis failed, using local fallback analysis:', (error as Error)?.message);
      return {
        responseQuality: this.calculateResponseQuality(userResponse, context),
        completeness: this.calculateCompleteness(userResponse),
        relevantTopics: this.extractTopics(userResponse, context),
        needsFollowUp: userResponse.length < 50 || userResponse.includes('?') || this.shouldFollowUp(userResponse),
        suggestedFollowUps: this.generateSuggestedFollowUps(userResponse, context),
        sentiment: this.analyzeSentiment(userResponse),
        quotableSegments: keepVerbatimSegments(userResponse, this.extractQuotes(userResponse)),
        offTopicScore: this.calculateOffTopicScore(userResponse, context),
        isDecline: false,
        writerSentiment: [],
        costUsd: 0,
      };
    }

    // Model output is advisory; the verbatim and roster constraints are enforced here.
    const allowed = allowedPersonas(context, userResponse);
    return {
      ...analysis,
      quotableSegments: keepVerbatimSegments(userResponse, analysis.quotableSegments),
      writerSentiment: (analysis.writerSentiment ?? [])
        .filter((entry) => allowed.has(entry.persona))
        .map((entry) => ({
          persona: entry.persona,
          sentiment: entry.sentiment,
          evidence: (matchVerbatimSegment(userResponse, entry.evidence) ?? entry.evidence).slice(0, 280),
        })),
      usage,
      costUsd,
    };
  }

  /**
   * Walks `models` in order, retrying 529/overloaded on each with jittered backoff before moving
   * to the next. The chain is per call site: questions lead with Opus, analysis with Sonnet.
   */
  private async withRetriesAndFallback<T>(
    call: (model: string) => Promise<T>,
    label: string,
    models: readonly string[]
  ): Promise<T> {
    const last = models[models.length - 1];
    const maxRetries = 3;
    const baseDelay = 1000;
    let lastError: Error | null = null;

    for (const model of models) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await call(model);
        } catch (error) {
          lastError = error as Error;
          const errorObj = error as any;
          const is529 = error instanceof Anthropic.APIError && errorObj.status === 529;
          const isOverloaded = errorObj.name === 'OverloadedError' || errorObj.type === 'overloaded_error';
          if ((is529 || isOverloaded) && attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
            console.warn(`${model} overloaded for ${label} (attempt ${attempt + 1}/${maxRetries + 1}). Retrying in ${Math.round(delay)}ms.`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          break;
        }
      }
      if (model !== last) {
        console.warn(`Falling back to ${last} for ${label}: ${lastError?.message}`);
      }
    }

    throw new Error(`Failed to generate ${label}: ${lastError?.message || 'Unknown error'}`);
  }

  /* ------------------------------------------------------------------------ */
  /* Prompts                                                                   */
  /* ------------------------------------------------------------------------ */

  private buildConversationPrompts(context: ConversationContext): {
    systemPrompt: string;
    userPrompt: string;
  } {
    const isInitialMessage = !context.conversationHistory || context.conversationHistory.length === 0;
    return {
      systemPrompt: this.buildInterviewerSystemPrompt(),
      userPrompt: this.buildUserPrompt(context, isInitialMessage),
    };
  }

  /** Sam Ortega, FFSN sideline reporter (spec §5). Voice only above the hard rules. */
  private buildInterviewerSystemPrompt(): string {
    return `You are Simone "Sam" Ortega, sideline reporter for FFSN. You are getting one quick on-the-record comment from a fantasy manager before a story runs. You are a reporter: you ask, you listen, you leave.

HARD RULES
1. Ask exactly one question per message. Never two.
2. Every question must contain at least one specific verified fact from CONTEXT - an opponent, a margin, a player and a point total, a dollar amount, a pick number. If CONTEXT lacks a specific fact, ask about the one thing you do know and say less.
3. Never state a fact that is not in CONTEXT. Never guess a player's NFL team, injury, or rookie status. Never speculate about what another manager thinks. Never add color CONTEXT does not have (which day the game was, how long it took, how it felt).
3a. Numbers are quoted exactly as CONTEXT writes them - never rounded, never "about", never "140-plus". A score is always the manager's points first, then the opponent's, in CONTEXT's order: "lost 107.6-143.8 to Team Rive", never "dropped 143.8 to 107.6".
4. Never give advice, analysis, predictions, or opinions. If asked for one, say you just take notes and re-ask your question once.
5. Never characterize their decision as good or bad. "Walk me through it," not "why would you do that?"
6. Maximum two questions total: the opener, then at most one follow-up that digs into a specific thing they actually said. If their first answer is complete, skip the follow-up and close. A follow-up asks for a new beat - the why, the what-next - never a restatement of numbers they just gave you or that were in your opener.
7. After their final answer, always close with a variation of "Anything else you want on the record?" and set intent to "closing". Never staple a follow-up onto the close: a message is either the one follow-up or the close, not both.
8. If they decline, say "no comment," or go silent on substance, thank them once and end. Never push twice. Set intent to "closing" and shouldRecordDecline to true. An answer that ends with "that's all" or "no further comment" is an answer, not a decline: close with intent "closing" and shouldRecordDecline false.
9. If they go off-topic or ask about you, one light redirect, then end.
10. You may use a writer's recent line about this manager from CONTEXT and offer them the reply: "Mel called your Hurts pick 'nineteen picks of air.' Anything you want to say to him?" Only when that line is in CONTEXT, and quote it exactly as CONTEXT has it.
11. A player CONTEXT lists under "In-game injury" left his game hurt. That is never the manager's decision: never ask why they started him or whether they regret it; ask how they replace the production - bench cover, the waiver wire, the next man up.

VOICE: brisk, warm, curious. Two sentences maximum. Contractions. No emoji, no exclamation points, no jokes at their expense - the columnists do that part. You are on their sideline, not in their face.

DISCLOSURE: this is on the record and may be quoted with their name and team.`;
  }

  /**
   * The CONTEXT block: only lines backed by real data are emitted, so the "never state a
   * fact not in CONTEXT" rule is enforceable by what is absent.
   */
  /** Public alias of `buildFactBlock` for `buildInterviewFactBlock`. */
  factBlock(context: ConversationContext): string {
    return this.buildFactBlock(context);
  }

  private buildFactBlock(context: ConversationContext): string {
    const { teamPerformance: tp, leagueContext, week, seasonId, contentType } = context;
    const lines: string[] = [];

    // A draft piece or an offseason story has no week; "Week 0" is never a thing to say.
    const weekLabel = week > 0 ? `Week ${week}, ` : '';
    lines.push(`Story: ${contentType.replace(/_/g, ' ')} - ${weekLabel}${seasonId} season${context.leagueName ? `, ${context.leagueName}` : ''}`);
    lines.push(`Manager: ${context.managerName ?? 'Unknown manager'}`);
    lines.push(`Team: ${context.teamName ?? tp.teamName}`);

    if (context.upcomingOpponentName && !(tp.score > 0)) {
      lines.push(`${week > 0 ? `Week ${week} matchup` : 'Next matchup'}: vs ${context.upcomingOpponentName} (not played yet - no result to cite)`);
    }

    if (tp.score > 0) {
      const result = context.tie ? 'Tied' : tp.won ? 'Won' : 'Lost';
      if (context.opponentName && context.opponentScore !== undefined) {
        lines.push(
          `Week ${week} result: ${result} ${fmt(tp.score)}-${fmt(context.opponentScore)} ${context.tie ? 'with' : tp.won ? 'over' : 'to'} ${context.opponentName}` +
          (context.margin !== undefined && !context.tie ? ` (margin ${fmt(context.margin)})` : '')
        );
      } else {
        lines.push(`Week ${week} result: ${result} with ${fmt(tp.score)} points`);
      }
      if (tp.projectedScore) lines.push(`Projected: ${fmt(tp.projectedScore)}`);
    }

    const standing = leagueContext.standings.find((s) => s.teamId === tp.teamId);
    if (standing && hasGames(standing.record)) {
      lines.push(
        `Standing: #${standing.rank} by record (${standing.record})` +
          (context.playoffSeed ? `, ESPN playoff seed #${context.playoffSeed}` : '')
      );
    }

    if (context.benchPoints !== undefined && context.benchPoints > 0) {
      const top = context.topBenchPlayer;
      lines.push(
        `Bench points: ${fmt(context.benchPoints)}` +
        (top ? ` (most: ${top.player}, ${top.position}, ${fmt(top.points)})` : '')
      );
    }

    // A starter who left his game hurt is not a lineup decision and not an under-projection
    // (spec §16.1): those lines would hand Sam the "why did you start him" question.
    const injured = injuredPlayerNames(context);
    for (const decision of context.lineupDecisions ?? []) {
      if (injured.has(decision.startedPlayer.trim().toLowerCase())) continue;
      lines.push(
        `Lineup: ${decision.benchedPlayer} (${decision.position}) scored ${fmt(decision.benchedPoints)} on the bench; started ${decision.startedPlayer} scored ${fmt(decision.startedPoints)} (difference ${fmt(decision.pointGain)})`
      );
    }

    for (const entry of context.inGameInjuries ?? []) {
      const position = entry.position ? ` (${entry.position})` : '';
      const points = entry.points !== undefined ? `, ${fmt(entry.points)} points` : '';
      lines.push(
        `In-game injury: ${entry.name}${position} left hurt - ${entry.status}, ${minutesAfterKickoffLabel(entry)}, ${entry.started ? 'started' : 'on the bench'}${points}`
      );
    }

    for (const player of tp.underperformers.filter((p) => !injured.has(p.player.trim().toLowerCase())).slice(0, 2)) {
      lines.push(`Under projection: ${player.player} (${player.position}) ${fmt(player.actualPts)} vs ${fmt(player.expectedPts)} projected`);
    }
    for (const player of tp.overperformers.slice(0, 2)) {
      lines.push(`Over projection: ${player.player} (${player.position}) ${fmt(player.actualPts)} vs ${fmt(player.expectedPts)} projected`);
    }

    for (const tx of (context.transactionsThisWeek ?? []).slice(0, 4)) {
      const added = tx.playersAdded.length ? `added ${tx.playersAdded.join(', ')}` : '';
      const dropped = tx.playersDropped.length ? `dropped ${tx.playersDropped.join(', ')}` : '';
      const faab = tx.bidAmount ? ` for $${fmt(tx.bidAmount, 0)} FAAB` : '';
      const detail = [added, dropped].filter(Boolean).join(', ');
      if (detail) lines.push(`Transaction (${tx.type}): ${detail}${faab}`);
    }

    for (const trade of (context.tradesThisWeek ?? []).slice(0, 3)) {
      lines.push(`Trade with ${trade.withTeam}: sent ${trade.gave.join(', ') || 'nothing'}, received ${trade.received.join(', ') || 'nothing'}`);
    }

    // FAAB ledger: the claims this manager made in the latest waiver run, their
    // remaining budget, and the league-wide highlights. Dollar figures are quoted
    // verbatim so Sam can cite them; she is told not to invent any.
    for (const claim of (context.waiverClaimsThisRun ?? []).slice(0, 4)) {
      const who = claim.position ? `${claim.player} (${claim.position})` : claim.player;
      const rivals = claim.competingBids
        .slice(0, 3)
        .map((b) => `${b.teamName} $${fmt(b.bid, 0)}`)
        .join(', ');
      if (claim.result === 'won') {
        lines.push(
          `Waiver claim (week ${claim.scoringPeriod}): won ${who} for $${fmt(claim.bid, 0)}` +
            (rivals ? `, outbidding ${rivals}` : ' unopposed'),
        );
      } else {
        const winner = claim.competingBids[0];
        lines.push(
          `Waiver claim (week ${claim.scoringPeriod}): lost ${who} with a $${fmt(claim.bid, 0)} bid` +
            (winner ? ` (${winner.teamName} won at $${fmt(winner.bid, 0)})` : ''),
        );
      }
    }
    if (context.waiverBudget && context.waiverBudget.remaining !== undefined) {
      const b = context.waiverBudget;
      const ofBudget = b.budget !== undefined ? ` of $${fmt(b.budget, 0)}` : '';
      const pickups = b.acquisitions !== undefined ? `, ${b.acquisitions} pickups this season` : '';
      lines.push(`FAAB remaining: $${fmt(b.remaining, 0)}${ofBudget}${pickups}`);
    }
    if (context.waiverSeasonHighlights) {
      const h = context.waiverSeasonHighlights;
      if (h.biggestBid) {
        lines.push(`League's biggest bid: ${h.biggestBid.teamName} paid $${fmt(h.biggestBid.bid, 0)} for ${h.biggestBid.player} in week ${h.biggestBid.week}`);
      }
      if (h.mostActive) lines.push(`Most active on waivers: ${h.mostActive.teamName} (${h.mostActive.acquisitions} pickups)`);
      if (h.lowestRemaining.length > 0) {
        lines.push(`Lowest budgets left: ${h.lowestRemaining.slice(0, 3).map((t) => `${t.teamName} $${fmt(t.remaining, 0)}`).join(', ')}`);
      }
    }

    if (context.rivalry) {
      lines.push(`Rivalry: ${context.rivalry.allTimeRecord} all-time against ${context.rivalry.opponent}`);
    }

    if (leagueContext.playoffContext?.isPlayoffWeek) {
      lines.push(`Playoffs: ${leagueContext.playoffContext.playoffImplications}`);
    }

    const picks = context.draftData?.userDraftPicks ?? [];
    for (const pick of picks.slice(0, 3)) {
      const adp = pick.playerADP
        ? `, ADP ${fmt(pick.playerADP, 0)} (${pick.pickNumber < pick.playerADP ? `${fmt(pick.playerADP - pick.pickNumber, 0)} picks early` : `${fmt(pick.pickNumber - pick.playerADP, 0)} picks late`})`
        : '';
      lines.push(
        `Draft pick ${pick.roundNumber}.${String(pick.roundPickNumber).padStart(2, '0')} (overall ${pick.pickNumber}): ${pick.playerName}, ${pick.playerPosition}${pick.isRookie ? ', rookie' : ''}${adp}`
      );
    }

    for (const quote of (context.priorQuotes ?? []).slice(0, 3)) {
      lines.push(`Already on the record${quote.week ? ` (Week ${quote.week})` : ''}: "${quote.text}"${quote.askedAbout ? ` - asked about ${quote.askedAbout}` : ''}`);
    }

    const writer = context.writerContext;
    if (writer) {
      lines.push(`Writer on this story: ${writer.name} (${writer.persona}), relationship with this manager: ${writer.relationship.tier}`);
      for (const mention of writer.recentMentions.slice(0, 2)) {
        lines.push(
          `${writer.name} ${mention.stance === 'roast' ? 'wrote about' : 'praised'} this manager${mention.week ? ` in Week ${mention.week}` : ''}${mention.articleTitle ? ` ("${mention.articleTitle}")` : ''}: "${mention.evidence}"`
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * The one fact the opener must lead with, per content type. Leads with the most
   * specific number available and degrades to whatever CONTEXT actually holds.
   */
  private openingAngle(context: ConversationContext): string {
    const { teamPerformance: tp, leagueContext, week } = context;
    const standing = leagueContext.standings.find((s) => s.teamId === tp.teamId);
    // The injured starter is nobody's lineup call and nobody's under-projection (spec §16.1).
    const injured = injuredPlayerNames(context);
    const lineupDecisions = (context.lineupDecisions ?? []).filter((d) => !injured.has(d.startedPlayer.trim().toLowerCase()));
    const underperformers = tp.underperformers.filter((p) => !injured.has(p.player.trim().toLowerCase()));
    const firstInjury = context.inGameInjuries?.[0];
    const injuryPhrase = firstInjury
      ? `${firstInjury.name} leaving the game hurt (${firstInjury.status}, ${minutesAfterKickoffLabel(firstInjury)})` +
        (firstInjury.points !== undefined ? ` with ${fmt(firstInjury.points)} points` : '')
      : null;
    const marginPhrase =
      context.tie && context.opponentName && context.opponentScore !== undefined
        ? `the ${fmt(tp.score)}-${fmt(context.opponentScore)} tie with ${context.opponentName}`
        : context.margin !== undefined && context.opponentName
        ? `the ${fmt(context.margin)}-point ${tp.won ? 'win over' : 'loss to'} ${context.opponentName}`
        : tp.score > 0
        ? `their ${fmt(tp.score)}-point Week ${week}`
        : null;
    const benchPhrase =
      context.topBenchPlayer && context.benchPoints !== undefined && context.benchPoints > 0
        ? `${fmt(context.topBenchPlayer.points)} from ${context.topBenchPlayer.player} on the bench`
        : null;
    const lineupPhrase = lineupDecisions[0]
      ? `starting ${lineupDecisions[0].startedPlayer} (${fmt(lineupDecisions[0].startedPoints)}) over ${lineupDecisions[0].benchedPlayer} (${fmt(lineupDecisions[0].benchedPoints)})`
      : null;
    // Prefer the ledger (wins, losses and the budget left) over the raw transaction feed.
    const wonClaim = (context.waiverClaimsThisRun ?? []).find((c) => c.result === 'won');
    const lostClaim = (context.waiverClaimsThisRun ?? []).find((c) => c.result === 'lost');
    const remaining = context.waiverBudget?.remaining;
    const remainingPhrase = remaining !== undefined ? ` with $${fmt(remaining, 0)} still in the bank` : '';
    const ledgerPhrase = wonClaim
      ? `the $${fmt(wonClaim.bid, 0)} winning bid on ${wonClaim.player}` +
        (wonClaim.competingBids[0] ? ` over ${wonClaim.competingBids[0].teamName}'s $${fmt(wonClaim.competingBids[0].bid, 0)}` : '') +
        remainingPhrase
      : lostClaim
        ? `getting outbid on ${lostClaim.player} ($${fmt(lostClaim.bid, 0)}` +
          (lostClaim.competingBids[0] ? ` against ${lostClaim.competingBids[0].teamName}'s $${fmt(lostClaim.competingBids[0].bid, 0)}` : '') +
          `)${remainingPhrase}`
        : null;
    const faabTx = (context.transactionsThisWeek ?? []).find((t) => t.bidAmount && t.bidAmount > 0);
    const faabPhrase =
      ledgerPhrase ??
      (faabTx ? `the $${fmt(faabTx.bidAmount, 0)} FAAB bid on ${faabTx.playersAdded[0] ?? 'their claim'}` : null);
    const anyAdd = (context.transactionsThisWeek ?? []).find((t) => t.playersAdded.length > 0);
    const addPhrase = anyAdd ? `adding ${anyAdd.playersAdded[0]}` : null;
    const tradePhrase = context.tradesThisWeek?.[0]
      ? `the trade with ${context.tradesThisWeek[0].withTeam} (sent ${context.tradesThisWeek[0].gave.join(', ') || 'nothing'}, got ${context.tradesThisWeek[0].received.join(', ') || 'nothing'})`
      : null;
    const rankPhrase = standing && hasGames(standing.record) ? `their #${standing.rank} spot at ${standing.record}` : null;
    const upcomingPhrase =
      context.upcomingOpponentName && !(tp.score > 0)
        ? `their ${week > 0 ? `Week ${week} ` : 'upcoming '}matchup against ${context.upcomingOpponentName}`
        : null;
    const rivalryPhrase = context.rivalry
      ? `their ${context.rivalry.allTimeRecord} all-time record against ${context.rivalry.opponent}`
      : null;
    const firstPick = context.draftData?.userDraftPicks?.[0];
    const pickPhrase = firstPick
      ? firstPick.playerADP
        ? `taking ${firstPick.playerName} at ${firstPick.roundNumber}.${String(firstPick.roundPickNumber).padStart(2, '0')}, ${fmt(Math.abs(firstPick.playerADP - firstPick.pickNumber), 0)} picks ${firstPick.pickNumber < firstPick.playerADP ? 'ahead of' : 'behind'} his ADP`
        : `taking ${firstPick.playerName} at ${firstPick.roundNumber}.${String(firstPick.roundPickNumber).padStart(2, '0')}`
      : null;
    const topPerformer = tp.overperformers[0]
      ? `${fmt(tp.overperformers[0].actualPts)} from ${tp.overperformers[0].player}`
      : null;
    const worstPerformer = underperformers[0]
      ? `${underperformers[0].player}'s ${fmt(underperformers[0].actualPts)} against a ${fmt(underperformers[0].expectedPts)} projection`
      : null;

    const firstOf = (...candidates: Array<string | null>) =>
      candidates.find((c): c is string => !!c) ?? 'the single most specific number in CONTEXT about their team';

    switch (context.contentType) {
      case 'weekly_recap':
        return tp.won
          ? firstOf(marginPhrase && topPerformer ? `${marginPhrase} and ${topPerformer}` : marginPhrase, topPerformer, rankPhrase)
          : firstOf(
              // A starter who left hurt leads over the bench points behind him: the story is the
              // replacement, not the slot (spec §16.1).
              marginPhrase && injuryPhrase ? `${marginPhrase} and ${injuryPhrase}` : injuryPhrase,
              marginPhrase && benchPhrase ? `${marginPhrase} and ${benchPhrase}` : marginPhrase,
              benchPhrase,
              lineupPhrase,
              worstPerformer,
              rankPhrase
            );
      case 'weekly_preview':
        return firstOf(upcomingPhrase && rankPhrase ? `${upcomingPhrase} at ${standing!.record}` : upcomingPhrase, rankPhrase, marginPhrase, topPerformer);
      case 'power_rankings':
        return firstOf(rankPhrase, marginPhrase, upcomingPhrase);
      case 'waiver_wire_report':
        return firstOf(faabPhrase, addPhrase, worstPerformer, rankPhrase);
      case 'trade_analysis':
      case 'trade_block_tuesday':
      case 'trade_rumor_mill':
        return firstOf(tradePhrase, addPhrase, rankPhrase);
      case 'mock_draft':
      case 'draft_rankings':
      case 'draft_strategy_guide':
        return firstOf(pickPhrase, rankPhrase);
      case 'rivalry_week_special':
        return firstOf(rivalryPhrase, marginPhrase, rankPhrase);
      case 'mid_season_awards':
        return firstOf(topPerformer, worstPerformer, rankPhrase);
      case 'championship_manifesto':
      case 'season_recap':
        return firstOf(rankPhrase, marginPhrase, topPerformer);
      case 'emergency_hot_takes':
        return firstOf(addPhrase, tradePhrase, marginPhrase, rankPhrase);
      case 'custom_roast':
      case 'hall_of_shame':
        return firstOf(benchPhrase, lineupPhrase, worstPerformer, rankPhrase);
      case 'season_welcome':
        return firstOf(rankPhrase, pickPhrase, upcomingPhrase);
      default:
        return firstOf(marginPhrase, benchPhrase, rankPhrase, topPerformer, upcomingPhrase);
    }
  }

  private buildUserPrompt(context: ConversationContext, isInitial: boolean): string {
    const facts = this.buildFactBlock(context);
    const injuryRule = buildInGameInjuryRule(context);
    const rules = injuryRule ? `\n${injuryRule}\n` : '';

    if (isInitial) {
      return `CONTEXT (the only facts you may state)
${facts}
${rules}
TASK
Ask your opening question. Lead with ${this.openingAngle(context)}, stated as one clause with the number in it, then one open question they cannot answer with "yeah." Introduce yourself by name on first contact and make clear this is on the record. Set intent to "initial".`;
    }

    const history = context.conversationHistory ?? [];
    const userMessages = history.filter((m) => m.role === 'user');
    const aiMessages = history.filter((m) => m.role === 'ai');
    const lastUserMessage = userMessages[userMessages.length - 1];
    const isLastQuestion = userMessages.length >= 1;

    return `CONTEXT (the only facts you may state)
${facts}
${rules}
QUESTIONS YOU HAVE ALREADY ASKED (never repeat one)
${aiMessages.map((m) => `- ${m.content}`).join('\n') || '- none'}

THEIR LAST ANSWER
"${lastUserMessage?.content ?? ''}"

TASK
${isLastQuestion
  ? `This is your last message. If their answer left one specific thing they said worth one more beat, ask that single follow-up (quote at most one short phrase of theirs, then ask about something they did NOT address - never re-ask what they answered, never re-list your opener's numbers) and set intent to "follow_up" with shouldEndAfterResponse true. Otherwise close with a variation of "Anything else you want on the record?" and set intent to "closing". One or the other, never a follow-up with "anything else" stapled on.`
  : `Ask one follow-up that digs into a specific thing they actually said, then set shouldEndAfterResponse to true.`}
If they declined, said no comment, or gave nothing on substance, thank them once, set intent to "closing" and shouldRecordDecline to true.`;
  }

  /* ------------------------------------------------------------------------ */
  /* Local heuristics (fallback only)                                          */
  /* ------------------------------------------------------------------------ */

  private detectAbusePatterns(context: ConversationContext): AIConversationResult['detectedAbuse'] {
    const lastMessage = context.conversationHistory?.filter(m => m.role === 'user').pop();
    if (!lastMessage) return undefined;

    const content = lastMessage.content.toLowerCase();

    const offTopicKeywords = ['weather', 'politics', 'recipe', 'how do i', 'what is', 'can you help'];
    const hasOffTopic = offTopicKeywords.some(keyword => content.includes(keyword));

    const spamPatterns = /(.)\1{4,}|[A-Z]{10,}|http/;
    const isSpam = spamPatterns.test(content) || content.length > 1000;

    const aiQuestions = ['what model are you', 'are you chatgpt', 'how do you work', 'tell me about yourself'];
    const isQuestioningAI = aiQuestions.some(q => content.includes(q));

    if (isQuestioningAI) {
      return {
        type: 'questioning_ai',
        severity: 'medium',
        reason: 'Manager is asking about the interviewer instead of answering on the record',
      };
    }

    if (isSpam) {
      return {
        type: 'spam',
        severity: 'high',
        reason: 'Message appears to be spam or nonsense',
      };
    }

    if (hasOffTopic) {
      return {
        type: 'off_topic',
        severity: 'low',
        reason: 'Response is not related to the story',
      };
    }

    return undefined;
  }

  private extractTopics(response: string, context: ConversationContext): string[] {
    const topics: string[] = [];
    const lowerResponse = response.toLowerCase();

    [...context.teamPerformance.underperformers, ...context.teamPerformance.overperformers].forEach(player => {
      if (lowerResponse.includes(player.player.toLowerCase())) {
        topics.push(`${player.player} performance`);
      }
    });

    if (lowerResponse.includes('start') || lowerResponse.includes('bench')) {
      topics.push('start/sit decision');
    }
    if (lowerResponse.includes('waiver') || lowerResponse.includes('pickup')) {
      topics.push('waiver wire move');
    }
    if (lowerResponse.includes('trade')) {
      topics.push('trade consideration');
    }
    if (lowerResponse.includes('mistake') || lowerResponse.includes('regret')) {
      topics.push('roster regret');
    }
    if (lowerResponse.includes('lucky') || lowerResponse.includes('fortunate')) {
      topics.push('luck factor');
    }

    return topics;
  }

  private analyzeSentiment(response: string): "positive" | "negative" | "neutral" | "mixed" {
    const lower = response.toLowerCase();

    const positiveWords = ['great', 'awesome', 'perfect', 'happy', 'excited', 'love', 'best', 'win', 'success'];
    const negativeWords = ['terrible', 'awful', 'hate', 'worst', 'disaster', 'failed', 'disappointed', 'frustrat'];

    const positiveCount = positiveWords.filter(word => lower.includes(word)).length;
    const negativeCount = negativeWords.filter(word => lower.includes(word)).length;

    if (positiveCount > negativeCount + 1) return 'positive';
    if (negativeCount > positiveCount + 1) return 'negative';
    if (positiveCount > 0 && negativeCount > 0) return 'mixed';
    return 'neutral';
  }

  private extractQuotes(response: string): string[] {
    const quotes: string[] = [];
    const sentences = response.match(/[^.!?]+[.!?]+/g) || [];

    sentences.forEach(sentence => {
      const trimmed = sentence.trim();
      const hasOpinion = /I (think|believe|feel|knew|should|couldn't|had to)/i.test(trimmed);
      const hasEmotion = /(frustrat|disappoint|thrill|excit|angry|happy|devastat)/i.test(trimmed);
      const hasSpecificity = /\d+\s*(points|yards|touchdowns|receptions)/.test(trimmed);
      const isReasonablyShort = trimmed.length < 200;

      if ((hasOpinion || hasEmotion || hasSpecificity) && isReasonablyShort) {
        quotes.push(trimmed);
      }
    });

    return quotes.slice(0, 3);
  }

  private calculateOffTopicScore(response: string, context: ConversationContext): number {
    const lower = response.toLowerCase();
    let score = 0;

    const ffKeywords = ['team', 'player', 'points', 'roster', 'lineup', 'start', 'bench', 'waiver', 'trade', 'matchup', 'week', 'score'];
    const ffMatches = ffKeywords.filter(keyword => lower.includes(keyword)).length;
    score = Math.max(0, 50 - (ffMatches * 10));

    const offTopicIndicators = ['recipe', 'weather', 'politics', 'movie', 'restaurant', 'vacation'];
    score += offTopicIndicators.filter(keyword => lower.includes(keyword)).length * 25;

    const mentionsContextPlayers = [...context.teamPerformance.underperformers, ...context.teamPerformance.overperformers]
      .some(player => lower.includes(player.player.toLowerCase()));
    if (mentionsContextPlayers) {
      score = Math.max(0, score - 20);
    }

    return Math.min(100, score);
  }

  private calculateResponseQuality(response: string, context: ConversationContext): number {
    let quality = 50;

    if (response.length > 100) quality += 15;
    if (response.length > 200) quality += 10;

    if (/\d+\s*(points|yards|touchdowns)/.test(response)) quality += 20;

    const emotionalWords = ['excited', 'frustrated', 'disappointed', 'thrilled', 'angry', 'happy'];
    if (emotionalWords.some(word => response.toLowerCase().includes(word))) quality += 15;

    const mentionsContextPlayers = [...context.teamPerformance.underperformers, ...context.teamPerformance.overperformers]
      .some(player => response.toLowerCase().includes(player.player.toLowerCase()));
    if (mentionsContextPlayers) quality += 10;

    return Math.min(100, quality);
  }

  private calculateCompleteness(response: string): number {
    let completeness = 30;

    if (response.length > 50) completeness += 20;
    if (response.length > 150) completeness += 25;
    if (response.length > 300) completeness += 25;

    const reasoningWords = ['because', 'since', 'therefore', 'however', 'although', 'but'];
    if (reasoningWords.some(word => response.toLowerCase().includes(word))) completeness += 15;

    if (response.includes('?')) completeness -= 15;

    return Math.min(100, Math.max(0, completeness));
  }

  private shouldFollowUp(response: string): boolean {
    if (response.length < 50) return true;
    if (response.includes('?')) return true;

    const vagueIndicators = ['not sure', 'maybe', 'i guess', 'probably', 'kinda'];
    return vagueIndicators.some(phrase => response.toLowerCase().includes(phrase));
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private generateSuggestedFollowUps(response: string, context: ConversationContext): string[] {
    const suggestions: string[] = [];
    const lower = response.toLowerCase();

    if (lower.includes('start') || lower.includes('bench')) {
      suggestions.push('the start/sit call they just described');
    }
    if (lower.includes('frustrat') || lower.includes('disappoint')) {
      suggestions.push('the part of the week they called frustrating');
    }

    const mentionedPlayers = [...context.teamPerformance.underperformers, ...context.teamPerformance.overperformers]
      .filter(player => lower.includes(player.player.toLowerCase()));
    if (mentionedPlayers.length > 0) {
      suggestions.push(`${mentionedPlayers[0].player}'s day`);
    }

    if (suggestions.length === 0) {
      suggestions.push('the specific decision they mentioned');
    }

    return suggestions.slice(0, 3);
  }
}

// Export singleton instance
export const conversationService = new ConversationService();
