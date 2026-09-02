/**
 * Public-page engagement for articles: reader reactions and the "Locker Room"
 * manager quotes pulled in from the comment-request pipeline.
 *
 * Visibility mirrors aiContent.getById exactly: a published article is
 * readable by anyone (that's the whole point of the public /articles/[id]
 * page); anything else (draft, generating, waiting_for_comments, failed,
 * etc.) is only visible to members of the owning league.
 */
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { getLeagueMembership, requireIdentity } from "./lib/auth";

const REACTIONS = ["fire", "lol", "salty", "respect"] as const;
type Reaction = (typeof REACTIONS)[number];
const reactionValidator = v.union(
  v.literal("fire"),
  v.literal("lol"),
  v.literal("salty"),
  v.literal("respect")
);

function emptyCounts(): Record<Reaction, number> {
  return REACTIONS.reduce(
    (acc, reaction) => ({ ...acc, [reaction]: 0 }),
    {} as Record<Reaction, number>
  );
}

/** Same rule as aiContent.getById: published -> anyone, otherwise members only. */
async function canViewArticle(
  ctx: Parameters<typeof getLeagueMembership>[0],
  article: Doc<"aiContent">
): Promise<boolean> {
  if (article.status === "published") return true;
  const membership = await getLeagueMembership(ctx, article.leagueId);
  return membership !== null;
}

// ===============================
// Feature A: reactions
// ===============================

export const getReactionSummary = query({
  args: { articleId: v.id("aiContent") },
  handler: async (ctx, args) => {
    const empty = { counts: emptyCounts(), mine: null as Reaction | null, total: 0 };

    const article = await ctx.db.get(args.articleId);
    if (!article) return empty;
    if (!(await canViewArticle(ctx, article))) return empty;

    const reactions = await ctx.db
      .query("articleReactions")
      .withIndex("by_article", (q) => q.eq("articleId", args.articleId))
      .collect();

    const counts = emptyCounts();
    for (const r of reactions) {
      counts[r.reaction]++;
    }

    const identity = await ctx.auth.getUserIdentity();
    const mine = identity
      ? reactions.find((r) => r.userId === identity.subject)?.reaction ?? null
      : null;

    return { counts, mine, total: reactions.length };
  },
});

export const toggleReaction = mutation({
  args: {
    articleId: v.id("aiContent"),
    reaction: reactionValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);

    const article = await ctx.db.get(args.articleId);
    if (!article) {
      throw new Error("Article not found");
    }
    if (!(await canViewArticle(ctx, article))) {
      throw new Error("Not authorized: you are not a member of this league");
    }

    const existing = await ctx.db
      .query("articleReactions")
      .withIndex("by_article_user", (q) =>
        q.eq("articleId", args.articleId).eq("userId", identity.subject)
      )
      .first();

    if (existing) {
      if (existing.reaction === args.reaction) {
        // Tapping the same reaction again removes it.
        await ctx.db.delete(existing._id);
        return { mine: null as Reaction | null };
      }
      // A different reaction replaces the old one (one reaction per user).
      await ctx.db.patch(existing._id, { reaction: args.reaction });
      return { mine: args.reaction };
    }

    await ctx.db.insert("articleReactions", {
      articleId: args.articleId,
      userId: identity.subject,
      reaction: args.reaction,
      createdAt: Date.now(),
    });
    return { mine: args.reaction };
  },
});

// ===============================
// Feature C: Locker Room (manager quotes)
// ===============================

export const getArticleQuotes = query({
  args: { articleId: v.id("aiContent") },
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) return [];
    if (!(await canViewArticle(ctx, article))) return [];

    // Manually-generated "wait for comments" articles (aiContent.ts's
    // createGenerationWithComments) link commentResponses straight back to
    // the article via manualContentId.
    const manualResponses = await ctx.db
      .query("commentResponses")
      .withIndex("by_manual_content", (q) => q.eq("manualContentId", args.articleId))
      .collect();

    // Scheduled/cron-generated articles (contentScheduling -> scheduledContent)
    // have no direct link on commentResponses: the request/response only know
    // their scheduledContentId, and scheduledContent.generatedContentId is
    // set to this article once generation completes. Find those
    // scheduledContent rows first, scoped by league to use an existing index.
    const scheduledMatches = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league", (q) => q.eq("leagueId", article.leagueId))
      .filter((q) => q.eq(q.field("generatedContentId"), args.articleId))
      .collect();

    const scheduledResponses = (
      await Promise.all(
        scheduledMatches.map((sc) =>
          ctx.db
            .query("commentResponses")
            .withIndex("by_scheduled_content", (q) => q.eq("scheduledContentId", sc._id))
            .collect()
        )
      )
    ).flat();

    const allResponses = [...manualResponses, ...scheduledResponses];

    const quotes = await Promise.all(
      allResponses
        // processedResponse is the cleaned/quotable text (see
        // commentConversations.processCompletedResponse); rawResponse and
        // aiContext are internal to the generation pipeline and never shown.
        .filter((r) => r.processedResponse && r.processedResponse.trim().length > 0)
        .map(async (r) => {
          const user = await ctx.db.get(r.userId);
          if (!user) return null;

          // Mirrors aiContentWithComments.getUserTeam: users -> clerkId ->
          // active teamClaims row for this league -> team name.
          let teamName: string | null = null;
          if (user.clerkId) {
            const teamClaim = await ctx.db
              .query("teamClaims")
              .withIndex("by_user", (q) => q.eq("userId", user.clerkId))
              .filter((q) =>
                q.and(
                  q.eq(q.field("leagueId"), article.leagueId),
                  q.eq(q.field("status"), "active")
                )
              )
              .first();
            if (teamClaim) {
              const team = await ctx.db.get(teamClaim.teamId);
              teamName = team?.name ?? null;
            }
          }

          return {
            userName: user.name || "A league manager",
            teamName,
            quote: r.processedResponse.trim(),
            respondedAt: r.processedAt,
          };
        })
    );

    return quotes
      .filter((q): q is NonNullable<typeof q> => q !== null)
      .sort((a, b) => a.respondedAt - b.respondedAt);
  },
});
