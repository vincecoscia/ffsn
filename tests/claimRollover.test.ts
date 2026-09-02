import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { decideRollover } from "../convex/claimRollover";

const modules = import.meta.glob("../convex/**/*.*s");

const PRIOR_SEASON = 2025;
const SEASON = 2026;
const TWO_SEASONS_BACK = 2024;

const CLERK_COMMISH = "clerk_commish";
const CLERK_ANN = "clerk_manager_ann"; // straightforward rollover
const CLERK_BOB = "clerk_manager_bob"; // prior claimant on the team that changes hands
const CLERK_CARL = "clerk_manager_carl"; // already claimed a different team this season
const CLERK_DAVE = "clerk_manager_dave"; // claim only found two seasons back

/**
 * One league, a commissioner, and six current-season teams covering every
 * branch of `rollForwardClaims`:
 *  - teamAlpha: prior claim, same ownerInfo.id -> rolls forward
 *  - teamBeta: prior claim, ownerInfo.id differs -> ownerChanged, no rollover
 *  - teamGamma: prior claim, same ownerInfo.id, but the claimant (Carl)
 *    already holds an active claim this season (teamXi) -> alreadyClaimed
 *  - teamEpsilon: unclaimed team one season back, claimed team two seasons
 *    back -> rolls forward from the two-seasons-back claim
 *  - teamZeta: no team at all in the last 3 seasons -> unmatched
 *  - teamXi: already has an active current-season claim (simulating a
 *    manager who claimed it directly through the UI) -> untouched, and
 *    exists so Carl's "already claimed" check has something to collide with
 */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();

    const leagueId = await ctx.db.insert("leagues", {
      name: "Rollover Test League",
      platform: "espn",
      externalId: "5551",
      commissionerUserId: CLERK_COMMISH,
      settings: {
        scoringType: "standard",
        rosterSize: 16,
        playoffWeeks: 3,
        categories: [],
      },
      subscription: {
        tier: "season_pass",
        status: "active",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "completed",
        seasonYear: SEASON,
      },
      lastSync: now,
      createdAt: now,
    });

    const commishUserId = await ctx.db.insert("users", {
      clerkId: CLERK_COMMISH,
      name: "Commish",
      email: "commish@example.com",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });
    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: CLERK_COMMISH,
      role: "commissioner",
      joinedAt: now,
    });

    const baseTeam = {
      leagueId,
      record: { wins: 0, losses: 0, ties: 0 },
      roster: [] as never[],
      createdAt: now,
      updatedAt: now,
    };

    // --- teamAlpha: clean rollover -------------------------------------
    const alphaPriorId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "10",
      name: "Alpha Prior",
      owner: "Ann Prior",
      ownerInfo: { displayName: "Ann Prior", id: "ann-swid" },
      seasonId: PRIOR_SEASON,
    });
    const alphaPriorClaimId = await ctx.db.insert("teamClaims", {
      leagueId,
      teamId: alphaPriorId,
      seasonId: PRIOR_SEASON,
      userId: CLERK_ANN,
      status: "active",
      credits: 0,
      createdAt: now,
    });
    const alphaCurrentId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "10",
      name: "Alpha Current",
      owner: "Ann Current",
      ownerInfo: { displayName: "Ann Current", id: "ann-swid" },
      seasonId: SEASON,
    });

    // --- teamBeta: ownerInfo.id changed hands ---------------------------
    const betaPriorId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "20",
      name: "Beta Prior",
      owner: "Riley Original",
      ownerInfo: { displayName: "Riley Original", id: "riley-swid" },
      seasonId: PRIOR_SEASON,
    });
    await ctx.db.insert("teamClaims", {
      leagueId,
      teamId: betaPriorId,
      seasonId: PRIOR_SEASON,
      userId: CLERK_BOB,
      status: "active",
      credits: 0,
      createdAt: now,
    });
    const betaCurrentId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "20",
      name: "Beta Current",
      owner: "Jordan New",
      ownerInfo: { displayName: "Jordan New", id: "jordan-swid" },
      seasonId: SEASON,
    });

    // --- teamGamma: claimant already holds an active claim this season -
    const gammaPriorId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "30",
      name: "Gamma Prior",
      owner: "Carl Prior",
      ownerInfo: { displayName: "Carl Prior", id: "carl-swid" },
      seasonId: PRIOR_SEASON,
    });
    await ctx.db.insert("teamClaims", {
      leagueId,
      teamId: gammaPriorId,
      seasonId: PRIOR_SEASON,
      userId: CLERK_CARL,
      status: "active",
      credits: 0,
      createdAt: now,
    });
    const gammaCurrentId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "30",
      name: "Gamma Current",
      owner: "Carl Current",
      ownerInfo: { displayName: "Carl Current", id: "carl-swid" },
      seasonId: SEASON,
    });

    // teamXi: Carl already has an active claim on this (unrelated) team for
    // the current season, seeded directly the way `teamClaims.claimTeam`
    // would leave it (no prior-season counterpart needed).
    const xiCurrentId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "70",
      name: "Xi Current",
      owner: "Carl Current",
      ownerInfo: { displayName: "Carl Current", id: "carl-swid" },
      seasonId: SEASON,
    });
    await ctx.db.insert("teamClaims", {
      leagueId,
      teamId: xiCurrentId,
      seasonId: SEASON,
      userId: CLERK_CARL,
      status: "active",
      credits: 0,
      createdAt: now,
    });

    // --- teamEpsilon: unclaimed one season back, claimed two seasons back
    await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "60",
      name: "Epsilon Prior (unclaimed)",
      owner: "Auto Team",
      seasonId: PRIOR_SEASON,
    });
    const epsilonTwoBackId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "60",
      name: "Epsilon Two Seasons Back",
      owner: "Dave Prior",
      ownerInfo: { displayName: "Dave Prior", id: "dave-swid" },
      seasonId: TWO_SEASONS_BACK,
    });
    const epsilonTwoBackClaimId = await ctx.db.insert("teamClaims", {
      leagueId,
      teamId: epsilonTwoBackId,
      seasonId: TWO_SEASONS_BACK,
      userId: CLERK_DAVE,
      status: "active",
      credits: 0,
      createdAt: now,
    });
    const epsilonCurrentId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "60",
      name: "Epsilon Current",
      owner: "Dave Current",
      ownerInfo: { displayName: "Dave Current", id: "dave-swid" },
      seasonId: SEASON,
    });

    // --- teamZeta: no prior-season team at all --------------------------
    const zetaCurrentId = await ctx.db.insert("teams", {
      ...baseTeam,
      externalId: "80",
      name: "Zeta Current",
      owner: "Nobody Yet",
      seasonId: SEASON,
    });

    return {
      leagueId,
      commishUserId,
      alphaPriorClaimId,
      alphaCurrentId,
      betaCurrentId,
      gammaCurrentId,
      xiCurrentId,
      epsilonTwoBackClaimId,
      epsilonCurrentId,
      zetaCurrentId,
    };
  });

  return { t, ...ids };
}

