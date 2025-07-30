/* eslint-disable @typescript-eslint/no-explicit-any */
import { action, mutation, internalMutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";

// Helper functions for ESPN data mapping
const getPositionName = (positionId: number): string => {
  const positionMap: { [key: number]: string } = {
    1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST'
  };
  return positionMap[positionId] || 'FLEX';
};

const getTeamAbbreviation = (teamId: number): string => {
  // ESPN team ID to abbreviation mapping (simplified)
  const teamMap: { [key: number]: string } = {
    1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
    9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
    17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
    25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
  };
  return teamMap[teamId] || 'FA';
};

// Generate X-Fantasy-Filter header for all matchup periods in a season
const generateFantasyFilterHeader = (regularSeasonWeeks: number = 14, playoffWeeks: number = 4): string => {
  const totalWeeks = regularSeasonWeeks + playoffWeeks;
  const matchupPeriodIds = Array.from({ length: totalWeeks }, (_, i) => i + 1);
  
  return JSON.stringify({
    schedule: {
      filterMatchupPeriodIds: {
        value: matchupPeriodIds
      }
    }
  });
};

// Transform ESPN roster data to clean format
const transformRosterData = (rosterData: any) => {
  if (!rosterData || !rosterData.entries) {
    console.log('No roster data found!!!');
    return undefined;
  }

  console.log('Roster data found!!!');

  console.log(rosterData);
  // Ensure appliedStatTotal is a valid number, default to 0 if missing
  const appliedStatTotal = typeof rosterData.appliedStatTotal === 'number' 
    ? rosterData.appliedStatTotal 
    : 0;

  return {
    appliedStatTotal,
    players: rosterData.entries.map((entry: any) => {
      const player = entry.playerPoolEntry?.player;
      if (!player) return null;

      // Get appliedStats from the second stats entry (index 1) if available
      const appliedStats = player.stats && player.stats[0] ? player.stats[0].appliedStats : undefined;

      const projectedPoints = player.stats && player.stats[1] ? player.stats[1].appliedTotal.toFixed(1) : undefined;

      // Ensure appliedStatTotal is a valid number for the player too
      const playerAppliedStatTotal = typeof entry.playerPoolEntry?.appliedStatTotal === 'number'
        ? entry.playerPoolEntry.appliedStatTotal
        : 0;

      return {
        lineupSlotId: entry.lineupSlotId,
        espnId: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        fullName: player.fullName,
        position: getPositionName(player.defaultPositionId),
        points: playerAppliedStatTotal,
        appliedStats: appliedStats,
        projectedPoints: projectedPoints,
      };
    }).filter((player: any) => player !== null),
  };
};

// Matchup roster fetching is now in matchupRosters.ts to avoid circular dependencies


export const syncLeagueData = action({
  args: {
    leagueId: v.id("leagues"),
  },
  handler: async (ctx, args) => {
    // Get the league with ESPN auth data using internal query
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    
    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    try {
      // Use the stored ESPN auth data to fetch updated league information
      const currentYear = new Date().getFullYear();
      const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${currentYear}/segments/0/leagues/${league.externalId}`;
      
      const headers: HeadersInit = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Origin': 'https://fantasy.espn.com',
        'Referer': 'https://fantasy.espn.com/',
        'Sec-Ch-Ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'X-Fantasy-Platform': 'kona-PROD-871ba974fde0504c7ee3018049a715c0af70b886',
        'X-Fantasy-Source': 'kona'
      };
      
      // Add fantasy filter for all matchup periods to get roster data
      // Use league settings or reasonable defaults (most leagues are 14 regular + 4 playoff weeks)
      const regularSeasonWeeks = league.settings?.regularSeasonMatchupPeriods || 14;
      const playoffWeeks = league.settings?.playoffWeeks || 4;
      headers['X-Fantasy-Filter'] = generateFantasyFilterHeader(regularSeasonWeeks, playoffWeeks);
      
      if (league.espnData.isPrivate && league.espnData.espnS2 && league.espnData.swid) {
        headers['Cookie'] = `espn_s2=${league.espnData.espnS2}; SWID=${league.espnData.swid}`;
      }

      // Get comprehensive league data including players, matchups, draft info, and transactions
      const leagueResponse = await fetch(`${baseUrl}?view=mSettings&view=mTeams&view=mRoster&view=mMatchup&view=mMatchupScore&view=mStandings&view=mDraftDetail&view=mNav&view=modular&view=players_wl&view=kona_player_info&view=mLogo&view=mTeam&view=mStatus&view=mBoxscore&view=mPositionalRatings&view=kona_league_communication`, {
        headers
      });

      if (!leagueResponse.ok) {
        throw new Error(`ESPN API returned ${leagueResponse.status}: ${leagueResponse.statusText}`);
      }

      const leagueData = await leagueResponse.json();
      const teams = leagueData.teams || [];
      const members = leagueData.members || [];
      const settings = leagueData.settings;
      const schedule = leagueData.schedule || [];
      const players = leagueData.players || [];
      const draftDetail = leagueData.draftDetail;
      const communication = leagueData.communication || {};

      // Create a map of member IDs to member data for easy lookup
      const memberMap = new Map();
      members.forEach((member: any) => {
        memberMap.set(member.id, member);
      });
      
      // Log member map for debugging
      if (members.length > 0 && teams.length > 0) {
        console.log('Member/Owner data mapping:', {
          memberCount: members.length,
          sampleMemberId: members[0].id,
          memberMapSize: memberMap.size,
          firstTeamOwner: teams[0]?.owners?.[0],
          ownerType: typeof teams[0]?.owners?.[0],
          ownerInMap: teams[0]?.owners?.[0] ? memberMap.has(teams[0].owners[0]) : 'No owner'
        });
      }

      // Log data availability for debugging
      console.log('ESPN API Data Check:', {
        hasTeams: !!teams.length,
        teamsCount: teams.length,
        hasMembers: !!members.length,
        membersCount: members.length,
        sampleTeam: teams[0] ? {
          hasOwners: !!teams[0].owners,
          ownersLength: teams[0].owners?.length || 0,
          hasPrimaryOwner: !!teams[0].primaryOwner,
          hasLogo: !!teams[0].logo,
          logoUrl: teams[0].logo
        } : null
      });

      // Store draft data for current season
      if (settings || draftDetail) {
        const seasonData: any = {
          settings: {
            name: settings?.name || 'ESPN League',
            size: settings?.size || teams.length,
            scoringType: settings?.scoringSettings?.scoringType === 1 ? 'ppr' : 
                        settings?.scoringSettings?.scoringType === 2 ? 'half-ppr' : 'standard',
            playoffTeamCount: settings?.scheduleSettings?.playoffTeamCount || 6,
            playoffWeeks: settings?.scheduleSettings?.playoffWeekCount || 3,
            regularSeasonMatchupPeriods: settings?.scheduleSettings?.regularSeasonMatchupPeriods || 14,
            rosterSettings: settings?.rosterSettings,
          },
        };

        // Only include draftSettings if it exists
        if (settings?.draftSettings) {
          seasonData.draftSettings = settings.draftSettings;
        }

        // Only include draft picks if draft has actually occurred
        if (draftDetail?.drafted === 1 && draftDetail.picks) {
          seasonData.draft = draftDetail.picks;
        }

        // Only include draftInfo if draftDetail exists
        if (draftDetail) {
          seasonData.draftInfo = {
            draftDate: draftDetail.drafted === 1 ? 1 : undefined,
            draftType: draftDetail.type,
            timePerPick: draftDetail.timePerPick,
          };
        }

        await ctx.runMutation(api.espnSync.updateLeagueSeason, {
          leagueId: args.leagueId,
          seasonId: currentYear,
          seasonData,
        });
      }

      // Helper function for roster data
      // Note: The general league endpoint doesn't reliably return roster data
      // We'll use fetchHistoricalRosters after team sync for accurate roster data
      const getRosterData = (team: any) => {
        // Return empty array - rosters will be fetched separately using fetchHistoricalRosters
        return [];
      };

      // Helper function to get owner info with fallback logic
      const getOwnerInfo = (team: any) => {
        // First try to get owner from team.owners array
        if (team.owners?.[0]) {
          const owner = team.owners[0];
          
          // Check if owner is just a string ID (historical data) or an object (current data)
          if (typeof owner === 'string') {
            // Owner is just an ID, need to look up in members
            const member = memberMap.get(owner);
            if (member) {
              return {
                ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
                ownerInfo: {
                  displayName: member.displayName,
                  firstName: member.firstName,
                  lastName: member.lastName,
                  id: member.id?.toString() || owner,
                }
              };
            }
          } else if (owner.displayName || owner.firstName || owner.lastName) {
            // Owner is an object with properties
            return {
              ownerName: (owner.firstName && owner.lastName ? `${owner.firstName} ${owner.lastName}` : owner.displayName || owner.firstName || owner.lastName || 'Unknown'),
              ownerInfo: {
                displayName: owner.displayName,
                firstName: owner.firstName,
                lastName: owner.lastName,
                id: owner.id?.toString(),
              }
            };
          }
        }
        
        // Fallback to member data using primaryOwner
        if (team.primaryOwner && memberMap.has(team.primaryOwner)) {
          const member = memberMap.get(team.primaryOwner);
          return {
            ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
            ownerInfo: {
              displayName: member.displayName,
              firstName: member.firstName,
              lastName: member.lastName,
              id: member.id?.toString(),
            }
          };
        }
        
        // Last resort - try to find member by matching team name
        const matchingMember = members.find((m: any) => 
          team.name && (team.name.includes(m.displayName) || team.name.includes(m.firstName) || team.name.includes(m.lastName))
        );
        if (matchingMember) {
          return {
            ownerName: (matchingMember.firstName && matchingMember.lastName ? `${matchingMember.firstName} ${matchingMember.lastName}` : matchingMember.displayName) || 'Unknown',
            ownerInfo: {
              displayName: matchingMember.displayName,
              firstName: matchingMember.firstName,
              lastName: matchingMember.lastName,
              id: matchingMember.id?.toString(),
            }
          };
        }
        
        return {
          ownerName: 'Unknown',
          ownerInfo: undefined
        };
      };


      // Update teams with comprehensive data
      await ctx.runMutation(api.espnSync.updateTeams, {
        leagueId: args.leagueId,
        seasonId: currentYear,
        teamsData: teams.map((team: any) => {
          const { ownerName, ownerInfo } = getOwnerInfo(team);
          return {
            externalId: team.id.toString(),
            name: team.name || (team.location && team.nickname ? `${team.location} ${team.nickname}` : 'Unknown Team'),
            abbreviation: team.abbrev,
            location: team.location,
            nickname: team.nickname,
            logo: team.logo || team.logoURL || team.logoUrl || undefined,
            owner: ownerName,
            ownerInfo: ownerInfo,
          record: {
            wins: team.record?.overall?.wins || 0,
            losses: team.record?.overall?.losses || 0,
            ties: team.record?.overall?.ties || 0,
            pointsFor: team.record?.overall?.pointsFor || 0,
            pointsAgainst: team.record?.overall?.pointsAgainst || 0,
            playoffSeed: team.playoffSeed,
            divisionRecord: team.record?.division ? {
              wins: team.record.division.wins || 0,
              losses: team.record.division.losses || 0,
              ties: team.record.division.ties || 0,
            } : undefined,
          },
          roster: getRosterData(team),
            divisionId: team.divisionId,
          };
        })
      });

      // Sync players data if available
      if (players.length > 0) {
        await ctx.runMutation(api.espnSync.updatePlayers, {
          playersData: players.map((player: any) => ({
            externalId: player.id?.toString() || '',
            fullName: player.fullName || 'Unknown Player',
            firstName: player.firstName,
            lastName: player.lastName,
            defaultPosition: getPositionName(player.defaultPositionId),
            eligiblePositions: player.eligibleSlots?.map((slot: number) => getPositionName(slot)) || [],
            proTeamId: player.proTeamId,
            proTeamAbbrev: getTeamAbbreviation(player.proTeamId),
            injuryStatus: player.injuryStatus,
            stats: player.stats ? {
              seasonStats: {
                appliedTotal: player.stats.appliedTotal,
                projectedTotal: player.stats.projectedTotal,
                averagePoints: player.stats.averagePoints,
              }
            } : undefined,
            ownership: player.ownership ? {
              percentOwned: player.ownership.percentOwned,
              percentChange: player.ownership.percentChange,
              percentStarted: player.ownership.percentStarted,
            } : undefined,
          }))
        });
      }

      // Sync matchups data
      if (schedule.length > 0) {
        await ctx.runMutation(api.espnSync.updateMatchups, {
          leagueId: args.leagueId,
          seasonId: currentYear,
          matchupsData: schedule.map((matchup: any) => ({
            matchupPeriod: matchup.matchupPeriodId,
            scoringPeriod: matchup.id,
            homeTeamId: matchup.home?.teamId?.toString() || '',
            awayTeamId: matchup.away?.teamId?.toString() || '',
            homeScore: matchup.home?.totalPoints || 0,
            awayScore: matchup.away?.totalPoints || 0,
            homeProjectedScore: matchup.home?.totalProjectedPoints,
            awayProjectedScore: matchup.away?.totalProjectedPoints,
            homePointsByScoringPeriod: matchup.home?.pointsByScoringPeriod,
            awayPointsByScoringPeriod: matchup.away?.pointsByScoringPeriod,
            winner: matchup.winner === 'HOME' ? 'home' as const : 
                   matchup.winner === 'AWAY' ? 'away' as const : 
                   matchup.winner === 'TIE' ? 'tie' as const : undefined,
            playoffTier: matchup.playoffTierType,
            // Transform and clean roster data from current scoring period
            homeRoster: transformRosterData(matchup.home?.rosterForCurrentScoringPeriod),
            awayRoster: transformRosterData(matchup.away?.rosterForCurrentScoringPeriod),
          }))
        });
      }

      // Update league's ESPN data with new sync timestamp
      await ctx.runMutation(api.espnSync.updateLeagueSync, {
        leagueId: args.leagueId,
        currentScoringPeriod: settings?.scoringSettings?.matchupPeriods?.length || league.espnData.currentScoringPeriod,
      });

      // Fetch rosters using the dedicated roster endpoint
      console.log('Fetching current season rosters...');
      try {
        const rosterResult = await ctx.runAction(api.espnSync.fetchHistoricalRosters, {
          leagueId: args.leagueId,
          seasonId: currentYear,
        });
        
        if (rosterResult.success) {
          console.log(`Successfully fetched rosters for ${rosterResult.totalRostersFetched} teams`);
        } else {
          console.warn('Failed to fetch some rosters:', rosterResult.message);
        }
      } catch (rosterError) {
        console.error('Error fetching rosters:', rosterError);
        // Don't fail the entire sync if roster fetching fails
      }

      // Fetch matchup rosters for all scoring periods
      console.log('Fetching matchup rosters for all scoring periods...');
      try {
        const matchupRosterResult = await ctx.runAction(api.matchupRosters.fetchMatchupRosters, {
          leagueId: args.leagueId,
          seasonId: currentYear,
        });
        
        if (matchupRosterResult.success) {
          console.log(`Successfully fetched matchup rosters for ${matchupRosterResult.successfulPeriods}/${matchupRosterResult.totalPeriods} periods`);
        } else {
          console.warn('Failed to fetch matchup rosters:', matchupRosterResult.message);
        }
      } catch (matchupRosterError) {
        console.error('Error fetching matchup rosters:', matchupRosterError);
        // Don't fail the entire sync if matchup roster fetching fails
      }

      // Process transaction data if available
      if (communication.messages && communication.messages.length > 0) {
        console.log(`Processing ${communication.messages.length} transaction messages...`);
        try {
          await ctx.runAction(api.espnSync.processTransactionData, {
            leagueId: args.leagueId,
            seasonId: currentYear,
            messages: communication.messages,
            teams: teams.map((t: any) => ({
              id: t.id.toString(),
              name: t.name || 'Unknown Team',
              owner: getOwnerInfo(t).ownerName,
            })),
          });
        } catch (transactionError) {
          console.error('Error processing transactions:', transactionError);
          // Don't fail the entire sync if transaction processing fails
        }
      }

      // Run data processing pipeline after successful sync
      // Note: This would be called separately after sync completes
      // to avoid circular dependencies and internal mutation issues
      console.log("Sync completed. Data processing should be triggered separately.");

      return {
        success: true,
        message: "League data synced successfully",
        syncedAt: Date.now(),
      };

    } catch (error) {
      console.error("Failed to sync ESPN league data:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown sync error",
      };
    }
  },
});

export const updateTeams = mutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    teamsData: v.array(v.object({
      externalId: v.string(),
      name: v.string(),
      abbreviation: v.optional(v.string()),
      location: v.optional(v.string()),
      nickname: v.optional(v.string()),
      logo: v.optional(v.string()),
      owner: v.string(),
      ownerInfo: v.optional(v.object({
        displayName: v.optional(v.string()),
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        id: v.optional(v.string()),
      })),
      record: v.object({
        wins: v.number(),
        losses: v.number(),
        ties: v.number(),
        pointsFor: v.optional(v.number()),
        pointsAgainst: v.optional(v.number()),
        playoffSeed: v.optional(v.number()),
        divisionRecord: v.optional(v.object({
          wins: v.number(),
          losses: v.number(),
          ties: v.number(),
        })),
      }),
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
      divisionId: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const processedExternalIds = new Set<string>();

    // Upsert teams - update if exists, insert if new
    for (const teamData of args.teamsData) {
      processedExternalIds.add(teamData.externalId);
      
      // Check if team already exists
      const existingTeam = await ctx.db
        .query("teams")
        .withIndex("by_external", (q) => 
          q.eq("leagueId", args.leagueId)
           .eq("externalId", teamData.externalId)
           .eq("seasonId", args.seasonId)
        )
        .first();

      const teamRecord = {
        leagueId: args.leagueId,
        externalId: teamData.externalId,
        name: teamData.name,
        abbreviation: teamData.abbreviation,
        location: teamData.location,
        nickname: teamData.nickname,
        logo: teamData.logo,
        owner: teamData.owner,
        ownerInfo: teamData.ownerInfo,
        record: teamData.record,
        roster: teamData.roster,
        seasonId: args.seasonId,
        divisionId: teamData.divisionId,
        updatedAt: now,
      };

      if (existingTeam) {
        // Update existing team, preserving the ID
        await ctx.db.patch(existingTeam._id, teamRecord);
      } else {
        // Insert new team
        await ctx.db.insert("teams", {
          ...teamRecord,
          createdAt: now,
        });
      }
    }

    // Remove teams that are no longer in the league/season
    // This handles cases where teams are removed from the league
    const allTeamsForSeason = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    for (const team of allTeamsForSeason) {
      if (!processedExternalIds.has(team.externalId)) {
        // Check if this team has any claims before deleting
        const teamClaim = await ctx.db
          .query("teamClaims")
          .withIndex("by_team_season", (q) => 
            q.eq("teamId", team._id).eq("seasonId", args.seasonId)
          )
          .first();
        
        if (!teamClaim) {
          // Safe to delete - no one has claimed this team
          await ctx.db.delete(team._id);
        } else {
          // Mark as inactive instead of deleting to preserve claims
          await ctx.db.patch(team._id, { 
            updatedAt: now,
            isActive: false 
          });
        }
      }
    }
  },
});;

export const updatePlayers = mutation({
  args: {
    playersData: v.array(v.object({
      externalId: v.string(),
      fullName: v.string(),
      firstName: v.optional(v.string()),
      lastName: v.optional(v.string()),
      defaultPosition: v.string(),
      eligiblePositions: v.array(v.string()),
      proTeamId: v.optional(v.number()),
      proTeamAbbrev: v.optional(v.string()),
      injuryStatus: v.optional(v.string()),
      stats: v.optional(v.object({
        seasonStats: v.optional(v.object({
          appliedTotal: v.optional(v.number()),
          projectedTotal: v.optional(v.number()),
          averagePoints: v.optional(v.number()),
        })),
      })),
      ownership: v.optional(v.object({
        percentOwned: v.optional(v.number()),
        percentChange: v.optional(v.number()),
        percentStarted: v.optional(v.number()),
      })),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    for (const playerData of args.playersData) {
      // Check if player already exists
      const existingPlayer = await ctx.db
        .query("players")
        .withIndex("by_external_id", (q) => q.eq("externalId", playerData.externalId))
        .first();

      if (existingPlayer) {
        // Update existing player
        await ctx.db.patch(existingPlayer._id, {
          fullName: playerData.fullName,
          firstName: playerData.firstName,
          lastName: playerData.lastName,
          defaultPosition: playerData.defaultPosition,
          eligiblePositions: playerData.eligiblePositions,
          proTeamId: playerData.proTeamId,
          proTeamAbbrev: playerData.proTeamAbbrev,
          injuryStatus: playerData.injuryStatus,
          stats: playerData.stats,
          ownership: playerData.ownership,
          updatedAt: now,
        });
      } else {
        // Create new player
        await ctx.db.insert("players", {
          externalId: playerData.externalId,
          fullName: playerData.fullName,
          firstName: playerData.firstName,
          lastName: playerData.lastName,
          defaultPosition: playerData.defaultPosition,
          eligiblePositions: playerData.eligiblePositions,
          proTeamId: playerData.proTeamId,
          proTeamAbbrev: playerData.proTeamAbbrev,
          injuryStatus: playerData.injuryStatus,
          stats: playerData.stats,
          ownership: playerData.ownership,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  },
});

export const updateMatchups = mutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    matchupsData: v.array(v.object({
      matchupPeriod: v.number(),
      scoringPeriod: v.number(),
      homeTeamId: v.string(),
      awayTeamId: v.string(),
      homeScore: v.number(),
      awayScore: v.number(),
      homeProjectedScore: v.optional(v.number()),
      awayProjectedScore: v.optional(v.number()),
      homePointsByScoringPeriod: v.optional(v.record(v.string(), v.number())),
      awayPointsByScoringPeriod: v.optional(v.record(v.string(), v.number())),
      winner: v.optional(v.union(v.literal("home"), v.literal("away"), v.literal("tie"))),
      playoffTier: v.optional(v.string()),
      
      // Clean roster data from current scoring period
      homeRoster: v.optional(v.any()),
      awayRoster: v.optional(v.any()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const processedMatchupKeys = new Set<string>();

    // Upsert matchups - update if exists, insert if new
    for (const matchupData of args.matchupsData) {
      // Create a unique key for this matchup
      const matchupKey = `${matchupData.matchupPeriod}-${matchupData.homeTeamId}-${matchupData.awayTeamId}`;
      processedMatchupKeys.add(matchupKey);
      
      // Check if matchup already exists
      const existingMatchup = await ctx.db
        .query("matchups")
        .withIndex("by_unique_matchup", (q) => 
          q.eq("leagueId", args.leagueId)
           .eq("seasonId", args.seasonId)
           .eq("matchupPeriod", matchupData.matchupPeriod)
           .eq("homeTeamId", matchupData.homeTeamId)
           .eq("awayTeamId", matchupData.awayTeamId)
        )
        .first();

      const matchupRecord = {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        matchupPeriod: matchupData.matchupPeriod,
        scoringPeriod: matchupData.scoringPeriod,
        homeTeamId: matchupData.homeTeamId,
        awayTeamId: matchupData.awayTeamId,
        homeScore: matchupData.homeScore,
        awayScore: matchupData.awayScore,
        homeProjectedScore: matchupData.homeProjectedScore,
        awayProjectedScore: matchupData.awayProjectedScore,
        homePointsByScoringPeriod: matchupData.homePointsByScoringPeriod,
        awayPointsByScoringPeriod: matchupData.awayPointsByScoringPeriod,
        winner: matchupData.winner,
        playoffTier: matchupData.playoffTier,
        homeRoster: matchupData.homeRoster,
        awayRoster: matchupData.awayRoster,
        updatedAt: now,
      };

      if (existingMatchup) {
        // Update existing matchup, preserving the ID
        await ctx.db.patch(existingMatchup._id, matchupRecord);
      } else {
        // Insert new matchup
        await ctx.db.insert("matchups", {
          ...matchupRecord,
          createdAt: now,
        });
      }
    }

    // Remove matchups that are no longer in the data
    // This handles cases where matchups are removed or corrected
    const allMatchupsForSeason = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    for (const matchup of allMatchupsForSeason) {
      const matchupKey = `${matchup.matchupPeriod}-${matchup.homeTeamId}-${matchup.awayTeamId}`;
      if (!processedMatchupKeys.has(matchupKey)) {
        // Safe to delete - this matchup no longer exists in the source data
        await ctx.db.delete(matchup._id);
      }
    }
  },
});;

export const syncHistoricalData = action({
  args: {
    leagueId: v.id("leagues"),
    years: v.optional(v.array(v.number())), // If not provided, will sync last 10 seasons
  },
  handler: async (ctx, args) => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    
    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    const currentYear = new Date().getFullYear();
    const yearsToSync = args.years || Array.from({length: 10}, (_, i) => currentYear - (i + 1));

    const results = [];

    for (const year of yearsToSync) {
      try {
        const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${league.externalId}`;
        
        const headers: HeadersInit = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Origin': 'https://fantasy.espn.com',
          'Referer': 'https://fantasy.espn.com/',
          'Sec-Ch-Ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site',
          'X-Fantasy-Platform': 'kona-PROD-871ba974fde0504c7ee3018049a715c0af70b886',
          'X-Fantasy-Source': 'kona'
        };
        
        // Add fantasy filter for all matchup periods to get roster data
        const regularSeasonWeeks = league.settings?.regularSeasonMatchupPeriods || 14;
        const playoffWeeks = league.settings?.playoffWeeks || 4;
        headers['X-Fantasy-Filter'] = generateFantasyFilterHeader(regularSeasonWeeks, playoffWeeks);
        
        if (league.espnData.isPrivate && league.espnData.espnS2 && league.espnData.swid) {
          // Decode URL-encoded espnS2 if needed
          const espnS2 = decodeURIComponent(league.espnData.espnS2);
          headers['Cookie'] = `espn_s2=${espnS2}; SWID=${league.espnData.swid}`;
          console.log(`Using ESPN auth for year ${year}:`, {
            hasEspnS2: !!league.espnData.espnS2,
            espnS2Length: league.espnData.espnS2.length,
            hasSwid: !!league.espnData.swid,
            swidFormat: league.espnData.swid.startsWith('{') && league.espnData.swid.endsWith('}')
          });
        }

        // Get historical league data including player information
        const leagueResponse = await fetch(`${baseUrl}?view=mSettings&view=mTeams&view=mStandings&view=mMatchup&view=mDraftDetail&view=players_wl&view=kona_player_info&view=mRoster&view=mBoxscore&view=mPositionalRatings`, {
          headers
        });

        if (!leagueResponse.ok) {
          console.warn(`Failed to fetch data for year ${year}: ${leagueResponse.status}`);
          continue;
        }

        const leagueData = await leagueResponse.json();
        
        // Debug logging for historical data
        if (year !== currentYear) {
          console.log(`Historical data for ${year}:`, {
            hasTeams: !!leagueData.teams,
            teamsCount: leagueData.teams?.length || 0,
            hasMembers: !!leagueData.members,
            membersCount: leagueData.members?.length || 0,
            hasStatus: !!leagueData.status,
            sampleTeam: leagueData.teams?.[0] ? {
              id: leagueData.teams[0].id,
              name: leagueData.teams[0].name,
              location: leagueData.teams[0].location,
              nickname: leagueData.teams[0].nickname,
              abbrev: leagueData.teams[0].abbrev,
              hasRecord: !!leagueData.teams[0].record,
              hasOwners: !!leagueData.teams[0].owners,
              recordOverall: leagueData.teams[0].record?.overall,
              owners: leagueData.teams[0].owners,
              allKeys: Object.keys(leagueData.teams[0])
            } : null,
            sampleMember: leagueData.members?.[0] ? {
              id: leagueData.members[0].id,
              displayName: leagueData.members[0].displayName,
              isLeagueManager: leagueData.members[0].isLeagueManager
            } : null
          });
        }
        const teams = leagueData.teams || [];
        const members = leagueData.members || [];
        const settings = leagueData.settings;
        const schedule = leagueData.schedule || [];
        const draftDetail = leagueData.draftDetail;

        // Create a map of member IDs to member data for easy lookup
        const memberMap = new Map();
        members.forEach((member: any) => {
          memberMap.set(member.id, member);
        });
        
        // Log member map for debugging in historical data
        if (year !== currentYear && members.length > 0) {
          console.log(`Member data for ${year}:`, {
            memberCount: members.length,
            sampleMemberId: members[0].id,
            memberMapSize: memberMap.size,
            firstTeamOwner: teams[0]?.owners?.[0],
            ownerInMap: teams[0]?.owners?.[0] ? memberMap.has(teams[0].owners[0]) : 'No owner'
          });
        }

        // Helper function for roster data
        // Note: The general league endpoint doesn't reliably return roster data
        // We'll use fetchHistoricalRosters after team sync for accurate roster data
        const getRosterData = (team: any) => {
          // Return empty array - rosters will be fetched separately using fetchHistoricalRosters
          return [];
        };

        // Helper function to get owner info with fallback logic
      const getOwnerInfo = (team: any) => {
        // First try to get owner from team.owners array
        if (team.owners?.[0]) {
          const owner = team.owners[0];
          
          // Check if owner is just a string ID (historical data) or an object (current data)
          if (typeof owner === 'string') {
            // Owner is just an ID, need to look up in members
            const member = memberMap.get(owner);
            if (member) {
              return {
                ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
                ownerInfo: {
                  displayName: member.displayName,
                  firstName: member.firstName,
                  lastName: member.lastName,
                  id: member.id?.toString() || owner,
                }
              };
            }
          } else if (owner.displayName || owner.firstName || owner.lastName) {
            // Owner is an object with properties
            return {
              ownerName: (owner.firstName && owner.lastName ? `${owner.firstName} ${owner.lastName}` : owner.displayName || owner.firstName || owner.lastName || 'Unknown'),
              ownerInfo: {
                displayName: owner.displayName,
                firstName: owner.firstName,
                lastName: owner.lastName,
                id: owner.id?.toString(),
              }
            };
          }
        }
          
          // Fallback to member data using primaryOwner
          if (team.primaryOwner && memberMap.has(team.primaryOwner)) {
            const member = memberMap.get(team.primaryOwner);
            return {
              ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
              ownerInfo: {
                displayName: member.displayName,
                firstName: member.firstName,
                lastName: member.lastName,
                id: member.id?.toString(),
              }
            };
          }
          
          // Last resort - try to find member by matching team name  
          const matchingMember = members.find((m: any) => 
            team.name && (team.name.includes(m.displayName) || team.name.includes(m.firstName) || team.name.includes(m.lastName))
          );
          if (matchingMember) {
            return {
              ownerName: (matchingMember.firstName && matchingMember.lastName ? `${matchingMember.firstName} ${matchingMember.lastName}` : matchingMember.displayName) || 'Unknown',
              ownerInfo: {
                displayName: matchingMember.displayName,
                firstName: matchingMember.firstName,
                lastName: matchingMember.lastName,
                id: matchingMember.id?.toString(),
              }
            };
          }
          
          return {
            ownerName: 'Unknown',
            ownerInfo: undefined
          };
        };

        // Process champion and runner-up from final standings
        let champion, runnerUp;
        
        // First try to use rankCalculatedFinal for the most accurate results
        const finalRankings = teams
          .filter((team: any) => team.rankCalculatedFinal)
          .sort((a: any, b: any) => a.rankCalculatedFinal - b.rankCalculatedFinal);
          
        if (finalRankings.length >= 2) {
          champion = finalRankings[0]; // rankCalculatedFinal: 1
          runnerUp = finalRankings[1];  // rankCalculatedFinal: 2
        } else {
          // Fallback: Use playoff seeds for completed seasons
          const finalStandings = teams
            .filter((team: any) => team.playoffSeed)
            .sort((a: any, b: any) => a.playoffSeed - b.playoffSeed);
            
          if (finalStandings.length >= 2) {
            champion = finalStandings[0];
            runnerUp = finalStandings[1];
          } else {
            // Last resort: Use best regular season records for historical data
            const sortedByRecord = teams
              .sort((a: any, b: any) => {
                const aWinPct = (a.record?.overall?.wins || 0) / ((a.record?.overall?.wins || 0) + (a.record?.overall?.losses || 0) || 1);
                const bWinPct = (b.record?.overall?.wins || 0) / ((b.record?.overall?.wins || 0) + (b.record?.overall?.losses || 0) || 1);
                if (aWinPct !== bWinPct) return bWinPct - aWinPct;
                return (b.record?.overall?.pointsFor || 0) - (a.record?.overall?.pointsFor || 0);
              });
            
            // Only set champion/runnerUp if we have valid record data
            if (sortedByRecord[0]?.record?.overall?.wins > 0) {
              champion = sortedByRecord[0];
              runnerUp = sortedByRecord[1];
            }
          }
        }

        // Find regular season champion (best record)
        const regularSeasonChamp = teams
          .sort((a: any, b: any) => {
            const aWinPct = a.record?.overall?.wins / (a.record?.overall?.wins + a.record?.overall?.losses || 1);
            const bWinPct = b.record?.overall?.wins / (b.record?.overall?.wins + b.record?.overall?.losses || 1);
            if (aWinPct !== bWinPct) return bWinPct - aWinPct;
            return (b.record?.overall?.pointsFor || 0) - (a.record?.overall?.pointsFor || 0);
          })[0];

        // Create league season record
        await ctx.runMutation(api.espnSync.updateLeagueSeason, {
          leagueId: args.leagueId,
          seasonId: year,
          seasonData: {
            settings: {
              name: settings?.name || league.name,
              size: settings?.size || teams.length,
              scoringType: settings?.scoringSettings?.scoringType === 1 ? 'ppr' : 
                          settings?.scoringSettings?.scoringType === 2 ? 'half-ppr' : 'standard',
              playoffTeamCount: settings?.scheduleSettings?.playoffTeamCount || 6,
              playoffWeeks: settings?.scheduleSettings?.playoffWeekCount || 3,
              regularSeasonMatchupPeriods: settings?.scheduleSettings?.regularSeasonMatchupPeriods || 14,
              rosterSettings: settings?.rosterSettings,
            },
            champion: champion ? {
              teamId: champion.id?.toString() || '',
              teamName: champion.name || champion.location + ' ' + champion.nickname,
              owner: champion.owners?.[0]?.displayName || 
                    (champion.owners?.[0]?.firstName && champion.owners?.[0]?.lastName 
                      ? `${champion.owners[0].firstName} ${champion.owners[0].lastName}` 
                      : champion.owners?.[0]?.firstName || champion.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: champion.record?.overall?.wins || 0,
                losses: champion.record?.overall?.losses || 0,
                ties: champion.record?.overall?.ties || 0,
              },
              pointsFor: champion.record?.overall?.pointsFor,
            } : undefined,
            runnerUp: runnerUp ? {
              teamId: runnerUp.id?.toString() || '',
              teamName: runnerUp.name || runnerUp.location + ' ' + runnerUp.nickname,
              owner: runnerUp.owners?.[0]?.displayName || 
                    (runnerUp.owners?.[0]?.firstName && runnerUp.owners?.[0]?.lastName 
                      ? `${runnerUp.owners[0].firstName} ${runnerUp.owners[0].lastName}` 
                      : runnerUp.owners?.[0]?.firstName || runnerUp.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: runnerUp.record?.overall?.wins || 0,
                losses: runnerUp.record?.overall?.losses || 0,
                ties: runnerUp.record?.overall?.ties || 0,
              },
              pointsFor: runnerUp.record?.overall?.pointsFor,
            } : undefined,
            regularSeasonChampion: regularSeasonChamp ? {
              teamId: regularSeasonChamp.id?.toString() || '',
              teamName: regularSeasonChamp.name || regularSeasonChamp.location + ' ' + regularSeasonChamp.nickname,
              owner: regularSeasonChamp.owners?.[0]?.displayName || 
                    (regularSeasonChamp.owners?.[0]?.firstName && regularSeasonChamp.owners?.[0]?.lastName 
                      ? `${regularSeasonChamp.owners[0].firstName} ${regularSeasonChamp.owners[0].lastName}` 
                      : regularSeasonChamp.owners?.[0]?.firstName || regularSeasonChamp.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: regularSeasonChamp.record?.overall?.wins || 0,
                losses: regularSeasonChamp.record?.overall?.losses || 0,
                ties: regularSeasonChamp.record?.overall?.ties || 0,
              },
              pointsFor: regularSeasonChamp.record?.overall?.pointsFor,
            } : undefined,
            draftInfo: draftDetail ? {
              draftDate: draftDetail.drafted === 1 ? 1 : undefined,
              draftType: draftDetail.type,
              timePerPick: draftDetail.timePerPick,
            } : undefined,
          }
        });

        // Sync teams for this historical season
        await ctx.runMutation(api.espnSync.updateTeams, {
          leagueId: args.leagueId,
          seasonId: year,
          teamsData: teams.map((team: any) => {
            const { ownerName, ownerInfo } = getOwnerInfo(team);
            return {
              externalId: team.id.toString(),
              name: team.name || 
                    (team.location && team.nickname ? `${team.location} ${team.nickname}` : 
                     team.location || team.nickname || `Team ${team.id}` || 'Unknown Team'),
              abbreviation: team.abbrev,
              location: team.location,
              nickname: team.nickname,
              logo: team.logo || team.logoURL || team.logoUrl || undefined,
              owner: ownerName,
              ownerInfo: ownerInfo,
            record: {
              wins: team.record?.overall?.wins || 0,
              losses: team.record?.overall?.losses || 0,
              ties: team.record?.overall?.ties || 0,
              pointsFor: team.record?.overall?.pointsFor || 0,
              pointsAgainst: team.record?.overall?.pointsAgainst || 0,
              playoffSeed: team.playoffSeed,
              divisionRecord: team.record?.division ? {
                wins: team.record.division.wins || 0,
                losses: team.record.division.losses || 0,
                ties: team.record.division.ties || 0,
              } : undefined,
            },
            roster: getRosterData(team),
            divisionId: team.divisionId,
            };
          })
        });

        // Sync matchups for historical season if available
        if (schedule.length > 0) {
          await ctx.runMutation(api.espnSync.updateMatchups, {
            leagueId: args.leagueId,
            seasonId: year,
            matchupsData: schedule.map((matchup: any) => ({
              matchupPeriod: matchup.matchupPeriodId,
              scoringPeriod: matchup.id,
              homeTeamId: matchup.home?.teamId?.toString() || '',
              awayTeamId: matchup.away?.teamId?.toString() || '',
              homeScore: matchup.home?.totalPoints || 0,
              awayScore: matchup.away?.totalPoints || 0,
              homeProjectedScore: matchup.home?.totalProjectedPoints,
              awayProjectedScore: matchup.away?.totalProjectedPoints,
              homePointsByScoringPeriod: matchup.home?.pointsByScoringPeriod,
              awayPointsByScoringPeriod: matchup.away?.pointsByScoringPeriod,
              winner: matchup.winner === 'HOME' ? 'home' as const : 
                     matchup.winner === 'AWAY' ? 'away' as const : 
                     matchup.winner === 'TIE' ? 'tie' as const : undefined,
              playoffTier: matchup.playoffTierType,
              // Transform and clean roster data from current scoring period
              homeRoster: transformRosterData(matchup.home?.rosterForCurrentScoringPeriod),
              awayRoster: transformRosterData(matchup.away?.rosterForCurrentScoringPeriod),
            }))
          });
        }

        results.push({ year, success: true });
      } catch (error) {
        console.error(`Failed to sync historical data for year ${year}:`, error);
        results.push({ year, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    return {
      success: true,
      results,
      message: `Historical data sync completed for years: ${yearsToSync.join(', ')}`,
    };
  },
});

export const updateLeagueSeason = mutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    seasonData: v.object({
      settings: v.object({
        name: v.string(),
        size: v.number(),
        scoringType: v.string(),
        playoffTeamCount: v.number(),
        playoffWeeks: v.number(),
        regularSeasonMatchupPeriods: v.number(),
        rosterSettings: v.optional(v.any()),
      }),
      champion: v.optional(v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
        record: v.object({
          wins: v.number(),
          losses: v.number(),
          ties: v.number(),
        }),
        pointsFor: v.optional(v.number()),
      })),
      runnerUp: v.optional(v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
        record: v.object({
          wins: v.number(),
          losses: v.number(),
          ties: v.number(),
        }),
        pointsFor: v.optional(v.number()),
      })),
      regularSeasonChampion: v.optional(v.object({
        teamId: v.string(),
        teamName: v.string(),
        owner: v.string(),
        record: v.object({
          wins: v.number(),
          losses: v.number(),
          ties: v.number(),
        }),
        pointsFor: v.optional(v.number()),
      })),
      draftInfo: v.optional(v.object({
        draftDate: v.optional(v.number()),
        draftType: v.optional(v.string()),
        timePerPick: v.optional(v.number()),
      })),
      draftSettings: v.optional(v.any()),
      draft: v.optional(v.array(v.object({
        autoDraftTypeId: v.number(),
        bidAmount: v.number(),
        id: v.number(),
        keeper: v.boolean(),
        lineupSlotId: v.number(),
        memberId: v.optional(v.string()),
        nominatingTeamId: v.number(),
        overallPickNumber: v.number(),
        playerId: v.number(),
        reservedForKeeper: v.boolean(),
        roundId: v.number(),
        roundPickNumber: v.number(),
        teamId: v.number(),
        tradeLocked: v.boolean(),
      }))),
    }),
  },
  handler: async (ctx, args) => {
    // Check if season already exists
    const existingSeason = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .first();

    const now = Date.now();

    if (existingSeason) {
      // Update existing season
      await ctx.db.patch(existingSeason._id, {
        settings: args.seasonData.settings,
        champion: args.seasonData.champion,
        runnerUp: args.seasonData.runnerUp,
        regularSeasonChampion: args.seasonData.regularSeasonChampion,
        draftInfo: args.seasonData.draftInfo,
        draftSettings: args.seasonData.draftSettings,
        draft: args.seasonData.draft,
      });
    } else {
      // Create new season record
      await ctx.db.insert("leagueSeasons", {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
        settings: args.seasonData.settings,
        champion: args.seasonData.champion,
        runnerUp: args.seasonData.runnerUp,
        regularSeasonChampion: args.seasonData.regularSeasonChampion,
        draftInfo: args.seasonData.draftInfo,
        draftSettings: args.seasonData.draftSettings,
        draft: args.seasonData.draft,
        createdAt: now,
      });
    }
  },
});
export const updateSeasonDraftData = mutation({
  args: {
    seasonId: v.id("leagueSeasons"),
    draftSettings: v.optional(v.any()),
    draft: v.optional(v.array(v.object({
      autoDraftTypeId: v.number(),
      bidAmount: v.number(),
      id: v.number(),
      keeper: v.boolean(),
      lineupSlotId: v.number(),
      memberId: v.optional(v.string()),
      nominatingTeamId: v.number(),
      overallPickNumber: v.number(),
      playerId: v.number(),
      reservedForKeeper: v.boolean(),
      roundId: v.number(),
      roundPickNumber: v.number(),
      teamId: v.number(),
      tradeLocked: v.boolean(),
    }))),
    draftInfo: v.optional(v.object({
      draftDate: v.optional(v.number()),
      draftType: v.optional(v.string()),
      timePerPick: v.optional(v.number()),
    })),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.seasonId, {
      draftSettings: args.draftSettings,
      draft: args.draft,
      draftInfo: args.draftInfo,
    });
  },
});

