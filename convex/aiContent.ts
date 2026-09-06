/* eslint-disable @typescript-eslint/no-explicit-any */
import { query, mutation, action, internalQuery, internalMutation, internalAction, MutationCtx } from "./_generated/server";
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import schema, { editorReviewValidator } from "./schema";
import { contentTemplates } from "../src/lib/ai/content-templates";
// The publish gate (spec §11.2.9). A pure, SDK-free module owned by the prompt
// layer, so Convex and the generator apply the same rule rather than two copies
// of it.
import { shouldPublish, type EditorPassResult } from "../src/lib/ai/publish-gate";
import {
  WIRE_STATEMENT_EXCLUDED_CONTENT_TYPES,
  WIRE_STATEMENT_QUOTABLE_MS,
} from "../src/lib/ai/wire/types";

/** The editor pass exactly as it is stored on `aiContent.generationStats.editor`. */
export type StoredEditorReview = Infer<typeof editorReviewValidator>;
import { creditCostFor } from "./credits";
// Type-only: never a value import from src/lib/ai in a non-Node Convex file.
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";
import { getLeagueMembership, requireCommissioner } from "./lib/auth";
import {
  articleQuoteValidator,
  commentResponseDataValidator,
  generatedClaimValidator,
  managerMentionValidator,
  nonRespondentValidator,
  reviewFlagValidator,
  showTranscriptValidator,
  verifierStatsValidator,
} from "./validators";
import { leagueCurrentSeason } from "./lib/season";
import {
  handleGenerationFailure,
  isInsufficientDataError,
} from "./lib/generationFailure";
import { espnConnectionBlocked, FRESHNESS_EXEMPT_CONTENT } from "./lib/espnConnection";

/**
 * Manual generation's half of the ESPN connection gate (owner directive,
 * Sept 2026): a private league whose stored cookies ESPN rejects cannot have
 * its data refreshed, so the desk cannot write a fresh (non-exempt) article
 * about it - refuse before any credit is spent. Throws rather than returning
 * so every caller mutation stops before `credits.deductCredits`.
 */
function assertEspnConnectionNotBlocked(
  league: { espnData?: { isPrivate?: boolean; credentialStatus?: string } | null } | null,
  contentType: string,
): void {
  if (FRESHNESS_EXEMPT_CONTENT.has(contentType)) return;
  if (!espnConnectionBlocked(league)) return;
  throw new Error(
    "ESPN_CONNECTION_BROKEN: ESPN rejected this league's cookies, so the desk can't read fresh data. " +
      "Ask your commissioner to fix the ESPN connection in League settings.",
  );
}

export const getByLeague = query({
  args: { 
    leagueId: v.id("leagues"),
    paginationOpts: v.optional(v.object({
      numItems: v.number(),
      cursor: v.union(v.string(), v.null())
    }))
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { page: [], continueCursor: null, isDone: true };
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return { page: [], continueCursor: null, isDone: true };
    }

    // Use pagination if provided, otherwise return first 3 items
    const numItems = args.paginationOpts?.numItems || 3;
    const cursor = args.paginationOpts?.cursor || null;

    const result = await ctx.db
      .query("aiContent")
      .withIndex("by_league_published", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("status"), "published"))
      .order("desc")
      .paginate({ numItems, cursor });

    // Add banner image URLs to each article
    const pageWithImages = await Promise.all(
      result.page.map(async (article) => {
        let bannerImageUrl = null;
        if (article.bannerImageId) {
          bannerImageUrl = await ctx.storage.getUrl(article.bannerImageId);
        }
        return {
          ...article,
          bannerImageUrl,
        };
      })
    );

    return {
      ...result,
      page: pageWithImages,
    };
  },
});

// New query for article management - returns all articles regardless of status
export const getAllByLeague = query({
  args: { 
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    // Get all articles for this league, ordered by creation date (newest first)
    const articles = await ctx.db
      .query("aiContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .collect();

    return articles;
  },
});
export const getById = query({
  args: {
    articleId: v.id("aiContent"),
  },
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) return null;

    // /articles/[id] is a public page (no login) for published articles, same
    // reason leagues.getPublicInfo exists, so a published article is readable
    // by anyone. Anything else (draft, generating, waiting_for_comments,
    // failed, etc.) is only visible to members of the owning league.
    if (article.status !== "published") {
      const membership = await getLeagueMembership(ctx, article.leagueId);
      if (!membership) {
        return null;
      }
    }

    // Add banner image URL if available
    let bannerImageUrl = null;
    if (article.bannerImageId) {
      bannerImageUrl = await ctx.storage.getUrl(article.bannerImageId);
    }

    return {
      ...article,
      bannerImageUrl,
    };
  },
});
export const getMostRecentWithImage = query({
  args: {
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return null;
    }

    // Get the most recent published article with a banner image
    const article = await ctx.db
      .query("aiContent")
      .withIndex("by_league_published", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => 
        q.and(
          q.eq(q.field("status"), "published"),
          q.neq(q.field("bannerImageId"), undefined)
        )
      )
      .order("desc")
      .first();

    if (!article || !article.bannerImageId) {
      return null;
    }

    // Get the banner image URL
    const bannerImageUrl = await ctx.storage.getUrl(article.bannerImageId);

    return {
      ...article,
      bannerImageUrl,
    };
  },
});

export const createGenerationRequest = mutation({
  args: {
    leagueId: v.id("leagues"),
    type: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    tradeRumorData: v.optional(v.object({
      rumorType: v.union(v.literal("my_trade"), v.literal("other_offer")),
      targetTeamId: v.optional(v.id("teams")),
      playersInvolved: v.array(v.string()), // Player IDs as strings from roster
      additionalContext: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      throw new Error("Not a member of this league");
    }

    // Check if user is commissioner for commissioner-only content
    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      throw new Error("League not found");
    }

    // ESPN connection gate (owner directive, Sept 2026). Before any credit
    // is touched: a blocked, non-exempt type cannot produce a trustworthy
    // article right now.
    assertEspnConnectionNotBlocked(league, args.type);

    // Get template to check credit cost
    const template = contentTemplates[args.type];
    if (!template) {
      const availableTypes = Object.keys(contentTemplates).join(', ');
      throw new Error(`Invalid content type: "${args.type}". Available types: ${availableTypes}`);
    }

    // Show-kind templates (spec: Disputed) are produced turn-by-turn by the desk show
    // producer (disputedNode.produceEpisode), not by this single-writer article pipeline.
    // Refuse before any credit is touched.
    if (template.kind === "show") {
      throw new Error("Disputed is produced by the desk show producer, not the article generator");
    }

    // What this generation costs its requester (spec §10.1). No managers are
    // asked for comment on this path, so it is the template price alone.
    const creditCost = creditCostFor(args.type);

    // Check if user has sufficient credits before scheduling any generation
    // work (mirrors regenerateContentWithCredits below).
    const userCredits = await ctx.runQuery(internal.credits.checkSufficientCredits, {
      userId: identity.subject,
      requiredAmount: creditCost,
    });

    if (!userCredits.hasSufficientCredits) {
      throw new Error(`Insufficient credits. Required: ${creditCost}, Available: ${userCredits.currentBalance}`);
    }

    // Deduct credits up front, before scheduling generation, so concurrent
    // requests can't spend more than the user's balance allows.
    await ctx.runMutation(internal.credits.deductCredits, {
      userId: identity.subject,
      amount: creditCost,
      description: `AI content generation: ${args.type}`,
      leagueId: args.leagueId,
    });

    // Create a generation request in "generating" status
    const articleId = await ctx.db.insert("aiContent", {
      leagueId: args.leagueId,
      type: args.type,
      persona: args.persona,
      title: "Generating...",
      content: "",
      metadata: {
        week: 1, // Will be updated
        featured_teams: [],
        credits_used: creditCost,
      },
      status: "generating",
      createdAt: Date.now(),
    });

    // Schedule the actual generation. creditsDeductedUpFront tells
    // generateContentAction the cost was already taken above, so on failure
    // it refunds instead of trying to deduct again post-generation.
    await ctx.scheduler.runAfter(0, internal.aiContent.generateContentAction, {
      articleId,
      leagueId: args.leagueId,
      contentType: args.type,
      persona: args.persona,
      customContext: args.customContext,
      userId: identity.subject,
      seasonId: args.seasonId,
      week: args.week,
      tradeRumorData: args.tradeRumorData,
      creditsDeductedUpFront: creditCost,
    });

    return articleId;
  },
});

// Create content generation with comment requests
export const createGenerationWithComments = mutation({
  args: {
    leagueId: v.id("leagues"),
    type: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    requestComments: v.boolean(),
    articleGenerationTime: v.number(), // Unix timestamp of when to generate the article
    targetUserIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      throw new Error("Not a member of this league");
    }

    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      throw new Error("League not found");
    }

    // ESPN connection gate (owner directive, Sept 2026). Before any credit
    // is touched: a blocked, non-exempt type cannot produce a trustworthy
    // article right now, and interviewing managers for one is worse.
    assertEspnConnectionNotBlocked(league, args.type);

    // Get template to check credit cost
    const template = contentTemplates[args.type];
    if (!template) {
      const availableTypes = Object.keys(contentTemplates).join(', ');
      throw new Error(`Invalid content type: "${args.type}". Available types: ${availableTypes}`);
    }

    // The template price plus 5 credits per manager asked for comment
    // (spec §10.1): every interview is a real, billed round trip through Sam,
    // and this path is the only one that buys them.
    const creditCost = creditCostFor(args.type, args.requestComments ? args.targetUserIds.length : 0);

    // Check if user has sufficient credits before scheduling any generation
    // work (mirrors createGenerationRequest above).
    const userCredits = await ctx.runQuery(internal.credits.checkSufficientCredits, {
      userId: identity.subject,
      requiredAmount: creditCost,
    });

    if (!userCredits.hasSufficientCredits) {
      throw new Error(`Insufficient credits. Required: ${creditCost}, Available: ${userCredits.currentBalance}`);
    }

    // Deduct credits up front, before scheduling comment collection /
    // generation, so concurrent requests can't spend more than the user's
    // balance allows.
    await ctx.runMutation(internal.credits.deductCredits, {
      userId: identity.subject,
      amount: creditCost,
      description: `AI content generation with comments: ${args.type} (${args.targetUserIds.length} asked)`,
      leagueId: args.leagueId,
    });

    // Create a generation request in "waiting_for_comments" status
    const articleId = await ctx.db.insert("aiContent", {
      leagueId: args.leagueId,
      type: args.type,
      persona: args.persona,
      title: "Waiting for team comments...",
      content: "",
      metadata: {
        week: args.week || 1,
        featured_teams: [],
        credits_used: creditCost,
      },
      status: "waiting_for_comments",
      createdAt: Date.now(),
      commentRequestConfig: {
        enabled: true,
        articleGenerationTime: args.articleGenerationTime,
        targetUserIds: args.targetUserIds,
        requestedAt: Date.now(),
        // Everything the deadline run needs, so aiContentWithComments.goToPrintNow
        // can start checkAndGenerate early without re-supplying (or trusting) any
        // of it from the client (spec §8.2). `userId` is also the requester half
        // of that mutation's authorization check.
        userId: identity.subject,
        customContext: args.customContext,
        seasonId: args.seasonId,
        week: args.week,
        creditsDeductedUpFront: creditCost,
      },
    });

    // Schedule comment request creation and waiting logic.
    // creditsDeductedUpFront tells the chain (createCommentRequestsAndWait ->
    // checkAndGenerate/checkIfAllResponsesReceived -> generateWithComments ->
    // generateContentAction) the cost was already taken above, so a failure
    // anywhere along the way refunds instead of deducting again.
    await ctx.scheduler.runAfter(0, internal.aiContentWithComments.createCommentRequestsAndWait, {
      articleId,
      leagueId: args.leagueId,
      contentType: args.type,
      persona: args.persona,
      customContext: args.customContext,
      userId: identity.subject,
      seasonId: args.seasonId,
      week: args.week,
      targetUserIds: args.targetUserIds,
      articleGenerationTime: args.articleGenerationTime,
      creditsDeductedUpFront: creditCost,
    });

    return articleId;
  },
});

