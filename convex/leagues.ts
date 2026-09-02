/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  mutation,
  query,
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireLeagueMember } from "./lib/auth";
import { leagueSeatAllowance } from "./credits";

/**
 * The error a full league throws (spec §10.1). A machine-readable code rather
 * than a sentence, because the join flow catches it and renders the
 * commissioner's "buy a seat" prompt - see PRICE-D's at-capacity message.
 */
export const LEAGUE_AT_CAPACITY = "LEAGUE_AT_CAPACITY";

/** How many membership rows one capacity check reads. Leagues are small. */
const MAX_MEMBERSHIPS_SCANNED = 200;

/**
 * Seats used and seats left in a league.
 *
 * The League Pass covers `includedManagers` (12 by default); each $10 seat the
 * commissioner buys adds one. `managers` counts membership rows, which is what
 * every other seat-consuming path in this codebase writes.
 */
export async function leagueCapacity(
  ctx: QueryCtx | MutationCtx,
  leagueId: Id<"leagues">
): Promise<{ managers: number; included: number; extraSeats: number; remaining: number }> {
  const league = await ctx.db.get(leagueId);
  if (!league) throw new Error("League not found");

  const memberships = await ctx.db
    .query("leagueMemberships")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .take(MAX_MEMBERSHIPS_SCANNED);

  const { included, extraSeats, total } = leagueSeatAllowance(league);
  const managers = memberships.length;

  return { managers, included, extraSeats, remaining: Math.max(0, total - managers) };
}

// ESPN session credentials (espnS2/swid) are live auth cookies for the
// commissioner's ESPN account. They are needed server-side for syncing but must
// NEVER be returned to a client — strip them from any league document before it
// leaves a public query.
function redactEspnCredentials<L extends { espnData?: Record<string, unknown> | undefined }>(
  league: L
): L {
  if (!league.espnData) return league;
  const safeEspnData = { ...league.espnData };
  delete safeEspnData.espnS2;
  delete safeEspnData.swid;
  return { ...league, espnData: safeEspnData } as L;
}

export const create = mutation({
  args: {
    name: v.string(),
    platform: v.literal("espn"),
    externalId: v.string(),
    settings: v.object({
      scoringType: v.string(),
      rosterSize: v.number(),
      playoffWeeks: v.number(),
      categories: v.array(v.string()),
      rosterComposition: v.optional(v.object({
        QB: v.optional(v.number()),
        RB: v.optional(v.number()),
        WR: v.optional(v.number()),
        TE: v.optional(v.number()),
        FLEX: v.optional(v.number()),
        K: v.optional(v.number()),
        DST: v.optional(v.number()),
        BE: v.optional(v.number()),
      })),
      playoffTeamCount: v.optional(v.number()),
      regularSeasonMatchupPeriods: v.optional(v.number()),
      divisions: v.optional(v.array(v.object({
        id: v.string(),
        name: v.string(),
        size: v.number(),
      }))),
    }),
    espnData: v.optional(v.object({
      seasonId: v.number(),
      currentScoringPeriod: v.number(),
      size: v.number(),
      lastSyncedAt: v.number(),
      isPrivate: v.boolean(),
      espnS2: v.optional(v.string()),
      swid: v.optional(v.string()),
    })),
    history: v.optional(v.array(v.object({
      seasonId: v.number(),
      winner: v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
      }),
      runnerUp: v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
      }),
      regularSeasonChampion: v.optional(v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
      })),
    }))),
    // Captured by the setup wizard from the commissioner's browser
    // (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Every default
    // content schedule is expressed in this zone (spec section 9.1).
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // A commissioner who abandons Checkout and comes back through the wizard
    // must land on the league they already created, not a second copy of it:
    // the pass is bought per league, and the duplicate would sit unpaid
    // forever. Same platform + ESPN id + commissioner is the same league, so
    // refresh what the wizard just fetched and hand back the existing id.
    const existing = await ctx.db
      .query("leagues")
      .withIndex("by_external_id", (q) =>
        q.eq("platform", args.platform).eq("externalId", args.externalId)
      )
      .filter((q) => q.eq(q.field("commissionerUserId"), identity.subject))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        settings: args.settings,
        ...(args.espnData
          ? {
              espnData: {
                ...existing.espnData,
                ...args.espnData,
                // Keep the stored ESPN cookies when the wizard didn't send new ones.
                espnS2: args.espnData.espnS2 ?? existing.espnData?.espnS2,
                swid: args.espnData.swid ?? existing.espnData?.swid,
              },
            }
          : {}),
        ...(args.history ? { history: args.history } : {}),
      });
      console.log(
        `leagues.create: ${identity.subject} re-imported ${args.platform}:${args.externalId}; returning existing league ${existing._id}`
      );
      return existing._id;
    }

    const leagueId = await ctx.db.insert("leagues", {
      name: args.name,
      platform: args.platform,
      externalId: args.externalId,
      commissionerUserId: identity.subject,
      settings: args.settings,
      espnData: args.espnData,
      history: args.history,
      subscription: {
        tier: "season_pass",
        status: "pending",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "pending" as const,
        seasonYear: new Date().getFullYear(),
      },
      lastSync: Date.now(),
      createdAt: Date.now(),
    });

    // Add commissioner as member
    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: identity.subject,
      role: "commissioner",
      joinedAt: Date.now(),
    });

    // Set up the automatic-by-default content calendar (spec section 9.1) in
    // the timezone the commissioner imported from.
    try {
      await ctx.scheduler.runAfter(0, internal.contentScheduling.createDefaultContentSchedules, {
        leagueId,
        timezone: args.timezone && args.timezone.trim().length > 0
          ? args.timezone
          : "America/New_York",
      });
    } catch (error) {
      console.error("Failed to create default content schedules:", error);
    }

    return leagueId;
  },
});