// Comprehensive sync function for both current and historical data
// Helper function to validate ESPN credentials
const validateEspnCredentials = async (leagueId: string, espnS2?: string, swid?: string): Promise<{
  isValid: boolean;
  error?: string;
}> => {
  if (!espnS2 || !swid) {
    return { isValid: false, error: "Missing ESPN S2 or SWID credentials" };
  }

  try {
    const currentYear = new Date().getFullYear();
    const testUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${currentYear}/segments/0/leagues/${leagueId}?view=mSettings`;
    
    const response = await fetch(testUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Cookie': `espn_s2=${decodeURIComponent(espnS2)}; SWID=${swid}`
      }
    });

    return {
      isValid: response.ok,
      error: response.ok ? undefined : `ESPN API returned ${response.status}: ${response.statusText}`
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : "Unknown error validating credentials"
    };
  }
};
export const syncAllLeagueData = action({
  args: {
    leagueId: v.id("leagues"),
    includeCurrentSeason: v.optional(v.boolean()),
    historicalYears: v.optional(v.number()), // Number of years to go back
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    totalYearsRequested: number;
    totalSynced: number;
    totalErrors: number;
    results: Array<{
      year: number;
      success: boolean;
      error?: string;
      teamsCount?: number;
      matchupsCount?: number;
      playersCount?: number;
      rostersCount?: number;
      matchupRostersCount?: number;
    }>;
    message: string;
    syncedAt: number;
  }> => {
    const league: any = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    
    console.log('League ESPN data check:', {
      hasEspnData: !!league?.espnData,
      isPrivate: league?.espnData?.isPrivate,
      hasEspnS2: !!league?.espnData?.espnS2,
      hasSwid: !!league?.espnData?.swid,
      espnS2Length: league?.espnData?.espnS2?.length,
      swidFormat: league?.espnData?.swid?.startsWith?.('{') && league?.espnData?.swid?.endsWith?.('}')
    });
    
    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    // Validate ESPN credentials if league is private
    if (league.espnData.isPrivate) {
      const credentialsCheck = await validateEspnCredentials(
        league.externalId, 
        league.espnData.espnS2, 
        league.espnData.swid
      );
      
      if (!credentialsCheck.isValid) {
        throw new Error(`ESPN credentials invalid: ${credentialsCheck.error}. Please re-authenticate with ESPN.`);
      }
    }

    const currentYear = new Date().getFullYear();
    const includeCurrentSeason = args.includeCurrentSeason ?? true;
    const yearsBack = args.historicalYears ?? 10;
    
    const yearsToSync = [];
    
    // Add current season if requested
    if (includeCurrentSeason) {
      yearsToSync.push(currentYear);
    }
    
    // Add historical years
    for (let i = 1; i <= yearsBack; i++) {
      yearsToSync.push(currentYear - i);
    }

    const results = [];
    let totalSynced = 0;
    let totalErrors = 0;

    for (const year of yearsToSync) {
      try {
        console.log(`Starting sync for year ${year}...`);
        
        const baseUrl: string = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leagues/${league.externalId}`;
        
        const headers: HeadersInit = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Origin': 'https://fantasy.espn.com',
          'Referer': 'https://fantasy.espn.com/',
          'Sec-Ch-Ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site',
          'X-Fantasy-Platform': 'kona-PROD-871ba974fde0504c7ee3018049a715c0af70b886',
          'X-Fantasy-Source': 'kona'
        };
        
        // Add fantasy filter for all matchup periods to get roster data
        const regularSeasonWeeks = league.settings?.regularSeasonMatchupPeriods || 14;
        const playoffWeeks = league.settings?.playoffWeeks || 4;
        headers['X-Fantasy-Filter'] = generateFantasyFilterHeader(regularSeasonWeeks, playoffWeeks);
        
        if (league.espnData.isPrivate && league.espnData.espnS2 && league.espnData.swid) {
          // Decode URL-encoded espnS2 if needed
          const espnS2 = decodeURIComponent(league.espnData.espnS2);
          headers['Cookie'] = `espn_s2=${espnS2}; SWID=${league.espnData.swid}`;
          console.log(`Using ESPN auth for year ${year}:`, {
            hasEspnS2: !!league.espnData.espnS2,
            espnS2Length: league.espnData.espnS2.length,
            hasSwid: !!league.espnData.swid,
            swidFormat: league.espnData.swid.startsWith('{') && league.espnData.swid.endsWith('}')
          });
        }

        // For current season, get more comprehensive data
        const viewParams = year === currentYear 
          ? '?view=mSettings&view=mTeams&view=mRoster&view=mMatchup&view=mMatchupScore&view=mStandings&view=mDraftDetail&view=mNav&view=modular&view=players_wl&view=kona_player_info&view=mLogo&view=mTeam&view=mStatus&view=mBoxscore&view=mPositionalRatings&view=kona_league_communication'
          : '?view=mSettings&view=mTeams&view=mRoster&view=mMatchup&view=mMatchupScore&view=mStandings&view=mDraftDetail&view=mNav&view=modular&view=players_wl&view=kona_player_info&view=mLogo&view=mTeam&view=mStatus&view=mBoxscore&view=mPositionalRatings&view=kona_league_communication';

        const leagueResponse: Response = await fetch(`${baseUrl}${viewParams}`, {
          headers
        });

        if (!leagueResponse.ok) {
          const responseText = await leagueResponse.text();
          console.error(`ESPN API Error for year ${year}:`, {
            status: leagueResponse.status,
            statusText: leagueResponse.statusText,
            url: baseUrl + viewParams,
            hasAuth: !!(league.espnData.espnS2 && league.espnData.swid),
            isPrivate: league.espnData.isPrivate,
            responseText: responseText.slice(0, 200)
          });
          console.warn(`Failed to fetch data for year ${year}: ${leagueResponse.status}`);
          results.push({ 
            year, 
            success: false, 
            error: `HTTP ${leagueResponse.status}: ${leagueResponse.statusText}${leagueResponse.status === 401 ? ' (Authentication required - check ESPN S2/SWID cookies)' : ''}` 
          });
          totalErrors++;
          continue;
        }

        const leagueData = await leagueResponse.json();
        
        // Debug logging for historical data
        if (year !== currentYear) {
          console.log(`Historical data for ${year}:`, {
            hasTeams: !!leagueData.teams,
            teamsCount: leagueData.teams?.length || 0,
            hasMembers: !!leagueData.members,
            membersCount: leagueData.members?.length || 0,
            hasStatus: !!leagueData.status,
            sampleTeam: leagueData.teams?.[0] ? {
              id: leagueData.teams[0].id,
              name: leagueData.teams[0].name,
              location: leagueData.teams[0].location,
              nickname: leagueData.teams[0].nickname,
              abbrev: leagueData.teams[0].abbrev,
              hasRecord: !!leagueData.teams[0].record,
              hasOwners: !!leagueData.teams[0].owners,
              recordOverall: leagueData.teams[0].record?.overall,
              owners: leagueData.teams[0].owners,
              allKeys: Object.keys(leagueData.teams[0])
            } : null,
            sampleMember: leagueData.members?.[0] ? {
              id: leagueData.members[0].id,
              displayName: leagueData.members[0].displayName,
              isLeagueManager: leagueData.members[0].isLeagueManager
            } : null
          });
        }
        
        // Check if we got valid data
        if (!leagueData.settings || !leagueData.teams) {
          console.warn(`Invalid data structure for year ${year}`);
          results.push({ 
            year, 
            success: false, 
            error: 'Invalid data structure returned from ESPN' 
          });
          totalErrors++;
          continue;
        }

        const teams = leagueData.teams || [];
        const members = leagueData.members || [];

        // Create a map of member IDs to member data for easy lookup
        const memberMap = new Map();
        members.forEach((member: any) => {
          memberMap.set(member.id, member);
        });
        
        // Log member map for debugging in historical data
        if (year !== currentYear && members.length > 0) {
          console.log(`Member data for ${year}:`, {
            memberCount: members.length,
            sampleMemberId: members[0].id,
            memberMapSize: memberMap.size,
            firstTeamOwner: teams[0]?.owners?.[0],
            ownerInMap: teams[0]?.owners?.[0] ? memberMap.has(teams[0].owners[0]) : 'No owner'
          });
        }

        // Skip processing if historical data is too incomplete
        if (year !== currentYear) {
          const hasAnyTeamData = teams.some((team: any) => 
            team.name || team.location || team.nickname || team.owners?.length > 0
          );
          
          if (!hasAnyTeamData && members.length === 0) {
            console.warn(`Skipping year ${year} - no meaningful team or member data available`);
            results.push({
              year,
              success: false,
              error: 'Historical season data too incomplete - no team names or member data available'
            });
            totalErrors++;
            continue;
          }
        }
        const settings = leagueData.settings;
        const schedule = leagueData.schedule || [];
        const players = leagueData.players || [];
        const draftDetail = leagueData.draftDetail;

        // Process champion and runner-up from final standings
        let champion, runnerUp;
        
        // First try to use rankCalculatedFinal for the most accurate results
        const finalRankings = teams
          .filter((team: any) => team.rankCalculatedFinal)
          .sort((a: any, b: any) => a.rankCalculatedFinal - b.rankCalculatedFinal);
          
        if (finalRankings.length >= 2) {
          champion = finalRankings[0]; // rankCalculatedFinal: 1
          runnerUp = finalRankings[1];  // rankCalculatedFinal: 2
        } else {
          // Fallback: Use playoff seeds for completed seasons
          const finalStandings = teams
            .filter((team: any) => team.playoffSeed)
            .sort((a: any, b: any) => a.playoffSeed - b.playoffSeed);
            
          if (finalStandings.length >= 2) {
            champion = finalStandings[0];
            runnerUp = finalStandings[1];
          } else {
            // Last resort: Use best regular season records for historical data
            const sortedByRecord = teams
              .sort((a: any, b: any) => {
                const aWinPct = (a.record?.overall?.wins || 0) / ((a.record?.overall?.wins || 0) + (a.record?.overall?.losses || 0) || 1);
                const bWinPct = (b.record?.overall?.wins || 0) / ((b.record?.overall?.wins || 0) + (b.record?.overall?.losses || 0) || 1);
                if (aWinPct !== bWinPct) return bWinPct - aWinPct;
                return (b.record?.overall?.pointsFor || 0) - (a.record?.overall?.pointsFor || 0);
              });
            
            // Only set champion/runnerUp if we have valid record data
            if (sortedByRecord[0]?.record?.overall?.wins > 0) {
              champion = sortedByRecord[0];
              runnerUp = sortedByRecord[1];
            }
          }
        }

        // Find regular season champion (best record)
        const regularSeasonChamp = teams
          .sort((a: any, b: any) => {
            const aWinPct = a.record?.overall?.wins / (a.record?.overall?.wins + a.record?.overall?.losses || 1);
            const bWinPct = b.record?.overall?.wins / (b.record?.overall?.wins + b.record?.overall?.losses || 1);
            if (aWinPct !== bWinPct) return bWinPct - aWinPct;
            return (b.record?.overall?.pointsFor || 0) - (a.record?.overall?.pointsFor || 0);
          })[0];

        // Enrich historical team data if possible
        if (year !== currentYear && members.length > 0) {
          // Try to map team IDs to member names if team data is incomplete
          teams.forEach((team: any, index: number) => {
            if (!team.name && !team.location && !team.nickname) {
              // Use member data as fallback for team names
              const member = members[index % members.length]; // Basic mapping attempt
              if (member) {
                team.location = member.displayName?.split(' ')[0] || 'Team';
                team.nickname = member.displayName?.split(' ').slice(1).join(' ') || `${team.id}`;
                team.owners = [{
                  displayName: member.displayName,
                  id: member.id,
                  isLeagueManager: member.isLeagueManager
                }];
              }
            }
          });
        }

        // Create/update league season record
        if (teams.length > 0) {
          const seasonData: any = {
            settings: {
              name: settings?.name || league.name,
              size: settings?.size || teams.length,
              scoringType: settings?.scoringSettings?.scoringType === 1 ? 'ppr' : 
                          settings?.scoringSettings?.scoringType === 2 ? 'half-ppr' : 'standard',
              playoffTeamCount: settings?.scheduleSettings?.playoffTeamCount || 6,
              playoffWeeks: settings?.scheduleSettings?.playoffWeekCount || 3,
              regularSeasonMatchupPeriods: settings?.scheduleSettings?.regularSeasonMatchupPeriods || 14,
              rosterSettings: settings?.rosterSettings,
            },
          };

          // Only include champion if exists
          if (champion) {
            seasonData.champion = {
              teamId: champion.id?.toString() || '',
              teamName: champion.name || (champion.location && champion.nickname ? `${champion.location} ${champion.nickname}` : 'Unknown Team'),
              owner: champion.owners?.[0]?.displayName || 
                  (champion.owners?.[0]?.firstName && champion.owners?.[0]?.lastName 
                    ? `${champion.owners[0].firstName} ${champion.owners[0].lastName}` 
                    : champion.owners?.[0]?.firstName || champion.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: champion.record?.overall?.wins || 0,
                losses: champion.record?.overall?.losses || 0,
                ties: champion.record?.overall?.ties || 0,
              },
              pointsFor: champion.record?.overall?.pointsFor,
            };
          }

          // Only include runnerUp if exists
          if (runnerUp) {
            seasonData.runnerUp = {
              teamId: runnerUp.id?.toString() || '',
              teamName: runnerUp.name || (runnerUp.location && runnerUp.nickname ? `${runnerUp.location} ${runnerUp.nickname}` : 'Unknown Team'),
              owner: runnerUp.owners?.[0]?.displayName || 
                  (runnerUp.owners?.[0]?.firstName && runnerUp.owners?.[0]?.lastName 
                    ? `${runnerUp.owners[0].firstName} ${runnerUp.owners[0].lastName}` 
                    : runnerUp.owners?.[0]?.firstName || runnerUp.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: runnerUp.record?.overall?.wins || 0,
                losses: runnerUp.record?.overall?.losses || 0,
                ties: runnerUp.record?.overall?.ties || 0,
              },
              pointsFor: runnerUp.record?.overall?.pointsFor,
            };
          }

          // Only include regularSeasonChampion if exists
          if (regularSeasonChamp) {
            seasonData.regularSeasonChampion = {
              teamId: regularSeasonChamp.id?.toString() || '',
              teamName: regularSeasonChamp.name || (regularSeasonChamp.location && regularSeasonChamp.nickname ? `${regularSeasonChamp.location} ${regularSeasonChamp.nickname}` : 'Unknown Team'),
              owner: regularSeasonChamp.owners?.[0]?.displayName || 
                  (regularSeasonChamp.owners?.[0]?.firstName && regularSeasonChamp.owners?.[0]?.lastName 
                    ? `${regularSeasonChamp.owners[0].firstName} ${regularSeasonChamp.owners[0].lastName}` 
                    : regularSeasonChamp.owners?.[0]?.firstName || regularSeasonChamp.owners?.[0]?.lastName || 'Unknown'),
              record: {
                wins: regularSeasonChamp.record?.overall?.wins || 0,
                losses: regularSeasonChamp.record?.overall?.losses || 0,
                ties: regularSeasonChamp.record?.overall?.ties || 0,
              },
              pointsFor: regularSeasonChamp.record?.overall?.pointsFor,
            };
          }

          // Only include draftInfo if draftDetail exists
          if (draftDetail) {
            seasonData.draftInfo = {
              draftDate: draftDetail.drafted === 1 ? 1 : undefined,
              draftType: draftDetail.type,
              timePerPick: draftDetail.timePerPick,
            };
          }

          // Only include draftSettings if it exists
          if (settings?.draftSettings) {
            seasonData.draftSettings = settings.draftSettings;
          }

          // Only include draft picks if draft has actually occurred
          if (draftDetail?.drafted === 1 && draftDetail.picks) {
            seasonData.draft = draftDetail.picks;
          }

          await ctx.runMutation(api.espnSync.updateLeagueSeason, {
            leagueId: args.leagueId,
            seasonId: year,
            seasonData,
          });
        }

        // Helper function for roster data
        // Note: The general league endpoint doesn't reliably return roster data
        // We'll use fetchHistoricalRosters after team sync for accurate roster data
        const getRosterData = (team: any) => {
          // Return empty array - rosters will be fetched separately using fetchHistoricalRosters
          return [];
        };

        // Helper function to get owner info with fallback logic
      const getOwnerInfo = (team: any) => {
        // First try to get owner from team.owners array
        if (team.owners?.[0]) {
          const owner = team.owners[0];
          
          // Check if owner is just a string ID (historical data) or an object (current data)
          if (typeof owner === 'string') {
            // Owner is just an ID, need to look up in members
            const member = memberMap.get(owner);
            if (member) {
              return {
                ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
                ownerInfo: {
                  displayName: member.displayName,
                  firstName: member.firstName,
                  lastName: member.lastName,
                  id: member.id?.toString() || owner,
                }
              };
            }
          } else if (owner.displayName || owner.firstName || owner.lastName) {
            // Owner is an object with properties
            return {
              ownerName: (owner.firstName && owner.lastName ? `${owner.firstName} ${owner.lastName}` : owner.displayName || owner.firstName || owner.lastName || 'Unknown'),
              ownerInfo: {
                displayName: owner.displayName,
                firstName: owner.firstName,
                lastName: owner.lastName,
                id: owner.id?.toString(),
              }
            };
          }
        }
          
          // Fallback to member data using primaryOwner
          if (team.primaryOwner && memberMap.has(team.primaryOwner)) {
            const member = memberMap.get(team.primaryOwner);
            return {
              ownerName: (member.firstName && member.lastName ? `${member.firstName} ${member.lastName}` : member.displayName) || 'Unknown',
              ownerInfo: {
                displayName: member.displayName,
                firstName: member.firstName,
                lastName: member.lastName,
                id: member.id?.toString(),
              }
            };
          }
          
          // Last resort - try to find member by matching team name  
          const matchingMember = members.find((m: any) => 
            team.name && (team.name.includes(m.displayName) || team.name.includes(m.firstName) || team.name.includes(m.lastName))
          );
          if (matchingMember) {
            return {
              ownerName: (matchingMember.firstName && matchingMember.lastName ? `${matchingMember.firstName} ${matchingMember.lastName}` : matchingMember.displayName) || 'Unknown',
              ownerInfo: {
                displayName: matchingMember.displayName,
                firstName: matchingMember.firstName,
                lastName: matchingMember.lastName,
                id: matchingMember.id?.toString(),
              }
            };
          }
          
          return {
            ownerName: 'Unknown',
            ownerInfo: undefined
          };
        };

        // Sync teams for this season
        await ctx.runMutation(api.espnSync.updateTeams, {
          leagueId: args.leagueId,
          seasonId: year,
          teamsData: teams.map((team: any) => {
            const { ownerName, ownerInfo } = getOwnerInfo(team);
            return {
              externalId: team.id.toString(),
              name: team.name || 
                    (team.location && team.nickname ? `${team.location} ${team.nickname}` : 
                     team.location || team.nickname || `Team ${team.id}` || 'Unknown Team'),
              abbreviation: team.abbrev,
              location: team.location,
              nickname: team.nickname,
              logo: team.logo || team.logoURL || team.logoUrl || undefined,
              owner: ownerName,
              ownerInfo: ownerInfo,
            record: {
              wins: team.record?.overall?.wins || 0,
              losses: team.record?.overall?.losses || 0,
              ties: team.record?.overall?.ties || 0,
              pointsFor: team.record?.overall?.pointsFor || 0,
              pointsAgainst: team.record?.overall?.pointsAgainst || 0,
              playoffSeed: team.playoffSeed,
              divisionRecord: team.record?.division ? {
                wins: team.record.division.wins || 0,
                losses: team.record.division.losses || 0,
                ties: team.record.division.ties || 0,
              } : undefined,
            },
            roster: year === currentYear && team.roster?.entries ? team.roster.entries.map((entry: any) => ({
              playerId: entry.playerId?.toString() || '',
              playerName: entry.playerPoolEntry?.player?.fullName || 'Unknown',
              position: entry.playerPoolEntry?.player?.defaultPositionId ? getPositionName(entry.playerPoolEntry.player.defaultPositionId) : 'UNKNOWN',
              team: entry.playerPoolEntry?.player?.proTeamId ? getTeamAbbreviation(entry.playerPoolEntry.player.proTeamId) : 'FA',
              acquisitionType: entry.acquisitionType,
              lineupSlotId: entry.lineupSlotId,
              playerStats: entry.playerPoolEntry?.player?.stats ? {
                appliedTotal: entry.playerPoolEntry.player.stats.appliedTotal,
                projectedTotal: entry.playerPoolEntry.player.stats.projectedTotal,
              } : undefined,
            })) : [], // Historical rosters can be fetched separately using fetchHistoricalRosters
            divisionId: team.divisionId,
            };
          })
        });

        // Sync players data for all seasons (historical and current)
        if (players.length > 0) {
          await ctx.runMutation(api.espnSync.updatePlayers, {
            playersData: players.map((player: any) => ({
              externalId: player.id?.toString() || '',
              fullName: player.fullName || 'Unknown Player',
              firstName: player.firstName,
              lastName: player.lastName,
              defaultPosition: getPositionName(player.defaultPositionId),
              eligiblePositions: player.eligibleSlots?.map((slot: number) => getPositionName(slot)) || [],
              proTeamId: player.proTeamId,
              proTeamAbbrev: getTeamAbbreviation(player.proTeamId),
              injuryStatus: player.injuryStatus,
              stats: player.stats ? {
                seasonStats: {
                  appliedTotal: player.stats.appliedTotal,
                  projectedTotal: player.stats.projectedTotal,
                  averagePoints: player.stats.averagePoints,
                }
              } : undefined,
              ownership: player.ownership ? {
                percentOwned: player.ownership.percentOwned,
                percentChange: player.ownership.percentChange,
                percentStarted: player.ownership.percentStarted,
              } : undefined,
            }))
          });
        }

        // Sync matchups data
        if (schedule.length > 0) {
          await ctx.runMutation(api.espnSync.updateMatchups, {
            leagueId: args.leagueId,
            seasonId: year,
            matchupsData: schedule.map((matchup: any) => ({
              matchupPeriod: matchup.matchupPeriodId,
              scoringPeriod: matchup.id,
              homeTeamId: matchup.home?.teamId?.toString() || '',
              awayTeamId: matchup.away?.teamId?.toString() || '',
              homeScore: matchup.home?.totalPoints || 0,
              awayScore: matchup.away?.totalPoints || 0,
              homeProjectedScore: matchup.home?.totalProjectedPoints,
              awayProjectedScore: matchup.away?.totalProjectedPoints,
              homePointsByScoringPeriod: matchup.home?.pointsByScoringPeriod,
              awayPointsByScoringPeriod: matchup.away?.pointsByScoringPeriod,
              winner: matchup.winner === 'HOME' ? 'home' as const : 
                     matchup.winner === 'AWAY' ? 'away' as const : 
                     matchup.winner === 'TIE' ? 'tie' as const : undefined,
              playoffTier: matchup.playoffTierType,
              // Transform and clean roster data from current scoring period
              homeRoster: transformRosterData(matchup.home?.rosterForCurrentScoringPeriod),
              awayRoster: transformRosterData(matchup.away?.rosterForCurrentScoringPeriod),
            }))
          });
        }

        // Update league sync timestamp for current season
        if (year === currentYear) {
          await ctx.runMutation(api.espnSync.updateLeagueSync, {
            leagueId: args.leagueId,
            currentScoringPeriod: settings?.scoringSettings?.matchupPeriods?.length || league.espnData.currentScoringPeriod,
          });
        }

        // Fetch rosters for each year after teams are synced
        console.log(`Fetching rosters for year ${year}...`);
        let rostersFetched = 0;
        try {
          const rosterResult = await ctx.runAction(api.espnSync.fetchHistoricalRosters, {
            leagueId: args.leagueId,
            seasonId: year,
          });
          
          if (rosterResult.success) {
            rostersFetched = rosterResult.totalRostersFetched;
            console.log(`Successfully fetched rosters for ${rostersFetched} teams in ${year}`);
          } else {
            console.warn(`Failed to fetch some rosters for ${year}:`, rosterResult.message);
          }
        } catch (rosterError) {
          console.error(`Error fetching rosters for ${year}:`, rosterError);
          // Don't fail the entire sync if roster fetching fails
        }

        // Fetch matchup rosters for each year after teams are synced
        console.log(`Fetching matchup rosters for year ${year}...`);
        let matchupRostersFetched = 0;
        try {
          const matchupRosterResult = await ctx.runAction(api.matchupRosters.fetchMatchupRosters, {
            leagueId: args.leagueId,
            seasonId: year,
          });
          
          if (matchupRosterResult.success) {
            matchupRostersFetched = matchupRosterResult.successfulPeriods;
            console.log(`Successfully fetched matchup rosters for ${matchupRostersFetched}/${matchupRosterResult.totalPeriods} periods in ${year}`);
          } else {
            console.warn(`Failed to fetch matchup rosters for ${year}:`, matchupRosterResult.message);
          }
        } catch (matchupRosterError) {
          console.error(`Error fetching matchup rosters for ${year}:`, matchupRosterError);
          // Don't fail the entire sync if matchup roster fetching fails
        }

        // Fetch player stats for each year after rosters are synced
        console.log(`Fetching player stats for year ${year}...`);
        let playerStatsSynced = 0;
        try {
          const statsResult = await ctx.runAction(api.playerSync.syncAllLeaguePlayerStats, {
            leagueId: args.leagueId,
            season: year,
          });
          
          if (statsResult.status === "success") {
            playerStatsSynced = statsResult.totalPlayersProcessed;
            console.log(`Successfully synced player stats for ${playerStatsSynced} players in ${year}`);
          } else {
            console.warn(`Failed to sync player stats for ${year}`);
          }
        } catch (statsError) {
          console.error(`Error syncing player stats for ${year}:`, statsError);
          // Don't fail the entire sync if player stats syncing fails
        }

        results.push({ 
          year, 
          success: true, 
          teamsCount: teams.length,
          matchupsCount: schedule.length,
          playersCount: year === currentYear ? players.length : 0,
          rostersCount: rostersFetched,
          matchupRostersCount: matchupRostersFetched,
          playerStatsCount: playerStatsSynced
        });
        totalSynced++;
        
        console.log(`Successfully synced year ${year}: ${teams.length} teams, ${schedule.length} matchups, ${rostersFetched} rosters, ${matchupRostersFetched} matchup periods, ${playerStatsSynced} player stats`);
        
        // Add small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`Failed to sync data for year ${year}:`, error);
        results.push({ 
          year, 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        totalErrors++;
      }
    }

    return {
      success: totalSynced > 0,
      totalYearsRequested: yearsToSync.length,
      totalSynced,
      totalErrors,
      results,
      message: `Sync completed: ${totalSynced}/${yearsToSync.length} years synced successfully`,
      syncedAt: Date.now(),
    };
  },
});

