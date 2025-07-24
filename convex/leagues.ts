import { mutation, query, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

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
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
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
        tier: "free",
        status: "active",
        creditsRemaining: 10,
        creditsMonthly: 10,
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
          ...league,
          role: membership.role,
          joinedAt: membership.joinedAt,
        };
      })
    );

    return leagues.filter((league): league is NonNullable<typeof league> => league !== null);
  },
});

export const getById = query({
  args: { id: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.log("🔍 getById: No identity found");
      return null;
    }

    console.log("🔍 getById: Checking league access for user:", {
      userId: identity.subject,
      leagueId: args.id,
      email: identity.email
    });

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.id).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      console.log("❌ getById: No membership found for user in league");
      
      // Debug: check if there are any memberships for this league
      const allMemberships = await ctx.db
        .query("leagueMemberships")
        .withIndex("by_league", (q) => q.eq("leagueId", args.id))
        .collect();
      
      console.log("🔍 getById: All memberships for this league:", allMemberships.map(m => ({
        id: m._id,
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt
      })));
      
      // Debug: check if there are any memberships for this user
      const userMemberships = await ctx.db
        .query("leagueMemberships")
        .withIndex("by_user", (q) => q.eq("userId", identity.subject))
        .collect();
      
      console.log("🔍 getById: All memberships for this user:", userMemberships.map(m => ({
        id: m._id,
        leagueId: m.leagueId,
        role: m.role,
        joinedAt: m.joinedAt
      })));
      
      return null;
    }

    console.log("✅ getById: Membership found:", {
      membershipId: membership._id,
      role: membership.role,
      joinedAt: membership.joinedAt
    });

    const league = await ctx.db.get(args.id);
    if (!league) {
      console.log("❌ getById: League not found in database");
      return null;
    }
    
    console.log("✅ getById: League found and returning:", {
      leagueId: league._id,
      name: league.name,
      role: membership.role
    });
    
    return {
      ...league,
      role: membership.role,
    };
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

    // Add as member
    await ctx.db.insert("leagueMemberships", {
      leagueId: args.leagueId,
      userId: identity.subject,
      role: "member",
      joinedAt: Date.now(),
    });

    return args.leagueId;
  },
});

// Debug mutation to clear all league data and refetch from ESPN
export const debugClearAndRefetch = action({
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
      // Clear all existing data for this league
      await ctx.runMutation(api.leagues.clearAllLeagueData, { leagueId: args.leagueId });

      // Refetch all data from ESPN (current season + 10 years of history)
      const syncResult: any = await ctx.runAction(api.espnSync.syncAllLeagueData, {
        leagueId: args.leagueId,
        includeCurrentSeason: true,
        historicalYears: 10,
      });

      return {
        success: true,
        message: "Successfully cleared all data and refetched from ESPN",
        syncResult,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  },
});

// Helper mutation to clear all league data
export const clearAllLeagueData = mutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
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