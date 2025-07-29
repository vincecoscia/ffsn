/* eslint-disable @typescript-eslint/no-explicit-any */
import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
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
    console.log("=== generateContentAction START ===");
    console.log("Content type:", args.contentType);
    console.log("Persona:", args.persona);
    console.log("Custom context provided:", !!args.customContext);
    
    try {
      // Gather league data
      const leagueData = await ctx.runQuery(api.aiContent.getLeagueDataForGeneration, {
        leagueId: args.leagueId,
      });
      
      console.log("=== LEAGUE DATA RECEIVED IN ACTION ===");
      console.log("League name:", leagueData.leagueName);
      console.log("Current teams:", leagueData.teams.length);
      console.log("Previous seasons available:", Object.keys(leagueData.previousSeasons || {}).length);
      
      // Log detailed data for season_welcome
      if (args.contentType === 'season_welcome' && leagueData.previousSeasons) {
        console.log("=== SEASON WELCOME DATA CHECK ===");
        Object.entries(leagueData.previousSeasons).forEach(([year, teams]) => {
          const teamsList = teams as any[];
          console.log(`Year ${year}: ${teamsList.length} teams`);
          if (teamsList[0]) {
            console.log(`  Sample team: ${teamsList[0].teamName} with ${teamsList[0].roster?.length || 0} players`);
          }
        });
      }
      
      // Log sample roster data
      if (leagueData.teams[0]?.roster?.length > 0) {
        console.log("Sample current roster player:", {
          name: leagueData.teams[0].roster[0].playerName,
          position: leagueData.teams[0].roster[0].position,
          hasStats: !!leagueData.teams[0].roster[0].stats,
          hasOwnership: !!leagueData.teams[0].roster[0].ownership,
        });
      }

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
      console.log("Featured teams:", generatedContent.metadata?.featuredTeams?.length || 0);
      console.log("Featured players:", generatedContent.metadata?.featuredPlayers?.length || 0);

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
    }
  },
});

// Query to get league data for generation - using enhanced data
export const getLeagueDataForGeneration = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<any> => {
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
      
      // League history
      leagueHistory: enrichedData.leagueHistory,
      
      // Additional metadata
      scoringType: enrichedData.league.settings?.scoringType || "PPR",
      rosterSize: enrichedData.league.settings?.rosterSize || 16,
      metadata: enrichedData.metadata,
      
      // Legacy fields for backward compatibility
      previousSeasons: {}, // Will be populated from league history if needed
    };
    
    console.log("=== FINAL LEAGUE DATA SUMMARY ===");
    console.log({
      leagueName: result.leagueName,
      currentWeek: result.currentWeek,
      currentTeams: result.teams.length,
      previousSeasons: Object.keys(result.previousSeasons).length,
      matchups: result.recentMatchups.length,
      trades: result.trades.length,
      leagueHistorySeasons: result.leagueHistory?.length || 0,
    });
    console.log("=== getLeagueDataForGeneration END ===");
    
    return result;
  },
});;;;

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
    await ctx.db.patch(args.articleId, {
      title: args.title,
      content: args.content,
      // Note: summary field doesn't exist in schema
      metadata: {
        week: args.metadata.week,
        featured_teams: args.metadata.featuredTeams as any, // Cast to match schema
        credits_used: args.metadata.creditsUsed,
      },
      status: "published",
      publishedAt: Date.now(),
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
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const update: any = { status: args.status };
    if (args.error) {
      update.error = args.error;
    }
    await ctx.db.patch(args.articleId, update);
  },
});