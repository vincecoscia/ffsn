/**
 * League Pass: seats, grants and expiry (spec §10.1).
 *
 * The three things that have to hold for the pass to be a product rather than
 * a promise: a league cannot hold more managers than it has paid for, a
 * replayed payment webhook cannot mint credits twice, and credits actually
 * stop being spendable when the season ends.
 */

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import {
  CREDITS_PER_MANAGER,
  INCLUDED_MANAGERS_DEFAULT,
  seasonCreditsExpireAt,
} from "../convex/credits";

const modules = import.meta.glob("../convex/**/*.*s");

/** `convexTest` bound to this app's schema, so helpers keep their index types. */
function makeTest() {
  return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof makeTest>;

const SEASON = 2026;
const COMMISSIONER = "clerk_pass_commish";

function managerId(index: number): string {
  return `clerk_pass_manager_${index}`;
}

/**
 * A league with `managers` membership rows (the commissioner is the first of
 * them), on an active pass for `SEASON`.
 */
async function seedLeague(
  t: TestHarness,
  opts: { managers?: number; extraSeats?: number; status?: string } = {}
) {
  const managers = opts.managers ?? 1;
  return await t.run(async (ctx) => {
    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      name: "Pass Test League",
      platform: "espn",
      externalId: "9001",
      commissionerUserId: COMMISSIONER,
      settings: { scoringType: "PPR", rosterSize: 16, playoffWeeks: 3, categories: [] },
      espnData: {
        seasonId: SEASON,
        currentScoringPeriod: 6,
        size: 12,
        lastSyncedAt: now,
        isPrivate: false,
      },
      subscription: {
        tier: "season_pass",
        status: opts.status ?? "active",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "completed",
        seasonYear: SEASON,
        seasonId: SEASON,
        extraSeats: opts.extraSeats,
      },
      lastSync: now,
      createdAt: now,
    });

    for (let i = 0; i < managers; i++) {
      const userId = i === 0 ? COMMISSIONER : managerId(i);
      await ctx.db.insert("leagueMemberships", {
        leagueId,
        userId,
        role: i === 0 ? "commissioner" : "member",
        joinedAt: now,
      });
    }

    return leagueId;
  });
}

async function balanceOf(t: TestHarness, userId: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("userCredits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    return row ?? null;
  });
}

describe("seats (spec §10.1)", () => {
  it("refuses the 13th manager and lets them in once a seat is bought", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t, { managers: INCLUDED_MANAGERS_DEFAULT });

    const beforeCapacity = await t
      .withIdentity({ subject: COMMISSIONER })
      .query(api.leagues.getLeagueCapacity, { leagueId });
    expect(beforeCapacity).toEqual({
      managers: INCLUDED_MANAGERS_DEFAULT,
      included: INCLUDED_MANAGERS_DEFAULT,
      extraSeats: 0,
      remaining: 0,
    });

    const thirteenth = t.withIdentity({ subject: managerId(99) });
    await expect(
      thirteenth.mutation(api.leagues.joinLeague, { leagueId })
    ).rejects.toThrow(/LEAGUE_AT_CAPACITY/);

    // The commissioner buys a $10 seat; PRICE-D's webhook calls this.
    const seat = await t.mutation(internal.leagues.recordExtraSeat, { leagueId });
    expect(seat).toEqual({
      included: INCLUDED_MANAGERS_DEFAULT,
      extraSeats: 1,
      total: INCLUDED_MANAGERS_DEFAULT + 1,
    });

    await thirteenth.mutation(api.leagues.joinLeague, { leagueId });

    const afterCapacity = await t
      .withIdentity({ subject: COMMISSIONER })
      .query(api.leagues.getLeagueCapacity, { leagueId });
    expect(afterCapacity).toEqual({
      managers: INCLUDED_MANAGERS_DEFAULT + 1,
      included: INCLUDED_MANAGERS_DEFAULT,
      extraSeats: 1,
      remaining: 0,
    });

    // And the 14th is refused again, on the same seat arithmetic.
    await expect(
      t.withIdentity({ subject: managerId(98) }).mutation(api.leagues.joinLeague, { leagueId })
    ).rejects.toThrow(/LEAGUE_AT_CAPACITY/);
  });

  it("keeps seat counts to league members", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t, { managers: 2 });

    await expect(
      t.withIdentity({ subject: "clerk_outsider" }).query(api.leagues.getLeagueCapacity, { leagueId })
    ).rejects.toThrow(/not a member/i);
  });
});

