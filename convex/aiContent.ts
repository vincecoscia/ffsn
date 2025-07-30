/* eslint-disable @typescript-eslint/no-explicit-any */
import { query, mutation, action, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { generateAIContent } from "../src/lib/ai/content-generation-service";
import { contentTemplates } from "../src/lib/ai/content-templates";

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

    // Schedule the actual generation
    await ctx.scheduler.runAfter(0, api.aiContent.generateContentAction, {
      articleId,
      leagueId: args.leagueId,
      contentType: args.type,
      persona: args.persona,
      customContext: args.customContext,
      userId: identity.subject,
    });

    return articleId;
  },
});

// Action to handle the actual AI generation
export const generateContentAction = action({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    console.log("=== generateContentAction START (OPTIMIZED) ===");
    console.log("Content type:", args.contentType);
    console.log("Persona:", args.persona);
    
    try {
      // For mock drafts, use the new scheduled approach
      if (args.contentType === 'mock_draft') {
        console.log("Using scheduled approach for mock draft generation");
        
        // Schedule data preparation step (which will chain the generation step)
        await ctx.scheduler.runAfter(0, internal.aiContentHelpers.prepareAIContentData, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
        });
        
        console.log("Mock draft generation scheduled successfully");
        return;
      }
      
      // For other content types, use the existing approach
      console.log("Using standard approach for content type:", args.contentType);
      
      const leagueData = await ctx.runQuery(api.aiContent.getLeagueDataForGeneration, {
        leagueId: args.leagueId,
      });
      
      console.log("League data fetched successfully");
      
      // Get API key from environment
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY not configured");
      }

      console.log("Calling AI generation service...");
      
      // Call AI generation service
      const generatedContent = await generateAIContent({
        leagueId: args.leagueId,
        contentType: args.contentType,
        persona: args.persona,
        leagueData,
        customContext: args.customContext,
        userId: args.userId,
      }, apiKey);
      
      console.log("AI content generated successfully");
      console.log("Generated title:", generatedContent.title);
      console.log("Content length:", generatedContent.content.length);

      // Update the article with generated content
      await ctx.runMutation(api.aiContent.updateGeneratedContent, {
        articleId: args.articleId,
        title: generatedContent.title,
        content: generatedContent.content,
        summary: generatedContent.summary,
        metadata: generatedContent.metadata,
      });
      
      // Generate banner image if applicable
      const { shouldGenerateImage, generateArticleImage } = await import("../src/lib/ai/image-generator");
      
      const shouldGenerate = shouldGenerateImage(args.contentType);
      console.log(`Should generate image for ${args.contentType}:`, shouldGenerate);
      
      if (shouldGenerate) {
        console.log("Generating banner image for article type:", args.contentType);
        
        const openAIKey = process.env.OPENAI_API_KEY;
        if (!openAIKey) {
          console.warn("OPENAI_API_KEY not configured in Convex environment variables, skipping image generation");
          console.warn("To enable image generation, run: npx convex env set OPENAI_API_KEY \"your-api-key\"");
        } else {
          try {
            // Generate the image
            const imageBlob = await generateArticleImage({
              title: generatedContent.title,
              contentType: args.contentType,
              metadata: {
                week: generatedContent.metadata?.week,
                featuredTeams: generatedContent.metadata?.featuredTeams,
                featuredPlayers: generatedContent.metadata?.featuredPlayers,
              },
              persona: args.persona,
            }, openAIKey);
            
            // Store the image in Convex
            const storageId = await ctx.storage.store(imageBlob);
            console.log("Banner image stored with ID:", storageId);
            
            // Update article with banner image ID
            await ctx.runMutation(api.aiContent.storeBannerImage, {
              articleId: args.articleId,
              storageId,
            });
            
            console.log("Banner image successfully added to article");
          } catch (imageError) {
            console.error("Failed to generate/store banner image:", imageError);
            // Continue without image - don't fail the entire generation
          }
        }
      }
      
      console.log("=== generateContentAction SUCCESS ===");
    } catch (error) {
      console.error("=== generateContentAction ERROR ===");
      console.error("Content generation failed:", error);
      console.error("Error stack:", error instanceof Error ? error.stack : "No stack trace");
      
      // Update article to failed status
      await ctx.runMutation(api.aiContent.updateContentStatus, {
        articleId: args.articleId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      
      // Schedule retry for mock drafts
      if (args.contentType === 'mock_draft') {
        console.log("Scheduling retry for failed mock draft generation");
        await ctx.scheduler.runAfter(2000, internal.aiContentHelpers.retryFailedGeneration, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          retryCount: 1,
        });
      }
    }
  },
});;

