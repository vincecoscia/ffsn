import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity } from "./lib/auth";
import { nflSeasonYearFor } from "./lib/season";
// Plain data modules (no runtime deps), safe in the Convex V8 isolate.
import {
  creditCostFor,
  INTERVIEW_CREDITS_PER_MANAGER,
} from "../src/lib/ai/content-templates";

/**
 * Re-exported so Convex callers have one import for the pricing surface.
 * `content-templates.ts` (PRICE-A) owns both: `creditCost` per type is the
 * single source of truth for what a manual generation costs, and interviews
 * add {@link INTERVIEW_CREDITS_PER_MANAGER} per manager asked (spec §10.2).
 */
export { creditCostFor, INTERVIEW_CREDITS_PER_MANAGER };

/* ========================================================================== *
 * League Pass pricing (spec §10.1 / §10.2)
 *
 * One league buys one pass per season. The pass covers every automated story
 * in the §9.1 calendar outright - automation never spends credits - and mints
 * 100 credits for each manager it includes. Credits are only ever spent by a
 * real person generating something by hand.
 * ========================================================================== */

/** Credits minted per covered manager by the pass, a seat, or a top-up. */
export const CREDITS_PER_MANAGER = 100;

/** Managers a base $100 pass covers before the commissioner buys seats. */
export const INCLUDED_MANAGERS_DEFAULT = 12;

/** Just enough of a league document to answer the pass questions below. */
type PassBearingLeague = {
  subscription?: {
    status?: string;
    seasonId?: number;
    seasonYear?: number;
    includedManagers?: number;
    extraSeats?: number;
  };
  espnData?: { seasonId?: number };
} | null | undefined;

/**
 * Is this league's League Pass live?
 *
 * `"active"` is the status spec §10.1 writes. `"paid"` is what every league
 * bought before the pass existed, and those leagues are paid up - shutting
 * their automation off on a rename would be a billing bug, not a fix. Nothing
 * else counts, and no caller compares `subscription.status` by hand.
 */
export function hasActivePass(league: PassBearingLeague): boolean {
  const status = league?.subscription?.status;
  return status === "active" || status === "paid";
}

/** The NFL season a league's pass (and therefore its spend cap) applies to. */
export function passSeasonId(league: PassBearingLeague): number {
  return (
    league?.subscription?.seasonId ??
    league?.espnData?.seasonId ??
    league?.subscription?.seasonYear ??
    nflSeasonYearFor()
  );
}

/** Managers the pass covers today: the included allowance plus bought seats. */
export function leagueSeatAllowance(league: PassBearingLeague): {
  included: number;
  extraSeats: number;
  total: number;
} {
  const included = league?.subscription?.includedManagers ?? INCLUDED_MANAGERS_DEFAULT;
  const extraSeats = league?.subscription?.extraSeats ?? 0;
  return { included, extraSeats, total: included + extraSeats };
}

/**
 * When credits granted for a season stop being spendable (spec §10.1: credits
 * expire at season end, no rollover).
 *
 * A season labelled YYYY runs August YYYY -> July YYYY+1 (`lib/season.ts`), so
 * its February 15 falls in YYYY+1. That is a few weeks after the Super Bowl:
 * long enough to write the season recap, short enough that nobody carries a
 * balance into the next pass.
 */
export function seasonCreditsExpireAt(seasonId: number): number {
  return Date.UTC(seasonId + 1, 1, 15, 0, 0, 0, 0);
}

/** Reason codes stored on `creditTransactions.reason`; also the idempotency key. */
export const GRANT_REASONS = {
  leaguePass: "league_pass",
  seat: "seat",
  topUp: "top_up",
} as const;

/** Has this exact (league, user, reason) grant already been made? */
async function grantAlreadyMade(
  ctx: QueryCtx | MutationCtx,
  leagueId: Id<"leagues">,
  userId: string,
  reason: string
): Promise<boolean> {
  const existing = await ctx.db
    .query("creditTransactions")
    .withIndex("by_league_user_reason", (q) =>
      q.eq("leagueId", leagueId).eq("userId", userId).eq("reason", reason)
    )
    .first();
  return existing !== null;
}

