/* eslint-disable @typescript-eslint/no-explicit-any */
import { query, mutation, action, internalQuery, internalMutation, internalAction, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { contentTemplates } from "../src/lib/ai/content-templates";
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
  verifierStatsValidator,
} from "./validators";
import { leagueCurrentSeason } from "./lib/season";

/**
 * `InsufficientDataError` (src/lib/ai/prompt-builder) is thrown when a content
 * type's core data is absent. It reaches this action through the Node runtime,
 * where only the name and message survive, so match on both. Its message is
 * written for a human and is stored verbatim as the article's failure reason.
 */
function isInsufficientDataError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "InsufficientDataError" ||
    /^Not enough data to write a/i.test(error.message)
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

    // Get template to check credit cost
    const template = contentTemplates[args.type];
    if (!template) {
      const availableTypes = Object.keys(contentTemplates).join(', ');
      throw new Error(`Invalid content type: "${args.type}". Available types: ${availableTypes}`);
    }

    // Check if user has sufficient credits before scheduling any generation
    // work (mirrors regenerateContentWithCredits below).
    const userCredits = await ctx.runQuery(internal.credits.checkSufficientCredits, {
      userId: identity.subject,
      requiredAmount: template.creditCost,
    });

    if (!userCredits.hasSufficientCredits) {
      throw new Error(`Insufficient credits. Required: ${template.creditCost}, Available: ${userCredits.currentBalance}`);
    }

    // Deduct credits up front, before scheduling generation, so concurrent
    // requests can't spend more than the user's balance allows.
    await ctx.runMutation(internal.credits.deductCredits, {
      userId: identity.subject,
      amount: template.creditCost,
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
        credits_used: template.creditCost,
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
      creditsDeductedUpFront: template.creditCost,
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

    // Get template to check credit cost
    const template = contentTemplates[args.type];
    if (!template) {
      const availableTypes = Object.keys(contentTemplates).join(', ');
      throw new Error(`Invalid content type: "${args.type}". Available types: ${availableTypes}`);
    }

    // Check if user has sufficient credits before scheduling any generation
    // work (mirrors createGenerationRequest above).
    const userCredits = await ctx.runQuery(internal.credits.checkSufficientCredits, {
      userId: identity.subject,
      requiredAmount: template.creditCost,
    });

    if (!userCredits.hasSufficientCredits) {
      throw new Error(`Insufficient credits. Required: ${template.creditCost}, Available: ${userCredits.currentBalance}`);
    }

    // Deduct credits up front, before scheduling comment collection /
    // generation, so concurrent requests can't spend more than the user's
    // balance allows.
    await ctx.runMutation(internal.credits.deductCredits, {
      userId: identity.subject,
      amount: template.creditCost,
      description: `AI content generation with comments: ${args.type}`,
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
        credits_used: template.creditCost,
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
        creditsDeductedUpFront: template.creditCost,
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
      creditsDeductedUpFront: template.creditCost,
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

    // Get template to check credit cost
    const template = contentTemplates[args.type];
    if (!template) {
      const availableTypes = Object.keys(contentTemplates).join(', ');
      throw new Error(`Invalid content type: "${args.type}". Available types: ${availableTypes}`);
    }

    // Check if user has sufficient credits
    const userCredits = await ctx.runQuery(internal.credits.checkSufficientCredits, {
      userId: identity.subject,
      requiredAmount: template.creditCost,
    });

    if (!userCredits.hasSufficientCredits) {
      throw new Error(`Insufficient credits. Required: ${template.creditCost}, Available: ${userCredits.currentBalance}`);
    }

    // Deduct credits first
    await ctx.runMutation(internal.credits.deductCredits, {
      userId: identity.subject,
      amount: template.creditCost,
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
        credits_used: template.creditCost,
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
      creditsDeductedUpFront: template.creditCost,
    });

    return articleId;
  },
});

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
    // of deducting again on success. Callers that omit it (scheduled/cron
    // content, comment-triggered content, retries) keep the legacy
    // post-generation deduction below unchanged.
    creditsDeductedUpFront: v.optional(v.number()),
    // Interview material from the comment flow (spec section 5). Built by
    // aiContentWithComments.generateWithComments and passed straight through to
    // the writer instead of being pasted into customContext.
    commentResponses: v.optional(v.array(commentResponseDataValidator)),
    nonRespondents: v.optional(v.array(nonRespondentValidator)),
  },
  handler: async (ctx, args) => {
    console.log("=== generateContentAction START (OPTIMIZED) ===");
    console.log("Content type:", args.contentType);
    console.log("Persona:", args.persona);
    
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
          creditsDeductedUpFront: args.creditsDeductedUpFront,
          commentResponses: args.commentResponses,
          nonRespondents: args.nonRespondents,
        });
        
        console.log(`${args.contentType} generation scheduled successfully`);
        return;
      }
      
      // For other content types, use the existing approach
      console.log("Using standard approach for content type:", args.contentType);
      
      const leagueData = await ctx.runQuery(internal.aiContent.getLeagueDataForGenerationInternal, {
        leagueId: args.leagueId,
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
      
      // The writer's standing with each manager in this league (spec section 6).
      // Drives relationshipPosture and lets the writer answer a manager's jab.
      const relationships = await ctx.runQuery(
        internal.relationships.getRelationshipsForWriter,
        { leagueId: args.leagueId, persona: args.persona }
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
          // Use prepared data for season_welcome; fallback to enriched
          leagueData: args.contentType === 'season_welcome' ? (await ctx.runQuery(internal.aiContentHelpers.getPreparedData, { articleId: args.articleId }))?.leagueData || leagueData : leagueData,
          customContext: enrichedCustomContext,
          userId: args.userId,
          commentResponses: args.commentResponses,
          nonRespondents: args.nonRespondents,
          relationships: relationships.length > 0 ? relationships : undefined,
          // The writer's own back catalogue of predictions and their record
          // (spec §8.4). A writer may only claim a past call that is in here.
          priorClaims: priorClaims.items,
          priorRecord: priorClaims.record,
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
        metadata: generatedContent.metadata,
      });

      // Relationship events from the stored managerMentions, and the write-back
      // of which approved quotes actually made print. Neither may fail a
      // generation that already succeeded.
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

      // Deduct credits from user for system-generated content (if userId is "system", find the league owner).
      // Skipped when the caller already deducted up front (see creditsDeductedUpFront above) -
      // that credit accounting is settled in the catch block below instead (refund on failure).
      if (!args.creditsDeductedUpFront) {
        try {
          let creditUserId = args.userId;
          if (args.userId === "system") {
            // Find the league commissioner to deduct credits from
            const league = await ctx.runQuery(internal.contentScheduling.getLeagueById, {
              leagueId: args.leagueId,
            });
            if (league?.commissionerUserId) {
              creditUserId = league.commissionerUserId; // Use league commissioner
            }
          }

          if (creditUserId !== "system") {
            await ctx.runMutation(internal.credits.deductCreditsInternal, {
              userId: creditUserId,
              amount: generatedContent.metadata.creditsUsed,
              description: `AI content generation: ${args.contentType}`,
              leagueId: args.leagueId,
              relatedContentId: args.articleId,
            });
          }
        } catch (creditError) {
          console.warn("Failed to deduct credits for content generation:", creditError);
          // Don't fail the entire generation process if credit deduction fails
        }
      }

      // Optionally auto-publish based on league preferences. The verifier wins:
      // an article carrying a block or strip finding always stops in draft so a
      // human sees the flagged sentences first (spec decision 6).
      try {
        const blockingFlags = (generatedContent.metadata.reviewFlags ?? []).filter(
          (flag) => flag.severity === "block" || flag.severity === "strip"
        );
        const preferences = await ctx.runQuery(internal.contentScheduling.getLeaguePreferences, {
          leagueId: args.leagueId,
        });
        if (preferences?.autoPublish && blockingFlags.length > 0) {
          console.log(
            `Auto-publish suppressed: ${blockingFlags.length} blocking review flag(s) on article ${args.articleId}`
          );
        } else if (preferences?.autoPublish) {
          await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
            articleId: args.articleId,
            status: "published",
          });
        }
      } catch (e) {
        console.warn("Failed to apply auto-publish preference", e);
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

      // Update scheduledContent final status on success
      try {
        if (args.scheduledContentId) {
          await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
            scheduledContentId: args.scheduledContentId,
            status: "completed",
            generatedContentId: args.articleId,
            generatedAt: Date.now(),
          });
        }
      } catch (e) {
        console.warn("Failed to update scheduled content status to completed", e);
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

      // If a caller deducted credits up front (createGenerationRequest,
      // regenerateContentWithCredits, processLeaguePayment's auto
      // season_welcome), refund them now — the user paid for content they
      // never received. Captured rather than swallowed: if the refund
      // itself fails, that's rethrown below (after the rest of the
      // failure-handling cleanup runs) instead of being logged and ignored.
      let refundError: unknown = null;
      if (args.creditsDeductedUpFront) {
        try {
          let creditUserId = args.userId;
          if (creditUserId === "system") {
            const league = await ctx.runQuery(internal.contentScheduling.getLeagueById, {
              leagueId: args.leagueId,
            });
            if (league?.commissionerUserId) {
              creditUserId = league.commissionerUserId;
            }
          }

          if (creditUserId !== "system") {
            await ctx.runMutation(internal.credits.refundCredits, {
              userId: creditUserId,
              amount: args.creditsDeductedUpFront,
              description: `Refund: failed AI content generation (${args.contentType})`,
              leagueId: args.leagueId,
              relatedContentId: args.articleId,
            });
          }
        } catch (e) {
          console.error("Failed to refund credits after generation failure:", e);
          refundError = e;
        }
      }

      // Update article to failed status
      await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
        articleId: args.articleId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Update scheduled content status to failed
      try {
        if (args.scheduledContentId) {
          await ctx.runMutation(internal.contentScheduling.updateScheduledContentStatus, {
            scheduledContentId: args.scheduledContentId,
            status: "failed",
            errorMessage: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } catch (e) {
        console.warn("Failed to update scheduled content status to failed", e);
      }

      // Schedule retry for mock drafts and weekly recaps. Never for an
      // InsufficientDataError: the data is missing, not flaky, and retrying
      // would burn the refund path three more times.
      if (
        !isInsufficientDataError(error) &&
        (args.contentType === 'mock_draft' || args.contentType === 'weekly_recap')
      ) {
        console.log(`Scheduling retry for failed ${args.contentType} generation`);
        await ctx.scheduler.runAfter(2000, internal.aiContentHelpers.retryFailedGeneration, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          seasonId: args.seasonId,
          week: args.week,
          retryCount: 1,
        });
      }

      if (refundError) {
        // Surface loudly instead of swallowing: the refund did not happen
        // and the user's balance needs manual reconciliation.
        throw new Error(
          `Generation failed for article ${args.articleId} and the credit refund also failed: ${
            refundError instanceof Error ? refundError.message : String(refundError)
          }`
        );
      }
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
        credits_used: template.creditCost,
      },
      status: "generating",
      createdAt: Date.now(),
    });

    return articleId;
  },
});

