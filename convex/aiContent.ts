import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { generateAIContent } from "../src/lib/ai/content-generation-service";
import { contentTemplates } from "../src/lib/ai/content-templates";

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

    const content = await ctx.db
      .query("aiContent")
      .withIndex("by_league_published", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("status"), "published"))
      .order("desc")
      .take(10);

    return content;
  },
});
export const getById = query({
  args: {
    articleId: v.id("aiContent"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.articleId);
  },
});

export const createGenerationRequest = mutation({
  args: {
    leagueId: v.id("leagues"),
    type: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
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

    // Check if user is commissioner for commissioner-only content
    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      throw new Error("League not found");
    }

    // Get template to check credit cost
    const template = contentTemplates[args.type];
    if (!template) {
      const availableTypes = Object.keys(contentTemplates).join(', ');
      throw new Error(`Invalid content type: "${args.type}". Available types: ${availableTypes}`);
    }

    // Create a generation request in "generating" status
    const articleId = await ctx.db.insert("aiContent", {
      leagueId: args.leagueId,
      type: args.type,
      persona: args.persona,
      title: "Generating...",
      content: "",
      metadata: {
        week: 1, // Will be updated
        featured_teams: [],
        credits_used: template.creditCost,
      },
      status: "generating",
      createdAt: Date.now(),
    });

    // Schedule the actual generation
    await ctx.scheduler.runAfter(0, api.aiContent.generateContentAction, {
      articleId,
      leagueId: args.leagueId,
      contentType: args.type,
      persona: args.persona,
      customContext: args.customContext,
      userId: identity.subject,
    });

    return articleId;
  },
});

