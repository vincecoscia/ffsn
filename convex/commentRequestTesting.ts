import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// ===============================
// TESTING FUNCTIONS
// ===============================

// Create test scheduled content for comment requests
export const createTestScheduledContent = mutation({
  args: {
    leagueId: v.id("leagues"),
    contentType: v.optional(v.string()),
    hoursFromNow: v.optional(v.number()),
    week: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const contentType = args.contentType || "weekly_recap";
    const scheduledTime = now + (args.hoursFromNow || 2) * 60 * 60 * 1000; // Default 2 hours from now
    const week = args.week || 12; // Default week 12

    // Create a dummy content schedule for the required field
    const contentScheduleId = await ctx.db.insert("contentSchedules", {
      leagueId: args.leagueId,
      contentType: "weekly_recap" as const,
      enabled: true,
      timezone: "America/New_York",
      schedule: {
        type: "weekly",
        dayOfWeek: 2, // Tuesday
        hour: 10, // 10 AM
        minute: 0,
      },
      preferredPersona: "default",
      createdAt: now,
      updatedAt: now,
    });

    // Create test scheduled content
    const scheduledContentId = await ctx.db.insert("scheduledContent", {
      leagueId: args.leagueId,
      contentScheduleId,
      contentType,
      scheduledFor: scheduledTime,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      contextData: {
        week,
        seasonId: 2024,
        additionalContext: {
          testMode: true,
          createdForTesting: true,
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    console.log(`Created test scheduled content: ${scheduledContentId} for ${contentType} at ${new Date(scheduledTime).toISOString()}`);

    return {
      scheduledContentId,
      contentType,
      scheduledTime: new Date(scheduledTime).toISOString(),
      week,
    };
  },
});

// Manually trigger comment requests for testing
export const triggerTestCommentRequests = mutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    targetUserIds: v.optional(v.array(v.id("users"))),
    requestTimeOffset: v.optional(v.number()), // milliseconds before generation
  },
  handler: async (ctx, args) => {
    const scheduledContent = await ctx.db.get(args.scheduledContentId);
    if (!scheduledContent) {
      throw new Error("Scheduled content not found");
    }

    // Get target users if not specified
    let targetUserIds = args.targetUserIds;
    let teams: any[] = [];
    
    if (!targetUserIds) {
      // Get users from teamClaims (which shows actual user ownership)
      const teamClaims = await ctx.db
        .query("teamClaims")
        .withIndex("by_league", q => q.eq("leagueId", scheduledContent.leagueId))
        .filter(q => q.eq(q.field("status"), "active"))
        .collect();
      
      console.log(`Found ${teamClaims.length} active team claims in league ${scheduledContent.leagueId}`);
      
      if (teamClaims.length === 0) {
        // Fallback: get any users and use the first few
        console.log("No active team claims found, falling back to any users");
        const fallbackUsers = await ctx.db.query("users").take(3);
        targetUserIds = fallbackUsers.map(u => u._id);
        console.log(`Using ${fallbackUsers.length} fallback users`);
      } else {
        // Get users from team claims (userId field contains Clerk user IDs)
        const claimedClerkIds = teamClaims
          .map(claim => claim.userId)
          .filter(userId => userId !== null && userId !== undefined)
          .slice(0, 3); // Limit to 3 for testing
        
        console.log(`Found ${claimedClerkIds.length} users with team claims:`, claimedClerkIds);
        
        // Look up users by their Clerk IDs
        const users = await Promise.all(
          claimedClerkIds.map(async (clerkId) => {
            try {
              const user = await ctx.db
                .query("users")
                .withIndex("by_clerk_id", q => q.eq("clerkId", clerkId))
                .unique();
              console.log(`Clerk ID ${clerkId}: ${user ? `found - ${user.name}` : 'not found'}`);
              return user;
            } catch (e) {
              console.log(`Clerk ID ${clerkId}: lookup error`);
              return null;
            }
          })
        );
        
        targetUserIds = users
          .filter(user => user !== null)
          .map(user => user!._id);
          
        console.log(`Found ${targetUserIds.length} valid users from team claims`);
        
        // If still no users found, try current authenticated user
        if (targetUserIds.length === 0) {
          console.log("No valid users from team claims, trying current authenticated user");
          const identity = await ctx.auth.getUserIdentity();
          if (identity) {
            const currentUser = await ctx.db
              .query("users")
              .withIndex("by_clerk_id", q => q.eq("clerkId", identity.subject))
              .unique();
            if (currentUser) {
              targetUserIds = [currentUser._id];
              console.log(`Using current authenticated user: ${currentUser.name}`);
            }
          }
        }
      }
    }

    if (targetUserIds.length === 0) {
      throw new Error(`No target users found. League has ${teams.length} teams. Check that teams have valid owner clerkIds and corresponding users exist.`);
    }

    // Schedule comment request creation
    await ctx.scheduler.runAfter(0, internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: args.scheduledContentId,
      targetUserIds,
      requestTimeBeforeGeneration: args.requestTimeOffset || 1000, // 1 second for immediate testing
    });

    return {
      success: true,
      targetUserCount: targetUserIds.length,
      targetUserIds,
      message: `Created comment requests for ${targetUserIds.length} users`,
    };
  },
});

