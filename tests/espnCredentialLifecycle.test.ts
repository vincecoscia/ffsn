/**
 * ESPN credential lifecycle (owner's words: "notify the private league's
 * commissioner via email 2 weeks before that token expires (if we know that
 * info) or when the token has expired so they can fix it ASAP").
 *
 * Two layers are tested:
 *  - `decideReminder`, the pure branch-selection helper `crons.ts`'s daily
 *    sweep uses - no Convex context needed.
 *  - The transition wiring: `leagues.setEspnCredentialStatus` schedules
 *    `espnCredentialLifecycle.onInvalid`/`onRestored` on the actual
 *    invalid/valid transition, which (via the scheduler agent's
 *    `contentScheduling.onEspnCredentialsInvalid`/`onEspnCredentialsRestored`)
 *    pause/resume content and queue the commissioner's email.
 *
 * EMAIL_SENDING_DISABLED short-circuits emailService.sendNow before any real
 * SendGrid call, same as tests/teamInvitationEmails.test.ts.
 */
process.env.EMAIL_SENDING_DISABLED = "true";
process.env.SENDGRID_API_KEY ??= "SG.test_dummy_key";

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { decideReminder, type CredentialReminderEspnData } from "../convex/espnCredentialLifecycle";

const modules = import.meta.glob("../convex/**/*.*s");

function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

const COMMISSIONER = "clerk_credlife_commish";
const SEASON = 2026;

async function seedPrivateLeague(
  t: TestHarness,
  espnDataOverrides: Record<string, unknown> = {}
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "The Credential Crisis",
      platform: "espn",
      externalId: "credlife-league-1",
      commissionerUserId: COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 4,
        size: 10,
        lastSyncedAt: now,
        isPrivate: true,
        espnS2: "stored_s2",
        swid: "{STORED-SWID}",
        ...espnDataOverrides,
      },
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

    await ctx.db.insert("users", {
      clerkId: COMMISSIONER,
      email: "commish@credlife.example.com",
      name: "Dana Whitlock",
      hasCompletedOnboarding: true,
      createdAt: now,
      lastActiveAt: now,
    });

    return leagueId;
  });
}

