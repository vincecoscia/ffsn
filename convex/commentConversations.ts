import { v } from "convex/values";
import { mutation, query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { ConversationContext } from "../src/lib/ai/conversation-service";
import { Id } from "./_generated/dataModel";
import { getLeagueMembership, requireIdentity } from "./lib/auth";
import { looksLikeDecline } from "./lib/declineDetection";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  quoteReviewActionValidator,
  quoteReviewEntryValidator,
  writerSentimentValidator,
} from "./validators";
import { DELTAS } from "./relationships";

/* -------------------------------------------------------------------------- */
/* Quote integrity (spec §5)                                                   */
/* -------------------------------------------------------------------------- */

/** Curly quotes and dashes folded so a re-typed span still matches the raw text. */
function foldPunctuation(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, "-");
}

function normalizeForMatch(text: string): string {
  return foldPunctuation(text).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Keep only the segments that are genuinely contained in `raw` after
 * case-insensitive, whitespace-normalized comparison. Anything the model
 * rephrased, merged, or invented is dropped rather than stored as a quote.
 *
 * This is deliberately duplicated from `conversation-service.ts`: that module is a
 * Node-runtime file (it loads the Anthropic SDK), so Convex isolate code may only
 * import types from it.
 */
export function keepVerbatimSegments(raw: string, segments: string[]): string[] {
  const haystack = normalizeForMatch(raw);
  const kept: string[] = [];
  for (const segment of segments ?? []) {
    const trimmed = foldPunctuation(segment).replace(/\s+/g, " ").trim();
    if (trimmed.length === 0) continue;
    if (!haystack.includes(trimmed.toLowerCase())) continue;
    if (!kept.includes(trimmed)) kept.push(trimmed);
  }
  return kept;
}

/**
 * Every comment request for the signed-in manager, open or closed, newest first.
 *
 * This replaces the old `getActiveRequests`, which filtered to `status === "active"` and
 * so made answered and expired requests vanish from the list the moment they mattered
 * most (spec §5). This is the query the requests list renders from; the target user is
 * still derived from the caller's identity, never from an argument.
 */
export const getMyRequests = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) return [];

    const requests = await ctx.db
      .query("commentRequests")
      .withIndex("by_user", (q) => q.eq("targetUserId", user._id))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 25, 1), 100));

    return await Promise.all(
      requests
        .filter((request) => request.status !== "cancelled")
        .map(async (request) => {
          const scheduledContent = request.scheduledContentId
            ? await ctx.db.get(request.scheduledContentId)
            : null;
          const league = await ctx.db.get(request.leagueId);

          const messages = await ctx.db
            .query("commentConversations")
            .withIndex("by_comment_request_order", (q) =>
              q.eq("commentRequestId", request._id)
            )
            .collect();

          return {
            ...request,
            leagueName: league?.name || "Unknown League",
            articleType: scheduledContent?.contentType || request.contentType,
            messageCount: messages.length,
            lastMessage: messages[messages.length - 1],
          };
        })
    );
  },
});

/* -------------------------------------------------------------------------- */
/* Quote approval (spec §8.1)                                                  */
/* -------------------------------------------------------------------------- */

type QuoteReviewEntry = {
  original: string;
  text: string;
  status: "pending" | "approved" | "edited" | "withdrawn";
};

/** The response row for a request, or null. One row per request by construction. */
async function responseForRequest(
  ctx: QueryCtx | MutationCtx,
  commentRequestId: Id<"commentRequests">
): Promise<Doc<"commentResponses"> | null> {
  return await ctx.db
    .query("commentResponses")
    .withIndex("by_comment_request", q =>
      q.eq("commentRequestId", commentRequestId)
    )
    .first();
}

/** The signed-in caller's `users` row, resolved through `by_clerk_id`. */
async function callerUser(
  ctx: QueryCtx | MutationCtx,
  clerkId: string
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", q => q.eq("clerkId", clerkId))
    .unique();
}

/**
 * "We go to print at ..." in the manager's own timezone when we have one.
 * Convex's isolate ships Intl; a bad tz string still must not cost us the message.
 */
function formatDeadline(deadline: number, timeZone?: string): string {
  const tz = timeZone || "America/New_York";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(deadline));
  } catch {
    return new Date(deadline).toUTCString();
  }
}

/**
 * Post Sam's one quote-approval message, once, when there is something to approve.
 *
 * Called at the moment the response row lands (`createCommentResponse`) and again
 * from the closing message when a row already exists, so the manager sees it right
 * after the close and never twice.
 */