// Mutation to regenerate content using user credits
export const regenerateContentWithCredits = mutation({
  args: {
    leagueId: v.id("leagues"),
    type: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      throw new Error("Not a member of this league");
    }

    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      throw new Error("League not found");
    }

    // ESPN connection gate (owner directive, Sept 2026). Before any credit
    // is touched: a blocked, non-exempt type cannot produce a trustworthy
    // article right now.
    assertEspnConnectionNotBlocked(league, args.type);

    // Get template to check credit cost
    const template = contentTemplates[args.type];
    if (!template) {
      const availableTypes = Object.keys(contentTemplates).join(', ');
      throw new Error(`Invalid content type: "${args.type}". Available types: ${availableTypes}`);
    }

    const creditCost = creditCostFor(args.type);

    // Check if user has sufficient credits
    const userCredits = await ctx.runQuery(internal.credits.checkSufficientCredits, {
      userId: identity.subject,
      requiredAmount: creditCost,
    });

    if (!userCredits.hasSufficientCredits) {
      throw new Error(`Insufficient credits. Required: ${creditCost}, Available: ${userCredits.currentBalance}`);
    }

    // Deduct credits first
    await ctx.runMutation(internal.credits.deductCredits, {
      userId: identity.subject,
      amount: creditCost,
      description: `Manual ${args.type} content generation`,
      leagueId: args.leagueId,
    });

    // Create a generation request in "generating" status
    const articleId = await ctx.db.insert("aiContent", {
      leagueId: args.leagueId,
      type: args.type,
      persona: args.persona,
      title: "Generating...",
      content: "",
      metadata: {
        week: 1, // Will be updated
        featured_teams: [],
        credits_used: creditCost,
      },
      status: "generating",
      createdAt: Date.now(),
    });

    // Schedule the actual generation. creditsDeductedUpFront tells
    // generateContentAction the cost was already taken above, so on failure
    // it refunds instead of deducting again post-generation (previously this
    // flow double-charged: once here, then again inside generateContentAction).
    await ctx.scheduler.runAfter(0, internal.aiContent.generateContentAction, {
      articleId,
      leagueId: args.leagueId,
      contentType: args.type,
      persona: args.persona,
      customContext: args.customContext,
      userId: identity.subject,
      seasonId: args.seasonId,
      week: args.week,
      creditsDeductedUpFront: creditCost,
    });

    return articleId;
  },
});

/**
 * Season backfill (convex/seasonBackfill.ts): types printed AHEAD of the week they cover - a
 * weekly_preview for week N runs Thursday of week N, a playoff_picture for week N runs Thursday of
 * week N too - so both are written off week N-1's results, same as the live cron already does via
 * `resolveTargetWeek`'s FORWARD-vs-lookback split in `convex/contentScheduling.ts`.
 */
const FORWARD_LOOKING_CONTENT = new Set(["weekly_preview", "playoff_picture"]);

