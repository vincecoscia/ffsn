/* eslint-disable @typescript-eslint/no-explicit-any */
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

// Helper function to get user display name for team ownership
async function getUserDisplayName(ctx: any, userId: string): Promise<string> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q: any) => q.eq("clerkId", userId))
    .first();

  if (!user) {
    return "Unknown";
  }

  // Prefer user.name, fallback to "Unknown"
  return user.name || "Unknown";
}
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

    // Get the user's information to use as the team owner
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      throw new Error("User not found");
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

    // Get the user's display name for the team owner field
    const ownerName = await getUserDisplayName(ctx, identity.subject);

    // Update the team's owner field
    await ctx.db.patch(args.teamId, {
      owner: ownerName,
    });

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

export const updateTeamOwnersFromClaims = mutation({
  args: {
    leagueId: v.optional(v.id("leagues")), // Optional - if not provided, updates all leagues
  },
  handler: async (ctx, args) => {
    // Get all active team claims
    const teamClaims = args.leagueId 
      ? await ctx.db
          .query("teamClaims")
          .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId!))
          .filter((q) => q.eq(q.field("status"), "active"))
          .collect()
      : await ctx.db
          .query("teamClaims")
          .filter((q) => q.eq(q.field("status"), "active"))
          .collect();

    let updatedCount = 0;
    
    for (const claim of teamClaims) {
      // Get the user who claimed this team
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", claim.userId))
        .first();

      if (!user) {
        console.warn(`User not found for claim: ${claim._id}`);
        continue;
      }

      // Get the team
      const team = await ctx.db.get(claim.teamId);
      if (!team) {
        console.warn(`Team not found: ${claim.teamId}`);
        continue;
      }

      // Only update teams that currently have "Unknown" as owner
      if (team.owner === "Unknown") {
        const ownerName = await getUserDisplayName(ctx, claim.userId);
        
        await ctx.db.patch(claim.teamId, {
          owner: ownerName,
        });
        
        updatedCount++;
      }
    }

    return {
      success: true,
      updatedCount,
      message: `Updated ${updatedCount} team owners from "Unknown" to user names`,
    };
  },
});
export const getTeamsWithUnknownOwners = query({
  args: {
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
    const teams = args.leagueId
      ? await ctx.db
          .query("teams")
          .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId!))
          .filter((q) => q.eq(q.field("owner"), "Unknown"))
          .collect()
      : await ctx.db
          .query("teams")
          .filter((q) => q.eq(q.field("owner"), "Unknown"))
          .collect();

    return teams.map(team => ({
      _id: team._id,
      name: team.name,
      owner: team.owner,
      seasonId: team.seasonId,
      leagueId: team.leagueId,
    }));
  },
});
export const syncAllTeamOwners = mutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()), // Optional - if not provided, updates all seasons
  },
  handler: async (ctx, args) => {
    // Get all teams for this league
    let teamsQuery = ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId));
    
    if (args.seasonId) {
      teamsQuery = teamsQuery.filter((q) => q.eq(q.field("seasonId"), args.seasonId));
    }
    
    const teams = await teamsQuery.collect();
    
    let updatedCount = 0;
    let unchangedCount = 0;
    
    for (const team of teams) {
      // Find if this team has been claimed
      const claim = await ctx.db
        .query("teamClaims")
        .withIndex("by_team_season", (q) => 
          q.eq("teamId", team._id).eq("seasonId", team.seasonId)
        )
        .filter((q) => q.eq(q.field("status"), "active"))
        .first();

      if (claim) {
        // Get the user who claimed this team
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", claim.userId))
          .first();

        if (user && team.owner === "Unknown") {
          const ownerName = await getUserDisplayName(ctx, claim.userId);
          
          await ctx.db.patch(team._id, {
            owner: ownerName,
          });
          
          updatedCount++;
        } else {
          unchangedCount++;
        }
      } else {
        unchangedCount++;
      }
    }

    return {
      success: true,
      totalTeams: teams.length,
      updatedCount,
      unchangedCount,
      message: `Processed ${teams.length} teams. Updated ${updatedCount} team owners, ${unchangedCount} unchanged.`,
    };
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