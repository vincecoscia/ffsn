import { v } from "convex/values";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

// ===============================
// PUBLIC QUERIES (for frontend)
// ===============================

// Get user's notifications with optional filtering
export const getUserNotifications = query({
  args: {
    leagueId: v.optional(v.id("leagues")),
    type: v.optional(v.union(
      v.literal("comment_request"),
      v.literal("comment_reminder"),
      v.literal("comment_follow_up"),
      v.literal("comment_thank_you"),
      v.literal("article_published"),
      v.literal("article_generated"),
      v.literal("system_announcement"),
      v.literal("league_invitation"),
      v.literal("account_update")
    )),
    isRead: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    let query = ctx.db
      .query("userNotifications")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc");

    const notifications = await query.take(args.limit ?? 50);

    // Filter based on provided criteria
    return notifications.filter(notification => {
      if (args.leagueId && notification.leagueId !== args.leagueId) return false;
      if (args.type && notification.type !== args.type) return false;
      if (args.isRead !== undefined) {
        const isUnread = notification.status === "unread";
        if (args.isRead && isUnread) return false;
        if (!args.isRead && !isUnread) return false;
      }
      return true;
    });
  },
});

// Get unread notification count
export const getUnreadCount = query({
  args: {
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return 0;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      return 0;
    }

    const notifications = await ctx.db
      .query("userNotifications")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "unread"))
      .collect();

    if (args.leagueId) {
      return notifications.filter(n => n.leagueId === args.leagueId).length;
    }

    return notifications.length;
  },
});