describe("pass grants (spec §10.1)", () => {
  it("grants every manager 100 credits, exactly once", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t, { managers: 4 });

    const first = await t.mutation(internal.credits.grantPassCredits, { leagueId });
    expect(first).toMatchObject({
      granted: 4,
      skipped: 0,
      amountPerManager: CREDITS_PER_MANAGER,
      seasonId: SEASON,
      expiresAt: seasonCreditsExpireAt(SEASON),
    });

    // A retried Stripe webhook. Nobody gets paid twice.
    const second = await t.mutation(internal.credits.grantPassCredits, { leagueId });
    expect(second).toMatchObject({ granted: 0, skipped: 4 });

    for (const userId of [COMMISSIONER, managerId(1), managerId(2), managerId(3)]) {
      const credits = await balanceOf(t, userId);
      expect(credits?.balance).toBe(CREDITS_PER_MANAGER);
      expect(credits?.creditsExpireAt).toBe(seasonCreditsExpireAt(SEASON));
    }

    const ledger = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
        .collect()
    );
    expect(ledger).toHaveLength(4);
    expect(new Set(ledger.map((row) => row.reason))).toEqual(
      new Set([`league_pass:${SEASON}`])
    );
  });

  it("covers a manager who joins after the pass was bought, and only once", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t, { managers: 1 });
    await t.mutation(internal.credits.grantPassCredits, { leagueId });

    const latecomer = managerId(7);
    const first = await t.mutation(internal.credits.grantJoinCredits, {
      userId: latecomer,
      leagueId,
    });
    expect(first).toMatchObject({ alreadyGranted: false, creditsGranted: CREDITS_PER_MANAGER });

    const second = await t.mutation(internal.credits.grantJoinCredits, {
      userId: latecomer,
      leagueId,
    });
    expect(second).toEqual({ alreadyGranted: true });
    expect((await balanceOf(t, latecomer))?.balance).toBe(CREDITS_PER_MANAGER);

    // A pass grant re-run afterwards does not top them up a second time either.
    await t.mutation(internal.credits.grantPassCredits, { leagueId });
    expect((await balanceOf(t, latecomer))?.balance).toBe(CREDITS_PER_MANAGER);
  });

  it("grants a bought seat its own 100 credits, idempotently", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t, { managers: 1 });
    const seatHolder = managerId(5);

    const first = await t.mutation(internal.credits.grantSeatCredits, {
      leagueId,
      userId: seatHolder,
    });
    expect(first).toMatchObject({ granted: true, amount: CREDITS_PER_MANAGER });

    const second = await t.mutation(internal.credits.grantSeatCredits, {
      leagueId,
      userId: seatHolder,
    });
    expect(second.granted).toBe(false);
    expect((await balanceOf(t, seatHolder))?.balance).toBe(CREDITS_PER_MANAGER);
  });

  it("lets a manager buy several top-ups but never double-credits one payment", async () => {
    const t = makeTest();
    const buyer = managerId(9);

    await t.mutation(internal.credits.grantTopUp, { userId: buyer, seasonId: SEASON });
    await t.mutation(internal.credits.grantTopUp, { userId: buyer, seasonId: SEASON });
    expect((await balanceOf(t, buyer))?.balance).toBe(2 * CREDITS_PER_MANAGER);

    const paymentId = await t.run((ctx) =>
      ctx.db.insert("stripePayments", {
        paymentIntentId: "pi_topup_1",
        checkoutSessionId: "cs_topup_1",
        amount: 500,
        currency: "usd",
        status: "succeeded",
        userId: buyer,
        paymentType: "credits_purchase",
        description: "100 credits",
        webhookProcessed: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    await t.mutation(internal.credits.grantTopUp, {
      userId: buyer,
      seasonId: SEASON,
      relatedPaymentId: paymentId,
    });
    const replay = await t.mutation(internal.credits.grantTopUp, {
      userId: buyer,
      seasonId: SEASON,
      relatedPaymentId: paymentId,
    });
    expect(replay.granted).toBe(false);
    expect((await balanceOf(t, buyer))?.balance).toBe(3 * CREDITS_PER_MANAGER);
  });
});

describe("credit expiry (spec §10.1)", () => {
  it("zeroes expired balances and leaves everything else alone", async () => {
    const t = makeTest();
    const expiry = seasonCreditsExpireAt(SEASON);
    const now = expiry + 24 * 60 * 60 * 1000;

    await t.run(async (ctx) => {
      const base = { totalEarned: 0, totalSpent: 0, totalPurchased: 0, createdAt: 0, updatedAt: 0 };
      // Past its expiry with a balance: swept.
      await ctx.db.insert("userCredits", {
        ...base,
        userId: "clerk_expired",
        balance: 65,
        creditsExpireAt: expiry,
      });
      // Past its expiry with nothing left: the marker still has to go.
      await ctx.db.insert("userCredits", {
        ...base,
        userId: "clerk_expired_empty",
        balance: 0,
        creditsExpireAt: expiry,
      });
      // Next season's credits: untouched.
      await ctx.db.insert("userCredits", {
        ...base,
        userId: "clerk_future",
        balance: 100,
        creditsExpireAt: seasonCreditsExpireAt(SEASON + 1),
      });
      // No expiry recorded at all: untouched, and never swept.
      await ctx.db.insert("userCredits", { ...base, userId: "clerk_no_expiry", balance: 40 });
    });

    const result = await t.mutation(internal.credits.expireSeasonCredits, { now });
    expect(result).toMatchObject({ swept: 2, expired: 1, creditsCleared: 65, more: false });

    expect((await balanceOf(t, "clerk_expired"))?.balance).toBe(0);
    expect((await balanceOf(t, "clerk_expired"))?.creditsExpireAt).toBeUndefined();
    expect((await balanceOf(t, "clerk_expired_empty"))?.creditsExpireAt).toBeUndefined();
    expect((await balanceOf(t, "clerk_future"))?.balance).toBe(100);
    expect((await balanceOf(t, "clerk_no_expiry"))?.balance).toBe(40);

    // The sweep is explained in the ledger, not just performed.
    const ledger = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", "clerk_expired"))
        .collect()
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "expired", amount: -65, balanceAfter: 0 });

    // Idempotent: a second Monday finds nothing left to do.
    const again = await t.mutation(internal.credits.expireSeasonCredits, { now });
    expect(again).toMatchObject({ swept: 0, expired: 0 });
  });

  it("a later grant pushes the expiry out rather than pulling it in", async () => {
    const t = makeTest();
    const leagueId = await seedLeague(t, { managers: 1 });

    await t.mutation(internal.credits.grantPassCredits, { leagueId });
    expect((await balanceOf(t, COMMISSIONER))?.creditsExpireAt).toBe(seasonCreditsExpireAt(SEASON));

    // A top-up bought against last season must not expire this season's credits.
    await t.mutation(internal.credits.grantTopUp, {
      userId: COMMISSIONER,
      seasonId: SEASON - 1,
    });
    expect((await balanceOf(t, COMMISSIONER))?.creditsExpireAt).toBe(seasonCreditsExpireAt(SEASON));

    // Next season's does push it out.
    await t.mutation(internal.credits.grantTopUp, {
      userId: COMMISSIONER,
      seasonId: SEASON + 1,
    });
    expect((await balanceOf(t, COMMISSIONER))?.creditsExpireAt).toBe(
      seasonCreditsExpireAt(SEASON + 1)
    );
  });
});
