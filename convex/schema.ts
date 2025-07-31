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

  // All transactions (waivers, drops, adds)
  transactions: defineTable({
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    transactionDate: v.number(),
    transactionType: v.union(
      v.literal("add"),
      v.literal("drop"),
      v.literal("add_drop"),
      v.literal("waiver_claim"),
      v.literal("trade") // Reference to trades table
    ),
    
    // Team making the transaction
    teamId: v.string(),
    teamName: v.string(),
    manager: v.string(),
    
    // Players involved
    playerAdded: v.optional(v.object({
      playerId: v.string(),
      playerName: v.string(),
      position: v.string(),
      team: v.string(), // NFL team
    })),
    playerDropped: v.optional(v.object({
      playerId: v.string(),
      playerName: v.string(),
      position: v.string(),
      team: v.string(), // NFL team
    })),
    
    // Waiver details
    waiverPriority: v.optional(v.number()),
    faabBid: v.optional(v.number()),
    isSuccessful: v.optional(v.boolean()),
    
    // Reference to trade if applicable
    tradeId: v.optional(v.id("trades")),
    
    createdAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_season", ["leagueId", "seasonId"])
    .index("by_date", ["leagueId", "transactionDate"])
    .index("by_team", ["leagueId", "teamId"])
    .index("by_type", ["transactionType"]),

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
});