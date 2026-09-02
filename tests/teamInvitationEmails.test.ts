/**
 * Team invitation emails (spec: commissioners no longer copy the invite link
 * by hand). `teamInvitations.createInvitation` schedules
 * `emailService.sendTeamInvitationEmail` for a pending invitation with a
 * plausible email; `resendInvitationEmail` lets a commissioner re-trigger it.
 *
 * EMAIL_SENDING_DISABLED is set before the harness runs so the scheduled
 * chain's terminal `emailService.sendNow` short-circuits before it would
 * otherwise make a real SendGrid fetch call.
 */
process.env.EMAIL_SENDING_DISABLED = "true";
// sendTeamInvitationEmail (like sendCommentRequestEmail) bails out early if this
// is unset; EMAIL_SENDING_DISABLED above is what actually stops any network call.
process.env.SENDGRID_API_KEY ??= "SG.test_dummy_key";

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

const COMMISSIONER = "clerk_invite_commish";
const SEASON = 2026;

async function seedLeagueAndTeam(t: TestHarness) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "The Sunday Scaries",
      platform: "espn",
      externalId: "invite-league-1",
      commissionerUserId: COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      subscription: {
        tier: "season_pass",
        status: "active",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "completed",
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

    await ctx.db.insert("users", {
      clerkId: COMMISSIONER,
      email: "commish@example.com",
      name: "Dana Whitlock",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    return { leagueId, teamId };
  });
}

// queueEmailInternal overwrites `relatedEntityId` with a JSON blob of the
// template data (see emailService.ts), so invitation emails aren't findable
// by that field - look them up by templateType + recipient instead.
async function emailLogsFor(t: TestHarness, email: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("emailLogs")
      .withIndex("by_template_type", (q) => q.eq("templateType", "team_invitation"))
      .filter((q) => q.eq(q.field("email"), email))
      .collect()
  );
}

async function allTeamInvitationEmailLogs(t: TestHarness) {
  return await t.run((ctx) =>
    ctx.db
      .query("emailLogs")
      .withIndex("by_template_type", (q) => q.eq("templateType", "team_invitation"))
      .collect()
  );
}

describe("createInvitation schedules the claim-your-team email", () => {
  it("queues and sends through the pipeline for a valid email", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueAndTeam(t);

    const result = await t
      .withIdentity({ subject: COMMISSIONER })
      .mutation(api.teamInvitations.createInvitation, {
        leagueId,
        teamId,
        seasonId: SEASON,
        email: "manager@example.com",
      });

    await t.finishAllScheduledFunctions(() => {});

    const logs = await emailLogsFor(t, "manager@example.com");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      email: "manager@example.com",
      templateId: "ffsn:team_invitation",
    });
    // Reached the real send path and was stopped only by the kill switch -
    // proof the whole schedule -> render -> queue -> send chain is wired up.
    expect(logs[0].status).toBe("error");
    expect(logs[0].error).toContain("EMAIL_SENDING_DISABLED");
  });

  it("does not schedule an email when no address was given", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueAndTeam(t);

    await t
      .withIdentity({ subject: COMMISSIONER })
      .mutation(api.teamInvitations.createInvitation, {
        leagueId,
        teamId,
        seasonId: SEASON,
      });

    await t.finishAllScheduledFunctions(() => {});

    expect(await allTeamInvitationEmailLogs(t)).toHaveLength(0);
  });

  it("does not schedule an email for a string that isn't one", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueAndTeam(t);

    await t
      .withIdentity({ subject: COMMISSIONER })
      .mutation(api.teamInvitations.createInvitation, {
        leagueId,
        teamId,
        seasonId: SEASON,
        email: "not-an-email",
      });

    await t.finishAllScheduledFunctions(() => {});

    expect(await allTeamInvitationEmailLogs(t)).toHaveLength(0);
  });
});

