import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { commentResponseDataValidator, nonRespondentValidator } from "./validators";
import { leagueCurrentSeason } from "./lib/season";
import { requireCommissioner, requireLeagueMember } from "./lib/auth";
import { espnConnectionBlocked } from "./lib/espnConnection";
import { teamForUser, userByClerkId } from "./lib/teamClaims";
import { reminderTimes } from "./lib/reminderTimes";
import { INTERVIEWER_PERSONA, DEFAULT_WRITER_PERSONA } from "./commentRequests";

/* -------------------------------------------------------------------------- */
/* Quote ledger helpers (spec §5)                                              */
/* -------------------------------------------------------------------------- */

/**
 * What Sam actually asked about, taken from her opening question rather than invented.
 * Prefers the interrogative sentence, drops her self-introduction, and caps the length.
 */
function questionTopicFrom(openingQuestion: string | undefined, fallback: string): string {
  if (!openingQuestion) return fallback;
  const sentences = openingQuestion
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
    // Drop the "Sam Ortega, FFSN." style intro and the on-the-record disclosure.
    .filter(s => !/^sam ortega|^simone|ffsn\.$|on the record\.$/i.test(s));

  const topic = sentences.find(s => s.endsWith("?")) ?? sentences[0] ?? openingQuestion;
  const trimmed = topic.trim();
  if (!trimmed) return fallback;
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}

/**
 * What the writer is allowed to print for one manager, in priority order (spec §8.1).
 *
 * 1. `quoteReview` when it exists - approved and edited entries only. An edited
 *    entry's text is what the manager typed and is the verbatim of record;
 *    withdrawn entries are off the record and never reach the writer.
 * 2. `approvedQuotes`, for rows written by the older `approveQuotes` mutation.
 * 3. The verified `extractedQuotes` ledger, only when no review exists.
 * 4. The processed reply, so a manager who spoke is never silently dropped.
 *
 * An empty result means the manager withdrew everything: the caller skips them
 * rather than handing the writer a speaker with no words.
 */