// Get test status and results
export const getTestStatus = query({
  args: {
    scheduledContentId: v.optional(v.id("scheduledContent")),
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
    let requests;
    
    if (args.scheduledContentId) {
      requests = await ctx.db
        .query("commentRequests")
        .withIndex("by_scheduled_content", q => 
          q.eq("scheduledContentId", args.scheduledContentId!)
        )
        .collect();
    } else if (args.leagueId) {
      requests = await ctx.db
        .query("commentRequests")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId!))
        .collect();
    } else {
      // Get all recent requests (last 24 hours)
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      requests = await ctx.db
        .query("commentRequests")
        .filter(q => q.gte(q.field("createdAt"), oneDayAgo))
        .collect();
    }

    // Get conversation data for each request
    const requestsWithConversations = await Promise.all(
      requests.map(async (request) => {
        const messages = await ctx.db
          .query("commentConversations")
          .withIndex("by_comment_request", q => 
            q.eq("commentRequestId", request._id)
          )
          .collect();

        const user = await ctx.db.get(request.targetUserId);
        const scheduledContent = await ctx.db.get(request.scheduledContentId);
        const league = await ctx.db.get(request.leagueId);

        return {
          ...request,
          userName: user?.name || "Unknown User",
          userEmail: user?.email || "Unknown Email",
          contentType: scheduledContent?.contentType || request.contentType,
          leagueName: league?.name || "Unknown League",
          messageCount: messages.length,
          messages: messages.map(m => ({
            messageType: m.messageType,
            content: m.content.substring(0, 100) + (m.content.length > 100 ? "..." : ""),
            createdAt: new Date(m.createdAt).toISOString(),
          })),
        };
      })
    );

    // Get summary statistics
    const statusCounts = requests.reduce((acc, req) => {
      acc[req.status] = (acc[req.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const conversationStateCounts = requests.reduce((acc, req) => {
      acc[req.conversationState] = (acc[req.conversationState] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      summary: {
        totalRequests: requests.length,
        statusBreakdown: statusCounts,
        conversationStateBreakdown: conversationStateCounts,
        testRequestsFound: requests.filter(r => 
          r.articleContext?.topic?.includes("test") || 
          r.aiContext?.currentFocus?.includes("test")
        ).length,
      },
      requests: requestsWithConversations,
    };
  },
});

// Simulate user response for testing
export const simulateUserResponse = mutation({
  args: {
    commentRequestId: v.id("commentRequests"),
    response: v.string(),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) {
      throw new Error("Comment request not found");
    }

    // If userId provided, verify it matches the request
    if (args.userId && args.userId !== request.targetUserId) {
      throw new Error("User ID doesn't match request target");
    }

    // Get message count
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
      content: args.response,
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

    // Schedule AI response processing
    await ctx.scheduler.runAfter(100, internal.commentConversations.processUserResponse, {
      commentRequestId: args.commentRequestId,
      userMessageId: messageId,
    });

    return {
      success: true,
      messageId,
      messageCount: existingMessages.length + 1,
      response: args.response.substring(0, 100) + (args.response.length > 100 ? "..." : ""),
    };
  },
});

// Get available leagues and users for testing
export const getTestingData = query({
  args: {},
  handler: async (ctx, args) => {
    const leagues = await ctx.db
      .query("leagues")
      .take(10);

    const users = await ctx.db
      .query("users")
      .take(10);

    const recentScheduledContent = await ctx.db
      .query("scheduledContent")
      .order("desc")
      .take(5);

    // Get team count per league for debugging
    const leaguesWithTeamCounts = await Promise.all(
      leagues.map(async (league) => {
        const teams = await ctx.db
          .query("teams")
          .withIndex("by_league", q => q.eq("leagueId", league._id))
          .collect();
        
        // Get actual member count from teamClaims
        const teamClaims = await ctx.db
          .query("teamClaims")
          .withIndex("by_league", q => q.eq("leagueId", league._id))
          .filter(q => q.eq(q.field("status"), "active"))
          .collect();
        
        return {
          _id: league._id,
          name: league.name,
          memberCount: teamClaims.length, // Actual claimed teams count
          totalTeams: teams.length,
          claimedTeams: teamClaims.length,
          sampleClaims: teamClaims.slice(0, 3).map(claim => ({
            teamId: claim.teamId,
            userId: claim.userId,
            status: claim.status,
          })),
        };
      })
    );

    return {
      leagues: leaguesWithTeamCounts,
      users: users.map(u => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        clerkId: u.clerkId,
      })),
      recentScheduledContent: recentScheduledContent.map(sc => ({
        _id: sc._id,
        contentType: sc.contentType,
        scheduledFor: new Date(sc.scheduledFor).toISOString(),
        status: sc.status,
        leagueId: sc.leagueId,
      })),
    };
  },
});

// Debug function to check data relationships
export const debugLeagueData = query({
  args: {
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
      .collect();

    // Get team claims (this is the correct way to find user ownership)
    const teamClaims = await ctx.db
      .query("teamClaims")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
      .collect();
    
    const activeTeamClaims = teamClaims.filter(claim => claim.status === "active");
    
    // Get all users to see what exists
    const allUsers = await ctx.db.query("users").collect();
    
    // Check team claims and user relationships
    const teamClaimLookups = await Promise.all(
      activeTeamClaims.slice(0, 5).map(async (claim) => {
        const team = teams.find(t => t._id === claim.teamId);
        let user = null;
        try {
          // claim.userId is a Clerk ID, not a Convex user ID
          user = await ctx.db
            .query("users")
            .withIndex("by_clerk_id", q => q.eq("clerkId", claim.userId))
            .unique();
        } catch (e) {
          // Lookup error
        }
        
        return {
          teamName: team?.name || "Unknown Team",
          teamId: claim.teamId,
          userId: claim.userId, // This is actually a Clerk ID
          userName: user?.name || "User not found",
          userExists: !!user,
          claimStatus: claim.status,
        };
      })
    );

    return {
      league: {
        _id: league?._id,
        name: league?.name,
      },
      teams: {
        total: teams.length,
        sample: teams.slice(0, 3).map(t => ({
          _id: t._id,
          name: t.name,
          owner: t.owner, // This is just a name string, not a user reference
          externalId: t.externalId,
        })),
      },
      teamClaims: {
        total: teamClaims.length,
        active: activeTeamClaims.length,
        sample: teamClaims.slice(0, 3).map(claim => ({
          teamId: claim.teamId,
          userId: claim.userId,
          status: claim.status,
          seasonId: claim.seasonId,
        })),
      },
      users: {
        total: allUsers.length,
        sampleNames: allUsers.slice(0, 3).map(u => u.name),
      },
      teamClaimLookups,
      diagnosis: {
        hasTeams: teams.length > 0,
        hasTeamClaims: teamClaims.length > 0,
        hasActiveTeamClaims: activeTeamClaims.length > 0,
        canFindUsersFromClaims: teamClaimLookups.some(lookup => lookup.userExists),
        recommendedApproach: "Use teamClaims table with active status to find users",
      },
    };
  },
});

// Manually trigger sending of pending comment requests (for testing)
export const sendPendingRequests = mutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
  },
  handler: async (ctx, args) => {
    console.log("Manually triggering pending comment requests for:", args.scheduledContentId);
    
    // Trigger the sending immediately
    await ctx.scheduler.runAfter(0, internal.commentRequests.sendInitialRequests, {
      scheduledContentId: args.scheduledContentId,
    });

    return {
      success: true,
      message: "Triggered sending of pending comment requests"
    };
  },
});

