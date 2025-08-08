import { v } from "convex/values";
import { mutation, query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ConversationContext, conversationService } from "../src/lib/ai/conversation-service";

// Create comment requests for scheduled content
export const createRequestsForScheduledContent = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    targetUserIds: v.array(v.id("users")),
    requestTimeBeforeGeneration: v.optional(v.number()), // milliseconds before content generation
  },
  handler: async (ctx, args) => {
    const scheduledContent = await ctx.db.get(args.scheduledContentId);
    if (!scheduledContent) throw new Error("Scheduled content not found");

    const league = await ctx.db.get(scheduledContent.leagueId);
    if (!league) throw new Error("League not found");

    // Default to 12 hours before generation
    const requestTimeOffset = args.requestTimeBeforeGeneration || 12 * 60 * 60 * 1000;
    const expirationTimeOffset = 15 * 60 * 1000; // 15 minutes before generation

    const scheduledSendTime = scheduledContent.scheduledFor - requestTimeOffset;
    const expirationTime = scheduledContent.scheduledFor - expirationTimeOffset;
    const currentTime = Date.now();

    // Create a request for each target user
    const requestIds = await Promise.all(
      args.targetUserIds.map(async (userId) => {
        // Check if request already exists
        const existing = await ctx.db
          .query("commentRequests")
          .withIndex("by_scheduled_content", q => 
            q.eq("scheduledContentId", args.scheduledContentId)
          )
          .filter(q => q.eq(q.field("targetUserId"), userId))
          .first();

        if (existing) {
          console.log(`Comment request already exists for user ${userId}`);
          return existing._id;
        }

        // Get user's team for context  
        const userTeam = await ctx.db
          .query("teams")
          .withIndex("by_league", q => 
            q.eq("leagueId", scheduledContent.leagueId)
          )
          .filter(q => q.eq(q.field("owner"), userId))
          .first();

        // Determine priority based on user activity
        let priority: "high" | "medium" | "low" = "medium";
        if (userTeam && (userTeam.record.wins + userTeam.record.losses) > 10) {
          priority = "high"; // Active player
        }

        const requestId = await ctx.db.insert("commentRequests", {
          leagueId: scheduledContent.leagueId,
          scheduledContentId: args.scheduledContentId,
          targetUserId: userId,
          contentType: scheduledContent.contentType,
          articleContext: {
            week: scheduledContent.contextData?.week,
            seasonId: scheduledContent.contextData?.seasonId,
            topic: `Week ${scheduledContent.contextData?.week} ${scheduledContent.contentType.replace('_', ' ')}`,
            focusAreas: ["team performance", "player decisions"], // Static for now
          },
          status: "pending",
          scheduledSendTime,
          expirationTime,
          articleGenerationTime: scheduledContent.scheduledFor,
          conversationState: "not_started",
          aiContext: {
            initialPrompt: "",
            conversationGoals: ["gather team insights", "get player reactions"],
            currentFocus: scheduledContent.contentType,
          },
          autoEndCriteria: {
            maxMessages: 8,
            currentMessageCount: 0,
            minResponseLength: 30,
            lastActivityTime: currentTime,
            inactivityTimeoutMinutes: 30,
          },
          priority,
          notificationsSent: [],
          createdAt: currentTime,
          updatedAt: currentTime,
        });

        return requestId;
      })
    );

    console.log(`Created ${requestIds.length} comment requests for scheduled content ${args.scheduledContentId}`);

    // Schedule the initial send time if it's in the future
    if (scheduledSendTime > currentTime) {
      await ctx.scheduler.runAt(scheduledSendTime, internal.commentRequests.sendInitialRequests, {
        scheduledContentId: args.scheduledContentId,
      });
    } else {
      // Send immediately if time has passed
      await ctx.scheduler.runAfter(0, internal.commentRequests.sendInitialRequests, {
        scheduledContentId: args.scheduledContentId,
      });
    }

    return requestIds;
  },
});

// Missing internal functions that are being called
export const getPendingRequestsForContent = internalQuery({
  args: { scheduledContentId: v.id("scheduledContent") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commentRequests")
      .withIndex("by_scheduled_content", q => 
        q.eq("scheduledContentId", args.scheduledContentId)
      )
      .filter(q => q.eq(q.field("status"), "pending"))
      .collect();
  },
});