describe("rollForwardClaims", () => {
  it("rolls forward matching owners, flags owner changes, skips already-claimed, and leaves unmatched teams alone", async () => {
    const {
      t,
      leagueId,
      alphaPriorClaimId,
      alphaCurrentId,
      betaCurrentId,
      gammaCurrentId,
      epsilonTwoBackClaimId,
      epsilonCurrentId,
      zetaCurrentId,
    } = await setup();

    const result = await t.mutation(internal.claimRollover.rollForwardClaims, {
      leagueId,
      seasonId: SEASON,
    });

    expect(result.rolled.map((r) => r.teamId).sort()).toEqual(
      [alphaCurrentId, epsilonCurrentId].sort()
    );
    expect(result.alreadyClaimed).toEqual([
      { teamId: gammaCurrentId, teamName: "Gamma Current" },
    ]);
    expect(result.unmatched).toEqual([{ teamId: zetaCurrentId, teamName: "Zeta Current" }]);
    expect(result.ownerChanged).toEqual([
      {
        teamId: betaCurrentId,
        teamName: "Beta Current",
        previousOwner: "Riley Original",
        newOwner: "Jordan New",
      },
    ]);

    // teamAlpha: rolled to Ann, tagged with rollover provenance.
    const alphaClaim = await t.run((ctx) =>
      ctx.db
        .query("teamClaims")
        .withIndex("by_team_season", (q) => q.eq("teamId", alphaCurrentId).eq("seasonId", SEASON))
        .filter((q) => q.eq(q.field("status"), "active"))
        .first()
    );
    expect(alphaClaim?.userId).toBe(CLERK_ANN);
    expect(alphaClaim?.source).toBe("rollover");
    expect(alphaClaim?.rolledOverFromClaimId).toBe(alphaPriorClaimId);

    // teamEpsilon: rolled to Dave from the two-seasons-back claim, not the
    // (claim-less) one-season-back team.
    const epsilonClaim = await t.run((ctx) =>
      ctx.db
        .query("teamClaims")
        .withIndex("by_team_season", (q) =>
          q.eq("teamId", epsilonCurrentId).eq("seasonId", SEASON)
        )
        .filter((q) => q.eq(q.field("status"), "active"))
        .first()
    );
    expect(epsilonClaim?.userId).toBe(CLERK_DAVE);
    expect(epsilonClaim?.rolledOverFromClaimId).toBe(epsilonTwoBackClaimId);

    // teamBeta and teamGamma got no new claim.
    const betaClaims = await t.run((ctx) =>
      ctx.db
        .query("teamClaims")
        .withIndex("by_team_season", (q) => q.eq("teamId", betaCurrentId).eq("seasonId", SEASON))
        .collect()
    );
    expect(betaClaims).toHaveLength(0);
    const gammaClaims = await t.run((ctx) =>
      ctx.db
        .query("teamClaims")
        .withIndex("by_team_season", (q) => q.eq("teamId", gammaCurrentId).eq("seasonId", SEASON))
        .collect()
    );
    expect(gammaClaims).toHaveLength(0);

    // Commissioner got exactly one heads-up about the owner change.
    const notifications = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("league_invitation");
    expect(notifications[0].message).toContain("Beta Current");
    expect(notifications[0].message).toContain("Jordan New");

    // --- second run: idempotent ------------------------------------------
    const second = await t.mutation(internal.claimRollover.rollForwardClaims, {
      leagueId,
      seasonId: SEASON,
    });
    expect(second.rolled).toEqual([]);
    expect(second.alreadyClaimed).toEqual([
      { teamId: gammaCurrentId, teamName: "Gamma Current" },
    ]);
    expect(second.unmatched).toEqual([{ teamId: zetaCurrentId, teamName: "Zeta Current" }]);
    expect(second.ownerChanged).toEqual([
      {
        teamId: betaCurrentId,
        teamName: "Beta Current",
        previousOwner: "Riley Original",
        newOwner: "Jordan New",
      },
    ]);

    const allActiveClaimsForSeason = await t.run((ctx) =>
      ctx.db
        .query("teamClaims")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .filter((q) => q.and(q.eq(q.field("seasonId"), SEASON), q.eq(q.field("status"), "active")))
        .collect()
    );
    // Alpha (rolled), Epsilon (rolled), Xi (pre-existing) - no duplicates
    // from the second run, and no new claim for Beta/Gamma/Zeta.
    expect(allActiveClaimsForSeason).toHaveLength(3);

    const notificationsAfterSecondRun = await t.run((ctx) =>
      ctx.db
        .query("userNotifications")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(notificationsAfterSecondRun).toHaveLength(1);
  });
});

describe("decideRollover (pure matching decision)", () => {
  const currentTeam = { owner: "Current Owner", ownerInfo: { id: "same-swid" } };

  it("rolls over when ownerInfo.id matches", () => {
    const priorTeam = { owner: "Prior Owner", ownerInfo: { id: "same-swid" } };
    const priorClaim = { userId: "clerk_x" };
    expect(decideRollover(currentTeam, priorTeam, priorClaim)).toEqual({
      outcome: "rollover",
      claimantUserId: "clerk_x",
    });
  });

  it("rolls over when one side is missing ownerInfo.id", () => {
    const priorTeam = { owner: "Prior Owner", ownerInfo: undefined };
    const priorClaim = { userId: "clerk_x" };
    expect(decideRollover(currentTeam, priorTeam, priorClaim)).toEqual({
      outcome: "rollover",
      claimantUserId: "clerk_x",
    });
  });

  it("reports ownerChanged when ownerInfo.id differs on both sides", () => {
    const priorTeam = { owner: "Prior Owner", ownerInfo: { id: "different-swid" } };
    const priorClaim = { userId: "clerk_x" };
    expect(decideRollover(currentTeam, priorTeam, priorClaim)).toEqual({
      outcome: "ownerChanged",
      previousOwner: "Prior Owner",
      newOwner: "Current Owner",
    });
  });

  it("is unmatched when there is no prior team", () => {
    expect(decideRollover(currentTeam, null, null)).toEqual({ outcome: "unmatched" });
  });

  it("is unmatched when a prior team exists but has no active claim", () => {
    const priorTeam = { owner: "Prior Owner", ownerInfo: { id: "same-swid" } };
    expect(decideRollover(currentTeam, priorTeam, null)).toEqual({ outcome: "unmatched" });
  });
});
