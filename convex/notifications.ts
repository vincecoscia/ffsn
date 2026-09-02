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

    const query = ctx.db
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
    // Generate contextual title based on article type
    const getNotificationTitle = (articleType: string, leagueName: string) => {
      const articleTypeMap: Record<string, string> = {
        'weekly_recap': `Weekly recap for the ${leagueName}`,
        'trade_analysis': `Trade analysis for the ${leagueName}`,
        'waiver_wire_report': `Waiver wire insights for the ${leagueName}`,
        'power_rankings': `Power rankings for the ${leagueName}`,
        'draft_rankings': `Draft recap for the ${leagueName}`,
        'matchup_preview': `Matchup preview for the ${leagueName}`,
      };
      
      return articleTypeMap[articleType] || `Article feedback for the ${leagueName}`;
    };

    // Create in-app notification
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_request",
      title: getNotificationTitle(args.articleType, args.leagueName),
      message: args.message,
      actionUrl: `/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: "Join Conversation",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: "medium",
      deliveryChannels: ["in_app", "email"],
      expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
    });

    // Send email notification
    const baseUrl = process.env.SITE_URL || "https://ffsn.ai";
    const commentRequestUrl = `${baseUrl}/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`;
    const unsubscribeUrl = `${baseUrl}/dashboard/settings/notifications`;

    try {
      await ctx.scheduler.runAfter(0, internal.emailService.sendCommentRequestEmail, {
        userId: args.userId,
        commentRequestId: args.commentRequestId,
        leagueId: args.leagueId,
        templateData: {
          userName: "User", // We'll get this from the user record in the email service
          leagueName: args.leagueName,
          articleType: getNotificationTitle(args.articleType, args.leagueName),
          week: undefined, // TODO: Extract from context if needed
          commentRequestUrl,
          unsubscribeUrl,
        },
      });
      console.log(`Scheduled email notification for comment request to user ${args.userId}`);
    } catch (emailError) {
      console.error(`Failed to schedule email notification to user ${args.userId}:`, emailError);
      // Don't fail the entire operation if email fails
    }

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
    leagueName: v.string(),
  },
  handler: async (ctx, args) => {
    // Create in-app notification
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_follow_up",
      title: `Follow-up question for ${args.leagueName}`,
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
    leagueName: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_reminder",
      title: `Reminder: ${args.leagueName} article feedback`,
      message: `Response window closes in ${args.minutesRemaining} minutes`,
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
    leagueName: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_thank_you",
      title: `Thanks for your input on ${args.leagueName}`,
      message: `Your insights will be featured in the upcoming article`,
      actionUrl: `/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: "View Request",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: "low",
      deliveryChannels: ["in_app"],
    });

    console.log(`Created thank you notification for user ${args.userId}`);
  },
});

// ===============================
// ARTICLE PUBLISHED NOTIFICATIONS
// ===============================

// Derive a short body for the article_published notification/email. aiContent
// has no persisted summary column (see the comment on aiContent.editArticle
// for why), so this prefers a commissioner-edited summary stashed in
// tempGenerationData.summary and otherwise falls back to a plain-text
// excerpt of the article content.
function deriveArticleSummary(article: { content: string; summary?: string }): string {
  if (article.summary && article.summary.trim().length > 0) {
    return article.summary.trim();
  }

  const plain = article.content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > 200 ? `${plain.slice(0, 200).trim()}…` : plain;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Notify every member of an article's league that it was published. Called
// (scheduled via ctx.scheduler.runAfter) from both places an article can be
// published: the commissioner-gated aiContent.updateContentStatus mutation
// and the auto-publish branch inside aiContent.generateContentAction - both
// funnel through aiContent's shared updateContentStatusHandler, which is
// what actually schedules this. Internal only: this is a system side-effect
// of publishing, not something a client should be able to trigger directly.
export const notifyArticlePublished = internalMutation({
  args: { articleId: v.id("aiContent") },
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) {
      console.warn(`notifyArticlePublished: article ${args.articleId} not found`);
      return;
    }

    const summary = deriveArticleSummary(article);
    const actionUrl = `/articles/${args.articleId}`;
    const now = Date.now();

    const memberships = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league", (q) => q.eq("leagueId", article.leagueId))
      .collect();

    let notifiedCount = 0;
    let skippedCount = 0;
    const emailRecipients: string[] = [];

    for (const membership of memberships) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", membership.userId))
        .unique();
      if (!user) continue;

      // Idempotent: skip members who already have an article_published
      // notification for this article (e.g. publish gets triggered twice).
      const existing = await ctx.db
        .query("userNotifications")
        .withIndex("by_user_type", (q) => q.eq("userId", user._id).eq("type", "article_published"))
        .filter((q) => q.eq(q.field("relatedEntityId"), args.articleId))
        .first();

      if (existing) {
        skippedCount++;
        continue;
      }

      await ctx.db.insert("userNotifications", {
        userId: user._id,
        leagueId: article.leagueId,
        type: "article_published",
        title: article.title,
        message: summary,
        actionUrl,
        actionText: "Read Article",
        relatedEntityType: "ai_content",
        relatedEntityId: args.articleId,
        status: "unread",
        priority: "medium",
        deliveryChannels: ["in_app", "email"],
        deliveryStatus: { inApp: { delivered: false } },
        scheduledFor: now,
        createdAt: now,
        updatedAt: now,
      });
      notifiedCount++;

      if (user.preferences?.emailNotifications && user.email) {
        emailRecipients.push(user.email);
      }
    }

    if (emailRecipients.length > 0) {
      await ctx.scheduler.runAfter(0, internal.notifications.sendArticlePublishedEmails, {
        title: article.title,
        summary,
        actionUrl,
        recipients: emailRecipients,
      });
    }

    console.log(
      `notifyArticlePublished: article ${args.articleId} - ${notifiedCount} notified, ${skippedCount} already notified, ${emailRecipients.length} emails queued (of ${memberships.length} league members)`
    );
  },
});

// Sends the "article published" email to a batch of recipients via the
// plain-text send path (no SendGrid dynamic template - see
// emailService.sendPlainEmail). Kept as one action per publish event so we
// log one line per batch instead of one per member.
export const sendArticlePublishedEmails = internalAction({
  args: {
    title: v.string(),
    summary: v.string(),
    actionUrl: v.string(),
    recipients: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const baseUrl = process.env.SITE_URL || "https://ffsn.ai";
    const fullUrl = `${baseUrl}${args.actionUrl}`;
    const subject = `New on FFSN: ${args.title}`;
    const text = `${args.title}\n\n${args.summary}\n\nRead it here: ${fullUrl}`;
    const html = `<p><strong>${escapeHtml(args.title)}</strong></p><p>${escapeHtml(args.summary)}</p><p><a href="${escapeHtml(fullUrl)}">Read the full article</a></p>`;

    let sent = 0;
    let failed = 0;
    for (const to of args.recipients) {
      try {
        const result = await ctx.runAction(internal.emailService.sendPlainEmail, {
          to,
          subject,
          text,
          html,
          relatedEntityType: "article_published",
        });
        if (result.success) {
          sent++;
        } else {
          failed++;
        }
      } catch (error) {
        failed++;
        console.error(`sendArticlePublishedEmails: failed to send to ${to}`, error);
      }
    }

    console.log(
      `sendArticlePublishedEmails: sent ${sent}/${args.recipients.length} article-published emails (${failed} failed)`
    );
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