/** Every Clerk id that holds a seat in a league today, commissioner included. */
async function currentManagerIds(
  ctx: QueryCtx | MutationCtx,
  league: Doc<"leagues">
): Promise<string[]> {
  const memberships = await ctx.db
    .query("leagueMemberships")
    .withIndex("by_league", (q) => q.eq("leagueId", league._id))
    .take(200);

  const ids = new Set<string>(memberships.map((m) => m.userId));
  // The commissioner always holds a seat, membership row or not.
  if (league.commissionerUserId) ids.add(league.commissionerUserId);
  return [...ids];
}


// Grant credits to a user (internal function)
export const grantCredits = internalMutation({
  args: {
    userId: v.string(),
    amount: v.number(),
    type: v.union(v.literal("earned"), v.literal("purchased"), v.literal("bonus")),
    description: v.string(),
    leagueId: v.optional(v.id("leagues")),
    relatedPaymentId: v.optional(v.id("stripePayments")),
    relatedContentId: v.optional(v.id("aiContent")),
    // Machine-readable grant reason (see GRANT_REASONS). Stored on the ledger
    // row so the idempotent League Pass grants can find their own work.
    reason: v.optional(v.string()),
    // When these credits stop being spendable. Also raises the holder's
    // `userCredits.creditsExpireAt` so the weekly sweep can find the balance.
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Get or create user credits record
    let userCredits = await ctx.db
      .query("userCredits")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (!userCredits) {
      // Create initial credits record
      const id = await ctx.db.insert("userCredits", {
        userId: args.userId,
        balance: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalPurchased: 0,
        createdAt: now,
        updatedAt: now,
      });
      
      userCredits = await ctx.db.get(id);
      if (!userCredits) {
        throw new Error("Failed to create user credits record");
      }
    }

    // Update balance and totals
    const newBalance = userCredits.balance + args.amount;
    const updates: any = {
      balance: newBalance,
      updatedAt: now,
    };

    if (args.type === "earned") {
      updates.totalEarned = userCredits.totalEarned + args.amount;
    } else if (args.type === "purchased") {
      updates.totalPurchased = userCredits.totalPurchased + args.amount;
    }

    // Credits do not roll over (spec §10.1). A balance holds one expiry, and a
    // later grant can only push it out, never pull it in - otherwise a $5
    // top-up bought in January would expire the whole season's credits early.
    if (args.expiresAt && args.expiresAt > (userCredits.creditsExpireAt ?? 0)) {
      updates.creditsExpireAt = args.expiresAt;
    }

    // Create transaction record
    const transactionId = await ctx.db.insert("creditTransactions", {
      userId: args.userId,
      leagueId: args.leagueId,
      type: args.type,
      amount: args.amount,
      description: args.description,
      reason: args.reason,
      expiresAt: args.expiresAt,
      relatedPaymentId: args.relatedPaymentId,
      relatedContentId: args.relatedContentId,
      balanceAfter: newBalance,
      createdAt: now,
    });

    updates.lastTransactionId = transactionId;

    // Update user credits
    await ctx.db.patch(userCredits._id, updates);

    console.log(`Granted ${args.amount} credits to user ${args.userId}. New balance: ${newBalance}`);

    return {
      newBalance,
      transactionId,
    };
  },
});

// Deduct credits from a user (for AI content generation, etc.)
// Deduct credits from a user. INTERNAL ONLY — the caller-supplied userId is
// trusted, so exposing this publicly let anyone drain any user's balance.
export const deductCredits = internalMutation({
  args: {
    userId: v.string(),
    amount: v.number(),
    description: v.string(),
    leagueId: v.optional(v.id("leagues")),
    relatedContentId: v.optional(v.id("aiContent")),
  },
  handler: async (ctx, args) => {
    // Check if user has sufficient credits
    const userCredits = await ctx.db
      .query("userCredits")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (!userCredits || userCredits.balance < args.amount) {
      throw new Error(`Insufficient credits. Required: ${args.amount}, Available: ${userCredits?.balance || 0}`);
    }

    const now = Date.now();
    const newBalance = userCredits.balance - args.amount;

    // Create transaction record
    const transactionId = await ctx.db.insert("creditTransactions", {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "spent",
      amount: -args.amount, // Negative for spending
      description: args.description,
      relatedContentId: args.relatedContentId,
      balanceAfter: newBalance,
      createdAt: now,
    });

    // Update user credits
    await ctx.db.patch(userCredits._id, {
      balance: newBalance,
      totalSpent: userCredits.totalSpent + args.amount,
      lastTransactionId: transactionId,
      updatedAt: now,
    });

    console.log(`Deducted ${args.amount} credits from user ${args.userId}. New balance: ${newBalance}`);

    return {
      newBalance,
      transactionId,
    };
  },
});