export const buildConversationContext = internalQuery({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return null;

    const league = await ctx.db.get(request.leagueId);
    const targetSeason = request.articleContext.seasonId || league?.espnData?.seasonId || 0;
    const week = request.articleContext.week || 0;

    // Resolve user's team via teamClaims first (uses Clerk ID), then fall back to any season's team
    const user = await ctx.db.get(request.targetUserId);
    let team = null as any;
    let teamExternalId: string | null = null;

    if (user?.clerkId) {
      const claims = await ctx.db
        .query("teamClaims")
        .withIndex("by_user", q => q.eq("userId", user.clerkId))
        .collect();
      const claimForLeagueAny = claims.find(c => c.leagueId === request.leagueId);
      if (claimForLeagueAny) {
        const claimedTeam = await ctx.db.get(claimForLeagueAny.teamId);
        if (claimedTeam) {
          teamExternalId = claimedTeam.externalId;
          // Resolve the specific season team by externalId
          const seasonTeam = await ctx.db
            .query("teams")
            .withIndex("by_external", q =>
              q.eq("leagueId", request.leagueId)
               .eq("externalId", claimedTeam.externalId)
               .eq("seasonId", targetSeason)
            )
            .first();
          team = seasonTeam || claimedTeam;
        }
      }
    }

    if (!team) {
      // Try to find any team for user by display name match as a last resort
      const possibleTeams = await ctx.db
        .query("teams")
        .withIndex("by_league", q => q.eq("leagueId", request.leagueId))
        .collect();
      team = possibleTeams.find(t => t.owner === user?.name || t.ownerInfo?.displayName === user?.name) || null;
    }

    if (team) {
      teamExternalId = team.externalId;
    }

    // If still no externalId, try season-specific owner match (more precise)
    if (!teamExternalId) {
      const seasonTeams = await ctx.db
        .query("teams")
        .withIndex("by_season", q => q.eq("leagueId", request.leagueId).eq("seasonId", targetSeason))
        .collect();
      const found = seasonTeams.find(
        (t) => t.owner === user?.name || t.ownerInfo?.displayName === user?.name || t.ownerInfo?.id === user?.clerkId
      );
      if (found) {
        team = found;
        teamExternalId = found.externalId;
      }
    }

    // Prefer finding matchup by league + week (any season), then infer season from it
    const periodMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_period", q => q.eq("leagueId", request.leagueId).eq("matchupPeriod", week))
      .collect();

    const candidateMatches = periodMatchups.filter(
      (m) => teamExternalId && (m.homeTeamId === teamExternalId || m.awayTeamId === teamExternalId)
    );

    const currentLeagueSeason = league?.espnData?.seasonId || targetSeason;

    const hasNonZeroScore = (m: any) =>
      (m.homeScore && m.homeScore > 0) || (m.awayScore && m.awayScore > 0) ||
      (m.homeRoster?.appliedStatTotal && m.homeRoster.appliedStatTotal > 0) ||
      (m.awayRoster?.appliedStatTotal && m.awayRoster.appliedStatTotal > 0) ||
      (m.homePointsByScoringPeriod && typeof m.homePointsByScoringPeriod[String(week)] === 'number' && m.homePointsByScoringPeriod[String(week)] > 0) ||
      (m.awayPointsByScoringPeriod && typeof m.awayPointsByScoringPeriod[String(week)] === 'number' && m.awayPointsByScoringPeriod[String(week)] > 0);

    // Prefer matches with non-zero score, and with seasonId <= currentLeagueSeason, then highest seasonId
    let matchup = candidateMatches
      .filter(hasNonZeroScore)
      .sort((a, b) => (b.seasonId || 0) - (a.seasonId || 0))
      .find(m => (m.seasonId || 0) <= currentLeagueSeason) || null;

    if (!matchup && candidateMatches.length > 0) {
      matchup = candidateMatches.sort((a, b) => (b.seasonId || 0) - (a.seasonId || 0))[0];
    }

    // Fallback: use provided/league season if no direct match found
    if (!matchup) {
      const seasonMatchups = await ctx.db
        .query("matchups")
        .withIndex("by_league_season", q => q.eq("leagueId", request.leagueId).eq("seasonId", targetSeason))
        .collect();
      matchup = seasonMatchups.find(m => m.matchupPeriod === week && (!teamExternalId || m.homeTeamId === teamExternalId || m.awayTeamId === teamExternalId)) || null;
    }

    const seasonIdUsed = matchup?.seasonId ?? targetSeason;

    // Derive performance metrics
    let teamScore = 0;
    let projectedScore: number | undefined = undefined;
    let won = false;
    let underperformers: Array<{ player: string; position: string; expectedPts: number; actualPts: number; }> = [];
    let overperformers: Array<{ player: string; position: string; expectedPts: number; actualPts: number; }> = [];

    if (matchup && teamExternalId) {
      const isHome = matchup.homeTeamId === teamExternalId;
      teamScore = isHome ? matchup.homeScore : matchup.awayScore;
      const opponentScore = isHome ? matchup.awayScore : matchup.homeScore;
      projectedScore = isHome ? matchup.homeProjectedScore : matchup.awayProjectedScore;
      won = teamScore > opponentScore;

      const roster = isHome ? matchup.homeRoster : matchup.awayRoster;
      const players = roster?.players || [];

      // Score fallback if base score is 0 but period totals exist
      if ((!teamScore || teamScore === 0) && (isHome ? matchup.homePointsByScoringPeriod : matchup.awayPointsByScoringPeriod)) {
        const periodKey = String(week);
        const periodScore = (isHome ? matchup.homePointsByScoringPeriod : matchup.awayPointsByScoringPeriod)![periodKey];
        if (typeof periodScore === 'number' && periodScore > 0) {
          teamScore = periodScore;
        }
      }
      // Final fallback to roster applied totals
      if ((!teamScore || teamScore === 0) && roster?.appliedStatTotal) {
        teamScore = roster.appliedStatTotal;
      }

      underperformers = players
        .filter((p: any) => p.lineupSlotId !== 20 && p.projectedPoints && p.points < p.projectedPoints * 0.8)
        .map((p: any) => ({
          player: p.fullName,
          position: p.position,
          expectedPts: p.projectedPoints,
          actualPts: p.points,
        }))
        .sort((a, b) => (a.expectedPts - a.actualPts) - (b.expectedPts - b.actualPts))
        .slice(0, 3);

      overperformers = players
        .filter((p: any) => p.lineupSlotId !== 20 && p.projectedPoints && p.points > p.projectedPoints * 1.2)
        .map((p: any) => ({
          player: p.fullName,
          position: p.position,
          expectedPts: p.projectedPoints,
          actualPts: p.points,
        }))
        .sort((a, b) => (b.actualPts - b.expectedPts) - (a.actualPts - a.expectedPts))
        .slice(0, 3);
    }

    // Build standings for the given season
    const allTeams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => q.eq("leagueId", request.leagueId).eq("seasonId", seasonIdUsed))
      .collect();

    const standings = allTeams
      .sort((a, b) => (b.record.wins || 0) - (a.record.wins || 0))
      .map((t, idx) => ({
        teamId: t._id,
        teamName: t.name,
        rank: idx + 1,
        record: `${t.record.wins || 0}-${t.record.losses || 0}${t.record.ties ? `-${t.record.ties}` : ''}`,
      }));

    return {
      userId: request.targetUserId,
      leagueId: request.leagueId,
      scheduledContentId: request.scheduledContentId,
      contentType: request.contentType as "weekly_recap" | "trade_analysis" | "waiver_wire_report",
      week,
      seasonId: seasonIdUsed,
      leagueName: league?.name || "League",
      teamPerformance: {
        teamId: team?._id || request.targetUserId,
        teamName: team?.name || "Unknown Team",
        score: teamScore,
        projectedScore,
        won,
        underperformers,
        overperformers,
      },
      leagueContext: {
        standings,
      },
    };
  },
});