async function postQuoteApproval(
  ctx: MutationCtx,
  commentRequestId: Id<"commentRequests">
): Promise<Id<"commentConversations"> | null> {
  const request = await ctx.db.get(commentRequestId);
  if (!request) return null;

  const response = await responseForRequest(ctx, commentRequestId);
  const pending = (response?.quoteReview ?? []).filter(q => q.status === "pending");
  if (pending.length === 0) return null;

  const messages = await ctx.db
    .query("commentConversations")
    .withIndex("by_comment_request", q => q.eq("commentRequestId", commentRequestId))
    .collect();
  if (messages.some(m => m.messageType === "quote_approval")) return null;

  const user = await ctx.db.get(request.targetUserId);
  const deadline = formatDeadline(
    request.articleGenerationTime,
    user?.preferences?.timezone
  );

  return await ctx.db.insert("commentConversations", {
    commentRequestId,
    leagueId: request.leagueId,
    userId: request.targetUserId,
    messageType: "quote_approval",
    content: `Here's what we'll quote you saying. Tighten it if you want. We go to print at ${deadline}.`,
    messageOrder: messages.length,
    isRead: false,
    aiMetadata: { intent: "quote_approval" },
    createdAt: Date.now(),
    threadDepth: 0,
  });
}

// Get conversation messages for a comment request. Readable by the
// request's target user or a commissioner of its league.
export const getConversation = query({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return [];

    const identity = await ctx.auth.getUserIdentity();
    let isTargetUser = false;
    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .unique();
      isTargetUser = !!user && user._id === request.targetUserId;
    }

    if (!isTargetUser) {
      const membership = await getLeagueMembership(ctx, request.leagueId);
      if (!membership || membership.membership.role !== "commissioner") {
        return [];
      }
    }

    const messages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request_order", q =>
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    return messages;
  },
});

// Send user response to a comment request
export const sendUserResponse = mutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    // Get the comment request
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) throw new Error("Comment request not found");
    
    // Verify user owns this request
    const userId = await ctx.auth.getUserIdentity().then(identity => 
      identity ? ctx.db
        .query("users")
        .withIndex("by_clerk_id", q => q.eq("clerkId", identity.subject))
        .unique()
        .then(user => user?._id)
      : null
    );
    
    if (!userId || userId !== request.targetUserId) {
      throw new Error("Unauthorized");
    }

    // Get message count to determine order
    const existingMessages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q => 
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    // Create user message
    const messageId = await ctx.db.insert("commentConversations", {
      commentRequestId: args.commentRequestId,
      leagueId: request.leagueId,
      userId: request.targetUserId,
      messageType: "user_response",
      content: args.content,
      messageOrder: existingMessages.length,
      isRead: true,
      createdAt: Date.now(),
      threadDepth: 0,
    });

    // Update request state
    await ctx.db.patch(request._id, {
      conversationState: "gathering_details",
      autoEndCriteria: {
        ...request.autoEndCriteria,
        currentMessageCount: request.autoEndCriteria.currentMessageCount + 1,
        lastActivityTime: Date.now(),
      },
      updatedAt: Date.now(),
    });

    // Mark any related unread notifications as read now that the user has responded
    try {
      const unreadNotifications = await ctx.db
        .query("userNotifications")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "unread"))
        .collect();

      const relatedNotifications = unreadNotifications.filter((n) =>
        n.relatedEntityType === "comment_request" && n.relatedEntityId === `${args.commentRequestId}`
      );

      const now = Date.now();
      for (const notification of relatedNotifications) {
        await ctx.db.patch(notification._id, {
          status: "read",
          readAt: now,
        });
      }
    } catch (err) {
      console.error("Failed to auto-mark comment request notifications as read:", err);
      // Non-fatal: continue
    }

    // Schedule AI response analysis and potential follow-up
    await ctx.scheduler.runAfter(100, internal.commentConversations.processUserResponse, {
      commentRequestId: args.commentRequestId,
      userMessageId: messageId,
    });

    return messageId;
  },
});

