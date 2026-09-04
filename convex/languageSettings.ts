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
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireLeagueMember } from "./lib/auth";
import { leagueCurrentSeason } from "./lib/season";
import { teamForUser, userByClerkId } from "./lib/teamClaims";
import { languageRatingValidator } from "./validators";
import type { LanguageRating } from "../src/lib/ai/language";

/** Bounded scan of a league's team claims — mirrors `relationships.getLeagueRelationshipMatrix`. */
const MAX_CLAIMS = 200;

export interface LeagueLanguageSettings {
  languageRating: LanguageRating;
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
      user = await userByClerkId(ctx, claim.userId);
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

/**
 * Public counterpart of {@link getLeagueLanguage} for a signed-in league member - the settings UI
 * reads its own league's rating and opted-down team names through this instead of an internal
 * query. Named `...ForMember` (rather than reusing `getLeagueLanguage`) purely to avoid a same-file
 * export clash with the internal query above; every existing `internal.languageSettings.
 * getLeagueLanguage` caller is unaffected.
 */
export const getLeagueLanguageForMember = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    languageRating: languageRatingValidator,
    cleanTeamNames: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<LeagueLanguageSettings> => {
    await requireLeagueMember(ctx, args.leagueId);
    return resolveLeagueLanguage(ctx, args.leagueId);
  },
});

/**
 * Every league the signed-in manager belongs to, with that league's language rating and - when
 * they have claimed a team for the league's CURRENT season - their own team's name. Returns `[]`
 * when signed out, same convention as other "my ..." queries in this codebase.
 */
export const getMyLeagueLanguage = query({
  args: {},
  returns: v.array(
    v.object({
      leagueId: v.id("leagues"),
      leagueName: v.string(),
      languageRating: languageRatingValidator,
      myTeamName: v.union(v.string(), v.null()),
    })
  ),
  handler: async (
    ctx
  ): Promise<
    Array<{
      leagueId: Id<"leagues">;
      leagueName: string;
      languageRating: LeagueLanguageSettings["languageRating"];
      myTeamName: string | null;
    }>
  > => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const memberships = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .take(50);

    const user = await userByClerkId(ctx, identity.subject);

    const results = [];
    for (const membership of memberships) {
      const league = await ctx.db.get(membership.leagueId);
      if (!league) continue;

      const settings = await resolveLeagueLanguage(ctx, membership.leagueId);
      const seasonId = leagueCurrentSeason(league);
      const team = await teamForUser(ctx, membership.leagueId, user, seasonId);

      results.push({
        leagueId: membership.leagueId,
        leagueName: league.name,
        languageRating: settings.languageRating,
        myTeamName: team?.name ?? null,
      });
    }

    return results;
  },
});
