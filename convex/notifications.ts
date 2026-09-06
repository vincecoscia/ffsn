import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { leagueCurrentSeason } from "./lib/season";
import {
  contentTypeLabel,
  interviewerDisplay,
  renderArticlePublishedEmail,
  writerDisplay,
} from "../src/lib/email";

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
      v.literal("account_update"),
      v.literal("wire_alert")
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
      v.literal("account_update"),
      v.literal("wire_alert")
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
      v.literal("user"),
      v.literal("wire_post")
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
    // Idempotency for notifications the automation may reach more than once
    // (spec §9.2.10): a finalize that runs twice, a low-credit cancellation
    // that hits the same league in the same week. When set, an existing
    // notification with the same (userId, type, relatedEntityId) and this key
    // is returned instead of a second row being inserted. The key is also
    // stored as `groupKey`, so two different reasons about the same article
    // still both get through.
    dedupeKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    if (args.dedupeKey) {
      const sameKey = await ctx.db
        .query("userNotifications")
        .withIndex("by_user_type", (q) => q.eq("userId", args.userId).eq("type", args.type))
        .filter((q) => q.eq(q.field("groupKey"), args.dedupeKey))
        .take(50);
      // `relatedEntityId` is optional, so it is compared in JS rather than in a
      // filter (an `undefined` operand is not a Convex value).
      const existing = sameKey.find(
        (n) => (n.relatedEntityId ?? null) === (args.relatedEntityId ?? null)
      );
      if (existing) {
        console.log(
          `createNotification: skipping duplicate ${args.type} for user ${args.userId} (dedupeKey ${args.dedupeKey})`
        );
        return existing._id;
      }
    }

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
      groupKey: args.dedupeKey,
      createdAt: now,
      updatedAt: now,
    });

    return notificationId;
  },
});

/* -------------------------------------------------------------------------- *
 * Commissioner notifications for automatic content (spec §9.2.10)
 *
 * `leagueContentPreferences.notifyCommissioner` / `notifyFailures` were dead
 * settings before this: nothing read them. These are the transitions they now
 * drive. Every one of them is deduped, because the generation pipeline retries
 * and the finalize step is idempotent by design.
 * -------------------------------------------------------------------------- */

const COMMISSIONER_NOTICE_KIND = v.union(
  v.literal("ready_for_review"),
  v.literal("generation_failed"),
  v.literal("low_credits")
);

export const notifyCommissionerOfContent = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    kind: COMMISSIONER_NOTICE_KIND,
    contentType: v.string(),
    articleId: v.optional(v.id("aiContent")),
    scheduledContentId: v.optional(v.id("scheduledContent")),
    // Extra sentence for the body (the failure message, the credit shortfall).
    detail: v.optional(v.string()),
    // Defaults to the kind plus the related entity, which is the "once per
    // article" behaviour the spec asks for. Callers that need a coarser window
    // (low credits: once per league per week) pass their own.
    dedupeKey: v.optional(v.string()),
  },
  returns: v.union(v.id("userNotifications"), v.null()),
  handler: async (ctx, args): Promise<Id<"userNotifications"> | null> => {
    const league = await ctx.db.get(args.leagueId);
    if (!league?.commissionerUserId) {
      console.warn(`notifyCommissionerOfContent: league ${args.leagueId} has no commissioner`);
      return null;
    }

    // `leagues.commissionerUserId` is a Clerk id; notifications are keyed by
    // the Convex users row (spec §2).
    const commissioner = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", league.commissionerUserId))
      .unique();
    if (!commissioner) {
      console.warn(
        `notifyCommissionerOfContent: no users row for commissioner ${league.commissionerUserId}`
      );
      return null;
    }

    const label = contentTypeLabel(args.contentType);
    const reviewUrl = `/leagues/${args.leagueId}/ai-generation`;
    const relatedEntityId = args.articleId ?? args.scheduledContentId;

    const copy = {
      ready_for_review: {
        type: "article_generated" as const,
        title: `New ${label} is ready for your review`,
        message:
          args.detail ??
          "It is saved as a draft. Read it over and publish it when you are happy with it.",
        actionText: "Review draft",
        priority: "medium" as const,
      },
      generation_failed: {
        type: "system_announcement" as const,
        title: `We could not write this week's ${label}`,
        message: args.detail ?? "The generation failed after every retry.",
        actionText: "Open the desk",
        priority: "high" as const,
      },
      low_credits: {
        type: "system_announcement" as const,
        title: `Not enough credits for this week's ${label}`,
        message:
          args.detail ??
          "Top up your credits and the next scheduled story will go out as normal.",
        actionText: "Open the desk",
        priority: "high" as const,
      },
    }[args.kind];

    const notificationId: Id<"userNotifications"> = await ctx.runMutation(
      internal.notifications.createNotification,
      {
      userId: commissioner._id,
      leagueId: args.leagueId,
      type: copy.type,
      title: copy.title,
      message: copy.message,
      actionUrl: reviewUrl,
      actionText: copy.actionText,
      relatedEntityType: args.articleId ? ("ai_content" as const) : ("scheduled_content" as const),
      relatedEntityId,
      priority: copy.priority,
      deliveryChannels: ["in_app"],
      dedupeKey: args.dedupeKey ?? `${args.kind}:${relatedEntityId ?? args.leagueId}`,
      }
    );

    return notificationId;
  },
});