// Internal action to process user response and generate AI follow-up
export const processUserResponse = internalAction({
  args: {
    commentRequestId: v.id("commentRequests"),
    userMessageId: v.id("commentConversations"),
  },
  handler: async (ctx, args) => {
    console.log("Processing user response for comment request:", args.commentRequestId);

    // Get all necessary data
    const request = await ctx.runQuery(internal.commentConversations.getRequestWithContext, {
      commentRequestId: args.commentRequestId,
    });

    if (!request) {
      console.error("Comment request not found");
      return;
    }

    const userMessage = await ctx.runQuery(internal.commentConversations.getMessage, {
      messageId: args.userMessageId,
    });

    if (!userMessage) {
      console.error("User message not found");
      return;
    }

    try {
      // Get Claude API key
      // Build ConversationContext using the same context builder used for initial requests
      const conversationContext = await ctx.runQuery(internal.commentRequests.buildConversationContext, {
        commentRequestId: args.commentRequestId,
      });
      if (!conversationContext) {
        throw new Error("Failed to build conversation context");
      }

      // Analyze the user response
      const analysis = await ctx.runAction(internal.aiNode.analyzeUserResponse, {
        userResponse: userMessage.content,
        context: conversationContext,
      });

      console.log("User response analysis:", analysis);

      // Store the analysis, including the verbatim spans the quote ledger is built from.
      await ctx.runMutation(internal.commentConversations.updateMessageAnalysis, {
        messageId: args.userMessageId,
        analysis: {
          sentiment: analysis.sentiment,
          completeness: analysis.completeness,
          relevantTopics: analysis.relevantTopics,
          needsFollowUp: analysis.needsFollowUp,
          suggestedFollowUps: analysis.suggestedFollowUps,
          quotableSegments: analysis.quotableSegments,
          writerSentiment: analysis.writerSentiment,
        },
      });

      // A manager jabbing or praising a writer during the interview moves the
      // relationship meter (spec §6.2). Neutral mentions are not events.
      for (const entry of analysis.writerSentiment ?? []) {
        if (entry.sentiment === "neutral") continue;
        const isJab = entry.sentiment === "hostile" || entry.sentiment === "dismissive";
        const delta = isJab
          ? DELTAS.interview_jab[entry.sentiment as "hostile" | "dismissive"]
          : DELTAS.interview_praise.friendly;
        try {
          await ctx.runMutation(internal.relationships.recordEvent, {
            leagueId: request.leagueId,
            userId: request.targetUserId,
            persona: entry.persona,
            type: isJab ? "interview_jab" : "interview_praise",
            delta,
            evidence: entry.evidence.slice(0, 280),
            commentRequestId: args.commentRequestId,
            week: request.articleContext?.week,
          });
        } catch (relationshipError) {
          // A meter write must never cost us the interview itself.
          console.error("Failed to record interview relationship event:", relationshipError);
        }
      }

      // A bare decline ("no comment", "I'd rather not get into it today") must never become
      // a response row: the analysis happily marks "I'd rather not get into it" as a
      // quotable span, and the writer would print it as the manager's comment. The
      // off-topic gate used to swallow these. `looksLikeDecline` is sentence-level, so a
      // reply with a real sentence in it never matches.
      if (looksLikeDecline(userMessage.content)) {
        await ctx.runMutation(internal.commentConversations.recordDeclineInternal, {
          commentRequestId: args.commentRequestId,
        });
        return;
      }

      // Count total messages so far for this conversation
      const allMessages = await ctx.runQuery(internal.commentConversations.getUserMessages, {
        commentRequestId: args.commentRequestId,
      });

      // Continue only for the single sanctioned follow-up (spec §5).
      const shouldContinue = await ctx.runMutation(internal.commentConversations.evaluateConversationContinuation, {
        commentRequestId: args.commentRequestId,
        responseQuality: analysis.responseQuality,
        completeness: analysis.completeness,
        offTopicScore: analysis.offTopicScore,
        quotableSegments: analysis.quotableSegments,
      });

      if (shouldContinue) {
        // Generate follow-up question (ignore analysis.needsFollowUp as our logic is more robust)
        await ctx.scheduler.runAfter(1000, internal.commentConversations.generateAIFollowUp, {
          commentRequestId: args.commentRequestId,
          suggestedTopics: analysis.suggestedFollowUps || [],
        });
      } else {
        // End the conversation - reason is determined by our robust evaluation logic
        const reason = analysis.responseQuality >= 70 ? "sufficient_response" : 
                     analysis.offTopicScore > 70 ? "off_topic" :
                     allMessages.length >= 6 ? "max_exchanges" : "auto_ended";
        
        await ctx.runMutation(internal.commentConversations.completeConversation, {
          commentRequestId: args.commentRequestId,
          reason,
        });
      }
    } catch (error) {
      console.error("Error processing user response:", error);
      // Don't throw - just log and potentially mark request as having issues
    }
  },
});

