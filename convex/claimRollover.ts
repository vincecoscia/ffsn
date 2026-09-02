import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Carries manager <-> team claims forward into a new season.
 *
 * Teams are per-season documents (`teams`), so nothing links a manager's
 * `teamClaims` row from last season to this season's freshly-synced team
 * doc. Left alone, every team looks "unclaimed" the moment a new season's
 * teams are synced from ESPN, even though the same person still owns it.
 *
 * `externalId` (the ESPN team id) is stable across seasons, and so is
 * `ownerInfo.id` (the ESPN SWID) for a given person. This mutation matches
 * this season's team to a prior season's team by `externalId`, and only
 * rolls the claim forward when the two teams' `ownerInfo.id` agree (or one
 * side is missing it) - if they disagree, the ESPN team clearly changed
 * hands, and rolling the old claim forward would hand the new team to the
 * wrong Clerk user.
 */

/** How many seasons back to search for a matching team before giving up. */
const MAX_SEASON_LOOKBACK = 3;

const rolloverTeamValidator = v.object({
  teamId: v.id("teams"),
  teamName: v.string(),
});

const ownerChangedValidator = v.object({
  teamId: v.id("teams"),
  teamName: v.string(),
  previousOwner: v.string(),
  newOwner: v.string(),
});

const rollForwardResultValidator = v.object({
  rolled: v.array(rolloverTeamValidator),
  alreadyClaimed: v.array(rolloverTeamValidator),
  unmatched: v.array(rolloverTeamValidator),
  ownerChanged: v.array(ownerChangedValidator),
});

type RollForwardResult = {
  rolled: { teamId: Id<"teams">; teamName: string }[];
  alreadyClaimed: { teamId: Id<"teams">; teamName: string }[];
  unmatched: { teamId: Id<"teams">; teamName: string }[];
  ownerChanged: {
    teamId: Id<"teams">;
    teamName: string;
    previousOwner: string;
    newOwner: string;
  }[];
};

/**
 * Pure matching decision, exported for unit testing without a Convex
 * context: given the current team, a same-`externalId` candidate from a
 * prior season, and that candidate's active claim (if any), decide whether
 * the claim should roll forward.
 *
 * Mirrors the ownerInfo.id comparison in `rollForwardClaims` below - kept in
 * sync by hand since a mutation handler can't itself be imported as a plain
 * value from a test without pulling in the whole Convex module graph.
 */
export function decideRollover(
  currentTeam: Pick<Doc<"teams">, "owner" | "ownerInfo">,
  priorTeam: Pick<Doc<"teams">, "owner" | "ownerInfo"> | null,
  priorActiveClaim: Pick<Doc<"teamClaims">, "userId"> | null
):
  | { outcome: "unmatched" }
  | { outcome: "ownerChanged"; previousOwner: string; newOwner: string }
  | { outcome: "rollover"; claimantUserId: string } {
  if (!priorTeam || !priorActiveClaim) {
    return { outcome: "unmatched" };
  }

  const currentOwnerId = currentTeam.ownerInfo?.id;
  const priorOwnerId = priorTeam.ownerInfo?.id;
  if (currentOwnerId && priorOwnerId && currentOwnerId !== priorOwnerId) {
    return {
      outcome: "ownerChanged",
      previousOwner: priorTeam.owner,
      newOwner: currentTeam.owner,
    };
  }

  return { outcome: "rollover", claimantUserId: priorActiveClaim.userId };
}

