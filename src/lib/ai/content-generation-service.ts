import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { generatePrompt, PromptBuilderOptions, LeagueDataContext, InsufficientDataError } from './prompt-builder';
import { enhancePromptWithComments } from './comment-integration';
import { contentTemplates } from './content-templates';
import { serializeFacts, type FactsBlock } from './facts';
import {
  parseQuoteDirectives,
  stripQuoteDirectives,
  verifyArticle,
  type Violation,
} from './fact-verifier';
import type { RelationshipTier } from './persona-prompts';
import { Id } from '../../../convex/_generated/dataModel';

interface AnthropicResponse {
  content: Array<{ text: string }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Claude 5-family models reject sampling params (temperature/top_p); persona "heat" lives in the
// system prompt instead. Effort controls thinking depth and cost per article.
const ARTICLE_EFFORT = 'medium' as const;
// Upper bound for the retry after a max_tokens truncation. Thinking tokens share this budget.
// Kept under ~21k: the Anthropic SDK refuses non-streaming requests it expects to run past ten
// minutes (about 21,333 tokens at its rate heuristic), and Convex actions time out at ten minutes.
const MAX_STRUCTURED_TOKENS = 21000;

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
  commentResponses?: CommentResponseData[];
  nonRespondents?: NonRespondent[];
  relationships?: WriterRelationshipContext[];
  priorClaims?: PriorClaim[];
  priorRecord?: PriorRecord;
}

/** Verifier findings, attached to the article so the commissioner sees every flagged sentence. */
export type ReviewFlag = Violation;

/* ------------------------------------------------------------------------------------------- *
 * Structured output schema v2
 * ------------------------------------------------------------------------------------------- */

