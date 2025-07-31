import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

export const getByLeague = query({
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

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    return teams;
  },
});

export const getByLeagueAndSeason = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number()
  },
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

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    return teams;
  },
});

export const getByExternalIdAndSeason = query({
  args: { 
    leagueId: v.id("leagues"),
    externalId: v.string(),
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

    const team = await ctx.db
      .query("teams")
      .withIndex("by_external", (q) => 
        q.eq("leagueId", args.leagueId)
          .eq("externalId", args.externalId)
          .eq("seasonId", args.seasonId)
      )
      .first();

    return team;
  },
});
export const getBySeasonAndLeague = query({
  args: { 
    leagueId: v.id("leagues"), 
    seasonId: v.number() 
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();
  },
});

export const updateTeamRoster = mutation({
  args: {
    teamId: v.id("teams"),
    roster: v.array(v.object({
      playerId: v.string(),
      playerName: v.string(),
      position: v.string(),
      team: v.string(),
      acquisitionType: v.optional(v.string()),
      lineupSlotId: v.optional(v.number()),
      playerStats: v.optional(v.object({
        appliedTotal: v.optional(v.number()),
        projectedTotal: v.optional(v.number()),
      })),
    })),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.teamId, {
      roster: args.roster,
      updatedAt: Date.now(),
    });
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated to upload logos");
    }
    
    return await ctx.storage.generateUploadUrl();
  },
});

export const updateCustomLogo = mutation({
  args: {
    teamId: v.id("teams"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated to update team logo");
    }

    const team = await ctx.db.get(args.teamId);
    if (!team) {
      throw new Error("Team not found");
    }

    // Check if user has permission (either commissioner or team owner via claim)
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", team.leagueId).eq("userId", identity.subject)
      )
      .unique();

    const teamClaim = await ctx.db
      .query("teamClaims")
      .withIndex("by_team_season", (q) =>
        q.eq("teamId", args.teamId).eq("seasonId", 2025)
      )
      .filter((q) => q.eq(q.field("userId"), identity.subject))
      .unique();

    const isCommissioner = membership?.role === "commissioner";
    const isTeamOwner = teamClaim?.status === "active";

    if (!isCommissioner && !isTeamOwner) {
      throw new Error("You don't have permission to update this team's logo");
    }

    // Delete old custom logo if it exists
    if (team.customLogo) {
      await ctx.storage.delete(team.customLogo);
    }

    // Update team with new custom logo
    await ctx.db.patch(args.teamId, {
      customLogo: args.storageId,
    });

    return { success: true };
  },
});

export const getCustomLogoUrl = query({
  args: {
    teamId: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team || !team.customLogo) {
      return null;
    }

    return await ctx.storage.getUrl(team.customLogo);
  },
});

export const removeCustomLogo = mutation({
  args: {
    teamId: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated to remove team logo");
    }

    const team = await ctx.db.get(args.teamId);
    if (!team) {
      throw new Error("Team not found");
    }

    // Check permissions
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", team.leagueId).eq("userId", identity.subject)
      )
      .unique();

    const teamClaim = await ctx.db
      .query("teamClaims")
      .withIndex("by_team_season", (q) =>
        q.eq("teamId", args.teamId).eq("seasonId", 2025)
      )
      .filter((q) => q.eq(q.field("userId"), identity.subject))
      .unique();

    const isCommissioner = membership?.role === "commissioner";
    const isTeamOwner = teamClaim?.status === "active";

    if (!isCommissioner && !isTeamOwner) {
      throw new Error("You don't have permission to remove this team's logo");
    }

    if (team.customLogo) {
      await ctx.storage.delete(team.customLogo);
      await ctx.db.patch(args.teamId, {
        customLogo: undefined,
      });
    }

    return { success: true };
  },
});