export const getByUser = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const memberships = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();

    const leagues = await Promise.all(
      memberships.map(async (membership) => {
        const league = await ctx.db.get(membership.leagueId);
        if (!league) return null;
        return {
          ...redactEspnCredentials(league),
          role: membership.role,
          joinedAt: membership.joinedAt,
        };
      })
    );

    return leagues.filter((league): league is NonNullable<typeof league> => league !== null);
  },
});

// List all leagues. INTERNAL ONLY — returns full documents including ESPN
// credentials, and is used by sync jobs to enumerate leagues. Never expose this
// publicly (it previously leaked every commissioner's ESPN session cookies).
export const listLeagues = internalQuery({
  handler: async (ctx) => {
    return await ctx.db.query("leagues").collect();
  },
});

export const getById = query({
  args: { id: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.id).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return null;
    }

    const league = await ctx.db.get(args.id);
    if (!league) {
      return null;
    }

    return {
      ...redactEspnCredentials(league),
      role: membership.role,
    };
  },
});

// Distinct seasons (years) with league data, for season-selector UI. Sorted
// most-recent-first. Membership-checked, same pattern as getById.
export const getAvailableSeasons = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<number[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    const leagueSeasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    const years = Array.from(new Set(leagueSeasons.map((ls) => ls.seasonId)));
    years.sort((a, b) => b - a);

    return years;
  },
});

export const getPublicInfo = query({
  args: { id: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.id);
    if (!league) return null;
    
    // Return only public information about the league
    return {
      _id: league._id,
      name: league.name,
      createdAt: league.createdAt,
    };
  },
});

// Internal query for fetching league data without authentication
export const getByIdInternal = internalQuery({
  args: { id: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.id);
    if (!league) {
      console.log("🔍 getByIdInternal: League not found");
      return null;
    }
    
    console.log("✅ getByIdInternal: League found:", {
      leagueId: league._id,
      name: league.name,
      hasEspnData: !!league.espnData
    });
    
    return league;
  },
});
export const getDraftData = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number()
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return null;
    }

    // Get league season data
    const leagueSeason = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .first();

    if (!leagueSeason) {
      return null;
    }

    // Get teams for this season
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    // Get enhanced player data - ensure string conversion for espnId matching
    const playerIds = leagueSeason.draft?.map(pick => pick.playerId.toString()) || [];
    const players = await Promise.all(
      playerIds.map(async (playerId) => {
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", args.seasonId)
          )
          .first();
        return player;
      })
    );

    // Create a map for quick lookup - use string keys to match draft data
    const teamMap = new Map(teams.map(t => [parseInt(t.externalId), t]));
    const playerMap = new Map(players.filter(p => p).map(p => [p!.espnId, p]));

    return {
      draftSettings: leagueSeason.draftSettings,
      draftInfo: leagueSeason.draftInfo,
      picks: leagueSeason.draft?.map(pick => ({
        ...pick,
        team: teamMap.get(pick.teamId),
        player: playerMap.get(pick.playerId.toString())
      })) || [],
      hasData: !!leagueSeason.draft && leagueSeason.draft.length > 0
    };
  },
});
export const getLeagueSeasons = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return [];
    }

    // Get all seasons for this league
    const seasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    return seasons;
  },
});
export const getLeagueSeasonByYear = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number()
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return null;
    }

    // Get specific season for this league
    const season = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .first();

    return season;
  },
});

