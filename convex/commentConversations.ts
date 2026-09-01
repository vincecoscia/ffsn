import { v } from "convex/values";
import { mutation, query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { ConversationContext } from "../src/lib/ai/conversation-service";
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
        const scheduledContent = request.scheduledContentId ? await ctx.db.get(request.scheduledContentId) : null;
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
      const shouldContinue = await ctx.runMutation(internal.commentConversations.evaluateConversationContinuation, {
        commentRequestId: args.commentRequestId,
        responseQuality: analysis.responseQuality,
        completeness: analysis.completeness,
        offTopicScore: analysis.offTopicScore,
        quotableSegments: analysis.quotableSegments,
      });

      // The evaluateConversationContinuation function now handles all termination logic
      // including hard stops, quality stops, and continuation conditions

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

    // Get all messages to understand conversation depth
    const allMessages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q => 
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    const userMessages = allMessages.filter(m => m.messageType === "user_response");
    const aiMessages = allMessages.filter(m => m.messageType === "ai_question" || m.messageType === "ai_follow_up");

    // Check auto-end criteria
    const { autoEndCriteria } = request;
    const totalExchanges = Math.min(userMessages.length, aiMessages.length);
    const conversationAge = Date.now() - request.createdAt;
    const lastUserMessage = userMessages[userMessages.length - 1];
    
    // HARD STOPS - These always end the conversation regardless of other factors
    
    // 1. Absolute message limit reached
    if (autoEndCriteria.currentMessageCount >= autoEndCriteria.maxMessages) {
      console.log("HARD STOP: Max messages reached, ending conversation");
      return false;
    }

    // 2. Absolute exchange limit (safety net)
    if (totalExchanges >= 4) {
      console.log("HARD STOP: Maximum exchanges (4) reached, ending conversation");
      return false;
    }

    // 3. Time-based cutoff (30 minutes max conversation)
    if (conversationAge > 30 * 60 * 1000) {
      console.log("HARD STOP: Conversation too old (30+ minutes), ending");
      return false;
    }

    // 4. Too many poor quality responses in a row
    const recentUserMessages = userMessages.slice(-2);
    const allPoorQuality = recentUserMessages.length >= 2 && 
      recentUserMessages.every(msg => 
        (msg.responseAnalysis?.completeness || 0) < 40 && 
        (msg.responseAnalysis?.relevantTopics?.length || 0) === 0
      );
    if (allPoorQuality) {
      console.log("HARD STOP: Multiple poor quality responses, ending conversation");
      return false;
    }

    // QUALITY-BASED STOPS - End if we have good material
    
    // 5. Response is completely off-topic
    if (args.offTopicScore > 70) {
      console.log("QUALITY STOP: Response too off-topic, ending conversation");
      return false;
    }

    // 6. Multiple quality responses obtained
    if (userMessages.length >= 2 && args.responseQuality >= 60) {
      console.log("QUALITY STOP: Multiple quality responses obtained, ending conversation");
      return false;
    }

    // 7. Excellent quotes from even one response
    if (args.quotableSegments.length >= 3 && args.responseQuality >= 80) {
      console.log("QUALITY STOP: Excellent quotes obtained, ending conversation");
      return false;
    }

    // 8. Substantial response with good quality
    if (lastUserMessage && lastUserMessage.content.length > 100 && 
        args.responseQuality >= 65 && args.completeness >= 70) {
      console.log("QUALITY STOP: Substantial response received, ending conversation");
      return false;
    }

    // 9. After 3 exchanges, end unless response was very incomplete
    if (totalExchanges >= 3) {
      if (args.completeness >= 50) {
        console.log("QUALITY STOP: 3 exchanges completed with decent completeness, ending");
        return false;
      } else {
        console.log("HARD STOP: 3 exchanges reached regardless of completeness, ending");
        return false;
      }
    }

    // CONTINUATION CONDITIONS - Only continue in specific circumstances
    
    // 10. First response was very incomplete and on-topic
    if (userMessages.length === 1 && args.completeness < 40 && args.offTopicScore < 30) {
      console.log("CONTINUE: First response incomplete but on-topic, allowing follow-up");
      return true;
    }

    // 11. First response, allow one follow-up regardless (but not if off-topic)
    if (userMessages.length === 1 && args.offTopicScore < 50) {
      console.log("CONTINUE: First response received, allowing one follow-up");
      return true;
    }

    // 12. Second response was incomplete and we haven't hit other limits
    if (userMessages.length === 2 && args.completeness < 50 && args.offTopicScore < 30 && 
        args.responseQuality < 60) {
      console.log("CONTINUE: Second response incomplete, allowing final follow-up");
      return true;
    }

    // DEFAULT: End the conversation
    console.log("DEFAULT STOP: No continuation conditions met, ending conversation");
    return false;
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

    // Extract the best quotes
    const allQuotes = messages
      .flatMap(m => m.responseAnalysis?.relevantTopics || [])
      .filter((quote, index, self) => self.indexOf(quote) === index);

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
    await ctx.db.insert("commentResponses", {
      ...args,
      integrationStatus: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});