export const getActiveRequestsForContent = internalQuery({
  args: { scheduledContentId: v.id("scheduledContent") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commentRequests")
      .withIndex("by_scheduled_content", q => 
        q.eq("scheduledContentId", args.scheduledContentId)
      )
      .filter(q => q.eq(q.field("status"), "active"))
      .collect();
  },
});

// Helper functions (moved outside of the mutation object)
function getFocusAreas(contentType: string): string[] {
  switch (contentType) {
    case "weekly_recap":
      return ["team performance", "key decisions", "player disappointments", "lucky breaks"];
    case "trade_analysis":
      return ["trade rationale", "immediate impact", "future outlook", "negotiation process"];
    case "waiver_wire_report":
      return ["waiver priorities", "FAAB strategy", "missed opportunities", "sleeper picks"];
    default:
      return ["general thoughts", "key moments", "future plans"];
  }
}

function getConversationGoals(contentType: string): string[] {
  switch (contentType) {
    case "weekly_recap":
      return [
        "Get specific player performance reactions",
        "Understand key lineup decisions",
        "Capture emotional responses to outcomes",
        "Extract quotable insights about the week",
      ];
    case "trade_analysis":
      return [
        "Understand trade motivation",
        "Get both sides' perspectives",
        "Capture negotiation details",
        "Assess perceived winners/losers",
      ];
    default:
      return ["Gather relevant insights", "Get quotable content"];
  }
}

