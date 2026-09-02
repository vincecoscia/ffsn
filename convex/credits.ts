import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireIdentity } from "./lib/auth";

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

    // Create transaction record
    const transactionId = await ctx.db.insert("creditTransactions", {
      userId: args.userId,
      leagueId: args.leagueId,
      type: args.type,
      amount: args.amount,
      description: args.description,
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

// Internal function to deduct credits (for system-generated content)
export const deductCreditsInternal = internalMutation({
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

    console.log(`Deducted ${args.amount} credits from user ${args.userId} (system). New balance: ${newBalance}`);

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
    // Check if user already received join credits for this league
    const existingCredit = await ctx.db
      .query("creditTransactions")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .filter((q) => q.eq(q.field("type"), "earned"))
      .filter((q) => q.eq(q.field("description"), "League join bonus - 100 credits"))
      .first();

    if (existingCredit) {
      console.log(`User ${args.userId} already received join credits for league ${args.leagueId}`);
      return { alreadyGranted: true };
    }

    // Grant 100 credits for joining
    const result = await ctx.runMutation(internal.credits.grantCredits, {
      userId: args.userId,
      amount: 100,
      type: "earned",
      description: "League join bonus - 100 credits",
      leagueId: args.leagueId,
    });

    return {
      alreadyGranted: false,
      newBalance: result.newBalance,
      creditsGranted: 100,
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