// Internal action to handle the actual AI generation
export const generateContentAction = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    scheduledContentId: v.optional(v.id("scheduledContent")),
    tradeRumorData: v.optional(v.object({
      rumorType: v.union(v.literal("my_trade"), v.literal("other_offer")),
      targetTeamId: v.optional(v.id("teams")),
      playersInvolved: v.array(v.string()), // Player IDs as strings from roster
      additionalContext: v.optional(v.string()),
    })),
    // Set by callers that already deducted credits before scheduling this
    // action (createGenerationRequest, regenerateContentWithCredits,
    // processLeaguePayment's auto season_welcome generation) to the amount
    // deducted. When set, this action refunds that amount on failure instead
    // of charging again. Automated content never sets it: the League Pass
    // covers those outright (spec §10.1), so nothing is deducted and there is
    // nothing to refund.
    creditsDeductedUpFront: v.optional(v.number()),
    // Interview material from the comment flow (spec section 5). Built by
    // aiContentWithComments.generateWithComments and passed straight through to
    // the writer instead of being pasted into customContext.
    commentResponses: v.optional(v.array(commentResponseDataValidator)),
    nonRespondents: v.optional(v.array(nonRespondentValidator)),
    // Which attempt this is (spec section 9.2.5). Absent/0 on the first run;
    // retryFailedGeneration passes the incremented count so the retry loop is
    // actually capped instead of restarting from one every time.
    retryCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("=== generateContentAction START (OPTIMIZED) ===");
    console.log("Content type:", args.contentType);
    console.log("Persona:", args.persona);

    // Who is paying (spec §10.1). Automated content - a cron row, an event
    // trigger, anything arriving as userId "system" - is covered by the
    // League Pass and deducts nothing. This used to charge the commissioner
    // per story before the model call; the pass is what replaced that bill,
    // and `contentScheduling.processScheduledContent` has already checked the
    // pass is live and that the league is under its season spend cap.
    //
    // Everything else is a real person spending their own credits, which the
    // calling mutation already took up front.
    const isAutomated = args.userId === "system" || args.scheduledContentId !== undefined;
    const billing: "pass" | "credits" = isAutomated ? "pass" : "credits";
    const creditsDeductedUpFront = isAutomated ? undefined : args.creditsDeductedUpFront;

    try {
      // For mock drafts, weekly recaps, draft rankings, and season welcome, use the scheduled data-prep approach
      if (args.contentType === 'mock_draft' || args.contentType === 'weekly_recap' || args.contentType === 'season_welcome' || args.contentType === 'draft_rankings') {
        console.log(`Using scheduled approach for ${args.contentType} generation`);
        
        // Schedule data preparation step (which will chain the generation step).
        // creditsDeductedUpFront is forwarded so a failure anywhere in the
        // prepareAIContentData -> generateAIContentWithData chain refunds the
        // amount this action's caller already deducted, instead of losing
        // track of it.
        await ctx.scheduler.runAfter(0, internal.aiContentHelpers.prepareAIContentData, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          seasonId: args.seasonId,
          week: args.week,
          scheduledContentId: args.scheduledContentId,
          creditsDeductedUpFront,
          commentResponses: args.commentResponses,
          nonRespondents: args.nonRespondents,
          retryCount: args.retryCount,
        });
        
        console.log(`${args.contentType} generation scheduled successfully`);
        return;
      }
      
      // For other content types, use the existing approach
      console.log("Using standard approach for content type:", args.contentType);

      // Season backfill (owner directive, Sept 2026): a row about a season BEFORE the league's
      // current one is written as of the period it actually covers, not live data - otherwise a
      // "2025 week 5" article would read 2026's in-progress standings. Current-season rows (the
      // ordinary case) keep the untouched live path: `asOf` stays undefined.
      let asOf: { seasonId: number; week: number; rosterWeek?: number } | undefined;
      if (args.seasonId !== undefined && args.week !== undefined) {
        const league = await ctx.runQuery(internal.contentScheduling.getLeagueById, {
          leagueId: args.leagueId,
        });
        if (args.seasonId < leagueCurrentSeason(league)) {
          const asOfWeek = FORWARD_LOOKING_CONTENT.has(args.contentType) ? args.week - 1 : args.week;
          // The roster a forward-looking piece describes is the one heading INTO its week (a week-5
          // preview talks about week-5 lineups, waiver adds included); results still stop at asOfWeek.
          asOf = { seasonId: args.seasonId, week: asOfWeek, rosterWeek: args.week };
        }
      }

      const leagueData = await ctx.runQuery(internal.aiContent.getLeagueDataForGenerationInternal, {
        leagueId: args.leagueId,
        asOf,
      });

      console.log("League data fetched successfully");

      // The trade-rumor enrichment below predates the typed context and reaches
      // for fields LeagueDataContext does not model (espnId, standing), so it
      // works through a deliberately widened view of the same object.
      const legacyLeagueData = leagueData as unknown as { teams: any[] };
      
      console.log("Calling AI generation service...");
      
      // Enrich trade rumor data if present
      let enrichedCustomContext = args.customContext;
      
      console.log("Trade rumor data check:", {
        hasTradeRumorData: !!args.tradeRumorData,
        contentType: args.contentType,
        playersInvolved: args.tradeRumorData?.playersInvolved || []
      });
      
      if (args.tradeRumorData && args.contentType === 'trade_rumor_mill') {
        console.log("Enriching trade rumor data...");
        
        // Get the full player data for the involved players
        console.log("Processing players:", args.tradeRumorData.playersInvolved);
        console.log("Number of teams to search:", legacyLeagueData.teams.length);
        
        // Debug: Log first team's roster structure
        if (legacyLeagueData.teams.length > 0 && legacyLeagueData.teams[0].roster?.length > 0) {
          const samplePlayer = legacyLeagueData.teams[0].roster[0];
          console.log("Sample roster player structure:", {
            playerId: samplePlayer.playerId,
            espnId: samplePlayer.espnId,
            playerName: samplePlayer.playerName || samplePlayer.fullName,
            keys: Object.keys(samplePlayer).slice(0, 10) // First 10 keys
          });
        }
        
        const enrichedPlayers = await Promise.all(
          args.tradeRumorData.playersInvolved.map(async (playerId) => {
            console.log(`\n=== Looking for player with ID: "${playerId}" (type: ${typeof playerId}) ===`);
            
            // Find the player in the league data
            for (const team of legacyLeagueData.teams) {
              if (team.roster && Array.isArray(team.roster)) {
                // Convert playerId to string for consistent comparison
                const targetId = String(playerId).trim();
                
                const player = team.roster.find((p: any) => {
                  // Convert all IDs to strings for comparison
                  const pPlayerId = p.playerId ? String(p.playerId).trim() : '';
                  const pEspnId = p.espnId ? String(p.espnId).trim() : '';
                  
                  // Check for match
                  const matches = pPlayerId === targetId || pEspnId === targetId;
                  
                  if (matches) {
                    console.log(`✓ Found match in team ${team.name}! Player:`, {
                      playerName: p.fullName || p.playerName,
                      playerId: p.playerId,
                      espnId: p.espnId,
                      position: p.position,
                      hasStats: !!p.stats
                    });
                  }
                  
                  return matches;
                });
                
                if (player) {
                  const enrichedPlayer = {
                    playerName: player.fullName || player.playerName,
                    position: player.position,
                    teamName: team.name,
                    stats: player.stats?.seasonStats || null,
                    recentPerformance: player.stats?.recentPerformance || null
                  };
                  console.log("Returning enriched player:", enrichedPlayer);
                  return enrichedPlayer;
                }
              } else {
                console.log(`Team ${team.name} has no roster or roster is not an array`);
              }
            }
            
            // If we didn't find the player, log some sample IDs from rosters to debug
            console.log(`❌ Player ${playerId} not found in any roster`);
            console.log("Sample player IDs from first team's roster:");
            if (legacyLeagueData.teams[0]?.roster?.length > 0) {
              const sampleIds = legacyLeagueData.teams[0].roster.slice(0, 3).map((p: any) => ({
                playerId: p.playerId,
                espnId: p.espnId,
                name: p.playerName || p.fullName
              }));
              console.log(sampleIds);
            }
            return null;
          })
        );
        
        // Filter out any null results
        const validPlayers = enrichedPlayers.filter(p => p !== null);
        
        // Get target team information if provided
        let targetTeamInfo = null;
        if (args.tradeRumorData.targetTeamId) {
          const targetTeam = legacyLeagueData.teams.find((t: any) => t.id === args.tradeRumorData!.targetTeamId);
          if (targetTeam) {
            targetTeamInfo = {
              teamName: targetTeam.name,
              record: targetTeam.record,
              standing: targetTeam.standing
            };
          }
        }
        
        // Build enriched context with better formatting
        let tradeRumorContext = `${args.customContext || ''}

TRADE RUMOR DETAILS:
Rumor Type: ${args.tradeRumorData.rumorType === 'my_trade' ? 'Manager looking to trade their player(s)' : 'Manager received trade offer'}
`;

        if (targetTeamInfo) {
          tradeRumorContext += `Target Team: ${targetTeamInfo.teamName} (${targetTeamInfo.record.wins}-${targetTeamInfo.record.losses})\n`;
        }

        if (validPlayers.length > 0) {
          tradeRumorContext += `\nPlayers Involved:\n`;
          validPlayers.forEach((player, idx) => {
            tradeRumorContext += `${idx + 1}. ${player.playerName} - ${player.position} (${player.teamName})\n`;
            if (player.stats) {
              tradeRumorContext += `   Stats: ${player.stats.appliedTotal.toFixed(1)} total pts, ${player.stats.averagePoints.toFixed(1)} PPG\n`;
            }
          });
        } else {
          // Fallback if no players were enriched - use IDs
          tradeRumorContext += `\nPlayers Involved (IDs): ${args.tradeRumorData.playersInvolved.join(', ')}\n`;
        }

        if (args.tradeRumorData.additionalContext) {
          tradeRumorContext += `\nAdditional Context: ${args.tradeRumorData.additionalContext}\n`;
        }

        enrichedCustomContext = tradeRumorContext;
        
        console.log("Trade rumor enriched with player data:", {
          playersFound: validPlayers.length,
          targetTeam: targetTeamInfo?.teamName || 'N/A',
          contextLength: enrichedCustomContext.length
        });
        console.log("Final enriched context preview:", enrichedCustomContext.substring(0, 500));
      }
      
      // Interview material for scheduled articles (spec section 9.2.8). The
      // comment window now opens hours before print, so by the time this runs
      // there are approved quotes sitting against the scheduled row - and this
      // branch used to ignore them, which is why interviewed managers were
      // never quoted in cron-generated stories. Mirrors the prepared path in
      // aiContentHelpers.generateAIContentWithData; a caller that already
      // resolved the ledger (generateWithComments) still wins.
      let commentResponses = args.commentResponses;
      let nonRespondents = args.nonRespondents;
      if (!commentResponses && args.scheduledContentId) {
        commentResponses = await ctx.runQuery(
          internal.aiContentHelpers.getCommentResponsesForContent,
          {
            scheduledContentId: args.scheduledContentId,
            leagueId: args.leagueId,
            contentType: args.contentType,
            week: args.week,
          }
        );
        nonRespondents = await ctx.runQuery(
          internal.aiContentHelpers.getNonRespondentsForScheduledContent,
          { scheduledContentId: args.scheduledContentId }
        );
        console.log(
          `Loaded ${commentResponses?.length ?? 0} quoted managers and ${nonRespondents?.length ?? 0} non-respondents for scheduled content`
        );
      }

      // The Wire (ffsn-the-wire-spec.md §17.5): same statement pull as the prepared path in
      // aiContentHelpers.generateAIContentWithData - a manager's Wire post/reply is quotable
      // alongside (never merged into) an interview entry.
      if (!WIRE_STATEMENT_EXCLUDED_CONTENT_TYPES.has(args.contentType)) {
        const wireStatements = await ctx.runQuery(internal.wire.getManagerStatementsForArticle, {
          leagueId: args.leagueId,
          since: Date.now() - WIRE_STATEMENT_QUOTABLE_MS,
        });
        if (wireStatements.length > 0) {
          commentResponses = [...(commentResponses ?? []), ...wireStatements];
          console.log(`Added ${wireStatements.length} manager statement(s) from The Wire`);
        }
      }

      // The writer's standing with each manager in this league (spec section 6).
      // Drives relationshipPosture and lets the writer answer a manager's jab.
      const relationships = await ctx.runQuery(
        internal.relationships.getRelationshipsForWriter,
        { leagueId: args.leagueId, persona: args.persona }
      );

      // League language rating + per-manager opt-down (owner ask, Sept 2026): resolved once
      // so this article renders at the same rating every other generation path would use.
      const languageSettings = await ctx.runQuery(
        internal.languageSettings.getLeagueLanguage,
        { leagueId: args.leagueId }
      );

      // Receipts (spec section 8.4): what this writer has predicted in this
      // league and how it turned out. Empty for a writer with no back catalogue.
      const priorClaims = await ctx.runQuery(
        internal.claims.getPriorClaimsForWriter,
        { leagueId: args.leagueId, persona: args.persona }
      );

      // Call AI generation service
      const generatedContent = await ctx.runAction(internal.aiNode.generateArticle, {
        request: {
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          week: args.week,
          // Use prepared data for season_welcome; fallback to enriched
          leagueData: args.contentType === 'season_welcome' ? (await ctx.runQuery(internal.aiContentHelpers.getPreparedData, { articleId: args.articleId }))?.leagueData || leagueData : leagueData,
          customContext: enrichedCustomContext,
          userId: args.userId,
          commentResponses: commentResponses?.length ? commentResponses : undefined,
          nonRespondents: nonRespondents?.length ? nonRespondents : undefined,
          relationships: relationships.length > 0 ? relationships : undefined,
          // The writer's own back catalogue of predictions and their record
          // (spec §8.4). A writer may only claim a past call that is in here.
          priorClaims: priorClaims.items,
          priorRecord: priorClaims.record,
          languageRating: languageSettings.languageRating,
          cleanTeamNames: languageSettings.cleanTeamNames.length
            ? languageSettings.cleanTeamNames
            : undefined,
        },
      });
      
      console.log("AI content generated successfully");
      console.log("Generated title:", generatedContent.title);
      console.log("Content length:", generatedContent.content.length);

      // Update the article with generated content. quotes, managerMentions,
      // reviewFlags, factsMissing and generationStats ride along on metadata and
      // are persisted onto the row (spec section 4.2).
      await ctx.runMutation(internal.aiContent.updateGeneratedContent, {
        articleId: args.articleId,
        title: generatedContent.title,
        content: generatedContent.content,
        summary: generatedContent.summary,
        // args.seasonId is the season this article is actually about (asOf.seasonId for a
        // backfilled row); updateGeneratedContent falls back to the league's live current season
        // when it's absent, so every non-backfill caller is unaffected.
        metadata: { ...generatedContent.metadata, seasonId: args.seasonId },
        billing,
      });

      // One finalize path (spec section 9.2.2): relationship events, quote
      // write-back, the auto-publish decision (suppressed by any block/strip
      // review flag), the commissioner's "ready for your review" notice and the
      // scheduled row's completion, all in one idempotent mutation shared with
      // the prepared path. It must not fail a generation that already produced
      // an article, so it is logged rather than thrown.
      try {
        const finalized = await ctx.runMutation(internal.aiContent.finalizeGeneratedArticle, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          scheduledContentId: args.scheduledContentId,
          reviewFlags: generatedContent.metadata.reviewFlags,
          // The editor pass's verdict rides on metadata (spec §11.2.7) and is
          // half of the publish gate. `null` means the pass did not run.
          editor: generatedContent.metadata.editor ?? undefined,
          generatedByUserId: args.userId,
          billing,
        });
        console.log("Article finalized:", finalized);
      } catch (e) {
        console.error("Failed to finalize generated article", args.articleId, e);
      }

      // Generate banner image if applicable. The OpenAI call runs in the Node runtime
      // (convex/aiNode.ts) and returns a storage id, or null when not eligible/configured.
      try {
        const storageId = await ctx.runAction(internal.aiNode.generateBannerImage, {
          title: generatedContent.title,
          contentType: args.contentType,
          persona: args.persona,
          metadata: {
            week: generatedContent.metadata?.week,
            featuredTeams: generatedContent.metadata?.featuredTeams,
            featuredPlayers: generatedContent.metadata?.featuredPlayers,
          },
        });
        if (storageId) {
          await ctx.runMutation(internal.aiContent.storeBannerImage, {
            articleId: args.articleId,
            storageId,
          });
          console.log("Banner image stored with ID:", storageId);
        }
      } catch (imageError) {
        console.error("Failed to generate/store banner image:", imageError);
        // Continue without image - don't fail the entire generation
      }

      // Update monthly budget spend if applicable
      try {
        const preferences = await ctx.runQuery(internal.contentScheduling.getLeaguePreferences, {
          leagueId: args.leagueId,
        });
        if (preferences?._id) {
          await ctx.runMutation(internal.contentScheduling.updateMonthlySpending, {
            preferencesId: preferences._id,
            creditsUsed: generatedContent.metadata.creditsUsed,
          });
        }
      } catch (e) {
        console.warn("Failed to update monthly content spending", e);
      }

      console.log("=== generateContentAction SUCCESS ===");
    } catch (error) {
      console.error("=== generateContentAction ERROR ===");
      if (isInsufficientDataError(error)) {
        // Not a bug: the writer refused rather than inventing matchups. The
        // message below is written for the commissioner and is stored verbatim.
        console.error("Generation refused for lack of data:", (error as Error).message);
      }
      console.error("Content generation failed:", error);
      console.error("Error stack:", error instanceof Error ? error.stack : "No stack trace");

      // Credits, article status, the scheduled row and the capped retry, all
      // in one place (spec section 9.2.5). `creditsDeductedUpFront` is the
      // local, so a "system" generation that this action charged up front is
      // refunded here too.
      await handleGenerationFailure(
        ctx,
        {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          seasonId: args.seasonId,
          week: args.week,
          scheduledContentId: args.scheduledContentId,
          creditsDeductedUpFront,
          retryCount: args.retryCount,
          stage: "Generation",
        },
        error
      );
    }
  },
});