// Refund credits to a user after a paid-for operation (e.g. AI content
// generation) failed to complete. INTERNAL ONLY — mirrors grantCredits /
// deductCredits; the caller-supplied userId is trusted, so this must never
// be publicly callable. Uses the "refunded" creditTransactions type, which
// already exists in the schema union.
export const refundCredits = internalMutation({
  args: {
    userId: v.string(),
    amount: v.number(),
    description: v.string(),
    leagueId: v.optional(v.id("leagues")),
    relatedContentId: v.optional(v.id("aiContent")),
    relatedPaymentId: v.optional(v.id("stripePayments")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Get or create user credits record
    let userCredits = await ctx.db
      .query("userCredits")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (!userCredits) {
      const id = await ctx.db.insert("userCredits", {
        userId: args.userId,
        balance: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalPurchased: 0,
        createdAt: now,
        updatedAt: now,
      });

      userCredits = await ctx.db.get(id);
      if (!userCredits) {
        throw new Error("Failed to create user credits record");
      }
    }

    const newBalance = userCredits.balance + args.amount;

    // Create transaction record
    const transactionId = await ctx.db.insert("creditTransactions", {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "refunded",
      amount: args.amount,
      description: args.description,
      relatedPaymentId: args.relatedPaymentId,
      relatedContentId: args.relatedContentId,
      balanceAfter: newBalance,
      createdAt: now,
    });

    // Update user credits. totalSpent is reduced to reflect that the
    // original spend never actually delivered the paid-for content.
    await ctx.db.patch(userCredits._id, {
      balance: newBalance,
      totalSpent: Math.max(0, userCredits.totalSpent - args.amount),
      lastTransactionId: transactionId,
      updatedAt: now,
    });

    console.log(`Refunded ${args.amount} credits to user ${args.userId}. New balance: ${newBalance}`);

    return {
      newBalance,
      transactionId,
    };
  },
});

// Check if user has sufficient credits. INTERNAL ONLY — the caller-supplied
// userId is trusted, so this must never be publicly callable.
export const checkSufficientCredits = internalQuery({
  args: {
    userId: v.string(),
    requiredAmount: v.number(),
  },
  handler: async (ctx, args) => {
    const userCredits = await ctx.db
      .query("userCredits")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    const currentBalance = userCredits?.balance || 0;

    return {
      hasSufficientCredits: currentBalance >= args.requiredAmount,
      currentBalance,
      requiredAmount: args.requiredAmount,
      shortage: Math.max(0, args.requiredAmount - currentBalance),
    };
  },
});

// Get the authenticated user's current credit balance and stats.
export const getUserCredits = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        balance: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalPurchased: 0,
        lastUpdated: null,
      };
    }

    const userCredits = await ctx.db
      .query("userCredits")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .first();

    if (!userCredits) {
      return {
        balance: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalPurchased: 0,
        lastUpdated: null,
      };
    }

    return {
      balance: userCredits.balance,
      totalEarned: userCredits.totalEarned,
      totalSpent: userCredits.totalSpent,
      totalPurchased: userCredits.totalPurchased,
      lastUpdated: userCredits.updatedAt,
    };
  },
});

// Get the authenticated user's credit transaction history.
export const getCreditHistory = query({
  args: {
    limit: v.optional(v.number()),
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    let query = ctx.db
      .query("creditTransactions")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject));

    if (args.leagueId) {
      query = ctx.db
        .query("creditTransactions")
        .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
        .filter((q) => q.eq(q.field("userId"), identity.subject));
    }

    const transactions = await query
      .order("desc")
      .take(args.limit || 50);

    return transactions.map((tx) => ({
      id: tx._id,
      type: tx.type,
      amount: tx.amount,
      description: tx.description,
      balanceAfter: tx.balanceAfter,
      createdAt: tx.createdAt,
      leagueId: tx.leagueId,
    }));
  },
});

