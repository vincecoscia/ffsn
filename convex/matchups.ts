/* eslint-disable @typescript-eslint/no-explicit-any */
import { query } from "./_generated/server";
import { v } from "convex/values";

export const getByLeagueAndPeriod = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    matchupPeriod: v.number()
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

    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_period", (q) => 
        q.eq("leagueId", args.leagueId).eq("matchupPeriod", args.matchupPeriod)
      )
      .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
      .collect();

    return matchups;
  },
});

export const getCurrentWeekMatchups = query({
  args: { 
    leagueId: v.id("leagues"),
    seasonId: v.number()
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { matchups: [], currentWeek: 1 };
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return { matchups: [], currentWeek: 1 };
    }

    // Find the current week by looking for the first week with undecided games
    // Start from week 1 and iterate until we find incomplete matchups
    let currentWeek = 1;
    let currentMatchups: any[] = [];

    for (let week = 1; week <= 18; week++) { // NFL season is max 18 weeks
      const weekMatchups = await ctx.db
        .query("matchups")
        .withIndex("by_league_period", (q) => 
          q.eq("leagueId", args.leagueId).eq("matchupPeriod", week)
        )
        .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
        .collect();

      if (weekMatchups.length === 0) break;

      // Check if all games in this week have winners
      const incompleteGames = weekMatchups.filter(matchup => !matchup.winner);
      
      if (incompleteGames.length > 0) {
        // Found the current week - some games are not finished
        currentWeek = week;
        currentMatchups = weekMatchups;
        break;
      } else if (week === 1 && weekMatchups.every(matchup => matchup.winner)) {
        // If week 1 is complete, but we haven't found incomplete games yet,
        // continue to next week
        currentWeek = week + 1;
        continue;
      }
      
      // If we get here, this week is complete, move to next
      currentWeek = week + 1;
      currentMatchups = weekMatchups;
    }

    // If no incomplete weeks found, return the last week's matchups
    if (currentMatchups.length === 0 && currentWeek > 1) {
      currentMatchups = await ctx.db
        .query("matchups")
        .withIndex("by_league_period", (q) => 
          q.eq("leagueId", args.leagueId).eq("matchupPeriod", currentWeek - 1)
        )
        .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
        .collect();
      currentWeek = currentWeek - 1;
    }

    return {
      matchups: currentMatchups,
      currentWeek
    };
  },
});