async function backlogRow(t: TestHarness, leagueId: Awaited<ReturnType<typeof seedPrivateLeague>>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const scheduleId = await ctx.db.insert("contentSchedules", {
      leagueId,
      contentType: "weekly_recap",
      enabled: true,
      timezone: "America/New_York",
      schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 },
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("scheduledContent", {
      leagueId,
      contentScheduleId: scheduleId,
      contentType: "weekly_recap",
      scheduledFor: now - 3 * 24 * 60 * 60 * 1000, // old enough to skip its interview on resume
      status: "backlogged",
      attempts: 0,
      maxAttempts: 3,
      backlogReason: "espn_credentials_invalid",
      backloggedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function emailLogsFor(t: TestHarness, templateType: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("emailLogs")
      .withIndex("by_template_type", (q) => q.eq("templateType", templateType))
      .collect()
  );
}

describe("decideReminder (pure)", () => {
  const now = Date.UTC(2026, 8, 15); // Sep 15 2026
  const base: CredentialReminderEspnData = {};

  it("resends the broken email once status is invalid and the last notice is stale (or absent)", () => {
    expect(decideReminder({ ...base, credentialStatus: "invalid" }, now)).toMatchObject({
      resendBrokenEmail: true,
    });

    const fourDaysAgo = now - 4 * 24 * 60 * 60 * 1000;
    expect(
      decideReminder({ ...base, credentialStatus: "invalid", credentialInvalidNotifiedAt: fourDaysAgo }, now)
    ).toMatchObject({ resendBrokenEmail: true });

    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;
    expect(
      decideReminder({ ...base, credentialStatus: "invalid", credentialInvalidNotifiedAt: oneDayAgo }, now)
    ).toMatchObject({ resendBrokenEmail: false });

    // Not invalid at all - nothing to resend.
    expect(decideReminder({ ...base, credentialStatus: "valid" }, now)).toMatchObject({
      resendBrokenEmail: false,
    });
  });

  it("sends the expiring email once per expiry value, only inside the 14-day window", () => {
    const in10Days = now + 10 * 24 * 60 * 60 * 1000;
    const decision = decideReminder({ ...base, credentialExpiresAt: in10Days }, now);
    expect(decision.sendExpiringEmail).toBe(true);
    expect(decision.daysLeft).toBe(10);

    // Already warned for this exact expiry value - no repeat.
    expect(
      decideReminder(
        { ...base, credentialExpiresAt: in10Days, expiryReminderSentFor: in10Days },
        now
      )
    ).toMatchObject({ sendExpiringEmail: false });

    // Outside the 14-day window.
    const in20Days = now + 20 * 24 * 60 * 60 * 1000;
    expect(decideReminder({ ...base, credentialExpiresAt: in20Days }, now)).toMatchObject({
      sendExpiringEmail: false,
    });

    // No known expiry at all.
    expect(decideReminder(base, now)).toMatchObject({ sendExpiringEmail: false, daysLeft: undefined });
  });

  it("probes stored credentials once a known expiry has passed and status isn't already invalid", () => {
    const yesterday = now - 1 * 24 * 60 * 60 * 1000;
    expect(
      decideReminder({ ...base, credentialExpiresAt: yesterday, credentialStatus: "valid" }, now)
    ).toMatchObject({ probeStoredCredentials: true });
    expect(
      decideReminder({ ...base, credentialExpiresAt: yesterday, credentialStatus: "unknown" }, now)
    ).toMatchObject({ probeStoredCredentials: true });

    // Already known invalid - the resend branch owns this, no need to re-probe.
    expect(
      decideReminder({ ...base, credentialExpiresAt: yesterday, credentialStatus: "invalid" }, now)
    ).toMatchObject({ probeStoredCredentials: false });

    // Expiry hasn't passed yet.
    const tomorrow = now + 1 * 24 * 60 * 60 * 1000;
    expect(
      decideReminder({ ...base, credentialExpiresAt: tomorrow, credentialStatus: "valid" }, now)
    ).toMatchObject({ probeStoredCredentials: false });
  });
});

describe("leagues.setEspnCredentialStatus transitions", () => {
  it("valid -> invalid on a private league pauses content and emails the commissioner", async () => {
    const t = makeTest();
    const leagueId = await seedPrivateLeague(t, { credentialStatus: "valid" });

    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "invalid",
      error: "ESPN API returned 401: Unauthorized",
    });
    await t.finishAllScheduledFunctions(() => {});

    const stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData?.contentPausedAt).toBeTypeOf("number");
    expect(stored?.espnData?.credentialInvalidNotifiedAt).toBeTypeOf("number");

    const logs = await emailLogsFor(t, "espn_connection_broken");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      email: "commish@credlife.example.com",
      templateId: "ffsn:espn_connection_broken",
    });
    // Reached the real send path and was stopped only by the kill switch.
    expect(logs[0].status).toBe("error");
    expect(logs[0].error).toContain("EMAIL_SENDING_DISABLED");
  });

  it("does not re-trigger on invalid -> invalid (already-known status)", async () => {
    const t = makeTest();
    const leagueId = await seedPrivateLeague(t, { credentialStatus: "unknown" });

    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "invalid",
      error: "first rejection",
    });
    await t.finishAllScheduledFunctions(() => {});
    expect(await emailLogsFor(t, "espn_connection_broken")).toHaveLength(1);

    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "invalid",
      error: "still rejected",
    });
    await t.finishAllScheduledFunctions(() => {});
    // Still just the one - a repeated "invalid" confirmation is not a transition.
    expect(await emailLogsFor(t, "espn_connection_broken")).toHaveLength(1);
  });

  it("does not trigger for a public league", async () => {
    const t = makeTest();
    const leagueId = await seedPrivateLeague(t, { isPrivate: false, credentialStatus: "unknown" });

    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "invalid",
      error: "unexpected auth failure",
    });
    await t.finishAllScheduledFunctions(() => {});

    expect(await emailLogsFor(t, "espn_connection_broken")).toHaveLength(0);
    const stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData?.contentPausedAt).toBeUndefined();
  });

  it("invalid -> valid resumes the backlog and emails the commissioner", async () => {
    const t = makeTest();
    const leagueId = await seedPrivateLeague(t, {
      credentialStatus: "invalid",
      contentPausedAt: Date.now(),
    });
    await t.run(async (ctx) => {
      const league = await ctx.db.get(leagueId);
      await ctx.db.patch(leagueId, {
        espnData: { ...league!.espnData!, credentialInvalidNotifiedAt: Date.now() },
      });
    });
    const scheduledContentId = await backlogRow(t, leagueId);

    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "valid",
    });
    await t.finishAllScheduledFunctions(() => {});

    const stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData?.contentPausedAt).toBeUndefined();
    expect(stored?.espnData?.credentialInvalidNotifiedAt).toBeUndefined();

    const row = await t.run(async (ctx) => ctx.db.get(scheduledContentId));
    expect(row?.status).toBe("pending");

    const logs = await emailLogsFor(t, "espn_connection_restored");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      email: "commish@credlife.example.com",
      templateId: "ffsn:espn_connection_restored",
    });
  });

  it("does not trigger restore on unknown -> valid (never was invalid)", async () => {
    const t = makeTest();
    const leagueId = await seedPrivateLeague(t, { credentialStatus: "unknown" });

    await t.mutation(internal.leagues.setEspnCredentialStatus, { leagueId, status: "valid" });
    await t.finishAllScheduledFunctions(() => {});

    expect(await emailLogsFor(t, "espn_connection_restored")).toHaveLength(0);
  });
});
