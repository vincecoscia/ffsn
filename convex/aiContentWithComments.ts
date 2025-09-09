import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// Create comment requests and wait for responses
export const createCommentRequestsAndWait = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    targetUserIds: v.array(v.string()),
    articleGenerationTime: v.number(), // Unix timestamp of when to generate the article
  },
  handler: async (ctx, args) => {
    console.log("=== Creating comment requests for content generation ===");
    
    try {
      // Get users from teamClaims based on selected team IDs
      // args.targetUserIds contains team IDs selected in the UI
      const userIdsFromClaims = await ctx.runQuery(internal.aiContentWithComments.getUsersFromTeamClaims, {
        leagueId: args.leagueId,
        teamIds: args.targetUserIds, // These are team IDs from the frontend
      });
      
      const validUserIds = userIdsFromClaims.filter(id => id !== undefined) as Id<"users">[];
      
      if (validUserIds.length === 0) {
        console.warn("No valid users found for comment requests");
        // Still proceed with generation without comments
        await ctx.scheduler.runAfter(0, internal.aiContent.generateContentAction, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          seasonId: args.seasonId,
          week: args.week,
        });
        return;
      }
      
      // Fetch draft data if this is draft-related content
      let draftData = undefined;
      if (args.contentType === 'draft_rankings' || args.contentType === 'mock_draft') {
        try {
          const draftInfo = await ctx.runQuery(internal.draftRankingsHelpers.getSimplifiedDraftData, {
            leagueId: args.leagueId,
            seasonId: args.seasonId || new Date().getFullYear(),
          });
          
          // Build a map of userId to their draft picks
          const userDraftPicks: Record<string, any[]> = {};
          for (const userId of validUserIds) {
            const user = await ctx.runQuery(internal.aiContentWithComments.getUserById, { userId });
            if (user) {
              // Find this user's team and their picks
              const userTeam = draftInfo.teamGrades.find(t => 
                t.teamOwner === user.name || t.teamOwner === user.clerkId
              );
              if (userTeam) {
                userDraftPicks[userId] = draftInfo.draftPicks.filter(pick => 
                  pick.teamName === userTeam.teamName
                );
              }
            }
          }
          
          draftData = {
            draftType: draftInfo.leagueInfo.draftType,
            draftOrder: draftInfo.draftOrder,
            userDraftPicks,
          };
        } catch (error) {
          console.warn("Failed to fetch draft data for comment requests:", error);
        }
      }
      
      // Fetch weekly recap data if this is weekly recap content
      let weeklyRecapData = undefined;
      if (args.contentType === 'weekly_recap') {
        try {
          // Get team information for each user
          const userTeamMapping: Record<string, any> = {};
          for (const userId of validUserIds) {
            const user = await ctx.runQuery(internal.aiContentWithComments.getUserById, { userId });
            const userTeam = await ctx.runQuery(internal.aiContentWithComments.getUserTeam, {
              userId,
              leagueId: args.leagueId,
            });
            
            if (user && userTeam) {
              userTeamMapping[userId] = {
                teamId: userTeam._id,
                teamName: userTeam.name,
                teamExternalId: userTeam.externalId,
                managerName: user.name,
                userId: userId,
              };
            }
          }
          
          weeklyRecapData = {
            week: args.week,
            seasonId: args.seasonId || new Date().getFullYear(),
            userTeamMapping,
          };
        } catch (error) {
          console.warn("Failed to fetch weekly recap data for comment requests:", error);
        }
      }
      
      // Create comment requests for manual content
      const commentRequestIds = await ctx.runMutation(internal.aiContentWithComments.createManualCommentRequests, {
        articleId: args.articleId,
        leagueId: args.leagueId,
        contentType: args.contentType,
        targetUserIds: validUserIds,
        articleGenerationTime: args.articleGenerationTime,
        week: args.week,
        seasonId: args.seasonId,
        draftData,
        weeklyRecapData,
      });
      
      console.log(`Created ${commentRequestIds.length} comment requests`);
      
      // Send initial requests immediately
      for (const requestId of commentRequestIds) {
        await ctx.scheduler.runAfter(0, internal.aiContentWithComments.sendManualCommentRequest, {
          commentRequestId: requestId,
        });
      }
      
      // Schedule the monitoring and generation
      await ctx.scheduler.runAt(args.articleGenerationTime, internal.aiContentWithComments.checkAndGenerate, {
        articleId: args.articleId,
        leagueId: args.leagueId,
        contentType: args.contentType,
        persona: args.persona,
        customContext: args.customContext,
        userId: args.userId,
        seasonId: args.seasonId,
        week: args.week,
        commentRequestIds,
      });
      
      // Also schedule periodic checks to see if all responses are collected
      const timeUntilGeneration = args.articleGenerationTime - Date.now();
      for (let i = 1; i <= 4; i++) {
        const checkTime = Date.now() + (timeUntilGeneration / 4) * i;
        await ctx.scheduler.runAt(checkTime, internal.aiContentWithComments.checkIfAllResponsesReceived, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          seasonId: args.seasonId,
          week: args.week,
          commentRequestIds,
        });
      }
      
    } catch (error) {
      console.error("Error in createCommentRequestsAndWait:", error);
      
      // Update article status to failed
      await ctx.runMutation(api.aiContent.updateContentStatus, {
        articleId: args.articleId,
        status: "failed",
        error: error instanceof Error ? error.message : "Failed to create comment requests",
      });
    }
  },
});

