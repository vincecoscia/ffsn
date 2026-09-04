"use node";

/**
 * Node-runtime boundary for third-party AI SDK calls.
 *
 * The Anthropic SDK (0.8x and later) dynamically imports `node:fs` / `node:path` for its
 * credential-profile resolution, which Convex's default isolate runtime cannot bundle. Every
 * other Convex module must therefore reach the Anthropic and OpenAI SDKs through these
 * internal actions (`ctx.runAction(internal.aiNode.*)`) instead of importing
 * `src/lib/ai/content-generation-service`, `conversation-service`, or `image-generator`
 * directly. Keep this file actions-only; "use node" files cannot export queries or mutations.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  commentResponseDataValidator,
  languageRatingValidator,
  nonRespondentValidator,
  priorClaimValidator,
  priorRecordValidator,
  writerRelationshipContextValidator,
} from "./validators";
import {
  contentGenerationService,
  type GeneratedContent,
  type GenerationRequest,
} from "../src/lib/ai/content-generation-service";
import {
  conversationService,
  type AIConversationResult,
  type ConversationContext,
} from "../src/lib/ai/conversation-service";
import { generateArticleImage, shouldGenerateImage } from "../src/lib/ai/image-generator";
import { requireEnv, toConvexValue } from "./lib/nodeHelpers";

type ResponseAnalysis = Awaited<ReturnType<typeof conversationService.analyzeUserResponse>>;

/**
 * Generate a full article with the persona-driven content service.
 *
 * The request is validated field by field (spec section 4.2) so a caller cannot
 * quietly drop `commentResponses`, `relationships` or `priorClaims`. `leagueData`
 * stays `v.any()`: it is the large, loosely-typed payload from `aiQueries.ts`,
 * typed on the TypeScript side as `LeagueDataContext`.
 */
export const generateArticle = internalAction({
  args: {
    request: v.object({
      leagueId: v.id("leagues"),
      contentType: v.string(),
      persona: v.string(),
      leagueData: v.any(),
      customContext: v.optional(v.string()),
      userId: v.string(),
      // The week the article covers (a preview is about the week after leagueData.currentWeek).
      week: v.optional(v.number()),
      commentResponses: v.optional(v.array(commentResponseDataValidator)),
      nonRespondents: v.optional(v.array(nonRespondentValidator)),
      relationships: v.optional(v.array(writerRelationshipContextValidator)),
      priorClaims: v.optional(v.array(priorClaimValidator)),
      // The writer's standing record on those claims (spec §8.4).
      priorRecord: v.optional(priorRecordValidator),
      // League-level language rating + per-manager opt-down (owner ask, Sept 2026); pass-through
      // only - the prompt layer applies these, this action just forwards them.
      languageRating: v.optional(languageRatingValidator),
      cleanTeamNames: v.optional(v.array(v.string())),
    }),
  },
  handler: async (_ctx, args): Promise<GeneratedContent> => {
    const request = args.request as GenerationRequest;
    const result = await contentGenerationService.generateContent(
      request,
      requireEnv("ANTHROPIC_API_KEY")
    );
    return toConvexValue(result);
  },
});

/** Ask the AI interviewer for the next question in a comment-request conversation. */
export const generateConversationQuestion = internalAction({
  args: { context: v.any() },
  handler: async (_ctx, args): Promise<AIConversationResult> => {
    const context = args.context as ConversationContext;
    const result = await conversationService.generateConversationQuestion(
      context,
      requireEnv("ANTHROPIC_API_KEY")
    );
    return toConvexValue(result);
  },
});

/** Score and extract quotable segments from a manager's reply. */
export const analyzeUserResponse = internalAction({
  args: { userResponse: v.string(), context: v.any() },
  handler: async (_ctx, args): Promise<ResponseAnalysis> => {
    const context = args.context as ConversationContext;
    const result = await conversationService.analyzeUserResponse(
      args.userResponse,
      context,
      requireEnv("ANTHROPIC_API_KEY")
    );
    return toConvexValue(result);
  },
});

/**
 * Generate and store a banner image for an article. Returns the storage id, or null when the
 * content type is not image-eligible or OPENAI_API_KEY is not configured.
 */
export const generateBannerImage = internalAction({
  args: {
    title: v.string(),
    contentType: v.string(),
    persona: v.optional(v.string()),
    metadata: v.optional(
      v.object({
        week: v.optional(v.number()),
        featuredTeams: v.optional(v.array(v.string())),
        featuredPlayers: v.optional(v.array(v.string())),
      })
    ),
  },
  handler: async (ctx, args): Promise<Id<"_storage"> | null> => {
    if (!shouldGenerateImage(args.contentType)) {
      return null;
    }
    const openAIKey = process.env.OPENAI_API_KEY;
    if (!openAIKey) {
      console.warn(
        'OPENAI_API_KEY not configured, skipping banner image. Enable with: npx convex env set OPENAI_API_KEY "..."'
      );
      return null;
    }
    const imageBlob = await generateArticleImage(
      {
        title: args.title,
        contentType: args.contentType,
        metadata: args.metadata,
        persona: args.persona,
      },
      openAIKey
    );
    return await ctx.storage.store(imageBlob);
  },
});
