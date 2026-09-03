import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
// Type-only: never a value import from src/lib/ai in a non-Node Convex file.
import type {
  CommentResponseData,
  NonRespondent,
} from "../src/lib/ai/content-generation-service";
import { Doc, Id } from "./_generated/dataModel";
import {
  commentResponseDataValidator,
  nonRespondentValidator,
} from "./validators";
import { quotesForResponse } from "./aiContentWithComments";
import {
  handleGenerationFailure,
  MAX_GENERATION_RETRIES,
} from "./lib/generationFailure";

/* -------------------------------------------------------------------------- *
 * Manager -> team, via teamClaims (spec section 2)
 *
 * `teamClaims.userId` is a Clerk id, so the join runs users -> clerkId ->
 * teamClaims -> teams. `teams.owner` is an ESPN owner string and is never
 * compared to a Convex user id.
 * -------------------------------------------------------------------------- */
async function teamForUser(
  ctx: QueryCtx | MutationCtx,
  leagueId: Id<"leagues">,
  user: Doc<"users"> | null
): Promise<Doc<"teams"> | null> {
  if (!user?.clerkId) return null;
  const claims = await ctx.db
    .query("teamClaims")
    .withIndex("by_user", (q) => q.eq("userId", user.clerkId))
    .take(50);
  const inLeague = claims.filter(
    (c) => c.leagueId === leagueId && c.status === "active"
  );
  if (inLeague.length === 0) return null;
  const claim = inLeague.sort((a, b) => b.seasonId - a.seasonId)[0];
  return await ctx.db.get(claim.teamId);
}

/**
 * What the interviewer asked this manager about, in the order the spec gives:
 * the request's article topic, its first focus area, then the live conversation
 * focus. Falls back to the content type so the field is never empty.
 */
function questionTopicFor(
  request: Doc<"commentRequests"> | null,
  contentType: string
): string {
  const topic = request?.articleContext?.topic?.trim();
  if (topic) return topic;
  const focus = request?.articleContext?.focusAreas?.find((f) => f && f.trim());
  if (focus) return focus.trim();
  const current = request?.aiContext?.currentFocus?.trim();
  if (current) return current;
  return contentType.replace(/_/g, " ");
}

/** Build the spec section 4.2 `CommentResponseData` for one stored response. */
async function toCommentResponseData(
  ctx: QueryCtx,
  response: Doc<"commentResponses">,
  leagueId: Id<"leagues">,
  contentType: string
): Promise<CommentResponseData> {
  const user = await ctx.db.get(response.userId);
  const team = await teamForUser(ctx, leagueId, user);
  const request = await ctx.db.get(response.commentRequestId);

  // Verbatim, post-approval: the manager's quote review wins where it exists,
  // withdrawn quotes never leave this function, and the cleaned response is the
  // last fallback so a reply is never dropped (spec section 8.1).
  const quotes = quotesForResponse(response);

  const contextTeamName =
    contentType === "weekly_recap"
      ? request?.articleContext?.userTeamInfo?.teamName
      : undefined;

  return {
    userId: response.userId as string,
    userName: user?.name?.trim() || "A league manager",
    teamId: (team?._id ?? "") as string,
    teamName: team?.name || contextTeamName || "Unclaimed team",
    questionTopic: questionTopicFor(request, contentType),
    quotes,
    rawResponse: response.rawResponse,
  };
}