function getInitialFocus(contentType: string): string {
  switch (contentType) {
    case "weekly_recap":
      return "specific player performances and lineup decisions";
    case "trade_analysis":
      return "trade rationale and expected impact";
    case "waiver_wire_report":
      return "waiver strategy and priority targets";
    default:
      return "relevant insights for the article";
  }
}

// Send initial comment requests
export const sendInitialRequests = internalAction({
  args: {
    scheduledContentId: v.id("scheduledContent"),
  },
  handler: async (ctx, args) => {
    console.log("Sending initial comment requests for scheduled content:", args.scheduledContentId);

    // Get all pending requests for this content
    const requests = await ctx.runQuery(internal.commentRequests.getPendingRequestsForContent, {
      scheduledContentId: args.scheduledContentId,
    });

    console.log(`Found ${requests.length} pending requests to send`);

    // Process each request
    for (const request of requests) {
      try {
        // Get full context for AI generation
        const context = await ctx.runQuery(internal.commentRequests.buildConversationContext, {
          commentRequestId: request._id,
        });

        if (!context) {
          console.error(`Failed to build context for request ${request._id}`);
          continue;
        }

        // Generate initial AI question
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new Error("ANTHROPIC_API_KEY not configured");
        }

        const aiResult = await conversationService.generateConversationQuestion(context, apiKey);
        
        console.log(`Generated initial question for user ${request.targetUserId}:`, {
          confidence: aiResult.confidence,
          intent: aiResult.intent,
        });

        // Create the initial AI message
        await ctx.runMutation(internal.commentConversations.createAIMessage, {
          commentRequestId: request._id,
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
          commentRequestId: request._id,
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
          commentRequestId: request._id,
          message: aiResult.question,
          articleType: request.contentType,
          leagueName: context.leagueName || "your league",
          leagueId: request.leagueId,
        });

      } catch (error) {
        console.error(`Error processing request ${request._id}:`, error);
        // Continue with other requests
      }
    }

    // Schedule expiration check
    const scheduledContent = await ctx.runQuery(internal.contentScheduling.getById, {
      id: args.scheduledContentId,
    });
    
    if (scheduledContent && scheduledContent.scheduledFor) {
      const expirationTime = scheduledContent.scheduledFor - 15 * 60 * 1000; // 15 min before
      await ctx.scheduler.runAt(expirationTime, internal.commentRequests.expireOldRequests, {
        scheduledContentId: args.scheduledContentId,
      });
    }
  },
});