// Generate AI follow-up question
export const generateAIFollowUp = internalAction({
  args: {
    commentRequestId: v.id("commentRequests"),
    suggestedTopics: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("Generating AI follow-up for request:", args.commentRequestId);

    const request = await ctx.runQuery(internal.commentConversations.getRequestWithContext, {
      commentRequestId: args.commentRequestId,
    });

    if (!request) {
      console.error("Comment request not found");
      return;
    }

    try {
      // Use the shared context builder for accurate context
      const conversationContext = await ctx.runQuery(internal.commentRequests.buildConversationContext, {
        commentRequestId: args.commentRequestId,
      });
      if (!conversationContext) {
        throw new Error("Failed to build conversation context");
      }

      // Generate follow-up question
      const result = await ctx.runAction(internal.aiNode.generateConversationQuestion, {
        context: conversationContext,
      });

      console.log("AI follow-up generated:", result);

      // Honor a decline once (spec §5): if Sam read the reply as "no comment", the
      // request is marked declined instead of being asked a second question - unless
      // the manager actually said something quotable first ("...that's all, no further
      // comment"). That is an answer with a close on the end, not a decline; last
      // season it was recorded as a decline and the words were never used.
      if (result.shouldRecordDecline) {
        const spoke = await ctx.runQuery(internal.commentConversations.hasQuotableReply, {
          commentRequestId: args.commentRequestId,
        });
        if (!spoke) {
          await ctx.runMutation(internal.commentConversations.recordDeclineInternal, {
            commentRequestId: args.commentRequestId,
          });
          return;
        }
        result.intent = "closing";
        result.shouldEndAfterResponse = true;
      }

      // Check for abuse detection
      if (result.detectedAbuse && result.detectedAbuse.severity !== "low") {
        await ctx.runMutation(internal.commentConversations.completeConversation, {
          commentRequestId: args.commentRequestId,
          reason: "abuse_detected",
        });
        return;
      }

      // Store the AI message
      await ctx.runMutation(internal.commentConversations.createAIMessage, {
        commentRequestId: args.commentRequestId,
        content: result.question,
        messageType: "ai_follow_up",
        aiMetadata: {
          confidence: result.confidence,
          intent: result.intent,
          generationModel: "claude-opus-5",
          processingTime: Date.now(),
        },
        shouldEndAfterResponse: result.shouldEndAfterResponse,
      });

      // Sam just closed on a complete first answer. Build the response row NOW from
      // what they said (`processCompletedResponse` upserts, and `createCommentResponse`
      // posts the quote-approval prompt once the row lands), while the request stays
      // active so a reply to "anything else?" is still taken. Before this, nothing was
      // written until a second reply arrived: a manager who answered fully and then
      // went quiet was expired at the deadline and told the article ran without them.
      if (result.intent === "closing") {
        await ctx.scheduler.runAfter(0, internal.commentConversations.processCompletedResponse, {
          commentRequestId: args.commentRequestId,
        });
      }

      // Send notification to user - request is already available from above
      if (request) {
        // Get league name for notification
        const league = await ctx.runQuery(internal.contentScheduling.getLeagueById, { leagueId: request.leagueId });
        
        await ctx.scheduler.runAfter(0, internal.notifications.sendCommentFollowUp, {
          userId: request.targetUserId,
          commentRequestId: args.commentRequestId,
          leagueId: request.leagueId,
          question: result.question,
          leagueName: league?.name || "your league",
        });
      }

    } catch (error) {
      console.error("Error generating AI follow-up:", error);
    }
  },
});


export const updateMessageAnalysis = internalMutation({
  args: {
    messageId: v.id("commentConversations"),
    analysis: v.object({
      sentiment: v.optional(v.string()),
      completeness: v.optional(v.number()),
      relevantTopics: v.optional(v.array(v.string())),
      needsFollowUp: v.optional(v.boolean()),
      suggestedFollowUps: v.optional(v.array(v.string())),
      // The verbatim spans. `processCompletedResponse` builds the quote ledger from
      // these and from nothing else (spec §5); `relevantTopics` are labels, not quotes.
      quotableSegments: v.optional(v.array(v.string())),
      writerSentiment: v.optional(v.array(writerSentimentValidator)),
    }),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return;

    // Defence in depth: a segment that is not actually contained in what the manager
    // typed never reaches storage, so no downstream consumer can print it as a quote.
    const quotableSegments = args.analysis.quotableSegments
      ? keepVerbatimSegments(message.content, args.analysis.quotableSegments)
      : undefined;

    await ctx.db.patch(args.messageId, {
      responseAnalysis: { ...args.analysis, quotableSegments },
    });
  },
});

/**
 * Interview shape (spec §5): opener -> at most one follow-up -> close.
 *
 * Continue if and only if this is the manager's first reply and it is not off-topic.
 * Everything else closes. This replaces a 120-line, twelve-branch heuristic that in
 * practice produced the same outcome while burning an extra model call to get there.
 */
