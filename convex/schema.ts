import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // User profiles and preferences
  users: defineTable({
    clerkId: v.string(), // Clerk user ID
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    hasCompletedOnboarding: v.boolean(),
    preferences: v.optional(v.object({
      emailNotifications: v.boolean(),
      favoriteTeam: v.optional(v.string()),
      timezone: v.optional(v.string()),
    })),
    createdAt: v.number(),
    lastActiveAt: v.number(),
  }).index("by_clerk_id", ["clerkId"]),

  // Users can create and join leagues
  leagues: defineTable({
    name: v.string(),
    platform: v.literal("espn"),
    externalId: v.string(),
    commissionerUserId: v.string(), // Clerk user ID
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
    subscription: v.object({
      tier: v.string(),
      status: v.string(),
      stripeCustomerId: v.optional(v.string()),
      stripeSubscriptionId: v.optional(v.string()),
      creditsRemaining: v.number(),
      creditsMonthly: v.number(),
    }),
    lastSync: v.number(),
    createdAt: v.number(),
  })
    .index("by_commissioner", ["commissionerUserId"])
    .index("by_external_id", ["platform", "externalId"]),

  // League memberships for users who join leagues
  leagueMemberships: defineTable({
    leagueId: v.id("leagues"),
    userId: v.string(), // Clerk user ID
    role: v.union(v.literal("commissioner"), v.literal("member")),
    joinedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_user", ["userId"])
    .index("by_league_user", ["leagueId", "userId"]),

  teams: defineTable({
    leagueId: v.id("leagues"),
    externalId: v.string(),
    name: v.string(),
    abbreviation: v.optional(v.string()),
    location: v.optional(v.string()),
    nickname: v.optional(v.string()),
    logo: v.optional(v.string()),
    customLogo: v.optional(v.id("_storage")), // User-uploaded custom logo
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
    seasonId: v.number(),
    divisionId: v.optional(v.number()),
    isActive: v.optional(v.boolean()), // Used to mark teams as inactive instead of deleting
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_season", ["leagueId", "seasonId"])
    .index("by_external", ["leagueId", "externalId", "seasonId"]),

  // Enhanced player data from ESPN
  players: defineTable({
    externalId: v.string(), // ESPN player ID
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
      weeklyStats: v.optional(v.array(v.object({
        week: v.number(),
        appliedTotal: v.optional(v.number()),
        projectedTotal: v.optional(v.number()),
      }))),
    })),
    ownership: v.optional(v.object({
      percentOwned: v.optional(v.number()),
      percentChange: v.optional(v.number()),
      percentStarted: v.optional(v.number()),
    })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_external_id", ["externalId"]),

  // League history with detailed season information
  leagueSeasons: defineTable({
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    settings: v.object({
      name: v.string(),
      size: v.number(),
      scoringType: v.string(),
      playoffTeamCount: v.number(),
      playoffWeeks: v.number(),
      regularSeasonMatchupPeriods: v.number(),
      rosterSettings: v.optional(v.object({
        lineupSlotCounts: v.optional(v.record(v.string(), v.number())),
        isBenchUnlimited: v.optional(v.boolean()),
        isUsingUndroppableList: v.optional(v.boolean()),
        lineupLocktimeType: v.optional(v.string()),
        lineupSlotStatLimits: v.optional(v.record(v.string(), v.any())),
        moveLimit: v.optional(v.number()),
        positionLimits: v.optional(v.record(v.string(), v.number())),
        rosterLocktimeType: v.optional(v.string()),
        universeIds: v.optional(v.array(v.number())),
      })),
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
    draftSettings: v.optional(v.any()), // Store ESPN's draftSettings object
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
    createdAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_league_season", ["leagueId", "seasonId"]),

  // Matchup data for weekly results
  matchups: defineTable({
    leagueId: v.id("leagues"),
    seasonId: v.number(),
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
    homeRoster: v.optional(v.object({
      appliedStatTotal: v.number(),
      players: v.array(v.object({
        lineupSlotId: v.number(),
        espnId: v.number(),
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        fullName: v.string(),
        position: v.string(), // Converted from defaultPositionId using getPositionName
        points: v.number(),
        appliedStats: v.optional(v.record(v.string(), v.number())), // Fantasy points breakdown
        projectedPoints: v.optional(v.number()),
        projectedStats: v.optional(v.record(v.string(), v.number())),
      })),
    })),
    
    awayRoster: v.optional(v.object({
      appliedStatTotal: v.number(),
      players: v.array(v.object({
        lineupSlotId: v.number(),
        espnId: v.number(),
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        fullName: v.string(),
        position: v.string(), // Converted from defaultPositionId using getPositionName
        points: v.number(),
        appliedStats: v.optional(v.record(v.string(), v.number())), // Fantasy points breakdown
        projectedPoints: v.optional(v.number()),
        projectedStats: v.optional(v.record(v.string(), v.number())),
      })),
    })),
    
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_league_period", ["leagueId", "matchupPeriod"])
    .index("by_league_season", ["leagueId", "seasonId"])
    .index("by_unique_matchup", ["leagueId", "seasonId", "matchupPeriod", "homeTeamId", "awayTeamId"]),

  aiContent: defineTable({
    leagueId: v.id("leagues"),
    type: v.string(), // "recap", "preview", "analysis", etc.
    persona: v.string(),
    title: v.string(),
    content: v.string(),
    metadata: v.object({
      week: v.optional(v.number()),
      featured_teams: v.array(v.id("teams")),
      credits_used: v.number(),
    }),
    status: v.string(), // "draft", "published", "scheduled"
    publishedAt: v.optional(v.number()),
    createdAt: v.number(),
    bannerImageId: v.optional(v.id("_storage")), // AI-generated banner image
    tempGenerationData: v.optional(v.any()), // Temporary data for multi-step generation
  })
    .index("by_league", ["leagueId"])
    .index("by_status", ["status"])
    .index("by_league_published", ["leagueId", "publishedAt"]),

  weeklyStats: defineTable({
    leagueId: v.id("leagues"),
    week: v.number(),
    teamStats: v.array(v.object({
      teamId: v.id("teams"),
      score: v.number(),
      projectedScore: v.number(),
      rank: v.number(),
    })),
    topPerformers: v.array(v.object({
      playerId: v.string(),
      playerName: v.string(),
      points: v.number(),
      teamId: v.id("teams"),
    })),
    createdAt: v.number(),
  }).index("by_league_week", ["leagueId", "week"]),

  // Team invitations for claiming teams in upcoming season
  teamInvitations: defineTable({
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    seasonId: v.number(),
    inviteToken: v.string(),
    email: v.optional(v.string()),
    teamName: v.string(),
    teamAbbreviation: v.optional(v.string()),
    teamLogo: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("claimed"), v.literal("expired")),
    claimedByUserId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
  })
    .index("by_league", ["leagueId"])
    .index("by_token", ["inviteToken"])
    .index("by_team", ["teamId"])
    .index("by_status", ["status"]),

  // Team claims for the upcoming season (2025)
  teamClaims: defineTable({
    leagueId: v.id("leagues"),
    teamId: v.id("teams"),
    seasonId: v.number(),
    userId: v.string(), // Clerk user ID
    status: v.union(v.literal("active"), v.literal("pending")),
    createdAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_user", ["userId"])
    .index("by_team_season", ["teamId", "seasonId"]),

  // Enhanced player management tables
  playersEnhanced: defineTable({
    // ESPN player ID - unique identifier across all leagues
    espnId: v.string(),
    season: v.number(), // e.g., 2025
    
    // Basic info
    fullName: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    
    // Position data
    defaultPositionId: v.number(),
    defaultPosition: v.string(), // e.g., "RB", "WR"
    eligibleSlots: v.array(v.number()),
    eligiblePositions: v.array(v.string()),
    
    // Team info
    proTeamId: v.number(),
    proTeamAbbrev: v.optional(v.string()),
    jersey: v.optional(v.string()),
    
    // Player status
    active: v.boolean(),
    injured: v.boolean(),
    injuryStatus: v.optional(v.string()),
    
    // ESPN metadata
    droppable: v.boolean(),
    universeId: v.optional(v.number()),
    
    // Global ownership stats
    ownership: v.object({
      percentOwned: v.number(),
      percentStarted: v.number(),
      percentChange: v.optional(v.number()),
      auctionValueAverage: v.optional(v.number()),
      averageDraftPosition: v.optional(v.number()),
    }),
    
    // Rankings
    draftRanksByRankType: v.optional(v.any()), // Complex ESPN ranking object
    
    // Season outlook
    seasonOutlook: v.optional(v.string()),
    
    // Stats snapshot (raw ESPN data structure)
    stats: v.optional(v.any()), // ESPN returns complex array structure
    
    // Transformed stats for easier consumption
    actualStats: v.optional(v.record(v.string(), v.number())), // Transformed actual stats using statSourceId: 0
    projectedStats: v.optional(v.record(v.string(), v.number())), // Transformed projected stats using statSourceId: 1
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_espn_id_season", ["espnId", "season"])
    .index("by_position", ["defaultPosition"])
    .index("by_pro_team", ["proTeamId"])
    .index("by_ownership", ["ownership.percentOwned"])
    .index("by_season", ["season"])
    .index("by_season_adp", ["season", "ownership.averageDraftPosition"]),

  // League-specific player status
  leaguePlayerStatus: defineTable({
    leagueId: v.id("leagues"),
    playerId: v.string(), // ESPN player ID
    season: v.number(),
    
    // Ownership status in this league
    status: v.union(
      v.literal("owned"),
      v.literal("free_agent"),
      v.literal("waivers"),
      v.literal("cant_drop")
    ),
    
    // Team ownership (if owned)
    teamId: v.optional(v.id("teams")),
    teamExternalId: v.optional(v.string()),
    
    // Roster position (if owned)
    lineupSlotId: v.optional(v.number()),
    acquisitionType: v.optional(v.string()), // DRAFT, ADD, TRADE
    acquisitionDate: v.optional(v.number()),
    
    // Waiver/trade info
    onWaivers: v.boolean(),
    waiverProcessDate: v.optional(v.number()),
    tradeLocked: v.boolean(),
    keeperValue: v.optional(v.number()),
    keeperValueFuture: v.optional(v.number()),
    
    // League-specific values
    draftAuctionValue: v.optional(v.number()),
    
    updatedAt: v.number(),
  })
    .index("by_league_player", ["leagueId", "playerId"])
    .index("by_league_status", ["leagueId", "status"])
    .index("by_team", ["teamId"])
    .index("by_league_free_agents", ["leagueId", "status", "playerId"]),

  // Player sync status tracking
  playerSyncStatus: defineTable({
    type: v.string(), // "all", "league", "default"
    season: v.number(),
    status: v.union(v.literal("syncing"), v.literal("completed"), v.literal("failed")),
    leagueId: v.optional(v.id("leagues")),
    error: v.optional(v.string()),
    playersProcessed: v.optional(v.number()),
    totalPlayers: v.optional(v.number()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_type_season", ["type", "season"])
    .index("by_league", ["leagueId"]),

  // ESPN News articles
  espnNews: defineTable({
    espnId: v.string(), // ESPN article ID
    nowId: v.optional(v.string()), // ESPN now ID
    type: v.string(), // "Story", "HeadlineNews", etc.
    headline: v.string(),
    description: v.optional(v.string()),
    lastModified: v.string(), // ISO date string
    published: v.string(), // ISO date string
    byline: v.optional(v.string()),
    premium: v.boolean(),
    
    // Links
    links: v.object({
      web: v.optional(v.string()),
      mobile: v.optional(v.string()),
      api: v.optional(v.string()),
    }),
    
    // Images
    images: v.array(v.object({
      id: v.optional(v.string()),
      url: v.string(),
      alt: v.optional(v.string()),
      caption: v.optional(v.string()),
      width: v.optional(v.number()),
      height: v.optional(v.number()),
    })),
    
    // Processed categories
    categories: v.object({
      teams: v.array(v.object({
        id: v.number(),
        name: v.string(),
        abbreviation: v.optional(v.string()),
      })),
      athletes: v.array(v.object({
        id: v.number(),
        name: v.string(),
        position: v.optional(v.string()),
      })),
      leagues: v.array(v.object({
        id: v.number(),
        name: v.string(),
        abbreviation: v.optional(v.string()),
      })),
    }),
    
    // Metadata
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_espn_id", ["espnId"])
    .index("by_published", ["published"])
    .index("by_updated", ["updatedAt"]),

  // League-specific player stats
  playerStats: defineTable({
    leagueId: v.id("leagues"),
    espnId: v.string(),
    season: v.number(),
    
    // League's scoring type for reference
    scoringType: v.string(), // "PPR", "HALF_PPR", "STANDARD", "CUSTOM"
    
    // Calculated stats based on league's specific scoring rules
    stats: v.any(), // Same structure as playersEnhanced.stats but with league-specific calculations
    
    // Transformed stats for easier consumption (league-specific)
    actualStats: v.optional(v.record(v.string(), v.number())), // Transformed actual stats using statSourceId: 0
    projectedStats: v.optional(v.record(v.string(), v.number())), // Transformed projected stats using statSourceId: 1
    
    // Track last calculation
    calculatedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league_player", ["leagueId", "espnId", "season"])
    .index("by_league", ["leagueId"])
    .index("by_player", ["espnId"]),

  // Trade transactions
  trades: defineTable({
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    tradeDate: v.number(),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("rejected"), v.literal("completed")),
    
    // Teams involved
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
    
    // Players exchanged
    playersFromTeamA: v.array(v.object({
      playerId: v.string(),
      playerName: v.string(),
      position: v.string(),
      team: v.string(), // NFL team
    })),
    playersFromTeamB: v.array(v.object({
      playerId: v.string(),
      playerName: v.string(),
      position: v.string(),
      team: v.string(), // NFL team
    })),
    
    // Optional trade details
    faabFromTeamA: v.optional(v.number()),
    faabFromTeamB: v.optional(v.number()),
    draftPicksFromTeamA: v.optional(v.array(v.object({
      round: v.number(),
      year: v.number(),
    }))),
    draftPicksFromTeamB: v.optional(v.array(v.object({
      round: v.number(),
      year: v.number(),
    }))),
    
    // Trade analysis (can be AI-generated or manual)
    analysis: v.optional(v.object({
      teamAGrade: v.optional(v.string()), // A+, A, B+, etc.
      teamBGrade: v.optional(v.string()),
      summary: v.optional(v.string()),
      impactTeamA: v.optional(v.string()),
      impactTeamB: v.optional(v.string()),
    })),
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_season", ["leagueId", "seasonId"])
    .index("by_date", ["leagueId", "tradeDate"])
    .index("by_team", ["leagueId", "teamA.teamId"])
    .index("by_status", ["status"]),

  // ESPN transactions with complete data model
  transactions: defineTable({
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    espnTransactionId: v.string(), // ESPN's unique transaction ID
    
    // Transaction metadata from ESPN
    bidAmount: v.number(),
    executionType: v.string(), // "EXECUTE", "PROCESS", etc.
    isActingAsTeamOwner: v.boolean(),
    isLeagueManager: v.boolean(),
    isPending: v.boolean(),
    
    // Transaction items array - captures all player movements
    items: v.array(v.object({
      fromLineupSlotId: v.number(),
      fromTeamId: v.number(), // 0 means free agent
      isKeeper: v.boolean(),
      overallPickNumber: v.number(),
      playerId: v.number(),
      toLineupSlotId: v.number(),
      toTeamId: v.number(),
      type: v.string(), // "ADD", "DROP", "MOVE", etc.
    })),
    
    // Transaction type classification
    type: v.string(), // DRAFT, TRADE_ACCEPT, WAIVER, etc.
    
    // Additional metadata
    proposedDate: v.number(),
    processedDate: v.optional(v.number()),
    status: v.string(),
    scoringPeriod: v.number(),
    teamId: v.number(), // Primary team involved
    
    createdAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_season", ["leagueId", "seasonId"])
    .index("by_espn_id", ["espnTransactionId"])
    .index("by_date", ["leagueId", "proposedDate"])
    .index("by_type", ["type"])
    .index("by_scoring_period", ["leagueId", "seasonId", "scoringPeriod"]),

  // Team rivalries
  rivalries: defineTable({
    leagueId: v.id("leagues"),
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
    
    // Rivalry stats
    allTimeRecord: v.object({
      teamAWins: v.number(),
      teamBWins: v.number(),
      ties: v.number(),
    }),
    playoffMeetings: v.number(),
    championshipMeetings: v.number(),
    
    // Notable games
    notableGames: v.optional(v.array(v.object({
      seasonId: v.number(),
      week: v.number(),
      teamAScore: v.number(),
      teamBScore: v.number(),
      significance: v.string(), // "Playoff", "Championship", "Upset", etc.
      description: v.optional(v.string()),
    }))),
    
    // Rivalry intensity (calculated or manual)
    intensity: v.union(
      v.literal("casual"),
      v.literal("competitive"), 
      v.literal("heated"),
      v.literal("bitter")
    ),
    
    // Custom rivalry story/lore
    backstory: v.optional(v.string()),
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_teams", ["leagueId", "teamA.teamId", "teamB.teamId"]),

  // Manager activity tracking
  managerActivity: defineTable({
    leagueId: v.id("leagues"),
    userId: v.string(), // Clerk user ID
    teamId: v.string(),
    seasonId: v.number(),
    
    // Activity metrics
    totalTransactions: v.number(),
    trades: v.number(),
    waiverClaims: v.number(),
    lineupChanges: v.number(),
    
    // Engagement metrics
    lastActiveAt: v.number(),
    loginCount: v.number(),
    messagesSent: v.optional(v.number()),
    
    // Performance metrics
    optimalLineupPercentage: v.optional(v.number()), // How often they set optimal lineup
    benchPointsLeft: v.optional(v.number()), // Total points left on bench
    
    // Awards/Recognition
    weeklyHighScores: v.number(),
    weeklyLowScores: v.number(),
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league_user", ["leagueId", "userId"])
    .index("by_league_season", ["leagueId", "seasonId"])
    .index("by_team", ["teamId"]),

  // Weather data for games (optional)
  weatherData: defineTable({
    nflGameId: v.string(), // ESPN game ID or similar
    gameDate: v.number(),
    stadium: v.string(),
    
    // Weather conditions
    temperature: v.number(), // Fahrenheit
    condition: v.string(), // "Clear", "Rain", "Snow", etc.
    windSpeed: v.optional(v.number()), // mph
    precipitation: v.optional(v.number()), // percentage
    isDome: v.boolean(),
    
    // Impact assessment
    passingImpact: v.optional(v.string()), // "Negative", "Neutral", "Positive"
    rushingImpact: v.optional(v.string()),
    kickingImpact: v.optional(v.string()),
    
    createdAt: v.number(),
  })
    .index("by_date", ["gameDate"])
    .index("by_game", ["nflGameId"]),

  // NFL team schedules
  nflSchedules: defineTable({
    season: v.number(),
    week: v.number(),
    teamId: v.number(), // ESPN team ID
    teamAbbrev: v.string(),
    
    // Game details
    opponent: v.string(),
    isHome: v.boolean(),
    gameTime: v.number(),
    
    // Matchup difficulty
    opponentRankVsPosition: v.optional(v.object({
      vsQB: v.optional(v.number()),
      vsRB: v.optional(v.number()),
      vsWR: v.optional(v.number()),
      vsTE: v.optional(v.number()),
      vsDST: v.optional(v.number()),
    })),
    
    // Game result (after played)
    result: v.optional(v.object({
      teamScore: v.number(),
      opponentScore: v.number(),
      won: v.boolean(),
    })),
    
    isByeWeek: v.boolean(),
    
    createdAt: v.number(),
  })
    .index("by_team_season", ["teamId", "season"])
    .index("by_week", ["season", "week"])
    .index("by_team_week", ["teamId", "season", "week"]),

  // Content schedule configurations for leagues
  contentSchedules: defineTable({
    leagueId: v.id("leagues"),
    contentType: v.union(
      v.literal("weekly_recap"),
      v.literal("weekly_preview"),
      v.literal("trade_analysis"),
      v.literal("power_rankings"),
      v.literal("waiver_wire_report"),
      v.literal("mock_draft"),
      v.literal("rivalry_week_special"),
      v.literal("emergency_hot_takes"),
      v.literal("mid_season_awards"),
      v.literal("championship_manifesto"),
      v.literal("season_recap"),
      v.literal("custom_roast"),
      v.literal("season_welcome")
    ),
    
    // Schedule configuration
    enabled: v.boolean(),
    timezone: v.string(), // e.g., "America/New_York"
    
    // Timing configuration based on content type
    schedule: v.union(
      // For weekly recurring content (waiver_wire_report, power_rankings, weekly_preview, weekly_recap)
      v.object({
        type: v.literal("weekly"),
        dayOfWeek: v.number(), // 0=Sunday, 1=Monday, etc.
        hour: v.number(), // 0-23
        minute: v.number(), // 0-59
      }),
      // For relative scheduling (mock_draft - X days before draft)
      v.object({
        type: v.literal("relative"),
        relativeTo: v.string(), // "draft_date", "season_end", etc.
        offsetDays: v.number(), // negative for before, positive for after
        hour: v.number(),
        minute: v.number(),
      }),
      // For event-triggered content (trade_analysis - when trade happens)
      v.object({
        type: v.literal("event_triggered"),
        trigger: v.string(), // "trade_occurred", "season_ended", etc.
        delayMinutes: v.optional(v.number()), // optional delay after trigger
      }),
      // For season-based scheduling (season_recap - after season ends)
      v.object({
        type: v.literal("season_based"),
        trigger: v.string(), // "season_end", "champion_determined"
        delayDays: v.optional(v.number()),
        hour: v.number(),
        minute: v.number(),
      })
    ),
    
    // Persona preference for this content type
    preferredPersona: v.optional(v.string()),
    
    // Additional configuration
    customSettings: v.optional(v.object({
      includeAnalysis: v.optional(v.boolean()),
      focusAreas: v.optional(v.array(v.string())),
      excludeTeams: v.optional(v.array(v.string())),
    })),
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_league_type", ["leagueId", "contentType"])
    .index("by_enabled", ["enabled"]),

  // Scheduled content generation jobs
  scheduledContent: defineTable({
    leagueId: v.id("leagues"),
    contentScheduleId: v.id("contentSchedules"),
    contentType: v.string(),
    
    // Scheduling details
    scheduledFor: v.number(), // timestamp when content should be generated
    status: v.union(
      v.literal("pending"),
      v.literal("generating"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    
    // Generation attempt tracking
    attempts: v.number(),
    maxAttempts: v.number(),
    lastAttemptAt: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
    
    // Context data for generation
    contextData: v.optional(v.object({
      week: v.optional(v.number()),
      seasonId: v.optional(v.number()),
      triggerEvent: v.optional(v.string()),
      tradeId: v.optional(v.id("trades")),
      additionalContext: v.optional(v.any()),
    })),
    
    // Results
    generatedContentId: v.optional(v.id("aiContent")),
    errorMessage: v.optional(v.string()),
    generatedAt: v.optional(v.number()),
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_scheduled_time", ["scheduledFor"])
    .index("by_status", ["status"])
    .index("by_league_status", ["leagueId", "status"])
    .index("by_schedule_config", ["contentScheduleId"]),

  // League content preferences - overall settings for each league
  leagueContentPreferences: defineTable({
    leagueId: v.id("leagues"),
    
    // Global content settings
    contentEnabled: v.boolean(), // Master switch for all scheduled content
    timezone: v.string(), // League's preferred timezone
    
    // Credit management
    monthlyContentBudget: v.optional(v.number()), // Max credits to spend on scheduled content per month
    currentMonthSpent: v.number(),
    budgetResetDate: v.number(), // When to reset the monthly budget
    
    // Notification preferences
    notifyCommissioner: v.boolean(), // Notify when content is generated
    notifyFailures: v.boolean(), // Notify when generation fails
    
    // Content quality settings
    preferredPersonas: v.optional(v.array(v.string())), // Preferred personas in order
    contentStyle: v.optional(v.union(
      v.literal("professional"),
      v.literal("casual"),
      v.literal("humorous"),
      v.literal("analytical")
    )),
    
    // Auto-publish settings
    autoPublish: v.boolean(), // Automatically publish generated content
    requireApproval: v.boolean(), // Require commissioner approval before publishing
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_content_enabled", ["contentEnabled"]),

  // NFL season metadata for accurate season phase detection
  nflSeasons: defineTable({
    year: v.number(), // NFL season year (e.g., 2025 for 2025-2026 season)
    
    // Season phase boundaries (all timestamps in UTC)
    phases: v.object({
      preseason: v.object({
        start: v.number(), // Late July - when preseason begins
        end: v.number(),   // Early September - day before regular season
      }),
      regularSeason: v.object({
        start: v.number(), // Early September - Week 1 Thursday
        end: v.number(),   // Early January - after Week 18
      }),
      playoffs: v.object({
        start: v.number(), // Mid January - Wild Card weekend
        end: v.number(),   // Day before Super Bowl
      }),
      superBowl: v.object({
        start: v.number(), // Super Bowl Sunday
        end: v.number(),   // End of Super Bowl Sunday
      }),
      offseason: v.object({
        start: v.number(), // Day after Super Bowl
        end: v.number(),   // Day before preseason starts
      }),
    }),
    
    // Regular season week boundaries for accurate week detection
    weekBoundaries: v.array(v.object({
      week: v.number(),     // Week number (1-18)
      start: v.number(),    // Week start (typically Tuesday after previous week)
      end: v.number(),      // Week end (typically Monday night)
      isPlayoffs: v.boolean(),
    })),
    
    // Important dates
    draftEligibilityWindow: v.object({
      start: v.number(), // When fantasy drafts typically become available
      end: v.number(),   // Last reasonable draft date before season
    }),
    
    // Playoff structure
    playoffStructure: v.object({
      wildCardWeek: v.number(),     // Week 19
      divisionalWeek: v.number(),   // Week 20  
      championshipWeek: v.number(), // Week 21
      superBowlWeek: v.number(),    // Week 22
    }),
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_year", ["year"]),

  // Comment requests - AI reaches out to users for comments before article generation
  commentRequests: defineTable({
    // Core relationships
    leagueId: v.id("leagues"),
    scheduledContentId: v.id("scheduledContent"), // The article this comment is for
    targetUserId: v.id("users"), // User being asked for comment
    
    // Request context
    contentType: v.string(), // "weekly_recap", etc. (copied from scheduledContent)
    articleContext: v.object({
      week: v.optional(v.number()),
      seasonId: v.optional(v.number()),
      topic: v.optional(v.string()), // "Your team's performance", "Trade impact", etc.
      focusAreas: v.optional(v.array(v.string())), // Specific topics to comment on
    }),
    
    // Timing and lifecycle
    status: v.union(
      v.literal("pending"),      // Request created, not yet sent
      v.literal("active"),       // Request sent, waiting for user response
      v.literal("completed"),    // User provided response
      v.literal("expired"),      // Passed expiration time without response
      v.literal("declined"),     // User explicitly declined to comment
      v.literal("cancelled")     // Request cancelled (e.g., article cancelled)
    ),
    
    // Critical timing fields for automation
    scheduledSendTime: v.number(),    // When to send the request (12-24 hours before)
    expirationTime: v.number(),       // 15 minutes before article generation
    articleGenerationTime: v.number(), // When the article will be generated
    
    // Conversation state management
    conversationState: v.union(
      v.literal("not_started"),          // No messages sent yet
      v.literal("initial_request_sent"), // Initial request sent, awaiting response
      v.literal("follow_up_needed"),     // AI should ask follow-up questions
      v.literal("gathering_details"),    // In active conversation
      v.literal("response_complete"),    // User finished providing input
      v.literal("auto_ended")           // Conversation auto-ended due to time/completion
    ),
    
    // AI context for maintaining conversation focus
    aiContext: v.object({
      initialPrompt: v.string(),              // The initial request prompt
      conversationGoals: v.array(v.string()), // What info AI should gather
      followUpQuestions: v.optional(v.array(v.string())), // Pre-planned follow-ups
      currentFocus: v.optional(v.string()),   // Current conversation topic
      userPersonality: v.optional(v.string()), // Detected user communication style
    }),
    
    // Auto-end logic tracking
    autoEndCriteria: v.object({
      maxMessages: v.number(),           // Max messages in conversation (default: 10)
      currentMessageCount: v.number(),   // Current count
      minResponseLength: v.number(),     // Minimum response length to be "complete"
      responseCompleteness: v.optional(v.number()), // AI assessment 0-100%
      lastActivityTime: v.number(),      // Last message timestamp
      inactivityTimeoutMinutes: v.number(), // Auto-end after inactivity (default: 30)
    }),
    
    // Request metadata
    priority: v.union(
      v.literal("high"),    // Key players, commissioners
      v.literal("medium"),  // Regular active users
      v.literal("low")      // Less active users
    ),
    
    // Notification tracking
    notificationsSent: v.array(v.object({
      type: v.union(
        v.literal("initial_request"),
        v.literal("reminder"),
        v.literal("follow_up"),
        v.literal("final_reminder")
      ),
      sentAt: v.number(),
      method: v.union(v.literal("app_notification"), v.literal("email")),
      delivered: v.boolean(),
    })),
    
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
  })
    .index("by_scheduled_content", ["scheduledContentId"])
    .index("by_user", ["targetUserId"])
    .index("by_league", ["leagueId"])
    .index("by_status", ["status"])
    .index("by_send_time", ["scheduledSendTime"]) // For cron jobs to pick up
    .index("by_expiration", ["expirationTime"])   // For cleanup/expiration jobs
    .index("by_league_status", ["leagueId", "status"])
    .index("by_user_status", ["targetUserId", "status"])
    .index("by_priority_status", ["priority", "status"]),

  // Comment conversations - actual message exchanges between AI and users
  commentConversations: defineTable({
    // Core relationships
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"), // Denormalized for efficient queries
    userId: v.id("users"),     // Denormalized for efficient queries
    
    // Message content
    messageType: v.union(
      v.literal("ai_question"),    // AI asking user for input
      v.literal("user_response"),  // User providing response
      v.literal("ai_follow_up"),   // AI asking for clarification
      v.literal("ai_confirmation"), // AI confirming understanding
      v.literal("system_message")  // System notifications (auto-end, etc.)
    ),
    
    content: v.string(), // The actual message content
    
    // Message metadata
    messageOrder: v.number(), // Sequential order within conversation
    isRead: v.boolean(),      // Has user seen this message
    
    // AI processing metadata (for AI messages)
    aiMetadata: v.optional(v.object({
      promptTemplate: v.optional(v.string()),     // Template used
      generationModel: v.optional(v.string()),    // AI model used
      processingTime: v.optional(v.number()),     // Generation time in ms
      confidence: v.optional(v.number()),         // AI confidence 0-100%
      intent: v.optional(v.string()),             // What AI was trying to achieve
    })),
    
    // User response analysis (for user messages)
    responseAnalysis: v.optional(v.object({
      sentiment: v.optional(v.string()),          // "positive", "negative", "neutral"
      completeness: v.optional(v.number()),       // 0-100% how complete response is
      relevantTopics: v.optional(v.array(v.string())), // Extracted topics
      needsFollowUp: v.optional(v.boolean()),     // Should AI ask follow-up?
      suggestedFollowUps: v.optional(v.array(v.string())), // Potential questions
    })),
    
    // Timing
    createdAt: v.number(),
    editedAt: v.optional(v.number()), // If user edited their response
    
    // Threading support (for complex conversations)
    parentMessageId: v.optional(v.id("commentConversations")),
    threadDepth: v.number(), // 0 for main thread, 1+ for nested
  })
    .index("by_comment_request", ["commentRequestId"])
    .index("by_comment_request_order", ["commentRequestId", "messageOrder"])
    .index("by_user", ["userId"])
    .index("by_league", ["leagueId"])
    .index("by_message_type", ["messageType"])
    .index("by_unread", ["userId", "isRead"])
    .index("by_created_at", ["createdAt"])
    .index("by_thread", ["parentMessageId", "threadDepth"]),

  // Comment responses - processed final responses for article integration
  commentResponses: defineTable({
    // Core relationships
    commentRequestId: v.id("commentRequests"),
    leagueId: v.id("leagues"), // Denormalized
    userId: v.id("users"),     // Denormalized
    scheduledContentId: v.id("scheduledContent"), // For article integration
    
    // Processed response content
    rawResponse: v.string(),        // Original user response(s) combined
    processedResponse: v.string(),   // Cleaned/formatted for article use
    
    // Content categorization
    responseType: v.union(
      v.literal("opinion"),         // User opinion/commentary
      v.literal("analysis"),        // User analysis of situation
      v.literal("prediction"),      // User predictions
      v.literal("story"),          // User anecdote/story
      v.literal("question"),       // User asking questions
      v.literal("mixed")           // Combination of above
    ),
    
    // Relevance and quality metadata
    relevanceMetadata: v.object({
      topicRelevance: v.number(),     // 0-100% how relevant to article topic
      qualityScore: v.number(),       // 0-100% content quality
      originality: v.number(),        // 0-100% how unique/interesting
      usabilityRating: v.union(       // How usable in article
        v.literal("high"),    // Perfect for direct quote
        v.literal("medium"),  // Good with light editing
        v.literal("low"),     // Only useful for inspiration
        v.literal("unusable") // Cannot be used
      ),
      extractedQuotes: v.optional(v.array(v.string())), // Quotable segments
      keyInsights: v.optional(v.array(v.string())),     // Main insights
      suggestedUsage: v.optional(v.string()),           // How to use in article
    }),
    
    // Article integration tracking
    integrationStatus: v.union(
      v.literal("pending"),     // Available for use
      v.literal("selected"),    // Chosen for article
      v.literal("integrated"),  // Actually used in article
      v.literal("rejected"),    // Not suitable for use
      v.literal("archived")     // Archived after article completion
    ),
    
    // Usage tracking
    usedInArticle: v.optional(v.boolean()),
    articleSection: v.optional(v.string()), // Which section it was used in
    quoteAttribution: v.optional(v.string()), // How user should be credited
    
    // Response context
    conversationSummary: v.optional(v.string()), // Summary of full conversation
    userEngagementLevel: v.union(
      v.literal("high"),    // Very engaged, detailed responses
      v.literal("medium"),  // Good engagement
      v.literal("low"),     // Minimal responses
      v.literal("reluctant") // Provided response but seemed hesitant
    ),
    
    createdAt: v.number(),
    updatedAt: v.number(),
    processedAt: v.number(),
    integratedAt: v.optional(v.number()),
  })
    .index("by_comment_request", ["commentRequestId"])
    .index("by_scheduled_content", ["scheduledContentId"])
    .index("by_user", ["userId"])
    .index("by_league", ["leagueId"])
    .index("by_integration_status", ["integrationStatus"])
    .index("by_usability", ["relevanceMetadata.usabilityRating"])
    .index("by_quality", ["relevanceMetadata.qualityScore"])
    .index("by_league_integration", ["leagueId", "integrationStatus"]),

  // User notifications - comprehensive notification system
  userNotifications: defineTable({
    // Core relationships
    userId: v.id("users"),
    leagueId: v.optional(v.id("leagues")), // Null for account-wide notifications
    
    // Notification content
    type: v.union(
      v.literal("comment_request"),        // New comment request
      v.literal("comment_reminder"),       // Reminder about pending request
      v.literal("comment_follow_up"),      // AI follow-up in conversation
      v.literal("comment_thank_you"),      // Thanks for providing comment
      v.literal("article_published"),     // Article with your comment published
      v.literal("article_generated"),     // Scheduled article completed
      v.literal("system_announcement"),   // System-wide announcements
      v.literal("league_invitation"),     // League-related invites
      v.literal("account_update")         // Account/subscription changes
    ),
    
    title: v.string(),
    message: v.string(),
    
    // Action/navigation
    actionUrl: v.optional(v.string()),    // Where to navigate when clicked
    actionText: v.optional(v.string()),   // Button text ("View Comment Request")
    
    // Related entities (for deep linking and context)
    relatedEntityType: v.optional(v.union(
      v.literal("comment_request"),
      v.literal("scheduled_content"),
      v.literal("ai_content"),
      v.literal("league"),
      v.literal("user")
    )),
    relatedEntityId: v.optional(v.string()), // ID of related entity
    
    // Status and tracking
    status: v.union(
      v.literal("unread"),
      v.literal("read"),
      v.literal("archived"),
      v.literal("dismissed")
    ),
    
    priority: v.union(
      v.literal("urgent"),     // Immediate attention needed
      v.literal("high"),       // Important but not urgent
      v.literal("medium"),     // Normal priority
      v.literal("low")         // FYI/nice-to-know
    ),
    
    // Delivery tracking
    deliveryChannels: v.array(v.union(
      v.literal("in_app"),     // In-app notification
      v.literal("email"),      // Email notification
      v.literal("push")        // Push notification (future)
    )),
    
    deliveryStatus: v.object({
      inApp: v.optional(v.object({
        delivered: v.boolean(),
        deliveredAt: v.optional(v.number()),
      })),
      email: v.optional(v.object({
        delivered: v.boolean(),
        deliveredAt: v.optional(v.number()),
        emailId: v.optional(v.string()), // External email service ID
        bounced: v.optional(v.boolean()),
        opened: v.optional(v.boolean()),
        clicked: v.optional(v.boolean()),
      })),
      push: v.optional(v.object({
        delivered: v.boolean(),
        deliveredAt: v.optional(v.number()),
        clicked: v.optional(v.boolean()),
      })),
    }),
    
    // User interaction
    readAt: v.optional(v.number()),
    clickedAt: v.optional(v.number()),
    dismissedAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
    
    // Scheduling
    scheduledFor: v.optional(v.number()), // For delayed notifications
    expiresAt: v.optional(v.number()),    // Auto-expire old notifications
    
    // Grouping (for batching similar notifications)
    groupKey: v.optional(v.string()),     // Group similar notifications
    batchId: v.optional(v.string()),      // Batch processing ID
    
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_user_type", ["userId", "type"])
    .index("by_league", ["leagueId"])
    .index("by_priority", ["priority"])
    .index("by_scheduled", ["scheduledFor"]) // For scheduled notifications
    .index("by_expiration", ["expiresAt"])   // For cleanup
    .index("by_group", ["groupKey"])
    .index("by_created_at", ["createdAt"])
    .index("by_user_unread", ["userId", "status", "createdAt"]), // Efficient unread queries

});