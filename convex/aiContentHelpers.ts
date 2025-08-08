import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { generateAIContent } from "../src/lib/ai/content-generation-service";
import { CommentResponseData } from "../src/lib/ai/comment-integration";
import { Id } from "./_generated/dataModel";

// Step 1: Fetch and prepare data for AI generation
export const prepareAIContentData = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("=== prepareAIContentData START ===");
    const startTime = Date.now();
    
    try {
      // Fetch data based on content type
      let leagueData;
      
      if (args.contentType === 'mock_draft') {
        console.log("Fetching mock draft data...");
        
        const mockDraftData = await ctx.runQuery(api.aiQueries.getMockDraftDataForAI, {
          leagueId: args.leagueId,
        });
        
        // Convert to expected format (simplified)
        leagueData = {
          leagueName: mockDraftData.leagueName,
          currentWeek: 0,
          currentSeason: mockDraftData.seasonId,
          teams: mockDraftData.teams,
          scoringType: mockDraftData.scoringType,
          rosterSize: mockDraftData.rosterSize,
          totalTeams: mockDraftData.totalTeams,
          draftOrder: mockDraftData.draftOrder,
          draftType: mockDraftData.draftType,
          leagueType: mockDraftData.leagueType,
          availablePlayers: mockDraftData.availablePlayers,
          playerCount: mockDraftData.playerCount,
          metadata: mockDraftData.metadata,
          // Empty arrays for non-draft content
          recentMatchups: [],
          trades: [],
          transactions: [],
          rivalries: [],
          managerActivity: [],
          standings: [],
        };
      } else if (args.contentType === 'season_welcome') {
        console.log("Fetching season welcome data...");
        
        const seasonWelcomeData = await ctx.runQuery(api.aiQueries.getSeasonWelcomeDataForAI, {
          leagueId: args.leagueId,
        });
        
        leagueData = seasonWelcomeData;
      } else if (args.contentType === 'waiver_wire_report') {
        console.log("Fetching waiver wire data...");
        
        const waiverWireData = await ctx.runQuery(api.aiQueries.getWaiverWireDataForAI, {
          leagueId: args.leagueId,
        });
        
        leagueData = waiverWireData;
      } else if (args.contentType === 'trade_analysis') {
        console.log("Fetching trade analysis data...");
        
        const tradeAnalysisData = await ctx.runQuery(api.aiQueries.getTradeAnalysisDataForAI, {
          leagueId: args.leagueId,
        });
        
        leagueData = tradeAnalysisData;
      } else if (args.contentType === 'weekly_recap') {
        console.log("Fetching weekly recap data...");
        
        if (!args.seasonId || !args.week) {
          throw new Error("seasonId and week are required for weekly_recap content");
        }
        
        const weeklyRecapData = await ctx.runQuery(api.aiQueries.getWeeklyRecapDataForAI, {
          leagueId: args.leagueId,
          seasonId: args.seasonId,
          week: args.week,
        });
        
        leagueData = weeklyRecapData;
      } else {
        // Regular content generation
        leagueData = await ctx.runQuery(api.aiContent.getLeagueDataForGeneration, {
          leagueId: args.leagueId,
        });
      }
      
      const executionTime = Date.now() - startTime;
      console.log("Data preparation completed in", executionTime + "ms");
      
      // Store prepared data for next step
      await ctx.runMutation(internal.aiContentHelpers.storePreparedData, {
        articleId: args.articleId,
        leagueData,
        executionTime,
      });
      
      // Schedule the next step after data is prepared
      await ctx.scheduler.runAfter(0, internal.aiContentHelpers.generateAIContentWithData, {
        articleId: args.articleId,
        leagueId: args.leagueId,
        contentType: args.contentType,
        persona: args.persona,
        customContext: args.customContext,
        userId: args.userId,
      });
      
      console.log("=== prepareAIContentData SUCCESS ===");
      return { success: true, executionTime };
      
    } catch (error) {
      console.error("=== prepareAIContentData ERROR ===");
      console.error("Error:", error);
      
      // Update article status to failed
      await ctx.runMutation(api.aiContent.updateContentStatus, {
        articleId: args.articleId,
        status: "failed",
        error: error instanceof Error ? error.message : "Data preparation failed",
      });
      
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  },
});

