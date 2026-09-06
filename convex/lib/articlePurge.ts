/**
 * Delete an article and everything that points at it (owner ask, 2026-09-06: the first Season
 * Kickoff had to go, and `aiContent.deleteContent` only removed the row - leaving reader reactions,
 * the relationship-ledger rows its manager mentions wrote, and Mel's "NEW PIECE" Wire post whose
 * link would 404). Shared by that public mutation and `adminTools.purgeArticle` (the operator's
 * CLI path for a published article on prod).
 *
 * What goes: `articleReactions` (by_article), `relationshipEvents` (by_article - the meter moves
 * back, since the article that moved it no longer exists), every `wireLeaguePosts` row keyed
 * `article:<id>` (the routine "article published" post) with its thread replies (by_root) and
 * their `wireReactions` (postKey `league:<postId>`), then the article itself. What stays: credit
 * ledger rows (`relatedContentId` - money moved), desk notices and scheduled rows (history of
 * what ran), comment requests (the interviews happened). Bounded: every read is an indexed
 * range with `.take()`; an article has at most one routine post and a handful of replies.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export interface PurgeArticleResult {
  found: boolean;
  dryRun: boolean;
  reactions: number;
  relationshipEvents: number;
  wirePosts: number;
  wireReplies: number;
  wireReactions: number;
}

const TAKE = 500;

async function deleteWireReactions(ctx: MutationCtx, postKey: string, dryRun: boolean): Promise<number> {
  const rows = await ctx.db
    .query("wireReactions")
    .withIndex("by_post", (q) => q.eq("postKey", postKey))
    .take(TAKE);
  if (!dryRun) for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

export async function purgeArticle(
  ctx: MutationCtx,
  articleId: Id<"aiContent">,
  opts: { dryRun: boolean }
): Promise<PurgeArticleResult> {
  const { dryRun } = opts;
  const result: PurgeArticleResult = {
    found: false,
    dryRun,
    reactions: 0,
    relationshipEvents: 0,
    wirePosts: 0,
    wireReplies: 0,
    wireReactions: 0,
  };
  const article = await ctx.db.get(articleId);
  if (!article) return result;
  result.found = true;

  const reactions = await ctx.db
    .query("articleReactions")
    .withIndex("by_article", (q) => q.eq("articleId", articleId))
    .take(TAKE);
  result.reactions = reactions.length;
  if (!dryRun) for (const row of reactions) await ctx.db.delete(row._id);

  const events = await ctx.db
    .query("relationshipEvents")
    .withIndex("by_article", (q) => q.eq("articleId", articleId))
    .take(TAKE);
  result.relationshipEvents = events.length;
  if (!dryRun) for (const row of events) await ctx.db.delete(row._id);

  // The routine Wire post about this article (wireRoutine.ts#onArticlePublished keys it
  // `article:<id>`), its thread and the reactions on both.
  const posts: Doc<"wireLeaguePosts">[] = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_league_dedupe", (q) => q.eq("leagueId", article.leagueId).eq("dedupeKey", `article:${articleId}`))
    .take(10);
  for (const post of posts) {
    const replies = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_root", (q) => q.eq("leagueId", article.leagueId).eq("rootId", post._id))
      .take(TAKE);
    for (const reply of replies) {
      if (reply._id === post._id) continue;
      result.wireReactions += await deleteWireReactions(ctx, `league:${reply._id}`, dryRun);
      result.wireReplies++;
      if (!dryRun) await ctx.db.delete(reply._id);
    }
    result.wireReactions += await deleteWireReactions(ctx, `league:${post._id}`, dryRun);
    result.wirePosts++;
    if (!dryRun) await ctx.db.delete(post._id);
  }

  if (!dryRun) await ctx.db.delete(articleId);
  return result;
}
