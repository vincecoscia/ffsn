import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";

// Process league creation payment - grant commissioner credits and create league
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
    const seasonYear = parseInt(args.sessionMetadata.seasonYear || "2025");
    const now = Date.now();

    // Grant 1000 credits to the commissioner
    await ctx.runMutation(internal.credits.grantCredits, {
      userId,
      amount: 1000,
      type: "earned",
      description: `League creation bonus - 1000 credits`,
      relatedPaymentId: args.paymentId,
    });

    // Create league payment record
    const leagueId = payment.leagueId;
    if (leagueId) {
      await ctx.db.insert("leaguePayments", {
        leagueId,
        stripePaymentId: args.paymentId,
        seasonYear,
        amount: payment.amount,
        currency: payment.currency,
        status: "completed",
        paidByUserId: userId,
        paidAt: now,
        createdAt: now,
      });

      // Update league subscription status and tier
      const league = await ctx.db.get(leagueId);
      if (league) {
        await ctx.db.patch(leagueId, {
          subscription: {
            ...league.subscription,
            paymentStatus: "completed",
            paidAt: now,
            status: "paid",
            tier: "season_pass",
          },
        });
      }
    }

    // Auto-generate season_welcome content for the new league
    try {
      // Check if season_welcome content already exists for this league/season
      const existingCheck = await ctx.runQuery(internal.contentScheduling.checkExistingContent, {
        leagueId: leagueId!,
        contentType: "season_welcome",
        seasonId: seasonYear,
      });

      if (!existingCheck.hasExistingContent && !existingCheck.hasScheduledContent) {
        // Check if user has sufficient credits
        const userCredits = await ctx.runQuery(internal.credits.checkSufficientCredits, {
          userId,
          requiredAmount: 5, // season_welcome typically costs 5 credits
        });

        if (userCredits.hasSufficientCredits) {
          console.log(`Auto-generating season_welcome content for league ${leagueId}`);
          
          // Create the article first
          const articleId = await ctx.runMutation(internal.aiContent.createScheduledArticle, {
            leagueId: leagueId!,
            type: "season_welcome",
            persona: "analyst", // Default persona
            userId: userId,
          });

          // Schedule immediate generation of season_welcome
          await ctx.scheduler.runAfter(5000, internal.aiContent.generateContentAction, {
            articleId,
            leagueId: leagueId!,
            contentType: "season_welcome",
            persona: "analyst",
            userId: userId,
            seasonId: seasonYear,
          });

          console.log(`Season welcome content generation scheduled for league ${leagueId}`);
        } else {
          console.log(`User ${userId} has insufficient credits for auto season_welcome generation. Required: 5, Available: ${userCredits.currentBalance}`);
        }
      } else {
        console.log(`Season welcome content already exists or is scheduled for league ${leagueId}`);
      }
    } catch (error) {
      console.error("Error auto-generating season welcome content:", error);
      // Don't fail the entire payment process if content generation fails
    }

    console.log(`League payment processed: $${payment.amount / 100} for user ${userId}`);
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
            paymentType: "league_creation",
            seasonYear: new Date().getFullYear().toString(),
          },
        });
      }

      console.log(`Linked payment ${payment._id} to league ${args.leagueId}`);
    }
  },
});

// Process credits purchase - add credits to user balance
export const processCreditsPurchase = internalMutation({
  args: {
    paymentId: v.id("stripePayments"),
    sessionMetadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db.get(args.paymentId);
    if (!payment || !payment.metadata?.creditsPurchased) {
      throw new Error("Invalid payment record for credits purchase");
    }

    const userId = payment.userId;
    const creditsPurchased = payment.metadata.creditsPurchased;

    // Grant purchased credits
    await ctx.runMutation(internal.credits.grantCredits, {
      userId,
      amount: creditsPurchased,
      type: "purchased",
      description: `Purchased ${creditsPurchased} credits for $${payment.amount / 100}`,
      relatedPaymentId: args.paymentId,
      leagueId: payment.leagueId,
    });

    console.log(`Credits purchase processed: ${creditsPurchased} credits for user ${userId}`);
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
export const reconcilePayment = internalMutation({
  args: {
    paymentId: v.id("stripePayments"),
    newStatus: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("cancelled")),
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
      if (payment.paymentType === "league_creation") {
        await ctx.runMutation(internal.payments.processLeaguePayment, {
          paymentId: args.paymentId,
          sessionMetadata: {
            paymentType: "league_creation",
            seasonYear: payment.metadata?.seasonYear?.toString() || "2025",
          },
        });
      } else if (payment.paymentType === "credits_purchase") {
        await ctx.runMutation(internal.payments.processCreditsPurchase, {
          paymentId: args.paymentId,
          sessionMetadata: {
            paymentType: "credits_purchase",
            creditsPurchased: payment.metadata?.creditsPurchased?.toString() || "0",
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