// Create comment requests for manual content generation
export const createManualCommentRequests = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    targetUserIds: v.array(v.id("users")),
    articleGenerationTime: v.number(), // Unix timestamp of when to generate the article
    week: v.optional(v.number()),
    seasonId: v.optional(v.number()),
    draftData: v.optional(v.object({
      draftType: v.optional(v.string()),
      draftOrder: v.optional(v.array(v.any())),
      userDraftPicks: v.optional(v.any()), // Map of userId to their draft picks
    })),
    weeklyRecapData: v.optional(v.object({
      week: v.optional(v.number()),
      seasonId: v.optional(v.number()),
      userTeamMapping: v.optional(v.any()), // Map of userId to their team info
    })),
  },
  handler: async (ctx, args) => {
    const currentTime = Date.now();
    
    const requestIds = await Promise.all(
      args.targetUserIds.map(async (userId) => {
        // Get user's team for context
        const userTeam = await ctx.db
          .query("teams")
          .withIndex("by_league", q => 
            q.eq("leagueId", args.leagueId)
          )
          .filter(q => q.eq(q.field("owner"), userId))
          .first();
        
        // Build article context with draft data if applicable
        let articleContext: any = {
          week: args.week,
          seasonId: args.seasonId,
          topic: `${args.contentType.replace('_', ' ')} Article`,
          focusAreas: ["team performance", "player decisions", "strategy"],
        };
        
        // Add draft-specific context for draft-related content
        if ((args.contentType === 'draft_rankings' || args.contentType === 'mock_draft') && args.draftData) {
          articleContext = {
            ...articleContext,
            draftType: args.draftData.draftType,
            draftOrder: args.draftData.draftOrder,
            userDraftPicks: args.draftData.userDraftPicks?.[userId], // Get this user's specific draft picks
            focusAreas: ["draft strategy", "player selections", "value picks", "roster construction"],
          };
        }
        
        // Add weekly recap-specific context for weekly recap content
        if (args.contentType === 'weekly_recap' && args.weeklyRecapData) {
          const userTeamInfo = args.weeklyRecapData.userTeamMapping?.[userId];
          articleContext = {
            ...articleContext,
            week: args.weeklyRecapData.week,
            seasonId: args.weeklyRecapData.seasonId,
            userTeamInfo, // Include this user's specific team information
            focusAreas: ["team performance", "matchup results", "lineup decisions", "player performances"],
          };
        }
        
        const requestId = await ctx.db.insert("commentRequests", {
          leagueId: args.leagueId,
          manualContentId: args.articleId, // Link to manual content instead of scheduled
          targetUserId: userId,
          contentType: args.contentType,
          articleContext,
          status: "pending",
          scheduledSendTime: currentTime,
          articleGenerationTime: args.articleGenerationTime,
          conversationState: "not_started",
          aiContext: {
            initialPrompt: "",
            conversationGoals: args.contentType === 'draft_rankings' || args.contentType === 'mock_draft'
              ? ["gather draft strategy insights", "get reactions to picks", "collect thoughts on value", "understand roster construction choices"]
              : ["gather team insights", "get player reactions", "collect memorable quotes"],
            currentFocus: args.contentType,
          },
          autoEndCriteria: {
            maxMessages: 8,
            currentMessageCount: 0,
            minResponseLength: 30,
            lastActivityTime: currentTime,
            inactivityTimeoutMinutes: 30,
          },
          priority: "high", // Manual requests are high priority
          notificationsSent: [],
          createdAt: currentTime,
          updatedAt: currentTime,
        });
        
        return requestId;
      })
    );
    
    return requestIds;
  },
});