// Internal queries and mutations
export const getRequestsForLeague = query({
  args: {
    scheduledContentId: v.id("scheduledContent"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commentRequests")
      .withIndex("by_scheduled_content", q => 
        q.eq("scheduledContentId", args.scheduledContentId)
      )
      .filter(q => q.eq(q.field("status"), "pending"))
      .collect();
  },
});

export const getConversationContext = query({
  args: {
    commentRequestId: v.id("commentRequests"),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return null;

    const league = await ctx.db.get(request.leagueId);
    const seasonId = request.articleContext.seasonId || league?.espnData?.seasonId || 0;
    const week = request.articleContext.week || 0;

    // Resolve user's team via teamClaims (preferred) or fallback to any team with same externalId
    const user = await ctx.db.get(request.targetUserId);
    let team = null as any;
    let teamExternalId: string | null = null;

    if (user?.clerkId) {
      const claims = await ctx.db
        .query("teamClaims")
        .withIndex("by_user", q => q.eq("userId", user.clerkId))
        .collect();
      const claimForLeagueSeason = claims.find(c => c.leagueId === request.leagueId && c.seasonId === seasonId);
      const claimForLeagueAny = claimForLeagueSeason || claims.find(c => c.leagueId === request.leagueId);
      if (claimForLeagueAny) {
        team = await ctx.db.get(claimForLeagueAny.teamId);
      }
    }

    if (!team) {
      // Fallback: any team in this league matching the user's display name
      const possibleTeams = await ctx.db
        .query("teams")
        .withIndex("by_league", q => q.eq("leagueId", request.leagueId))
        .collect();
      team = possibleTeams.find(t => t.owner === user?.name || t.ownerInfo?.displayName === user?.name) || null;
    }

    if (team) {
      teamExternalId = team.externalId;
    }

    // If still no externalId, try season-specific owner match (more precise)
    if (!teamExternalId) {
      const seasonTeams = await ctx.db
        .query("teams")
        .withIndex("by_season", q => q.eq("leagueId", request.leagueId).eq("seasonId", seasonId))
        .collect();
      const found = seasonTeams.find(
        (t) => t.owner === user?.name || t.ownerInfo?.displayName === user?.name || t.ownerInfo?.id === user?.clerkId
      );
      if (found) {
        team = found;
        teamExternalId = found.externalId;
      }
    }

    if (!teamExternalId) return null;

    // Get matchup by season + week + team externalId
    const seasonMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", q => q.eq("leagueId", request.leagueId).eq("seasonId", seasonId))
      .collect();

    const candidates = seasonMatchups
      .filter(m => m.matchupPeriod === week && (m.homeTeamId === teamExternalId || m.awayTeamId === teamExternalId));
    const hasScore = (m: any) =>
      (m.homeScore && m.homeScore > 0) || (m.awayScore && m.awayScore > 0) ||
      (m.homeRoster?.appliedStatTotal && m.homeRoster.appliedStatTotal > 0) ||
      (m.awayRoster?.appliedStatTotal && m.awayRoster.appliedStatTotal > 0) ||
      (m.homePointsByScoringPeriod && typeof m.homePointsByScoringPeriod[String(week)] === 'number' && m.homePointsByScoringPeriod[String(week)] > 0) ||
      (m.awayPointsByScoringPeriod && typeof m.awayPointsByScoringPeriod[String(week)] === 'number' && m.awayPointsByScoringPeriod[String(week)] > 0);

    const matchup = candidates.find(hasScore) || candidates[0];

    if (!matchup) return null;

    // Determine if home or away
    const isHome = matchup.homeTeamId === teamExternalId;
    let teamScore = isHome ? matchup.homeScore : matchup.awayScore;
    const opponentScore = isHome ? matchup.awayScore : matchup.homeScore;
    const won = teamScore > opponentScore;

    // Get roster data
    const roster = isHome ? matchup.homeRoster : matchup.awayRoster;
    const players = roster?.players || [];

    // Score fallback if base score is 0 but period totals exist
    if ((!teamScore || teamScore === 0) && (isHome ? matchup.homePointsByScoringPeriod : matchup.awayPointsByScoringPeriod)) {
      const periodKey = String(week);
      const periodScore = (isHome ? matchup.homePointsByScoringPeriod : matchup.awayPointsByScoringPeriod)![periodKey];
      if (typeof periodScore === 'number' && periodScore > 0) {
        teamScore = periodScore;
      }
    }
    // Final fallback to roster applied totals
    if ((!teamScore || teamScore === 0) && roster?.appliedStatTotal) {
      teamScore = roster.appliedStatTotal;
    }

    // Find underperformers and overperformers
    const underperformers = players
      .filter((p: any) => p.lineupSlotId !== 20 && p.projectedPoints && p.points < p.projectedPoints * 0.8)
      .map((p: any) => ({
        player: p.fullName,
        position: p.position,
        expectedPts: p.projectedPoints,
        actualPts: p.points,
      }))
      .sort((a, b) => (a.expectedPts - a.actualPts) - (b.expectedPts - b.actualPts))
      .slice(0, 3);

    const overperformers = players
      .filter((p: any) => p.lineupSlotId !== 20 && p.projectedPoints && p.points > p.projectedPoints * 1.2)
      .map((p: any) => ({
        player: p.fullName,
        position: p.position,
        expectedPts: p.projectedPoints,
        actualPts: p.points,
      }))
      .sort((a, b) => (b.actualPts - b.expectedPts) - (a.actualPts - a.expectedPts))
      .slice(0, 3);

    // Get league standings for the season
    const allTeams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => 
        q.eq("leagueId", request.leagueId)
         .eq("seasonId", seasonId)
      )
      .collect();

    const standings = allTeams
      .sort((a, b) => (b.record.wins || 0) - (a.record.wins || 0))
      .map((t, idx) => ({
        teamId: t._id,
        teamName: t.name,
        rank: idx + 1,
        record: `${t.record.wins || 0}-${t.record.losses || 0}${t.record.ties ? `-${t.record.ties}` : ''}`,
      }));

    // Check playoff context
    const isPlayoffWeek = matchup.playoffTier !== undefined && matchup.playoffTier !== null;
    const userInPlayoffs = isPlayoffWeek && matchup.playoffTier === "WINNERS_BRACKET";

    const context: ConversationContext = {
      userId: request.targetUserId,
      leagueId: request.leagueId,
      scheduledContentId: request.scheduledContentId,
      contentType: request.contentType as any,
      week,
      seasonId,
      teamPerformance: {
        teamId: team?._id || request.targetUserId,
        teamName: team?.name || "Unknown Team",
        score: teamScore,
        projectedScore: isHome ? matchup.homeProjectedScore : matchup.awayProjectedScore,
        won,
        underperformers,
        overperformers,
      },
      leagueContext: {
        standings,
        playoffContext: isPlayoffWeek ? {
          isPlayoffWeek,
          userInPlayoffs,
          playoffImplications: userInPlayoffs 
            ? "Fighting for the championship" 
            : "Playing in consolation bracket",
        } : undefined,
      },
    };

    return context;
  },
});

