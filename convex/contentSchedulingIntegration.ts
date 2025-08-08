import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// Integration hook to create comment requests when content is scheduled
export const onContentScheduled = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    scheduledTime: v.number(),
  },
  handler: async (ctx, args) => {
    console.log("Content scheduled, creating comment requests:", {
      contentType: args.contentType,
      scheduledTime: new Date(args.scheduledTime).toISOString(),
    });

    // Determine if this content type should have comment requests
    const commentEnabledTypes = [
      "weekly_recap",
      "trade_analysis",
      "waiver_wire_report",
      "power_rankings",
      "championship_manifesto",
    ];

    if (!commentEnabledTypes.includes(args.contentType)) {
      console.log(`Content type ${args.contentType} does not support comment requests`);
      return;
    }

    // Get active league members to request comments from
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => 
        q.eq("leagueId", args.leagueId)
      )
      .filter(q => q.neq(q.field("owner"), null))
      .collect();

    if (teams.length === 0) {
      console.log("No active teams found for comment requests");
      return;
    }

    // Select users for comment requests based on content type
    // Convert owner clerkIds to user IDs
    const ownerClerkIds = teams
      .filter(team => team.owner !== null)
      .map(team => team.owner);
      
    const users = await Promise.all(
      ownerClerkIds.map(async (clerkId) => {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", q => q.eq("clerkId", clerkId))
          .unique();
        return user?._id;
      })
    );
    
    let targetUserIds = users.filter(id => id !== undefined) as Id<"users">[];

    // For weekly recaps, prioritize teams that played that week
    if (args.contentType === "weekly_recap") {
      // Get the scheduled content to check the week
      const scheduledContent = await ctx.db.get(args.scheduledContentId);
      if (scheduledContent?.contextData?.week) {
        const week = scheduledContent.contextData.week;
        
        // Get matchups for that week
        const matchups = await ctx.db
          .query("matchups")
          .withIndex("by_league_period", q => 
            q.eq("leagueId", args.leagueId)
             .eq("matchupPeriod", week)
          )
          .collect();

        // Prioritize teams that played
        const playingTeamIds = new Set<string>();
        matchups.forEach(m => {
          playingTeamIds.add(m.homeTeamId);
          playingTeamIds.add(m.awayTeamId);
        });

        // Filter to get users who played
        const playingTeams = teams.filter(t => 
          t.externalId && playingTeamIds.has(t.externalId) && t.owner
        );

        if (playingTeams.length > 0) {
          // Convert playing team owners to user IDs
          const playingOwnerClerkIds = playingTeams.map(t => t.owner);
          const playingUsers = await Promise.all(
            playingOwnerClerkIds.map(async (clerkId) => {
              const user = await ctx.db
                .query("users")
                .withIndex("by_clerk_id", q => q.eq("clerkId", clerkId))
                .unique();
              return user?._id;
            })
          );
          targetUserIds = playingUsers.filter(id => id !== undefined) as Id<"users">[];
        }
      }
    }

    // For trade analysis, only request from teams involved in recent trades
    if (args.contentType === "trade_analysis") {
      // This would need more sophisticated logic to identify trade participants
      // For now, take top 4 most active teams
      targetUserIds = targetUserIds.slice(0, 4);
    }

    // Limit number of requests based on content type
    const maxRequests = {
      weekly_recap: 8,
      trade_analysis: 4,
      waiver_wire_report: 6,
      power_rankings: 5,
      championship_manifesto: 2,
    };

    const limit = maxRequests[args.contentType as keyof typeof maxRequests] || 5;
    targetUserIds = targetUserIds.slice(0, limit);

    console.log(`Creating comment requests for ${targetUserIds.length} users`);

    // Schedule comment request creation
    await ctx.scheduler.runAfter(0, internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: args.scheduledContentId,
      targetUserIds,
      requestTimeBeforeGeneration: getRequestTimeOffset(args.contentType),
    });
  },
});

// Helper function (moved outside of the mutation object)
function getRequestTimeOffset(contentType: string): number {
  // Different content types need different lead times
  const offsets = {
    weekly_recap: 12 * 60 * 60 * 1000,        // 12 hours
    trade_analysis: 2 * 60 * 60 * 1000,       // 2 hours (more immediate)
    waiver_wire_report: 6 * 60 * 60 * 1000,   // 6 hours
    power_rankings: 24 * 60 * 60 * 1000,      // 24 hours
    championship_manifesto: 48 * 60 * 60 * 1000, // 48 hours (more time for important content)
  };

  return offsets[contentType as keyof typeof offsets] || 12 * 60 * 60 * 1000;
}

// Update the existing processScheduledContent to include comment response integration
export const integrateCommentResponses = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
  },
  handler: async (ctx, args) => {
    console.log("Integrating comment responses for scheduled content:", args.scheduledContentId);

    // Get all completed comment responses for this content
    const commentResponses = await ctx.db
      .query("commentResponses")
      .withIndex("by_scheduled_content", q => 
        q.eq("scheduledContentId", args.scheduledContentId)
      )
      .filter(q => q.eq(q.field("integrationStatus"), "pending"))
      .collect();

    if (commentResponses.length === 0) {
      console.log("No comment responses to integrate");
      return { integrated: 0 };
    }

    // Get high-quality responses
    const qualityResponses = commentResponses
      .filter(r => 
        r.relevanceMetadata.qualityScore >= 60 &&
        r.relevanceMetadata.usabilityRating !== "unusable"
      )
      .sort((a, b) => b.relevanceMetadata.qualityScore - a.relevanceMetadata.qualityScore);

    console.log(`Found ${qualityResponses.length} quality responses out of ${commentResponses.length} total`);

    // Mark selected responses as integrated
    const selectedResponses = qualityResponses.slice(0, 5); // Top 5 responses
    
    for (const response of selectedResponses) {
      await ctx.db.patch(response._id, {
        integrationStatus: "selected",
        updatedAt: Date.now(),
      });
    }

    // Store integration metadata on the scheduled content
    const scheduledContent = await ctx.db.get(args.scheduledContentId);
    if (scheduledContent) {
      await ctx.db.patch(args.scheduledContentId, {
        contextData: {
          ...scheduledContent.contextData,
          additionalContext: {
            ...scheduledContent.contextData?.additionalContext,
            commentResponsesIntegrated: selectedResponses.length,
            commentResponseIds: selectedResponses.map(r => r._id),
          },
        },
      });
    }

    return { 
      integrated: selectedResponses.length,
      total: commentResponses.length,
    };
  },
});