// Get notification by ID (for deep linking)
export const getNotificationById = query({
  args: { id: v.id("userNotifications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const notification = await ctx.db.get(args.id);
    
    if (!notification || notification.userId !== user._id) {
      throw new Error("Notification not found or access denied");
    }

    return notification;
  },
});

// ===============================
// PUBLIC MUTATIONS (for frontend)
// ===============================

// Mark notification as read
export const markAsRead = mutation({
  args: { id: v.id("userNotifications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const notification = await ctx.db.get(args.id);
    
    if (!notification || notification.userId !== user._id) {
      throw new Error("Notification not found or access denied");
    }

    await ctx.db.patch(args.id, {
      status: "read",
      readAt: Date.now(),
    });

    return { success: true };
  },
});

// Mark notification as unread
export const markAsUnread = mutation({
  args: { id: v.id("userNotifications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const notification = await ctx.db.get(args.id);
    
    if (!notification || notification.userId !== user._id) {
      throw new Error("Notification not found or access denied");
    }

    await ctx.db.patch(args.id, {
      status: "unread",
      readAt: undefined,
    });

    return { success: true };
  },
});

// Mark all notifications as read
export const markAllAsRead = mutation({
  args: {
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const unreadNotifications = await ctx.db
      .query("userNotifications")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "unread"))
      .collect();

    const filteredNotifications = args.leagueId 
      ? unreadNotifications.filter(n => n.leagueId === args.leagueId)
      : unreadNotifications;

    const now = Date.now();
    for (const notification of filteredNotifications) {
      await ctx.db.patch(notification._id, {
        status: "read",
        readAt: now,
      });
    }

    return { markedCount: filteredNotifications.length };
  },
});

// Delete notification
export const deleteNotification = mutation({
  args: { id: v.id("userNotifications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const notification = await ctx.db.get(args.id);
    
    if (!notification || notification.userId !== user._id) {
      throw new Error("Notification not found or access denied");
    }

    await ctx.db.delete(args.id);
    return { success: true };
  },
});

// ===============================
// INTERNAL FUNCTIONS (for system)
// ===============================

// Create a new notification (internal)
export const createNotification = internalMutation({
  args: {
    userId: v.id("users"),
    leagueId: v.optional(v.id("leagues")),
    type: v.union(
      v.literal("comment_request"),
      v.literal("comment_reminder"),
      v.literal("comment_follow_up"),
      v.literal("comment_thank_you"),
      v.literal("article_published"),
      v.literal("article_generated"),
      v.literal("system_announcement"),
      v.literal("league_invitation"),
      v.literal("account_update")
    ),
    title: v.string(),
    message: v.string(),
    actionUrl: v.optional(v.string()),
    actionText: v.optional(v.string()),
    relatedEntityType: v.optional(v.union(
      v.literal("comment_request"),
      v.literal("scheduled_content"),
      v.literal("ai_content"),
      v.literal("league"),
      v.literal("user")
    )),
    relatedEntityId: v.optional(v.string()),
    priority: v.union(
      v.literal("urgent"),
      v.literal("high"),
      v.literal("medium"),
      v.literal("low")
    ),
    deliveryChannels: v.array(v.union(
      v.literal("in_app"),
      v.literal("email"),
      v.literal("push")
    )),
    scheduledFor: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    
    const notificationId = await ctx.db.insert("userNotifications", {
      userId: args.userId,
      leagueId: args.leagueId,
      type: args.type,
      title: args.title,
      message: args.message,
      actionUrl: args.actionUrl,
      actionText: args.actionText,
      relatedEntityType: args.relatedEntityType,
      relatedEntityId: args.relatedEntityId,
      status: "unread",
      priority: args.priority,
      deliveryChannels: args.deliveryChannels,
      deliveryStatus: {
        inApp: { delivered: false },
      },
      scheduledFor: args.scheduledFor ?? now,
      expiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    return notificationId;
  },
});

// ===============================
// ENHANCED COMMENT NOTIFICATIONS
// ===============================

// Send initial comment request notification
export const sendCommentRequest = internalAction({
  args: {
    userId: v.id("users"),
    commentRequestId: v.id("commentRequests"),
    message: v.string(),
    articleType: v.string(),
    leagueName: v.string(),
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    // Create in-app notification
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_request",
      title: "AI wants your input!",
      message: `${args.message} for ${args.leagueName}`,
      actionUrl: `/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: "Respond Now",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: "high",
      deliveryChannels: ["in_app"],
      expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
    });

    console.log(`Created comment request notification for user ${args.userId}`);
  },
});

// Send follow-up notification for ongoing conversation
export const sendCommentFollowUp = internalAction({
  args: {
    userId: v.id("users"),
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"),
    question: v.string(),
  },
  handler: async (ctx, args) => {
    // Create in-app notification
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_follow_up",
      title: "AI asked a follow-up question",
      message: args.question.length > 100 ? `${args.question.substring(0, 100)}...` : args.question,
      actionUrl: `/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: "Continue Conversation",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: "medium",
      deliveryChannels: ["in_app"],
      expiresAt: Date.now() + (2 * 60 * 60 * 1000), // 2 hours
    });

    console.log(`Created follow-up notification for user ${args.userId}`);
  },
});

// Send expiring soon notification
export const sendExpiringNotification = internalAction({
  args: {
    userId: v.id("users"),
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"),
    minutesRemaining: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_reminder",
      title: "⏰ Comment request expiring soon!",
      message: `Your comment request expires in ${args.minutesRemaining} minutes. Don't miss your chance to be featured!`,
      actionUrl: `/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: "Respond Now",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: "high",
      deliveryChannels: ["in_app"],
      expiresAt: Date.now() + (args.minutesRemaining * 60 * 1000),
    });

    console.log(`Created expiring notification for user ${args.userId}`);
  },
});

// Send completion/thank you notification
export const sendCommentThankYou = internalAction({
  args: {
    userId: v.id("users"),
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"),
    articleTitle: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_thank_you",
      title: "🎉 Thanks for your comments!",
      message: `Your insights will be featured in "${args.articleTitle}". The article will be generated soon!`,
      actionUrl: `/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: "View Request",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: "medium",
      deliveryChannels: ["in_app"],
    });

    console.log(`Created thank you notification for user ${args.userId}`);
  },
});

// ===============================
// UTILITY FUNCTIONS
// ===============================

// Clean up expired notifications (called by cron)
export const cleanupExpiredNotifications = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expiredNotifications = await ctx.db
      .query("userNotifications")
      .withIndex("by_expiration", (q) => q.lte("expiresAt", now))
      .collect();

    let deletedCount = 0;
    for (const notification of expiredNotifications) {
      if (notification.expiresAt && notification.expiresAt <= now) {
        await ctx.db.delete(notification._id);
        deletedCount++;
      }
    }

    console.log(`Cleaned up ${deletedCount} expired notifications`);
    return { deletedCount };
  },
});