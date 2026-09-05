/**
 * Who Sam interviews for an article, and how long they get (spec section 9.1, owner
 * decisions of 2026-09-05). Shared by `contentSchedulingIntegration.onContentScheduled`
 * (which queues the requests when a row is created) and
 * `commentRequests.createRequestsForScheduledContent` (which resolves the managers again
 * at send time, so a list queued days earlier under older rules is never trusted).
 *
 * Manager identity lives in `teamClaims`, never `teams.owner`: `teams.owner` is an ESPN
 * display name, `teamClaims.userId` is a Clerk id keyed to `users.clerkId`.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type DbCtx = QueryCtx | MutationCtx;

/**
 * How long managers get to answer. The article never prints before the window has run:
 * when the requests go out late (a recap waits for ESPN to finalize the week; an event
 * article is scheduled minutes after its event) the print time moves out to send time +
 * window on the schedule's own hour.
 */
export const COMMENT_WINDOWS_MS: Record<string, number> = {
  weekly_recap: 24 * 60 * 60 * 1000, // a full day
  trade_analysis: 6 * 60 * 60 * 1000, // at least a few hours
  draft_rankings: 6 * 60 * 60 * 1000, // at least a few hours
};

/**
 * How many managers one article interviews. A recap and a draft piece ask everyone who
 * played or drafted, whatever the league size (the old cap of 8 skipped the same two
 * managers of a ten-team league every week). A trade article asks the two sides.
 */
export const MAX_REQUESTS: Record<string, number> = {
  weekly_recap: Number.POSITIVE_INFINITY,
  trade_analysis: 4,
  draft_rankings: Number.POSITIVE_INFINITY,
};

/**
 * Stories about a finished week. Their interviews wait for ESPN to finalize it, go out
 * one window before print, and observe quiet hours. Event stories (a trade, the draft)
 * reach out the moment the row exists, while the managers are still around.
 */
export const LOOKBACK_INTERVIEW_TYPES = new Set([
  "weekly_recap",
  "power_rankings",
  "waiver_wire_report",
  "bank_statement",
  "mid_season_awards",
  "hall_of_shame",
]);

export interface IntervieweeCounts {
  teams: number;
  claimed: number;
  targeted: number;
}

export async function resolveInterviewees(
  ctx: DbCtx,
  args: {
    leagueId: Id<"leagues">;
    season: number;
    contentType: string;
    week?: number;
    /** `scheduledContent.contextData.eventData` for a trade article: the two sides. */
    eventData?: { teamA?: { teamId?: unknown }; teamB?: { teamId?: unknown } } | null;
  }
): Promise<{ targetUserIds: Id<"users">[]; counts: IntervieweeCounts }> {
  // Teams are per-season documents: scope to (league, season) or every season's rows
  // come back and stale owner strings leak into selection.
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.season))
    .collect();
  if (teams.length === 0) return { targetUserIds: [], counts: { teams: 0, claimed: 0, targeted: 0 } };

  const claims = await ctx.db
    .query("teamClaims")
    .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
    .collect();
  const activeClaims = claims.filter((c) => c.seasonId === args.season && c.status === "active");

  const clerkIdByTeamId = new Map<Id<"teams">, string>();
  for (const claim of activeClaims) clerkIdByTeamId.set(claim.teamId, claim.userId);

  const userIdByClerkId = new Map<string, Id<"users">>();
  await Promise.all(
    Array.from(new Set(clerkIdByTeamId.values())).map(async (clerkId) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
        .unique();
      if (user) userIdByClerkId.set(clerkId, user._id);
    })
  );

  let selectedTeams: Doc<"teams">[] = teams;

  if (args.contentType === "weekly_recap" && args.week) {
    // Only the managers who actually played that week have anything to say.
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_unique_matchup", (q) =>
        q.eq("leagueId", args.leagueId).eq("seasonId", args.season).eq("matchupPeriod", args.week!)
      )
      .collect();
    const playing = new Set<string>();
    for (const matchup of matchups) {
      playing.add(matchup.homeTeamId);
      playing.add(matchup.awayTeamId);
    }
    const played = teams.filter((t) => t.externalId && playing.has(t.externalId));
    if (played.length > 0) selectedTeams = played;
  } else if (args.contentType === "trade_analysis") {
    // Both sides of the trade that triggered this article, and nobody else.
    const involved = new Set(
      [args.eventData?.teamA?.teamId, args.eventData?.teamB?.teamId].filter(
        (id): id is string => typeof id === "string"
      )
    );
    if (involved.size > 0) {
      const participants = teams.filter((t) => t.externalId && involved.has(t.externalId));
      if (participants.length > 0) selectedTeams = participants;
    }
  }
  // draft_rankings: everyone in the league drafted, so everyone is fair game.

  const limit = MAX_REQUESTS[args.contentType] ?? 5;
  const targetUserIds: Id<"users">[] = [];
  for (const team of selectedTeams) {
    const clerkId = clerkIdByTeamId.get(team._id);
    const userId = clerkId ? userIdByClerkId.get(clerkId) : undefined;
    if (userId && !targetUserIds.includes(userId)) targetUserIds.push(userId);
  }
  const targeted = targetUserIds.slice(0, limit);
  return {
    targetUserIds: targeted,
    counts: { teams: teams.length, claimed: activeClaims.length, targeted: targeted.length },
  };
}