describe("resendInvitationEmail", () => {
  it("lets the commissioner re-trigger the send for a pending invitation", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueAndTeam(t);

    const { invitationId } = await t
      .withIdentity({ subject: COMMISSIONER })
      .mutation(api.teamInvitations.createInvitation, {
        leagueId,
        teamId,
        seasonId: SEASON,
        email: "manager@example.com",
      });
    await t.finishAllScheduledFunctions(() => {});
    expect(await emailLogsFor(t, "manager@example.com")).toHaveLength(1);

    await t.withIdentity({ subject: COMMISSIONER }).mutation(api.teamInvitations.resendInvitationEmail, {
      invitationId,
    });
    await t.finishAllScheduledFunctions(() => {});

    expect(await emailLogsFor(t, "manager@example.com")).toHaveLength(2);
  });

  it("refuses a non-commissioner", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueAndTeam(t);

    const { invitationId } = await t
      .withIdentity({ subject: COMMISSIONER })
      .mutation(api.teamInvitations.createInvitation, {
        leagueId,
        teamId,
        seasonId: SEASON,
        email: "manager@example.com",
      });

    await expect(
      t.withIdentity({ subject: "clerk_outsider" }).mutation(api.teamInvitations.resendInvitationEmail, {
        invitationId,
      })
    ).rejects.toThrow(/Only commissioners/);
  });

  it("refuses once the invitation is claimed", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueAndTeam(t);

    const { invitationId, inviteToken } = await t
      .withIdentity({ subject: COMMISSIONER })
      .mutation(api.teamInvitations.createInvitation, {
        leagueId,
        teamId,
        seasonId: SEASON,
        email: "manager@example.com",
      });
    await t.finishAllScheduledFunctions(() => {});

    const CLAIMER = "clerk_invite_claimer";
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("users", {
        clerkId: CLAIMER,
        email: "claimer@example.com",
        name: "Pat Rivera",
        hasCompletedOnboarding: true,
        createdAt: now,
        lastActiveAt: now,
      });
    });
    await t.withIdentity({ subject: CLAIMER }).mutation(api.teamInvitations.claimInvitation, {
      token: inviteToken,
    });

    await expect(
      t.withIdentity({ subject: COMMISSIONER }).mutation(api.teamInvitations.resendInvitationEmail, {
        invitationId,
      })
    ).rejects.toThrow(/no longer pending/);
  });
});

// Sanity check that the internal action itself is wired the way
// createInvitation expects it (loads the invitation/league/team, renders the
// local template, and queues it) - independent of the scheduler plumbing
// exercised above.
describe("emailService.sendTeamInvitationEmail", () => {
  it("queues the local team_invitation template for a pending invitation", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueAndTeam(t);

    const invitationId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("teamInvitations", {
        leagueId,
        teamId,
        seasonId: SEASON,
        inviteToken: "direct-action-token",
        email: "direct@example.com",
        teamName: "Kittle Me This",
        teamAbbreviation: "KMT",
        status: "pending",
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        createdAt: now,
      });
    });

    const result = await t.action(internal.emailService.sendTeamInvitationEmail, {
      invitationId,
      invitedByName: "Dana Whitlock",
    });
    expect(result.success).toBe(true);

    const logs = await emailLogsFor(t, "direct@example.com");
    expect(logs).toHaveLength(1);
    expect(logs[0].templateId).toBe("ffsn:team_invitation");
    expect(logs[0].email).toBe("direct@example.com");
  });

  it("declines to send once the invitation is no longer pending", async () => {
    const t = makeTest();
    const { leagueId, teamId } = await seedLeagueAndTeam(t);

    const invitationId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("teamInvitations", {
        leagueId,
        teamId,
        seasonId: SEASON,
        inviteToken: "claimed-token",
        email: "direct@example.com",
        teamName: "Kittle Me This",
        status: "claimed",
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        createdAt: now,
      });
    });

    const result = await t.action(internal.emailService.sendTeamInvitationEmail, { invitationId });
    expect(result).toEqual({ success: false, error: "Invitation is not pending" });
    expect(await emailLogsFor(t, "direct@example.com")).toHaveLength(0);
  });
});