// Internal mutation to create an article for scheduled content
export const createScheduledArticle = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    type: v.string(),
    persona: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    // Get template to check credit cost
    const template = contentTemplates[args.type];
    if (!template) {
      const availableTypes = Object.keys(contentTemplates).join(', ');
      throw new Error(`Invalid content type: "${args.type}". Available types: ${availableTypes}`);
    }

    // Create a generation request in "generating" status. A "system" article
    // is covered by the League Pass and costs its league nothing (spec §10.1);
    // anything else was charged to the requester before this ran.
    const articleId = await ctx.db.insert("aiContent", {
      leagueId: args.leagueId,
      type: args.type,
      persona: args.persona,
      title: "Generating...",
      content: "",
      metadata: {
        week: 1, // Will be updated
        featured_teams: [],
        credits_used: args.userId === "system" ? 0 : template.creditCost,
      },
      status: "generating",
      createdAt: Date.now(),
    });

    return articleId;
  },
});

// Internal query for getLeagueDataForGeneration
export const getLeagueDataForGenerationInternal = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    // Season backfill (convex/seasonBackfill.ts): forwarded straight through to
    // aiQueries.getLeagueDataForAI's own `asOf` - see that function for what it does.
    asOf: v.optional(v.object({ seasonId: v.number(), week: v.number(), rosterWeek: v.optional(v.number()) })),
  },
  handler: async (ctx, args): Promise<LeagueDataContext> => {
    return getLeagueDataForGenerationHandler(ctx, args);
  },
});