// Step 1: Fetch and prepare data for AI generation
export const prepareAIContentData = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    scheduledContentId: v.optional(v.id("scheduledContent")),
    // Set when the caller (generateContentAction) already deducted credits
    // up front. Forwarded on to generateAIContentWithData, and refunded here
    // on failure instead of being silently lost.
    creditsDeductedUpFront: v.optional(v.number()),
    // Interview material collected by the caller (spec section 5). When present
    // these are preferred over this module's own queries, so the quotes the
    // article prints are exactly the ones the comment flow approved.
    commentResponses: v.optional(v.array(commentResponseDataValidator)),
    nonRespondents: v.optional(v.array(nonRespondentValidator)),
    // Retries already spent on this article (spec section 9.2.5). Forwarded so
    // the cap survives the prepare -> generate hand-off.
    retryCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("=== prepareAIContentData START ===");
    const startTime = Date.now();
    
    try {
      // Fetch data based on content type
      let leagueData;
      
      if (args.contentType === 'mock_draft') {
        console.log("Fetching mock draft data...");
        
        const mockDraftData = await ctx.runQuery(internal.aiQueries.getMockDraftDataForAI, {
          leagueId: args.leagueId,
        });
        
        // Convert to expected format (simplified)
        leagueData = {
          leagueName: mockDraftData.leagueName,
          currentWeek: 0,
          currentSeason: mockDraftData.seasonId,
          teams: mockDraftData.teams,
          scoringType: mockDraftData.scoringType,
          rosterSize: mockDraftData.rosterSize,
          totalTeams: mockDraftData.totalTeams,
          draftOrder: mockDraftData.draftOrder,
          draftType: mockDraftData.draftType,
          leagueType: mockDraftData.leagueType,
          availablePlayers: mockDraftData.availablePlayers,
          playerCount: mockDraftData.playerCount,
          metadata: mockDraftData.metadata,
          // Empty arrays for non-draft content
          recentMatchups: [],
          trades: [],
          transactions: [],
          rivalries: [],
          managerActivity: [],
          standings: [],
        };
      } else if (args.contentType === 'season_welcome') {
        console.log("Fetching season welcome data...");
        
        const seasonWelcomeData = await ctx.runQuery(internal.aiQueries.getSeasonWelcomeDataForAI, {
          leagueId: args.leagueId,
        });
        
        leagueData = seasonWelcomeData;
      } else if (args.contentType === 'waiver_wire_report') {
        console.log("Fetching waiver wire data...");
        
        const waiverWireData = await ctx.runQuery(internal.aiQueries.getWaiverWireDataForAI, {
          leagueId: args.leagueId,
        });
        
        leagueData = waiverWireData;
      } else if (args.contentType === 'trade_analysis') {
        console.log("Fetching trade analysis data...");
        
        const tradeAnalysisData = await ctx.runQuery(internal.aiQueries.getTradeAnalysisDataForAI, {
          leagueId: args.leagueId,
        });
        
        leagueData = tradeAnalysisData;
      } else if (args.contentType === 'weekly_recap') {
        console.log("Fetching weekly recap data...");
        
        if (!args.seasonId || !args.week) {
          throw new Error("seasonId and week are required for weekly_recap content");
        }
        
        const weeklyRecapData = await ctx.runQuery(internal.aiQueries.getWeeklyRecapDataForAI, {
          leagueId: args.leagueId,
          seasonId: args.seasonId,
          week: args.week,
        });
        
        leagueData = weeklyRecapData;
      } else if (args.contentType === 'draft_rankings') {
        console.log("Fetching draft rankings data...");
        
        // Determine seasonId - use provided seasonId or fall back to league's current season
        let seasonId = args.seasonId;
        if (!seasonId) {
          console.log("No seasonId provided, determining from league data...");
          const league = await ctx.runQuery(api.leagues.getById, { id: args.leagueId });
          seasonId = league?.espnData?.seasonId || new Date().getFullYear();
          console.log(`Using seasonId: ${seasonId}`);
        }
        
        const draftRankingsData = await ctx.runQuery(internal.draftRankingsHelpers.getSimplifiedDraftData, {
          leagueId: args.leagueId,
          seasonId: seasonId,
        });
        
        // Convert to expected league data format
        leagueData = {
          leagueName: draftRankingsData.leagueInfo.name,
          currentWeek: 0,
          currentSeason: seasonId,
          scoringType: draftRankingsData.leagueInfo.scoringType,
          totalTeams: draftRankingsData.leagueInfo.teamCount,
          draftType: draftRankingsData.leagueInfo.draftType,
          // Draft-specific data
          draftPicks: draftRankingsData.draftPicks,
          teamGrades: draftRankingsData.teamGrades,
          // Use the draft order from draftRankingsData (from leagueSeasons.draftSettings.pickOrder)
          draftOrder: draftRankingsData.draftOrder.length > 0 
            ? draftRankingsData.draftOrder 
            : draftRankingsData.draftPicks.map(pick => ({
                position: pick.pickNumber,
                teamId: pick.teamName, // fallback
                teamName: pick.teamName,
                manager: pick.teamOwner,
              })).sort((a, b) => a.position - b.position),
          // Create teams data from teamGrades for roster information
          teams: draftRankingsData.teamGrades.map(grade => ({
            name: grade.teamName,
            owner: grade.teamOwner,
            abbreviation: grade.teamName.substring(0, 3).toUpperCase(),
            projectedPoints: grade.projectedStarterPoints,
            draftGrade: grade.grade,
            gradeScore: grade.gradeScore,
            strategy: grade.strategy.strategy,
            bestPicks: grade.bestPicks,
            worstPicks: grade.worstPicks,
            benchDepthScore: grade.benchDepthScore,
          })),
          recentMatchups: [],
          trades: [],
          transactions: [],
          rivalries: [],
          managerActivity: [],
          standings: [],
        };
      } else {
        // Regular content generation
        leagueData = await ctx.runQuery(internal.aiContent.getLeagueDataForGenerationInternal, {
          leagueId: args.leagueId,
        });
      }
      
      const executionTime = Date.now() - startTime;
      console.log("Data preparation completed in", executionTime + "ms");
      
      // Store prepared data for next step
      await ctx.runMutation(internal.aiContentHelpers.storePreparedData, {
        articleId: args.articleId,
        leagueData,
        executionTime,
      });
      
      // Schedule the next step after data is prepared
      await ctx.scheduler.runAfter(0, internal.aiContentHelpers.generateAIContentWithData, {
        articleId: args.articleId,
        leagueId: args.leagueId,
        contentType: args.contentType,
        persona: args.persona,
        customContext: args.customContext,
        userId: args.userId,
        scheduledContentId: args.scheduledContentId,
        creditsDeductedUpFront: args.creditsDeductedUpFront,
        commentResponses: args.commentResponses,
        nonRespondents: args.nonRespondents,
        retryCount: args.retryCount,
        seasonId: args.seasonId,
        week: args.week,
      });
      
      console.log("=== prepareAIContentData SUCCESS ===");
      return { success: true, executionTime };
      
    } catch (error) {
      console.error("=== prepareAIContentData ERROR ===");
      console.error("Error:", error);

      // Credits, article status, the scheduled row (back to pending with a
      // retry time, or failed plus a commissioner notice) and the capped
      // retry, all through the one shared path (spec section 9.2.5).
      await handleGenerationFailure(
        ctx,
        {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          seasonId: args.seasonId,
          week: args.week,
          scheduledContentId: args.scheduledContentId,
          creditsDeductedUpFront: args.creditsDeductedUpFront,
          retryCount: args.retryCount,
          stage: "Data preparation",
        },
        error
      );

      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  },
});

