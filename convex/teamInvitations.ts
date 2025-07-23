import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Generate a secure random token for invitations
function generateInviteToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export const createInvitation = mutation({
  args: {
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    seasonId: v.number(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if user is commissioner of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (!membership || membership.role !== "commissioner") {
      throw new Error("Only commissioners can create invitations");
    }

    // Get team info
    const team = await ctx.db.get(args.teamId);
    if (!team) {
      throw new Error("Team not found");
    }

    // Check if invitation already exists for this team/season
    const existingInvite = await ctx.db
      .query("teamInvitations")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .filter((q) => 
        q.and(
          q.eq(q.field("seasonId"), args.seasonId),
          q.eq(q.field("status"), "pending")
        )
      )
      .first();

    if (existingInvite) {
      throw new Error("Active invitation already exists for this team");
    }

    const inviteToken = generateInviteToken();
    const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days

    const invitationId = await ctx.db.insert("teamInvitations", {
      leagueId: args.leagueId,
      teamId: args.teamId,
      seasonId: args.seasonId,
      inviteToken,
      email: args.email,
      teamName: team.name,
      teamAbbreviation: team.abbreviation,
      teamLogo: team.logo,
      status: "pending",
      expiresAt,
      createdAt: Date.now(),
    });

    return {
      invitationId,
      inviteToken,
      inviteUrl: `/invite/${inviteToken}`,
    };
  },
});

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

    const invitations = await ctx.db
      .query("teamInvitations")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("seasonId"), args.seasonId))
      .collect();

    return invitations;
  },
});

export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("teamInvitations")
      .withIndex("by_token", (q) => q.eq("inviteToken", args.token))
      .first();

    if (!invitation) {
      return null;
    }

    // Check if expired (but don't mutate in query)
    if (invitation.expiresAt < Date.now()) {
      return null;
    }

    const team = await ctx.db.get(invitation.teamId);
    const league = await ctx.db.get(invitation.leagueId);

    return {
      ...invitation,
      team,
      league,
    };
  },
});

export const claimInvitation = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    console.log("🔥 CLAIM INVITATION STARTED", { token: args.token });
    
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.log("❌ No authentication found");
      throw new Error("Not authenticated");
    }

    console.log("✅ User authenticated:", { 
      subject: identity.subject, 
      email: identity.email,
      name: identity.name 
    });

    const invitation = await ctx.db
      .query("teamInvitations")
      .withIndex("by_token", (q) => q.eq("inviteToken", args.token))
      .first();

    if (!invitation) {
      console.log("❌ Invitation not found for token:", args.token);
      throw new Error("Invitation not found");
    }

    console.log("✅ Invitation found:", {
      id: invitation._id,
      teamId: invitation.teamId,
      leagueId: invitation.leagueId,
      status: invitation.status,
      seasonId: invitation.seasonId
    });

    if (invitation.status !== "pending") {
      console.log("❌ Invitation status invalid:", invitation.status);
      throw new Error("Invitation is no longer valid");
    }

    if (invitation.expiresAt < Date.now()) {
      console.log("❌ Invitation expired");
      await ctx.db.patch(invitation._id, { status: "expired" });
      throw new Error("Invitation has expired");
    }

    // Check if team is already claimed
    const existingClaim = await ctx.db
      .query("teamClaims")
      .withIndex("by_team_season", (q) => 
        q.eq("teamId", invitation.teamId).eq("seasonId", invitation.seasonId)
      )
      .first();

    if (existingClaim) {
      console.log("❌ Team already claimed:", existingClaim);
      throw new Error("Team has already been claimed");
    }

    // Check if user already has a team in this league for this season
    const userExistingClaim = await ctx.db
      .query("teamClaims")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .filter((q) => 
        q.and(
          q.eq(q.field("leagueId"), invitation.leagueId),
          q.eq(q.field("seasonId"), invitation.seasonId)
        )
      )
      .first();

    if (userExistingClaim) {
      console.log("❌ User already has team in league:", userExistingClaim);
      throw new Error("You already have a team in this league for this season");
    }

    // Ensure user exists in the users table
    let user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      console.log("❌ User not found in database with clerkId:", identity.subject);
      
      // Let's try to search all users to see what we have
      const allUsers = await ctx.db.query("users").collect();
      console.log("🔍 All users in database:", allUsers.map(u => ({ 
        id: u._id, 
        clerkId: u.clerkId, 
        email: u.email, 
        name: u.name 
      })));
      
      throw new Error("User not found. Please try refreshing the page and signing in again.");
    }

    console.log("✅ User found in database:", {
      id: user._id,
      clerkId: user.clerkId,
      email: user.email,
      name: user.name
    });

    // Add user to league if not already a member
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", invitation.leagueId).eq("userId", identity.subject)
      )
      .first();

    let membershipId;
    if (!membership) {
      console.log("🔄 Adding user to league membership");
      membershipId = await ctx.db.insert("leagueMemberships", {
        leagueId: invitation.leagueId,
        userId: identity.subject,
        role: "member",
        joinedAt: Date.now(),
      });
      console.log("✅ League membership created:", membershipId);
    } else {
      console.log("✅ User already has league membership:", membership._id);
      membershipId = membership._id;
    }

    // Create team claim
    console.log("🔄 Creating team claim with data:", {
      leagueId: invitation.leagueId,
      teamId: invitation.teamId,
      seasonId: invitation.seasonId,
      userId: identity.subject,
      status: "active",
      createdAt: Date.now(),
    });
    
    const teamClaimId = await ctx.db.insert("teamClaims", {
      leagueId: invitation.leagueId,
      teamId: invitation.teamId,
      seasonId: invitation.seasonId,
      userId: identity.subject,
      status: "active",
      createdAt: Date.now(),
    });

    console.log("✅ Team claim created with ID:", teamClaimId);

    // Mark invitation as claimed
    console.log("🔄 Marking invitation as claimed");
    await ctx.db.patch(invitation._id, {
      status: "claimed",
      claimedByUserId: identity.subject,
      claimedAt: Date.now(),
    });

    // Verify the league membership was created and is accessible
    console.log("🔍 Verifying league membership exists after creation...");
    const verifyMembership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", invitation.leagueId).eq("userId", identity.subject)
      )
      .first();
    
    if (!verifyMembership) {
      console.log("❌ CRITICAL: League membership verification failed!");
      throw new Error("Failed to create league membership - database consistency issue");
    }
    
    console.log("✅ League membership verified:", verifyMembership._id);

    // Verify the team claim was created
    console.log("🔍 Verifying team claim exists after creation...");
    const verifyTeamClaim = await ctx.db
      .query("teamClaims")
      .withIndex("by_team_season", (q) => 
        q.eq("teamId", invitation.teamId).eq("seasonId", invitation.seasonId)
      )
      .first();
    
    if (!verifyTeamClaim) {
      console.log("❌ CRITICAL: Team claim verification failed!");
      throw new Error("Failed to create team claim - database consistency issue");
    }
    
    console.log("✅ Team claim verified:", verifyTeamClaim._id);

    console.log("🎉 Invitation claimed successfully! Returning league ID:", invitation.leagueId);
    return invitation.leagueId;
  },
});;;