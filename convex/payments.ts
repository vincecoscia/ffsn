import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { leagueCurrentSeason } from "./lib/season";
import { INCLUDED_MANAGERS_DEFAULT } from "./credits";

/** Credits one top-up unit buys (spec §10.1: 100 credits for $5). */
const CREDITS_PER_TOPUP_UNIT = 100;

/**
 * Fulfillment idempotency marker for league-scoped purchases (pass and seats).
 *
 * PRICE-B's grant mutations take only ids, so they leave no
 * `creditTransactions.relatedPaymentId` trail to check. The `leaguePayments`
 * row inserted alongside each grant does the job instead: it is unique per
 * `stripePayments` id (index `by_payment`), and it is written in the same
 * transaction as the grant, so a webhook retry - or `verifyPaymentCompleted`
 * racing the webhook for the same session - finds it and skips.
 */

// Process the League Pass purchase (spec §10.1): activate the pass for the
// league's current season with 12 included managers, then grant every manager
// their 100 credits. The old flat 1,000-credit commissioner bonus is gone -
// `grantPassCredits` gives the commissioner the same 100 as everyone else.
export const processLeaguePayment = internalMutation({
  args: {
    paymentId: v.id("stripePayments"),
    sessionMetadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment) {
      throw new Error("Payment record not found");
    }

    const userId = payment.userId;
    const now = Date.now();

    // Record the money regardless - a pass bought before the league row exists
    // (legacy flow) is fulfilled later by linkPaymentToLeague.
    if (payment.status !== "succeeded") {
      await ctx.db.patch(args.paymentId, {
        status: "succeeded",
        paidAt: payment.paidAt ?? now,
        updatedAt: now,
      });
    }

    const leagueId = payment.leagueId;
    if (!leagueId) {
      console.log(
        `League Pass payment ${args.paymentId} has no league yet; fulfillment deferred to linkPaymentToLeague`
      );
      return;
    }

    // Idempotency: one leaguePayments row per stripePayments row.
    const existingLeaguePayment = await ctx.db
      .query("leaguePayments")
      .withIndex("by_payment", (q) => q.eq("stripePaymentId", args.paymentId))
      .first();

    if (existingLeaguePayment) {
      console.log(`League Pass already fulfilled for payment ${args.paymentId}; skipping`);
      return;
    }

    const league = await ctx.db.get(leagueId);
    const seasonId =
      parseInt(args.sessionMetadata.seasonYear || "") || leagueCurrentSeason(league);

    await ctx.db.insert("leaguePayments", {
      leagueId,
      stripePaymentId: args.paymentId,
      seasonYear: seasonId,
      amount: payment.amount,
      currency: payment.currency,
      status: "completed",
      paidByUserId: userId,
      paidAt: now,
      createdAt: now,
    });

    if (league) {
      // Spreading keeps any seats already bought for this league; only the pass
      // fields move. `includedManagers` is written explicitly so the league's
      // allowance survives a later change to the default (same reasoning as
      // `leagues.recordExtraSeat`).
      await ctx.db.patch(leagueId, {
        subscription: {
          ...league.subscription,
          tier: "league_pass",
          status: "active",
          paymentStatus: "completed",
          paidAt: now,
          seasonYear: seasonId,
          seasonId,
          includedManagers:
            league.subscription.includedManagers ?? INCLUDED_MANAGERS_DEFAULT,
        },
      });
    }

    // 100 credits for every manager, commissioner included.
    await ctx.runMutation(internal.credits.grantPassCredits, { leagueId, seasonId });

    // Season kickoff (owner directive, Sept 2026: "season_welcome" rings in
    // every season, not just a league's first one, and is included in the
    // subscription). `kickOffSeasonWelcome` owns the existence check, article
    // creation and generation scheduling, billed to the pass (userId
    // "system") - no credit check or deduction here anymore.
    try {
      await ctx.runMutation(internal.contentScheduling.kickOffSeasonWelcome, { leagueId, seasonId });
    } catch (error) {
      console.error("Error kicking off the season welcome article:", error);
      // Don't fail the entire payment process if content generation fails
    }

    console.log(`League Pass processed: $${payment.amount / 100} for league ${leagueId}`);
  },
});