// Step 2: Generate AI content with prepared data
export const generateAIContentWithData = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    scheduledContentId: v.optional(v.id("scheduledContent")),
    // Forwarded from prepareAIContentData; when set, refunded on failure
    // below instead of being silently lost.
    creditsDeductedUpFront: v.optional(v.number()),
    // Preferred over this module's own comment queries when supplied.
    commentResponses: v.optional(v.array(commentResponseDataValidator)),
    nonRespondents: v.optional(v.array(nonRespondentValidator)),
    // Forwarded from prepareAIContentData so a failure here can hand the same
    // context to the retry it schedules (spec section 9.2.5).
    retryCount: v.optional(v.number()),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("=== generateAIContentWithData START ===");
    const startTime = Date.now();
    
    try {
      // Retrieve prepared data
      const preparedData = await ctx.runQuery(internal.aiContentHelpers.getPreparedData, {
        articleId: args.articleId,
      });
      
      if (!preparedData || !preparedData.leagueData) {
        throw new Error("No prepared data found for article");
      }
      
      console.log("Retrieved prepared data, generating content...");
      
      // Interview material. The caller's arrays win when present (the comment
      // flow already resolved managers, teams and approved quotes); otherwise
      // fall back to this module's own queries.
      let commentResponses: CommentResponseData[] = args.commentResponses ?? [];
      let nonRespondents: NonRespondent[] = args.nonRespondents ?? [];
      if (args.commentResponses) {
        console.log(`Using ${commentResponses.length} comment responses supplied by the caller`);
      } else if (args.scheduledContentId) {
        // For scheduled content
        commentResponses = await ctx.runQuery(internal.aiContentHelpers.getCommentResponsesForContent, {
          scheduledContentId: args.scheduledContentId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          week: preparedData.leagueData.currentWeek,
        });
        // Managers who were asked and said nothing get their sanctioned "did
        // not respond" line instead of silently disappearing (spec section 5).
        if (nonRespondents.length === 0) {
          nonRespondents = await ctx.runQuery(
            internal.aiContentHelpers.getNonRespondentsForScheduledContent,
            { scheduledContentId: args.scheduledContentId }
          );
        }
        console.log(
          `Found ${commentResponses.length} comment responses and ${nonRespondents.length} non-respondents for scheduled content`
        );
      } else {
        // For manual content, get comment responses by articleId
        commentResponses = await ctx.runQuery(internal.aiContentHelpers.getCommentResponsesForManualContent, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          week: preparedData.leagueData.currentWeek,
        });
        console.log(`Found ${commentResponses.length} comment responses for manual content`);
      }

      // The writer's standing with each manager (spec section 6). Fetched here
      // too - not just in generateContentAction - because mock_draft,
      // weekly_recap, season_welcome and draft_rankings never pass through that
      // action's inline path.
      const relationships = await ctx.runQuery(
        internal.relationships.getRelationshipsForWriter,
        { leagueId: args.leagueId, persona: args.persona }
      );

      // Receipts (spec section 8.4), fetched here for the same reason as the
      // relationships above: the prepared path never reaches generateContentAction.
      const priorClaims = await ctx.runQuery(
        internal.claims.getPriorClaimsForWriter,
        { leagueId: args.leagueId, persona: args.persona }
      );
      
      // Generate content without timeout - similar to Season Welcome Package
      console.log(`Generating AI content for ${args.contentType} without timeout...`);
      
      const generatedContent = await ctx.runAction(internal.aiNode.generateArticle, {
        request: {
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          week: args.week,
          leagueData: preparedData.leagueData,
          customContext: args.customContext,
          userId: args.userId,
          commentResponses: commentResponses.length > 0 ? commentResponses : undefined,
          nonRespondents: nonRespondents.length > 0 ? nonRespondents : undefined,
          relationships: relationships.length > 0 ? relationships : undefined,
          // The writer's own back catalogue of predictions and their record
          // (spec section 8.4).
          priorClaims: priorClaims.items,
          priorRecord: priorClaims.record,
        },
      });
      
      const executionTime = Date.now() - startTime;
      console.log("AI generation completed in", executionTime + "ms");
      
      // Update article with generated content (quotes, managerMentions,
      // reviewFlags, factsMissing and generationStats ride along on metadata).
      //
      // `billing` is derived here rather than threaded through
      // prepareAIContentData: the two inputs it needs are already arguments of
      // this action, and they are the same test generateContentAction applies -
      // automated content is covered by the League Pass and cost nobody
      // credits, everything else was charged to a real person up front
      // (spec §10.1).
      const billing: "pass" | "credits" =
        args.userId === "system" || args.scheduledContentId !== undefined ? "pass" : "credits";

      await ctx.runMutation(internal.aiContent.updateGeneratedContent, {
        articleId: args.articleId,
        title: generatedContent.title,
        content: generatedContent.content,
        summary: generatedContent.summary,
        // Season backfill (owner directive, Sept 2026): args.seasonId is the season this article is
        // actually about; updateGeneratedContent falls back to the league's live current season
        // when it's absent, so every non-backfill caller is unaffected.
        metadata: { ...generatedContent.metadata, seasonId: args.seasonId },
        billing,
      });

      // One finalize path (spec section 9.2.2). Before this, the prepared path
      // recorded relationship events and quote usage but never applied the
      // league's autoPublish preference and never closed its scheduled row, so
      // every cron-generated mock draft, weekly recap, draft ranking and season
      // welcome sat in draft with its schedule row stuck on "generating".
      try {
        const finalized = await ctx.runMutation(internal.aiContent.finalizeGeneratedArticle, {
          articleId: args.articleId,
          leagueId: args.leagueId,
          scheduledContentId: args.scheduledContentId,
          reviewFlags: generatedContent.metadata.reviewFlags,
          generatedByUserId: args.userId,
        });
        console.log("Article finalized:", finalized);
      } catch (e) {
        console.error("Failed to finalize generated article", args.articleId, e);
      }

      // Clean up prepared data
      await ctx.runMutation(internal.aiContentHelpers.cleanupPreparedData, {
        articleId: args.articleId,
      });

      console.log("=== generateAIContentWithData SUCCESS ===");
      return { success: true, executionTime };

    } catch (error) {
      console.error("=== generateAIContentWithData ERROR ===");
      console.error("Error:", error);

      // Same shared failure path as prepareAIContentData's catch above: refund
      // only when no retry is coming, mark the article failed, and hand the
      // scheduled row back to the cron (spec section 9.2.5).
      await handleGenerationFailure(
        ctx,
        {
          articleId: args.articleId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          persona: args.persona,
          customContext: args.customContext,
          userId: args.userId,
          seasonId: args.seasonId,
          week: args.week,
          scheduledContentId: args.scheduledContentId,
          creditsDeductedUpFront: args.creditsDeductedUpFront,
          retryCount: args.retryCount,
          stage: "AI generation",
        },
        error
      );

      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  },
});