// Send a manual comment request
export const sendManualCommentRequest = internalAction({
  args: {
    commentRequestId: v.id("commentRequests"),
  },
  handler: async (ctx, args) => {
    // Reuse the existing sendInitialRequests logic but for a single request
    const request = await ctx.runQuery(internal.aiContentWithComments.getCommentRequest, {
      commentRequestId: args.commentRequestId,
    });
    
    if (!request || request.status !== "pending") {
      console.log("Request not found or not pending");
      return;
    }
    
    try {
      // Get full context for AI generation
      const context = await ctx.runQuery(internal.commentRequests.buildConversationContext, {
        commentRequestId: args.commentRequestId,
      });
      
      if (!context) {
        console.error(`Failed to build context for request ${args.commentRequestId}`);
        return;
      }
      
      // Generate initial AI question
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY not configured");
      }
      
      const { conversationService } = await import("../src/lib/ai/conversation-service");
      const aiResult = await conversationService.generateConversationQuestion(context, apiKey);
      
      console.log(`Generated initial question for user ${request.targetUserId}`);
      
      // Create the initial AI message
      await ctx.runMutation(internal.commentConversations.createAIMessage, {
        commentRequestId: args.commentRequestId,
        content: aiResult.question,
        messageType: "ai_question",
        aiMetadata: {
          generationModel: "claude-sonnet-4",
          processingTime: Date.now(),
          confidence: aiResult.confidence,
          intent: aiResult.intent,
        },
        shouldEndAfterResponse: aiResult.shouldEndAfterResponse,
      });
      
      // Update request status
      await ctx.runMutation(internal.commentRequests.updateRequestStatus, {
        commentRequestId: args.commentRequestId,
        status: "active",
        conversationState: "initial_request_sent",
        notificationSent: {
          type: "initial_request",
          sentAt: Date.now(),
          method: "app_notification",
          delivered: true,
        },
      });
      
      // Send notification to user
      await ctx.scheduler.runAfter(0, internal.notifications.sendCommentRequest, {
        userId: request.targetUserId,
        commentRequestId: args.commentRequestId,
        message: aiResult.question,
        articleType: request.contentType,
        leagueName: context.leagueName || "your league",
        leagueId: request.leagueId,
      });
      
    } catch (error) {
      console.error(`Error processing request ${args.commentRequestId}:`, error);
    }
  },
});