export const evaluateConversationContinuation = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    responseQuality: v.number(),
    completeness: v.number(),
    offTopicScore: v.number(),
    quotableSegments: v.array(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return false;

    const messages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q =>
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    const userMessageCount = messages.filter(m => m.messageType === "user_response").length;
    const shouldContinue = userMessageCount === 1 && args.offTopicScore < 50;

    console.log(
      shouldContinue
        ? "CONTINUE: first reply on topic, asking the one follow-up"
        : `CLOSE: userMessages=${userMessageCount}, offTopicScore=${args.offTopicScore}`
    );

    return shouldContinue;
  },
});

/**
 * "No comment." The target manager ends the interview themselves; the writer may
 * report the decline but may never turn it into a quote (spec §4/§5).
 */
export const declineCommentRequest = mutation({
  args: { commentRequestId: v.id("commentRequests") },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);

    const request = await ctx.db.get(args.commentRequestId);
    if (!request) throw new Error("Comment request not found");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", q => q.eq("clerkId", identity.subject))
      .unique();

    if (!user || user._id !== request.targetUserId) {
      throw new Error("Not authorized: this comment request is not yours");
    }

    if (request.status === "declined") {
      return { success: true };
    }
    if (request.status !== "pending" && request.status !== "active") {
      throw new Error("This comment request is already closed");
    }

    const now = Date.now();
    await ctx.db.patch(request._id, {
      status: "declined",
      conversationState: "auto_ended",
      declinedAt: now,
      updatedAt: now,
    });

    const messages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q =>
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    await ctx.db.insert("commentConversations", {
      commentRequestId: args.commentRequestId,
      leagueId: request.leagueId,
      userId: request.targetUserId,
      messageType: "system_message",
      content: "Noted - you declined to comment. The story will say so and nothing you have written here will be quoted.",
      messageOrder: messages.length,
      isRead: true,
      createdAt: now,
      threadDepth: 0,
    });

    return { success: true };
  },
});

/** True when any reply on this request carries a verbatim quotable span. */
export const hasQuotableReply = internalQuery({
  args: { commentRequestId: v.id("commentRequests") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q => q.eq("commentRequestId", args.commentRequestId))
      .collect();
    return messages.some(
      m =>
        m.messageType === "user_response" &&
        keepVerbatimSegments(m.content, m.responseAnalysis?.quotableSegments ?? []).length > 0
    );
  },
});

/**
 * Server-side decline, used when the interviewer reads a reply as "no comment".
 * The user-initiated path is the public `declineCommentRequest` mutation above.
 */
export const recordDeclineInternal = internalMutation({
  args: { commentRequestId: v.id("commentRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return null;
    if (request.status !== "pending" && request.status !== "active") return null;

    const now = Date.now();
    await ctx.db.patch(request._id, {
      status: "declined",
      conversationState: "auto_ended",
      declinedAt: now,
      updatedAt: now,
    });

    const messages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q =>
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    await ctx.db.insert("commentConversations", {
      commentRequestId: args.commentRequestId,
      leagueId: request.leagueId,
      userId: request.targetUserId,
      messageType: "system_message",
      content: "Thanks for your time. We'll note that you declined to comment.",
      messageOrder: messages.length,
      isRead: false,
      createdAt: now,
      threadDepth: 0,
    });

    return null;
  },
});

/**
 * The manager's approved quotes, verbatim, for this request. Ships now; the approval
 * UI is P2 (spec §5). Only spans the manager actually typed are accepted.
 */
export const approveQuotes = mutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    quotes: v.array(v.string()),
  },
  returns: v.object({ approved: v.number(), rejected: v.number() }),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);

    const request = await ctx.db.get(args.commentRequestId);
    if (!request) throw new Error("Comment request not found");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", q => q.eq("clerkId", identity.subject))
      .unique();

    if (!user || user._id !== request.targetUserId) {
      throw new Error("Not authorized: this comment request is not yours");
    }

    const response = await ctx.db
      .query("commentResponses")
      .withIndex("by_comment_request", q =>
        q.eq("commentRequestId", args.commentRequestId)
      )
      .first();

    if (!response) throw new Error("No response recorded for this comment request yet");

    // Approving cannot mint new text: every quote must still be verbatim in what the
    // manager typed. Light cleanup lives in the (P2) edit flow, not here.
    const approvedQuotes = keepVerbatimSegments(response.rawResponse, args.quotes);

    await ctx.db.patch(response._id, {
      approvedQuotes,
      updatedAt: Date.now(),
    });

    return { approved: approvedQuotes.length, rejected: args.quotes.length - approvedQuotes.length };
  },
});

