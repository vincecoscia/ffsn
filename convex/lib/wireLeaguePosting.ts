/**
 * Shared per-league posting helpers for The Wire's league tier
 * (`convex/wireOverlay.ts`, `convex/wireRoutine.ts`): the dedupe-and-insert into
 * `wireLeaguePosts`, and the per-league rate limit (spec ffsn-the-wire-spec.md §11).
 *
 * Kept in `convex/lib/` rather than imported from one of `wireOverlay.ts`/`wireRoutine.ts`
 * directly: both those files define their own `internalMutation`s against `internal.*`, and a
 * convex/*.ts module that references `internal`/`api` makes the generated `api` type recursive
 * for anything that imports it as a plain value (the repo's documented cross-module value-import
 * gotcha). This file imports nothing from `./_generated/api`, so both can import it safely.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { LEAGUE_LIMIT_EXEMPT_KINDS, LEAGUE_POSTS_PER_DAY, LEAGUE_POSTS_PER_HOUR } from "../../src/lib/ai/wire/types";

/**
 * The Wire's global kill switch (spec §11): Convex env `WIRE_ENABLED="0"` stops every poster
 * (global cards, takes, league posts) and the injuries poll at their next run. Absent = on.
 * Events already detected are still stored, so turning it back on loses nothing.
 */
export function wireEnabled(): boolean {
  return (process.env.WIRE_ENABLED ?? "").trim() !== "0";
}

export interface LeaguePostInsert {
  leagueId: Id<"leagues">;
  seasonId: number;
  week?: number;
  kind: string;
  persona: string;
  text: string;
  tags: string[];
  globalPostId?: Id<"wirePosts">;
  impact?: { teamId: Id<"teams">; variant: string; slots: Record<string, string> };
  featuredTeams: Id<"teams">[];
  dedupeKey: string;
  generationStats?: { costUsd: number; model: string; effort: string };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Hard safety cap on the per-day scan below - once the limiter is enforced a league can never
 *  accumulate more than LEAGUE_POSTS_PER_DAY (80) + a handful of exempt-kind posts in a day, but
 *  this keeps the read bounded regardless (repo guideline: never an unbounded `.collect()`). */
const RATE_LIMIT_SCAN_CAP = 300;

/** Whether this league has hit its per-hour/day post cap for a kind that isn't exempt (spec §11). */
export async function leagueRateLimited(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  kind: string,
  now: number
): Promise<boolean> {
  if (LEAGUE_LIMIT_EXEMPT_KINDS.has(kind)) return false;

  const recent = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId).gt("createdAt", now - DAY_MS))
    .take(RATE_LIMIT_SCAN_CAP);

  if (recent.length >= LEAGUE_POSTS_PER_DAY) return true;
  const lastHour = recent.filter((row) => row.createdAt > now - HOUR_MS).length;
  return lastHour >= LEAGUE_POSTS_PER_HOUR;
}

/**
 * Insert a league post unless its dedupe key already exists for this league, or the league's
 * rate limit is exceeded for a non-exempt kind. Returns `{ inserted: false }` in either skip case
 * (never throws - overflow is dropped silently per spec §11, the caller may still record a flag).
 */
export async function insertLeaguePostIfNew(
  ctx: MutationCtx,
  now: number,
  post: LeaguePostInsert
): Promise<{ inserted: boolean; id?: Id<"wireLeaguePosts"> }> {
  if (!wireEnabled()) return { inserted: false };
  const existing = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_league_dedupe", (q) => q.eq("leagueId", post.leagueId).eq("dedupeKey", post.dedupeKey))
    .first();
  if (existing) return { inserted: false, id: existing._id };

  if (await leagueRateLimited(ctx, post.leagueId, post.kind, now)) {
    return { inserted: false };
  }

  const id = await ctx.db.insert("wireLeaguePosts", { ...post, createdAt: now });
  return { inserted: true, id };
}

/**
 * `$` remaining FAAB budget for a team, only in a FAAB league with a known budget - shared by the
 * overlay (`wireOverlay.ts`'s owner variant) and the waiver-processed routine line
 * (`wireRoutine.ts`), both of which need the same "how much is left" math (spec §3.2 point 3).
 */
export function faabSlot(
  league: Pick<Doc<"leagues">, "settings">,
  team: Pick<Doc<"teams">, "transactionCounter">
): string | undefined {
  if (league.settings?.waiverType !== "faab") return undefined;
  const budget = league.settings?.faabBudget;
  if (budget === undefined) return undefined;
  const spent = team.transactionCounter?.acquisitionBudgetSpent ?? 0;
  return `$${Math.max(0, budget - spent)}`;
}

/** A team's manager display name, preferring the ESPN-mirrored display name over the raw owner id. */
export function managerNameFor(team: Pick<Doc<"teams">, "ownerInfo" | "owner">): string | undefined {
  return team.ownerInfo?.displayName || team.owner || undefined;
}
