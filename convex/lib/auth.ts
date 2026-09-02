/**
 * Shared authorization helpers for Convex functions.
 *
 * Every public `query` / `mutation` / `action` is an HTTP endpoint that anyone who knows the
 * deployment URL can call with arbitrary arguments. The only gate is what the handler checks.
 * Use these helpers at the top of every public handler instead of trusting a client-supplied
 * `userId` / `leagueId`:
 *
 *   const identity = await requireIdentity(ctx);            // signed in
 *   const { membership } = await requireLeagueMember(ctx, leagueId);   // member of the league
 *   await requireCommissioner(ctx, leagueId);                // commissioner of the league
 *
 * Functions that are only ever called from crons, schedulers, or other Convex functions should
 * be `internalQuery` / `internalMutation` / `internalAction` instead, which need no check.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";

type DbCtx = QueryCtx | MutationCtx;
type AnyCtx = DbCtx | ActionCtx;

export interface Identity {
  /** The auth subject (Clerk user id today), which is what `users.clerkId`,
   *  `leagueMemberships.userId`, and `leagues.commissionerUserId` store. */
  subject: string;
  email?: string;
  name?: string;
}

/** Throws unless the caller is signed in. Works in queries, mutations, and actions. */
export async function requireIdentity(ctx: AnyCtx): Promise<Identity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }
  return { subject: identity.subject, email: identity.email, name: identity.name };
}

/** Returns the caller's membership row for a league, or null when signed out / not a member. */
export async function getLeagueMembership(
  ctx: DbCtx,
  leagueId: Id<"leagues">
): Promise<{ identity: Identity; membership: Doc<"leagueMemberships"> } | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const membership = await ctx.db
    .query("leagueMemberships")
    .withIndex("by_league_user", (q) =>
      q.eq("leagueId", leagueId).eq("userId", identity.subject)
    )
    .first();
  if (!membership) return null;
  return {
    identity: { subject: identity.subject, email: identity.email, name: identity.name },
    membership,
  };
}

/** Throws unless the caller is a member (any role) of the league. Queries/mutations only. */
export async function requireLeagueMember(
  ctx: DbCtx,
  leagueId: Id<"leagues">
): Promise<{ identity: Identity; membership: Doc<"leagueMemberships"> }> {
  const result = await getLeagueMembership(ctx, leagueId);
  if (!result) {
    throw new Error("Not authorized: you are not a member of this league");
  }
  return result;
}

/** Throws unless the caller is the league's commissioner. Queries/mutations only. */
export async function requireCommissioner(
  ctx: DbCtx,
  leagueId: Id<"leagues">
): Promise<{ identity: Identity; membership: Doc<"leagueMemberships"> }> {
  const result = await requireLeagueMember(ctx, leagueId);
  if (result.membership.role !== "commissioner") {
    throw new Error("Not authorized: commissioner role required");
  }
  return result;
}

/**
 * Action-side membership check. Actions have no `ctx.db`, so this round-trips through the
 * `leagues.getMembershipInternal` query. Throws unless the caller is a member; pass
 * `{ commissioner: true }` to require the commissioner role.
 */
export async function requireLeagueMemberFromAction(
  ctx: ActionCtx,
  leagueId: Id<"leagues">,
  opts: { commissioner?: boolean } = {}
): Promise<{ identity: Identity; role: "commissioner" | "member" }> {
  const identity = await requireIdentity(ctx);
  const role = await ctx.runQuery(internal.leagues.getMembershipRoleInternal, {
    leagueId,
    userId: identity.subject,
  });
  if (!role) {
    throw new Error("Not authorized: you are not a member of this league");
  }
  if (opts.commissioner && role !== "commissioner") {
    throw new Error("Not authorized: commissioner role required");
  }
  return { identity, role };
}