// Shared handler function. Returns the prompt layer's LeagueDataContext: the
// enriched payload from aiQueries.getLeagueDataForAI, reshaped for generation.
async function getLeagueDataForGenerationHandler(
  ctx: any,
  args: { leagueId: any; asOf?: { seasonId: number; week: number; rosterWeek?: number } }
): Promise<LeagueDataContext> {
    console.log("=== getLeagueDataForGeneration START ===");
    console.log("League ID:", args.leagueId);

      // Use our enhanced query to get all enriched data
    const enrichedData = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
      leagueId: args.leagueId,
      asOf: args.asOf,
    });
    
    console.log("Enriched league data fetched:", {
      teams: enrichedData.teams.length,
      trades: enrichedData.trades.length,
      transactions: enrichedData.transactions.length,
      rivalries: enrichedData.rivalries.length,
      hasTransactionTrends: !!enrichedData.transactionTrends,
      hasPlayoffProbabilities: !!enrichedData.playoffProbabilities,
      previousSeasons: Object.keys(enrichedData.previousSeasons || {}).length,
      historicalSeasons: enrichedData.metadata?.historicalSeasons || 0,
      allTimeRecordsCount: Object.keys(enrichedData.leagueHistory?.allTimeRecords || {}).length,
      championshipHistoryCount: enrichedData.leagueHistory?.seasons?.length || 0,
    });
    
    const league = enrichedData.league;
    console.log("League found:", league.name);

    // The FAAB/waiver ledger (owner goal, 2026-09-02): power rankings can cite remaining budget as
    // a standings-adjacent fact. Called through `internal.aiQueries` rather than importing
    // `buildWaiverLedger` as a value — a cross-module value import of a convex/*.ts module that
    // references `internal` can make the generated api type recursive.
    const waivers = await ctx.runQuery(internal.aiQueries.getWaiverLedgerForAI, {
      leagueId: args.leagueId,
      seasonId: enrichedData.currentSeason,
      throughScoringPeriod: enrichedData.currentWeek,
      // A backfilled (asOf) article is about a past week; ESPN's counters would be end-of-season.
      useTeamCounters: args.asOf === undefined,
    });

    // Transform enriched data to match the expected format for AI generation
      const result = {
      // Core league info
      league: enrichedData.league,
      leagueName: enrichedData.league.name,
      currentWeek: enrichedData.currentWeek,
      currentSeason: enrichedData.currentSeason,
        leagueType: enrichedData.leagueType,
      
      // Teams with all enhanced data
      teams: enrichedData.teams,
      standings: enrichedData.standings,
      // Present only when the league has divisions (spec: format audit).
      divisionStandings: enrichedData.divisionStandings,

      // League-format facts: scoring, roster shape, playoff structure, divisions, waivers (spec:
      // format audit). `playoffTeams` / `regularSeasonWeeks` are the back-compat flat fields the
      // existing prompt-builder code (playoff_picture, draft_strategy_guide, …) already reads —
      // this reshape used to drop both, which is why every playoff_picture article printed
      // "not in the payload" regardless of what `getLeagueDataForAI` actually knew.
      leagueFormat: enrichedData.leagueFormat,
      playoffTeams: enrichedData.leagueFormat?.playoffTeamCount ?? enrichedData.metadata?.playoffTeams,
      regularSeasonWeeks: enrichedData.leagueFormat?.regularSeasonMatchupPeriods,


      // Matchup data
      recentMatchups: enrichedData.recentMatchups,
      // In-game injuries (spec §16, owner ask 2026-09-05) - src/lib/ai/facts.ts turns this into
      // the per-player `leftGameInjured` FACTS entry and the HOUSE STYLE line.
      inGameInjuries: enrichedData.inGameInjuries,
      // The look-ahead slate (spec 4.3). This reshape is a whitelist, so a field left out here
      // never reaches the prompt layer - weekly_preview had no upcoming games for exactly that
      // reason.
      upcomingMatchups: enrichedData.upcomingMatchups,
      
      // Transaction data
      trades: enrichedData.trades,
      transactions: enrichedData.transactions,
      transactionTrends: enrichedData.transactionTrends,
      // The FAAB/waiver ledger (owner goal: budget remaining is a standings-adjacent fact for
      // power rankings; harmless for every other content type sharing this payload).
      waivers,

      // Rivalry data
      rivalries: enrichedData.rivalries,
      
      // Manager activity
      managerActivity: enrichedData.managerActivity,
      
      // Playoff probabilities
      playoffProbabilities: enrichedData.playoffProbabilities,
      // The bracket / playoff picture (convex/lib/playoffs.ts) - the writers' FACTS block reads it.
      playoffs: enrichedData.playoffs,
      // League-relative player rankings (owner directive, 2026-09-03 - convex/lib/playerBoard.ts).
      // Whitelist entry only; the `PlayerBoard` shape itself lives in src/lib/ai/prompt-builder.ts.
      playerBoard: enrichedData.playerBoard,
      // Fresh player intel (convex/intel.ts, 2026-09-05) - the INTEL facts and the prompt's PLAYER INTEL block.
      playerIntel: enrichedData.playerIntel,

      // ENHANCED: Historical data for season welcome packages
      previousSeasons: enrichedData.previousSeasons || {},
      leagueHistory: enrichedData.leagueHistory || {
        seasons: [],
        allTimeRecords: {},
      },
      
      // Additional metadata
      scoringType: enrichedData.league.settings?.scoringType || "PPR",
      rosterSize: enrichedData.league.settings?.rosterSize || 16,
      metadata: enrichedData.metadata,
    };
    
    console.log("=== FINAL LEAGUE DATA SUMMARY ===");
    console.log({
      leagueName: result.leagueName,
      currentWeek: result.currentWeek,
      currentTeams: result.teams.length,
      previousSeasons: Object.keys(result.previousSeasons).length,
      historicalSeasonsData: Object.keys(result.previousSeasons).map(season => `${season}: ${result.previousSeasons[season].length} teams`),
      allTimeRecords: Object.keys(result.leagueHistory.allTimeRecords).length + " teams tracked",
      championshipHistory: result.leagueHistory.seasons.length + " seasons",
      matchups: result.recentMatchups.length,
      trades: result.trades.length,
      leagueHistorySeasons: result.leagueHistory?.seasons?.length || 0,
    });
    
    // Validate the required data for season welcome package
    const hasHistoricalData = Object.keys(result.previousSeasons).length > 0;
    const hasAllTimeRecords = Object.keys(result.leagueHistory.allTimeRecords).length > 0;
    const hasChampionshipHistory = result.leagueHistory.seasons.length > 0;
    
    console.log("=== DATA VALIDATION FOR SEASON WELCOME ===");
    console.log({
      hasHistoricalData,
      hasAllTimeRecords, 
      hasChampionshipHistory,
      previousSeasonsCount: Object.keys(result.previousSeasons).length,
      allTimeRecordsCount: Object.keys(result.leagueHistory.allTimeRecords).length,
      championshipSeasonsCount: result.leagueHistory.seasons.length,
    });
    
    console.log("=== getLeagueDataForGeneration END ===");
    
    return result;
}