// Internal query for getLeagueDataForGeneration
export const getLeagueDataForGenerationInternal = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<any> => {
    return getLeagueDataForGenerationHandler(ctx, args);
  },
});

// Query to get league data for generation - using enhanced data
export const getLeagueDataForGeneration = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<any> => {
    return getLeagueDataForGenerationHandler(ctx, args);
  },
});

// Shared handler function
async function getLeagueDataForGenerationHandler(ctx: any, args: { leagueId: any }): Promise<any> {
    console.log("=== getLeagueDataForGeneration START ===");
    console.log("League ID:", args.leagueId);
    
    // Use our enhanced query to get all enriched data
    const enrichedData = await ctx.runQuery(api.aiQueries.getLeagueDataForAI, {
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

// Mutation to update generated content
export const updateGeneratedContent = mutation({
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
    }),
  },
  handler: async (ctx, args) => {
    // Get the article to find the league
    const article = await ctx.db.get(args.articleId);
    if (!article) {
      throw new Error("Article not found");
    }

    // Convert team names to team IDs
    let featuredTeamIds: Id<"teams">[] = [];
    if (args.metadata.featuredTeams.length > 0) {
      // Get all teams for this league
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_league", (q) => q.eq("leagueId", article.leagueId))
        .collect();

      // Convert team names to IDs
      featuredTeamIds = args.metadata.featuredTeams
        .map(teamName => {
          // Try exact match first
          let team = teams.find(t => t.name.toLowerCase() === teamName.toLowerCase());
          
          // If no exact match, try partial match
          if (!team) {
            team = teams.find(t => 
              t.name.toLowerCase().includes(teamName.toLowerCase()) ||
              teamName.toLowerCase().includes(t.name.toLowerCase())
            );
          }
          
          // If still no match, try matching abbreviation
          if (!team && teamName.length <= 4) {
            team = teams.find(t => 
              t.abbreviation?.toLowerCase() === teamName.toLowerCase()
            );
          }
          
          return team?._id;
        })
        .filter((id): id is Id<"teams"> => id !== undefined); // Remove undefined values

      console.log(`Converted team names to IDs:`, {
        teamNames: args.metadata.featuredTeams,
        teamIds: featuredTeamIds,
        teamsInLeague: teams.map(t => ({ name: t.name, abbreviation: t.abbreviation, id: t._id }))
      });
    }

    await ctx.db.patch(args.articleId, {
      title: args.title,
      content: args.content,
      // Note: summary field doesn't exist in schema
      metadata: {
        week: args.metadata.week,
        featured_teams: featuredTeamIds, // Now using actual team IDs
        credits_used: args.metadata.creditsUsed,
      },
      status: "draft", // Set to draft for review instead of auto-publishing
      // publishedAt will be set when actually published
    });
  },
});

// Mutation to store banner image
export const storeBannerImage = mutation({
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

// Mutation to update content status
export const updateContentStatus = mutation({
  args: {
    articleId: v.id("aiContent"),
    status: v.string(),
    error: v.optional(v.string()), // We'll ignore this since it's not in schema
  },
  handler: async (ctx, args) => {
    // Update the status and set publishedAt if publishing
    const update: any = { status: args.status };
    if (args.status === "published") {
      update.publishedAt = Date.now();
    }
    await ctx.db.patch(args.articleId, update);
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