// ===============================
// ENHANCED COMMENT NOTIFICATIONS
// ===============================

/**
 * The manager's display name plus the week the request is about. Used to fill the
 * comment-request email template, which previously shipped "User" and no week.
 */
export const getCommentRecipient = internalQuery({
  args: {
    userId: v.id("users"),
    commentRequestId: v.id("commentRequests"),
  },
  returns: v.object({
    userName: v.string(),
    week: v.optional(v.number()),
    leagueId: v.optional(v.id("leagues")),
    contentType: v.optional(v.string()),
    articleGenerationTime: v.optional(v.number()),
    writerPersona: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    const request = await ctx.db.get(args.commentRequestId);
    // First name only: the templates read as a note from the newsroom, not a form letter.
    const fullName = user?.name?.trim();
    return {
      userName: fullName ? fullName.split(/\s+/)[0] : "there",
      week: request?.articleContext.week,
      leagueId: request?.leagueId,
      contentType: request?.contentType,
      articleGenerationTime: request?.articleGenerationTime,
      writerPersona: request?.writerPersona,
    };
  },
});

/**
 * Nudge a manager who has not answered yet (spec §5). Scheduled twice per request by
 * `aiContentWithComments.createCommentRequestsAndWait`: `reminder` at 50% of the
 * window and `final_reminder` 30 minutes before the article generates. Both no-op if
 * the request is no longer open, so a manager who already answered is never pestered.
 */
export const sendCommentReminder = internalAction({
  args: {
    commentRequestId: v.id("commentRequests"),
    type: v.union(v.literal("reminder"), v.literal("final_reminder")),
  },
  returns: v.object({ sent: v.boolean() }),
  handler: async (ctx, args): Promise<{ sent: boolean }> => {
    const request = await ctx.runQuery(internal.notifications.getOpenCommentRequest, {
      commentRequestId: args.commentRequestId,
    });

    // Answered, declined, expired or cancelled: nothing to chase.
    if (!request) return { sent: false };

    const minutesRemaining = Math.max(
      0,
      Math.round((request.articleGenerationTime - Date.now()) / 60000)
    );
    const isFinal = args.type === "final_reminder";
    const weekLabel = request.week ? `the Week ${request.week} ` : "the ";
    const storyLabel = `${weekLabel}${request.contentType.replace(/_/g, " ")}`;

    await ctx.runMutation(internal.notifications.createNotification, {
      userId: request.targetUserId,
      leagueId: request.leagueId,
      type: "comment_reminder",
      title: isFinal
        ? `Last call: ${request.leagueName}`
        : `Still time to comment: ${request.leagueName}`,
      message: isFinal
        ? `We go to print on ${storyLabel} in ${minutesRemaining} minutes and we'd still like your side of it.`
        : `${storyLabel} runs soon. One quick comment and you're in it.`,
      actionUrl: `/leagues/${request.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: isFinal ? "Respond now" : "Add your comment",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: isFinal ? "high" : "medium",
      deliveryChannels: ["in_app", "email"],
      expiresAt: request.articleGenerationTime,
    });

    // The matching email, from the sideline desk (src/lib/email "comment_reminder").
    // emailService.sendCommentRequestEmail checks the manager's email preference and
    // fills in their name and time zone; a failure here must not block the in-app nudge.
    const baseUrl = process.env.SITE_URL || "https://ffsn.ai";
    try {
      await ctx.scheduler.runAfter(0, internal.emailService.sendCommentRequestEmail, {
        userId: request.targetUserId,
        commentRequestId: args.commentRequestId,
        leagueId: request.leagueId,
        templateData: {
          variant: args.type,
          leagueName: request.leagueName,
          contentTypeLabel: contentTypeLabel(request.contentType),
          week: request.week,
          writer: writerDisplay(request.writerPersona),
          interviewer: interviewerDisplay(),
          deadline: request.articleGenerationTime,
          minutesRemaining,
          commentRequestUrl: `${baseUrl}/leagues/${request.leagueId}/comment-requests/${args.commentRequestId}`,
          preferencesUrl: `${baseUrl}/dashboard/settings/notifications`,
          siteUrl: baseUrl,
        },
      });
    } catch (emailError) {
      console.error(`Failed to schedule ${args.type} email for comment request ${args.commentRequestId}:`, emailError);
    }

    await ctx.runMutation(internal.commentRequests.updateRequestStatus, {
      commentRequestId: args.commentRequestId,
      notificationSent: {
        type: args.type,
        sentAt: Date.now(),
        method: "app_notification",
        delivered: true,
      },
    });

    console.log(`Sent ${args.type} for comment request ${args.commentRequestId}`);
    return { sent: true };
  },
});

/** The request plus its league name, but only while it is still open for comment. */
export const getOpenCommentRequest = internalQuery({
  args: { commentRequestId: v.id("commentRequests") },
  returns: v.union(
    v.null(),
    v.object({
      targetUserId: v.id("users"),
      leagueId: v.id("leagues"),
      leagueName: v.string(),
      contentType: v.string(),
      week: v.optional(v.number()),
      articleGenerationTime: v.number(),
      writerPersona: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return null;
    if (request.status !== "pending" && request.status !== "active") return null;

    // A request with a response already recorded is answered, whatever its status says.
    const response = await ctx.db
      .query("commentResponses")
      .withIndex("by_comment_request", q => q.eq("commentRequestId", args.commentRequestId))
      .first();
    if (response) return null;

    const league = await ctx.db.get(request.leagueId);
    return {
      targetUserId: request.targetUserId,
      leagueId: request.leagueId,
      leagueName: league?.name ?? "your league",
      contentType: request.contentType,
      week: request.articleContext.week,
      articleGenerationTime: request.articleGenerationTime,
      writerPersona: request.writerPersona,
    };
  },
});

// Send initial comment request notification
export const sendCommentRequest = internalAction({
  args: {
    userId: v.id("users"),
    commentRequestId: v.id("commentRequests"),
    message: v.string(),
    articleType: v.string(),
    leagueName: v.string(),
    leagueId: v.id("leagues"),
    writerPersona: v.optional(v.string()),
    week: v.optional(v.number()),
    deadline: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const title = `${contentTypeLabel(args.articleType)} for ${args.leagueName}`;

    // Create in-app notification
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_request",
      title,
      message: args.message,
      actionUrl: `/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: "Join Conversation",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: "medium",
      deliveryChannels: ["in_app", "email"],
      expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
    });

    // Send email notification - recipientName and timeZone are filled in by
    // emailService.sendCommentRequestEmail from the user record itself.
    const baseUrl = process.env.SITE_URL || "https://ffsn.ai";
    const commentRequestUrl = `${baseUrl}/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`;

    try {
      await ctx.scheduler.runAfter(0, internal.emailService.sendCommentRequestEmail, {
        userId: args.userId,
        commentRequestId: args.commentRequestId,
        leagueId: args.leagueId,
        templateData: {
          variant: "request",
          leagueName: args.leagueName,
          contentTypeLabel: contentTypeLabel(args.articleType),
          week: args.week,
          question: args.message,
          writer: writerDisplay(args.writerPersona),
          interviewer: interviewerDisplay(),
          deadline: args.deadline,
          commentRequestUrl,
          preferencesUrl: `${baseUrl}/dashboard/settings/notifications`,
          siteUrl: baseUrl,
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

/**
 * Reminder notification + email for a comment request closing soon. Nothing
 * schedules this today - the spec's W1-C reminder workstream will call it at
 * 50% of the window (variant "reminder") and again shortly before the
 * article generates (variant "final_reminder" via `final: true`).
 */
export const sendExpiringNotification = internalAction({
  args: {
    userId: v.id("users"),
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"),
    minutesRemaining: v.number(),
    leagueName: v.string(),
    writerPersona: v.optional(v.string()),
    week: v.optional(v.number()),
    deadline: v.optional(v.number()),
    question: v.optional(v.string()),
    final: v.optional(v.boolean()),
    articleType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const label = args.articleType ? contentTypeLabel(args.articleType) : "story";

    await ctx.runMutation(internal.notifications.createNotification, {
      userId: args.userId,
      leagueId: args.leagueId,
      type: "comment_reminder",
      title: `Reminder: ${label} for ${args.leagueName}`,
      message: `The window for comment closes in ${args.minutesRemaining} minutes`,
      actionUrl: `/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`,
      actionText: "Respond Now",
      relatedEntityType: "comment_request",
      relatedEntityId: args.commentRequestId,
      priority: "high",
      deliveryChannels: ["in_app", "email"],
      expiresAt: Date.now() + (args.minutesRemaining * 60 * 1000),
    });

    const baseUrl = process.env.SITE_URL || "https://ffsn.ai";
    const commentRequestUrl = `${baseUrl}/leagues/${args.leagueId}/comment-requests/${args.commentRequestId}`;

    try {
      await ctx.scheduler.runAfter(0, internal.emailService.sendCommentRequestEmail, {
        userId: args.userId,
        commentRequestId: args.commentRequestId,
        leagueId: args.leagueId,
        templateData: {
          variant: args.final ? "final_reminder" : "reminder",
          leagueName: args.leagueName,
          contentTypeLabel: label,
          week: args.week,
          question: args.question,
          writer: writerDisplay(args.writerPersona),
          interviewer: interviewerDisplay(),
          deadline: args.deadline,
          minutesRemaining: args.minutesRemaining,
          commentRequestUrl,
          preferencesUrl: `${baseUrl}/dashboard/settings/notifications`,
          siteUrl: baseUrl,
        },
      });
      console.log(`Scheduled expiring-reminder email for comment request to user ${args.userId}`);
    } catch (emailError) {
      console.error(`Failed to schedule expiring-reminder email to user ${args.userId}:`, emailError);
      // Don't fail the entire operation if email fails
    }

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

    const league = await ctx.db.get(article.leagueId);
    const summary = deriveArticleSummary(article);
    const actionUrl = `/articles/${args.articleId}`;
    const now = Date.now();

    // `quote.teamId` may arrive as a Convex team id or as a FACTS id ("T" + externalId)
    // - the same ambiguity resolved in relationships.recordArticleMentions - so resolve
    // every quoted team to a Convex id up front, once, rather than per member below.
    const seasonId = leagueCurrentSeason(league);
    const quotedTeamIds = new Set<Id<"teams">>();
    for (const quote of article.quotes ?? []) {
      let teamId = ctx.db.normalizeId("teams", quote.teamId);
      if (!teamId) {
        const externalId = quote.teamId.startsWith("T") ? quote.teamId.slice(1) : quote.teamId;
        const team = await ctx.db
          .query("teams")
          .withIndex("by_external", (q) =>
            q.eq("leagueId", article.leagueId).eq("externalId", externalId).eq("seasonId", seasonId)
          )
          .first();
        teamId = team?._id ?? null;
      }
      if (teamId) quotedTeamIds.add(teamId);
    }

    const memberships = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league", (q) => q.eq("leagueId", article.leagueId))
      .collect();

    let notifiedCount = 0;
    let skippedCount = 0;
    const emailRecipients: Array<{ email: string; recipientName?: string; quoted?: boolean }> = [];

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
        let quoted: boolean | undefined;
        if (quotedTeamIds.size > 0) {
          // Same pattern as aiContentWithComments.getUserTeam: resolve the member's
          // active team claim for this league via their Clerk id.
          const claim = await ctx.db
            .query("teamClaims")
            .withIndex("by_user", (q) => q.eq("userId", user.clerkId))
            .filter((q) => q.eq(q.field("leagueId"), article.leagueId))
            .filter((q) => q.eq(q.field("status"), "active"))
            .first();
          if (claim) quoted = quotedTeamIds.has(claim.teamId);
        }
        emailRecipients.push({ email: user.email, recipientName: user.name, quoted });
      }
    }

    if (emailRecipients.length > 0) {
      await ctx.scheduler.runAfter(0, internal.notifications.sendArticlePublishedEmails, {
        title: article.title,
        summary,
        actionUrl,
        leagueName: league?.name ?? "your league",
        contentTypeLabel: contentTypeLabel(article.type),
        week: article.metadata.week,
        writerPersona: article.persona,
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
// emailService.sendPlainEmail), rendered from src/lib/email's Broadcast
// template. Kept as one action per publish event so we log one line per
// batch instead of one per member.
export const sendArticlePublishedEmails = internalAction({
  args: {
    title: v.string(),
    summary: v.string(),
    actionUrl: v.string(),
    leagueName: v.string(),
    contentTypeLabel: v.string(),
    week: v.optional(v.number()),
    writerPersona: v.string(),
    recipients: v.array(v.object({
      email: v.string(),
      recipientName: v.optional(v.string()),
      quoted: v.optional(v.boolean()),
    })),
  },
  handler: async (ctx, args) => {
    const baseUrl = process.env.SITE_URL || "https://ffsn.ai";
    const fullUrl = `${baseUrl}${args.actionUrl}`;
    const writer = writerDisplay(args.writerPersona);
    const preferencesUrl = `${baseUrl}/dashboard/settings/notifications`;

    let sent = 0;
    let failed = 0;
    for (const recipient of args.recipients) {
      try {
        const rendered = renderArticlePublishedEmail({
          title: args.title,
          summary: args.summary,
          articleUrl: fullUrl,
          leagueName: args.leagueName,
          contentTypeLabel: args.contentTypeLabel,
          week: args.week,
          writer,
          recipientName: recipient.recipientName,
          quoted: recipient.quoted,
          preferencesUrl,
          siteUrl: baseUrl,
        });

        const result = await ctx.runAction(internal.emailService.sendPlainEmail, {
          to: recipient.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          fromName: rendered.fromName,
          relatedEntityType: "article_published",
        });
        if (result.success) {
          sent++;
        } else {
          failed++;
        }
      } catch (error) {
        failed++;
        console.error(`sendArticlePublishedEmails: failed to send to ${recipient.email}`, error);
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