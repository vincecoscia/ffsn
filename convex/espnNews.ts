/* eslint-disable @typescript-eslint/no-explicit-any */
import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal, api } from "./_generated/api";

// ESPN News API endpoint
const ESPN_NEWS_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/news";

// Helper to process categories and extract relevant data
function processCategories(categories: any[]) {
  const teams: any[] = [];
  const athletes: any[] = [];
  const leagues: any[] = [];
  let hasNFL = false;

  categories.forEach(category => {
    // Skip guid categories
    if (category.type === "guid") return;

    if (category.type === "team" && category.team) {
      teams.push({
        id: category.teamId || category.team.id,
        name: category.team.description || category.description,
        abbreviation: category.team.abbreviation,
      });
    } else if (category.type === "athlete" && category.athlete) {
      athletes.push({
        id: category.athleteId || category.athlete.id,
        name: category.athlete.description || category.description,
        position: category.athlete.position,
      });
    } else if (category.type === "league" && category.league) {
      const leagueId = category.leagueId || category.league.id;
      // Only include NFL league (ID: 28)
      if (leagueId === 28) {
        hasNFL = true;
        leagues.push({
          id: leagueId,
          name: category.league.description || category.description,
          abbreviation: category.league.abbreviation || undefined,
        });
      }
    }
  });

  return { teams, athletes, leagues, hasNFL };
}

// Helper to process images
function processImages(images: any[]) {
  if (!images || !Array.isArray(images)) return [];
  
  return images.map(img => ({
    id: img.id ? String(img.id) : undefined, // Convert number to string
    url: img.url,
    alt: img.alt,
    caption: img.caption,
    width: img.width,
    height: img.height,
  })).filter(img => img.url); // Only keep images with URLs
}

// Helper to extract clean links
function processLinks(links: any) {
  if (!links) return { web: undefined, mobile: undefined, api: undefined };
  
  return {
    web: links.web?.href,
    mobile: links.mobile?.href,
    api: links.api?.self?.href,
  };
}

export const fetchESPNNews = action({
  args: {
    limit: v.optional(v.number()),
    teamId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    try {
      const limit = args.limit || 50;
      const url = new URL(ESPN_NEWS_URL);
      url.searchParams.set("limit", limit.toString());
      
      if (args.teamId) {
        url.searchParams.set("team", args.teamId.toString());
      }

      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        throw new Error(`ESPN API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const articles = data.articles || [];

      // Process and clean articles
      const processedArticles = articles.map((article: any) => {
        const categoriesData = processCategories(article.categories || []);
        
        // Skip non-NFL articles
        if (!categoriesData.hasNFL) {
          return null;
        }
        
        return {
          espnId: String(article.id), // Ensure ID is string
          nowId: article.nowId ? String(article.nowId) : undefined,
          type: article.type || "Story",
          headline: article.headline,
          description: article.description,
          lastModified: article.lastModified,
          published: article.published,
          byline: article.byline,
          premium: article.premium || false,
          links: processLinks(article.links),
          images: processImages(article.images),
          categories: {
            teams: categoriesData.teams,
            athletes: categoriesData.athletes,
            leagues: categoriesData.leagues,
          },
        };
      }).filter((article: any) => article !== null && article.espnId && article.headline); // Filter out invalid and non-NFL articles

      return {
        success: true,
        articles: processedArticles,
        count: processedArticles.length,
      };
    } catch (error) {
      console.error("Failed to fetch ESPN news:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch ESPN news",
        articles: [],
        count: 0,
      };
    }
  },
});

// Fetch news with pagination support
export const fetchESPNNewsPaginated = action({
  args: {
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    teamId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // ESPN's news API doesn't have built-in pagination with offset
    // We'll fetch more items and slice them client-side if needed
    const totalLimit = (args.limit || 50) + (args.offset || 0);
    
    const result: any = await ctx.runAction(api.espnNews.fetchESPNNews, {
      limit: Math.min(totalLimit, 1000), // Cap at 1000 to avoid huge requests
      teamId: args.teamId,
    });

    if (result.success && result.articles) {
      const offset = args.offset || 0;
      const limit = args.limit || 50;
      const paginatedArticles = result.articles.slice(offset, offset + limit);
      
      return {
        ...result,
        articles: paginatedArticles,
        count: paginatedArticles.length,
        totalCount: result.articles.length,
        hasMore: result.articles.length > offset + limit,
      };
    }

    return result;
  },
});

// Sync news - fetch and store in one action
export const syncESPNNews = action({
  args: {
    limit: v.optional(v.number()),
    teamId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    try {
      // Fetch news from ESPN
      const fetchResult: any = await ctx.runAction(api.espnNews.fetchESPNNews, {
        limit: args.limit,
        teamId: args.teamId,
      });

      if (!fetchResult.success || !fetchResult.articles) {
        return {
          success: false,
          error: fetchResult.error || "No articles fetched",
          stored: 0,
        };
      }

      // Store the articles in the database
      const storeResult: any = await ctx.runMutation(api.news.storeNewsArticles, {
        articles: fetchResult.articles,
      });

      return {
        success: true,
        fetched: fetchResult.count,
        stored: storeResult.total,
        inserted: storeResult.inserted,
        updated: storeResult.updated,
      };
    } catch (error) {
      console.error("Failed to sync ESPN news:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to sync news",
        stored: 0,
      };
    }
  },
});

// Internal action for scheduled news sync
export const scheduledNewsSync = internalAction({
  handler: async (ctx): Promise<{
    success: boolean;
    fetched?: number;
    stored?: number;
    inserted?: number;
    updated?: number;
    error?: string;
  }> => {
    console.log("Starting scheduled ESPN news sync...");
    
    try {
      // Sync general NFL news
      const result = await ctx.runAction(api.espnNews.syncESPNNews, {
        limit: 100, // Fetch more articles during scheduled sync
      });

      if (result.success) {
        console.log(`Scheduled sync completed: ${result.inserted} new articles, ${result.updated} updated`);
      } else {
        console.error("Scheduled sync failed:", result.error);
      }

      // Optional: Clean up old articles (keep last 30 days)
      const cleanupResult = await ctx.runMutation(api.news.deleteOldArticles, {
        daysToKeep: 30,
      });

      if (cleanupResult.deleted > 0) {
        console.log(`Cleaned up ${cleanupResult.deleted} old articles`);
      }

      return result;
    } catch (error) {
      console.error("Scheduled news sync error:", error);
      throw error;
    }
  },
});