export const updateRequestStatus = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    status: v.optional(v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("completed"),
      v.literal("expired"),
      v.literal("declined"),
      v.literal("cancelled")
    )),
    conversationState: v.optional(v.union(
      v.literal("not_started"),
      v.literal("initial_request_sent"),
      v.literal("follow_up_needed"),
      v.literal("gathering_details"),
      v.literal("response_complete"),
      v.literal("auto_ended")
    )),
    notificationSent: v.optional(v.object({
      type: v.union(
        v.literal("initial_request"),
        v.literal("reminder"),
        v.literal("follow_up"),
        v.literal("final_reminder")
      ),
      sentAt: v.number(),
      method: v.union(v.literal("app_notification"), v.literal("email")),
      delivered: v.boolean(),
    })),
  },
  handler: async (ctx, args) => {
    const updates: any = { updatedAt: Date.now() };
    
    if (args.status) updates.status = args.status;
    if (args.conversationState) updates.conversationState = args.conversationState;
    
    await ctx.db.patch(args.commentRequestId, updates);

    if (args.notificationSent) {
      const request = await ctx.db.get(args.commentRequestId);
      if (request) {
        await ctx.db.patch(args.commentRequestId, {
          notificationsSent: [...request.notificationsSent, args.notificationSent],
        });
      }
    }
  },
});