/**
 * Manager sign-off on one quote (spec §8.1).
 *
 * `approve` keeps the extracted span as it stands. `edit` replaces it with what the
 * manager typed - that text becomes the verbatim of record and is deliberately not
 * re-checked against the raw reply, because they wrote it. `withdraw` takes it off
 * the record: `getStructuredCommentResponses` never sends a withdrawn quote to the
 * writer. Auth is the target manager only; the commissioner may read, never edit.
 */
export const reviewQuote = mutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    index: v.number(),
    action: quoteReviewActionValidator,
    text: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    quotes: v.array(quoteReviewEntryValidator),
  }),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);

    const request = await ctx.db.get(args.commentRequestId);
    if (!request) throw new Error("Comment request not found");

    const user = await callerUser(ctx, identity.subject);
    if (!user || user._id !== request.targetUserId) {
      throw new Error("Not authorized: this comment request is not yours");
    }

    const response = await responseForRequest(ctx, args.commentRequestId);
    if (!response) {
      throw new Error("No response recorded for this comment request yet");
    }

    const quotes: QuoteReviewEntry[] = [...(response.quoteReview ?? [])];
    if (!Number.isInteger(args.index) || args.index < 0 || args.index >= quotes.length) {
      throw new Error("No quote at that position");
    }

    const entry = quotes[args.index];
    if (args.action === "approve") {
      quotes[args.index] = { ...entry, status: "approved" };
    } else if (args.action === "withdraw") {
      quotes[args.index] = { ...entry, status: "withdrawn" };
    } else {
      const text = (args.text ?? "").trim();
      if (text.length === 0) {
        throw new Error("Editing a quote requires the replacement text");
      }
      quotes[args.index] = { ...entry, text, status: "edited" };
    }

    await ctx.db.patch(response._id, { quoteReview: quotes, updatedAt: Date.now() });
    return { success: true, quotes };
  },
});

/**
 * The quote ledger and the print deadline, for the approval UI (spec §8.1).
 * Readable by the target manager or by a commissioner of the request's league.
 */
export const getQuoteReview = query({
  args: { commentRequestId: v.id("commentRequests") },
  returns: v.union(
    v.object({
      deadline: v.number(),
      quotes: v.array(quoteReviewEntryValidator),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return null;

    const identity = await ctx.auth.getUserIdentity();
    let authorized = false;
    if (identity) {
      const user = await callerUser(ctx, identity.subject);
      authorized = !!user && user._id === request.targetUserId;
    }
    if (!authorized) {
      const membership = await getLeagueMembership(ctx, request.leagueId);
      if (!membership || membership.membership.role !== "commissioner") return null;
    }

    const response = await responseForRequest(ctx, args.commentRequestId);
    return {
      deadline: request.articleGenerationTime,
      quotes: response?.quoteReview ?? [],
    };
  },
});

/**
 * Post the quote-approval message for a request that already has a response row.
 * No-op when there is nothing pending or the message is already there.
 */
export const postQuoteApprovalMessage = internalMutation({
  args: { commentRequestId: v.id("commentRequests") },
  returns: v.union(v.id("commentConversations"), v.null()),
  handler: async (ctx, args) => {
    return await postQuoteApproval(ctx, args.commentRequestId);
  },
});

/**
 * Deadline behaviour (spec §8.1): silence is consent. Every quote still `pending`
 * when we go to print becomes `approved`. Scheduled at the deadline alongside the
 * other checks and re-run inside `checkAndGenerate` as a safety net, so it is
 * idempotent - a second pass finds nothing pending and writes nothing.
 */
export const autoApprovePendingQuotes = internalMutation({
  args: { commentRequestIds: v.array(v.id("commentRequests")) },
  returns: v.object({ approved: v.number(), responses: v.number() }),
  handler: async (ctx, args) => {
    let approved = 0;
    let responses = 0;

    for (const requestId of args.commentRequestIds) {
      const response = await responseForRequest(ctx, requestId);
      if (!response?.quoteReview) continue;

      const pending = response.quoteReview.filter(q => q.status === "pending").length;
      if (pending === 0) continue;

      const quotes: QuoteReviewEntry[] = response.quoteReview.map(q =>
        q.status === "pending" ? { ...q, status: "approved" as const } : q
      );
      await ctx.db.patch(response._id, { quoteReview: quotes, updatedAt: Date.now() });
      approved += pending;
      responses += 1;
    }

    return { approved, responses };
  },
});

export const createAIMessage = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    content: v.string(),
    messageType: v.union(
      v.literal("ai_question"),
      v.literal("ai_follow_up"),
      v.literal("ai_confirmation")
    ),
    aiMetadata: v.optional(v.object({
      promptTemplate: v.optional(v.string()),
      generationModel: v.optional(v.string()),
      processingTime: v.optional(v.number()),
      confidence: v.optional(v.number()),
      intent: v.optional(v.string()),
    })),
    shouldEndAfterResponse: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) throw new Error("Comment request not found");

    const existingMessages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q => 
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    const messageId = await ctx.db.insert("commentConversations", {
      commentRequestId: args.commentRequestId,
      leagueId: request.leagueId,
      userId: request.targetUserId,
      messageType: args.messageType,
      content: args.content,
      messageOrder: existingMessages.length,
      isRead: false,
      aiMetadata: args.aiMetadata,
      createdAt: Date.now(),
      threadDepth: 0,
    });

    // Update request metadata
    await ctx.db.patch(request._id, {
      autoEndCriteria: {
        ...request.autoEndCriteria,
        currentMessageCount: existingMessages.length + 1,
        lastActivityTime: Date.now(),
      },
      updatedAt: Date.now(),
    });

    return messageId;
  },
});

