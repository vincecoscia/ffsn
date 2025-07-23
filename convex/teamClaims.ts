import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByLeague = query({
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

    const claims = await ctx.db
      .query("teamClaims")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
      .collect();

    return claims;
  },
});

export const claimTeam = mutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      throw new Error("Not a member of this league");
    }

    // Check if team is already claimed for this season
    const existingClaim = await ctx.db
      .query("teamClaims")
      .withIndex("by_team_season", (q) => 
        q.eq("teamId", args.teamId).eq("seasonId", args.seasonId)
      )
      .first();

    if (existingClaim) {
      throw new Error("Team already claimed for this season");
    }

    // Check if user has already claimed a team for this season in this league
    const userExistingClaim = await ctx.db
      .query("teamClaims")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .filter((q) => 
        q.and(
          q.eq(q.field("leagueId"), args.leagueId),
          q.eq(q.field("seasonId"), args.seasonId)
        )
      )
      .first();

    if (userExistingClaim) {
      throw new Error("You have already claimed a team for this season");
    }

    // Create the team claim
    const claimId = await ctx.db.insert("teamClaims", {
      leagueId: args.leagueId,
      teamId: args.teamId,
      seasonId: args.seasonId,
      userId: identity.subject,
      status: "active",
      createdAt: Date.now(),
    });

    return claimId;
  },
});

export const getUserClaimedTeam = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const claim = await ctx.db
      .query("teamClaims")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .filter((q) => 
        q.and(
          q.eq(q.field("leagueId"), args.leagueId),
          q.eq(q.field("seasonId"), args.seasonId)
        )
      )
      .first();

    if (!claim) {
      return null;
    }

    const team = await ctx.db.get(claim.teamId);
    return {
      ...claim,
      team,
    };
  },
});