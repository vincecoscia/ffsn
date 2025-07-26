import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Store news articles (upsert based on espnId)
export const storeNewsArticles = mutation({
  args: {
    articles: v.array(v.object({
      espnId: v.string(),
      nowId: v.optional(v.string()),
      type: v.string(),
      headline: v.string(),
      description: v.optional(v.string()),
      lastModified: v.string(),
      published: v.string(),
      byline: v.optional(v.string()),
      premium: v.boolean(),
      links: v.object({
        web: v.optional(v.string()),
        mobile: v.optional(v.string()),
        api: v.optional(v.string()),
      }),
      images: v.array(v.object({
        id: v.optional(v.string()),
        url: v.string(),
        alt: v.optional(v.string()),
        caption: v.optional(v.string()),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
      })),
      categories: v.object({
        teams: v.array(v.object({
          id: v.number(),
          name: v.string(),
          abbreviation: v.optional(v.string()),
        })),
        athletes: v.array(v.object({
          id: v.number(),
          name: v.string(),
          position: v.optional(v.string()),
        })),
        leagues: v.array(v.object({
          id: v.number(),
          name: v.string(),
          abbreviation: v.string(),
        })),
      }),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    for (const article of args.articles) {
      // Check if article already exists
      const existing = await ctx.db
        .query("espnNews")
        .withIndex("by_espn_id", q => q.eq("espnId", article.espnId))
        .first();

      if (existing) {
        // Update if the article has been modified
        if (existing.lastModified !== article.lastModified) {
          await ctx.db.patch(existing._id, {
            ...article,
            updatedAt: now,
          });
          updated++;
        }
      } else {
        // Insert new article
        await ctx.db.insert("espnNews", {
          ...article,
          createdAt: now,
          updatedAt: now,
        });
        inserted++;
      }
    }

    return { inserted, updated, total: inserted + updated };
  },
});

// Get latest news with pagination
export const getLatestNews = query({
  args: {
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    teamId: v.optional(v.number()),
    athleteId: v.optional(v.number()),
    onlyNonPremium: v.optional(v.boolean()),
    type: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 20;
    const offset = args.offset || 0;

    let newsQuery = ctx.db
      .query("espnNews")
      .withIndex("by_published")
      .order("desc");

    // Get all articles first for filtering
    const allArticles = await newsQuery.collect();

    // Filter articles based on criteria
    let filteredArticles = allArticles;

    if (args.teamId !== undefined) {
      filteredArticles = filteredArticles.filter(article => 
        article.categories.teams.some(team => team.id === args.teamId)
      );
    }

    if (args.athleteId !== undefined) {
      filteredArticles = filteredArticles.filter(article =>
        article.categories.athletes.some(athlete => athlete.id === args.athleteId)
      );
    }

    if (args.onlyNonPremium) {
      filteredArticles = filteredArticles.filter(article => !article.premium);
    }

    if (args.type !== undefined) {
      filteredArticles = filteredArticles.filter(article => article.type === args.type);
    }

    // Apply pagination
    const paginatedArticles = filteredArticles.slice(offset, offset + limit);

    return {
      articles: paginatedArticles,
      totalCount: filteredArticles.length,
      hasMore: filteredArticles.length > offset + limit,
    };
  },
});

// Get a single news article by ID
export const getNewsArticle = query({
  args: {
    espnId: v.string(),
  },
  handler: async (ctx, args) => {
    const article = await ctx.db
      .query("espnNews")
      .withIndex("by_espn_id", q => q.eq("espnId", args.espnId))
      .first();

    return article;
  },
});

// Get news by team
export const getNewsByTeam = query({
  args: {
    teamId: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 10;

    // Get all news and filter by team
    const allNews = await ctx.db
      .query("espnNews")
      .withIndex("by_published")
      .order("desc")
      .collect();

    const teamNews = allNews
      .filter(article => 
        article.categories.teams.some(team => team.id === args.teamId)
      )
      .slice(0, limit);

    return teamNews;
  },
});

// Get news by athlete
export const getNewsByAthlete = query({
  args: {
    athleteId: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 10;

    // Get all news and filter by athlete
    const allNews = await ctx.db
      .query("espnNews")
      .withIndex("by_published")
      .order("desc")
      .collect();

    const athleteNews = allNews
      .filter(article =>
        article.categories.athletes.some(athlete => athlete.id === args.athleteId)
      )
      .slice(0, limit);

    return athleteNews;
  },
});

// Get news stats
export const getNewsStats = query({
  handler: async (ctx) => {
    const allNews = await ctx.db.query("espnNews").collect();
    
    const totalArticles = allNews.length;
    const premiumArticles = allNews.filter(a => a.premium).length;
    const freeArticles = totalArticles - premiumArticles;
    
    // Get unique teams and athletes
    const uniqueTeams = new Set<number>();
    const uniqueAthletes = new Set<number>();
    
    allNews.forEach(article => {
      article.categories.teams.forEach(team => uniqueTeams.add(team.id));
      article.categories.athletes.forEach(athlete => uniqueAthletes.add(athlete.id));
    });

    // Get latest and oldest articles
    const sortedByDate = [...allNews].sort((a, b) => 
      new Date(b.published).getTime() - new Date(a.published).getTime()
    );
    
    const latestArticle = sortedByDate[0];
    const oldestArticle = sortedByDate[sortedByDate.length - 1];

    return {
      totalArticles,
      premiumArticles,
      freeArticles,
      uniqueTeams: uniqueTeams.size,
      uniqueAthletes: uniqueAthletes.size,
      latestArticleDate: latestArticle?.published,
      oldestArticleDate: oldestArticle?.published,
    };
  },
});

// Delete old articles (cleanup)
export const deleteOldArticles = mutation({
  args: {
    daysToKeep: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - args.daysToKeep);
    const cutoffDateStr = cutoffDate.toISOString();

    const oldArticles = await ctx.db
      .query("espnNews")
      .filter(q => q.lt(q.field("published"), cutoffDateStr))
      .collect();

    let deleted = 0;
    for (const article of oldArticles) {
      await ctx.db.delete(article._id);
      deleted++;
    }

    return { deleted };
  },
});