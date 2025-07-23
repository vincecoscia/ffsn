import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { generateAIContent } from "../src/lib/ai/content-generation-service";
import { contentTemplates } from "../src/lib/ai/content-templates";

export const getByLeague = query({
  args: { leagueId: v.id("leagues") },
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

    const content = await ctx.db
      .query("aiContent")
      .withIndex("by_league_published", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("status"), "published"))
      .order("desc")
      .take(10);

    return content;
  },
});
export const getById = query({
  args: {
    articleId: v.id("aiContent"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.articleId);
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
    try {
      // Gather league data
      const leagueData = await ctx.runQuery(api.aiContent.getLeagueDataForGeneration, {
        leagueId: args.leagueId,
      });

      // Get API key from environment
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY not configured");
      }

      // Call AI generation service
      const generatedContent = await generateAIContent({
        leagueId: args.leagueId,
        contentType: args.contentType,
        persona: args.persona,
        leagueData,
        customContext: args.customContext,
        userId: args.userId,
      }, apiKey);

      // Update the article with generated content
      await ctx.runMutation(api.aiContent.updateGeneratedContent, {
        articleId: args.articleId,
        title: generatedContent.title,
        content: generatedContent.content,
        summary: generatedContent.summary,
        metadata: generatedContent.metadata,
      });
    } catch (error) {
      console.error("Content generation failed:", error);
      
      // Update article to failed status
      await ctx.runMutation(api.aiContent.updateContentStatus, {
        articleId: args.articleId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
});

// Query to get league data for generation
export const getLeagueDataForGeneration = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      throw new Error("League not found");
    }

    // Get teams for current season (2025)
    const currentYear = new Date().getFullYear();
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", currentYear))
      .collect();

    // Get recent matchups for current season (if available)
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", currentYear))
      .order("desc")
      .take(10);

    // Note: trades table doesn't exist in schema, so we'll return empty array
    const trades: any[] = [];

    // Build league data context
    return {
      leagueName: league.name,
      currentWeek: league.espnData?.currentScoringPeriod || 1,
      teams: teams.map(team => ({
        id: team._id,
        name: team.name,
        manager: team.owner,
        record: team.record,
        pointsFor: team.record.pointsFor || 0,
        pointsAgainst: team.record.pointsAgainst || 0,
        externalId: team.externalId, // ESPN team ID for consistency tracking across seasons
      })),
      recentMatchups: matchups.map(m => ({
        teamA: m.homeTeamId,
        teamB: m.awayTeamId,
        scoreA: m.homeScore,
        scoreB: m.awayScore,
        topPerformers: [], // No player performance data in matchups table
      })),
      trades: trades.map(t => ({
        teamA: t.teamA,
        teamB: t.teamB,
        playersFromA: t.playersFromA || [],
        playersFromB: t.playersFromB || [],
        date: new Date(t.createdAt).toLocaleDateString(),
      })),
      scoringType: league.settings?.scoringType || "PPR",
      rosterSize: league.settings?.rosterSize || 16,
    };
  },
});

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