// Internal mutations for data management
export const storePreparedData = internalMutation({
  args: {
    articleId: v.id("aiContent"),
    leagueData: v.any(),
    executionTime: v.number(),
  },
  handler: async (ctx, args) => {
    // Store in a temporary field on the article
    await ctx.db.patch(args.articleId, {
      tempGenerationData: {
        leagueData: args.leagueData,
        preparedAt: Date.now(),
        preparationTime: args.executionTime,
      },
    });
  },
});

/**
 * Comment responses for a scheduled article, in the spec section 4.2
 * `CommentResponseData` shape.
 *
 * No quality or integration-status filter: a manager who answered gets printed
 * or gets an explicit "did not respond" line. Suppressing a real reply because a
 * heuristic scored it 49 is exactly the failure the Broadcast Desk is fixing.
 */
export const getCommentResponsesForContent = internalQuery({
  args: {
    scheduledContentId: v.optional(v.id("scheduledContent")),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    week: v.optional(v.number()),
  },
  returns: v.array(commentResponseDataValidator),
  handler: async (ctx, args): Promise<CommentResponseData[]> => {
    if (!args.scheduledContentId) {
      return [];
    }

    const responses = await ctx.db
      .query("commentResponses")
      .withIndex("by_scheduled_content", q =>
        q.eq("scheduledContentId", args.scheduledContentId!)
      )
      .collect();

    const built = await Promise.all(
      responses.map((response) =>
        toCommentResponseData(ctx, response, args.leagueId, args.contentType)
      )
    );
    // A manager who withdrew every quote is not a speaker; sending them with an
    // empty quote list would ask the writer to attribute silence (spec section 8.1).
    return built.filter((entry) => entry.quotes.length > 0);
  },
});