// Action to handle the actual AI generation
export const generateContentAction = action({
  args: {
    articleId: v.id("aiContent"),
    leagueId: v.id("leagues"),
    contentType: v.string(),
    persona: v.string(),
    customContext: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    console.log("=== generateContentAction START ===");
    console.log("Content type:", args.contentType);
    console.log("Persona:", args.persona);
    console.log("Custom context provided:", !!args.customContext);
    
    try {
      // Gather league data
      const leagueData = await ctx.runQuery(api.aiContent.getLeagueDataForGeneration, {
        leagueId: args.leagueId,
      });
      
      console.log("=== LEAGUE DATA RECEIVED IN ACTION ===");
      console.log("League name:", leagueData.leagueName);
      console.log("Current teams:", leagueData.teams.length);
      console.log("Previous seasons available:", Object.keys(leagueData.previousSeasons || {}).length);
      
      // Log detailed data for season_welcome
      if (args.contentType === 'season_welcome' && leagueData.previousSeasons) {
        console.log("=== SEASON WELCOME DATA CHECK ===");
        Object.entries(leagueData.previousSeasons).forEach(([year, teams]) => {
          console.log(`Year ${year}: ${teams.length} teams`);
          if (teams[0]) {
            console.log(`  Sample team: ${teams[0].teamName} with ${teams[0].roster?.length || 0} players`);
          }
        });
      }
      
      // Log sample roster data
      if (leagueData.teams[0]?.roster?.length > 0) {
        console.log("Sample current roster player:", {
          name: leagueData.teams[0].roster[0].playerName,
          position: leagueData.teams[0].roster[0].position,
          hasStats: !!leagueData.teams[0].roster[0].stats,
          hasOwnership: !!leagueData.teams[0].roster[0].ownership,
        });
      }

      // Get API key from environment
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY not configured");
      }

      console.log("Calling AI generation service...");
      
      // Call AI generation service
      const generatedContent = await generateAIContent({
        leagueId: args.leagueId,
        contentType: args.contentType,
        persona: args.persona,
        leagueData,
        customContext: args.customContext,
        userId: args.userId,
      }, apiKey);
      
      console.log("AI content generated successfully");
      console.log("Generated title:", generatedContent.title);
      console.log("Content length:", generatedContent.content.length);
      console.log("Featured teams:", generatedContent.metadata?.featuredTeams?.length || 0);
      console.log("Featured players:", generatedContent.metadata?.featuredPlayers?.length || 0);

      // Update the article with generated content
      await ctx.runMutation(api.aiContent.updateGeneratedContent, {
        articleId: args.articleId,
        title: generatedContent.title,
        content: generatedContent.content,
        summary: generatedContent.summary,
        metadata: generatedContent.metadata,
      });
      
      console.log("=== generateContentAction SUCCESS ===");
    } catch (error) {
      console.error("=== generateContentAction ERROR ===");
      console.error("Content generation failed:", error);
      console.error("Error stack:", error instanceof Error ? error.stack : "No stack trace");
      
      // Update article to failed status
      await ctx.runMutation(api.aiContent.updateContentStatus, {
        articleId: args.articleId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
});

// Query to get league data for generation
export const getLeagueDataForGeneration = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    console.log("=== getLeagueDataForGeneration START ===");
    console.log("League ID:", args.leagueId);
    
    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      throw new Error("League not found");
    }
    console.log("League found:", league.name);

    // Get teams for current season (2025)
    const currentYear = new Date().getFullYear();
    console.log("Current year:", currentYear);
    
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", currentYear))
      .collect();
    console.log("Current season teams found:", teams.length);
    
    // Log sample team data
    if (teams.length > 0) {
      console.log("Sample team:", {
        name: teams[0].name,
        rosterSize: teams[0].roster?.length,
        samplePlayer: teams[0].roster?.[0],
      });
    }

    // Get teams from previous seasons for historical data
    const previousSeasonTeams = await ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.neq(q.field("seasonId"), currentYear))
      .collect();
    console.log("Previous season teams found:", previousSeasonTeams.length);
    
    // Group by season for logging
    const teamsBySeason = previousSeasonTeams.reduce((acc, team) => {
      acc[team.seasonId] = (acc[team.seasonId] || 0) + 1;
      return acc;
    }, {} as Record<number, number>);
    console.log("Teams by season:", teamsBySeason);

    // Get recent matchups for current season (if available)
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", currentYear))
      .order("desc")
      .take(10);
    console.log("Recent matchups found:", matchups.length);

    // Get players data from the players table
    const playerIds = new Set<string>();
    teams.forEach(team => {
      team.roster.forEach(player => {
        playerIds.add(player.playerId);
      });
    });

    // Also collect player IDs from previous seasons
    previousSeasonTeams.forEach(team => {
      team.roster.forEach(player => {
        playerIds.add(player.playerId);
      });
    });
    console.log("Total unique player IDs collected:", playerIds.size);

    // Fetch player details from players table
    const players = await Promise.all(
      Array.from(playerIds).map(async (playerId) => {
        const player = await ctx.db
          .query("players")
          .withIndex("by_external_id", (q) => q.eq("externalId", playerId))
          .first();
        return player;
      })
    );
    
    const validPlayers = players.filter(p => p !== null);
    console.log("Players found in players table:", validPlayers.length);

    // Create a map of player ID to player details for quick lookup
    const playerMap = new Map(
      validPlayers.map(p => [p!.externalId, p])
    );

    // Get league season history
    const leagueSeasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .collect();
    console.log("League seasons found:", leagueSeasons.length);

    // Note: trades table doesn't exist in schema, so we'll return empty array
    const trades: any[] = [];

    // Build previous seasons data
    const previousSeasonsData = previousSeasonTeams.reduce((acc, team) => {
      const seasonId = team.seasonId;
      if (!acc[seasonId]) {
        acc[seasonId] = [];
      }
      acc[seasonId].push({
        teamId: team.externalId,
        teamName: team.name,
        manager: team.owner,
        record: team.record,
        roster: team.roster.map(player => ({
          playerId: player.playerId,
          playerName: player.playerName,
          position: player.position,
          team: player.team,
          acquisitionType: player.acquisitionType || "UNKNOWN",
          // Try to get enhanced info but it might not exist for old players
          fullName: playerMap.get(player.playerId)?.fullName || player.playerName,
        })),
      });
      return acc;
    }, {} as Record<number, any[]>);
    
    console.log("Previous seasons data structure:", {
      seasons: Object.keys(previousSeasonsData),
      sampleSeason: Object.keys(previousSeasonsData)[0] ? {
        year: Object.keys(previousSeasonsData)[0],
        teamCount: previousSeasonsData[Number(Object.keys(previousSeasonsData)[0])].length,
        sampleTeam: previousSeasonsData[Number(Object.keys(previousSeasonsData)[0])][0]?.teamName,
        sampleRosterSize: previousSeasonsData[Number(Object.keys(previousSeasonsData)[0])][0]?.roster.length,
      } : null,
    });

    // Build league data context with enhanced roster information
    const result = {
      leagueName: league.name,
      currentWeek: league.espnData?.currentScoringPeriod || 1,
      teams: teams.map(team => ({
        id: team._id,
        name: team.name,
        manager: team.owner,
        record: team.record,
        pointsFor: team.record.pointsFor || 0,
        pointsAgainst: team.record.pointsAgainst || 0,
        externalId: team.externalId, // ESPN team ID for consistency tracking across seasons
        roster: team.roster.map(rosterPlayer => {
          const playerDetails = playerMap.get(rosterPlayer.playerId);
          return {
            playerId: rosterPlayer.playerId,
            playerName: rosterPlayer.playerName,
            position: rosterPlayer.position,
            team: rosterPlayer.team,
            lineupSlotId: rosterPlayer.lineupSlotId,
            acquisitionType: rosterPlayer.acquisitionType,
            // Enhanced player details from players table
            fullName: playerDetails?.fullName || rosterPlayer.playerName,
            eligiblePositions: playerDetails?.eligiblePositions || [rosterPlayer.position],
            injuryStatus: playerDetails?.injuryStatus,
            stats: {
              appliedTotal: rosterPlayer.playerStats?.appliedTotal,
              projectedTotal: rosterPlayer.playerStats?.projectedTotal,
              seasonStats: playerDetails?.stats?.seasonStats,
              weeklyStats: playerDetails?.stats?.weeklyStats,
            },
            ownership: playerDetails?.ownership,
          };
        }),
      })),
      // Add previous season data for season welcome package
      previousSeasons: previousSeasonsData,
      recentMatchups: matchups.map(m => ({
        teamA: m.homeTeamId,
        teamB: m.awayTeamId,
        scoreA: m.homeScore,
        scoreB: m.awayScore,
        winner: m.winner,
        week: m.matchupPeriod,
        // Find top performers from rosters for each matchup
        topPerformers: teams
          .filter(t => t.externalId === m.homeTeamId || t.externalId === m.awayTeamId)
          .flatMap(t => 
            t.roster
              .filter(p => p.playerStats?.appliedTotal)
              .map(p => ({
                playerId: p.playerId,
                playerName: p.playerName,
                points: p.playerStats!.appliedTotal!,
                teamId: t._id,
                position: p.position,
              }))
          )
          .sort((a, b) => b.points - a.points)
          .slice(0, 5), // Top 5 performers per matchup
      })),
      trades: trades.map(t => ({
        teamA: t.teamA,
        teamB: t.teamB,
        playersFromA: t.playersFromA || [],
        playersFromB: t.playersFromB || [],
        date: new Date(t.createdAt).toLocaleDateString(),
      })),
      scoringType: league.settings?.scoringType || "PPR",
      rosterSize: league.settings?.rosterSize || 16,
      // Additional context for content generation
      leagueHistory: {
        foundedYear: league.createdAt ? new Date(league.createdAt).getFullYear() : currentYear,
        totalSeasons: leagueSeasons.length || 1,
        seasons: leagueSeasons.map(season => ({
          year: season.seasonId,
          champion: season.champion,
          runnerUp: season.runnerUp,
          regularSeasonChampion: season.regularSeasonChampion,
          settings: season.settings ? {
            scoringType: season.settings.scoringType,
            teamCount: season.settings.size, // Map size to teamCount
            playoffWeeks: season.settings.playoffWeeks,
          } : undefined,
        })),
      },
    };
    
    console.log("=== FINAL LEAGUE DATA SUMMARY ===");
    console.log({
      leagueName: result.leagueName,
      currentWeek: result.currentWeek,
      currentTeams: result.teams.length,
      previousSeasons: Object.keys(result.previousSeasons).length,
      matchups: result.recentMatchups.length,
      trades: result.trades.length,
      leagueHistorySeasons: result.leagueHistory.seasons?.length || 0,
    });
    console.log("=== getLeagueDataForGeneration END ===");
    
    return result;
  },
});;;;

// Mutation to update generated content
export const updateGeneratedContent = mutation({
  args: {
    articleId: v.id("aiContent"),
    title: v.string(),
    content: v.string(),
    summary: v.string(),
    metadata: v.object({
      week: v.optional(v.number()),
      featuredTeams: v.array(v.string()),
      featuredPlayers: v.array(v.string()),
      tags: v.array(v.string()),
      creditsUsed: v.number(),
      generationTime: v.number(),
      modelUsed: v.string(),
      promptTokens: v.number(),
      completionTokens: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.articleId, {
      title: args.title,
      content: args.content,
      // Note: summary field doesn't exist in schema
      metadata: {
        week: args.metadata.week,
        featured_teams: args.metadata.featuredTeams as any, // Cast to match schema
        credits_used: args.metadata.creditsUsed,
      },
      status: "published",
      publishedAt: Date.now(),
    });
  },
});

// Mutation to update content status
export const updateContentStatus = mutation({
  args: {
    articleId: v.id("aiContent"),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const update: any = { status: args.status };
    if (args.error) {
      update.error = args.error;
    }
    await ctx.db.patch(args.articleId, update);
  },
});