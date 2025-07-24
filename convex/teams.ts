import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

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
