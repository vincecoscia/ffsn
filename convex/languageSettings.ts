/**
 * League language rating (owner ask, Sept 2026): a league-level dial — clean | salty | unfiltered
 * — plus a per-manager opt-down ("keep it clean about my team"). This module resolves both to the
 * values the prompt layer (`src/lib/ai/language.ts`) actually renders:
 *
 * - `languageRating`: the league's `leagueContentPreferences.languageRating`, defaulting to
 *   "clean" when the commissioner has never set it.
 * - `cleanTeamNames`: the names of every team whose manager set `preferences.cleanLanguage`,
 *   regardless of the league's own rating.
 *
 * Every generation path (the standard article path, the prepared path, the batch path, and the
 * "Disputed" show) reads these once through `getLeagueLanguage` and forwards them unchanged.
 */

import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { leagueCurrentSeason } from "./lib/season";
import { languageRatingValidator } from "./validators";

/** Bounded scan of a league's team claims — mirrors `relationships.getLeagueRelationshipMatrix`. */
const MAX_CLAIMS = 200;

export interface LeagueLanguageSettings {
  languageRating: "clean" | "salty" | "unfiltered";
  cleanTeamNames: string[];
}

/**
 * Resolve one league's language rating and its opted-down team names.
 *
 * Manager -> team is the same `teamClaims` join `relationships.ts` uses (`teamForUser` /
 * `userForTeam`): `teamClaims.userId` is a Clerk id, never a `users` document id, and only
 * `status: "active"` claims for the league's CURRENT season count.
 */
export async function resolveLeagueLanguage(
  ctx: QueryCtx,
  leagueId: Id<"leagues">
): Promise<LeagueLanguageSettings> {
  const preferences = await ctx.db
    .query("leagueContentPreferences")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .first();
  const languageRating = preferences?.languageRating ?? "clean";

  const league = await ctx.db.get(leagueId);
  const seasonId = leagueCurrentSeason(league);

  const claims = await ctx.db
    .query("teamClaims")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .take(MAX_CLAIMS);
  const activeClaims = claims.filter(
    (claim) => claim.status === "active" && claim.seasonId === seasonId
  );

  const userCache = new Map<string, Doc<"users"> | null>();
  const cleanTeamNames = new Set<string>();

  for (const claim of activeClaims) {
    let user = userCache.get(claim.userId);
    if (user === undefined) {
      user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", claim.userId))
        .unique();
      userCache.set(claim.userId, user);
    }
    if (!user || user.preferences?.cleanLanguage !== true) continue;

    const team = await ctx.db.get(claim.teamId);
    if (team) cleanTeamNames.add(team.name);
  }

  return {
    languageRating,
    cleanTeamNames: [...cleanTeamNames].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Convex wrapper around {@link resolveLeagueLanguage} for the "use node" generation actions
 * (`aiContent.ts`, `aiContentHelpers.ts`, `aiBatch.ts`, `disputedNode.ts`), which have no `ctx.db`
 * of their own and reach this through `ctx.runQuery(internal.languageSettings.getLeagueLanguage,
 * { leagueId })`.
 */
export const getLeagueLanguage = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    languageRating: languageRatingValidator,
    cleanTeamNames: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<LeagueLanguageSettings> =>
    resolveLeagueLanguage(ctx, args.leagueId),
});