export const rollForwardClaims = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  returns: rollForwardResultValidator,
  handler: async (ctx, args): Promise<RollForwardResult> => {
    const rolled: RollForwardResult["rolled"] = [];
    const alreadyClaimed: RollForwardResult["alreadyClaimed"] = [];
    const unmatched: RollForwardResult["unmatched"] = [];
    const ownerChanged: RollForwardResult["ownerChanged"] = [];

    const currentTeams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) =>
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    for (const team of currentTeams) {
      // Already claimed for this season - nothing to do (this is also what
      // makes a re-run idempotent for every team a prior run rolled forward).
      const existingActiveClaim = await ctx.db
        .query("teamClaims")
        .withIndex("by_team_season", (q) =>
          q.eq("teamId", team._id).eq("seasonId", args.seasonId)
        )
        .filter((q) => q.eq(q.field("status"), "active"))
        .first();
      if (existingActiveClaim) {
        continue;
      }

      // Search back up to MAX_SEASON_LOOKBACK seasons for a same-externalId
      // team that has an active claim to roll forward. A team doc can exist
      // in a prior season without ever having been claimed (e.g. an
      // auto-generated team nobody claimed that year), so a match on the
      // team alone isn't enough - keep looking further back for a season
      // that actually has a claim.
      let priorTeam: Doc<"teams"> | null = null;
      let priorActiveClaim: Doc<"teamClaims"> | null = null;
      for (let back = 1; back <= MAX_SEASON_LOOKBACK; back++) {
        const candidateTeam = await ctx.db
          .query("teams")
          .withIndex("by_external", (q) =>
            q
              .eq("leagueId", args.leagueId)
              .eq("externalId", team.externalId)
              .eq("seasonId", args.seasonId - back)
          )
          .first();
        if (!candidateTeam) continue;

        const candidateClaim = await ctx.db
          .query("teamClaims")
          .withIndex("by_team_season", (q) =>
            q.eq("teamId", candidateTeam._id).eq("seasonId", candidateTeam.seasonId)
          )
          .filter((q) => q.eq(q.field("status"), "active"))
          .first();

        if (candidateClaim) {
          priorTeam = candidateTeam;
          priorActiveClaim = candidateClaim;
          break;
        }
        // Remember the nearest team match even without a claim, in case
        // every season in the lookback window turns up a team but never a
        // claim - still reported as unmatched, just keeps searching for now.
        if (!priorTeam) {
          priorTeam = candidateTeam;
        }
      }

      const decision = decideRollover(team, priorTeam, priorActiveClaim);

      if (decision.outcome === "unmatched") {
        unmatched.push({ teamId: team._id, teamName: team.name });
        continue;
      }

      if (decision.outcome === "ownerChanged") {
        ownerChanged.push({
          teamId: team._id,
          teamName: team.name,
          previousOwner: decision.previousOwner,
          newOwner: decision.newOwner,
        });
        continue;
      }

      // decision.outcome === "rollover"
      const claimantUserId = decision.claimantUserId;

      // The claimant already holds an active claim on a *different* team in
      // this league for this season (e.g. a data anomaly upstream) - don't
      // hand them a second team.
      const claimantExistingClaim = await ctx.db
        .query("teamClaims")
        .withIndex("by_user", (q) => q.eq("userId", claimantUserId))
        .filter((q) =>
          q.and(
            q.eq(q.field("leagueId"), args.leagueId),
            q.eq(q.field("seasonId"), args.seasonId),
            q.eq(q.field("status"), "active")
          )
        )
        .first();
      if (claimantExistingClaim) {
        alreadyClaimed.push({ teamId: team._id, teamName: team.name });
        continue;
      }

      await ctx.db.insert("teamClaims", {
        leagueId: args.leagueId,
        teamId: team._id,
        seasonId: args.seasonId,
        userId: claimantUserId,
        status: "active",
        credits: 0,
        createdAt: Date.now(),
        source: "rollover",
        rolledOverFromClaimId: priorActiveClaim!._id,
      });
      rolled.push({ teamId: team._id, teamName: team.name });
    }

    if (ownerChanged.length > 0) {
      await notifyCommissionersOfOwnerChanges(ctx, args.leagueId, args.seasonId, ownerChanged);
    }

    console.log(
      `rollForwardClaims: league ${args.leagueId} season ${args.seasonId} - ` +
        `rolled ${rolled.length}, alreadyClaimed ${alreadyClaimed.length}, ` +
        `unmatched ${unmatched.length}, ownerChanged ${ownerChanged.length}`
    );

    return { rolled, alreadyClaimed, unmatched, ownerChanged };
  },
});

async function notifyCommissionersOfOwnerChanges(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  ownerChanged: RollForwardResult["ownerChanged"]
): Promise<void> {
  const commissionerMemberships = await ctx.db
    .query("leagueMemberships")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .filter((q) => q.eq(q.field("role"), "commissioner"))
    .collect();

  for (const membership of commissionerMemberships) {
    const commissionerUser = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", membership.userId))
      .first();
    if (!commissionerUser) {
      console.warn(
        `rollForwardClaims: no users row for commissioner ${membership.userId} in league ${leagueId}`
      );
      continue;
    }

    for (const changed of ownerChanged) {
      await ctx.runMutation(internal.notifications.createNotification, {
        userId: commissionerUser._id,
        leagueId,
        type: "league_invitation" as const,
        title: `${changed.teamName} has a new manager on ESPN`,
        message: `${changed.teamName} has a new manager on ESPN (${changed.newOwner}). Invite them from League settings.`,
        actionUrl: `/leagues/${leagueId}/settings`,
        actionText: "Open League settings",
        relatedEntityType: "league" as const,
        relatedEntityId: changed.teamId,
        priority: "medium" as const,
        deliveryChannels: ["in_app" as const],
        // One notification per (team, season, commissioner) even if the
        // sync (and this mutation) runs again before the commissioner acts.
        dedupeKey: `claim_rollover_owner_changed:${changed.teamId}:${seasonId}`,
      });
    }
  }
}