// Grant join bonus credits when user joins a league. INTERNAL ONLY — it mints
// credits, so it must never be publicly callable (that let anyone farm 100
// credits per league). Callers must verify the user's league membership first.
export const grantJoinCredits = internalMutation({
  args: {
    userId: v.string(),
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args): Promise<{ alreadyGranted: boolean; newBalance?: number; creditsGranted?: number }> => {
    const league = await ctx.db.get(args.leagueId);
    const seasonId = passSeasonId(league);
    const reason = `${GRANT_REASONS.leaguePass}:${seasonId}`;

    // Idempotency, two ways. The reason index covers everything granted since
    // the League Pass shipped; the description match below still covers the
    // join bonuses that predate it, so a returning manager is not paid twice.
    if (await grantAlreadyMade(ctx, args.leagueId, args.userId, reason)) {
      console.log(`User ${args.userId} already has ${seasonId} pass credits for league ${args.leagueId}`);
      return { alreadyGranted: true };
    }

    const legacyCredit = await ctx.db
      .query("creditTransactions")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .filter((q) => q.eq(q.field("type"), "earned"))
      .filter((q) => q.eq(q.field("description"), "League join bonus - 100 credits"))
      .first();

    if (legacyCredit) {
      console.log(`User ${args.userId} already received join credits for league ${args.leagueId}`);
      return { alreadyGranted: true };
    }

    // The manager's share of the League Pass (spec §10.1). Same reason and
    // expiry as `grantPassCredits`, so a manager who joins after the pass was
    // bought gets their 100 exactly once however they arrive.
    const result = await ctx.runMutation(internal.credits.grantCredits, {
      userId: args.userId,
      amount: CREDITS_PER_MANAGER,
      type: "earned",
      description: `League Pass credits - ${CREDITS_PER_MANAGER} credits for the ${seasonId} season`,
      leagueId: args.leagueId,
      reason,
      expiresAt: seasonCreditsExpireAt(seasonId),
    });

    return {
      alreadyGranted: false,
      newBalance: result.newBalance,
      creditsGranted: CREDITS_PER_MANAGER,
    };
  },
});

// Get credit statistics for a league (admin view). INTERNAL ONLY.
export const getLeagueCreditStats = internalQuery({
  args: {
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    const transactions = await ctx.db
      .query("creditTransactions")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    const stats = transactions.reduce(
      (acc, tx) => {
        acc.totalTransactions++;
        
        if (tx.type === "earned") {
          acc.totalEarned += tx.amount;
        } else if (tx.type === "spent") {
          acc.totalSpent += Math.abs(tx.amount);
        } else if (tx.type === "purchased") {
          acc.totalPurchased += tx.amount;
        }
        
        // Track unique users
        if (!acc.uniqueUsers.has(tx.userId)) {
          acc.uniqueUsers.add(tx.userId);
          acc.activeUsers++;
        }
        
        return acc;
      },
      {
        totalTransactions: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalPurchased: 0,
        activeUsers: 0,
        uniqueUsers: new Set<string>(),
      }
    );

    // Remove the Set from the returned object
    const { uniqueUsers, ...returnStats } = stats;
    
    return returnStats;
  },
});

// Calculate AI content generation cost based on content type
export const calculateContentCost = query({
  args: {
    contentType: v.string(),
    wordCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireIdentity(ctx);

    // Define credit costs for different content types
    const baseCosts: Record<string, number> = {
      "weekly_recap": 15,
      "weekly_preview": 12,
      "trade_analysis": 20,
      "power_rankings": 18,
      "waiver_wire_report": 10,
      "rivalry_week_special": 25,
      "season_recap": 30,
      "custom_roast": 8,
      "mock_draft": 22,
    };

    const baseCost = baseCosts[args.contentType] || 15;
    
    // Adjust for word count if provided
    let finalCost = baseCost;
    if (args.wordCount) {
      const wordMultiplier = Math.max(0.5, Math.min(2.0, args.wordCount / 500));
      finalCost = Math.round(baseCost * wordMultiplier);
    }

    return {
      baseCost,
      finalCost,
      contentType: args.contentType,
      wordCount: args.wordCount,
    };
  },
});
/* ========================================================================== *
 * League Pass grants (spec §10.1)
 *
 * PRICE-D's Stripe webhooks call these three. Every one of them is idempotent
 * on (leagueId, userId, reason) - a webhook that Stripe retries three times
 * mints one grant - and every one of them stamps a season expiry, because
 * credits do not roll over.
 * ========================================================================== */

