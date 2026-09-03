"use node";

/**
 * Node-runtime action that produces one "Disputed" episode end to end (see `src/lib/ai/disputed/`
 * for the pure producer this wraps): pulls the league's data and every writer's relationship
 * ledger, hands them to the producer with a real Anthropic-backed turn caller, and — unless
 * `dryRun` — saves the result as a draft `aiContent` row.
 *
 * "use node" because it calls the Anthropic SDK (through
 * `src/lib/ai/disputed/anthropic-caller.ts`) directly, same reason `convex/aiNode.ts` is split out
 * from the default-runtime Convex modules; a "use node" file cannot also export queries or
 * mutations, so `convex/disputed.ts` holds those.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ACTIVE_WRITERS } from "./relationships";
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";
import type { WriterRelationshipContext } from "../src/lib/ai/content-generation-service";
import { buildFactsBlock, serializeFacts } from "../src/lib/ai/facts";
import {
  chooseHotSeat,
  createAnthropicTurnCaller,
  fallbackQuestionFor,
  produceEpisode as produceShowEpisode,
  renderTranscriptMarkdown,
  type ShowBrief,
  type ShowTranscript,
  type ShowTurn,
} from "../src/lib/ai/disputed";

/** Same convention as convex/aiNode.ts's own private `requireEnv` (that file may not be edited here). */
function requireEnv(name: "ANTHROPIC_API_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} not configured. Set it with: npx convex env set ${name} "..."`);
  }
  return value;
}

/** Strip `undefined` (not a Convex value) before a result crosses the runtime boundary — same helper as convex/aiNode.ts. */
function toConvexValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `showTurnValidator`'s shape (convex/validators.ts): drops `managerMentions` / `claim`, which are
 * extracted once per episode onto the article's own `managerMentions` / `claims` fields instead.
 */
function toStoredTurn(turn: ShowTurn) {
  return {
    speaker: turn.speaker,
    kind: turn.kind,
    text: turn.text,
    jab: turn.jab,
    factsCited: turn.factsCited,
    witnessRequested: turn.witnessRequested,
    agreesWithOpponent: turn.agreesWithOpponent,
    verdict: turn.verdict,
    model: turn.model,
    retried: turn.retried,
  };
}

function toStoredTranscript(transcript: ShowTranscript) {
  return {
    schema: transcript.schema,
    show: transcript.show,
    week: transcript.week,
    question: transcript.question,
    hotSeat: transcript.hotSeat,
    sides: transcript.sides,
    segments: transcript.segments.map((segment) => ({
      id: segment.id,
      title: segment.title,
      turns: segment.turns.map(toStoredTurn),
    })),
  };
}

