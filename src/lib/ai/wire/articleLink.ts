// The Wire — article link helper (owner, 2026-09-06). Dependency-free, like types.ts, so both the
// Convex default runtime and the browser can import it.
//
// Stock lines used to print the raw "/articles/<id>" path inline (see stock-lines.ts's
// article_published lines before this change); the frontend now renders the article as a linked
// card under the post instead, so new posts never carry the path in their stored `text`. Rows
// written before this change still do, so `stripArticlePaths` stays useful as a render-time
// fallback for that old text, and `extractArticleId` is how a caller (Convex's `articleRefFor`, or
// the frontend for old rows) finds the id in the first place.

/** Matches one "/articles/<id>" path. Convex ids are longer than 10 chars in practice; the floor
 *  just keeps this from matching an unrelated short "/articles/x"-shaped string. */
export const ARTICLE_PATH_RE = /\/articles\/[a-zA-Z0-9]{10,}/;

/** The article id in the first "/articles/<id>" match in `text`, or undefined if there is none.
 *  Uses a fresh non-global match rather than a global regex's stateful `lastIndex`. */
export function extractArticleId(text: string): string | undefined {
  const match = text.match(ARTICLE_PATH_RE);
  if (!match) return undefined;
  return match[0].slice("/articles/".length);
}

/**
 * Removes an "/articles/<id>" path from `text`, along with the punctuation or "Link:" wrapper
 * stock lines used to dress it in, and collapses the whitespace left behind. Order matters: each
 * rule is a global replace over the whole string, applied in sequence, because a later rule would
 * mishandle what an earlier one is meant to catch (e.g. "Link: {url}." must be consumed before the
 * bare-colon rule would turn its colon into a stray period).
 */
export function stripArticlePaths(text: string): string {
  let out = text;

  // 1. An explicit "Link: " (case-insensitive), the path, and its own trailing period if present -
  //    delete the whole thing. Leaves whatever punctuation already existed on either side alone.
  out = out.replace(new RegExp(`link:\\s*${ARTICLE_PATH_RE.source}\\.?`, "gi"), "");

  // 2. A bare ":" immediately before the path (no "Link" word - the colon was already introducing
  //    the URL as a clause) plus the path plus its trailing period - collapse to a single "." that
  //    terminates the clause where the colon was.
  out = out.replace(new RegExp(`:\\s*${ARTICLE_PATH_RE.source}\\.?`, "g"), ".");

  // 3. Catch-all: any remaining path, with any leading whitespace and its own trailing period -
  //    delete entirely. Covers the common ". /articles/x. " mid-sentence case and the trailing
  //    " /articles/x." end-of-string case.
  out = out.replace(new RegExp(`\\s*${ARTICLE_PATH_RE.source}\\.?`, "g"), "");

  // 4. Collapse doubled whitespace left behind by the deletions above, and trim.
  return out.replace(/\s{2,}/g, " ").trim();
}