// Internal mutation to update generated content. Only ever called from
// Convex (generateContentAction / generateAIContentWithData) once generation
// finishes, so it does not need its own auth check.
export const updateGeneratedContent = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    title: v.string(),
    content: v.string(),
    summary: v.string(),
    metadata: v.object({
      week: v.optional(v.number()),
      featuredTeams: v.array(v.string()),
      featuredPlayers: v.array(v.string()),
      tags: v.array(v.string()),
      creditsUsed: v.number(),
      generationTime: v.number(),
      modelUsed: v.string(),
      promptTokens: v.number(),
      completionTokens: v.number(),
      // Money (spec §10.3.4). The measured API cost of every call this article
      // took, cache and batch pricing already applied, and the route it ran
      // on. Optional because a generation from a prompt layer that does not
      // report them must still save.
      costUsd: v.optional(v.number()),
      route: v.optional(v.object({ model: v.string(), effort: v.string() })),
      cacheReadTokens: v.optional(v.number()),
      // Broadcast Desk (spec section 4.2). Optional so a generation produced
      // before the verifier shipped still saves.
      quotes: v.optional(v.array(articleQuoteValidator)),
      managerMentions: v.optional(v.array(managerMentionValidator)),
      reviewFlags: v.optional(v.array(reviewFlagValidator)),
      factsMissing: v.optional(v.array(v.string())),
      // Extended in P2 with factsCount / wordCount / quotesOffered / quotesUsed
      // (spec §8.7). All four are optional, so a generation from a prompt layer
      // that does not report them still saves.
      verifierStats: v.optional(verifierStatsValidator),
      // The editor pass's verdict (spec §11.2.7), emitted by the prompt layer
      // as `metadata.editor`. Declared here so a generation that carries one
      // is not rejected for an unknown field, and so it lands on the row.
      // `null` is accepted because that is what the prompt layer sends when
      // the pass is switched off (`FACT_CHECK_LLM="0"`).
      editor: v.optional(v.union(editorReviewValidator, v.null())),
      // Explicit predictions the writer made (spec §8.4). Stored with
      // outcome "open" plus the byline, week and season below.
      claims: v.optional(v.array(generatedClaimValidator)),
      // The "Disputed" show's structured transcript (spec: Disputed). Optional: only a
      // desk_show generation reports one.
      transcript: v.optional(showTranscriptValidator),
      // Season backfill (owner directive, Sept 2026): the season this article is actually ABOUT,
      // from the caller (generateContentAction's `args.seasonId`, or aiContentHelpers' prepared
      // path). Falls back to the league's live current season below when absent, which is every
      // caller before this shipped - the row is stamped `leagueCurrentSeason(league)` exactly as it
      // always was.
      seasonId: v.optional(v.number()),
    }),
    // Who paid for this article (spec §10.1): the League Pass, or the
    // requester's credits. Drives the automated/manual split in the season
    // spend roll-up. Absent on legacy callers, which read as automated.
    billing: v.optional(v.union(v.literal("pass"), v.literal("credits"))),
  },
  handler: async (ctx, args) => {
    // Get the article to find the league
    const article = await ctx.db.get(args.articleId);
    if (!article) {
      throw new Error("Article not found");
    }

    // Convert provided metadata.featuredTeams (which may be team names, external IDs, or Convex IDs)
    // to actual Convex team IDs
    let featuredTeamIds: Id<"teams">[] = [];
    if (args.metadata.featuredTeams.length > 0) {
      // Get all teams for this league
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_league", (q) => q.eq("leagueId", article.leagueId))
        .collect();

      // Convert various identifiers to Convex IDs
      featuredTeamIds = args.metadata.featuredTeams
        .map(identifier => {
          const value = String(identifier);

          // 1) If this looks like a Convex ID, try direct match
          const maybeConvex = teams.find(t => t._id === (value as unknown as Id<"teams">));
          if (maybeConvex) return maybeConvex._id;

          // 2) If numeric/string external ID, match by externalId
          const byExternal = teams.find(t => t.externalId === value);
          if (byExternal) return byExternal._id;

          // 3) Try exact name match
          let byName = teams.find(t => t.name.toLowerCase() === value.toLowerCase());
          if (byName) return byName._id;

          // 4) Try partial name match
          byName = teams.find(t =>
            t.name.toLowerCase().includes(value.toLowerCase()) ||
            value.toLowerCase().includes(t.name.toLowerCase())
          );
          if (byName) return byName._id;

          // 5) Try abbreviation match (short strings)
          if (value.length <= 4) {
            const byAbbrev = teams.find(t => t.abbreviation?.toLowerCase() === value.toLowerCase());
            if (byAbbrev) return byAbbrev._id;
          }

          return undefined;
        })
        .filter((id): id is Id<"teams"> => id !== undefined); // Remove undefined values

      console.log(`Converted team names to IDs:`, {
        identifiers: args.metadata.featuredTeams,
        teamIds: featuredTeamIds,
        teamsInLeague: teams.map(t => ({ name: t.name, abbreviation: t.abbreviation, id: t._id }))
      });
    }

    const verifierStats = args.metadata.verifierStats;
    const editorReview = normalizeEditorReview(args.metadata.editor);

    // Receipts (spec §8.4). The model emits the prediction; who made it, in which
    // week and season, and how it turned out are ours to stamp on. Everything
    // starts "open" - claims.resolveOpenClaims settles them weekly.
    //
    // Season backfill (owner directive, Sept 2026): `args.metadata.seasonId` is the season this
    // article is actually ABOUT (the caller's `asOf.seasonId` for a backfilled article), and wins
    // over the league's live current season - without this, a 2025 recap generated during the 2026
    // season was stamped `seasonId: 2026`, which put it under the WRONG season's spend cap and made
    // it invisible to `by_league_season`-scoped reads of the 2025 season.
    const league = await ctx.db.get(article.leagueId);
    const season = args.metadata.seasonId ?? leagueCurrentSeason(league);
    // A multi-speaker piece (the "Disputed" show, spec: Disputed) stamps each claim with the
    // desk member who actually made it; an ordinary single-writer article falls back to its
    // own byline, exactly as before.
    const claims = args.metadata.claims?.map((claim) => ({
      ...claim,
      week: claim.week ?? args.metadata.week,
      outcome: "open" as const,
      persona: claim.persona ?? article.persona,
      season,
    }));

    await ctx.db.patch(args.articleId, {
      title: args.title,
      content: args.content,
      summary: args.summary,
      metadata: {
        week: args.metadata.week,
        featured_teams: featuredTeamIds, // Now using actual team IDs
        credits_used: args.metadata.creditsUsed,
      },
      // Grounding + verification, surfaced in edit-before-publish and consumed
      // by relationships.recordArticleMentions (spec sections 4.2, 4.5, 6.3).
      quotes: args.metadata.quotes,
      managerMentions: args.metadata.managerMentions,
      claims,
      transcript: args.metadata.transcript,
      reviewFlags: args.metadata.reviewFlags,
      factsMissing: args.metadata.factsMissing,
      // The season this article belongs to, so `deskMetrics.getLeagueSeasonSpend`
      // can roll a league's spend up off an index instead of scanning.
      seasonId: season,
      // Written whenever the run reported EITHER verifier stats or an editor
      // verdict (spec §11.2.7): the editor's scores are what the publish gate
      // re-reads, so losing them because the verifier said nothing would let a
      // held article quietly publish on a later finalize.
      generationStats:
        verifierStats || editorReview
          ? {
              ...(verifierStats ?? {
                blocks: (args.metadata.reviewFlags ?? []).filter((f) => f.severity === "block").length,
                strips: (args.metadata.reviewFlags ?? []).filter((f) => f.severity === "strip").length,
                warns: (args.metadata.reviewFlags ?? []).filter((f) => f.severity === "warn").length,
                sectionsRegenerated: 0,
              }),
              promptTokens: args.metadata.promptTokens,
              completionTokens: args.metadata.completionTokens,
              modelUsed: args.metadata.modelUsed,
              // Cost accounting (spec §10.3.4).
              costUsd: args.metadata.costUsd,
              route: args.metadata.route,
              billing: args.billing,
              // Quality gate bookkeeping (spec §11.2.7).
              editor: editorReview,
            }
          : undefined,
      status: "draft", // Set to draft for review instead of auto-publishing
      // publishedAt will be set when actually published
    });
  },
});

// Internal mutation to store banner image. Only ever called from Convex
// (generateContentAction) once the banner image has been generated.
export const storeBannerImage = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.articleId, {
      bannerImageId: args.storageId,
    });
  },
});

async function updateContentStatusHandler(
  ctx: MutationCtx,
  args: {
    articleId: Id<"aiContent">;
    status: string;
    error?: string;
    // Season backfill (owner directive, Sept 2026): a backfill publish is quiet (no
    // notifyArticlePublished fan-out) and backdated to when the article is actually about, not now.
    silent?: boolean;
    publishedAt?: number;
  }
) {
  // Update the status and set publishedAt if publishing
  const update: Record<string, unknown> = { status: args.status };
  if (args.status === "published") {
    update.publishedAt = args.publishedAt ?? Date.now();
  }
  await ctx.db.patch(args.articleId, update);

  // Notify the league whenever an article transitions to published. This
  // covers both publish paths (the commissioner-gated updateContentStatus
  // mutation below, and the auto-publish branch inside
  // generateContentAction which calls updateContentStatusInternal) since
  // both funnel through this shared handler. Scheduled rather than run
  // inline so a notification/email failure can never block publishing.
  if (args.status === "published" && !args.silent) {
    await ctx.scheduler.runAfter(0, internal.notifications.notifyArticlePublished, {
      articleId: args.articleId,
    });
    // The Wire (ffsn-the-wire-spec.md §5.2/§8.2): a routine "new article" post, same silent-backfill
    // exemption as the reader notification above - a quiet catch-up publish should not surface on
    // the live feed either.
    await ctx.scheduler.runAfter(0, internal.wireRoutine.onArticlePublished, {
      articleId: args.articleId,
    });
  }
}

// Mutation to update content status. This is the publish button in
// AIGenerationPage.tsx — public, but gated to the article's league
// commissioner. All internal (system-generated) status transitions go
// through updateContentStatusInternal below instead.
export const updateContentStatus = mutation({
  args: {
    articleId: v.id("aiContent"),
    status: v.string(),
    error: v.optional(v.string()), // We'll ignore this since it's not in schema
  },
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) {
      throw new Error("Article not found");
    }
    await requireCommissioner(ctx, article.leagueId);

    await updateContentStatusHandler(ctx, args);
  },
});

// Internal mutation to update content status. Used by the generation
// pipeline (generateContentAction, prepareAIContentData,
// generateAIContentWithData, aiContentWithComments) to mark articles
// generating/failed/published without requiring a signed-in caller.
export const updateContentStatusInternal = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await updateContentStatusHandler(ctx, args);
  },
});

/* -------------------------------------------------------------------------- *
 * One finalize path (spec §9.2.2)
 *
 * Everything that has to happen after an article is written and saved, in one
 * mutation, called from both generation paths: the standard branch of
 * generateContentAction and aiContentHelpers.generateAIContentWithData (which
 * previously did none of it - scheduled mock drafts, weekly recaps, draft
 * rankings and season welcomes never auto-published and never closed their
 * scheduled row).
 *
 * A mutation rather than an action so the whole finalize is one transaction and
 * a second call is a cheap no-op. The three sub-mutations it invokes run as
 * subtransactions: if one throws, its writes roll back on their own and the
 * finalize still completes.
 * -------------------------------------------------------------------------- */

/**
 * §9.1: content is automatic by default. A league whose preferences row has not
 * been created yet is treated as opted in, never opted out.
 */
function contentPreferenceDefaults(preferences: Doc<"leagueContentPreferences"> | null) {
  return {
    autoPublish: preferences?.autoPublish ?? true,
    requireApproval: preferences?.requireApproval ?? false,
    notifyCommissioner: preferences?.notifyCommissioner ?? true,
    notifyFailures: preferences?.notifyFailures ?? true,
  };
}

async function leaguePreferencesFor(
  ctx: MutationCtx,
  leagueId: Id<"leagues">
): Promise<Doc<"leagueContentPreferences"> | null> {
  return await ctx.db
    .query("leagueContentPreferences")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .first();
}

/* -------------------------------------------------------------------------- *
 * Publish gate (spec §11.2.9)
 * -------------------------------------------------------------------------- */

/**
 * The rule itself lives in `src/lib/ai/publish-gate.ts` (workstream Q-A):
 * publish iff zero `block`, zero `strip`, editor `factsScore >= 3`,
 * `wordCount >= 30%` of the template ceiling, and every required section
 * present. It is a pure, SDK-free module, so it imports cleanly into the V8
 * isolate and the prompt layer and Convex cannot drift apart on the decision.
 */