/** Same as above for manually generated "wait for comments" articles. */
export const getCommentResponsesForManualContent = internalQuery({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    week: v.optional(v.number()),
  },
  returns: v.array(commentResponseDataValidator),
  handler: async (ctx, args): Promise<CommentResponseData[]> => {
    const responses = await ctx.db
      .query("commentResponses")
      .withIndex("by_manual_content", q =>
        q.eq("manualContentId", args.articleId)
      )
      .collect();

    const built = await Promise.all(
      responses.map((response) =>
        toCommentResponseData(ctx, response, args.leagueId, args.contentType)
      )
    );
    // A manager who withdrew every quote is not a speaker; sending them with an
    // empty quote list would ask the writer to attribute silence (spec section 8.1).
    return built.filter((entry) => entry.quotes.length > 0);
  },
});

/**
 * Managers who were asked for comment on a scheduled article and never went on
 * the record, in the spec section 4.2 `NonRespondent` shape.
 *
 * The writer needs these by name: every persona has a sanctioned "did not
 * respond" line, and without the list the article silently pretends nobody was
 * asked. Mirrors aiContentWithComments.getNonRespondents, keyed by the
 * scheduled row instead of by an explicit list of request ids.
 */
export const getNonRespondentsForScheduledContent = internalQuery({
  args: { scheduledContentId: v.id("scheduledContent") },
  returns: v.array(nonRespondentValidator),
  handler: async (ctx, args): Promise<NonRespondent[]> => {
    const requests = await ctx.db
      .query("commentRequests")
      .withIndex("by_scheduled_content", (q) =>
        q.eq("scheduledContentId", args.scheduledContentId)
      )
      .collect();

    const results: NonRespondent[] = [];
    for (const request of requests) {
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
        .withIndex("by_comment_request", (q) => q.eq("commentRequestId", request._id))
        .first();
      if (response) continue;

      const user = await ctx.db.get(request.targetUserId);
      const team = await teamForUser(ctx, request.leagueId, user);

      results.push({
        userId: request.targetUserId as string,
        userName: user?.name?.trim() || user?.email || "A league manager",
        teamName: team?.name ?? "Unclaimed team",
        status: request.status === "declined" ? "declined" : "no_response",
      });
    }

    return results;
  },
});

