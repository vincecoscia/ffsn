import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { contentTypePersonaMap, DEFAULT_PERSONA } from "../src/lib/ai/persona-prompts";

/**
 * Content types that reach out for comment before they are written
 * (spec section 9.1). Nothing else opens an interview: a power rankings piece
 * that pesters eight managers every Wednesday is how a league turns
 * notifications off.
 */
const COMMENT_WINDOWS_MS: Record<string, number> = {
  weekly_recap: 12 * 60 * 60 * 1000, // requests go out 12h before print
  trade_analysis: 6 * 60 * 60 * 1000, // event type: 6h
  draft_rankings: 6 * 60 * 60 * 1000, // event type: 6h
};

/** How many managers we are willing to interview for one article. */
const MAX_REQUESTS: Record<string, number> = {
  weekly_recap: 8,
  trade_analysis: 4,
  draft_rankings: 10,
};

/**
 * Integration hook: when content is scheduled, line up the comment requests so
 * they land one window before the article is written, not the moment the row is
 * created (which used to give managers a deadline days away and a dead thread by
 * the time the writer needed the quote).
 */
export const onContentScheduled = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    scheduledTime: v.number(),
    // The writer the quotes are destined for; Sam still conducts the interview.
    writerPersona: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const window = COMMENT_WINDOWS_MS[args.contentType];
    if (window === undefined) {
      console.log(`Content type ${args.contentType} does not support comment requests`);
      return { scheduled: false, reason: "content type does not take comments" };
    }

    const writerPersona =
      args.writerPersona ?? contentTypePersonaMap[args.contentType]?.[0] ?? DEFAULT_PERSONA;

    // Active league members, keyed by the Convex user id the request table wants.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.neq(q.field("owner"), null))
      .collect();

    if (teams.length === 0) {
      console.log("No active teams found for comment requests");
      return { scheduled: false, reason: "no teams" };
    }

    const scheduledContent = await ctx.db.get(args.scheduledContentId);

    /** `teams.owner` is a Clerk id; `commentRequests.targetUserId` is `Id<"users">`. */
    const resolveUserIds = async (owners: Array<string | null | undefined>) => {
      const ids = await Promise.all(
        owners
          .filter((owner): owner is string => !!owner)
          .map(async (clerkId) => {
            const user = await ctx.db
              .query("users")
              .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
              .unique();
            return user?._id;
          }),
      );
      return ids.filter((id): id is Id<"users"> => id !== undefined);
    };

    let selectedTeams = teams;

    if (args.contentType === "weekly_recap") {
      // Only the managers who actually played that week have anything to say.
      const week = scheduledContent?.week ?? scheduledContent?.contextData?.week;
      if (week) {
        const matchups = await ctx.db
          .query("matchups")
          .withIndex("by_league_period", (q) =>
            q.eq("leagueId", args.leagueId).eq("matchupPeriod", week),
          )
          .collect();

        const playingTeamIds = new Set<string>();
        for (const matchup of matchups) {
          playingTeamIds.add(matchup.homeTeamId);
          playingTeamIds.add(matchup.awayTeamId);
        }

        const playing = teams.filter((t) => t.externalId && playingTeamIds.has(t.externalId));
        if (playing.length > 0) selectedTeams = playing;
      }
    } else if (args.contentType === "trade_analysis") {
      // Both sides of the trade that triggered this article, and nobody else.
      const eventData = scheduledContent?.contextData?.eventData;
      const involved = new Set<string>(
        [eventData?.teamA?.teamId, eventData?.teamB?.teamId].filter(
          (id): id is string => typeof id === "string",
        ),
      );
      if (involved.size > 0) {
        const participants = teams.filter((t) => t.externalId && involved.has(t.externalId));
        if (participants.length > 0) selectedTeams = participants;
      }
    }
    // draft_rankings: everyone in the league drafted, so everyone is fair game.

    const limit = MAX_REQUESTS[args.contentType] ?? 5;
    const targetUserIds = (await resolveUserIds(selectedTeams.map((t) => t.owner))).slice(0, limit);

    if (targetUserIds.length === 0) {
      console.log("No claimed managers to request comments from");
      return { scheduled: false, reason: "no claimed managers" };
    }

    // Send the requests one window before print. `runAt` with a time already in
    // the past fires immediately, which is the right behaviour for an event
    // article scheduled less than its window ahead.
    const sendAt = args.scheduledTime - window;

    await ctx.scheduler.runAt(sendAt, internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: args.scheduledContentId,
      targetUserIds,
      requestTimeBeforeGeneration: window,
      writerPersona,
    });

    console.log(
      `Comment requests for ${args.contentType} (${targetUserIds.length} managers, writer ${writerPersona}) queued for ${new Date(sendAt).toISOString()}`,
    );

    return { scheduled: true, requests: targetUserIds.length, sendAt, writerPersona };
  },
});

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
