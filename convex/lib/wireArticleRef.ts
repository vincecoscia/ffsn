/**
 * The Wire — resolves an `article_published` post's `dedupeKey` back to its `aiContent` row (owner,
 * 2026-09-06). `onArticlePublished` (`convex/wireRoutine.ts`) stamps `dedupeKey: "article:<id>"` on
 * the `wireLeaguePosts` row it inserts; the row itself carries no `articleId` field, so this is the
 * only link back to the article. Used by `convex/wire.ts` and `convex/wireDigest.ts` to let the
 * frontend render the article as a linked card instead of the old inline "/articles/<id>" text.
 */

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

const ARTICLE_DEDUPE_PREFIX = "article:";

/**
 * `undefined` unless `dedupeKey` is an `article_published` post's key AND the article it names
 * still exists AND is published - a draft or since-deleted article is never surfaced as a link.
 */
export async function articleRefFor(
  ctx: QueryCtx,
  dedupeKey: string
): Promise<{ id: string; title: string; persona?: string } | undefined> {
  if (!dedupeKey.startsWith(ARTICLE_DEDUPE_PREFIX)) return undefined;
  const rawId = dedupeKey.slice(ARTICLE_DEDUPE_PREFIX.length);
  const articleId = ctx.db.normalizeId("aiContent", rawId) as Id<"aiContent"> | null;
  if (!articleId) return undefined;

  const article = await ctx.db.get(articleId);
  if (!article || article.status !== "published") return undefined;

  return { id: article._id, title: article.title, persona: article.persona };
}
