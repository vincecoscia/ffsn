import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

const leagueArgs = {
  name: "Audit League",
  platform: "espn" as const,
  externalId: "424242",
  settings: {
    scoringType: "standard",
    rosterSize: 16,
    playoffWeeks: 3,
    categories: ["QB", "RB", "WR", "TE", "K", "DEF"],
  },
};

describe("checkout fulfillment without a PaymentIntent", () => {
  it("fulfills a $0 (promotion-code) credit top-up exactly once, keyed on the checkout session", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_free_topup";
    const call = () =>
      t.mutation(internal.stripe.processCheckoutSessionCompleted, {
        sessionId: "cs_test_promo_100",
        // Stripe creates no PaymentIntent for a session a coupon fully covers.
        paymentIntentId: undefined,
        paymentStatus: "paid",
        amountTotal: 0,
        metadata: { kind: "credit_topup", userId, quantity: "1", credits: "100" },
      });

    // Webhook delivery and the success page's verifyPaymentCompleted both call
    // this for the same session.
    await call();
    await call();

    const payments = await t.run((ctx) =>
      ctx.db
        .query("stripePayments")
        .withIndex("by_checkout_session", (q) => q.eq("checkoutSessionId", "cs_test_promo_100"))
        .collect()
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe("succeeded");
    expect(payments[0].paymentIntentId).toBeUndefined();
    expect(payments[0].amount).toBe(0);

    const balance = await t.run(async (ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first()
    );
    expect(balance?.balance).toBe(100);
    expect(balance?.creditsExpireAt).toBeGreaterThan(Date.now());
  });

  it("does not fulfill a session Stripe reports as unpaid", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.stripe.processCheckoutSessionCompleted, {
      sessionId: "cs_test_unpaid",
      paymentIntentId: "pi_test_unpaid",
      paymentStatus: "unpaid",
      metadata: { kind: "credit_topup", userId: "user_unpaid", quantity: "1", credits: "100" },
    });

    const balance = await t.run((ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", "user_unpaid"))
        .first()
    );
    expect(balance).toBeNull();
  });
});