/* -------------------------------------------------------------------------- *
 * Quote write-back (spec section 5)
 * -------------------------------------------------------------------------- */

/** Normalize curly quotes and whitespace so a substring match survives the model. */
function normalizeQuoteText(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Every commentResponse tied to this article, manual or scheduled. */
async function responsesForArticle(
  ctx: MutationCtx,
  article: Doc<"aiContent">
): Promise<Array<Doc<"commentResponses">>> {
  const manual = await ctx.db
    .query("commentResponses")
    .withIndex("by_manual_content", (q) => q.eq("manualContentId", article._id))
    .collect();

  // Scheduled articles have no direct link on commentResponses: the response
  // knows its scheduledContentId, and scheduledContent.generatedContentId points
  // back here once generation completes.
  const scheduled = await ctx.db
    .query("scheduledContent")
    .withIndex("by_league", (q) => q.eq("leagueId", article.leagueId))
    .filter((q) => q.eq(q.field("generatedContentId"), article._id))
    .collect();

  const fromScheduled = (
    await Promise.all(
      scheduled.map((sc) =>
        ctx.db
          .query("commentResponses")
          .withIndex("by_scheduled_content", (q) => q.eq("scheduledContentId", sc._id))
          .collect()
      )
    )
  ).flat();

  const seen = new Set<string>();
  return [...manual, ...fromScheduled].filter((r) => {
    if (seen.has(r._id)) return false;
    seen.add(r._id);
    return true;
  });
}

/**
 * Write back which approved quotes actually made print. Reads the verified
 * `quotes[]` saved on the article and, for each matching commentResponse
 * (same manager, and a quote that overlaps what they said), records the section
 * it ran in and how they were credited.
 */
export const markQuotesUsed = internalMutation({
  args: { articleId: v.id("aiContent") },
  returns: v.object({ integrated: v.number(), unmatched: v.number() }),
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    if (!article) return { integrated: 0, unmatched: 0 };

    const quotes = article.quotes ?? [];
    if (quotes.length === 0) return { integrated: 0, unmatched: 0 };

    const responses = await responsesForArticle(ctx, article);
    let integrated = 0;
    let unmatched = 0;

    for (const response of responses) {
      const user = await ctx.db.get(response.userId);
      const team = await teamForUser(ctx, article.leagueId, user);
      const userName = user?.name?.trim() || "";
      const said = normalizeQuoteText(
        [response.rawResponse, response.processedResponse].join(" ")
      );

      const match = quotes.find((quote) => {
        const text = normalizeQuoteText(quote.text);
        if (text.length === 0) return false;
        // Same manager: the printed quote is a span of what they said, or the
        // byline names them / their team.
        if (said.includes(text)) return true;
        const speaker = normalizeQuoteText(quote.speaker);
        const speakerIsUser =
          (userName.length > 0 && speaker === normalizeQuoteText(userName)) ||
          (team ? quote.teamId === (team._id as string) : false);
        return speakerIsUser && text.length >= 12 && said.includes(text.slice(0, 40));
      });

      if (!match) {
        unmatched++;
        continue;
      }

      await ctx.db.patch(response._id, {
        integrationStatus: "integrated" as const,
        usedInArticle: true,
        articleSection: match.sectionName,
        quoteAttribution: team?.name
          ? `${userName || match.speaker}, ${team.name}`
          : userName || match.speaker,
      });
      integrated++;
    }

    return { integrated, unmatched };
  },
});

