import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { contentTypePersonaMap, DEFAULT_PERSONA } from "../src/lib/ai/persona-prompts";
import { leagueCurrentSeason } from "./lib/season";
import { espnConnectionBlocked } from "./lib/espnConnection";
import { COMMENT_WINDOWS_MS, LOOKBACK_INTERVIEW_TYPES, resolveInterviewees } from "./lib/interviewees";

/**
 * Content types that reach out for comment before they are written (spec section 9.1)
 * are the keys of `COMMENT_WINDOWS_MS` in convex/lib/interviewees.ts. Nothing else opens
 * an interview: a power rankings piece that pesters every manager each Wednesday is how a
 * league turns notifications off.
 */

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

    const scheduledContent = await ctx.db.get(args.scheduledContentId);
    const league = await ctx.db.get(args.leagueId);

    // Reach out for comment articles should NOT reach out for comment while
    // the league's ESPN connection is broken (nothing to write about yet, and
    // it may end up weeks-old by the time it is fixed), for a row that has
    // already been flagged to skip interviews (a resumed backlog row whose
    // week has passed), or for a row that is no longer in a state that can
    // still use an interview (owner directive, Sept 2026).
    if (espnConnectionBlocked(league)) {
      console.log(`Skipping comment request scheduling for ${args.contentType}: ESPN connection blocked for league ${args.leagueId}`);
      return { scheduled: false, reason: "espn_connection_blocked" as const };
    }
    if (scheduledContent?.skipCommentRequests) {
      return { scheduled: false, reason: "skip_comment_requests" as const };
    }
    if (scheduledContent && scheduledContent.status !== "pending" && scheduledContent.status !== "generating") {
      return { scheduled: false, reason: "row_not_pending" as const };
    }

    // The season this article is actually about. `scheduledContent` carries it
    // in two possible spots (contextData is the generation payload;
    // the top-level field is what processScheduledContent stamps at execution
    // time - see convex/schema.ts). Only fall back to "whatever ESPN sync last
    // touched" when neither is set yet (e.g. a manual/early trigger).
    const season =
      scheduledContent?.contextData?.seasonId ??
      scheduledContent?.seasonId ??
      leagueCurrentSeason(league);

    // Who to ask, from this season's active claims (convex/lib/interviewees.ts). The same
    // helper runs again at send time, so this list is a preview, not a contract.
    const { targetUserIds, counts } = await resolveInterviewees(ctx, {
      leagueId: args.leagueId,
      season,
      contentType: args.contentType,
      week: scheduledContent?.week ?? scheduledContent?.contextData?.week,
      eventData: scheduledContent?.contextData?.eventData ?? null,
    });

    if (targetUserIds.length === 0) {
      console.log("No claimed managers to request comments from", counts);
      return { scheduled: false, reason: "no claimed managers", ...counts };
    }

    // A story about a finished week sends one window before print (and then waits for
    // ESPN to finalize the week, and for 07:00 league time). An event story - a trade,
    // the draft - reaches out right now, while the managers are still around: sending at
    // print minus six hours would have pinged a draft-night league at 3 AM.
    const sendAt = LOOKBACK_INTERVIEW_TYPES.has(args.contentType) ? args.scheduledTime - window : Date.now();

    await ctx.scheduler.runAt(sendAt, internal.commentRequests.createRequestsForScheduledContent, {
      scheduledContentId: args.scheduledContentId,
      targetUserIds,
      requestTimeBeforeGeneration: window,
      writerPersona,
    });

    console.log(
      `Comment requests for ${args.contentType} (${targetUserIds.length} managers, writer ${writerPersona}) queued for ${new Date(sendAt).toISOString()}`,
    );

    return { scheduled: true, requests: targetUserIds.length, sendAt, writerPersona, ...counts };
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