describe("join credits require an active League Pass", () => {
  it("mints nothing on an unpaid league, and 100 exactly once on a paid one", async () => {
    const t = convexTest(schema, modules);
    const commissioner = t.withIdentity({ subject: "user_commish" });
    const leagueId = await commissioner.mutation(api.leagues.create, leagueArgs);
    const manager = "user_manager";

    const unpaid = await t.mutation(internal.credits.grantJoinCredits, { userId: manager, leagueId });
    expect(unpaid.granted).toBe(false);
    expect(unpaid.skippedReason).toBe("no_active_pass");

    const noBalance = await t.run((ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", manager))
        .first()
    );
    expect(noBalance).toBeNull();

    // The pass settles (what payments.processLeaguePayment writes).
    await t.run(async (ctx) => {
      const league = await ctx.db.get(leagueId);
      await ctx.db.patch(leagueId, {
        subscription: {
          ...league!.subscription,
          tier: "league_pass",
          status: "active",
          paymentStatus: "completed",
          seasonId: 2026,
          seasonYear: 2026,
        },
      });
    });

    const first = await t.mutation(internal.credits.grantJoinCredits, { userId: manager, leagueId });
    expect(first.granted).toBe(true);
    expect(first.creditsGranted).toBe(100);

    const replay = await t.mutation(internal.credits.grantJoinCredits, { userId: manager, leagueId });
    expect(replay.granted).toBe(false);
    expect(replay.alreadyGranted).toBe(true);

    const balance = await t.run((ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", manager))
        .first()
    );
    expect(balance?.balance).toBe(100);
    // Season 2026 credits expire 2027-02-15.
    expect(balance?.creditsExpireAt).toBe(Date.UTC(2027, 1, 15));
  });

  it("claiming a team on an unpaid league grants no credits", async () => {
    const t = convexTest(schema, modules);
    const commissioner = t.withIdentity({ subject: "user_commish2" });
    const leagueId = await commissioner.mutation(api.leagues.create, leagueArgs);

    const managerId = "user_claimer";
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        clerkId: managerId,
        email: "claimer@example.com",
        name: "Claimer",
        hasCompletedOnboarding: true,
        preferences: { emailNotifications: true },
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    });
    const manager = t.withIdentity({ subject: managerId });
    await manager.mutation(api.leagues.joinLeague, { leagueId });

    const teamId = await t.run((ctx) =>
      ctx.db.insert("teams", {
        leagueId,
        externalId: "1",
        name: "Team One",
        abbreviation: "ONE",
        owner: "Unknown",
        seasonId: 2026,
        record: { wins: 0, losses: 0, ties: 0 },
        roster: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await manager.mutation(api.teamClaims.claimTeam, { leagueId, teamId, seasonId: 2026 });

    const balance = await t.run((ctx) =>
      ctx.db
        .query("userCredits")
        .withIndex("by_user", (q) => q.eq("userId", managerId))
        .first()
    );
    expect(balance).toBeNull();
  });
});

describe("leagues.create is idempotent per commissioner + ESPN league", () => {
  it("returns the existing league instead of creating a duplicate", async () => {
    const t = convexTest(schema, modules);
    const commissioner = t.withIdentity({ subject: "user_dupe" });

    const first = await commissioner.mutation(api.leagues.create, leagueArgs);
    const second = await commissioner.mutation(api.leagues.create, {
      ...leagueArgs,
      name: "Audit League (renamed)",
    });

    expect(second).toBe(first);
    const leagues = await t.run((ctx) => ctx.db.query("leagues").collect());
    expect(leagues).toHaveLength(1);
    expect(leagues[0].name).toBe("Audit League (renamed)");
    expect(leagues[0].subscription.status).toBe("pending");
  });
});

describe("legacy credit expiry backfill", () => {
  it("stamps only balances with no expiry, honours dryRun, and lets the sweep zero them", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("userCredits", {
        userId: "legacy_a",
        balance: 100,
        totalEarned: 100,
        totalSpent: 0,
        totalPurchased: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("userCredits", {
        userId: "current_b",
        balance: 100,
        totalEarned: 0,
        totalSpent: 0,
        totalPurchased: 100,
        creditsExpireAt: Date.UTC(2027, 1, 15),
        createdAt: now,
        updatedAt: now,
      });
    });

    const dry = await t.mutation(internal.credits.backfillLegacyCreditExpiry, { seasonId: 2025 });
    expect(dry.dryRun).toBe(true);
    expect(dry.stamped).toBe(1);
    expect(dry.userIds).toEqual(["legacy_a"]);

    const untouched = await t.run((ctx) =>
      ctx.db.query("userCredits").withIndex("by_user", (q) => q.eq("userId", "legacy_a")).first()
    );
    expect(untouched?.creditsExpireAt).toBeUndefined();

    const real = await t.mutation(internal.credits.backfillLegacyCreditExpiry, {
      seasonId: 2025,
      dryRun: false,
    });
    expect(real.stamped).toBe(1);
    expect(real.expiresAt).toBe(Date.UTC(2026, 1, 15));

    const sweep = await t.mutation(internal.credits.expireSeasonCredits, { now });
    expect(sweep.expired).toBe(1);
    expect(sweep.creditsCleared).toBe(100);

    const after = await t.run(async (ctx) => ({
      legacy: await ctx.db.query("userCredits").withIndex("by_user", (q) => q.eq("userId", "legacy_a")).first(),
      current: await ctx.db.query("userCredits").withIndex("by_user", (q) => q.eq("userId", "current_b")).first(),
    }));
    expect(after.legacy?.balance).toBe(0);
    expect(after.current?.balance).toBe(100);
  });
});