export const getPreparedData = internalQuery({
  args: {
    articleId: v.id("aiContent"),
  },
  handler: async (ctx, args) => {
    const article = await ctx.db.get(args.articleId);
    return article?.tempGenerationData || null;
  },
});

export const cleanupPreparedData = internalMutation({
  args: {
    articleId: v.id("aiContent"),
  },
  handler: async (ctx, args) => {
    // Remove temporary data
    await ctx.db.patch(args.articleId, {
      tempGenerationData: undefined,
    });
  },
});

/**
 * Retry handler for failed steps (spec section 9.2.5).
 *
 * `retryCount` is how many retries have already been spent on this article. It
 * used to arrive hard-coded as 1 from every caller, so the "max 3" check could
 * never fire and a genuinely broken generation looped forever. It is now
 * threaded through generateContentAction, incremented exactly once per retry
 * here, and capped.
 *
 * A generation that belongs to a scheduled row never gets here: the cron owns
 * those retries (the row goes back to `pending` with a `nextRetryAt` instead).
 * `scheduledContentId` is still accepted and forwarded so a row that somehow
 * reaches this path stays attached to its article.
 */
export const retryFailedGeneration = internalAction({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),
    retryCount: v.number(),
    // Kept with the run so the retry is not billed a second time and so a
    // terminal failure still refunds exactly once.
    creditsDeductedUpFront: v.optional(v.number()),
    scheduledContentId: v.optional(v.id("scheduledContent")),
  },
  handler: async (ctx, args) => {
    console.log(
      `=== Retry attempt ${args.retryCount + 1} of ${MAX_GENERATION_RETRIES} for article ${args.articleId} ===`
    );

    if (args.retryCount >= MAX_GENERATION_RETRIES) {
      console.error("Max retry attempts exceeded");
      await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
        articleId: args.articleId,
        status: "failed",
        error: "Max retry attempts exceeded",
      });
      return;
    }

    if (args.scheduledContentId) {
      // Belt and braces: the cron owns scheduled retries, so refuse rather
      // than run a second generation against a row it is already reclaiming.
      console.log(
        `Skipping retry for article ${args.articleId}: scheduled content ${args.scheduledContentId} is retried by the cron`
      );
      return;
    }

    // Wait before retry (exponential backoff)
    const waitTime = Math.pow(2, args.retryCount + 1) * 1000;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // Retry the generation process
    await ctx.runAction(internal.aiContent.generateContentAction, {
      articleId: args.articleId,
      leagueId: args.leagueId,
      contentType: args.contentType,
      persona: args.persona,
      customContext: args.customContext,
      userId: args.userId,
      seasonId: args.seasonId,
      week: args.week,
      retryCount: args.retryCount + 1,
      creditsDeductedUpFront: args.creditsDeductedUpFront,
      scheduledContentId: args.scheduledContentId,
    });
  },
});