/** Words in a stored body, for articles whose generation never reported a count. */
function countWords(body: string | undefined): number | undefined {
  if (!body) return undefined;
  const words = body.split(/\s+/).filter(Boolean).length;
  return words > 0 ? words : undefined;
}

/**
 * Narrow `EditorPassResult | null` down to what is stored on the row.
 *
 * `model` and `costUsd` are carried through for the operator digest; `null`
 * (the pass did not run) becomes `undefined`, which is what a Convex optional
 * field means.
 */
function normalizeEditorReview(
  editor: Partial<EditorPassResult> | null | undefined,
): StoredEditorReview | undefined {
  if (!editor) return undefined;
  const normalized: StoredEditorReview = {
    contradictions: editor.contradictions,
    unsupported: editor.unsupported,
    registerLeaks: editor.registerLeaks,
    factsScore: editor.factsScore,
    voiceScore: editor.voiceScore,
    incompleteSections: editor.incompleteSections,
    model: editor.model,
    costUsd: editor.costUsd,
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

export const finalizeGeneratedArticle = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    scheduledContentId: v.optional(v.id("scheduledContent")),
    // The verifier's findings for this run. Falls back to what
    // updateGeneratedContent already stored on the row, so a caller that does
    // not have them in hand still gets the right auto-publish decision.
    reviewFlags: v.optional(v.array(reviewFlagValidator)),
    // The editor pass's verdict (spec §11.2.7). Persisted onto the row and fed
    // to the publish gate. Falls back to what is already stored, so a caller
    // that does not carry it still gets the right decision.
    editor: v.optional(editorReviewValidator),
    generatedByUserId: v.optional(v.string()),
    // Who paid for this run (spec §10.1) - threaded through explicitly rather than re-read from
    // `article.generationStats.billing`: that field is only ever written when the row also has
    // verifier stats or an editor verdict (see `updateGeneratedContent`'s conditional
    // `generationStats` write), so a run with neither would otherwise lose its billing entirely
    // by the time it reaches here. Falls back to whatever is already stored for a caller that
    // does not pass it (aiBatch.ts's poll, which is always automated).
    billing: v.optional(v.union(v.literal("pass"), v.literal("credits"))),
  },
  returns: v.object({
    published: v.boolean(),
    blockingFlags: v.number(),
    /** Why the gate held it. Empty when it published (spec §11.2.9). */
    holdReasons: v.array(v.string()),
    notifiedCommissioner: v.boolean(),
    scheduledRowCompleted: v.boolean(),
    alreadyFinalized: v.boolean(),
  }),
  // The handler's return type is spelled out because this mutation and
  // aiContentHelpers call each other through `internal.*`; without it
  // TypeScript cannot break the inference cycle.
  handler: async (ctx, args): Promise<{
    published: boolean;
    blockingFlags: number;
    holdReasons: string[];
    notifiedCommissioner: boolean;
    scheduledRowCompleted: boolean;
    alreadyFinalized: boolean;
  }> => {
    const noop = {
      published: false,
      blockingFlags: 0,
      holdReasons: [] as string[],
      notifiedCommissioner: false,
      scheduledRowCompleted: false,
      alreadyFinalized: true,
    };

    const article = await ctx.db.get(args.articleId);
    if (!article) {
      console.warn(`finalizeGeneratedArticle: article ${args.articleId} not found`);
      return noop;
    }

    // Idempotency: a published article has already been through here (and its
    // readers have already been notified). Re-running would re-notify nobody
    // but would re-stamp publishedAt, so stop.
    if (article.status === "published") {
      return noop;
    }

    // Relationship events from the stored managerMentions, and the write-back
    // of which approved quotes made print. Both are idempotent on their own
    // (recordEvent dedupes on article+type+evidence; markQuotesUsed rewrites
    // the same fields), and neither may fail an article that already exists.
    try {
      await ctx.runMutation(internal.relationships.recordArticleMentions, {
        articleId: args.articleId,
      });
    } catch (e) {
      console.error("Failed to record relationship events for article", args.articleId, e);
    }
    try {
      await ctx.runMutation(internal.aiContentHelpers.markQuotesUsed, {
        articleId: args.articleId,
      });
    } catch (e) {
      console.error("Failed to mark comment responses as integrated", args.articleId, e);
    }

    // The publish gate (spec §11.2.9) wins over the preference: an article
    // that fails any of its five tests stops in draft so a human sees it
    // first, whatever `autoPublish` says.
    const reviewFlags = args.reviewFlags ?? article.reviewFlags ?? [];
    const blockingFlags = reviewFlags.filter(
      (flag) => flag.severity === "block" || flag.severity === "strip"
    ).length;

    // The editor's verdict, from this call or from what was already stored.
    // A verdict that arrives here and is not yet on the row is persisted, so
    // the reason an article was held survives the generation action.
    const editor = normalizeEditorReview(args.editor) ?? article.generationStats?.editor;
    if (args.editor && editor && article.generationStats) {
      await ctx.db.patch(args.articleId, {
        generationStats: { ...article.generationStats, editor },
      });
    }

    const gate = shouldPublish({
      contentType: article.type,
      reviewFlags,
      verifierStats: article.generationStats,
      wordCount: article.generationStats?.wordCount ?? countWords(article.content),
      editor,
    });

    const preferences = await leaguePreferencesFor(ctx, args.leagueId);
    const prefs = contentPreferenceDefaults(preferences);

    // Manual generation (owner ask, 2026-09-06): a real person requested and paid credits for
    // this specific run - it must land in review, never auto-publish, whatever the league's
    // autoPublish preference says. Automated/backfill content (billed to the League Pass, or a
    // legacy row with no billing stamped at all) is unaffected.
    const billing = args.billing ?? article.generationStats?.billing;
    const manual = billing === "credits";
    const publish = prefs.autoPublish && !prefs.requireApproval && gate.ok && !manual;

    // Read once, reused for the backfill gate below AND to close the row further down - a season
    // backfill row (convex/seasonBackfill.ts) publishes quietly and backdated, and triggers no
    // commissioner or operator notification (owner directive, Sept 2026): the whole point of the
    // tool is a quiet catch-up run.
    const scheduledRow = args.scheduledContentId ? await ctx.db.get(args.scheduledContentId) : null;
    const isBackfill = scheduledRow?.backfill === true;

    let notifiedCommissioner = false;
    if (publish) {
      // Fans out reader notifications + emails through notifyArticlePublished - unless this is a
      // backfill row, which publishes silently and backdated to when it's actually about.
      await updateContentStatusHandler(ctx, {
        articleId: args.articleId,
        status: "published",
        silent: isBackfill,
        publishedAt: isBackfill ? scheduledRow?.scheduledFor : undefined,
      });
      if (isBackfill && scheduledRow) {
        console.log(
          `[backfill] published article ${args.articleId} quietly, backdated to ${new Date(scheduledRow.scheduledFor).toISOString()}`
        );
      }
    } else {
      if (manual && gate.ok) {
        // Nothing is broken - the gate would have published this. It is held because a person
        // asked for it directly and spent their own credits on it (spec §10.1): no operator
        // alert (that path only fires when the gate itself failed, below), just the
        // commissioner's ordinary review notice with a detail that says exactly that.
        console.log(`manual run: held for review (article ${args.articleId})`);
      }
      if (!gate.ok && prefs.autoPublish) {
        console.log(
          `Auto-publish suppressed on article ${args.articleId}: ${gate.reasons.join("; ")}`
        );
        // The operator hears about every held article, deduped on the article id (spec §11.3.10).
        // A backfill row still claims/records the notice (so it lands in the daily digest) but
        // skips the immediate email - a 30-article catch-up run must not flood the operator's
        // inbox one message at a time. Scheduled rather than awaited: an email must never be able
        // to fail a finalize.
        await ctx.scheduler.runAfter(0, internal.deskMetrics.notifyOperatorOfArticle, {
          leagueId: args.leagueId,
          articleId: args.articleId,
          kind: "held" as const,
          contentType: article.type,
          persona: article.persona,
          reasons: gate.reasons,
          digestOnly: isBackfill,
        });
      }
      // The commissioner's "ready for your review" notice never fires for a backfill row - a held
      // backfill article is already visible in Review, and the whole run must stay quiet.
      if (prefs.notifyCommissioner && !isBackfill) {
        const detail =
          manual && gate.ok
            ? "Generated on request; review and publish when ready."
            : gate.ok
              ? undefined
              : `Needs your review: ${gate.reasons.join("; ")}.`;
        const notificationId: Id<"userNotifications"> | null = await ctx.runMutation(
          internal.notifications.notifyCommissionerOfContent,
          {
            leagueId: args.leagueId,
            kind: "ready_for_review" as const,
            contentType: article.type,
            articleId: args.articleId,
            detail,
            // One notification per article, however many times finalize runs.
            dedupeKey: `ready_for_review:${args.articleId}`,
          }
        );
        notifiedCommissioner = notificationId !== null;
      }
    }

    // Close the scheduled row. Only ever moves a row forward: a cancelled or
    // failed row is left alone so a later finalize cannot resurrect it.
    let scheduledRowCompleted = false;
    if (args.scheduledContentId && scheduledRow && (scheduledRow.status === "generating" || scheduledRow.status === "pending")) {
      await ctx.db.patch(args.scheduledContentId, {
        status: "completed",
        generatedContentId: args.articleId,
        generatedAt: Date.now(),
        updatedAt: Date.now(),
      });
      scheduledRowCompleted = true;
    }

    console.log(
      `finalizeGeneratedArticle: article ${args.articleId} ${
        publish ? "published" : "left in draft"
      } (${blockingFlags} blocking flag(s)${
        gate.ok ? "" : `, gate: ${gate.reasons.join("; ")}`
      }, requested by ${args.generatedByUserId ?? "unknown"})`
    );

    return {
      published: publish,
      blockingFlags,
      holdReasons: gate.reasons,
      notifiedCommissioner,
      scheduledRowCompleted,
      alreadyFinalized: false,
    };
  },
});