// Run complete end-to-end test
export const runEndToEndTest = mutation({
  args: {
    leagueId: v.id("leagues"),
    testResponse: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const testResults = {
      steps: [] as string[],
      success: false,
      error: null as string | null,
    };

    try {
      // Step 1: Create test content
      testResults.steps.push("Creating test scheduled content...");
      const now = Date.now();
      const scheduledTime = now + 5 * 60 * 1000; // 5 minutes from now
      
      // Create a dummy content schedule for the required field
      const contentScheduleId = await ctx.db.insert("contentSchedules", {
        leagueId: args.leagueId,
        contentType: "weekly_recap" as const,
        enabled: true,
        timezone: "America/New_York",
        schedule: {
          type: "weekly",
          dayOfWeek: 2, // Tuesday
          hour: 10, // 10 AM
          minute: 0,
        },
        preferredPersona: "default",
        createdAt: now,
        updatedAt: now,
      });

      const scheduledContentId = await ctx.db.insert("scheduledContent", {
        leagueId: args.leagueId,
        contentScheduleId,
        contentType: "weekly_recap",
        scheduledFor: scheduledTime,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        contextData: {
          week: 12,
          seasonId: 2024,
          additionalContext: {
            testMode: true,
            endToEndTest: true,
          },
        },
        createdAt: now,
        updatedAt: now,
      });
      testResults.steps.push(`✓ Created scheduled content: ${scheduledContentId}`);

      // Step 2: Get test users
      testResults.steps.push("Finding test users...");
      const teams = await ctx.db
        .query("teams")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
        .filter(q => q.neq(q.field("owner"), null))
        .take(2); // Just 2 users for testing

      const ownerClerkIds = teams.map(t => t.owner).filter(Boolean);
      const users = await Promise.all(
        ownerClerkIds.map(async (clerkId) => {
          const user = await ctx.db
            .query("users")
            .withIndex("by_clerk_id", q => q.eq("clerkId", clerkId))
            .unique();
          return user?._id;
        })
      );
      
      const targetUserIds = users.filter(id => id !== undefined) as Id<"users">[];
      testResults.steps.push(`✓ Found ${targetUserIds.length} test users`);

      // Step 3: Create comment requests immediately
      testResults.steps.push("Creating comment requests...");
      await ctx.scheduler.runAfter(0, internal.commentRequests.createRequestsForScheduledContent, {
        scheduledContentId,
        targetUserIds,
        requestTimeBeforeGeneration: 100, // Almost immediate
      });
      testResults.steps.push("✓ Scheduled comment request creation");

      // Step 4: Wait a moment then check if requests were created
      testResults.steps.push("Waiting for requests to be created...");
      // We'll return the scheduled content ID so we can check status later

      testResults.success = true;
      return {
        ...testResults,
        scheduledContentId,
        targetUserIds,
        nextSteps: [
          "1. Wait 10-20 seconds for requests to be created",
          "2. Check test status using getTestStatus",
          "3. Simulate user responses using simulateUserResponse",
          "4. Verify AI follow-up generation",
        ],
      };

    } catch (error) {
      testResults.error = String(error);
      testResults.steps.push(`✗ Error: ${error}`);
      return testResults;
    }
  },
});

