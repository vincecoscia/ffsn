import { v } from "convex/values";
import { mutation, query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import type { ConversationContext } from "../src/lib/ai/conversation-service";
import { getLeagueMembership, requireCommissioner } from "./lib/auth";

// Helper function to identify defense positions
function isDefensePosition(position: string): boolean {
  if (!position) return false;
  const pos = position.toUpperCase();
  return pos === 'D/ST' || pos === 'DST' || pos === 'DEF';
}

/**
 * Sam Ortega conducts every comment-request interview (spec §1.2 / §5).
 * Unknown writer slugs fall back to Curtis Vaughn, never to Mel (spec §1.7).
 */
export const INTERVIEWER_PERSONA = "sam-ortega";
export const DEFAULT_WRITER_PERSONA = "curtis-vaughn";

/**
 * Display names for the six writers. Duplicated here rather than imported from
 * `src/lib/ai/persona-prompts.ts`: that module carries prompt copy, and Convex isolate
 * code must not depend on it. Keep in sync when the roster changes (spec §3).
 */
const WRITER_NAMES: Record<string, string> = {
  "curtis-vaughn": "Curtis Vaughn",
  "sam-ortega": "Sam Ortega",
  "nina-sharpe": "Nina Sharpe",
  "dex-alvarez": "Dex Alvarez",
  "mel-diaper": "Mel Diaper",
  "walt-brennan": "Walt Brennan",
};

function writerDisplayName(slug: string): string {
  return WRITER_NAMES[slug] ?? WRITER_NAMES[DEFAULT_WRITER_PERSONA];
}

/** ESPN bench lineup slot. Shared by the bench-points and lineup-decision reducers. */
const BENCH_SLOT_ID = 20;

// Create comment requests for scheduled content
export const createRequestsForScheduledContent = internalMutation({
  args: {
    scheduledContentId: v.id("scheduledContent"),
    targetUserIds: v.array(v.id("users")),
    requestTimeBeforeGeneration: v.optional(v.number()), // milliseconds before content generation (deprecated)
    // The writer the collected quotes are destined for (spec §5). Optional so the
    // existing scheduler caller keeps working; unknown/absent falls back to Curtis.
    writerPersona: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scheduledContent = await ctx.db.get(args.scheduledContentId);
    if (!scheduledContent) throw new Error("Scheduled content not found");

    const league = await ctx.db.get(scheduledContent.leagueId);
    if (!league) throw new Error("League not found");

    const scheduledSendTime = Date.now(); // Send immediately
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
          // Sam Ortega conducts every interview; the writer is who the quotes run under.
          interviewerPersona: INTERVIEWER_PERSONA,
          writerPersona: args.writerPersona ?? DEFAULT_WRITER_PERSONA,
          articleContext: {
            week: scheduledContent.contextData?.week,
            seasonId: scheduledContent.contextData?.seasonId,
            topic: `Week ${scheduledContent.contextData?.week} ${scheduledContent.contentType.replace('_', ' ')}`,
            focusAreas: ["team performance", "player decisions"], // Static for now
          },
          status: "pending",
          scheduledSendTime,
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

    // Send initial requests immediately
    await ctx.scheduler.runAfter(0, internal.commentRequests.sendInitialRequests, {
      scheduledContentId: args.scheduledContentId,
    });

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

    // Get conversation history for follow-up context
    const conversationMessages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request_order", q => 
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    const conversationHistory = conversationMessages.map(msg => ({
      role: msg.messageType === "user_response" ? "user" as const : "ai" as const,
      content: msg.content,
      timestamp: msg.createdAt,
    }));

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

    // Interview context (spec §5). The opponent's score was already computed here and
    // thrown away; margin, bench points and lineup decisions are what make Sam's opener
    // specific, so they are all kept now.
    let opponentExternalId: string | undefined;
    let opponentName: string | undefined;
    let opponentScoreOut: number | undefined;
    let margin: number | undefined;
    let benchPoints: number | undefined;
    let topBenchPlayer:
      | { player: string; position: string; points: number; projectedPoints?: number }
      | undefined;
    let lineupDecisions: Array<{
      benchedPlayer: string;
      benchedPoints: number;
      startedPlayer: string;
      startedPoints: number;
      position: string;
      pointGain: number;
    }> = [];

    if (matchup && teamExternalId) {
      const isHome = matchup.homeTeamId === teamExternalId;
      teamScore = isHome ? matchup.homeScore : matchup.awayScore;
      const opponentScore = isHome ? matchup.awayScore : matchup.homeScore;
      projectedScore = isHome ? matchup.homeProjectedScore : matchup.awayProjectedScore;
      won = teamScore > opponentScore;

      opponentExternalId = isHome ? matchup.awayTeamId : matchup.homeTeamId;
      opponentScoreOut = opponentScore;

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

      // `won` was decided before those fallbacks ran, so a recovered score could be
      // reported as a loss while `margin` said otherwise. Recompute it from the score
      // we actually publish - Sam states this result out loud.
      won = teamScore > opponentScore;

      // Debug: Log all players to understand position formats
      console.log("All roster players:", players.map(p => ({ 
        name: p.fullName, 
        position: p.position, 
        lineupSlot: p.lineupSlotId,
        projected: p.projectedPoints,
        actual: p.points 
      })));
      
      underperformers = players
        .filter((p: any) => {
          // Filter out bench players and players without projections
          return p.lineupSlotId !== 20 && 
                 p.projectedPoints && 
                 p.points < p.projectedPoints * 0.8 &&
                 (p.projectedPoints - p.points) >= 2; // Minimum 2 point underperformance (lowered threshold)
        })
        .map((p: any) => ({
          player: p.fullName,
          position: p.position,
          expectedPts: p.projectedPoints,
          actualPts: p.points,
          pointDifferential: p.projectedPoints - p.points,
          isDefense: isDefensePosition(p.position),
        }))
        .sort((a, b) => {
          // Primary sort: Point differential (bigger underperformance first)
          const diffA = a.pointDifferential;
          const diffB = b.pointDifferential;
          
          // If point differentials are close (within 2 points), prioritize skill positions
          if (Math.abs(diffA - diffB) <= 2) {
            if (a.isDefense && !b.isDefense) return 1; // b (skill position) comes first
            if (!a.isDefense && b.isDefense) return -1; // a (skill position) comes first
          }
          
          // Otherwise, sort by point differential magnitude
          return diffB - diffA;
        })
        .slice(0, 3);
      
      console.log(`Final underperformers for comment generation:`, underperformers.map((u: any) => ({
        player: u.player,
        position: u.position,
        differential: u.pointDifferential,
        isDefense: u.isDefense
      })));

      overperformers = players
        .filter((p: any) => {
          // Filter out bench players and players without projections
          return p.lineupSlotId !== 20 && 
                 p.projectedPoints && 
                 p.points > p.projectedPoints * 1.2 &&
                 (p.points - p.projectedPoints) >= 2; // Minimum 2 point overperformance (lowered threshold)
        })
        .map((p: any) => ({
          player: p.fullName,
          position: p.position,
          expectedPts: p.projectedPoints,
          actualPts: p.points,
          pointDifferential: p.points - p.projectedPoints,
          isDefense: isDefensePosition(p.position),
        }))
        .sort((a, b) => {
          // Primary sort: Point differential (bigger overperformance first)
          const diffA = a.pointDifferential;
          const diffB = b.pointDifferential;
          
          // If point differentials are close (within 2 points), prioritize skill positions
          if (Math.abs(diffA - diffB) <= 2) {
            if (a.isDefense && !b.isDefense) return 1; // b (skill position) comes first
            if (!a.isDefense && b.isDefense) return -1; // a (skill position) comes first
          }
          
          // Otherwise, sort by point differential magnitude
          return diffB - diffA;
        })
        .slice(0, 3);

      // Bench points and the one bench player worth asking about (spec §5). Same
      // reducer as the article path in aiQueries.ts (~L1938), copied rather than
      // imported so the two paths stay independently editable.
      const benchPlayers = players.filter((p: any) => p.lineupSlotId === BENCH_SLOT_ID);
      const starters = players.filter((p: any) => p.lineupSlotId !== BENCH_SLOT_ID);
      benchPoints = benchPlayers.reduce((sum: number, p: any) => sum + (p.points || 0), 0);

      const bestBench = [...benchPlayers].sort((a: any, b: any) => (b.points || 0) - (a.points || 0))[0];
      if (bestBench && (bestBench.points || 0) > 0) {
        topBenchPlayer = {
          player: bestBench.fullName,
          position: bestBench.position,
          points: bestBench.points || 0,
          projectedPoints: bestBench.projectedPoints,
        };
      }

      // A bench player who outscored the worst starter at the same position by a
      // meaningful margin. Mirrors `impactfulBenchPlayers` in aiQueries.ts (~L1920).
      const worstStarterAt = (position: string) => {
        const same = starters.filter((s: any) => s.position === position);
        if (same.length === 0) return null;
        return [...same].sort((a: any, b: any) => (a.points || 0) - (b.points || 0))[0];
      };

      lineupDecisions = benchPlayers
        .filter((benchPlayer: any) => {
          if ((benchPlayer.points || 0) < 15) return false;
          const worst = worstStarterAt(benchPlayer.position);
          if (!worst) return false;
          return (benchPlayer.points || 0) - (worst.points || 0) >= 10;
        })
        .sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
        .slice(0, 2)
        .map((benchPlayer: any) => {
          const worst = worstStarterAt(benchPlayer.position)!;
          return {
            benchedPlayer: benchPlayer.fullName,
            benchedPoints: benchPlayer.points || 0,
            startedPlayer: worst.fullName,
            startedPoints: worst.points || 0,
            position: benchPlayer.position,
            pointGain: Math.round(((benchPlayer.points || 0) - (worst.points || 0)) * 10) / 10,
          };
        });
    }

    if (teamScore > 0 && opponentScoreOut !== undefined) {
      margin = Math.round(Math.abs(teamScore - opponentScoreOut) * 10) / 10;
    }

    if (opponentExternalId) {
      const opponentTeam = await ctx.db
        .query("teams")
        .withIndex("by_external", q =>
          q.eq("leagueId", request.leagueId)
           .eq("externalId", opponentExternalId!)
           .eq("seasonId", seasonIdUsed)
        )
        .first();
      opponentName = opponentTeam?.name;
    }

    // Build standings for the given season
    const allTeams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => q.eq("leagueId", request.leagueId).eq("seasonId", seasonIdUsed))
      .collect();

    const standings = allTeams
      .sort((a, b) => {
        // Sort by wins first
        if (a.record.wins !== b.record.wins) {
          return (b.record.wins || 0) - (a.record.wins || 0);
        }
        // Then by win percentage
        const aTotalGames = (a.record.wins || 0) + (a.record.losses || 0) + (a.record.ties || 0);
        const bTotalGames = (b.record.wins || 0) + (b.record.losses || 0) + (b.record.ties || 0);
        const aWinPct = aTotalGames > 0 ? (a.record.wins || 0) / aTotalGames : 0;
        const bWinPct = bTotalGames > 0 ? (b.record.wins || 0) / bTotalGames : 0;
        if (aWinPct !== bWinPct) {
          return bWinPct - aWinPct;
        }
        // Then by points for (tiebreaker)
        return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
      })
      .map((t, idx) => ({
        teamId: t._id,
        teamName: t.name,
        rank: idx + 1,
        record: `${t.record.wins || 0}-${t.record.losses || 0}${t.record.ties ? `-${t.record.ties}` : ''}`,
      }));

    // Get draft data with isRookie information for draft-related content types
    let draftData = undefined;
    if (request.contentType === 'draft_rankings' || request.contentType === 'mock_draft') {
      // First try to use articleContext data if it has complete draft picks with isRookie info
      if (request.articleContext.userDraftPicks && request.articleContext.userDraftPicks.length > 0) {
        draftData = {
          draftType: request.articleContext.draftType,
          draftOrder: request.articleContext.draftOrder,
          userDraftPicks: request.articleContext.userDraftPicks,
        };
      } else {
        // Fallback to fetching from database if articleContext doesn't have complete data
        try {
          const { getSimplifiedDraftDataImpl } = await import('./draftRankingsHelpers');
          const simplifiedDraftData = await getSimplifiedDraftDataImpl(ctx, {
            leagueId: request.leagueId,
            seasonId: seasonIdUsed,
          });
          
          // Find user's draft picks with complete isRookie information
          const userDraftPicks = simplifiedDraftData.draftPicks.filter(pick => 
            pick.teamName === team?.name || pick.teamOwner === user?.name
          );
          
          draftData = {
            draftType: simplifiedDraftData.leagueInfo.draftType,
            draftOrder: simplifiedDraftData.draftOrder,
            userDraftPicks,
            allDraftPicks: simplifiedDraftData.draftPicks, // Include all picks for context
          };
        } catch (error) {
          console.warn("Failed to load draft data for conversation context:", error);
        }
      }
    }

    /* ---------------------------------------------------------------------- */
    /* League activity Sam can open on (spec §5)                               */
    /* ---------------------------------------------------------------------- */

    const teamNumericId = teamExternalId ? Number(teamExternalId) : NaN;

    // Adds, drops and FAAB bids this scoring period. `bidAmount` is the number behind
    // the waiver opener ("You spent $47 of your FAAB").
    const transactionsThisWeek: Array<{
      type: string;
      playersAdded: string[];
      playersDropped: string[];
      bidAmount?: number;
      timestamp?: number;
    }> = [];

    if (!Number.isNaN(teamNumericId) && week > 0) {
      const periodTransactions = await ctx.db
        .query("transactions")
        .withIndex("by_scoring_period", q =>
          q.eq("leagueId", request.leagueId)
           .eq("seasonId", seasonIdUsed)
           .eq("scoringPeriod", week)
        )
        .filter(q =>
          q.and(
            q.eq(q.field("teamId"), teamNumericId),
            q.neq(q.field("type"), "DRAFT"),
            q.neq(q.field("type"), "ROSTER")
          )
        )
        .take(10);

      // One lookup per distinct player across all of this team's transactions.
      const playerNames = new Map<number, string>();
      for (const transaction of periodTransactions) {
        for (const item of transaction.items) {
          if (playerNames.has(item.playerId)) continue;
          const player = await ctx.db
            .query("playersEnhanced")
            .withIndex("by_espn_id_season", q =>
              q.eq("espnId", String(item.playerId)).eq("season", seasonIdUsed)
            )
            .first();
          if (player) playerNames.set(item.playerId, player.fullName);
        }
      }

      for (const transaction of periodTransactions) {
        const playersAdded: string[] = [];
        const playersDropped: string[] = [];
        for (const item of transaction.items) {
          const name = playerNames.get(item.playerId);
          if (!name) continue;
          if (item.type === "ADD") playersAdded.push(name);
          else if (item.type === "DROP") playersDropped.push(name);
        }
        if (playersAdded.length === 0 && playersDropped.length === 0) continue;
        transactionsThisWeek.push({
          type: transaction.type,
          playersAdded,
          playersDropped,
          bidAmount: transaction.bidAmount > 0 ? transaction.bidAmount : undefined,
          timestamp: transaction.proposedDate,
        });
      }
    }

    // Recent completed trades involving this team this season, newest first. The
    // `trades` table carries no week, so the prompt states the counterparty and the
    // players and never claims a week for them.
    const tradesThisWeek: Array<{
      withTeam: string;
      gave: string[];
      received: string[];
      timestamp?: number;
    }> = [];

    if (teamExternalId) {
      const seasonTrades = await ctx.db
        .query("trades")
        .withIndex("by_season", q =>
          q.eq("leagueId", request.leagueId).eq("seasonId", seasonIdUsed)
        )
        .take(100);

      const involving = seasonTrades
        .filter(t =>
          (t.status === "accepted" || t.status === "completed") &&
          (t.teamA.teamId === teamExternalId || t.teamB.teamId === teamExternalId)
        )
        .sort((a, b) => b.tradeDate - a.tradeDate)
        .slice(0, 2);

      for (const trade of involving) {
        const isTeamA = trade.teamA.teamId === teamExternalId;
        tradesThisWeek.push({
          withTeam: isTeamA ? trade.teamB.teamName : trade.teamA.teamName,
          gave: (isTeamA ? trade.playersFromTeamA : trade.playersFromTeamB).map(p => p.playerName),
          received: (isTeamA ? trade.playersFromTeamB : trade.playersFromTeamA).map(p => p.playerName),
          timestamp: trade.tradeDate,
        });
      }
    }

    // All-time head-to-head against this week's opponent, when a rivalry row exists.
    let rivalry: { opponent: string; allTimeRecord: string } | undefined;
    if (teamExternalId && opponentExternalId && opponentName) {
      const rivalryRow =
        (await ctx.db
          .query("rivalries")
          .withIndex("by_teams", q =>
            q.eq("leagueId", request.leagueId)
             .eq("teamA.teamId", teamExternalId!)
             .eq("teamB.teamId", opponentExternalId!)
          )
          .first()) ??
        (await ctx.db
          .query("rivalries")
          .withIndex("by_teams", q =>
            q.eq("leagueId", request.leagueId)
             .eq("teamA.teamId", opponentExternalId!)
             .eq("teamB.teamId", teamExternalId!)
          )
          .first());

      if (rivalryRow) {
        const isTeamA = rivalryRow.teamA.teamId === teamExternalId;
        const wins = isTeamA ? rivalryRow.allTimeRecord.teamAWins : rivalryRow.allTimeRecord.teamBWins;
        const losses = isTeamA ? rivalryRow.allTimeRecord.teamBWins : rivalryRow.allTimeRecord.teamAWins;
        const ties = rivalryRow.allTimeRecord.ties;
        rivalry = {
          opponent: opponentName,
          allTimeRecord: ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`,
        };
      }
    }

    // What this manager has already said on the record, so Sam doesn't re-ask and the
    // writer can note "as he told us in Week 4".
    const priorResponses = await ctx.db
      .query("commentResponses")
      .withIndex("by_user", q => q.eq("userId", request.targetUserId))
      .order("desc")
      .take(8);

    const priorQuotes: Array<{ week?: number; text: string; askedAbout?: string }> = [];
    for (const response of priorResponses) {
      if (response.leagueId !== request.leagueId) continue;
      if (response.commentRequestId === args.commentRequestId) continue;
      const text =
        response.approvedQuotes?.[0] ??
        response.relevanceMetadata.extractedQuotes?.[0] ??
        response.processedResponse;
      if (!text) continue;
      const priorRequest = await ctx.db.get(response.commentRequestId);
      priorQuotes.push({
        week: priorRequest?.articleContext.week,
        text: text.length > 240 ? `${text.slice(0, 239)}…` : text,
        askedAbout: response.relevanceMetadata.suggestedUsage,
      });
      if (priorQuotes.length >= 3) break;
    }

    /* ---------------------------------------------------------------------- */
    /* The writer this interview feeds (spec §5 / §6)                          */
    /* ---------------------------------------------------------------------- */

    const writerPersona = request.writerPersona ?? DEFAULT_WRITER_PERSONA;

    const relationshipRow = await ctx.db
      .query("writerRelationships")
      .withIndex("by_league_user_persona", q =>
        q.eq("leagueId", request.leagueId)
         .eq("userId", request.targetUserId)
         .eq("persona", writerPersona)
      )
      .unique();

    const writerEvents = await ctx.db
      .query("relationshipEvents")
      .withIndex("by_league_user_persona", q =>
        q.eq("leagueId", request.leagueId)
         .eq("userId", request.targetUserId)
         .eq("persona", writerPersona)
      )
      .order("desc")
      .take(20);

    const recentMentions: Array<{
      week?: number;
      stance: "roast" | "praise";
      evidence: string;
      articleTitle?: string;
    }> = [];

    for (const event of writerEvents) {
      if (event.type !== "article_roast" && event.type !== "article_praise") continue;
      // Last 3 weeks only; week-less events (offseason pieces) are always eligible.
      if (week > 0 && event.week !== undefined && event.week <= week - 3) continue;
      const article = event.articleId ? await ctx.db.get(event.articleId) : null;
      recentMentions.push({
        week: event.week,
        stance: event.type === "article_roast" ? "roast" : "praise",
        evidence: event.evidence,
        articleTitle: article?.title,
      });
      if (recentMentions.length >= 2) break;
    }

    const writerContext = {
      persona: writerPersona,
      name: writerDisplayName(writerPersona),
      relationship: {
        score: relationshipRow?.score ?? 0,
        tier: relationshipRow?.tier ?? ("neutral" as const),
      },
      recentMentions,
    };

    // Debug logging for team identification in buildConversationContext
    console.log("buildConversationContext team identification debug:", {
      userId: request.targetUserId,
      teamFound: !!team,
      teamId: team?._id,
      teamName: team?.name,
      teamExternalId: team?.externalId,
      seasonIdUsed,
      standingsCount: standings.length,
      standingsTeamIds: standings.map(s => s.teamId).slice(0, 3), // First 3 for debugging
    });

    return {
      userId: request.targetUserId,
      leagueId: request.leagueId,
      scheduledContentId: request.scheduledContentId,
      contentType: request.contentType,
      week,
      seasonId: seasonIdUsed,
      leagueName: league?.name || "League",

      // Identity (spec §5) - the interviewer is always Sam Ortega.
      managerName: user?.name || user?.email || "Unknown manager",
      teamName: team?.name || "Unknown Team",
      interviewerPersona: request.interviewerPersona ?? INTERVIEWER_PERSONA,
      writerPersona,

      // The matchup, in the detail that makes an opener specific.
      opponentName,
      opponentScore: opponentScoreOut,
      margin,
      benchPoints,
      topBenchPlayer,
      lineupDecisions,

      // League activity.
      transactionsThisWeek,
      tradesThisWeek,
      rivalry,
      priorQuotes,
      writerContext,

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
      conversationHistory, // Include conversation history for follow-ups
      draftData, // Include complete draft data with isRookie information
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
      return ["team performance", "key decisions", "player disappointments", "lucky breaks", "memorable moments"];
    case "weekly_preview":
      return ["matchup strategy", "key players to watch", "injury concerns", "bold predictions"];
    case "trade_analysis":
      return ["trade rationale", "immediate impact", "future outlook", "negotiation process", "winner assessment"];
    case "waiver_wire_report":
      return ["waiver priorities", "FAAB strategy", "missed opportunities", "sleeper picks", "drop candidates"];
    case "power_rankings":
      return ["team trajectory", "biggest surprises", "overperformers", "underperformers"];
    case "draft_rankings":
      return ["draft strategy", "best picks", "worst picks", "steals and reaches"];
    case "championship_manifesto":
      return ["season highlights", "key turning points", "championship strategy", "trash talk"];
    case "season_recap":
      return ["season highlights", "biggest disappointments", "memorable trades", "rivalry moments"];
    default:
      return ["general thoughts", "key insights", "team updates", "future plans"];
  }
}

function getConversationGoals(contentType: string): string[] {
  switch (contentType) {
    case "weekly_recap":
      return [
        "Get specific player performance reactions",
        "Understand key lineup decisions that impacted outcomes",
        "Capture emotional responses to wins/losses",
        "Extract memorable quotes about specific moments",
      ];
    case "weekly_preview":
      return [
        "Understand matchup strategy and game plans",
        "Get bold predictions for the week",
        "Capture trash talk between opponents",
        "Identify key players teams are relying on",
      ];
    case "trade_analysis":
      return [
        "Understand the motivation behind the trade",
        "Get both sides' perspectives on value",
        "Capture negotiation details",
        "Assess who won the trade",
      ];
    case "waiver_wire_report":
      return [
        "Identify priority waiver targets",
        "Understand FAAB bidding strategies",
        "Get reactions to waiver claims",
        "Extract sleeper picks",
      ];
    case "power_rankings":
      return [
        "Get reactions to current ranking",
        "Understand team trajectory",
        "Capture disagreements with rankings",
        "Extract hot takes on teams",
      ];
    case "draft_rankings":
      return [
        "Reflect on draft day strategy",
        "Identify best and worst picks",
        "Capture draft day regrets",
        "Extract lessons learned",
      ];
    default:
      return ["Gather relevant insights", "Get quotable content", "Capture memorable reactions"];
  }
}

function getInitialFocus(contentType: string): string {
  switch (contentType) {
    case "weekly_recap":
      return "your specific player performances, lineup decisions, and key moments from this week";
    case "weekly_preview":
      return "your strategy for this week's matchup and any predictions";
    case "trade_analysis":
      return "the reasoning behind this trade and expected impact";
    case "waiver_wire_report":
      return "your waiver wire strategy and priority targets";
    case "power_rankings":
      return "your team's current performance and ranking position";
    case "draft_rankings":
      return "your draft strategy, best picks, and any regrets";
    case "championship_manifesto":
      return "your championship victory or season highlights";
    case "season_recap":
      return "your season highlights and most memorable moments";
    default:
      return "relevant insights and reactions for the upcoming article";
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
        const aiResult = await ctx.runAction(internal.aiNode.generateConversationQuestion, { context });
        
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
            generationModel: "claude-opus-5",
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
          writerPersona: request.writerPersona,
          week: request.articleContext?.week ?? context.week,
          deadline: request.articleGenerationTime,
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
      // Both expiry paths use the article generation time (spec §5). The old
      // 15-minutes-early cutoff silenced managers who answered inside the window
      // the UI had promised them, and disagreed with the manual path.
      await ctx.scheduler.runAt(scheduledContent.scheduledFor, internal.commentRequests.expireOldRequests, {
        scheduledContentId: args.scheduledContentId,
      });
    }
  },
});

// No src/ caller - internal only.
export const getRequestsForLeague = internalQuery({
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

// No src/ caller - internal only.
export const getConversationContext = internalQuery({
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
      .filter((p: any) => {
        // Filter out bench players and players without projections
        return p.lineupSlotId !== 20 && 
               p.projectedPoints && 
               p.points < p.projectedPoints * 0.8 &&
               (p.projectedPoints - p.points) >= 2; // Minimum 2 point underperformance
      })
      .map((p: any) => ({
        player: p.fullName,
        position: p.position,
        expectedPts: p.projectedPoints,
        actualPts: p.points,
        pointDifferential: p.projectedPoints - p.points,
        isDefense: isDefensePosition(p.position),
      }))
      .sort((a, b) => {
        // Primary sort: Point differential (bigger underperformance first)
        const diffA = a.pointDifferential;
        const diffB = b.pointDifferential;
        
        // If point differentials are close (within 2 points), prioritize skill positions
        if (Math.abs(diffA - diffB) <= 2) {
          if (a.isDefense && !b.isDefense) return 1; // b (skill position) comes first
          if (!a.isDefense && b.isDefense) return -1; // a (skill position) comes first
        }
        
        // Otherwise, sort by point differential magnitude
        return diffB - diffA;
      })
      .slice(0, 3);

    const overperformers = players
      .filter((p: any) => {
        // Filter out bench players and players without projections
        return p.lineupSlotId !== 20 && 
               p.projectedPoints && 
               p.points > p.projectedPoints * 1.2 &&
               (p.points - p.projectedPoints) >= 2; // Minimum 2 point overperformance
      })
      .map((p: any) => ({
        player: p.fullName,
        position: p.position,
        expectedPts: p.projectedPoints,
        actualPts: p.points,
        pointDifferential: p.points - p.projectedPoints,
        isDefense: isDefensePosition(p.position),
      }))
      .sort((a, b) => {
        // Primary sort: Point differential (bigger overperformance first)
        const diffA = a.pointDifferential;
        const diffB = b.pointDifferential;
        
        // If point differentials are close (within 2 points), prioritize skill positions
        if (Math.abs(diffA - diffB) <= 2) {
          if (a.isDefense && !b.isDefense) return 1; // b (skill position) comes first
          if (!a.isDefense && b.isDefense) return -1; // a (skill position) comes first
        }
        
        // Otherwise, sort by point differential magnitude
        return diffB - diffA;
      })
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
      .sort((a, b) => {
        // Sort by wins first
        if (a.record.wins !== b.record.wins) {
          return (b.record.wins || 0) - (a.record.wins || 0);
        }
        // Then by win percentage
        const aTotalGames = (a.record.wins || 0) + (a.record.losses || 0) + (a.record.ties || 0);
        const bTotalGames = (b.record.wins || 0) + (b.record.losses || 0) + (b.record.ties || 0);
        const aWinPct = aTotalGames > 0 ? (a.record.wins || 0) / aTotalGames : 0;
        const bWinPct = bTotalGames > 0 ? (b.record.wins || 0) / bTotalGames : 0;
        if (aWinPct !== bWinPct) {
          return bWinPct - aWinPct;
        }
        // Then by points for (tiebreaker)
        return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
      })
      .map((t, idx) => ({
        teamId: t._id,
        teamName: t.name,
        rank: idx + 1,
        record: `${t.record.wins || 0}-${t.record.losses || 0}${t.record.ties ? `-${t.record.ties}` : ''}`,
      }));

    // Check playoff context
    const isPlayoffWeek = matchup.playoffTier !== undefined && matchup.playoffTier !== null;
    const userInPlayoffs = isPlayoffWeek && matchup.playoffTier === "WINNERS_BRACKET";

    // Debug logging for team identification
    console.log("Team identification debug:", {
      userId: request.targetUserId,
      teamFound: !!team,
      teamId: team?._id,
      teamName: team?.name,
      teamExternalId: team?.externalId,
      standingsCount: standings.length,
      standingsTeamIds: standings.map(s => s.teamId).slice(0, 3), // First 3 for debugging
    });

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

// No src/ caller - internal only. (Distinct from commentConversations.getActiveRequests.)
export const getActiveRequests = internalQuery({
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

// Get a specific comment request by ID (any status) with light enrichment.
// Used by the comment-request response page, so readable only by the
// request's target user or a commissioner of its league.
export const getRequestById = query({
  args: { commentRequestId: v.id("commentRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return null;

    const identity = await ctx.auth.getUserIdentity();
    let isTargetUser = false;
    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
        .unique();
      isTargetUser = !!user && user._id === request.targetUserId;
    }

    if (!isTargetUser) {
      const membership = await getLeagueMembership(ctx, request.leagueId);
      if (!membership || membership.membership.role !== "commissioner") {
        return null;
      }
    }

    const scheduledContent = request.scheduledContentId ? await ctx.db.get(request.scheduledContentId) : null;
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

// Get comment requests for a league. No src/ caller - internal only.
export const getLeagueCommentRequests = internalQuery({
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
        const scheduledContent = request.scheduledContentId ? await ctx.db.get(request.scheduledContentId) : null;
        
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

    await requireCommissioner(ctx, scheduledContent.leagueId);

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