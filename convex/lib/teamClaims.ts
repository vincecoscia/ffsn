/**
 * Shared manager <-> team helpers for Convex functions.
 *
 * `teamClaims.userId` is a Clerk id (never a `users` document id) and `teams.owner` is an ESPN
 * owner string that must never be compared to a Convex user id. Every caller that needs to go
 * from a manager to their claimed team (or back) should use these instead of reimplementing the
 * `users` -> Clerk id -> `teamClaims` -> `teams` join, same style as `convex/lib/auth.ts`.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type DbCtx = QueryCtx | MutationCtx;

/** Resolve a Clerk subject to the `users` row it belongs to. */
export async function userByClerkId(
  ctx: DbCtx,
  clerkId: string
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
    .unique();
}

/**
 * Manager -> team for a league, via `teamClaims` (whose `userId` is a Clerk id). Only
 * `status: "active"` claims count. When `seasonId` is given, prefers the active claim for that
 * season and falls back to the newest claim in the league; when omitted, always returns the
 * newest claim in the league.
 */
export async function teamForUser(
  ctx: DbCtx,
  leagueId: Id<"leagues">,
  user: Doc<"users"> | null,
  seasonId?: number
): Promise<Doc<"teams"> | null> {
  if (!user?.clerkId) return null;
  const claims = await ctx.db
    .query("teamClaims")
    .withIndex("by_user", (q) => q.eq("userId", user.clerkId))
    .take(50);
  const inLeague = claims.filter((c) => c.leagueId === leagueId && c.status === "active");
  if (inLeague.length === 0) return null;
  const claim =
    (seasonId !== undefined ? inLeague.find((c) => c.seasonId === seasonId) : undefined) ??
    [...inLeague].sort((a, b) => b.seasonId - a.seasonId)[0];
  return await ctx.db.get(claim.teamId);
}

/** Team -> the manager who claimed it for a season. */
export async function userForTeam(
  ctx: DbCtx,
  teamId: Id<"teams">,
  seasonId: number
): Promise<Doc<"users"> | null> {
  const claim = await ctx.db
    .query("teamClaims")
    .withIndex("by_team_season", (q) => q.eq("teamId", teamId).eq("seasonId", seasonId))
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();
  if (!claim) return null;
  return await userByClerkId(ctx, claim.userId);
}

/**
 * What a manager was actually asked about, taken from the comment request's own context (its
 * article topic, its first focus area, then the live conversation focus) rather than invented.
 * Falls back to `fallback` when the request carries none - every caller supplies its own.
 */
export function questionTopicFor(
  request: Doc<"commentRequests"> | null,
  fallback: string
): string {
  const topic = request?.articleContext?.topic?.trim();
  if (topic) return topic;
  const focus = request?.articleContext?.focusAreas?.find((f) => f && f.trim());
  if (focus) return focus.trim();
  const current = request?.aiContext?.currentFocus?.trim();
  if (current) return current;
  return fallback;
}