export const produceEpisode = internalAction({
  args: {
    leagueId: v.id("leagues"),
    asOf: v.optional(
      v.object({ seasonId: v.number(), week: v.number(), rosterWeek: v.optional(v.number()) })
    ),
    // Defaults TRUE: the safe default for a pilot run. Nothing is written to the deployment
    // unless a caller explicitly asks for it.
    dryRun: v.optional(v.boolean()),
    budgets: v.optional(
      v.object({
        mainEvent: v.optional(v.number()),
        heatThreshold: v.optional(v.number()),
        maxWitnessCalls: v.optional(v.number()),
      })
    ),
  },
  returns: v.object({
    articleId: v.optional(v.id("aiContent")),
    question: v.string(),
    hotSeat: v.object({ teamId: v.string(), managerName: v.string(), why: v.string() }),
    markdown: v.string(),
    stats: v.any(),
    turns: v.number(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    articleId?: Id<"aiContent">;
    question: string;
    hotSeat: { teamId: string; managerName: string; why: string };
    markdown: string;
    stats: unknown;
    turns: number;
  }> => {
    const dryRun = args.dryRun ?? true;
    const startedAt = Date.now();

    // 1. This league's data, exactly as an ordinary article generation reads it.
    const leagueData: LeagueDataContext = await ctx.runQuery(
      internal.aiContent.getLeagueDataForGenerationInternal,
      { leagueId: args.leagueId, asOf: args.asOf }
    );

    // 2. Every active writer's own relationship reading of every manager — the show needs the
    // whole desk's spread, not one writer's slice of it (spec: Disputed hot-seat selection).
    const relationshipsByWriter: Record<string, WriterRelationshipContext[]> = {};
    for (const slug of ACTIVE_WRITERS) {
      relationshipsByWriter[slug] = await ctx.runQuery(
        internal.relationships.getRelationshipsForWriter,
        { leagueId: args.leagueId, persona: slug }
      );
    }

    // 3. The two debaters' own season ledgers, read for the "season ledger" Curtis reads on air.
    const [melLedger, reggieLedger] = await Promise.all([
      ctx.runQuery(internal.claims.getPriorClaimsForWriter, {
        leagueId: args.leagueId,
        persona: "mel-diaper",
      }),
      ctx.runQuery(internal.claims.getPriorClaimsForWriter, {
        leagueId: args.leagueId,
        persona: "reggie-banks",
      }),
    ]);

    // 4. Recent on-record manager quotes the show can call witnesses in against.
    const commentResponses = await ctx.runQuery(internal.disputed.getRecentQuotesForShow, {
      leagueId: args.leagueId,
    });

    // 5. FACTS — the same grounding block an article would get, built for the show's own persona.
    const facts = buildFactsBlock({
      leagueId: args.leagueId,
      contentType: "desk_show",
      persona: "curtis-vaughn",
      leagueData,
      commentResponses,
      nonRespondents: [],
      relationships: [],
      priorClaims: [],
    });
    const factsText = serializeFacts(facts);

    // 6. Who this week's episode is about. No standings/matchups and no relationship spread means
    // there is nothing to build an episode from at all.
    const hotSeat = chooseHotSeat(facts, relationshipsByWriter);
    if (!hotSeat) {
      throw new Error("Disputed needs standings and matchups for this week");
    }

    // 7. The producer's brief.
    const brief: ShowBrief = {
      week: leagueData.currentWeek,
      hotSeat,
      fallbackQuestion: fallbackQuestionFor(hotSeat),
      ledger: {
        "mel-diaper": { hits: melLedger.record.hits, misses: melLedger.record.misses },
        "reggie-banks": { hits: reggieLedger.record.hits, misses: reggieLedger.record.misses },
      },
    };

    // A draft row is only ever created once real content is ready to fill it (step 11 below) —
    // there is nothing to show for a dry run, and nothing to hold a "generating" placeholder for.
    let articleId: Id<"aiContent"> | undefined;

    try {
      // 8. Produce the episode, turn by turn, against the real Anthropic API.
      const result = await produceShowEpisode({
        facts,
        factsText,
        brief,
        relationshipsByWriter,
        call: createAnthropicTurnCaller(requireEnv("ANTHROPIC_API_KEY")),
        options: args.budgets ? { budgets: args.budgets } : undefined,
      });

      // 9. The plain rendering `content` will hold.
      const markdown = renderTranscriptMarkdown(result.transcript);

      // 10. Dry run (the default): return without writing anything to the deployment.
      if (dryRun) {
        return {
          articleId: undefined,
          question: result.transcript.question,
          hotSeat,
          markdown,
          stats: result.stats,
          turns: result.stats.turns,
        };
      }

      // 11. Write the draft row. Never finalized, never published, never notified — it stays a
      // draft for a human to read, same as the pilot script's own output.
      articleId = await ctx.runMutation(internal.disputed.createShowDraft, {
        leagueId: args.leagueId,
        week: leagueData.currentWeek,
        seasonId: leagueData.currentSeason,
        title: `Disputed · Week ${leagueData.currentWeek ?? "?"}`,
      });

      const reviewFlags = result.stats.violations.map((violation) => ({
        kind: violation.kind,
        detail: `${violation.speaker}: ${violation.detail}`,
        severity: violation.severity as "block" | "strip" | "warn",
      }));

      await ctx.runMutation(
        internal.aiContent.updateGeneratedContent,
        toConvexValue({
          articleId,
          title: `Disputed · Week ${leagueData.currentWeek ?? "?"}`,
          content: markdown,
          summary: result.transcript.question,
          metadata: {
            week: leagueData.currentWeek,
            featuredTeams: [],
            featuredPlayers: [],
            tags: [],
            creditsUsed: 0,
            generationTime: Date.now() - startedAt,
            modelUsed: result.stats.modelsUsed.join(","),
            promptTokens: result.stats.promptTokens,
            completionTokens: result.stats.completionTokens,
            costUsd: result.stats.costUsd,
            quotes: [],
            managerMentions: result.managerMentions,
            reviewFlags,
            factsMissing: facts.missing,
            verifierStats: {
              blocks: result.stats.violations.filter((violation) => violation.severity === "block").length,
              strips: result.stats.violations.filter((violation) => violation.severity === "strip").length,
              warns: result.stats.violations.filter((violation) => violation.severity === "warn").length,
              sectionsRegenerated: 0,
            },
            claims: result.claims,
            transcript: toStoredTranscript(result.transcript),
            seasonId: leagueData.currentSeason,
          },
          billing: "pass" as const,
        })
      );

      await ctx.runMutation(internal.relationships.recordArticleMentions, { articleId });

      return {
        articleId,
        question: result.transcript.question,
        hotSeat,
        markdown,
        stats: result.stats,
        turns: result.stats.turns,
      };
    } catch (error) {
      // Only a draft row that actually got created needs closing out — a failure before step 11
      // (the model call itself, or a missing hot seat above) never created one.
      if (articleId) {
        const message = error instanceof Error ? error.message : "Disputed production failed";
        await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
          articleId,
          status: "failed",
          error: message,
        });
      }
      throw error;
    }
  },
});