/* -------------------------------------------------------------------------- *
 * Billing and retry bookkeeping for the automatic paths (spec §9.2.4, §9.2.5)
 * -------------------------------------------------------------------------- */

/**
 * `scheduledContent.cancelReason` / `deferrals` are AUTO-A's schema additions.
 * Until they land, patching them would be rejected as an unknown field, so the
 * write is gated on what the deployed schema actually declares.
 */
function scheduledContentHasField(field: string): boolean {
  const validator = schema.tables.scheduledContent.validator as unknown as {
    fields?: Record<string, unknown>;
  };
  return Boolean(validator.fields && field in validator.fields);
}

/**
 * The requester cannot pay for this article. Mark it failed, cancel the
 * scheduled row with a machine-readable reason, and tell them once.
 *
 * The automatic paths no longer reach this: since the League Pass shipped
 * (spec §10.1) scheduled content is covered outright and is gated on the pass
 * and the season spend cap instead, in
 * `contentScheduling.processScheduledContent`. This stays as the shared
 * "generation stopped because it could not be paid for" bookkeeping for any
 * credit-funded path that discovers a shortfall after the article row exists.
 */
export const markGenerationLowCredits = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    scheduledContentId: v.optional(v.id("scheduledContent")),
    required: v.number(),
    available: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await updateContentStatusHandler(ctx, {
      articleId: args.articleId,
      status: "failed",
      error: "low_credits",
    });

    const row = args.scheduledContentId ? await ctx.db.get(args.scheduledContentId) : null;
    const isBackfill = row?.backfill === true;

    if (row && row.status !== "completed") {
      const patch: Record<string, unknown> = {
        status: "cancelled",
        errorMessage: `low_credits: needed ${args.required}, balance ${args.available}`,
        updatedAt: Date.now(),
      };
      if (scheduledContentHasField("cancelReason")) {
        patch.cancelReason = "low_credits";
      }
      await ctx.db.patch(
        args.scheduledContentId as Id<"scheduledContent">,
        patch as Partial<Doc<"scheduledContent">>
      );
    }

    // A backfill row is covered by the League Pass and never touches credits, so this should never
    // actually fire for one - gated anyway per the owner's "zero notifications" directive.
    const preferences = await leaguePreferencesFor(ctx, args.leagueId);
    if (contentPreferenceDefaults(preferences).notifyFailures && !isBackfill) {
      const week = (await ctx.db.get(args.articleId))?.metadata.week;
      await ctx.runMutation(internal.notifications.notifyCommissionerOfContent, {
        leagueId: args.leagueId,
        kind: "low_credits" as const,
        contentType: args.contentType,
        articleId: args.articleId,
        scheduledContentId: args.scheduledContentId,
        detail: `This story costs ${args.required} credits and the balance is ${args.available}. Top up and the next scheduled story goes out as normal.`,
        // Once per league per week per reason (spec §9.2.4).
        dedupeKey: `low_credits:${args.leagueId}:${week ?? "na"}`,
      });
    }

    return null;
  },
});

/**
 * Record what one interview cost us (spec §10.3.4).
 *
 * Sam's interviews are billed API calls - an opener, a reply analysis, maybe a
 * follow-up - and they count against the league's automated spend cap even
 * though no article has been written yet. The conversation layer
 * (`commentConversations.ts`, W1-C) owns those calls, so it reports the cost
 * here rather than this module reaching into its tables.
 *
 * Additive on purpose: an interview accrues cost over several messages, and
 * each call adds its own. Idempotency is the caller's: report each API call
 * once. A non-finite or negative amount is ignored rather than corrupting the
 * running total.
 */
export const addInterviewCost = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    costUsd: v.number(),
  },
  returns: v.object({ totalUsd: v.number() }),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) {
      console.warn(`addInterviewCost: comment request ${args.commentRequestId} not found`);
      return { totalUsd: 0 };
    }

    if (!Number.isFinite(args.costUsd) || args.costUsd <= 0) {
      return { totalUsd: request.interviewCostUsd ?? 0 };
    }

    const totalUsd = (request.interviewCostUsd ?? 0) + args.costUsd;
    await ctx.db.patch(args.commentRequestId, {
      interviewCostUsd: totalUsd,
      updatedAt: Date.now(),
    });

    return { totalUsd };
  },
});

/**
 * A scheduled generation failed. The cron owns retries for scheduled rows, so
 * put the row back to `pending` with a retry time while attempts remain, and
 * only fail it (and tell the commissioner) once they are used up.
 */
export const recordScheduledGenerationFailure = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    articleId: v.optional(v.id("aiContent")),
    errorMessage: v.string(),
    // An InsufficientDataError is not flaky - retrying it burns the same
    // refund path again for the same missing week of data.
    retryable: v.boolean(),
  },
  returns: v.object({ status: v.string(), attempts: v.number(), notified: v.boolean() }),
  handler: async (
    ctx,
    args
  ): Promise<{ status: string; attempts: number; notified: boolean }> => {
    const row = await ctx.db.get(args.scheduledContentId);
    if (!row) {
      return { status: "missing", attempts: 0, notified: false };
    }

    const now = Date.now();
    // `processScheduledContent` spends the attempt when it dispatches the
    // generation (it moves the row to "generating" with attempts + 1), so
    // counting it again here would halve every league's retry budget. A row
    // that failed without having been dispatched is counted here instead.
    const attempts = row.status === "generating" ? row.attempts ?? 0 : (row.attempts ?? 0) + 1;
    const maxAttempts = row.maxAttempts ?? 3;
    const willRetry = args.retryable && attempts < maxAttempts;

    await ctx.db.patch(args.scheduledContentId, {
      status: willRetry ? "pending" : "failed",
      attempts,
      lastAttemptAt: now,
      nextRetryAt: willRetry ? now + 30 * 60 * 1000 : undefined,
      errorMessage: args.errorMessage,
      updatedAt: now,
    });

    let notified = false;
    // A backfill row (convex/seasonBackfill.ts) never notifies the commissioner of a failure - the
    // whole run is meant to be quiet, and its outcome is visible through getSeasonBackfillStatus.
    if (!willRetry && row.backfill !== true) {
      const preferences = await leaguePreferencesFor(ctx, args.leagueId);
      if (contentPreferenceDefaults(preferences).notifyFailures) {
        const notificationId: Id<"userNotifications"> | null = await ctx.runMutation(
          internal.notifications.notifyCommissionerOfContent,
          {
            leagueId: args.leagueId,
            kind: "generation_failed" as const,
            contentType: args.contentType,
            articleId: args.articleId,
            scheduledContentId: args.scheduledContentId,
            detail: args.errorMessage,
            dedupeKey: `generation_failed:${args.scheduledContentId}`,
          }
        );
        notified = notificationId !== null;
      }
    }

    return { status: willRetry ? "pending" : "failed", attempts, notified };
  },
});

// Public mutation backing the Review tab's Edit mode in AIGenerationPage.tsx.
// Commissioner-only, and only while the article is sitting in a reviewable
// state (not mid-generation or mid comment-collection).
export const editArticle = mutation({
  args: {
    articleId: v.id("aiContent"),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    content: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) {
      throw new Error("Article not found");
    }

    await requireCommissioner(ctx, article.leagueId);

    if (article.status === "generating" || article.status === "waiting_for_comments") {
      throw new Error("Cannot edit an article while it is still generating");
    }

    const update: Record<string, unknown> = {};
    if (args.title !== undefined) {
      update.title = args.title;
    }
    if (args.content !== undefined) {
      update.content = args.content;
    }
    if (args.summary !== undefined) {
      update.summary = args.summary;
    }

    // aiContent has no updatedAt field to stamp; metadata is intentionally
    // left untouched.
    if (Object.keys(update).length > 0) {
      await ctx.db.patch(args.articleId, update);
    }

    return { success: true };
  },
});

// Mutation to delete content
export const deleteContent = mutation({
  args: {
    articleId: v.id("aiContent"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Get the article to check permissions
    const article = await ctx.db.get(args.articleId);
    if (!article) {
      throw new Error("Article not found");
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", article.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      throw new Error("Not authorized to delete this article");
    }

    // Delete the article
    await ctx.db.delete(args.articleId);
  },
});