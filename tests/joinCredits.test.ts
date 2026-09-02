/**
 * Pass-aware join credits (spec §10.1).
 *
 * `teamClaims.claimTeam` and `teamInvitations.claimInvitation` are the two
 * ways a manager attaches to a team. Both must only mint the 100-credit join
 * bonus (via `credits.grantJoinCredits`) when the league's League Pass is
 * actually active - claiming a team on an unpaid league must mint nothing.
 */
process.env.EMAIL_SENDING_DISABLED = "true";

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { CREDITS_PER_MANAGER } from "../convex/credits";

const modules = import.meta.glob("../convex/**/*.*s");

function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

const COMMISSIONER = "clerk_join_commish";
const SEASON = 2026;

/** A league (with one team, unclaimed) whose pass status is `status`. */
async function seedLeagueWithTeam(t: TestHarness, status: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "Pass-Aware League",
      platform: "espn",
      externalId: `join-league-${status}`,
      commissionerUserId: COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      subscription: {
        tier: "season_pass",
        status,
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: status === "active" || status === "paid" ? "completed" : "pending",
        seasonYear: SEASON,
        seasonId: SEASON,
      },
      lastSync: now,
      createdAt: now,
    });

    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: COMMISSIONER,
      role: "commissioner",
      joinedAt: now,
    });

    const teamId = await ctx.db.insert("teams", {
      leagueId,
      externalId: "team-1",
      name: "Kittle Me This",
      abbreviation: "KMT",
      owner: "Unknown",
      record: { wins: 0, losses: 0, ties: 0 },
      roster: [],
      seasonId: SEASON,
      createdAt: now,
      updatedAt: now,
    });

    return { leagueId, teamId };
  });
}

async function insertUser(t: TestHarness, clerkId: string) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("users", {
      clerkId,
      email: `${clerkId}@example.com`,
      name: clerkId,
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });
  });
}

async function balanceOf(t: TestHarness, userId: string) {
  const row = await t.run((ctx) =>
    ctx.db
      .query("userCredits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first()
  );
  return row?.balance ?? 0;
}

describe("teamClaims.claimTeam", () => {
  it("grants the join bonus when the league's pass is active", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueWithTeam(t, "active");
    const MANAGER = "clerk_join_claimteam_active";
    await insertUser(t, MANAGER);
    await t.run((ctx) =>
      ctx.db.insert("leagueMemberships", { leagueId, userId: MANAGER, role: "member", joinedAt: Date.now() })
    );

    await t.withIdentity({ subject: MANAGER }).mutation(api.teamClaims.claimTeam, {
      leagueId,
      teamId,
      seasonId: SEASON,
    });

    expect(await balanceOf(t, MANAGER)).toBe(CREDITS_PER_MANAGER);
  });

  it("also grants it for the legacy 'paid' status alias", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueWithTeam(t, "paid");
    const MANAGER = "clerk_join_claimteam_paid";
    await insertUser(t, MANAGER);
    await t.run((ctx) =>
      ctx.db.insert("leagueMemberships", { leagueId, userId: MANAGER, role: "member", joinedAt: Date.now() })
    );

    await t.withIdentity({ subject: MANAGER }).mutation(api.teamClaims.claimTeam, {
      leagueId,
      teamId,
      seasonId: SEASON,
    });

    expect(await balanceOf(t, MANAGER)).toBe(CREDITS_PER_MANAGER);
  });

  it("mints nothing when the league has no active pass", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueWithTeam(t, "pending");
    const MANAGER = "clerk_join_claimteam_pending";
    await insertUser(t, MANAGER);
    await t.run((ctx) =>
      ctx.db.insert("leagueMemberships", { leagueId, userId: MANAGER, role: "member", joinedAt: Date.now() })
    );

    const claimId = await t.withIdentity({ subject: MANAGER }).mutation(api.teamClaims.claimTeam, {
      leagueId,
      teamId,
      seasonId: SEASON,
    });

    // The claim itself still succeeds - only the credit grant is gated.
    expect(claimId).toBeTruthy();
    expect(await balanceOf(t, MANAGER)).toBe(0);

    const ledger = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(ledger).toHaveLength(0);
  });

  it("mints nothing for a cancelled pass", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueWithTeam(t, "cancelled");
    const MANAGER = "clerk_join_claimteam_cancelled";
    await insertUser(t, MANAGER);
    await t.run((ctx) =>
      ctx.db.insert("leagueMemberships", { leagueId, userId: MANAGER, role: "member", joinedAt: Date.now() })
    );

    await t.withIdentity({ subject: MANAGER }).mutation(api.teamClaims.claimTeam, {
      leagueId,
      teamId,
      seasonId: SEASON,
    });

    expect(await balanceOf(t, MANAGER)).toBe(0);
  });
});

describe("teamInvitations.claimInvitation", () => {
  async function seedInvitation(t: TestHarness, leagueId: any, teamId: any) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("teamInvitations", {
        leagueId,
        teamId,
        seasonId: SEASON,
        inviteToken: `token-${leagueId}`,
        teamName: "Kittle Me This",
        teamAbbreviation: "KMT",
        status: "pending",
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        createdAt: now,
      });
    });
  }

  it("grants the join bonus when the league's pass is active", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueWithTeam(t, "active");
    await seedInvitation(t, leagueId, teamId);
    const invitation = await t.run((ctx) =>
      ctx.db
        .query("teamInvitations")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .first()
    );

    const MANAGER = "clerk_join_claiminvite_active";
    await insertUser(t, MANAGER);

    await t.withIdentity({ subject: MANAGER }).mutation(api.teamInvitations.claimInvitation, {
      token: invitation!.inviteToken,
    });

    expect(await balanceOf(t, MANAGER)).toBe(CREDITS_PER_MANAGER);
  });

  it("mints nothing when the league has no active pass", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueWithTeam(t, "pending");
    await seedInvitation(t, leagueId, teamId);
    const invitation = await t.run((ctx) =>
      ctx.db
        .query("teamInvitations")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .first()
    );

    const MANAGER = "clerk_join_claiminvite_pending";
    await insertUser(t, MANAGER);

    const resultLeagueId = await t
      .withIdentity({ subject: MANAGER })
      .mutation(api.teamInvitations.claimInvitation, { token: invitation!.inviteToken });

    // The invitation still gets claimed and the manager still joins the league.
    expect(resultLeagueId).toBe(leagueId);
    const membership = await t.run((ctx) =>
      ctx.db
        .query("leagueMemberships")
        .withIndex("by_league_user", (q) => q.eq("leagueId", leagueId).eq("userId", MANAGER))
        .first()
    );
    expect(membership).not.toBeNull();

    expect(await balanceOf(t, MANAGER)).toBe(0);
  });
});