export function quotesForResponse(response: Doc<"commentResponses">): string[] {
  const clean = (quotes: string[]) => quotes.filter(q => q && q.trim().length > 0);

  if (response.quoteReview && response.quoteReview.length > 0) {
    return clean(
      response.quoteReview
        .filter(q => q.status === "approved" || q.status === "edited")
        .map(q => q.text)
    );
  }
  if (response.approvedQuotes && response.approvedQuotes.length > 0) {
    return clean(response.approvedQuotes);
  }
  const extracted = clean(response.relevanceMetadata.extractedQuotes ?? []);
  if (extracted.length > 0) return extracted;
  return clean([response.processedResponse]);
}

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
    // Set by createGenerationWithComments when it already deducted credits
    // up front. Forwarded through checkAndGenerate/checkIfAllResponsesReceived
    // -> generateWithComments -> generateContentAction, and refunded here on
    // failure instead of being silently lost.
    creditsDeductedUpFront: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("=== Creating comment requests for content generation ===");

    try {
      // ESPN connection gate (owner directive, Sept 2026): a blocked private
      // league can't have its data refreshed, so don't open interviews for an
      // article that may sit unresolved for days - skip outreach and continue
      // straight to generation without quotes instead.
      const gatingLeague = await ctx.runQuery(internal.contentScheduling.getLeagueById, {
        leagueId: args.leagueId,
      });
      if (espnConnectionBlocked(gatingLeague)) {
        console.log(
          `Skipping comment outreach for article ${args.articleId}: ESPN connection blocked for league ${args.leagueId}`,
        );
        await ctx.scheduler.runAfter(0, internal.aiContent.generateContentAction, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          seasonId: args.seasonId,
          week: args.week,
          creditsDeductedUpFront: args.creditsDeductedUpFront,
        });
        return;
      }

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
          creditsDeductedUpFront: args.creditsDeductedUpFront,
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
        // The article's writer. Sam Ortega conducts the interview either way, but the
        // writer's relationship with this manager shapes which follow-up she asks.
        writerPersona: args.persona,
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
        creditsDeductedUpFront: args.creditsDeductedUpFront,
      });

      // Silence is consent (spec §8.1): whatever the manager left `pending` becomes
      // approved the moment we go to print. Scheduled just before checkAndGenerate,
      // and re-run inside it as a safety net for an early "Go to print now".
      await ctx.scheduler.runAt(
        args.articleGenerationTime,
        internal.commentConversations.autoApprovePendingQuotes,
        { commentRequestIds }
      );

      // Also schedule periodic checks to see if all responses are collected
      const now = Date.now();
      const timeUntilGeneration = args.articleGenerationTime - now;
      for (let i = 1; i <= 4; i++) {
        const checkTime = now + (timeUntilGeneration / 4) * i;
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
          creditsDeductedUpFront: args.creditsDeductedUpFront,
        });
      }

      // Two reminders to whoever still hasn't answered (spec §5): one at the halfway
      // mark, one 30 minutes before print. `sendCommentReminder` no-ops for requests
      // that are already answered, declined or expired, so nobody gets chased twice.
      const halfway = now + timeUntilGeneration / 2;
      const lastCall = args.articleGenerationTime - 30 * 60 * 1000;
      for (const requestId of commentRequestIds) {
        if (halfway > now) {
          await ctx.scheduler.runAt(halfway, internal.notifications.sendCommentReminder, {
            commentRequestId: requestId,
            type: "reminder",
          });
        }
        // Skipped for short windows, where the halfway nudge is already the last call.
        if (lastCall > halfway) {
          await ctx.scheduler.runAt(lastCall, internal.notifications.sendCommentReminder, {
            commentRequestId: requestId,
            type: "final_reminder",
          });
        }
      }

    } catch (error) {
      console.error("Error in createCommentRequestsAndWait:", error);

      // If credits were deducted up front (createGenerationWithComments),
      // refund them now - the user paid for content that was never even
      // queued for generation. Captured rather than swallowed: a refund
      // failure is logged loudly rather than dropped, matching
      // generateContentAction's refund-on-failure handling.
      if (args.creditsDeductedUpFront) {
        try {
          let creditUserId = args.userId;
          if (creditUserId === "system") {
            const league = await ctx.runQuery(internal.contentScheduling.getLeagueById, {
              leagueId: args.leagueId,
            });
            if (league?.commissionerUserId) {
              creditUserId = league.commissionerUserId;
            }
          }

          if (creditUserId !== "system") {
            await ctx.runMutation(internal.credits.refundCredits, {
              userId: creditUserId,
              amount: args.creditsDeductedUpFront,
              description: `Refund: failed AI content generation (${args.contentType})`,
              leagueId: args.leagueId,
              relatedContentId: args.articleId,
            });
          }
        } catch (e) {
          console.error("Failed to refund credits after comment-request creation failure:", e);
        }
      }

      // Update article status to failed
      await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
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
    // The writer the quotes are destined for (spec §5); the interviewer is always Sam.
    writerPersona: v.optional(v.string()),
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
          interviewerPersona: INTERVIEWER_PERSONA,
          writerPersona: args.writerPersona ?? DEFAULT_WRITER_PERSONA,
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
      const aiResult = await ctx.runAction(internal.aiNode.generateConversationQuestion, { context });
      
      console.log(`Generated initial question for user ${request.targetUserId}`);
      
      // Create the initial AI message
      await ctx.runMutation(internal.commentConversations.createAIMessage, {
        commentRequestId: args.commentRequestId,
        content: aiResult.question,
        messageType: "ai_question",
        aiMetadata: {
          generationModel: "claude-opus-5",
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
      
      // Two nudges for a manager who has not answered (spec §5); `sendReminder` re-checks.
      const reminders = reminderTimes(Date.now(), request.articleGenerationTime);
      if (reminders.halfway) {
        await ctx.scheduler.runAt(reminders.halfway, internal.commentRequests.sendReminder, {
          commentRequestId: args.commentRequestId,
          final: false,
        });
      }
      if (reminders.final) {
        await ctx.scheduler.runAt(reminders.final, internal.commentRequests.sendReminder, {
          commentRequestId: args.commentRequestId,
          final: true,
        });
      }

      // Send notification to user
      await ctx.scheduler.runAfter(0, internal.notifications.sendCommentRequest, {
        userId: request.targetUserId,
        commentRequestId: args.commentRequestId,
        message: aiResult.question,
        articleType: request.contentType,
        leagueName: context.leagueName || "your league",
        leagueId: request.leagueId,
        writerPersona: request.writerPersona,
        week: request.articleContext?.week ?? context.week,
        deadline: request.articleGenerationTime,
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
    creditsDeductedUpFront: v.optional(v.number()),
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

      // Going to print early still means going to print: anything the manager left
      // pending is approved now (spec §8.1). Without this, an article generated
      // before the deadline would carry no quotes at all, because
      // `getStructuredCommentResponses` only prints approved or edited entries.
      await ctx.runMutation(internal.commentConversations.autoApprovePendingQuotes, {
        commentRequestIds: args.commentRequestIds,
      });

      // Update article status immediately to prevent other scheduled checks from running
      await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
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
        creditsDeductedUpFront: args.creditsDeductedUpFront,
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
    creditsDeductedUpFront: v.optional(v.number()),
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

    // Deadline reached: every quote still awaiting the manager's sign-off is
    // approved (spec §8.1). The scheduled pass at articleGenerationTime normally
    // does this; running it here too covers "Go to print now", which arrives early.
    await ctx.runMutation(internal.commentConversations.autoApprovePendingQuotes, {
      commentRequestIds: args.commentRequestIds,
    });

    // A manager who replied but whose interview never formally closed (Sam's close
    // went unanswered, or a follow-up step failed) still gets their words in: build
    // their response row before the requests are closed out.
    for (const commentRequestId of args.commentRequestIds) {
      await ctx.runAction(internal.commentConversations.processCompletedResponse, { commentRequestId });
    }

    // Then close out every request still open for this article
    await ctx.runMutation(internal.aiContentWithComments.expireCommentRequests, {
      commentRequestIds: args.commentRequestIds,
    });

    // Update article status immediately to prevent other scheduled checks from running
    await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
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
      creditsDeductedUpFront: args.creditsDeductedUpFront,
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
    creditsDeductedUpFront: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // The quote ledger: one entry per manager, carrying their name, their team, what
    // Sam asked, and the verbatim spans they may be quoted saying.
    //
    // This replaces the old `Team Comment: "..."` string-mashing into customContext,
    // which stripped every attribution and then asked the writer for a named quote -
    // an instruction the model could only satisfy by inventing one. customContext is
    // now left exactly as the requester wrote it (spec §5).
    const commentResponses = await ctx.runQuery(
      internal.aiContentWithComments.getStructuredCommentResponses,
      { commentRequestIds: args.commentRequestIds }
    );

    const nonRespondents = await ctx.runQuery(
      internal.aiContentWithComments.getNonRespondents,
      { commentRequestIds: args.commentRequestIds }
    );

    console.log(
      `Generating with ${commentResponses.length} quoted managers and ${nonRespondents.length} non-respondents`
    );

    await ctx.runAction(internal.aiContent.generateContentAction, {
      articleId: args.articleId,
      leagueId: args.leagueId,
      contentType: args.contentType,
      persona: args.persona,
      customContext: args.customContext,
      userId: args.userId,
      seasonId: args.seasonId,
      week: args.week,
      commentResponses,
      nonRespondents,
      creditsDeductedUpFront: args.creditsDeductedUpFront,
    });
  },
});

/**
 * `CommentResponseData[]` (spec §4.2) for the writer: joined manager name, team id and
 * name, the question topic, and verbatim quotes. Quote selection - approved/edited
 * review entries first, withdrawn never - is `quotesForResponse` above (spec §8.1).
 */
export const getStructuredCommentResponses = internalQuery({
  args: { commentRequestIds: v.array(v.id("commentRequests")) },
  returns: v.array(commentResponseDataValidator),
  handler: async (ctx, args) => {
    const results = [];

    for (const requestId of args.commentRequestIds) {
      const request = await ctx.db.get(requestId);
      if (!request) continue;

      const response = await ctx.db
        .query("commentResponses")
        .withIndex("by_comment_request", q => q.eq("commentRequestId", requestId))
        .first();
      if (!response) continue;

      const league = await ctx.db.get(request.leagueId);
      const seasonId = request.articleContext.seasonId ?? leagueCurrentSeason(league);

      const user = await ctx.db.get(request.targetUserId);
      const team = await teamForUser(ctx, request.leagueId, user, seasonId);

      // What Sam opened with, so the writer can print the question when the answer
      // is surprising rather than guessing at the premise.
      const messages = await ctx.db
        .query("commentConversations")
        .withIndex("by_comment_request_order", q => q.eq("commentRequestId", requestId))
        .collect();
      const opener = messages.find(m => m.messageType === "ai_question");

      const quotes = quotesForResponse(response);
      // Everything withdrawn: the manager took it all back. Sending an entry with
      // no quotes would ask the writer to attribute silence to a named speaker.
      if (quotes.length === 0) continue;

      results.push({
        userId: request.targetUserId as string,
        userName: user?.name ?? user?.email ?? "Unknown manager",
        teamId: (team?._id ?? "") as string,
        teamName: team?.name ?? "Unclaimed team",
        questionTopic: questionTopicFrom(
          opener?.content,
          request.articleContext.topic ??
            `${request.contentType.replace(/_/g, " ")}${request.articleContext.week ? `, week ${request.articleContext.week}` : ""}`
        ),
        quotes,
        rawResponse: response.rawResponse,
      });
    }

    return results;
  },
});

/**
 * Managers who were asked and said nothing printable (spec §4.2). The writer may report
 * the silence with the two sanctioned phrases and may never turn it into a quote.
 */
export const getNonRespondents = internalQuery({
  args: { commentRequestIds: v.array(v.id("commentRequests")) },
  returns: v.array(nonRespondentValidator),
  handler: async (ctx, args) => {
    const results = [];

    for (const requestId of args.commentRequestIds) {
      const request = await ctx.db.get(requestId);
      if (!request) continue;
      if (
        request.status !== "declined" &&
        request.status !== "expired" &&
        request.status !== "pending" &&
        request.status !== "active"
      ) {
        continue;
      }

      // A response row means they spoke, whatever the request status ended up as.
      const response = await ctx.db
        .query("commentResponses")
        .withIndex("by_comment_request", q => q.eq("commentRequestId", requestId))
        .first();
      if (response) continue;

      const league = await ctx.db.get(request.leagueId);
      const seasonId = request.articleContext.seasonId ?? leagueCurrentSeason(league);
      const user = await ctx.db.get(request.targetUserId);
      const team = await teamForUser(ctx, request.leagueId, user, seasonId);

      results.push({
        userId: request.targetUserId as string,
        userName: user?.name ?? user?.email ?? "Unknown manager",
        teamName: team?.name ?? "Unclaimed team",
        status: (request.status === "declined" ? "declined" : "no_response") as
          | "declined"
          | "no_response",
      });
    }

    return results;
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

/**
 * Are we done waiting? Partial responses are the normal case, not a failure.
 *
 * A request is resolved when the manager answered, declined, or let it expire
 * (spec §5). Previously every request needed a response row, so one silent manager
 * forfeited early generation for the whole league.
 */
export const checkAllResponsesReceived = internalQuery({
  args: { commentRequestIds: v.array(v.id("commentRequests")) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    for (const requestId of args.commentRequestIds) {
      const request = await ctx.db.get(requestId);
      if (!request) continue;

      if (
        request.status === "declined" ||
        request.status === "expired" ||
        request.status === "cancelled"
      ) {
        continue;
      }

      // Check if there's a response for this request
      const response = await ctx.db
        .query("commentResponses")
        .withIndex("by_comment_request", q => q.eq("commentRequestId", requestId))
        .first();

      if (!response) {
        return false; // Still waiting on at least one manager
      }
    }

    return true; // Every request is answered or closed
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

/* -------------------------------------------------------------------------- */
/* Requester board (spec §8.2)                                                 */
/* -------------------------------------------------------------------------- */

const boardRequestStatusValidator = v.union(
  v.literal("answered"),
  v.literal("waiting"),
  v.literal("declined"),
  v.literal("no_response")
);

/** Every comment request raised for one manually generated article. */
async function requestsForArticle(
  ctx: QueryCtx,
  articleId: Id<"aiContent">
): Promise<Array<Doc<"commentRequests">>> {
  return await ctx.db
    .query("commentRequests")
    .withIndex("by_manual_content", q => q.eq("manualContentId", articleId))
    .collect();
}

/**
 * "3 of 6 responded": who was asked, who answered, and when we go to print.
 * Any member of the league may watch the board; only the commissioner or the
 * requester may act on it (`goToPrintNow`).
 */
export const getCommentRequestBoard = query({
  args: { articleId: v.id("aiContent") },
  returns: v.object({
    deadline: v.number(),
    status: v.string(),
    requests: v.array(
      v.object({
        commentRequestId: v.id("commentRequests"),
        managerName: v.string(),
        teamName: v.string(),
        status: boardRequestStatusValidator,
      })
    ),
  }),
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) throw new Error("Article not found");
    await requireLeagueMember(ctx, article.leagueId);

    const requests = await requestsForArticle(ctx, args.articleId);
    const league = await ctx.db.get(article.leagueId);
    const seasonId =
      article.commentRequestConfig?.seasonId ?? leagueCurrentSeason(league);

    const rows = [];
    for (const request of requests) {
      if (request.status === "cancelled") continue;

      const response = await ctx.db
        .query("commentResponses")
        .withIndex("by_comment_request", q => q.eq("commentRequestId", request._id))
        .first();

      const user = await ctx.db.get(request.targetUserId);
      const team = await teamForUser(ctx, article.leagueId, user, seasonId);

      // A response row is the only proof they spoke, whatever the request status
      // ended up as - expiry can land after a manager has already answered.
      const status: "answered" | "waiting" | "declined" | "no_response" = response
        ? "answered"
        : request.status === "declined"
        ? "declined"
        : request.status === "expired"
        ? "no_response"
        : "waiting";

      rows.push({
        commentRequestId: request._id,
        managerName: user?.name ?? user?.email ?? "Unknown manager",
        teamName: team?.name ?? "Unclaimed team",
        status,
      });
    }

    rows.sort((a, b) => a.teamName.localeCompare(b.teamName));

    return {
      deadline:
        article.commentRequestConfig?.articleGenerationTime ??
        requests[0]?.articleGenerationTime ??
        0,
      status: article.status,
      requests: rows,
    };
  },
});

/**
 * Print early (spec §8.2). Runs the deadline now instead of waiting for it.
 *
 * This mutation deliberately writes nothing itself: `checkAndGenerate` owns the
 * whole transition (auto-approve quotes, expire the open requests, flip the article
 * to `generating`, generate), so an early print and the scheduled deadline take the
 * exact same path. Its arguments come from what the flow stored on the article, never
 * from the caller. Idempotent: an article that is no longer waiting schedules nothing.
 *
 * Auth: the league's commissioner, or the manager who requested the article -
 * matched through `users.by_clerk_id` on both sides rather than on a raw subject.
 */
export const goToPrintNow = mutation({
  args: { articleId: v.id("aiContent") },
  returns: v.object({ scheduled: v.boolean() }),
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) throw new Error("Article not found");

    const { identity, membership } = await requireLeagueMember(ctx, article.leagueId);

    const config = article.commentRequestConfig;
    let isRequester = false;
    if (config?.userId) {
      const caller = await userByClerkId(ctx, identity.subject);
      const requester = await userByClerkId(ctx, config.userId);
      isRequester = !!caller && !!requester && caller._id === requester._id;
    }
    if (membership.role !== "commissioner" && !isRequester) {
      // Throws with the standard commissioner message.
      await requireCommissioner(ctx, article.leagueId);
    }

    if (article.status !== "waiting_for_comments") {
      return { scheduled: false };
    }

    // Preferred over a stored id list: the index is the record of what was
    // actually created, so it can't drift from the requests themselves.
    const commentRequestIds = (await requestsForArticle(ctx, args.articleId)).map(
      r => r._id
    );

    const league = await ctx.db.get(article.leagueId);

    await ctx.scheduler.runAfter(0, internal.aiContentWithComments.checkAndGenerate, {
      articleId: article._id,
      leagueId: article.leagueId,
      contentType: article.type,
      persona: article.persona,
      customContext: config?.customContext,
      userId: config?.userId ?? league?.commissionerUserId ?? "system",
      seasonId: config?.seasonId,
      week: config?.week ?? article.metadata.week,
      commentRequestIds,
      creditsDeductedUpFront: config?.creditsDeductedUpFront,
    });

    return { scheduled: true };
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
      
      // Only close requests that are still pending or active
      if (request.status === "pending" || request.status === "active") {
        // A manager who spoke goes to print with what they gave us; only a request
        // nobody answered is "expired" (same rule as commentRequests.expireRequest).
        const response = await ctx.db
          .query("commentResponses")
          .withIndex("by_comment_request", q => q.eq("commentRequestId", requestId))
          .first();
        const now = Date.now();
        if (response) {
          // Silence is consent (spec §8.1): approve whatever is still pending at print.
          if (response.quoteReview?.some(q => q.status === "pending")) {
            await ctx.db.patch(response._id, {
              quoteReview: response.quoteReview.map(q => (q.status === "pending" ? { ...q, status: "approved" as const } : q)),
              updatedAt: now,
            });
          }
          await ctx.db.patch(requestId, {
            status: "completed",
            conversationState: "response_complete",
            completedAt: now,
            updatedAt: now,
          });
        } else {
          await ctx.db.patch(requestId, {
            status: "expired",
            conversationState: "auto_ended",
            expiredAt: now,
            updatedAt: now,
          });
        }

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
          content: response
            ? "We're at the deadline - going to print with what you gave us. Thanks."
            : "This comment request has expired. The article has been generated without your input.",
          messageOrder: existingMessages.length,
          isRead: false,
          createdAt: now,
          threadDepth: 0,
        });

        console.log(`${response ? "Completed" : "Expired"} comment request ${requestId} at the deadline`);
      }
    }
  },
});