const passGrantResultValidator = v.object({
  granted: v.number(),
  skipped: v.number(),
  amountPerManager: v.number(),
  seasonId: v.number(),
  expiresAt: v.number(),
});

/**
 * 100 credits for every current manager of a league, commissioner included.
 * Called when a League Pass payment settles.
 *
 * Idempotent per manager: a manager who already has this season's pass grant is
 * skipped, so a replayed webhook - or a pass bought again after a refund and
 * re-purchase in the same season - never doubles anyone's balance.
 */
export const grantPassCredits = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    /** Defaults to the league's pass season. */
    seasonId: v.optional(v.number()),
  },
  returns: passGrantResultValidator,
  // Annotated because this mutation calls another in the same module through
  // `internal.*`; without it TypeScript cannot break the inference cycle.
  handler: async (
    ctx,
    args
  ): Promise<{
    granted: number;
    skipped: number;
    amountPerManager: number;
    seasonId: number;
    expiresAt: number;
  }> => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const seasonId = args.seasonId ?? passSeasonId(league);
    const expiresAt = seasonCreditsExpireAt(seasonId);
    const reason = `${GRANT_REASONS.leaguePass}:${seasonId}`;

    let granted = 0;
    let skipped = 0;

    for (const userId of await currentManagerIds(ctx, league)) {
      if (await grantAlreadyMade(ctx, args.leagueId, userId, reason)) {
        skipped++;
        continue;
      }
      await ctx.runMutation(internal.credits.grantCredits, {
        userId,
        amount: CREDITS_PER_MANAGER,
        type: "purchased",
        description: `League Pass credits - ${CREDITS_PER_MANAGER} credits for the ${seasonId} season`,
        leagueId: args.leagueId,
        reason,
        expiresAt,
      });
      granted++;
    }

    console.log(
      `League Pass credits for league ${args.leagueId} (${seasonId}): granted ${granted}, skipped ${skipped}`
    );

    return {
      granted,
      skipped,
      amountPerManager: CREDITS_PER_MANAGER,
      seasonId,
      expiresAt,
    };
  },
});

/**
 * The 100 credits that come with a $10 extra seat, for the one manager the
 * seat was bought for. Idempotent per (league, user, season).
 */
export const grantSeatCredits = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    userId: v.string(),
    seasonId: v.optional(v.number()),
  },
  returns: v.object({
    granted: v.boolean(),
    amount: v.number(),
    seasonId: v.number(),
    expiresAt: v.number(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ granted: boolean; amount: number; seasonId: number; expiresAt: number }> => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const seasonId = args.seasonId ?? passSeasonId(league);
    const expiresAt = seasonCreditsExpireAt(seasonId);
    // A seat holder may already have been covered by the pass itself; the seat
    // grant is its own reason, so both can legitimately land for one manager.
    const reason = `${GRANT_REASONS.seat}:${seasonId}`;

    if (await grantAlreadyMade(ctx, args.leagueId, args.userId, reason)) {
      return { granted: false, amount: 0, seasonId, expiresAt };
    }

    await ctx.runMutation(internal.credits.grantCredits, {
      userId: args.userId,
      amount: CREDITS_PER_MANAGER,
      type: "purchased",
      description: `Extra seat credits - ${CREDITS_PER_MANAGER} credits for the ${seasonId} season`,
      leagueId: args.leagueId,
      reason,
      expiresAt,
    });

    return { granted: true, amount: CREDITS_PER_MANAGER, seasonId, expiresAt };
  },
});

/**
 * A manager's own $5 top-up: 100 more credits on their existing balance.
 *
 * Unlike the pass and seat grants, a top-up is deliberately repeatable - a
 * manager may buy five of them - so it is deduped on the Stripe payment that
 * paid for it rather than on a reason alone. Called without
 * `relatedPaymentId` (a manual grant), it always mints.
 */
