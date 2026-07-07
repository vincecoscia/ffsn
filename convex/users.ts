import { mutation, query, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Re-point every record keyed by the auth-subject STRING from an old subject to
// a new one. Used when reconciling a legacy Clerk account to its new Better Auth
// identity so leagues, credits and payments follow the user.
//
// Only tables whose `userId` is a raw string (the auth subject) are re-keyed
// here. Tables that store `userId: v.id("users")` (commentConversations,
// commentResponses, userNotifications, emailLogs, ...) reference the stable
// Convex users._id and need no change. managerActivity also stores a subject but
// has no by_user index; re-key it separately if you rely on it (see MIGRATION.md).
async function rekeyAuthSubject(
  ctx: MutationCtx,
  oldSubject: string,
  newSubject: string
) {
  if (oldSubject === newSubject) return;

  for (const r of await ctx.db.query("leagueMemberships").withIndex("by_user", (q) => q.eq("userId", oldSubject)).collect()) {
    await ctx.db.patch(r._id, { userId: newSubject });
  }
  for (const r of await ctx.db.query("teamClaims").withIndex("by_user", (q) => q.eq("userId", oldSubject)).collect()) {
    await ctx.db.patch(r._id, { userId: newSubject });
  }
  for (const r of await ctx.db.query("stripePayments").withIndex("by_user", (q) => q.eq("userId", oldSubject)).collect()) {
    await ctx.db.patch(r._id, { userId: newSubject });
  }
  for (const r of await ctx.db.query("creditTransactions").withIndex("by_user", (q) => q.eq("userId", oldSubject)).collect()) {
    await ctx.db.patch(r._id, { userId: newSubject });
  }
  for (const r of await ctx.db.query("userCredits").withIndex("by_user", (q) => q.eq("userId", oldSubject)).collect()) {
    await ctx.db.patch(r._id, { userId: newSubject });
  }
}

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
    }

    // No user row is linked to this auth subject yet. Before creating one, check
    // for a legacy account (from the Clerk era) with the same email. Better Auth
    // assigns a brand-new subject id, so a returning user would otherwise be
    // orphaned from all their data. If we find their old row, relink it to the
    // new subject and re-point their subject-keyed records instead of creating a
    // duplicate. This is a no-op on a fresh database with no legacy users.
    const email = args.email || identity.email || undefined;
    if (email) {
      const legacy = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (legacy && legacy.clerkId !== identity.subject) {
        const oldSubject = legacy.clerkId;
        await ctx.db.patch(legacy._id, {
          clerkId: identity.subject,
          lastActiveAt: now,
          ...(args.name && { name: args.name }),
        });
        await rekeyAuthSubject(ctx, oldSubject, identity.subject);
        return legacy._id;
      }
    }

    {
      // Create new user with auth profile data
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
    
    const oldPreferences = user.preferences;
    
    await ctx.db.patch(user._id, {
      preferences: args.preferences,
      lastActiveAt: Date.now(),
    });

    // If email notification preference changed, update SendGrid suppression list
    if (oldPreferences?.emailNotifications !== args.preferences.emailNotifications) {
      try {
        await ctx.scheduler.runAfter(0, internal.emailService.updateEmailPreferences, {
          userId: user._id,
          emailNotifications: args.preferences.emailNotifications,
        });
      } catch (error) {
        console.error("Failed to schedule SendGrid preferences update:", error);
        // Don't throw here - we still want to save the local preference
      }
    }
  },
});

// Get the authenticated user's preferences (for the frontend).
export const getUserPreferences = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    return user;
  },
});

// Update the authenticated user's preferences (for the frontend). Derives the
// target user from the caller's identity — a client-supplied id is never
// trusted (that previously let anyone edit another user's preferences).
export const updateUserPreferences = mutation({
  args: {
    preferences: v.object({
      emailNotifications: v.optional(v.boolean()),
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
    
    const oldPreferences = user.preferences;
    const newPreferences = {
      ...oldPreferences,
      ...args.preferences,
      // Ensure emailNotifications is always a boolean
      emailNotifications: args.preferences.emailNotifications ?? oldPreferences?.emailNotifications ?? true,
    };
    
    await ctx.db.patch(user._id, {
      preferences: newPreferences,
      lastActiveAt: Date.now(),
    });

    // If email notification preference changed, update SendGrid suppression list
    if (args.preferences.emailNotifications !== undefined && 
        oldPreferences?.emailNotifications !== args.preferences.emailNotifications) {
      try {
        await ctx.scheduler.runAfter(0, internal.emailService.updateEmailPreferences, {
          userId: user._id,
          emailNotifications: args.preferences.emailNotifications,
        });
      } catch (error) {
        console.error("Failed to schedule SendGrid preferences update:", error);
        // Don't throw here - we still want to save the local preference
      }
    }
  },
});