// Check if all responses have been received
export const checkIfAllResponsesReceived = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    commentRequestIds: v.array(v.id("commentRequests")),
  },
  handler: async (ctx, args) => {
    // Check if article is still waiting
    const article = await ctx.runQuery(internal.aiContentWithComments.getArticle, {
      articleId: args.articleId,
    });
    
    if (!article || article.status !== "waiting_for_comments") {
      // Don't log anything - this is expected behavior when article completes early
      return;
    }
    
    // Check if all comment requests have responses
    const allResponses = await ctx.runQuery(internal.aiContentWithComments.checkAllResponsesReceived, {
      commentRequestIds: args.commentRequestIds,
    });
    
    if (allResponses) {
      console.log("All comment responses received, generating content");
      
      // Update article status immediately to prevent other scheduled checks from running
      await ctx.runMutation(api.aiContent.updateContentStatus, {
        articleId: args.articleId,
        status: "generating",
      });
      
      // Generate content with comments
      await ctx.runAction(internal.aiContentWithComments.generateWithComments, {
        articleId: args.articleId,
        leagueId: args.leagueId,
        contentType: args.contentType,
        persona: args.persona,
        customContext: args.customContext,
        userId: args.userId,
        seasonId: args.seasonId,
        week: args.week,
        commentRequestIds: args.commentRequestIds,
      });
    }
  },
});

// Check and generate after expiration
export const checkAndGenerate = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    commentRequestIds: v.array(v.id("commentRequests")),
  },
  handler: async (ctx, args) => {
    // Check if article is still waiting
    const article = await ctx.runQuery(internal.aiContentWithComments.getArticle, {
      articleId: args.articleId,
    });
    
    if (!article || article.status !== "waiting_for_comments") {
      // Don't log anything - this is expected behavior when article completes early
      return;
    }
    
    console.log("Comment request period expired, generating content with available responses");
    
    // First, expire all pending/active comment requests for this article
    await ctx.runMutation(internal.aiContentWithComments.expireCommentRequests, {
      commentRequestIds: args.commentRequestIds,
    });
    
    // Update article status immediately to prevent other scheduled checks from running
    await ctx.runMutation(api.aiContent.updateContentStatus, {
      articleId: args.articleId,
      status: "generating",
    });
    
    // Generate content with whatever comments we have
    await ctx.runAction(internal.aiContentWithComments.generateWithComments, {
      articleId: args.articleId,
      leagueId: args.leagueId,
      contentType: args.contentType,
      persona: args.persona,
      customContext: args.customContext,
      userId: args.userId,
      seasonId: args.seasonId,
      week: args.week,
      commentRequestIds: args.commentRequestIds,
    });
  },
});

// Generate content with collected comments
export const generateWithComments = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    commentRequestIds: v.array(v.id("commentRequests")),
  },
  handler: async (ctx, args) => {
    // Get comment responses
    const commentResponses = await ctx.runQuery(internal.aiContentWithComments.getCommentResponses, {
      commentRequestIds: args.commentRequestIds,
    });
    
    // Build enhanced context with comments
    let enhancedContext = args.customContext || "";
    
    if (commentResponses.length > 0) {
      enhancedContext += "\n\n=== TEAM COMMENTS ===\n";
      enhancedContext += "The following comments were collected from league members:\n\n";
      
      for (const response of commentResponses) {
        if (response.processedResponse) {
          enhancedContext += `Team Comment: "${response.processedResponse}"\n`;
        }
      }
      
      enhancedContext += "\nPlease incorporate these comments naturally into the article where relevant.";
    }
    
    // Trigger the regular content generation with enhanced context
    await ctx.runAction(internal.aiContent.generateContentAction, {
      articleId: args.articleId,
      leagueId: args.leagueId,
      contentType: args.contentType,
      persona: args.persona,
      customContext: enhancedContext,
      userId: args.userId,
      seasonId: args.seasonId,
      week: args.week,
    });
  },
});

// Helper queries
export const getUserByClerkId = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerk_id", q => q.eq("clerkId", args.clerkId))
      .unique();
  },
});

export const getUserById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

export const getUserTeam = internalQuery({
  args: { 
    userId: v.id("users"),
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.clerkId) return null;

    // Use teamClaims table to find the user's team for this league
    const teamClaim = await ctx.db
      .query("teamClaims")
      .withIndex("by_user", q => q.eq("userId", user.clerkId))
      .filter(q => q.eq(q.field("leagueId"), args.leagueId))
      .filter(q => q.eq(q.field("status"), "active"))
      .first();

    if (!teamClaim) return null;

    // Get the actual team record
    const team = await ctx.db.get(teamClaim.teamId);
    return team;
  },
});