export const completeConversation = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return;

    // Update request status
    await ctx.db.patch(request._id, {
      status: "completed",
      conversationState: "response_complete",
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Create system message
    const messages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q => 
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    let systemMessage = "Thanks for your input! Your insights will be included in the upcoming article.";
    
    if (args.reason === "auto_ended") {
      systemMessage = "Conversation ended. Thank you for your time!";
    } else if (args.reason === "abuse_detected") {
      systemMessage = "Let's keep the conversation focused on your fantasy football experience.";
    }

    await ctx.db.insert("commentConversations", {
      commentRequestId: args.commentRequestId,
      leagueId: request.leagueId,
      userId: request.targetUserId,
      messageType: "system_message",
      content: systemMessage,
      messageOrder: messages.length,
      isRead: false,
      createdAt: Date.now(),
      threadDepth: 0,
    });

    // Process the response for article use
    await ctx.scheduler.runAfter(0, internal.commentConversations.processCompletedResponse, {
      commentRequestId: args.commentRequestId,
    });
  },
});

// Process completed response for article integration
export const processCompletedResponse = internalAction({
  args: {
    commentRequestId: v.id("commentRequests"),
  },
  handler: async (ctx, args) => {
    // Get all user messages
    const messages = await ctx.runQuery(internal.commentConversations.getUserMessages, {
      commentRequestId: args.commentRequestId,
    });

    if (messages.length === 0) return;

    const request = await ctx.runQuery(internal.commentConversations.getRequestData, {
      commentRequestId: args.commentRequestId,
    });

    if (!request) return;

    // Get all conversation messages to find AI questions that prompted responses
    const allMessages = await ctx.runQuery(internal.commentConversations.getAllMessages, {
      commentRequestId: args.commentRequestId,
    });

    // Extract question contexts from AI messages
    const questionContexts: string[] = [];
    allMessages.forEach((msg: any) => {
      if (msg.messageType === "ai_question" && msg.aiMetadata?.intent) {
        questionContexts.push(msg.aiMetadata.intent);
      }
    });

    // Combine all user responses
    const rawResponse = messages
      .map(m => m.content)
      .join("\n\n");

    // The quote ledger. Built from `quotableSegments` only, and re-checked against the
    // message each segment came from, so nothing that is not a verbatim span of what the
    // manager actually typed can be printed inside quotation marks (spec §5).
    // `relevantTopics` are keyword labels ("lineup decisions") and were never quotes -
    // reading them here is what made articles print managers saying category names.
    const allQuotes: string[] = [];
    for (const message of messages) {
      for (const quote of keepVerbatimSegments(
        message.content,
        message.responseAnalysis?.quotableSegments ?? []
      )) {
        if (!allQuotes.includes(quote)) allQuotes.push(quote);
      }
    }

    // Calculate overall quality
    const avgQuality = messages.reduce((sum, m) => 
      sum + (m.responseAnalysis?.completeness || 0), 0
    ) / messages.length;

    // Create a general question context summary
    const questionContext = questionContexts.length > 0 
      ? questionContexts.join(", ") 
      : request.contentType === "draft_rankings" 
        ? "their draft strategy and player selections"
        : "their team performance and league insights";

    // Create comment response record
    await ctx.runMutation(internal.commentConversations.createCommentResponse, {
      commentRequestId: args.commentRequestId,
      leagueId: request.leagueId,
      userId: request.targetUserId,
      scheduledContentId: request.scheduledContentId || null,
      manualContentId: request.manualContentId || undefined,
      rawResponse,
      processedResponse: rawResponse, // Could apply additional processing
      responseType: "mixed", // Could be more sophisticated
      relevanceMetadata: {
        topicRelevance: Math.min(100, avgQuality * 1.2),
        qualityScore: avgQuality,
        originality: 75, // Placeholder
        usabilityRating: avgQuality >= 70 ? "high" : avgQuality >= 50 ? "medium" : "low",
        extractedQuotes: allQuotes.slice(0, 5),
        keyInsights: questionContexts, // Store question contexts as key insights
        suggestedUsage: `When asked about ${questionContext}`,
      },
      userEngagementLevel: avgQuality >= 70 ? "high" : avgQuality >= 50 ? "medium" : "low",
      processedAt: Date.now(),
    });
  },
});

