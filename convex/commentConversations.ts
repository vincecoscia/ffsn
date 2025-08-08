import { v } from "convex/values";
import { mutation, query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { ConversationContext, conversationService } from "../src/lib/ai/conversation-service";
import { Id } from "./_generated/dataModel";

// Get active comment requests for a user
export const getActiveRequests = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const requests = await ctx.db
      .query("commentRequests")
      .withIndex("by_user_status", q => 
        q.eq("targetUserId", args.userId)
         .eq("status", "active")
      )
      .collect();

    // Enrich with scheduled content info
    const enrichedRequests = await Promise.all(
      requests.map(async (request) => {
        const scheduledContent = await ctx.db.get(request.scheduledContentId);
        const league = await ctx.db.get(request.leagueId);
        
        // Get conversation messages
        const messages = await ctx.db
          .query("commentConversations")
          .withIndex("by_comment_request_order", q => 
            q.eq("commentRequestId", request._id)
          )
          .collect();

        return {
          ...request,
          leagueName: league?.name || "Unknown League",
          articleType: scheduledContent?.contentType || request.contentType,
          scheduledTime: scheduledContent?.scheduledFor,
          messageCount: messages.length,
          lastMessage: messages[messages.length - 1],
        };
      })
    );

    return enrichedRequests;
  },
});

// Get conversation messages for a comment request
export const getConversation = query({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
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
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY not configured");
      }

      // Build ConversationContext using the same context builder used for initial requests
      const conversationContext = await ctx.runQuery(internal.commentRequests.buildConversationContext, {
        commentRequestId: args.commentRequestId,
      });
      if (!conversationContext) {
        throw new Error("Failed to build conversation context");
      }

      // Analyze the user response
      const analysis = await conversationService.analyzeUserResponse(
        userMessage.content,
        conversationContext,
        apiKey
      );

      console.log("User response analysis:", analysis);

      // Store the analysis
      await ctx.runMutation(internal.commentConversations.updateMessageAnalysis, {
        messageId: args.userMessageId,
        analysis: {
          sentiment: analysis.sentiment,
          completeness: analysis.completeness,
          relevantTopics: analysis.relevantTopics,
          needsFollowUp: analysis.needsFollowUp,
          suggestedFollowUps: analysis.suggestedFollowUps,
        },
      });

      // Count total messages so far for this conversation
      const allMessages = await ctx.runQuery(internal.commentConversations.getUserMessages, {
        commentRequestId: args.commentRequestId,
      });

      // Check if we should continue the conversation
      let shouldContinue = await ctx.runMutation(internal.commentConversations.evaluateConversationContinuation, {
        commentRequestId: args.commentRequestId,
        responseQuality: analysis.responseQuality,
        completeness: analysis.completeness,
        offTopicScore: analysis.offTopicScore,
        quotableSegments: analysis.quotableSegments,
      });

      // Ensure at least one follow-up after the user's first response
      if (allMessages.length <= 1) {
        shouldContinue = true;
      }

      if (shouldContinue && analysis.needsFollowUp) {
        // Generate follow-up question
        await ctx.scheduler.runAfter(1000, internal.commentConversations.generateAIFollowUp, {
          commentRequestId: args.commentRequestId,
          suggestedTopics: analysis.suggestedFollowUps || [],
        });
      } else {
        // End the conversation
        await ctx.runMutation(internal.commentConversations.completeConversation, {
          commentRequestId: args.commentRequestId,
          reason: analysis.responseQuality >= 70 ? "sufficient_response" : "auto_ended",
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
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY not configured");
      }

      // Use the shared context builder for accurate context
      const conversationContext = await ctx.runQuery(internal.commentRequests.buildConversationContext, {
        commentRequestId: args.commentRequestId,
      });
      if (!conversationContext) {
        throw new Error("Failed to build conversation context");
      }

      // Generate follow-up question
      const result = await conversationService.generateConversationQuestion(
        conversationContext,
        apiKey
      );

      console.log("AI follow-up generated:", result);

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
          generationModel: "claude-sonnet-4",
          processingTime: Date.now(),
        },
        shouldEndAfterResponse: result.shouldEndAfterResponse,
      });

      // Send notification to user - request is already available from above
      if (request) {
        await ctx.scheduler.runAfter(0, internal.notifications.sendCommentFollowUp, {
          userId: request.targetUserId,
          commentRequestId: args.commentRequestId,
          leagueId: request.leagueId,
          question: result.question,
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
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, {
      responseAnalysis: args.analysis,
    });
  },
});

export const evaluateConversationContinuation = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    responseQuality: v.number(),
    completeness: v.number(),
    offTopicScore: v.number(),
    quotableSegments: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return false;

    // Check auto-end criteria
    const { autoEndCriteria } = request;
    
    // End if max messages reached
    if (autoEndCriteria.currentMessageCount >= autoEndCriteria.maxMessages) {
      console.log("Max messages reached, ending conversation");
      return false;
    }

    // End if response is off-topic
    if (args.offTopicScore > 70) {
      console.log("Response too off-topic, ending conversation");
      return false;
    }

    // End if we have good quotes and sufficient quality
    if (args.quotableSegments.length >= 2 && args.responseQuality >= 70) {
      console.log("Sufficient quotes obtained, ending conversation");
      return false;
    }

    // Continue if response is incomplete and on-topic
    if (args.completeness < 60 && args.offTopicScore < 30) {
      console.log("Response incomplete but on-topic, continuing");
      return true;
    }

    // Ensure at least one follow-up before ending when conversation just started
    if (autoEndCriteria.currentMessageCount <= 2) {
      return true;
    }

    // Default: end if quality is good enough
    return args.responseQuality < 70;
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

    // Combine all user responses
    const rawResponse = messages
      .map(m => m.content)
      .join("\n\n");

    // Extract the best quotes
    const allQuotes = messages
      .flatMap(m => m.responseAnalysis?.relevantTopics || [])
      .filter((quote, index, self) => self.indexOf(quote) === index);

    // Calculate overall quality
    const avgQuality = messages.reduce((sum, m) => 
      sum + (m.responseAnalysis?.completeness || 0), 0
    ) / messages.length;

    // Create comment response record
    await ctx.runMutation(internal.commentConversations.createCommentResponse, {
      commentRequestId: args.commentRequestId,
      leagueId: request.leagueId,
      userId: request.targetUserId,
      scheduledContentId: request.scheduledContentId,
      rawResponse,
      processedResponse: rawResponse, // Could apply additional processing
      responseType: "mixed", // Could be more sophisticated
      relevanceMetadata: {
        topicRelevance: Math.min(100, avgQuality * 1.2),
        qualityScore: avgQuality,
        originality: 75, // Placeholder
        usabilityRating: avgQuality >= 70 ? "high" : avgQuality >= 50 ? "medium" : "low",
        extractedQuotes: allQuotes.slice(0, 5),
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
    const scheduledContent = await ctx.db.get(request.scheduledContentId);
    
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

export const createCommentResponse = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    scheduledContentId: v.id("scheduledContent"),
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
    await ctx.db.insert("commentResponses", {
      ...args,
      integrationStatus: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});