// Process an extra manager seat purchase (spec §10.1): $10 per seat, bought by
// the commissioner. Each seat raises the league's capacity by one; when the
// commissioner named the manager the seat is for, that manager also gets the
// 100 credits the seat includes.
export const processExtraSeatPurchase = internalMutation({
  args: {
    paymentId: v.id("stripePayments"),
    sessionMetadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment) {
      throw new Error("Payment record not found");
    }

    const leagueId = payment.leagueId;
    if (!leagueId) {
      throw new Error(`Extra seat payment ${args.paymentId} has no league`);
    }

    // Idempotency: same leaguePayments marker as the pass.
    const existingLeaguePayment = await ctx.db
      .query("leaguePayments")
      .withIndex("by_payment", (q) => q.eq("stripePaymentId", args.paymentId))
      .first();

    if (existingLeaguePayment) {
      console.log(`Extra seats already recorded for payment ${args.paymentId}; skipping`);
      return;
    }

    const parsedQuantity = Math.floor(Number(args.sessionMetadata.quantity || "1"));
    const quantity = Number.isFinite(parsedQuantity)
      ? Math.min(Math.max(parsedQuantity, 1), 8)
      : 1;

    const now = Date.now();
    const league = await ctx.db.get(leagueId);
    const seasonId =
      parseInt(args.sessionMetadata.seasonYear || "") || leagueCurrentSeason(league);

    await ctx.db.patch(args.paymentId, {
      status: "succeeded",
      paidAt: payment.paidAt ?? now,
      updatedAt: now,
    });

    await ctx.db.insert("leaguePayments", {
      leagueId,
      stripePaymentId: args.paymentId,
      seasonYear: seasonId,
      amount: payment.amount,
      currency: payment.currency,
      status: "completed",
      paidByUserId: payment.userId,
      paidAt: now,
      createdAt: now,
    });

    await ctx.runMutation(internal.leagues.recordExtraSeat, { leagueId, count: quantity });

    // The seat's own 100 credits, when the commissioner bought it for a
    // specific manager rather than buying capacity ahead of time.
    const seatUserId = args.sessionMetadata.seatUserId;
    if (seatUserId) {
      await ctx.runMutation(internal.credits.grantSeatCredits, {
        leagueId,
        userId: seatUserId,
        seasonId,
      });
    }

    console.log(
      `Extra seats processed: ${quantity} seat(s) for league ${leagueId} (payment ${args.paymentId})`
    );
  },
});

// Link a payment record to a league after league creation
export const linkPaymentToLeague = mutation({
  args: {
    userId: v.string(),
    leagueId: v.id("leagues"),
    paymentType: v.literal("league_creation"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }
    if (identity.subject !== args.userId) {
      throw new Error("Cannot link a payment belonging to another user");
    }

    // Find the most recent pending or succeeded payment for this user
    const payment = await ctx.db
      .query("stripePayments")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .filter((q) =>
        q.and(
          q.eq(q.field("paymentType"), args.paymentType),
          q.or(
            q.eq(q.field("status"), "pending"),
            q.eq(q.field("status"), "succeeded")
          )
        )
      )
      .order("desc")
      .first();

    if (payment && !payment.leagueId) {
      // Update the payment record with the league ID
      await ctx.db.patch(payment._id, {
        leagueId: args.leagueId,
        updatedAt: Date.now(),
      });

      // If payment is already succeeded, process the league payment
      if (payment.status === "succeeded") {
        await ctx.runMutation(internal.payments.processLeaguePayment, {
          paymentId: payment._id,
          sessionMetadata: {
            userId: args.userId,
            kind: "league_pass",
            paymentType: "league_creation",
            seasonYear: new Date().getFullYear().toString(),
          },
        });
      }

      console.log(`Linked payment ${payment._id} to league ${args.leagueId}`);
    }
  },
});

// Process a credit top-up (spec §10.1): 100 credits per $5 unit, credited to
// the manager who bought it.
export const processCreditsPurchase = internalMutation({
  args: {
    paymentId: v.id("stripePayments"),
    sessionMetadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment) {
      throw new Error("Payment record not found");
    }

    // Idempotency: a retried webhook, or verifyPaymentCompleted racing the
    // webhook for the same session, must not grant credits twice. The status
    // flip below happens in the same transaction as the grant, and nothing
    // else in this codebase sets "succeeded" on an unfulfilled payment. The
    // creditTransactions check covers the older grant path, which stamped
    // `relatedPaymentId`.
    const alreadyGranted = await ctx.db
      .query("creditTransactions")
      .withIndex("by_payment", (q) => q.eq("relatedPaymentId", args.paymentId))
      .first();

    if (alreadyGranted || payment.status === "succeeded") {
      console.log(`Credits already granted for payment ${args.paymentId}; skipping duplicate grant`);
      return;
    }

    const quantityRaw = Math.floor(Number(args.sessionMetadata.quantity || "1"));
    const quantity = Number.isFinite(quantityRaw) ? Math.min(Math.max(quantityRaw, 1), 20) : 1;
    const amount =
      payment.metadata?.creditsPurchased ??
      (parseInt(args.sessionMetadata.credits || "") || CREDITS_PER_TOPUP_UNIT * quantity);

    const userId = payment.userId;
    const now = Date.now();

    await ctx.db.patch(args.paymentId, {
      status: "succeeded",
      paidAt: payment.paidAt ?? now,
      updatedAt: now,
    });

    // `relatedPaymentId` is what makes the grant itself idempotent, so a
    // replay that somehow gets past the guards above still cannot double-mint.
    await ctx.runMutation(internal.credits.grantTopUp, {
      userId,
      amount,
      leagueId: payment.leagueId,
      relatedPaymentId: args.paymentId,
    });

    console.log(`Credit top-up processed: ${amount} credits for user ${userId}`);
  },
});