export const getUserMessages = internalQuery({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request_order", q => 
        q.eq("commentRequestId", args.commentRequestId)
      )
      .filter(q => q.eq(q.field("messageType"), "user_response"))
      .collect();
  },
});

export const getRequestWithContext = internalQuery({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return null;

    // Get scheduled content
    const scheduledContent = request.scheduledContentId ? await ctx.db.get(request.scheduledContentId) : null;
    
    // Get league information
    const league = await ctx.db.get(request.leagueId);

    return {
      ...request,
      scheduledContent,
      league,
    };
  },
});

export const getMessage = internalQuery({
  args: { messageId: v.id("commentConversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.messageId);
  },
});

export const getRequestData = internalQuery({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.commentRequestId);
  },
});

export const getAllMessages = internalQuery({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request_order", q => 
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();
  },
});

export const createCommentResponse = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    scheduledContentId: v.union(v.id("scheduledContent"), v.null()),
    manualContentId: v.optional(v.id("aiContent")),
    rawResponse: v.string(),
    processedResponse: v.string(),
    responseType: v.union(
      v.literal("opinion"),
      v.literal("analysis"),
      v.literal("prediction"),
      v.literal("story"),
      v.literal("question"),
      v.literal("mixed")
    ),
    relevanceMetadata: v.object({
      topicRelevance: v.number(),
      qualityScore: v.number(),
      originality: v.number(),
      usabilityRating: v.union(
        v.literal("high"),
        v.literal("medium"),
        v.literal("low"),
        v.literal("unusable")
      ),
      extractedQuotes: v.optional(v.array(v.string())),
      keyInsights: v.optional(v.array(v.string())),
      suggestedUsage: v.optional(v.string()),
    }),
    userEngagementLevel: v.union(
      v.literal("high"),
      v.literal("medium"),
      v.literal("low"),
      v.literal("reluctant")
    ),
    processedAt: v.number(),
  },
  handler: async (ctx, args) => {
    // Seed the approval ledger (spec §8.1). Every extracted quote starts
    // `pending` with `text === original`; the manager approves, edits or
    // withdraws each one, and anything still pending at the deadline is
    // auto-approved. `getStructuredCommentResponses` reads this, not
    // `extractedQuotes`, once it exists.
    const quoteReview: QuoteReviewEntry[] = (
      args.relevanceMetadata.extractedQuotes ?? []
    )
      .filter(q => q && q.trim().length > 0)
      .map(q => ({ original: q, text: q, status: "pending" as const }));

    // Upsert: the row is built when Sam closes and rebuilt if the manager adds a
    // reply to "anything else?". Entries the manager already approved, edited or
    // withdrew keep their status; only genuinely new quotes are added as pending.
    const existing = await responseForRequest(ctx, args.commentRequestId);
    if (existing) {
      const kept = existing.quoteReview ?? [];
      const known = new Set(kept.map(q => q.original));
      const merged = [...kept, ...quoteReview.filter(q => !known.has(q.original))];
      await ctx.db.patch(existing._id, {
        rawResponse: args.rawResponse,
        processedResponse: args.processedResponse,
        responseType: args.responseType,
        relevanceMetadata: args.relevanceMetadata,
        userEngagementLevel: args.userEngagementLevel,
        processedAt: args.processedAt,
        quoteReview: merged.length > 0 ? merged : undefined,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("commentResponses", {
        ...args,
        quoteReview: quoteReview.length > 0 ? quoteReview : undefined,
        integrationStatus: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // The manager sees the approval prompt once, immediately after the close.
    await postQuoteApproval(ctx, args.commentRequestId);
  },
});