// Step 2: Generate AI content with prepared data
export const generateAIContentWithData = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    console.log("=== generateAIContentWithData START ===");
    const startTime = Date.now();
    
    try {
      // Retrieve prepared data
      const preparedData = await ctx.runQuery(internal.aiContentHelpers.getPreparedData, {
        articleId: args.articleId,
      });
      
      if (!preparedData || !preparedData.leagueData) {
        throw new Error("No prepared data found for article");
      }
      
      console.log("Retrieved prepared data, generating content...");
      
      // Get API key
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY not configured");
      }
      
      // Generate content without timeout - similar to Season Welcome Package
      console.log(`Generating AI content for ${args.contentType} without timeout...`);
      
      const generatedContent = await generateAIContent({
        leagueId: args.leagueId,
        contentType: args.contentType,
        persona: args.persona,
        leagueData: preparedData.leagueData,
        customContext: args.customContext,
        userId: args.userId,
      }, apiKey);
      
      const executionTime = Date.now() - startTime;
      console.log("AI generation completed in", executionTime + "ms");
      
      // Update article with generated content
      await ctx.runMutation(api.aiContent.updateGeneratedContent, {
        articleId: args.articleId,
        title: generatedContent.title,
        content: generatedContent.content,
        summary: generatedContent.summary,
        metadata: generatedContent.metadata,
      });
      
      // Clean up prepared data
      await ctx.runMutation(internal.aiContentHelpers.cleanupPreparedData, {
        articleId: args.articleId,
      });
      
      console.log("=== generateAIContentWithData SUCCESS ===");
      return { success: true, executionTime };
      
    } catch (error) {
      console.error("=== generateAIContentWithData ERROR ===");
      console.error("Error:", error);
      
      // Update article status to failed
      await ctx.runMutation(api.aiContent.updateContentStatus, {
        articleId: args.articleId,
        status: "failed",
        error: error instanceof Error ? error.message : "AI generation failed",
      });
      
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  },
});

// Internal mutations for data management
export const storePreparedData = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    leagueData: v.any(),
    executionTime: v.number(),
  },
  handler: async (ctx, args) => {
    // Store in a temporary field on the article
    await ctx.db.patch(args.articleId, {
      tempGenerationData: {
        leagueData: args.leagueData,
        preparedAt: Date.now(),
        preparationTime: args.executionTime,
      },
    });
  },
});

// Fetch comment responses for a scheduled content
export const getCommentResponsesForContent = internalQuery({
  args: {
    scheduledContentId: v.optional(v.id("scheduledContent")),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    week: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CommentResponseData[]> => {
    if (!args.scheduledContentId) {
      return [];
    }

    // Get comment responses for this scheduled content
    const responses = await ctx.db
      .query("commentResponses")
      .withIndex("by_scheduled_content", q => 
        q.eq("scheduledContentId", args.scheduledContentId!)
      )
      .filter(q => 
        q.and(
          q.eq(q.field("integrationStatus"), "pending"),
          q.gte(q.field("relevanceMetadata.qualityScore"), 50)
        )
      )
      .collect();

    // Enrich with user and team data
    const enrichedResponses = await Promise.all(
      responses.map(async (response) => {
        const user = await ctx.db.get(response.userId);
        const team = await ctx.db
          .query("teams")
          .withIndex("by_league", q => 
            q.eq("leagueId", args.leagueId)
          )
          .filter(q => q.eq(q.field("owner"), response.userId))
          .first();

        return {
          userId: response.userId,
          userName: user?.name,
          teamName: team?.name,
          rawResponse: response.rawResponse,
          processedResponse: response.processedResponse,
          responseType: response.responseType,
          relevanceMetadata: {
            topicRelevance: response.relevanceMetadata.topicRelevance,
            qualityScore: response.relevanceMetadata.qualityScore,
            extractedQuotes: response.relevanceMetadata.extractedQuotes,
            keyInsights: response.relevanceMetadata.keyInsights,
          },
        } as CommentResponseData;
      })
    );

    // Sort by quality score descending
    return enrichedResponses.sort((a, b) => 
      b.relevanceMetadata.qualityScore - a.relevanceMetadata.qualityScore
    );
  },
});

export const getPreparedData = internalQuery({
  args: {
    articleId: v.id("aiContent"),
  },
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    return article?.tempGenerationData || null;
  },
});

export const cleanupPreparedData = internalMutation({
  args: {
    articleId: v.id("aiContent"),
  },
  handler: async (ctx, args) => {
    // Remove temporary data
    await ctx.db.patch(args.articleId, {
      tempGenerationData: undefined,
    });
  },
});

// Retry handler for failed steps
export const retryFailedGeneration = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    retryCount: v.number(),
  },
  handler: async (ctx, args) => {
    console.log(`=== Retry attempt ${args.retryCount} for article ${args.articleId} ===`);
    
    if (args.retryCount > 3) {
      console.error("Max retry attempts exceeded");
      await ctx.runMutation(api.aiContent.updateContentStatus, {
        articleId: args.articleId,
        status: "failed",
        error: "Max retry attempts exceeded",
      });
      return;
    }
    
    // Wait before retry (exponential backoff)
    const waitTime = Math.pow(2, args.retryCount) * 1000;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // Retry the generation process
    await ctx.runAction(internal.aiContent.generateContentAction, {
      articleId: args.articleId,
      leagueId: args.leagueId,
      contentType: args.contentType,
      persona: args.persona,
      customContext: args.customContext,
      userId: args.userId,
      seasonId: args.seasonId,
      week: args.week,
    });
  },
});