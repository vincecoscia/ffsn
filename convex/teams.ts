import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { requireLeagueMember, requireCommissioner } from "./lib/auth";

// Local types for playerStats documents and entries to avoid `any`
type PlayerStatEntry = {
  statSourceId: number;
  scoringPeriodId: number;
  appliedTotal?: number;
  appliedAverage?: number;
  appliedStats?: Record<string, number>;
};

type LeaguePlayerStatsDoc = {
  _id: Id<"playerStats">;
  leagueId: Id<"leagues">;
  espnId: string;
  season: number;
  scoringType: string;
  stats?: PlayerStatEntry[] | unknown; // Stored as any in schema; we'll narrow when accessing
  actualStats?: Record<string, number>;
  projectedStats?: Record<string, number>;
  calculatedAt: number;
  createdAt: number;
  updatedAt: number;
};

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

export const getTeamsByLeague = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }
    await requireLeagueMember(ctx, args.leagueId);

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    return teams;
  },
});

export const getLeagueTeams = query({
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

    // Get the league to determine current season
    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      return [];
    }

    // Get current season from league's ESPN data
    const currentSeason = league.espnData?.seasonId || new Date().getFullYear();

    // Get teams for current season only
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason)
      )
      .collect();
    
    return teams;
  },
});

export const getClaimedTeams = query({
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

    // Get the league to determine current season
    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      return [];
    }

    // Get current season from league's ESPN data
    const currentSeason = league.espnData?.seasonId || new Date().getFullYear();

    // Get teams for current season only
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", currentSeason)
      )
      .collect();
    
    // Get active team claims for this league
    const teamClaims = await ctx.db
      .query("teamClaims")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
      .filter(q => q.eq(q.field("status"), "active"))
      .collect();
    
    // Filter teams to only those that have been claimed
    const claimedTeamIds = new Set(teamClaims.map(claim => claim.teamId));
    const claimedTeams = teams.filter(team => claimedTeamIds.has(team._id));
    
    return claimedTeams;
  },
});

export const getCurrentUserTeam = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    
    const userId = identity.subject;
    
    // Find team owned by current user in this league
    const team = await ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("owner"), userId))
      .first();
    
    return team;
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

    // Enrich roster players with league-specific season stats from playerStats table
    if (!teams || teams.length === 0) {
      return teams;
    }

    // Collect all rostered ESPN player IDs
    const rosterEspnIds = new Set<string>();
    for (const team of teams) {
      for (const player of team.roster || []) {
        if (player?.playerId) rosterEspnIds.add(player.playerId);
      }
    }

    // Fetch player stats only for rostered players using selective index lookups
    const statsByEspnId = new Map<string, LeaguePlayerStatsDoc>();
    await Promise.all(
      Array.from(rosterEspnIds).map(async (espnId) => {
        const ps = await ctx.db
          .query("playerStats")
          .withIndex("by_league_player", (q) =>
            q.eq("leagueId", args.leagueId).eq("espnId", espnId).eq("season", args.seasonId)
          )
          .first();
        if (ps) {
          statsByEspnId.set(espnId, ps as LeaguePlayerStatsDoc);
        }
      })
    );

    const enrichedTeams = teams.map((team) => {
      const enrichedRoster = team.roster.map((player) => {
        const ps = statsByEspnId.get(player.playerId);

        let appliedTotal: number | undefined = undefined;
        let appliedAverage: number | undefined = undefined;
        let projectedTotal: number | undefined = undefined;
        let projectedAverage: number | undefined = undefined;

        // Prefer season totals from league-specific stats array when available
        if (ps && Array.isArray(ps.stats)) {
          const seasonActual = (ps.stats as PlayerStatEntry[]).find((s) => s?.statSourceId === 0 && s?.scoringPeriodId === 0);
          const seasonProj = (ps.stats as PlayerStatEntry[]).find((s) => s?.statSourceId === 1 && s?.scoringPeriodId === 0);
          if (seasonActual && typeof seasonActual.appliedTotal === "number") {
            appliedTotal = seasonActual.appliedTotal;
          }
          if (seasonActual && typeof seasonActual.appliedAverage === "number") {
            appliedAverage = seasonActual.appliedAverage;
          }
          if (seasonProj && typeof seasonProj.appliedTotal === "number") {
            projectedTotal = seasonProj.appliedTotal;
          }
          if (seasonProj && typeof seasonProj.appliedAverage === "number") {
            projectedAverage = seasonProj.appliedAverage;
          }
        }

        return {
          ...player,
          playerStats: {
            // Flat fields for backward compatibility in UI until consumers switch to nested
            appliedTotal: appliedTotal ?? player.playerStats?.appliedTotal,
            appliedAverage: appliedAverage ?? player.playerStats?.appliedAverage,
            projectedTotal: projectedTotal ?? player.playerStats?.projectedTotal,
            projectedAverage: projectedAverage ?? player.playerStats?.projectedAverage,
            // New nested objects
            actual: {
              appliedTotal: appliedTotal ?? player.playerStats?.actual?.appliedTotal,
              appliedAverage: appliedAverage ?? player.playerStats?.actual?.appliedAverage,
            },
            projected: {
              appliedTotal: projectedTotal ?? player.playerStats?.projected?.appliedTotal,
              appliedAverage: projectedAverage ?? player.playerStats?.projected?.appliedAverage,
            },
          },
        };
      });

      return {
        ...team,
        roster: enrichedRoster,
      };
    });

    return enrichedTeams;
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }
    await requireLeagueMember(ctx, args.leagueId);

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
    const team = await ctx.db.get(args.teamId);
    if (!team) {
      throw new Error("Team not found");
    }
    await requireCommissioner(ctx, team.leagueId);

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
        q.eq("teamId", args.teamId).eq("seasonId", team.seasonId)
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

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    await requireLeagueMember(ctx, team.leagueId);

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
        q.eq("teamId", args.teamId).eq("seasonId", team.seasonId)
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

// ---------------------------------------------------------------------------
// Internal variants for crons and sync pipelines (no identity in that context).
// The public functions above require league membership / commissioner role;
// these are only reachable from other Convex functions via `internal.teams.*`.
// ---------------------------------------------------------------------------

export const getTeamsByLeagueInternal = internalQuery({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
  },
});

export const getBySeasonAndLeagueInternal = internalQuery({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("teams")
      .withIndex("by_season", (q) =>
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();
  },
});

export const updateTeamRosterInternal = internalMutation({
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
    const team = await ctx.db.get(args.teamId);
    if (!team) {
      throw new Error("Team not found");
    }
    await ctx.db.patch(args.teamId, {
      roster: args.roster,
      updatedAt: Date.now(),
    });
  },
});
