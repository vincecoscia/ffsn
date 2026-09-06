/**
 * Where a league's season sits relative to its draft (ffsn-the-wire-spec.md §3.2 point 7, §18).
 * Lifted out of `convex/wireOverlay.ts` (which owned this logic first) so `convex/wireDesk.ts` can
 * reuse it too - Dex Desk's lineup/roster posts are pre-draft-gated exactly the same way overlays
 * are ("pre-draft never" for a REDRAFT league; a KEEPER league before its draft still counts as
 * drafted for this purpose since its rosters are real).
 *
 * Pure-ish (needs `ctx.db`, but no `internal`/`api` import), matching the rule documented in
 * `convex/lib/wireLeaguePosting.ts`'s header comment - safe for any convex/*.ts module to import.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isPreDraftRedraft } from "./matchupSummary";

export type DraftPhase = "predraft_redraft" | "predraft_keeper" | "drafted";

/**
 * Reuses `isPreDraftRedraft`'s rule (matchupSummary.ts): `draftInfo.drafted` must be the literal
 * `false` to count as pre-draft, and a keeper/dynasty league (keeperCount or keeperCountFuture > 0)
 * is the keeper case. Anything else, including an unsynced season, is treated as drafted so real
 * rosters are never hidden.
 */
export async function draftPhaseFor(
  ctx: QueryCtx | MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number
): Promise<DraftPhase> {
  const season = await ctx.db
    .query("leagueSeasons")
    .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .first();
  if (!season || season.draftInfo?.drafted !== false) return "drafted";
  return isPreDraftRedraft(season) ? "predraft_redraft" : "predraft_keeper";
}
