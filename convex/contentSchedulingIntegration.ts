import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { contentTypePersonaMap, DEFAULT_PERSONA } from "../src/lib/ai/persona-prompts";
import { leagueCurrentSeason } from "./lib/season";
import { espnConnectionBlocked } from "./lib/espnConnection";

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

    // Teams are per-season documents (spec section 2): the same franchise gets
    // a fresh `teams` row every season, so scoping to (leagueId, seasonId) via
    // `by_season` is required - without it every season's rows come back and
    // stale/duplicate owner strings leak into selection.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", season))
      .collect();

    if (teams.length === 0) {
      console.log(`No teams found for league ${args.leagueId} season ${season}`);
      return { scheduled: false, reason: "no teams", teams: 0, claimed: 0, targeted: 0 };
    }

    // Manager identity lives in `teamClaims`, never `teams.owner` -
    // `teams.owner` is always an ESPN owner display name (e.g. "Gabe Coscia"),
    // not a Clerk id (see convex/aiQueries.ts and convex/relationships.ts).
    // Build teamId -> Clerk id from this league's active claims for the
    // article's season, then Clerk id -> `users` doc id.
    const claims = await ctx.db
      .query("teamClaims")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    const activeClaims = claims.filter((c) => c.seasonId === season && c.status === "active");

    const clerkIdByTeamId = new Map<Id<"teams">, string>();
    for (const claim of activeClaims) {
      clerkIdByTeamId.set(claim.teamId, claim.userId);
    }

    const uniqueClerkIds = Array.from(new Set(clerkIdByTeamId.values()));
    const userIdByClerkId = new Map<string, Id<"users">>();
    await Promise.all(
      uniqueClerkIds.map(async (clerkId) => {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
          .unique();
        if (user) userIdByClerkId.set(clerkId, user._id);
      }),
    );

    /** Teams with no active claim for this season are simply skipped. */
    const resolveUserIds = (candidateTeams: typeof teams): Id<"users">[] => {
      const ids: Id<"users">[] = [];
      for (const team of candidateTeams) {
        const clerkId = clerkIdByTeamId.get(team._id);
        const userId = clerkId ? userIdByClerkId.get(clerkId) : undefined;
        if (userId) ids.push(userId);
      }
      return ids;
    };

    let selectedTeams = teams;

    if (args.contentType === "weekly_recap") {
      // Only the managers who actually played that week have anything to say.
      const week = scheduledContent?.week ?? scheduledContent?.contextData?.week;
      if (week) {
        // `by_unique_matchup` is (leagueId, seasonId, matchupPeriod, ...), so an
        // equality prefix on the first three fields scopes this to exactly the
        // league/season/week without a separate post-filter.
        const matchups = await ctx.db
          .query("matchups")
          .withIndex("by_unique_matchup", (q) =>
            q.eq("leagueId", args.leagueId).eq("seasonId", season).eq("matchupPeriod", week),
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
    const targetUserIds = resolveUserIds(selectedTeams).slice(0, limit);
    const counts = { teams: teams.length, claimed: activeClaims.length, targeted: targetUserIds.length };

    if (targetUserIds.length === 0) {
      console.log("No claimed managers to request comments from", counts);
      return { scheduled: false, reason: "no claimed managers", ...counts };
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