const ArticleSection = z.object({
  name: z.string().describe("The section heading as readers will see it, in the writer's voice"),
  content: z.string().describe("The section content"),
  wordCount: z.number().describe("Number of words in the content"),
});

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
    quotes: GeneratedArticleT["quotes"];
    managerMentions: GeneratedArticleT["managerMentions"];
    /** Explicit predictions, stored on `aiContent.claims` with `outcome: "open"` (spec §8.4). */
    claims: ArticleClaimT[];
    reviewFlags: ReviewFlag[];
    factsMissing: string[];
    verifierStats: VerifierStats;
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
      case 'llm_contradicted': {
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

/** Ledger quote ids named anywhere in a set of violations. */
function quoteIdsIn(violations: Violation[]): Set<string> {
  const ids = new Set<string>();
  for (const violation of violations) {
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
 * Optional LLM fact-check pass (spec §8.6)
 * ------------------------------------------------------------------------------------------- */

const FactCheckFindings = z.object({
  findings: z.array(
    z.object({
      claim: z
        .string()
        .describe("The sentence from the article body, copied verbatim, that carries the claim"),
      sectionName: z.string().describe("The heading of the section the sentence is in"),
      verdict: z.enum(["supported", "contradicted", "unsupported"]),
      factPath: z
        .string()
        .optional()
        .describe("Dotted path into <FACTS> that settles it, e.g. 'teams.T3.pointsFor'"),
    })
  ),
});

const FACT_CHECK_SYSTEM = `You are a fact-checker for a fantasy football desk. You are given a
<FACTS> block and an article body written from it. Report only sentences that state something
factual — a name, number, score, record, rank, pick, transaction, or quote.

- supported: <FACTS> carries it. Give the factPath.
- contradicted: <FACTS> carries something different. Give the factPath.
- unsupported: <FACTS> neither carries nor denies it.

Opinions, predictions, jokes, rhetorical questions and stated uncertainty are not claims — skip them.
Arithmetic on two numbers that are both in <FACTS> is supported. Copy each claim sentence verbatim
from the body. Report nothing you are not sure about; a short list of real findings is the goal.`;

/** The pass is opt-in per deployment and only worth running where the risk sits. */
function shouldRunLlmFactCheck(contentType: string, facts: FactsBlock): boolean {
  if (process.env.FACT_CHECK_LLM !== "1") return false;
  return contentType === "draft_rankings" || contentType === "season_recap" || facts.quotes.length > 0;
}

/* ------------------------------------------------------------------------------------------- *
 * Service
 * ------------------------------------------------------------------------------------------- */

export class ContentGenerationService {
  private modelConfig = {
    primary: "claude-opus-5",
    fallback: "claude-sonnet-5",
    maxRetries: 3,
  };

  async generateContent(request: GenerationRequest, apiKey: string): Promise<GeneratedContent> {
    console.log("=== ContentGenerationService.generateContent START ===");
    console.log("Request:", {
      contentType: request.contentType,
      persona: request.persona,
      hasCustomContext: !!request.customContext,
      commentResponses: request.commentResponses?.length ?? 0,
      nonRespondents: request.nonRespondents?.length ?? 0,
      relationships: request.relationships?.length ?? 0,
    });

    const anthropic = new Anthropic({ apiKey });
    const startTime = Date.now();

    try {
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
      };

      const built = await generatePrompt(promptOptions);
      const { systemPrompt, facts, maxTokens } = built;
      let userPrompt = built.userPrompt;

      // The FACTS ledger is normative; this is only a readable rendering of the same quotes.
      if (request.commentResponses && request.commentResponses.length > 0) {
        userPrompt = enhancePromptWithComments(userPrompt, {
          commentResponses: request.commentResponses,
          nonRespondents: request.nonRespondents ?? [],
          contentType: request.contentType,
          week: request.leagueData.currentWeek,
        });
      }

      const { structuredData, response } = await this.callClaudeStructured(
        anthropic,
        systemPrompt,
        userPrompt,
        maxTokens
      );

      // --- Verification + failure policy -----------------------------------------------------
      let article = structuredData;
      let violations = verifyArticle(article, facts);
      let sectionsRegenerated = 0;

      const sectionNames = new Set(article.sections.map(section => section.name));
      const blockedSections = [
        ...new Set(
          violations
            .filter(v => v.severity === 'block' && v.section && sectionNames.has(v.section))
            .map(v => v.section as string)
        ),
      ];

      if (blockedSections.length > 0) {
        console.warn(`Verifier blocked ${blockedSections.length} section(s); regenerating once`);
        try {
          const rewritten = await this.regenerateSections(
            anthropic,
            systemPrompt,
            facts,
            article,
            blockedSections,
            violations.filter(v => v.severity === 'block'),
            maxTokens
          );
          if (rewritten.length > 0) {
            const droppedQuoteIds = quoteIdsIn(violations.filter(v => v.severity === 'block'));
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
            violations = verifyArticle(article, facts);
          }
        } catch (regenerationError) {
          console.warn("Section regeneration failed; falling through to strip", regenerationError);
        }
      }

      const deterministicBlocks = violations.filter(v => v.severity === 'block').length;
      const deterministicStrips = violations.filter(v => v.severity === 'strip').length;

      if (deterministicBlocks > 0 || deterministicStrips > 0) {
        article = applyStrips(article, violations);
      }

      // --- Optional LLM fact-check pass (spec §8.6) -------------------------------------------
      // Only after a clean deterministic verify, and only where a second opinion is worth 800
      // tokens: the two long-form draft/season pieces, and anything carrying quotes. A failure of
      // the pass itself is logged and ignored — it must never cost the caller an article.
      if (
        deterministicBlocks === 0 &&
        deterministicStrips === 0 &&
        shouldRunLlmFactCheck(request.contentType, facts)
      ) {
        const findings = await this.factCheckWithLlm(anthropic, facts, article);
        if (findings.length > 0) {
          violations = [...violations, ...findings];
          if (findings.some(finding => finding.severity === 'strip')) {
            article = applyStrips(article, findings);
          }
        }
      }

      // --- Assemble -------------------------------------------------------------------------
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

      const metadata: GeneratedContent["metadata"] = {
        week: request.leagueData.currentWeek,
        featuredTeams,
        featuredPlayers,
        tags: this.generateTags(request.contentType, request.persona),
        creditsUsed: contentTemplates[request.contentType]?.creditCost ?? 0,
        generationTime: Date.now() - startTime,
        modelUsed: this.modelConfig.primary,
        promptTokens: response.usage?.input_tokens || 0,
        completionTokens: response.usage?.output_tokens || 0,
        quotes: article.quotes ?? [],
        managerMentions: article.managerMentions ?? [],
        claims: article.claims ?? [],
        reviewFlags: violations,
        factsMissing: facts.missing,
        verifierStats: stats,
      };

      console.log("=== ContentGenerationService.generateContent SUCCESS ===", stats);

      return { title, content, summary, metadata };
    } catch (error) {
      if (error instanceof InsufficientDataError) {
        console.error("Generation refused for lack of data:", error.message);
        throw error;
      }
      console.error("=== ContentGenerationService.generateContent ERROR ===");
      console.error('Content generation failed:', error);
      throw new Error('Failed to generate content. Please try again.');
    }
  }

  private async callClaudeStructured(
    anthropic: Anthropic,
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number
  ): Promise<{ structuredData: GeneratedArticleT; response: AnthropicResponse }> {
    const structuredUserPrompt = `${userPrompt}

OUTPUT CONTRACT
Return one call to the generate_article tool. Requirements:
- sections[].name is the heading a reader sees, written in your voice — never a template field name.
- featuredTeams[].teamId and featuredPlayers[].playerId/fantasyTeamId are ids copied from <FACTS>.
- keyStats[].source is the dotted <FACTS> path the number came from, e.g. "teams.T3.pointsFor".
- quotes[] lists every ledger quote you used, text copied character-for-character from facts.quotes,
  with your in-voice reply to it in writerResponse. Each of those quotes is placed in the body with
  its own ":::quote{id=…}" directive line and is never repeated inside quotation marks.
- managerMentions[] lists every manager you roasted or praised, with the exact sentence as evidence.
- claims[] lists every explicit prediction you made, phrased as you wrote it, with FACTS team ids in
  subjectTeamId/opponentTeamId. If you predicted nothing, claims is an empty array. Do not put
  opinions, grades or descriptions of the present in claims — only statements about what will happen.
- Word counts are ceilings. A shorter accurate section beats a padded one.`;

    const build = (model: string, tokens: number): Anthropic.MessageCreateParamsNonStreaming => ({
      model,
      max_tokens: tokens,
      output_config: { effort: ARTICLE_EFFORT },
      system: systemPrompt,
      messages: [{ role: 'user' as const, content: structuredUserPrompt }],
      tools: [
        {
          name: "generate_article",
          description: "Generate a structured fantasy football article",
          input_schema: { ...zodToJsonSchema(GeneratedArticle), type: 'object' } as const,
        },
      ],
      tool_choice: { type: "tool" as const, name: "generate_article" },
    });

    // Thinking tokens (output_config.effort) count against max_tokens, so a long article can be
    // cut off mid tool call. The API then returns a partial or missing tool_use input, which
    // surfaces as a Zod error on required fields. Retry once with a larger budget before giving up.
    let message = await this.createWithFallback(anthropic, model => build(model, maxTokens));
    if (message.stop_reason === 'max_tokens') {
      const bigger = Math.min(maxTokens * 2, MAX_STRUCTURED_TOKENS);
      console.warn(`Structured output hit max_tokens (${maxTokens}); retrying with ${bigger}`);
      message = await this.createWithFallback(anthropic, model => build(model, bigger));
      if (message.stop_reason === 'max_tokens') {
        throw new Error(
          `Article output exceeded the ${bigger}-token budget twice; shorten the template ceilings`
        );
      }
    }

    let parsed = this.parseArticleToolCall(message);
    if (!parsed.success) {
      console.warn(
        `Structured output unusable on ${message.model} (${parsed.error}); retrying on fallback model`
      );
      message = await anthropic.messages.create(
        build(this.modelConfig.fallback, Math.min(maxTokens * 2, MAX_STRUCTURED_TOKENS))
      );
      parsed = this.parseArticleToolCall(message);
      if (!parsed.success) {
        throw new Error(`No usable structured output received: ${parsed.error}`);
      }
    }

    const structuredData = parsed.data;
    return {
      structuredData,
      response: {
        content: [{ text: JSON.stringify(structuredData) }],
        usage: message.usage
          ? { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens }
          : undefined,
      },
    };
  }

  /**
   * Second opinion from Sonnet 5 after a clean deterministic verify (spec §8.6). `contradicted`
   * strips the sentence and flags it; `unsupported` only warns. Any failure of the pass itself —
   * transport, refusal, malformed output — is logged and swallowed.
   */
  private async factCheckWithLlm(
    anthropic: Anthropic,
    facts: FactsBlock,
    article: GeneratedArticleT
  ): Promise<Violation[]> {
    try {
      const body = article.sections
        .map(section => `## ${section.name}\n${section.content}`)
        .join('\n\n');

      const message = await anthropic.messages.create({
        model: this.modelConfig.fallback,
        max_tokens: 800,
        output_config: { effort: 'low' },
        system: FACT_CHECK_SYSTEM,
        messages: [
          { role: 'user' as const, content: `${serializeFacts(facts)}\n\nARTICLE BODY\n\n${body}` },
        ],
        tools: [
          {
            name: "report_findings",
            description: "Report every factual claim in the body that FACTS does not support",
            input_schema: { ...zodToJsonSchema(FactCheckFindings), type: 'object' } as const,
          },
        ],
        tool_choice: { type: "tool" as const, name: "report_findings" },
      });

      const toolUse = message.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );
      if (!toolUse) return [];

      const sectionNames = new Set(article.sections.map(section => section.name));
      const findings = FactCheckFindings.parse(toolUse.input).findings;

      return findings
        .filter(finding => finding.verdict !== 'supported')
        .map(finding => ({
          kind: finding.verdict === 'contradicted' ? ('llm_contradicted' as const) : ('llm_unsupported' as const),
          detail: `"${finding.claim}"${finding.factPath ? ` (${finding.factPath})` : ''}`,
          section: sectionNames.has(finding.sectionName) ? finding.sectionName : undefined,
          severity: finding.verdict === 'contradicted' ? ('strip' as const) : ('warn' as const),
        }));
    } catch (error) {
      console.warn("LLM fact-check pass failed; keeping the deterministic result", error);
      return [];
    }
  }

  /** Rewrites only the sections a `block` violation landed in, once. */
  private async regenerateSections(
    anthropic: Anthropic,
    systemPrompt: string,
    facts: FactsBlock,
    article: GeneratedArticleT,
    sectionNames: string[],
    blockViolations: Violation[],
    maxTokens: number
  ): Promise<GeneratedArticleT["sections"]> {
    const droppedQuoteIds = quoteIdsIn(blockViolations);
    const surrounding = article.sections
      .filter(section => !sectionNames.includes(section.name))
      .map(section => `## ${section.name}\n${section.content}`)
      .join('\n\n');

    const prompt = `${serializeFacts(facts)}

PRIOR ATTEMPT VIOLATIONS — a fact-checker rejected part of your article. Every item below is a
statement that is not supported by <FACTS>. Rewrite only the listed sections so that none of these
remain. Do not restate the offending claim in softer language; remove it and write what <FACTS>
actually supports.

${blockViolations.map(v => `- [${v.kind}] ${v.section ? `${v.section}: ` : ''}${v.detail}`).join('\n')}

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
      output_config: { effort: ARTICLE_EFFORT },
      system: systemPrompt,
      messages: [{ role: 'user' as const, content: prompt }],
      tools: [
        {
          name: "rewrite_sections",
          description: "Rewrite the listed article sections so they are fully grounded in <FACTS>",
          input_schema: { ...zodToJsonSchema(RegeneratedSections), type: 'object' } as const,
        },
      ],
      tool_choice: { type: "tool" as const, name: "rewrite_sections" },
    });

    let message = await this.createWithFallback(anthropic, model => build(model, maxTokens));
    if (message.stop_reason === 'max_tokens') {
      const bigger = Math.min(maxTokens * 2, MAX_STRUCTURED_TOKENS);
      console.warn(`Section rewrite hit max_tokens (${maxTokens}); retrying with ${bigger}`);
      message = await this.createWithFallback(anthropic, model => build(model, bigger));
      // Still truncated: give up on the rewrite and let the strip policy handle the sections.
      if (message.stop_reason === 'max_tokens') return [];
    }

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
    if (!toolUse) return [];
    const parsed = RegeneratedSections.safeParse(toolUse.input);
    if (!parsed.success) {
      console.warn('Section rewrite returned an unusable tool call; falling back to strip policy');
      return [];
    }
    return parsed.data.sections.filter(section => sectionNames.includes(section.name));
  }

  /** Locate and validate the generate_article tool call, reporting why it is unusable. */
  private parseArticleToolCall(
    message: Anthropic.Message
  ): { success: true; data: GeneratedArticleT } | { success: false; error: string } {
    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
    if (!toolUse) {
      return { success: false, error: `no tool_use block (stop_reason ${message.stop_reason})` };
    }
    const result = GeneratedArticle.safeParse(toolUse.input);
    if (!result.success) {
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
    return { success: true, data: result.data };
  }

  /**
   * Runs a request on the primary model, retrying on the fallback for transport failures and for
   * safety refusals. Never sends temperature — Claude 5-family models reject sampling params.
   */
  private async createWithFallback(
    anthropic: Anthropic,
    build: (model: string) => Anthropic.MessageCreateParamsNonStreaming
  ): Promise<Anthropic.Message> {
    let message: Anthropic.Message;
    try {
      message = await anthropic.messages.create(build(this.modelConfig.primary));
    } catch (error: unknown) {
      if (!shouldFallback(error)) {
        console.error("Claude API call failed:", error);
        throw error;
      }
      console.warn('Primary model failed, trying fallback...');
      message = await anthropic.messages.create(build(this.modelConfig.fallback));
    }

    if (message.stop_reason === 'refusal') {
      console.warn(
        `Primary model refused (category: ${message.stop_details?.category ?? 'unknown'}), trying fallback...`
      );
      message = await anthropic.messages.create(build(this.modelConfig.fallback));
      if (message.stop_reason === 'refusal') {
        throw new Error(
          `Content generation was refused by the model (category: ${message.stop_details?.category ?? 'unknown'})`
        );
      }
    }

    return message;
  }

  private generateTags(contentType: string, persona: string): string[] {
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