export const grantTopUp = internalMutation({
  args: {
    userId: v.string(),
    amount: v.optional(v.number()),
    leagueId: v.optional(v.id("leagues")),
    seasonId: v.optional(v.number()),
    relatedPaymentId: v.optional(v.id("stripePayments")),
  },
  returns: v.object({
    granted: v.boolean(),
    amount: v.number(),
    seasonId: v.number(),
    expiresAt: v.number(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ granted: boolean; amount: number; seasonId: number; expiresAt: number }> => {
    const league = args.leagueId ? await ctx.db.get(args.leagueId) : null;
    const seasonId = args.seasonId ?? passSeasonId(league);
    const expiresAt = seasonCreditsExpireAt(seasonId);
    const amount = args.amount ?? CREDITS_PER_MANAGER;

    if (args.relatedPaymentId) {
      const existing = await ctx.db
        .query("creditTransactions")
        .withIndex("by_payment", (q) => q.eq("relatedPaymentId", args.relatedPaymentId))
        .first();
      if (existing) {
        return { granted: false, amount: 0, seasonId, expiresAt };
      }
    }

    await ctx.runMutation(internal.credits.grantCredits, {
      userId: args.userId,
      amount,
      type: "purchased",
      description: `Credit top-up - ${amount} credits`,
      leagueId: args.leagueId,
      relatedPaymentId: args.relatedPaymentId,
      reason: `${GRANT_REASONS.topUp}:${seasonId}`,
      expiresAt,
    });

    return { granted: true, amount, seasonId, expiresAt };
  },
});

/**
 * Season-end sweep (spec §10.1: credits expire, no rollover).
 *
 * Zeroes every balance whose `creditsExpireAt` has passed and writes an
 * `expired` ledger row for it, so the manager can see where the credits went.
 * Balances with no expiry, or with an expiry still in the future, are not
 * touched. Runs weekly from `crons.ts`; batches itself so a large deployment
 * never blows the mutation's document budget.
 */
export const expireSeasonCredits = internalMutation({
  args: {
    /** Test seam. Mutations may read the clock, so this defaults to now. */
    now: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    swept: v.number(),
    expired: v.number(),
    creditsCleared: v.number(),
    more: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.min(args.limit ?? 200, 500);

    // The lower bound matters: an index range that started at "undefined"
    // would sweep every account that has no expiry at all.
    const due = await ctx.db
      .query("userCredits")
      .withIndex("by_expiry", (q) =>
        q.gte("creditsExpireAt", 1).lte("creditsExpireAt", now)
      )
      .take(limit + 1);

    const more = due.length > limit;
    const batch = more ? due.slice(0, limit) : due;

    let expired = 0;
    let creditsCleared = 0;

    for (const row of batch) {
      const balance = row.balance;
      if (balance > 0) {
        const transactionId = await ctx.db.insert("creditTransactions", {
          userId: row.userId,
          type: "expired",
          amount: -balance,
          description: `Season credits expired - ${balance} credits`,
          reason: "season_expiry",
          balanceAfter: 0,
          createdAt: now,
        });
        await ctx.db.patch(row._id, {
          balance: 0,
          lastTransactionId: transactionId,
          // Cleared so the sweep terminates; the next grant sets a new expiry.
          creditsExpireAt: undefined,
          updatedAt: now,
        });
        expired++;
        creditsCleared += balance;
      } else {
        // Nothing to expire, but the marker has to go or this row comes back
        // in every sweep from now until the heat death of the universe.
        await ctx.db.patch(row._id, { creditsExpireAt: undefined, updatedAt: now });
      }
    }

    if (more) {
      // Fresh transaction for the next batch (Convex mutation limits).
      await ctx.scheduler.runAfter(0, internal.credits.expireSeasonCredits, {
        now,
        limit,
      });
    }

    if (batch.length > 0) {
      console.log(
        `expireSeasonCredits: swept ${batch.length} balances, expired ${expired} (${creditsCleared} credits)${more ? ", more to come" : ""}`
      );
    }

    return { swept: batch.length, expired, creditsCleared, more };
  },
});