export const joinLeague = mutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if already a member
    const existingMembership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (existingMembership) {
      throw new Error("Already a member of this league");
    }

    // Seats (spec §10.1). The pass covers 12 managers; the 13th needs a $10
    // seat the commissioner buys, which `recordExtraSeat` records. Checked
    // before the insert so the league can never hold more managers than it
    // has paid for.
    const capacity = await leagueCapacity(ctx, args.leagueId);
    if (capacity.remaining <= 0) {
      throw new Error(LEAGUE_AT_CAPACITY);
    }

    // Add as member
    await ctx.db.insert("leagueMemberships", {
      leagueId: args.leagueId,
      userId: identity.subject,
      role: "member",
      joinedAt: Date.now(),
    });

    // The manager's share of the League Pass, when the league has one. The
    // grant refuses on an unpaid league and is idempotent per season, so a
    // manager who joins after the pass was bought gets their 100 exactly once.
    try {
      await ctx.runMutation(internal.credits.grantJoinCredits, {
        userId: identity.subject,
        leagueId: args.leagueId,
      });
    } catch (error) {
      console.error("Failed to grant League Pass credits on join:", error);
    }

    return args.leagueId;
  },
});

// Debug mutation to clear all league data and refetch from ESPN
// Refresh league data from ESPN without clearing existing data
// This preserves team IDs and relationships (like team claims)
export const refreshLeagueData = action({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<{
    success: boolean;
    message?: string;
    syncResult?: any;
    error?: string;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if user has permission (commissioner only for now)
    const membership = await ctx.runQuery(api.leagues.getById, { id: args.leagueId });
    if (!membership || membership.role !== "commissioner") {
      throw new Error("Only commissioners can perform this debug operation");
    }

    try {
      // NOTE: We no longer clear data - we use upsert logic in the sync functions
      // This preserves team IDs and maintains relationships with teamClaims
      
      // Refetch all data from ESPN (current season + 10 years of history)
      const syncResult: any = await ctx.runAction(api.espnSync.syncAllLeagueData, {
        leagueId: args.leagueId,
        includeCurrentSeason: true,
        historicalYears: 10,
      });

      return {
        success: true,
        message: "Successfully refreshed all data from ESPN (data updated, not replaced)",
        syncResult,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  },
});;

// Helper mutation to clear all league data. DESTRUCTIVE — only the league
// commissioner may run it.
export const clearAllLeagueData = mutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();
    if (!membership || membership.role !== "commissioner") {
      throw new Error("Only the league commissioner can clear league data");
    }

    // Clear teams
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const team of teams) {
      await ctx.db.delete(team._id);
    }

    // Clear matchups
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const matchup of matchups) {
      await ctx.db.delete(matchup._id);
    }

    // Clear league seasons
    const leagueSeasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const season of leagueSeasons) {
      await ctx.db.delete(season._id);
    }

    // Clear AI content associated with this league
    const aiContent = await ctx.db
      .query("aiContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const content of aiContent) {
      await ctx.db.delete(content._id);
    }

    // Clear weekly stats
    const weeklyStats = await ctx.db
      .query("weeklyStats")
      .withIndex("by_league_week", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const stat of weeklyStats) {
      await ctx.db.delete(stat._id);
    }

    return { cleared: true };
  },
});
// Membership role lookup for action-side auth checks (see convex/lib/auth.ts
// requireLeagueMemberFromAction). Internal only: takes the userId as an argument.
export const getMembershipRoleInternal = internalQuery({
  args: { leagueId: v.id("leagues"), userId: v.string() },
  handler: async (ctx, args): Promise<"commissioner" | "member" | null> => {
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.leagueId).eq("userId", args.userId)
      )
      .first();
    return membership?.role ?? null;
  },
});

/* ========================================================================== *
 * League Pass seats (spec §10.1)
 * ========================================================================== */

/**
 * How many managers this league has paid for, and how many seats are left.
 *
 * League members only: seat counts are the commissioner's billing position,
 * and the join flow only ever needs them for a league the caller is already
 * in. The at-capacity message a would-be joiner sees comes from the
 * {@link LEAGUE_AT_CAPACITY} error on `joinLeague`, not from this query.
 */
export const getLeagueCapacity = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    managers: v.number(),
    included: v.number(),
    extraSeats: v.number(),
    remaining: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    return await leagueCapacity(ctx, args.leagueId);
  },
});

/**
 * Record one bought $10 seat. Called by PRICE-D's Stripe webhook once the seat
 * payment settles; `credits.grantSeatCredits` mints that seat's 100 credits.
 *
 * Internal on purpose: this widens what the league is allowed to hold, so it
 * may only ever be reached from a settled payment, never from a client.
 */
export const recordExtraSeat = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    /** Seats bought in one go. Defaults to one. */
    count: v.optional(v.number()),
  },
  returns: v.object({ extraSeats: v.number(), included: v.number(), total: v.number() }),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const count = Math.max(1, Math.floor(args.count ?? 1));
    const { included, extraSeats } = leagueSeatAllowance(league);
    const nextExtraSeats = extraSeats + count;

    await ctx.db.patch(args.leagueId, {
      subscription: {
        ...league.subscription,
        // Written explicitly rather than left to default, so the league's own
        // allowance survives a later change to INCLUDED_MANAGERS_DEFAULT.
        includedManagers: included,
        extraSeats: nextExtraSeats,
      },
    });

    return { extraSeats: nextExtraSeats, included, total: included + nextExtraSeats };
  },
});