// Expire old requests that haven't received responses
export const expireOldRequests = internalAction({
  args: {
    scheduledContentId: v.id("scheduledContent"),
  },
  handler: async (ctx, args) => {
    const activeRequests = await ctx.runQuery(internal.commentRequests.getActiveRequestsForContent, {
      scheduledContentId: args.scheduledContentId,
    });

    for (const request of activeRequests) {
      await ctx.runMutation(internal.commentRequests.expireRequest, {
        commentRequestId: request._id,
      });
    }
  },
});

export const getActiveRequests = query({
  args: {
    scheduledContentId: v.id("scheduledContent"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("commentRequests")
      .withIndex("by_scheduled_content", q => 
        q.eq("scheduledContentId", args.scheduledContentId)
      )
      .filter(q => q.eq(q.field("status"), "active"))
      .collect();
  },
});

// Get a specific comment request by ID (any status) with light enrichment
export const getRequestById = query({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return null;

    const scheduledContent = await ctx.db.get(request.scheduledContentId);
    const league = await ctx.db.get(request.leagueId);

    return {
      ...request,
      scheduledTime: scheduledContent?.scheduledFor,
      leagueName: league?.name || "Unknown League",
    };
  },
});

export const expireRequest = internalMutation({
  args: {
    commentRequestId: v.id("commentRequests"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.commentRequestId, {
      status: "expired",
      conversationState: "auto_ended",
      expiredAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Add system message
    const messages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q => 
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    await ctx.db.insert("commentConversations", {
      commentRequestId: args.commentRequestId,
      leagueId: (await ctx.db.get(args.commentRequestId))!.leagueId,
      userId: (await ctx.db.get(args.commentRequestId))!.targetUserId,
      messageType: "system_message",
      content: "This comment request has expired. The article will be generated without your input.",
      messageOrder: messages.length,
      isRead: false,
      createdAt: Date.now(),
      threadDepth: 0,
    });
  },
});

// Get comment requests for a league
export const getLeagueCommentRequests = query({
  args: {
    leagueId: v.id("leagues"),
    status: v.optional(v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("completed"),
      v.literal("expired"),
      v.literal("declined"),
      v.literal("cancelled")
    )),
  },
  handler: async (ctx, args) => {
    let query = ctx.db
      .query("commentRequests")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId));

    if (args.status) {
      query = ctx.db
        .query("commentRequests")
        .withIndex("by_league_status", q => 
          q.eq("leagueId", args.leagueId)
           .eq("status", args.status!)
        );
    }

    const requests = await query.collect();

    // Enrich with user and content info
    return await Promise.all(
      requests.map(async (request) => {
        const user = await ctx.db.get(request.targetUserId);
        const scheduledContent = await ctx.db.get(request.scheduledContentId);
        
        return {
          ...request,
          userName: user?.name || "Unknown User",
          contentTitle: `${request.contentType} - Week ${request.articleContext.week}`,
        };
      })
    );
  },
});

// Admin function to manually trigger comment requests
export const triggerCommentRequests = mutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    userIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args) => {
    const scheduledContent = await ctx.db.get(args.scheduledContentId);
    if (!scheduledContent) throw new Error("Scheduled content not found");

    // Get target users if not specified
    let targetUserIds = args.userIds;
    if (!targetUserIds) {
      // Get all active users in the league
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_season", q => 
          q.eq("leagueId", scheduledContent.leagueId)
           .eq("seasonId", scheduledContent.contextData?.seasonId || 0)
        )
        .collect();
      
      // Convert owner clerkIds to user IDs
      const ownerClerkIds = teams
        .filter(t => t.owner)
        .map(t => t.owner)
        .slice(0, 5); // Limit to 5 users for testing
        
      const users = await Promise.all(
        ownerClerkIds.map(async (clerkId) => {
          const user = await ctx.db
            .query("users")
            .withIndex("by_clerk_id", q => q.eq("clerkId", clerkId))
            .unique();
          return user?._id;
        })
      );
      
      targetUserIds = users.filter(id => id !== undefined) as Id<"users">[];
    }

    await ctx.scheduler.runAfter(0, internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: args.scheduledContentId,
      targetUserIds,
      requestTimeBeforeGeneration: 60 * 60 * 1000, // 1 hour for manual triggers
    });

    return { success: true, userCount: targetUserIds.length };
  },
});