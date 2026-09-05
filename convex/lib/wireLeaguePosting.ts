/**
 * Shared per-league posting helpers for The Wire's league tier
 * (`convex/wireOverlay.ts`, `convex/wireRoutine.ts`, `convex/wire.ts`, `convex/wireSocialData.ts`):
 * the dedupe-and-insert into `wireLeaguePosts`, the per-league rate limit (spec
 * ffsn-the-wire-spec.md §11), and the social layer's `postKey` convention (spec §17).
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
  // Absent on a manager post/reply - use `authorUserId` below instead (spec §17).
  persona?: string;
  text: string;
  tags: string[];
  globalPostId?: Id<"wirePosts">;
  impact?: { teamId: Id<"teams">; variant: string; slots: Record<string, string> };
  featuredTeams: Id<"teams">[];
  dedupeKey: string;
  generationStats?: { costUsd: number; model: string; effort: string };
  // Social layer (spec §17) - see the matching fields on `wireLeaguePosts` in convex/schema.ts.
  authorUserId?: string;
  authorTeamId?: Id<"teams">;
  replyTo?: { scope: "global" | "league"; id: string };
  rootScope?: "global" | "league";
  rootId?: string;
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

/** Mirrors convex/matchups.ts#getCurrentWeekMatchups: the first synced week with any undecided
 *  matchup, or the last synced week if every one so far is final. Bounded to 18 NFL weeks. Shared
 *  by `wireOverlay.ts` (the overlay's own week) and `wire.ts#postAsManager` (spec §17, stamps the
 *  same "current week" onto a manager's post). */
export async function currentMatchupPeriod(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number
): Promise<number | null> {
  let lastSyncedWeek: number | null = null;
  for (let week = 1; week <= 18; week++) {
    const weekMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_period", (q) => q.eq("leagueId", leagueId).eq("matchupPeriod", week))
      .filter((q) => q.eq(q.field("seasonId"), seasonId))
      .take(40);
    if (weekMatchups.length === 0) break;
    lastSyncedWeek = week;
    if (weekMatchups.some((m) => !m.winner)) return week;
  }
  return lastSyncedWeek;
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

/* -------------------------------------------------------------------------- *
 * Social layer (spec §17): the `postKey` convention shared by `wireReactions`,
 * `wire.react`, `wireSocialData.ts` and `relationships.syncWireReactionEvent`.
 * -------------------------------------------------------------------------- */

export type WirePostScope = "global" | "league";

/** `"global:<wirePosts id>"` or `"league:<wireLeaguePosts id>"` — one string key covering both
 *  post tables, so `wireReactions` needs neither a union id column nor two index pairs. */
export function buildPostKey(scope: WirePostScope, id: string): string {
  return `${scope}:${id}`;
}

/** Inverse of {@link buildPostKey}. Returns `null` for anything that isn't a well-formed key -
 *  every caller must treat a malformed/foreign `postKey` as "not found", never throw. */
export function parsePostKey(postKey: string): { scope: WirePostScope; id: string } | null {
  const globalPrefix = "global:";
  const leaguePrefix = "league:";
  if (postKey.startsWith(globalPrefix)) {
    const id = postKey.slice(globalPrefix.length);
    return id ? { scope: "global", id } : null;
  }
  if (postKey.startsWith(leaguePrefix)) {
    const id = postKey.slice(leaguePrefix.length);
    return id ? { scope: "league", id } : null;
  }
  return null;
}
