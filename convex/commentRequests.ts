import { v } from "convex/values";
import { mutation, query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import type { ConversationContext } from "../src/lib/ai/conversation-service";
// Type-only: never a value import from a convex/*.ts module here (see the repo-wide gotcha about
// `internal` recursion). `WaiverLedger` is a plain interface with no runtime footprint.
import type { WaiverLedger } from "../src/lib/ai/prompt-builder";
import { getLeagueMembership, requireCommissioner } from "./lib/auth";
import { leagueCurrentSeason } from "./lib/season";
import { espnConnectionBlocked } from "./lib/espnConnection";

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
 * Display names for the seven writers. Duplicated here rather than imported from
 * `src/lib/ai/persona-prompts.ts`: that module carries prompt copy, and Convex isolate
 * code must not depend on it. Keep in sync when the roster changes (spec §3).
 */
const WRITER_NAMES: Record<string, string> = {
  "curtis-vaughn": "Curtis Vaughn",
  "sam-ortega": "Sam Ortega",
  "nina-sharpe": "Nina Sharpe",
  "dex-alvarez": "Dex Alvarez",
  "mel-diaper": "Mel Diaper",
  "reggie-banks": "Reggie Banks",
  "walt-brennan": "Walt Brennan",
};

function writerDisplayName(slug: string): string {
  return WRITER_NAMES[slug] ?? WRITER_NAMES[DEFAULT_WRITER_PERSONA];
}

/** ESPN bench lineup slot. Shared by the bench-points and lineup-decision reducers. */
const BENCH_SLOT_ID = 20;
/** ESPN injured-reserve slot. Never a starter, never the bench (interview harness, Sept 2026). */
const IR_SLOT_ID = 21;
const NON_STARTER_SLOTS = new Set([BENCH_SLOT_ID, IR_SLOT_ID]);

/**
 * Interviews for these types are about a finished week: they wait for ESPN to finalize it
 * (mirrors `LOOKBACK_CONTENT` in contentScheduling.ts, kept separate so this module never
 * value-imports one that references `internal`).
 */
const LOOKBACK_INTERVIEW_TYPES = new Set([
  "weekly_recap",
  "power_rankings",
  "waiver_wire_report",
  "bank_statement",
  "mid_season_awards",
  "hall_of_shame",
]);
const WEEK_FINAL_RECHECK_MS = 30 * 60 * 1000;
/** Managers get at least this long to answer; below it we print without interviews. */
const MIN_INTERVIEW_WINDOW_MS = 60 * 60 * 1000;

/** A transaction that actually happened. Lost, withdrawn and still-pending claims are not moves. */
function transactionExecuted(tx: { outcome?: string; status: string; isPending: boolean }): boolean {
  if (tx.outcome) return tx.outcome === "executed";
  return !tx.isPending && tx.status === "EXECUTED";
}

function normalizeQuoteText(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The first prior quote that is provably something the manager typed: an approved or
 * edited review entry, an approved quote, or a ledger quote that is a verbatim span of
 * the raw reply. Last season's ledger rows carry topic labels ("draft strategy") where
 * quotes should be, and the old fallback to `processedResponse` handed Sam the whole raw
 * reply - neither may be read back to a manager as "already on the record".
 */
function verbatimPriorQuote(response: Doc<"commentResponses">): string | undefined {
  const raw = normalizeQuoteText(response.rawResponse);
  const review = response.quoteReview ?? [];
  const candidates = [
    ...review.filter(q => q.status === "approved").map(q => q.text),
    ...(response.approvedQuotes ?? []),
    ...(response.relevanceMetadata.extractedQuotes ?? []),
  ];
  for (const candidate of candidates) {
    const needle = normalizeQuoteText(candidate);
    if (needle.length >= 12 && raw.includes(needle)) return candidate;
  }
  // An edited entry is the manager's own rewrite of their words; it need not be a span.
  const edited = review.find(q => q.status === "edited")?.text;
  return edited && edited.trim().length > 0 ? edited : undefined;
}

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

    // Same gate as `contentSchedulingIntegration.onContentScheduled` - this
    // mutation also fires from a delayed `ctx.scheduler.runAt`, so the league
    // or the row's own flags may have changed since it was queued (owner
    // directive, Sept 2026: never reach out for comment on a blocked or
    // weeks-old row).
    if (espnConnectionBlocked(league)) {
      console.log(`Skipping comment requests for ${args.scheduledContentId}: ESPN connection blocked for league ${scheduledContent.leagueId}`);
      return { created: false, reason: "espn_connection_blocked" as const };
    }
    if (scheduledContent.skipCommentRequests) {
      return { created: false, reason: "skip_comment_requests" as const };
    }
    if (scheduledContent.status !== "pending" && scheduledContent.status !== "generating") {
      return { created: false, reason: "row_not_pending" as const };
    }

    const scheduledSendTime = Date.now(); // Send immediately
    const currentTime = Date.now();

    // The season this article is about (teams/claims are per-season - see the
    // note on `userTeam` below), falling back to the league's current season
    // for rows written before this field was stamped.
    const articleSeason =
      scheduledContent.contextData?.seasonId ??
      scheduledContent.seasonId ??
      leagueCurrentSeason(league);

    // A recap, ranking or waiver report is about a finished week. Interviews used to go
    // out one window before print - for a Tuesday 09:00 recap that is Monday 21:00, in
    // the middle of Monday Night Football, with a score that was still moving. Wait for
    // ESPN to finalize the week (the same rule the article itself waits on), re-checking
    // every 30 minutes while at least an hour of interview window is left; past that,
    // the article prints without interviews rather than with wrong ones.
    const articleWeek = scheduledContent.contextData?.week ?? scheduledContent.week;
    if (LOOKBACK_INTERVIEW_TYPES.has(scheduledContent.contentType) && articleWeek) {
      const finality: { final: boolean; reason: string } = await ctx.runQuery(
        internal.contentScheduling.isWeekFinal,
        { leagueId: scheduledContent.leagueId, seasonId: articleSeason, week: articleWeek }
      );
      if (!finality.final) {
        const retryAt = Date.now() + WEEK_FINAL_RECHECK_MS;
        if (retryAt <= scheduledContent.scheduledFor - MIN_INTERVIEW_WINDOW_MS) {
          await ctx.scheduler.runAt(retryAt, internal.commentRequests.createRequestsForScheduledContent, args);
          console.log(
            `Week ${articleWeek} not final for ${args.scheduledContentId} (${finality.reason}); re-checking at ${new Date(retryAt).toISOString()}`
          );
          return { created: false, reason: "week_not_final_deferred" as const, retryAt };
        }
        console.log(`Week ${articleWeek} not final for ${args.scheduledContentId} (${finality.reason}); printing without interviews`);
        return { created: false, reason: "week_not_final" as const };
      }
    }

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

        // Get user's team for context. `userId` here is `Id<"users">`, never a
        // Clerk id, and `teams.owner` is always an ESPN owner display name
        // (e.g. "Gabe Coscia") - never compare the two directly. The real link
        // is `teamClaims`: users doc -> its Clerk id -> that league's active
        // claim for this article's season -> the claimed team.
        let userTeam = null;
        const targetUser = await ctx.db.get(userId);
        if (targetUser) {
          const userClaims = await ctx.db
            .query("teamClaims")
            .withIndex("by_user", q => q.eq("userId", targetUser.clerkId))
            .collect();
          const claim = userClaims.find(
            c =>
              c.leagueId === scheduledContent.leagueId &&
              c.seasonId === articleSeason &&
              c.status === "active"
          );
          if (claim) {
            userTeam = await ctx.db.get(claim.teamId);
          }
        }

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
    // The season the story is about; a request stamped without one means the current season.
    const targetSeason = request.articleContext.seasonId ?? leagueCurrentSeason(league);
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

    // The matchup is pinned to the article's season. This used to key on league + week
    // across EVERY season and prefer whichever season had a score, so a preview, or a
    // recap asked for before ESPN finalized the week, was answered with LAST season's
    // week-N game - opponent, score, bench and waiver moves included (the interview
    // harness caught it on every 2026 scenario). A matchup is decided only when ESPN has
    // stamped a winner (or it belongs to a past season and has a score); an undecided one
    // contributes the opponent's name and nothing else.
    const leagueSeasonNow = league ? leagueCurrentSeason(league) : targetSeason;
    const isPastSeason = targetSeason < leagueSeasonNow;
    const seasonMatchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", q => q.eq("leagueId", request.leagueId).eq("seasonId", targetSeason))
      .collect();

    const matchupIsDecided = (m: { winner?: string; homeScore: number; awayScore: number }) =>
      m.winner !== undefined || (isPastSeason && (m.homeScore > 0 || m.awayScore > 0));

    const matchup =
      week > 0 && teamExternalId
        ? seasonMatchups.find(
            m => m.matchupPeriod === week && (m.homeTeamId === teamExternalId || m.awayTeamId === teamExternalId)
          ) ?? null
        : null;
    const matchupDecided = !!matchup && matchupIsDecided(matchup);

    const seasonIdUsed = targetSeason;

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

    // Who they play, when the game is not final: a preview names the opponent, never a score.
    let upcomingOpponentName: string | undefined;
    if (matchup && teamExternalId && !matchupDecided) {
      opponentExternalId = matchup.homeTeamId === teamExternalId ? matchup.awayTeamId : matchup.homeTeamId;
    }

    if (matchup && teamExternalId && matchupDecided) {
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
          // Starters only: bench (20) and IR (21) never "underperformed"
          return !NON_STARTER_SLOTS.has(p.lineupSlotId) &&
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
          // Starters only: bench (20) and IR (21) never "overperformed"
          return !NON_STARTER_SLOTS.has(p.lineupSlotId) &&
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
      // IR (slot 21) is neither: a player on IR with 0 points was being reported as the
      // "worst starter at the position", which turned every healthy bench player into a
      // lineup mistake (48 real weeks of the 2025 season, per the interview harness).
      const starters = players.filter((p: any) => !NON_STARTER_SLOTS.has(p.lineupSlotId));
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
      if (!matchupDecided) upcomingOpponentName = opponentName;
    }

    // Standings as of the article's week, tallied from this season's decided matchups.
    // `teams.record` is whatever the last sync wrote: the final record when a story looks
    // back at an earlier week, a stale one when the interview lands before the sync - a
    // manager was told he was "#4" the week he was #1. Regular-season games only; a
    // request with no week (draft, offseason) gets the standings as they stand.
    const allTeams = await ctx.db
      .query("teams")
      .withIndex("by_season", q => q.eq("leagueId", request.leagueId).eq("seasonId", seasonIdUsed))
      .collect();

    const regularSeasonWeeks: number = league?.settings?.regularSeasonMatchupPeriods ?? 14;
    const throughWeek = week > 0 ? Math.min(week, regularSeasonWeeks) : regularSeasonWeeks;
    const tally = new Map<string, { wins: number; losses: number; ties: number; pointsFor: number }>();
    for (const t of allTeams) tally.set(t.externalId, { wins: 0, losses: 0, ties: 0, pointsFor: 0 });
    for (const m of seasonMatchups) {
      if (m.matchupPeriod > throughWeek || !matchupIsDecided(m)) continue;
      const home = tally.get(m.homeTeamId);
      const away = tally.get(m.awayTeamId);
      if (!home || !away) continue;
      home.pointsFor += m.homeScore;
      away.pointsFor += m.awayScore;
      const winner =
        m.winner ?? (m.homeScore > m.awayScore ? "home" : m.awayScore > m.homeScore ? "away" : "tie");
      if (winner === "home") {
        home.wins++;
        away.losses++;
      } else if (winner === "away") {
        away.wins++;
        home.losses++;
      } else {
        home.ties++;
        away.ties++;
      }
    }

    const standings = allTeams
      .map(t => ({ team: t, rec: tally.get(t.externalId)! }))
      .sort(
        (a, b) =>
          b.rec.wins - a.rec.wins ||
          b.rec.pointsFor - a.rec.pointsFor ||
          a.team.name.localeCompare(b.team.name)
      )
      .map(({ team: t, rec }, idx) => ({
        teamId: t._id,
        teamName: t.name,
        rank: idx + 1,
        record: `${rec.wins}-${rec.losses}${rec.ties ? `-${rec.ties}` : ''}`,
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
        .take(40);

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
        // Only moves that happened. Lost, withdrawn and still-pending claims were listed
        // as pickups ("added Woody Marks for $21" on a claim that lost), so Sam asked
        // managers to walk her through players they never got. Losing bids are stated as
        // such by the waiver ledger below.
        if (!transactionExecuted(transaction)) continue;
        if (transactionsThisWeek.length >= 10) break;
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

      // A trade article is about the trade, whenever it happened. Every other story only
      // gets trades from this week or last - a week-1 recap was opening on a trade from
      // week 9 of the previous season, and a mid-season recap on one from weeks earlier.
      const isTradeStory =
        request.contentType === "trade_analysis" ||
        request.contentType === "trade_block_tuesday" ||
        request.contentType === "trade_rumor_mill";
      const tradeIsCurrent = (t: { week?: number }) =>
        isTradeStory || (t.week !== undefined && week > 0 && t.week >= week - 1 && t.week <= week);

      const involving = seasonTrades
        .filter(t =>
          (t.status === "accepted" || t.status === "completed") &&
          (t.teamA.teamId === teamExternalId || t.teamB.teamId === teamExternalId) &&
          tradeIsCurrent(t)
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
      const priorRequest = await ctx.db.get(response.commentRequestId);
      // This season only. What a manager said about last year's team is not context for
      // this one, and it is where the label-shaped "quotes" of the old ledger live.
      if (priorRequest?.articleContext.seasonId !== seasonIdUsed) continue;
      const text = verbatimPriorQuote(response);
      if (!text) continue;
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
      // Last 3 weeks only, and never a later week than the story's (a replay or a
      // backfill would otherwise hand Sam a line the writer has not written yet);
      // week-less events (offseason pieces) are always eligible.
      if (week > 0 && event.week !== undefined && (event.week <= week - 3 || event.week > week)) continue;
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

    /* ---------------------------------------------------------------------- */
    /* FAAB/waiver context (owner goal, 2026-09-02): this manager's remaining   */
    /* budget, their winning/losing claims from the latest processed run with   */
    /* competitors' bids, and season highlights - so Sam's opener can be         */
    /* specific ("You threw $23 at Bigsby and still have $61 - was that the      */
    /* plan?"). Only fetched for waiver-report interviews, where it is relevant. */
    /* Called through `internal.aiQueries` rather than importing                 */
    /* `buildWaiverLedger` as a value - a cross-module value import of a         */
    /* convex/*.ts module that references `internal` can make the generated api  */
    /* type recursive.                                                           */
    /* ---------------------------------------------------------------------- */
    let waiverBudget:
      | { budget?: number; spent?: number; remaining?: number; acquisitions?: number }
      | undefined;
    let waiverClaimsThisRun:
      | Array<{
          scoringPeriod: number;
          player: string;
          position?: string;
          result: "won" | "lost";
          bid: number;
          competingBids: Array<{ teamName: string; bid: number }>;
        }>
      | undefined;
    let waiverSeasonHighlights:
      | {
          biggestBid?: { teamName: string; player: string; bid: number; week: number };
          mostActive?: { teamName: string; acquisitions: number };
          lowestRemaining: Array<{ teamName: string; remaining: number }>;
        }
      | undefined;

    if (team && request.contentType === "waiver_wire_report" && week > 0) {
      // Explicit type annotation: a cross-module `ctx.runQuery(internal.aiQueries...)` call whose
      // result feeds back into this same handler's inferred return type can make the generated api
      // type recursive (repo-wide gotcha) - anchoring it here breaks the cycle.
      const ledger: WaiverLedger = await ctx.runQuery(internal.aiQueries.getWaiverLedgerForAI, {
        leagueId: request.leagueId,
        seasonId: seasonIdUsed,
        throughScoringPeriod: week,
      });
      const myTeamId = team._id;

      const myBudget = ledger.budgets.find(entry => entry.teamId === myTeamId);
      if (myBudget) {
        waiverBudget = {
          budget: myBudget.budget,
          spent: myBudget.spent,
          remaining: myBudget.remaining,
          acquisitions: myBudget.acquisitions,
        };
      }

      if (ledger.latestRun) {
        const claims: NonNullable<typeof waiverClaimsThisRun> = [];
        for (const claim of ledger.latestRun.claims) {
          if (claim.teamId === myTeamId) {
            claims.push({
              scoringPeriod: ledger.latestRun.scoringPeriod,
              player: claim.player.name,
              position: claim.player.pos,
              result: "won",
              bid: claim.bid,
              competingBids: claim.competingBids.map(bid => ({ teamName: bid.teamName, bid: bid.bid })),
            });
            continue;
          }
          const myLosingBid = claim.competingBids.find(bid => bid.teamId === myTeamId);
          if (myLosingBid) {
            claims.push({
              scoringPeriod: ledger.latestRun.scoringPeriod,
              player: claim.player.name,
              position: claim.player.pos,
              result: "lost",
              bid: myLosingBid.bid,
              competingBids: [{ teamName: claim.teamName, bid: claim.bid }],
            });
          }
        }
        if (claims.length > 0) waiverClaimsThisRun = claims;
      }

      if (
        ledger.season.biggestBid ||
        ledger.season.mostActive ||
        ledger.season.lowestRemaining.length > 0
      ) {
        waiverSeasonHighlights = {
          biggestBid: ledger.season.biggestBid
            ? {
                teamName: ledger.season.biggestBid.teamName,
                player: ledger.season.biggestBid.player,
                bid: ledger.season.biggestBid.bid,
                week: ledger.season.biggestBid.week,
              }
            : undefined,
          mostActive: ledger.season.mostActive
            ? { teamName: ledger.season.mostActive.teamName, acquisitions: ledger.season.mostActive.acquisitions }
            : undefined,
          lowestRemaining: ledger.season.lowestRemaining.map(entry => ({
            teamName: entry.teamName,
            remaining: entry.remaining,
          })),
        };
      }
    }

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
      upcomingOpponentName,
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

      // FAAB/waiver context (owner goal, 2026-09-02, waiver-report interviews only): this manager's
      // remaining budget, their winning/losing claims from the latest processed run with
      // competitors' bids, and season highlights. `ConversationContext`
      // (src/lib/ai/conversation-service.ts) does not yet declare these fields - wiring the
      // interview prompt to read them is a follow-up outside this change's file allowlist.
      waiverBudget,
      waiverClaimsThisRun,
      waiverSeasonHighlights,

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
      // A manager who replied but whose interview never formally closed (Sam's close
      // went unanswered, or the follow-up step failed) still gets their words in: build
      // the response row before the request is closed out.
      await ctx.runAction(internal.commentConversations.processCompletedResponse, {
        commentRequestId: request._id,
      });
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
    const request = await ctx.db.get(args.commentRequestId);
    if (!request) return;
    if (request.status !== "pending" && request.status !== "active") return;

    // Deadline. A manager who spoke goes to print with what they gave us; only a
    // request nobody answered is "expired". Telling someone who answered that the
    // article ran "without your input" was last season's most-reported complaint.
    const response = await ctx.db
      .query("commentResponses")
      .withIndex("by_comment_request", q => q.eq("commentRequestId", args.commentRequestId))
      .first();
    const now = Date.now();
    if (response) {
      // Silence is consent (spec §8.1): whatever the manager had not reviewed by the
      // deadline is approved here, so the scheduled path prints it too.
      if (response.quoteReview?.some(q => q.status === "pending")) {
        await ctx.db.patch(response._id, {
          quoteReview: response.quoteReview.map(q => (q.status === "pending" ? { ...q, status: "approved" as const } : q)),
          updatedAt: now,
        });
      }
      await ctx.db.patch(args.commentRequestId, {
        status: "completed",
        conversationState: "response_complete",
        completedAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(args.commentRequestId, {
        status: "expired",
        conversationState: "auto_ended",
        expiredAt: now,
        updatedAt: now,
      });
    }

    // Add system message
    const messages = await ctx.db
      .query("commentConversations")
      .withIndex("by_comment_request", q =>
        q.eq("commentRequestId", args.commentRequestId)
      )
      .collect();

    await ctx.db.insert("commentConversations", {
      commentRequestId: args.commentRequestId,
      leagueId: request.leagueId,
      userId: request.targetUserId,
      messageType: "system_message",
      content: response
        ? "We're at the deadline - going to print with what you gave us. Thanks."
        : "This comment request has expired. The article will be generated without your input.",
      messageOrder: messages.length,
      isRead: false,
      createdAt: now,
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
      // Manager identity lives in `teamClaims`, never `teams.owner` -
      // `teams.owner` is always an ESPN owner display name (e.g. "Gabe
      // Coscia"), not a Clerk id (same bug/fix as
      // `contentSchedulingIntegration.onContentScheduled`). Resolve through
      // this league's active claims for the article's season instead.
      const league = await ctx.db.get(scheduledContent.leagueId);
      const articleSeason =
        scheduledContent.contextData?.seasonId ??
        scheduledContent.seasonId ??
        leagueCurrentSeason(league);

      const claims = await ctx.db
        .query("teamClaims")
        .withIndex("by_league", (q) => q.eq("leagueId", scheduledContent.leagueId))
        .collect();
      const activeClaimClerkIds = Array.from(
        new Set(
          claims
            .filter((c) => c.seasonId === articleSeason && c.status === "active")
            .map((c) => c.userId)
        )
      ).slice(0, 5); // Limit to 5 users for testing

      const users = await Promise.all(
        activeClaimClerkIds.map(async (clerkId) => {
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