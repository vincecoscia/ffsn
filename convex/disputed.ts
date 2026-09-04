/**
 * Convex surface for "Disputed" — the desk's weekly debate show (see `src/lib/ai/disputed/`).
 *
 * The show is produced turn-by-turn by `disputedNode.produceEpisode` (a "use node" action, since
 * it calls the Anthropic SDK directly through `src/lib/ai/disputed`). This file holds the
 * default-runtime reads/writes that action needs: pulling recent manager quotes for the show's
 * FACTS block, creating the draft row before production starts, and reading a saved episode back.
 *
 * Kept separate from `disputedNode.ts` because "use node" files cannot export queries or
 * mutations (see convex/aiNode.ts's own header comment for the same split).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { commentResponseDataValidator, showTranscriptValidator } from "./validators";
import { quotesForResponse } from "./aiContentWithComments";
import { questionTopicFor, teamForUser } from "./lib/teamClaims";

/**
 * Every league quote the show can call on for the FACTS block, in the `CommentResponseData`
 * shape the FACTS builder expects (spec §4.2) — the same shape `aiContentHelpers.toCommentResponseData`
 * builds for an article, but scoped to a whole league across a recent window rather than to one
 * article's own comment thread.
 *
 * `commentResponses` carries a `by_league` index (used by `articleEngagement.getArticleQuotes`'s
 * cousin lookups), so this reads directly off it instead of walking `aiContent` /
 * `scheduledContent` rows to find responses indirectly. Bounded to the newest 100 league-wide
 * responses (an index-ordered `.take()`, never `.collect()`), then narrowed in memory to
 * `sinceWeeks` and to replies that actually carry a usable quote.
 */
export const getRecentQuotesForShow = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    sinceWeeks: v.optional(v.number()),
  },
  returns: v.array(commentResponseDataValidator),
  handler: async (ctx, args) => {
    const weeks = args.sinceWeeks ?? 2;
    const cutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;

    const responses = await ctx.db
      .query("commentResponses")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(100);

    const recent = responses.filter(
      (r) => r._creationTime >= cutoff && r.processedResponse && r.processedResponse.trim().length > 0
    );

    const built = await Promise.all(
      recent.map(async (response) => {
        const user = await ctx.db.get(response.userId);
        const team = await teamForUser(ctx, args.leagueId, user);
        const request = await ctx.db.get(response.commentRequestId);
        return {
          userId: response.userId as string,
          userName: user?.name?.trim() || "A league manager",
          teamId: (team?._id ?? "") as string,
          teamName: team?.name || "Unclaimed team",
          questionTopic: questionTopicFor(request, "the desk's question"),
          quotes: quotesForResponse(response),
          rawResponse: response.rawResponse,
        };
      })
    );

    // A manager who withdrew every quote is not a speaker (spec §8.1), same rule as
    // aiContentHelpers.getCommentResponsesForContent.
    return built.filter((entry) => entry.quotes.length > 0);
  },
});

/**
 * The draft row for one "Disputed" episode, created before production starts so the episode has
 * an id to attach progress and, eventually, the finished transcript to. Field shapes mirror what
 * `aiContent.createGenerationRequest` sets for an ordinary manual generation, so this row is valid
 * by the same schema — `status: "generating"` until `disputedNode.produceEpisode` finishes (or
 * marks it "failed").
 */
export const createShowDraft = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    week: v.optional(v.number()),
    seasonId: v.optional(v.number()),
    title: v.string(),
  },
  returns: v.id("aiContent"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("aiContent", {
      leagueId: args.leagueId,
      type: "desk_show",
      persona: "curtis-vaughn",
      title: args.title,
      content: "",
      metadata: {
        week: args.week,
        featured_teams: [],
        credits_used: 0,
      },
      status: "generating",
      createdAt: Date.now(),
      seasonId: args.seasonId,
    });
  },
});

/** One saved episode, for reading it back with `npx convex run disputed:getEpisode` and for tests. */
export const getEpisode = internalQuery({
  args: { articleId: v.id("aiContent") },
  returns: v.union(
    v.object({
      title: v.string(),
      status: v.string(),
      content: v.string(),
      transcript: v.optional(showTranscriptValidator),
      stats: v.optional(v.any()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) return null;
    return {
      title: article.title,
      status: article.status,
      content: article.content,
      transcript: article.transcript,
      stats: article.generationStats,
    };
  },
});