// Internal query for getLeagueDataForGeneration
export const getLeagueDataForGenerationInternal = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<LeagueDataContext> => {
    return getLeagueDataForGenerationHandler(ctx, args);
  },
});

// Shared handler function. Returns the prompt layer's LeagueDataContext: the
// enriched payload from aiQueries.getLeagueDataForAI, reshaped for generation.
async function getLeagueDataForGenerationHandler(
  ctx: any,
  args: { leagueId: any }
): Promise<LeagueDataContext> {
    console.log("=== getLeagueDataForGeneration START ===");
    console.log("League ID:", args.leagueId);
    
      // Use our enhanced query to get all enriched data
    const enrichedData = await ctx.runQuery(internal.aiQueries.getLeagueDataForAI, {
      leagueId: args.leagueId,
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
      
      // Matchup data
      recentMatchups: enrichedData.recentMatchups,
      
      // Transaction data
      trades: enrichedData.trades,
      transactions: enrichedData.transactions,
      transactionTrends: enrichedData.transactionTrends,
      
      // Rivalry data
      rivalries: enrichedData.rivalries,
      
      // Manager activity
      managerActivity: enrichedData.managerActivity,
      
      // Playoff probabilities
      playoffProbabilities: enrichedData.playoffProbabilities,
      
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
      // Explicit predictions the writer made (spec §8.4). Stored with
      // outcome "open" plus the byline, week and season below.
      claims: v.optional(v.array(generatedClaimValidator)),
    }),
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

    // Receipts (spec §8.4). The model emits the prediction; who made it, in which
    // week and season, and how it turned out are ours to stamp on. Everything
    // starts "open" - claims.resolveOpenClaims settles them weekly.
    const league = await ctx.db.get(article.leagueId);
    const season = leagueCurrentSeason(league);
    const claims = args.metadata.claims?.map((claim) => ({
      ...claim,
      week: claim.week ?? args.metadata.week,
      outcome: "open" as const,
      persona: article.persona,
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
      reviewFlags: args.metadata.reviewFlags,
      factsMissing: args.metadata.factsMissing,
      generationStats: verifierStats
        ? {
            ...verifierStats,
            promptTokens: args.metadata.promptTokens,
            completionTokens: args.metadata.completionTokens,
            modelUsed: args.metadata.modelUsed,
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
  args: { articleId: Id<"aiContent">; status: string; error?: string }
) {
  // Update the status and set publishedAt if publishing
  const update: Record<string, unknown> = { status: args.status };
  if (args.status === "published") {
    update.publishedAt = Date.now();
  }
  await ctx.db.patch(args.articleId, update);

  // Notify the league whenever an article transitions to published. This
  // covers both publish paths (the commissioner-gated updateContentStatus
  // mutation below, and the auto-publish branch inside
  // generateContentAction which calls updateContentStatusInternal) since
  // both funnel through this shared handler. Scheduled rather than run
  // inline so a notification/email failure can never block publishing.
  if (args.status === "published") {
    await ctx.scheduler.runAfter(0, internal.notifications.notifyArticlePublished, {
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