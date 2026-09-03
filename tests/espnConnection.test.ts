/**
 * ESPN connection contract: `leagues.getEspnConnection`,
 * `leagues.updateEspnCredentials`, and the internal `setEspnCredentialStatus`
 * mutation the sync crons and `espnSync.testEspnConnection` write through.
 *
 * The one invariant that matters most here: the cookie values themselves
 * (`espnS2`/`swid`) must never come back out of `getEspnConnection`, no
 * matter who's asking.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

const COMMISSIONER = "clerk_espn_commish";
const MEMBER = "clerk_espn_member";
const OUTSIDER = "clerk_espn_outsider";

async function seedLeague(t: ReturnType<typeof convexTest>, opts: { withEspnData?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "ESPN Connection Test League",
      platform: "espn",
      externalId: "778899",
      commissionerUserId: COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: opts.withEspnData
        ? {
            seasonId: 2026,
            currentScoringPeriod: 4,
            size: 10,
            lastSyncedAt: now,
            isPrivate: true,
            espnS2: "stored_s2",
            swid: "{STORED-SWID}",
          }
        : undefined,
      subscription: {
        tier: "season_pass",
        status: "active",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "completed",
        seasonYear: 2026,
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
    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: MEMBER,
      role: "member",
      joinedAt: now,
    });

    return leagueId;
  });
}

describe("leagues.updateEspnCredentials", () => {
  it("normalizes and stores the pair, and never returns them from getEspnConnection", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    const result = await t
      .withIdentity({ subject: COMMISSIONER })
      .mutation(api.leagues.updateEspnCredentials, {
        leagueId,
        espnS2: `  ${encodeURIComponent("AEB123/xyz+==")}  `,
        swid: "  1234-5678-ABCD  ",
      });
    expect(result).toEqual({ ok: true });

    // Stored value is normalized (trimmed, decoded once, brace-wrapped) -
    // checked via a raw db read since no public query ever returns it.
    const stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData?.espnS2).toBe("AEB123/xyz+==");
    expect(stored?.espnData?.swid).toBe("{1234-5678-ABCD}");
    expect(stored?.espnData?.isPrivate).toBe(true);
    expect(stored?.espnData?.credentialStatus).toBe("unknown");

    const connection = await t
      .withIdentity({ subject: COMMISSIONER })
      .query(api.leagues.getEspnConnection, { leagueId });
    expect(connection).toEqual({
      hasCredentials: true,
      isPrivate: true,
      credentialStatus: "unknown",
      credentialCheckedAt: undefined,
      credentialError: undefined,
      lastSyncedAt: stored?.espnData?.lastSyncedAt,
      credentialSavedAt: stored?.espnData?.credentialSavedAt,
      credentialExpiresAt: undefined,
      contentPausedAt: undefined,
      backloggedCount: 0,
    });
    expect(connection.credentialSavedAt).toBeTypeOf("number");
    // The connection object must not carry the raw cookie fields at all.
    expect(connection).not.toHaveProperty("espnS2");
    expect(connection).not.toHaveProperty("swid");
  });

  it("stores a commissioner-entered expiry, and clears the prior reminder stamp on re-save", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);
    const expiresAt = Date.now() + 10 * 24 * 60 * 60 * 1000;

    await t.withIdentity({ subject: COMMISSIONER }).mutation(api.leagues.updateEspnCredentials, {
      leagueId,
      espnS2: "abc",
      swid: "{ABC}",
      expiresAt,
    });

    let stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData?.credentialExpiresAt).toBe(expiresAt);
    expect(stored?.espnData?.credentialSavedAt).toBeTypeOf("number");

    // Simulate a reminder having already fired for this expiry, then a
    // re-save (e.g. the commissioner pastes a fresh pair) must clear it -
    // the old reminder no longer applies to whatever expiry the new pair has.
    await t.run(async (ctx) => {
      const league = await ctx.db.get(leagueId);
      await ctx.db.patch(leagueId, {
        espnData: { ...league!.espnData!, expiryReminderSentFor: expiresAt },
      });
    });

    await t.withIdentity({ subject: COMMISSIONER }).mutation(api.leagues.updateEspnCredentials, {
      leagueId,
      espnS2: "def",
      swid: "{DEF}",
      // Omitted this time - clears any previously-entered expiry.
    });

    stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData?.credentialExpiresAt).toBeUndefined();
    expect(stored?.espnData?.expiryReminderSentFor).toBeUndefined();
  });

  it("rejects a non-commissioner member", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    await expect(
      t.withIdentity({ subject: MEMBER }).mutation(api.leagues.updateEspnCredentials, {
        leagueId,
        espnS2: "abc",
        swid: "{ABC}",
      })
    ).rejects.toThrow(/commissioner/i);
  });

  it("rejects a non-member entirely", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t);

    await expect(
      t.withIdentity({ subject: OUTSIDER }).mutation(api.leagues.updateEspnCredentials, {
        leagueId,
        espnS2: "abc",
        swid: "{ABC}",
      })
    ).rejects.toThrow(/not a member|not authorized/i);
  });

  it("works for a league that has never had ESPN data", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { withEspnData: false });

    await t.withIdentity({ subject: COMMISSIONER }).mutation(api.leagues.updateEspnCredentials, {
      leagueId,
      espnS2: "fresh_s2",
      swid: "{FRESH}",
    });

    const connection = await t
      .withIdentity({ subject: COMMISSIONER })
      .query(api.leagues.getEspnConnection, { leagueId });
    expect(connection.hasCredentials).toBe(true);
    expect(connection.isPrivate).toBe(true);
  });
});

describe("leagues.getEspnConnection", () => {
  it("member-gates the read", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { withEspnData: true });

    await expect(
      t.withIdentity({ subject: OUTSIDER }).query(api.leagues.getEspnConnection, { leagueId })
    ).rejects.toThrow(/not a member/i);

    // A plain member (not just the commissioner) can read connection health.
    const connection = await t
      .withIdentity({ subject: MEMBER })
      .query(api.leagues.getEspnConnection, { leagueId });
    expect(connection.hasCredentials).toBe(true);
  });

  it("defaults credentialStatus to unknown before any probe", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { withEspnData: true });

    const connection = await t
      .withIdentity({ subject: COMMISSIONER })
      .query(api.leagues.getEspnConnection, { leagueId });
    expect(connection.credentialStatus).toBe("unknown");
  });

  it("counts backlogged scheduled content and surfaces contentPausedAt", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { withEspnData: true });

    await t.run(async (ctx) => {
      const now = Date.now();
      const league = await ctx.db.get(leagueId);
      await ctx.db.patch(leagueId, {
        espnData: { ...league!.espnData!, contentPausedAt: now },
      });

      const scheduleId = await ctx.db.insert("contentSchedules", {
        leagueId,
        contentType: "weekly_recap",
        enabled: true,
        timezone: "America/New_York",
        schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 },
        createdAt: now,
        updatedAt: now,
      });

      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("scheduledContent", {
          leagueId,
          contentScheduleId: scheduleId,
          contentType: "weekly_recap",
          scheduledFor: now,
          status: "backlogged",
          attempts: 0,
          maxAttempts: 3,
          backlogReason: "espn_credentials_invalid",
          backloggedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      // A non-backlogged row must not be counted.
      await ctx.db.insert("scheduledContent", {
        leagueId,
        contentScheduleId: scheduleId,
        contentType: "weekly_recap",
        scheduledFor: now,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
      });
    });

    const connection = await t
      .withIdentity({ subject: COMMISSIONER })
      .query(api.leagues.getEspnConnection, { leagueId });
    expect(connection.backloggedCount).toBe(2);
    expect(connection.contentPausedAt).toBeTypeOf("number");
  });
});

describe("internal.leagues.setEspnCredentialStatus", () => {
  it("persists an invalid status with its error message", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { withEspnData: true });

    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "invalid",
      error: "ESPN API returned 401: Unauthorized",
    });

    const connection = await t
      .withIdentity({ subject: COMMISSIONER })
      .query(api.leagues.getEspnConnection, { leagueId });
    expect(connection.credentialStatus).toBe("invalid");
    expect(connection.credentialError).toBe("ESPN API returned 401: Unauthorized");
    expect(connection.credentialCheckedAt).toBeTypeOf("number");
  });

  it("clears any stale error when the status flips back to valid", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { withEspnData: true });

    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "invalid",
      error: "ESPN API returned 401: Unauthorized",
    });
    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "valid",
    });

    const connection = await t
      .withIdentity({ subject: COMMISSIONER })
      .query(api.leagues.getEspnConnection, { leagueId });
    expect(connection.credentialStatus).toBe("valid");
    expect(connection.credentialError).toBeUndefined();
  });

  it("stamps credentialAlertedAt only when explicitly passed", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { withEspnData: true });

    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "invalid",
      error: "boom",
    });
    let stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData?.credentialAlertedAt).toBeUndefined();

    const alertedAt = Date.now();
    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "invalid",
      error: "boom again",
      alertedAt,
    });
    stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData?.credentialAlertedAt).toBe(alertedAt);
  });

  it("is a no-op for a league with no espnData", async () => {
    const t = convexTest(schema, modules);
    const leagueId = await seedLeague(t, { withEspnData: false });

    // Must not throw even though there's nothing to patch.
    await t.mutation(internal.leagues.setEspnCredentialStatus, {
      leagueId,
      status: "valid",
    });
    const stored = await t.run(async (ctx) => ctx.db.get(leagueId));
    expect(stored?.espnData).toBeUndefined();
  });
});