// Sync all historical player stats for all leagues
export const syncAllHistoricalPlayerStats = action({
  args: {},
  handler: async (ctx): Promise<{
    status: string;
    message: string;
    totalLeagues: number;
    totalSeasons: number;
    results: Array<{
      leagueId: string;
      leagueName: string;
      status: string;
      seasonsProcessed?: number;
      error?: string;
    }>;
    timestamp: number;
  }> => {
    console.log("Starting comprehensive historical player stats sync for all leagues");
    
    // This delegates to the playerHistoricalSync module
    return await ctx.runAction(api.playerHistoricalSync.syncAllLeaguesHistoricalPlayerStats, {});
  }
});

// Historical roster fetching action
export const fetchHistoricalRosters = action({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    teamIds: v.optional(v.array(v.string())), // If not provided, fetches for all teams
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    totalTeams: number;
    totalRostersFetched: number;
    totalErrors: number;
    results: Array<{
      teamId: string;
      teamName: string;
      success: boolean;
      error?: string;
      playersCount?: number;
    }>;
    message: string;
    fetchedAt: number;
  }> => {
    const league: any = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    
    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    // Validate ESPN credentials if league is private
    if (league.espnData.isPrivate) {
      const credentialsCheck = await validateEspnCredentials(
        league.externalId, 
        league.espnData.espnS2, 
        league.espnData.swid
      );
      
      if (!credentialsCheck.isValid) {
        throw new Error(`ESPN credentials invalid: ${credentialsCheck.error}. Please re-authenticate with ESPN.`);
      }
    }

    // Get teams for the specified season using a query
    const teams = await ctx.runQuery(api.teams.getBySeasonAndLeague, { 
      leagueId: args.leagueId, 
      seasonId: args.seasonId 
    });

    if (teams.length === 0) {
      throw new Error(`No teams found for season ${args.seasonId}. Please sync team data first.`);
    }

    // Filter teams if specific teamIds provided
    const teamsToFetch = args.teamIds 
      ? teams.filter((team: any) => args.teamIds!.includes(team.externalId))
      : teams;

    // Check if draft has occurred for current season - skip roster fetching if not
    const currentYear = new Date().getFullYear();
    if (args.seasonId === currentYear) {
      // For current season, check draft status before fetching rosters
      try {
        const leagueResponse = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${args.seasonId}/segments/0/leagues/${league.externalId}?view=mDraftDetail`, {
          headers: league.espnData.isPrivate && league.espnData.espnS2 && league.espnData.swid ? {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Cookie': `espn_s2=${decodeURIComponent(league.espnData.espnS2)}; SWID=${league.espnData.swid}`
          } : {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          }
        });

        if (leagueResponse.ok) {
          const leagueData = await leagueResponse.json();
          // Check if draft has occurred (draftDate should be 1 when drafted)
          if (leagueData.draftDetail?.drafted !== 1) {
            return {
              success: false,
              totalTeams: teamsToFetch.length,
              totalRostersFetched: 0,
              totalErrors: 1,
              results: [],
              message: "Draft has not occurred yet for current season. Cannot fetch rosters.",
              fetchedAt: Date.now(),
            };
          }
        }
      } catch (error) {
        console.log("Could not verify draft status, proceeding with roster fetch:", error);
      }
    }

    const results = [];
    let totalRostersFetched = 0;
    let totalErrors = 0;

    for (const team of teamsToFetch) {
      try {
        console.log(`Fetching historical roster for team ${team.name} (${team.externalId}) for season ${args.seasonId}...`);
        
        const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${args.seasonId}/segments/0/leagues/${league.externalId}`;
        const viewParams = `?rosterForTeamId=${team.externalId}&view=mDraftDetail&view=mLiveScoring&view=mMatchupScore&view=mPendingTransactions&view=mPositionalRatings&view=mRoster&view=mSettings&view=mTeam&view=modular&view=mNav`;
        
        const headers: HeadersInit = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        };
        
        // Add fantasy filter for all matchup periods to get roster data
        const regularSeasonWeeks = league.settings?.regularSeasonMatchupPeriods || 14;
        const playoffWeeks = league.settings?.playoffWeeks || 4;
        headers['X-Fantasy-Filter'] = generateFantasyFilterHeader(regularSeasonWeeks, playoffWeeks);
        
        if (league.espnData.isPrivate && league.espnData.espnS2 && league.espnData.swid) {
          const espnS2 = decodeURIComponent(league.espnData.espnS2);
          headers['Cookie'] = `espn_s2=${espnS2}; SWID=${league.espnData.swid}`;
        }

        const response = await fetch(`${baseUrl}${viewParams}`, { headers });

        if (!response.ok) {
          console.error(`Failed to fetch roster for team ${team.externalId}:`, response.status, response.statusText);
          results.push({
            teamId: team.externalId,
            teamName: team.name,
            success: false,
            error: `HTTP ${response.status}: ${response.statusText}`
          });
          totalErrors++;
          continue;
        }

        const data = await response.json();
        
        // Extract roster data from the response
        let rosterEntries = [];
        
        // Check multiple possible locations for roster data
        if (data.teams) {
          const teamData = data.teams.find((t: any) => t.id.toString() === team.externalId);
          if (teamData?.roster?.entries) {
            rosterEntries = teamData.roster.entries;
          }
        }
        
        // If no roster found in teams, try the direct roster property
        if (rosterEntries.length === 0 && data.roster?.entries) {
          rosterEntries = data.roster.entries;
        }

        if (rosterEntries.length === 0) {
          console.warn(`No roster data found for team ${team.externalId} in season ${args.seasonId}`);
          results.push({
            teamId: team.externalId,
            teamName: team.name,
            success: false,
            error: 'No roster data available for this team/season combination'
          });
          totalErrors++;
          continue;
        }

        // Process and store the roster data
        const historicalRoster = rosterEntries.map((entry: any) => ({
          playerId: entry.playerId?.toString() || '',
          playerName: entry.playerPoolEntry?.player?.fullName || 'Unknown',
          position: entry.playerPoolEntry?.player?.defaultPositionId ? getPositionName(entry.playerPoolEntry.player.defaultPositionId) : 'UNKNOWN',
          team: entry.playerPoolEntry?.player?.proTeamId ? getTeamAbbreviation(entry.playerPoolEntry.player.proTeamId) : 'FA',
          acquisitionType: entry.acquisitionType,
          lineupSlotId: entry.lineupSlotId,
          playerStats: entry.playerPoolEntry?.player?.stats ? {
            appliedTotal: entry.playerPoolEntry.player.stats.appliedTotal,
            projectedTotal: entry.playerPoolEntry.player.stats.projectedTotal,
          } : undefined,
        }));

        // Update the team's roster for this season using a mutation
        await ctx.runMutation(api.teams.updateTeamRoster, {
          teamId: team._id,
          roster: historicalRoster,
        });

        results.push({
          teamId: team.externalId,
          teamName: team.name,
          success: true,
          playersCount: historicalRoster.length
        });
        totalRostersFetched++;
        
        console.log(`Successfully fetched roster for team ${team.name}: ${historicalRoster.length} players`);
        
        // Add small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`Failed to fetch roster for team ${team.externalId}:`, error);
        results.push({
          teamId: team.externalId,
          teamName: team.name,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        totalErrors++;
      }
    }

    return {
      success: totalRostersFetched > 0,
      totalTeams: teamsToFetch.length,
      totalRostersFetched,
      totalErrors,
      results,
      message: `Historical rosters fetch completed: ${totalRostersFetched}/${teamsToFetch.length} teams fetched successfully`,
      fetchedAt: Date.now(),
    };
  },
});
// Action to fetch draft data for a specific season
export const fetchDraftDataForSeason = action({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    message: string;
    error?: string;
    picksCount?: number;
  }> => {
    const league: any = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    
    if (!league) {
      throw new Error("League not found");
    }

    if (!league.espnData) {
      throw new Error("No ESPN data found for league");
    }

    // Validate ESPN credentials if league is private
    if (league.espnData.isPrivate) {
      const credentialsCheck = await validateEspnCredentials(
        league.externalId, 
        league.espnData.espnS2, 
        league.espnData.swid
      );
      
      if (!credentialsCheck.isValid) {
        throw new Error(`ESPN credentials invalid: ${credentialsCheck.error}. Please re-authenticate with ESPN.`);
      }
    }

    try {
      console.log(`Fetching draft data for season ${args.seasonId}...`);
      
      const baseUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${args.seasonId}/segments/0/leagues/${league.externalId}`;
      
      const headers: HeadersInit = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      };
      
      // Add fantasy filter for all matchup periods to get comprehensive data
      const regularSeasonWeeks = league.settings?.regularSeasonMatchupPeriods || 14;
      const playoffWeeks = league.settings?.playoffWeeks || 4;
      headers['X-Fantasy-Filter'] = generateFantasyFilterHeader(regularSeasonWeeks, playoffWeeks);
      
      if (league.espnData.isPrivate && league.espnData.espnS2 && league.espnData.swid) {
        const espnS2 = decodeURIComponent(league.espnData.espnS2);
        headers['Cookie'] = `espn_s2=${espnS2}; SWID=${league.espnData.swid}`;
      }

      // Fetch league data with draft details
      const response = await fetch(
        `${baseUrl}?view=mDraftDetail&view=mSettings&view=mTeam&view=modular&view=mNav`,
        { headers }
      );

      if (!response.ok) {
        console.error(`ESPN API Error for draft data:`, {
          status: response.status,
          statusText: response.statusText,
        });
        return {
          success: false,
          message: `Failed to fetch draft data`,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const leagueData = await response.json();
      const draftDetail = leagueData.draftDetail;
      const settings = leagueData.settings;

      if (!draftDetail?.picks || draftDetail.picks.length === 0) {
        return {
          success: false,
          message: "No draft data available for this season",
          error: "Draft has not occurred yet or data is not available",
        };
      }

      // Sync all player data for this season to ensure comprehensive playersEnhanced table
      try {
        await ctx.runAction(api.playerSync.syncAllPlayers, {
          season: args.seasonId,
          forceUpdate: false,
          leagueId: args.leagueId,
        });
      } catch (playerSyncError) {
        console.warn("Failed to sync all players data for season, continuing with draft data sync:", playerSyncError);
      }

      // Get existing season record
      const existingSeason = await ctx.runQuery(api.leagues.getLeagueSeasonByYear, {
        leagueId: args.leagueId,
        seasonId: args.seasonId,
      });

      if (!existingSeason) {
        // Create new season record with draft data
        const seasonData: any = {
          settings: {
            name: settings?.name || league.name,
            size: settings?.size || 10,
            scoringType: settings?.scoringSettings?.scoringType === 1 ? 'ppr' : 
                        settings?.scoringSettings?.scoringType === 2 ? 'half-ppr' : 'standard',
            playoffTeamCount: settings?.scheduleSettings?.playoffTeamCount || 6,
            playoffWeeks: settings?.scheduleSettings?.playoffWeekCount || 3,
            regularSeasonMatchupPeriods: settings?.scheduleSettings?.regularSeasonMatchupPeriods || 14,
            rosterSettings: settings?.rosterSettings,
          },
          draftInfo: {
            draftDate: draftDetail.drafted === 1 ? 1 : undefined,
            draftType: draftDetail.type,
            timePerPick: draftDetail.timePerPick,
          },
        };

        // Only include draftSettings if it exists
        if (settings?.draftSettings) {
          seasonData.draftSettings = settings.draftSettings;
        }

        // Only include draft if it exists
        if (draftDetail.picks) {
          seasonData.draft = draftDetail.picks;
        }

        await ctx.runMutation(api.espnSync.updateLeagueSeason, {
          leagueId: args.leagueId,
          seasonId: args.seasonId,
          seasonData,
        });
      } else {
        // Update existing season with draft data
        const updateData: any = {
          draftInfo: {
            draftDate: draftDetail.drafted === 1 ? 1 : undefined,
            draftType: draftDetail.type,
            timePerPick: draftDetail.timePerPick,
          },
        };

        // Only include draftSettings if it exists
        if (settings?.draftSettings) {
          updateData.draftSettings = settings.draftSettings;
        }

        // Only include draft if it exists
        if (draftDetail.picks) {
          updateData.draft = draftDetail.picks;
        }

        await ctx.runMutation(api.espnSync.updateSeasonDraftData, {
          seasonId: existingSeason._id,
          ...updateData,
          draftInfo: {
            draftDate: draftDetail.drafted === 1 ? 1 : undefined,
            draftType: draftDetail.type,
            timePerPick: draftDetail.timePerPick,
          },
        });
      }

      return {
        success: true,
        message: `Successfully fetched draft data for ${args.seasonId}`,
        picksCount: draftDetail.picks.length,
      };

    } catch (error) {
      console.error(`Failed to fetch draft data for season ${args.seasonId}:`, error);
      return {
        success: false,
        message: "Failed to fetch draft data",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});
// Enhanced sync function that includes historical roster fetching
export const syncAllDataWithRosters = action({
  args: {
    leagueId: v.id("leagues"),
    includeCurrentSeason: v.optional(v.boolean()),
    historicalYears: v.optional(v.number()),
    includeHistoricalRosters: v.optional(v.boolean()), // New option
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    totalYearsRequested: number;
    totalSynced: number;
    totalErrors: number;
    results: Array<{
      year: number;
      success: boolean;
      error?: string;
      teamsCount?: number;
      matchupsCount?: number;
      playersCount?: number;
      rostersCount?: number;
      matchupRostersCount?: number;
    }>;
    message: string;
    syncedAt: number;
  }> => {
    // First run the regular sync
    const regularSyncResult = await ctx.runAction(api.espnSync.syncAllLeagueData, {
      leagueId: args.leagueId,
      includeCurrentSeason: args.includeCurrentSeason,
      historicalYears: args.historicalYears,
    });

    if (!regularSyncResult.success || !args.includeHistoricalRosters) {
      return regularSyncResult;
    }

    // Now fetch historical rosters for each successfully synced year
    const enhancedResults = [];
    
    for (const result of regularSyncResult.results) {
      if (result.success) {
        try {
          console.log(`Fetching rosters for year ${result.year}...`);
          
          const rosterResult = await ctx.runAction(api.espnSync.fetchHistoricalRosters, {
            leagueId: args.leagueId,
            seasonId: result.year,
          });

          enhancedResults.push({
            ...result,
            rostersCount: rosterResult.success ? rosterResult.totalRostersFetched : 0,
            matchupRostersCount: 0, // This function doesn't fetch matchup rosters
          });
          
          console.log(`Rosters for ${result.year}: ${rosterResult.success ? `${rosterResult.totalRostersFetched} teams` : 'failed'}`);
          
          // Add delay between roster fetches to prevent rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));
          
        } catch (error) {
          console.error(`Failed to fetch rosters for year ${result.year}:`, error);
          enhancedResults.push({
            ...result,
            rostersCount: 0,
            matchupRostersCount: 0,
          });
        }
      } else {
        enhancedResults.push(result);
      }
    }

    return {
      ...regularSyncResult,
      results: enhancedResults,
      message: args.includeHistoricalRosters 
        ? `Sync completed with historical rosters: ${regularSyncResult.totalSynced}/${regularSyncResult.totalYearsRequested} years synced successfully`
        : regularSyncResult.message,
    };
  },
});

export const updateLeagueSync = mutation({
  args: {
    leagueId: v.id("leagues"),
    currentScoringPeriod: v.number(),
  },
  handler: async (ctx, args) => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league || !league.espnData) {
      throw new Error("League or ESPN data not found");
    }

    await ctx.db.patch(args.leagueId, {
      espnData: {
        ...league.espnData,
        currentScoringPeriod: args.currentScoringPeriod,
        lastSyncedAt: Date.now(),
      },
      lastSync: Date.now(),
    });
  },
});

// Process transaction data from ESPN communication messages
export const processTransactionData = action({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    messages: v.array(v.any()),
    teams: v.array(v.object({
      id: v.string(),
      name: v.string(),
      owner: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    const processedTransactions = [];
    const processedTrades = [];
    
    // Create team lookup map
    const teamMap = new Map(args.teams.map(t => [t.id, t]));
    
    for (const message of args.messages) {
      const messageType = message.messageTypeId;
      const date = message.date || Date.now();
      
      // Process different transaction types
      if (messageType === 244 || messageType === 188) { // Trade messages
        const tradeData = await processTradeMessage(message, teamMap);
        if (tradeData) {
          processedTrades.push({
            ...tradeData,
            leagueId: args.leagueId,
            seasonId: args.seasonId,
            tradeDate: date,
          });
        }
      } else if (messageType === 178 || messageType === 180 || messageType === 179) { 
        // Waiver claim (178), Free agent add (180), Drop (179)
        const transactionData = await processTransactionMessage(message, teamMap);
        if (transactionData) {
          processedTransactions.push({
            ...transactionData,
            leagueId: args.leagueId,
            seasonId: args.seasonId,
            transactionDate: date,
          });
        }
      }
    }
    
    // Store trades
    if (processedTrades.length > 0) {
      await ctx.runMutation(api.espnSync.storeTrades, {
        trades: processedTrades,
      });
    }
    
    // Store transactions
    if (processedTransactions.length > 0) {
      await ctx.runMutation(api.espnSync.storeTransactions, {
        transactions: processedTransactions,
      });
    }
    
    console.log(`Processed ${processedTrades.length} trades and ${processedTransactions.length} transactions`);
    
    return {
      tradesProcessed: processedTrades.length,
      transactionsProcessed: processedTransactions.length,
    };
  },
});

// Helper function to process trade messages
async function processTradeMessage(message: any, teamMap: Map<string, any>) {
  try {
    // ESPN trade messages contain targetId (receiving team) and messages array with player details
    const teamAId = message.author?.toString();
    const teamBId = message.targetId?.toString();
    
    if (!teamAId || !teamBId || !teamMap.has(teamAId) || !teamMap.has(teamBId)) {
      return null;
    }
    
    const teamA = teamMap.get(teamAId)!;
    const teamB = teamMap.get(teamBId)!;
    
    // Parse players from message - this structure varies by ESPN version
    const playersFromA: any[] = [];
    const playersFromB: any[] = [];
    
    // ESPN often embeds player info in the messages array
    if (message.messages && Array.isArray(message.messages)) {
      message.messages.forEach((msg: any) => {
        if (msg.playerId && msg.fromTeamId && msg.toTeamId) {
          const player = {
            playerId: msg.playerId.toString(),
            playerName: msg.playerName || 'Unknown Player',
            position: msg.playerPosition || 'Unknown',
            team: msg.playerProTeam || 'FA',
          };
          
          if (msg.fromTeamId.toString() === teamAId) {
            playersFromA.push(player);
          } else if (msg.fromTeamId.toString() === teamBId) {
            playersFromB.push(player);
          }
        }
      });
    }
    
    // Only create trade if we found players
    if (playersFromA.length === 0 && playersFromB.length === 0) {
      return null;
    }
    
    return {
      teamA: {
        teamId: teamAId,
        teamName: teamA.name,
        manager: teamA.owner,
      },
      teamB: {
        teamId: teamBId,
        teamName: teamB.name,
        manager: teamB.owner,
      },
      playersFromTeamA: playersFromA,
      playersFromTeamB: playersFromB,
      status: 'completed' as const,
    };
  } catch (error) {
    console.error('Error processing trade message:', error);
    return null;
  }
}

// Helper function to process waiver/FA transactions
async function processTransactionMessage(message: any, teamMap: Map<string, any>) {
  try {
    const teamId = message.author?.toString();
    if (!teamId || !teamMap.has(teamId)) {
      return null;
    }
    
    const team = teamMap.get(teamId)!;
    const messageType = message.messageTypeId;
    
    // Parse transaction details from message
    let transactionType: 'add' | 'drop' | 'add_drop' | 'waiver_claim';
    let playerAdded = undefined;
    let playerDropped = undefined;
    
    // Extract player info from messages array
    if (message.messages && Array.isArray(message.messages)) {
      message.messages.forEach((msg: any) => {
        if (msg.playerId) {
          const player = {
            playerId: msg.playerId.toString(),
            playerName: msg.playerName || 'Unknown Player',
            position: msg.playerPosition || 'Unknown',
            team: msg.playerProTeam || 'FA',
          };
          
          if (messageType === 180 || messageType === 178) { // Add or Waiver
            playerAdded = player;
            transactionType = messageType === 178 ? 'waiver_claim' : 'add';
          } else if (messageType === 179) { // Drop
            playerDropped = player;
            transactionType = 'drop';
          }
        }
      });
    }
    
    // Handle add/drop combo
    if (playerAdded && playerDropped) {
      transactionType = 'add_drop';
    }
    
    if (!playerAdded && !playerDropped) {
      return null;
    }
    
    return {
      teamId,
      teamName: team.name,
      manager: team.owner,
      transactionType: transactionType!,
      playerAdded,
      playerDropped,
      waiverPriority: message.waiverOrder,
      isSuccessful: true,
    };
  } catch (error) {
    console.error('Error processing transaction message:', error);
    return null;
  }
}

// Store trades in database
export const storeTrades = mutation({
  args: {
    trades: v.array(v.object({
      leagueId: v.id("leagues"),
      seasonId: v.number(),
      tradeDate: v.number(),
      teamA: v.object({
        teamId: v.string(),
        teamName: v.string(),
        manager: v.string(),
      }),
      teamB: v.object({
        teamId: v.string(),
        teamName: v.string(),
        manager: v.string(),
      }),
      playersFromTeamA: v.array(v.object({
        playerId: v.string(),
        playerName: v.string(),
        position: v.string(),
        team: v.string(),
      })),
      playersFromTeamB: v.array(v.object({
        playerId: v.string(),
        playerName: v.string(),
        position: v.string(),
        team: v.string(),
      })),
      status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("rejected"), v.literal("completed")),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    
    for (const trade of args.trades) {
      // Check if trade already exists (by date and teams)
      const existingTrade = await ctx.db
        .query("trades")
        .withIndex("by_date", q => 
          q.eq("leagueId", trade.leagueId)
           .eq("tradeDate", trade.tradeDate)
        )
        .filter(q => 
          q.and(
            q.eq(q.field("teamA.teamId"), trade.teamA.teamId),
            q.eq(q.field("teamB.teamId"), trade.teamB.teamId)
          )
        )
        .first();
      
      if (!existingTrade) {
        await ctx.db.insert("trades", {
          ...trade,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  },
});

// Store transactions in database
export const storeTransactions = mutation({
  args: {
    transactions: v.array(v.object({
      leagueId: v.id("leagues"),
      seasonId: v.number(),
      transactionDate: v.number(),
      transactionType: v.union(
        v.literal("add"),
        v.literal("drop"),
        v.literal("add_drop"),
        v.literal("waiver_claim"),
        v.literal("trade")
      ),
      teamId: v.string(),
      teamName: v.string(),
      manager: v.string(),
      playerAdded: v.optional(v.object({
        playerId: v.string(),
        playerName: v.string(),
        position: v.string(),
        team: v.string(),
      })),
      playerDropped: v.optional(v.object({
        playerId: v.string(),
        playerName: v.string(),
        position: v.string(),
        team: v.string(),
      })),
      waiverPriority: v.optional(v.number()),
      isSuccessful: v.optional(v.boolean()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    
    for (const transaction of args.transactions) {
      // Check if transaction already exists
      const existingTransaction = await ctx.db
        .query("transactions")
        .withIndex("by_date", q => 
          q.eq("leagueId", transaction.leagueId)
           .eq("transactionDate", transaction.transactionDate)
        )
        .filter(q => 
          q.eq(q.field("teamId"), transaction.teamId)
        )
        .first();
      
      if (!existingTransaction) {
        await ctx.db.insert("transactions", {
          ...transaction,
          createdAt: now,
        });
      }
    }
  },
});