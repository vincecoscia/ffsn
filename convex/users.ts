import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.log("getCurrentUser: No identity found");
      return null;
    }
    
    console.log("getCurrentUser: Identity found", { subject: identity.subject });
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    if (!user) {
      console.log("getCurrentUser: No user found for clerkId", identity.subject);
    } else {
      console.log("getCurrentUser: User found", { userId: user._id, clerkId: user.clerkId });
    }
    
    return user;
  },
});

export const createOrUpdateUser = mutation({
  args: {
    hasCompletedOnboarding: v.optional(v.boolean()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Must be authenticated");
    
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    const now = Date.now();
    
    if (existingUser) {
      // Update existing user
      await ctx.db.patch(existingUser._id, {
        hasCompletedOnboarding: args.hasCompletedOnboarding ?? existingUser.hasCompletedOnboarding,
        lastActiveAt: now,
        // Update email/name if provided
        ...(args.email && { email: args.email }),
        ...(args.name && { name: args.name }),
      });
      return existingUser._id;
    } else {
      // Create new user with Clerk profile data
      const userId = await ctx.db.insert("users", {
        clerkId: identity.subject,
        email: args.email || identity.email || undefined,
        name: args.name || identity.name || undefined,
        hasCompletedOnboarding: args.hasCompletedOnboarding ?? false,
        preferences: {
          emailNotifications: true,
          favoriteTeam: undefined,
          timezone: undefined,
        },
        createdAt: now,
        lastActiveAt: now,
      });
      return userId;
    }
  },
});

export const completeOnboarding = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Must be authenticated");
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    if (!user) {
      // Create user if doesn't exist (fallback case)
      await ctx.db.insert("users", {
        clerkId: identity.subject,
        email: identity.email || undefined,
        name: identity.name || undefined,
        hasCompletedOnboarding: true,
        preferences: {
          emailNotifications: true,
          favoriteTeam: undefined,
          timezone: undefined,
        },
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    } else {
      // Update existing user
      await ctx.db.patch(user._id, {
        hasCompletedOnboarding: true,
        lastActiveAt: Date.now(),
      });
    }
  },
});

export const updatePreferences = mutation({
  args: {
    preferences: v.object({
      emailNotifications: v.boolean(),
      favoriteTeam: v.optional(v.string()),
      timezone: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Must be authenticated");
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();
    
    if (!user) throw new Error("User not found");
    
    await ctx.db.patch(user._id, {
      preferences: args.preferences,
      lastActiveAt: Date.now(),
    });
  },
});