export const getUsersFromTeamClaims = internalQuery({
  args: { 
    leagueId: v.id("leagues"),
    teamIds: v.array(v.string()), // Array of team IDs
  },
  handler: async (ctx, args) => {
    console.log("Getting users from team claims for teams:", args.teamIds);
    
    // Get all team claims for this league
    const teamClaims = await ctx.db
      .query("teamClaims")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
      .filter(q => q.eq(q.field("status"), "active"))
      .collect();
    
    console.log(`Found ${teamClaims.length} active team claims for league`);
    
    // Find users who have claimed the selected teams
    const userIds: Id<"users">[] = [];
    
    for (const teamId of args.teamIds) {
      // Find the claim for this team (teamId is already a team ID from the frontend)
      const claim = teamClaims.find(c => c.teamId === teamId);
      if (claim) {
        // Get the user from the claim's userId (which is a Clerk ID)
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", q => q.eq("clerkId", claim.userId))
          .unique();
        
        if (user) {
          console.log(`Found user ${user.name} for team ${teamId}`);
          userIds.push(user._id);
        } else {
          console.log(`No user record found for Clerk ID: ${claim.userId}`);
        }
      } else {
        console.log(`No active claim found for team: ${teamId}`);
      }
    }
    
    console.log(`Returning ${userIds.length} valid user IDs from team claims`);
    return userIds;
  },
});

export const getCommentRequest = internalQuery({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.commentRequestId);
  },
});

export const getArticle = internalQuery({
  args: { articleId: v.id("aiContent") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.articleId);
  },
});

export const checkAllResponsesReceived = internalQuery({
  args: { commentRequestIds: v.array(v.id("commentRequests")) },
  handler: async (ctx, args) => {
    for (const requestId of args.commentRequestIds) {
      const request = await ctx.db.get(requestId);
      if (!request) continue;
      
      // Check if there's a response for this request
      const response = await ctx.db
        .query("commentResponses")
        .withIndex("by_comment_request", q => q.eq("commentRequestId", requestId))
        .first();
      
      if (!response) {
        return false; // At least one request doesn't have a response
      }
    }
    
    return true; // All requests have responses
  },
});

export const getCommentResponses = internalQuery({
  args: { commentRequestIds: v.array(v.id("commentRequests")) },
  handler: async (ctx, args) => {
    const responses = [];
    
    for (const requestId of args.commentRequestIds) {
      const response = await ctx.db
        .query("commentResponses")
        .withIndex("by_comment_request", q => q.eq("commentRequestId", requestId))
        .first();
      
      if (response) {
        responses.push(response);
      }
    }
    
    return responses;
  },
});

// Expire comment requests when article generation time passes
export const expireCommentRequests = internalMutation({
  args: {
    commentRequestIds: v.array(v.id("commentRequests")),
  },
  handler: async (ctx, args) => {
    console.log(`Expiring ${args.commentRequestIds.length} comment requests`);
    
    for (const requestId of args.commentRequestIds) {
      const request = await ctx.db.get(requestId);
      if (!request) continue;
      
      // Only expire requests that are still pending or active
      if (request.status === "pending" || request.status === "active") {
        // Update request status to expired
        await ctx.db.patch(requestId, {
          status: "expired",
          conversationState: "auto_ended",
          expiredAt: Date.now(),
          updatedAt: Date.now(),
        });

        // Add system message to close the conversation
        const existingMessages = await ctx.db
          .query("commentConversations")
          .withIndex("by_comment_request", q => 
            q.eq("commentRequestId", requestId)
          )
          .collect();

        await ctx.db.insert("commentConversations", {
          commentRequestId: requestId,
          leagueId: request.leagueId,
          userId: request.targetUserId,
          messageType: "system_message",
          content: "This comment request has expired. The article has been generated without your input.",
          messageOrder: existingMessages.length,
          isRead: false,
          createdAt: Date.now(),
          threadDepth: 0,
        });

        console.log(`Expired comment request ${requestId}`);
      }
    }
  },
});