// Clean up test data
export const cleanupTestData = mutation({
  args: {
    leagueId: v.optional(v.id("leagues")),
    olderThanHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cutoffTime = Date.now() - (args.olderThanHours || 1) * 60 * 60 * 1000;
    
    // Find test requests to clean up
    let requests;
    if (args.leagueId) {
      requests = await ctx.db
        .query("commentRequests")
        .withIndex("by_league", q => q.eq("leagueId", args.leagueId!))
        .filter(q => q.lt(q.field("createdAt"), cutoffTime))
        .collect();
    } else {
      requests = await ctx.db
        .query("commentRequests")
        .filter(q => q.lt(q.field("createdAt"), cutoffTime))
        .collect();
    }

    let deletedRequests = 0;
    let deletedMessages = 0;
    let deletedResponses = 0;
    let deletedContent = 0;

    for (const request of requests) {
      // Delete conversations
      const messages = await ctx.db
        .query("commentConversations")
        .withIndex("by_comment_request", q => 
          q.eq("commentRequestId", request._id)
        )
        .collect();
      
      for (const message of messages) {
        await ctx.db.delete(message._id);
        deletedMessages++;
      }

      // Delete responses
      const responses = await ctx.db
        .query("commentResponses")
        .withIndex("by_comment_request", q => 
          q.eq("commentRequestId", request._id)
        )
        .collect();
      
      for (const response of responses) {
        await ctx.db.delete(response._id);
        deletedResponses++;
      }

      // Delete the request
      await ctx.db.delete(request._id);
      deletedRequests++;
    }

    // Clean up test scheduled content
    const testContent = await ctx.db
      .query("scheduledContent")
      .filter(q => 
        q.and(
          q.lt(q.field("createdAt"), cutoffTime),
          q.eq(q.field("contextData.additionalContext.testMode"), true)
        )
      )
      .collect();

    for (const content of testContent) {
      await ctx.db.delete(content._id);
      deletedContent++;
    }

    return {
      success: true,
      cleanup: {
        deletedRequests,
        deletedMessages,
        deletedResponses,
        deletedContent,
      },
    };
  },
});