// Get user's payment history
// INTERNAL ONLY — exposes payment records; must not be publicly callable.
export const getUserPaymentHistory = internalQuery({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const payments = await ctx.db
      .query("stripePayments")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit || 50);

    return payments.map((payment) => ({
      id: payment._id,
      type: payment.paymentType,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      description: payment.description,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
      metadata: payment.metadata,
    }));
  },
});

// Get league payment status
// INTERNAL ONLY.
export const getLeaguePaymentStatus = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    seasonYear: v.number(),
  },
  handler: async (ctx, args) => {
    const leaguePayment = await ctx.db
      .query("leaguePayments")
      .withIndex("by_league_season", (q) =>
        q.eq("leagueId", args.leagueId).eq("seasonYear", args.seasonYear)
      )
      .first();

    if (!leaguePayment) {
      return { isPaid: false, status: "pending" };
    }

    const stripePayment = await ctx.db.get(leaguePayment.stripePaymentId);

    return {
      isPaid: leaguePayment.status === "completed",
      status: leaguePayment.status,
      amount: leaguePayment.amount,
      paidAt: leaguePayment.paidAt,
      paidBy: leaguePayment.paidByUserId,
      stripePaymentStatus: stripePayment?.status,
    };
  },
});

// Get all pending payments (for admin/monitoring)
// INTERNAL ONLY — exposed the full pending-payment table (intent ids, user ids).
export const getPendingPayments = internalQuery({
  args: {},
  handler: async (ctx) => {
    const pendingPayments = await ctx.db
      .query("stripePayments")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(100);

    return pendingPayments.map((payment) => ({
      id: payment._id,
      paymentIntentId: payment.paymentIntentId,
      type: payment.paymentType,
      amount: payment.amount,
      userId: payment.userId,
      leagueId: payment.leagueId,
      createdAt: payment.createdAt,
      webhookProcessed: payment.webhookProcessed,
    }));
  },
});

// Manual payment reconciliation (admin function)
// INTERNAL ONLY — this can mark any payment "succeeded" and trigger fulfillment
// (credit/league grants). It must never be publicly callable; drive it from an
// admin-only server context.
//
// Note: seats and passes both store `paymentType: "league_creation"` (the
// stored union has no seat literal), so a seat reconciled here is routed by
// the caller-supplied `kind` when given, defaulting to the pass.
export const reconcilePayment = internalMutation({
  args: {
    paymentId: v.id("stripePayments"),
    newStatus: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("cancelled")),
    kind: v.optional(
      v.union(v.literal("league_pass"), v.literal("extra_seat"), v.literal("credit_topup"))
    ),
  },
  handler: async (ctx, args) => {

    const payment = await ctx.db.get(args.paymentId);
    if (!payment) {
      throw new Error("Payment not found");
    }

    await ctx.db.patch(args.paymentId, {
      status: args.newStatus,
      updatedAt: Date.now(),
    });

    // If marking as succeeded, process the payment
    if (args.newStatus === "succeeded" && !payment.webhookProcessed) {
      const kind =
        args.kind ?? (payment.paymentType === "credits_purchase" ? "credit_topup" : "league_pass");
      const seasonYear = (payment.metadata?.seasonYear ?? new Date().getFullYear()).toString();

      if (kind === "league_pass") {
        await ctx.runMutation(internal.payments.processLeaguePayment, {
          paymentId: args.paymentId,
          sessionMetadata: {
            kind: "league_pass",
            paymentType: "league_creation",
            seasonYear,
          },
        });
      } else if (kind === "extra_seat") {
        await ctx.runMutation(internal.payments.processExtraSeatPurchase, {
          paymentId: args.paymentId,
          sessionMetadata: {
            kind: "extra_seat",
            quantity: "1",
            seasonYear,
          },
        });
      } else {
        await ctx.runMutation(internal.payments.processCreditsPurchase, {
          paymentId: args.paymentId,
          sessionMetadata: {
            kind: "credit_topup",
            paymentType: "credits_purchase",
            credits: (payment.metadata?.creditsPurchased ?? CREDITS_PER_TOPUP_UNIT).toString(),
          },
        });
      }

      await ctx.db.patch(args.paymentId, {
        webhookProcessed: true,
        webhookProcessedAt: Date.now(),
        paidAt: Date.now(),
      });
    }

    return { success: true };
  },
});

// Get payment statistics for a league
// INTERNAL ONLY.
export const getLeaguePaymentStats = internalQuery({
  args: {
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    const payments = await ctx.db
      .query("stripePayments")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    const stats = payments.reduce(
      (acc, payment) => {
        acc.totalPayments++;
        acc.totalAmount += payment.amount;

        if (payment.status === "succeeded") {
          acc.successfulPayments++;
          acc.successfulAmount += payment.amount;
        } else if (payment.status === "failed") {
          acc.failedPayments++;
        } else if (payment.status === "pending") {
          acc.pendingPayments++;
        }

        return acc;
      },
      {
        totalPayments: 0,
        totalAmount: 0,
        successfulPayments: 0,
        successfulAmount: 0,
        failedPayments: 0,
        pendingPayments: 0,
      }
    );

    return stats;
  },
});
