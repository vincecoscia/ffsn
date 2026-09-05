import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  articleClaimValidator,
  articleQuoteValidator,
  generationStatsValidator,
  languageRatingValidator,
  managerMentionValidator,
  relationshipEventTypeValidator,
  relationshipTierValidator,
  quoteReviewEntryValidator,
  reviewFlagValidator,
  showTranscriptValidator,
  writerSentimentValidator,
} from "./validators";
import { divisionValidator, waiverTypeValidator } from "./lib/espnSettings";

/** `EditorFinding` from `src/lib/ai/publish-gate.ts` (spec §11.2.7). */
const editorFindingValidator = v.object({
  claim: v.string(),
  sectionName: v.string(),
  factPath: v.optional(v.string()),
});

/** `EditorRegisterLeak` from `src/lib/ai/publish-gate.ts` (spec §11.2.7). */
const editorRegisterLeakValidator = v.object({
  phrase: v.string(),
  sectionName: v.string(),
});

/**
 * The editor pass's verdict on one generated article (spec §11.2.7).
 *
 * Mirrors `EditorPassResult` from `src/lib/ai/publish-gate.ts`: produced by the
 * prompt layer as `GeneratedContent.metadata.editor` and stored on
 * `aiContent.generationStats.editor`, so the reason an article was held
 * survives long after the generation action has gone.
 *
 * Every field is optional even though the prompt layer's type requires most of
 * them. The pass is switched off by `FACT_CHECK_LLM="0"`, articles written
 * before it shipped are still in the table, and a validator failure here would
 * lose an article that has already been paid for and written.
 */
export const editorReviewValidator = v.object({
  contradictions: v.optional(v.array(editorFindingValidator)),
  unsupported: v.optional(v.array(editorFindingValidator)),
  registerLeaks: v.optional(v.array(editorRegisterLeakValidator)),
  /** 1-5. Below 3 holds the article for review (spec §11.2.9). */
  factsScore: v.optional(v.number()),
  /** 1-5. Below 3 is a warning only - voice never blocks. */
  voiceScore: v.optional(v.number()),
  incompleteSections: v.optional(v.array(v.string())),
  model: v.optional(v.string()),
  /** Already included in `generationStats.costUsd`; kept for the digest. */
  costUsd: v.optional(v.number()),
});

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
      // "Keep it clean about my team" (owner ask, Sept 2026): generated content about this
      // manager's team reads as clean whatever the league's languageRating is. Absent means
      // this manager has not opted down.
      cleanLanguage: v.optional(v.boolean()),
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
      // --- ESPN settings mirror (audit: this object was written once by the
      // setup wizard and never refreshed, so `dataProcessing.ts` fell back to
      // stale/default playoff math; `leagues.mirrorSeasonSettings` now
      // refreshes the fields below from every season sync's parsed ESPN
      // settings - see `convex/lib/espnSettings.ts`). All optional: leagues
      // created before this shipped, or a sync ESPN didn't include a field
      // for, still validate. ---
      // Replaces a placeholder that nothing had ever written (`id` was
      // `v.string()`; ESPN's division id is actually numeric, and `size`
      // isn't always present).
      divisions: v.optional(v.array(divisionValidator)),
      playoffMatchupPeriodLength: v.optional(v.number()),
      playoffRounds: v.optional(v.number()),
      playoffSeedingRule: v.optional(v.string()),
      playoffReseed: v.optional(v.boolean()),
      matchupPeriods: v.optional(v.record(v.string(), v.array(v.number()))),
      lineupSlots: v.optional(v.record(v.string(), v.number())),
      isSuperflex: v.optional(v.boolean()),
      hasIdp: v.optional(v.boolean()),
      waiverType: v.optional(waiverTypeValidator),
      faabBudget: v.optional(v.number()),
      waiverHours: v.optional(v.number()),
      tradeDeadline: v.optional(v.number()),
      receptionPoints: v.optional(v.number()),
      scoringSystem: v.optional(v.string()),
      settingsSyncedAt: v.optional(v.number()),
    }),
    espnData: v.optional(v.object({
      seasonId: v.number(),
      currentScoringPeriod: v.number(),
      size: v.number(),
      lastSyncedAt: v.number(),
      isPrivate: v.boolean(),
      espnS2: v.optional(v.string()),
      swid: v.optional(v.string()),
      // --- ESPN credential health (audit: cron alerting on invalid cookies) ---
      // Set by `espnSync.testEspnConnection` (when testing stored credentials)
      // and by the `syncAllLeaguesCurrentSeason` / `syncAllLeagueData` crons
      // and syncs via `leagues.setEspnCredentialStatus`. "unknown" until the
      // first probe. Never written to `credentialError` on success.
      credentialStatus: v.optional(
        v.union(v.literal("valid"), v.literal("invalid"), v.literal("unknown"))
      ),
      credentialCheckedAt: v.optional(v.number()),
      credentialError: v.optional(v.string()),
      // Last time an operator/commissioner alert was sent for invalid
      // credentials on this league. Used to cap alerts to once per 24h.
      credentialAlertedAt: v.optional(v.number()),
      // --- Credential lifecycle (commissioner-facing) ---
      // When the commissioner saved the current cookie pair.
      credentialSavedAt: v.optional(v.number()),
      // Expiry of espn_s2 as the commissioner read it from the browser's cookie
      // panel (optional; ESPN does not publish a lifetime). Drives the 14-day
      // "about to expire" email.
      credentialExpiresAt: v.optional(v.number()),
      // The expiresAt value the 14-day reminder was last sent for.
      expiryReminderSentFor: v.optional(v.number()),
      // Last time the commissioner was emailed that the cookies are rejected
      // (first notice immediately, then reminders every few days).
      credentialInvalidNotifiedAt: v.optional(v.number()),
      // Set while automated content is paused for rejected credentials; the
      // scheduler backlogs rows instead of generating. Cleared on restore.
      contentPausedAt: v.optional(v.number()),
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
      // "pending" | "active" | "paid" (legacy alias for active) | "cancelled".
      // `credits.hasActivePass` is the single reader - never compare this by hand.
      status: v.string(),
      stripeCustomerId: v.optional(v.string()),
      stripeSubscriptionId: v.optional(v.string()),
      creditsRemaining: v.number(),
      creditsMonthly: v.number(),
      paymentStatus: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed")),
      paidAt: v.optional(v.number()),
      seasonYear: v.number(), // e.g., 2025
      // --- League Pass (spec §10.1) ---------------------------------------
      // Managers covered by the base $100 pass. Absent means the default 12
      // (see `leagues.INCLUDED_MANAGERS_DEFAULT`); never read this raw.
      includedManagers: v.optional(v.number()),
      // $10 seats the commissioner bought on top of `includedManagers`.
      // Incremented by `leagues.recordExtraSeat` when a seat payment settles.
      extraSeats: v.optional(v.number()),
      // Set by adminTools.compLeaguePass when a pass was granted without a payment, so a comped
      // league is never counted as revenue.
      compedAt: v.optional(v.number()),
      compedReason: v.optional(v.string()),
      // The NFL season this pass covers. Drives credit expiry and the
      // per-season automated spend cap. Falls back to `seasonYear`.
      seasonId: v.optional(v.number()),
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
      // ESPN final-rank and form fields (refresh audit, Sept 2026); absent on rows written before then.
      rankCalculatedFinal: v.optional(v.number()),
      rankFinal: v.optional(v.number()),
      currentProjectedRank: v.optional(v.number()),
      draftDayProjectedRank: v.optional(v.number()),
      streakLength: v.optional(v.number()),
      streakType: v.optional(v.string()),
      gamesBack: v.optional(v.number()),
      percentage: v.optional(v.number()),
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
        // Backward-compatible flat fields
        appliedTotal: v.optional(v.number()),
        appliedAverage: v.optional(v.number()),
        projectedTotal: v.optional(v.number()),
        projectedAverage: v.optional(v.number()),
        // Preferred nested structure
        actual: v.optional(v.object({
          appliedTotal: v.optional(v.number()),
          appliedAverage: v.optional(v.number()),
        })),
        projected: v.optional(v.object({
          appliedTotal: v.optional(v.number()),
          appliedAverage: v.optional(v.number()),
        })),
      })),
    })),
    seasonId: v.number(),
    divisionId: v.optional(v.number()),
    // FAAB accounting straight from ESPN's `view=mTeam` team objects (spec:
    // the waiver wire report needs winning/losing bids AND remaining
    // budgets - `acquisitionBudgetSpent` is this team's season-to-date FAAB
    // spend; `matchupAcquisitionTotals` is acquisitions per matchup period).
    // Verified against tests/fixtures/espn-teams-public-2025.json, which
    // passes `team.transactionCounter` straight through here - the object
    // validator is strict, so every field ESPN actually sends must be
    // listed or a real sync throws on the very first team.
    transactionCounter: v.optional(v.object({
      acquisitionBudgetSpent: v.optional(v.number()),
      acquisitions: v.optional(v.number()),
      drops: v.optional(v.number()),
      trades: v.optional(v.number()),
      moveToActive: v.optional(v.number()),
      moveToIR: v.optional(v.number()),
      matchupAcquisitionTotals: v.optional(v.record(v.string(), v.number())),
      paid: v.optional(v.number()),
      teamCharges: v.optional(v.number()),
      misc: v.optional(v.number()),
    })),
    waiverRank: v.optional(v.number()),
    isActive: v.optional(v.boolean()), // Used to mark teams as inactive instead of deleting
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_season", ["leagueId", "seasonId"])
    .index("by_league_owner", ["leagueId", "owner"])
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
    // Store full ESPN settings blob for the season (the exact shape of
    // `leagueData.settings` from ESPN's `view=mSettings` response). Already
    // `v.any()`, so no schema change was needed to store it - but it's worth
    // noting here that `convex/lib/espnSettings.ts`'s `parseEspnLeagueSettings`
    // is the one place that blob gets turned into a typed
    // `ParsedLeagueSettings`, and `leagues.mirrorSeasonSettings` mirrors a
    // subset of that parsed result onto `leagues.settings` after each sync.
    settings: v.any(),
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
    // Store concise draft status info (e.g., { drafted: true, inProgress: false, completeDate: ... })
    draftInfo: v.optional(v.any()),
    draftSettings: v.optional(v.any()), // Store ESPN's draftSettings object
    // The scheduled draft instant (resolveScheduledDraftDate(...).scheduledAt)
    // that the post-draft follow-up syncs (scheduledAt + 3h/8h/24h, scheduled
    // from updateLeagueSeason) were created for. Lets a re-sync tell "already
    // scheduled for this draft date" apart from "the draft date changed,
    // schedule again" without re-reading the scheduler's queue.
    postDraftSyncScheduledFor: v.optional(v.number()),
    // Per-season sync bookkeeping (ESPN refresh audit, Sept 2026): a season is complete because
    // we recorded that we closed it out, not because the calendar moved on.
    /** Last time this season was pulled in full (every period, transactions, draft, teams). */
    lastFullSyncAt: v.optional(v.number()),
    /** Matchup periods whose final results, lineups and transaction log have been re-pulled after the week ended. */
    periodsFinal: v.optional(v.array(v.number())),
    /** Set once the season-closed pull ran and the champion was derived from the bracket. */
    finalizedAt: v.optional(v.number()),
    finalizedSource: v.optional(v.literal("bracket")),
    /** The one follow-up pull for stat corrections, scheduled a week after finalization. */
    finalizationRecheckAt: v.optional(v.number()),
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
    summary: v.optional(v.string()), // AI-generated or commissioner-edited excerpt
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
    commentRequestConfig: v.optional(v.object({
      enabled: v.boolean(),
      articleGenerationTime: v.number(), // Unix timestamp of when to generate the article
      targetUserIds: v.array(v.string()),
      requestedAt: v.number(),
      // Everything `checkAndGenerate` needs to run the deadline early, so
      // `aiContentWithComments.goToPrintNow` can reschedule it without the
      // caller re-supplying arguments it must not be trusted for (spec §8.2).
      // `userId` is the requester's Clerk subject and is also the non-commissioner
      // half of goToPrintNow's authorization check.
      userId: v.optional(v.string()),
      customContext: v.optional(v.string()),
      seasonId: v.optional(v.number()),
      week: v.optional(v.number()),
      creditsDeductedUpFront: v.optional(v.number()),
    })),

    // --- Broadcast Desk: grounding + verification (spec §4.2, §4.5) ---
    // Deterministic verifier findings surfaced in edit-before-publish. Any
    // "block" or "strip" finding suppresses auto-publish.
    reviewFlags: v.optional(v.array(reviewFlagValidator)),
    // Dotted FACTS paths the generator asked for and did not have.
    factsMissing: v.optional(v.array(v.string())),
    // Verifier + model bookkeeping for this generation run, plus the money
    // (spec §10.3.4): what this article actually cost us to produce, which
    // route produced it, and who paid - the League Pass or the requester's
    // credits. All three are optional: articles written before the cost
    // accounting shipped are still in the table.
    generationStats: v.optional(
      generationStatsValidator.extend({
        costUsd: v.optional(v.number()),
        route: v.optional(v.object({ model: v.string(), effort: v.string() })),
        billing: v.optional(v.union(v.literal("pass"), v.literal("credits"))),
        // The editor pass's verdict (spec §11.2.7). Persisted so the publish
        // gate's decision can be re-read - and re-explained to the
        // commissioner - long after the generation action has gone.
        editor: v.optional(editorReviewValidator),
      })
    ),
    // Verified ledger quotes actually used, with the writer's in-voice reply.
    quotes: v.optional(v.array(articleQuoteValidator)),
    // Structured roast/praise, consumed by relationships.recordArticleMentions.
    managerMentions: v.optional(v.array(managerMentionValidator)),
    // Explicit on-the-record predictions this writer made (spec §8.4). Written
    // with outcome "open"; claims.resolveOpenClaims settles them weekly.
    claims: v.optional(v.array(articleClaimValidator)),
    // The structured "Disputed" episode transcript (spec: Disputed), when this row is a
    // desk_show. `content` still holds the plain rendering; this is the turn-by-turn structure
    // behind it, produced by src/lib/ai/disputed's producer rather than the article pipeline.
    transcript: v.optional(showTranscriptValidator),
    // The NFL season this article belongs to, stamped at generation time from
    // the league's synced season. Backs the per-season spend roll-up
    // (`deskMetrics.getLeagueSeasonSpend`) without scanning the whole league.
    seasonId: v.optional(v.number()),
  })
    .index("by_league", ["leagueId"])
    .index("by_status", ["status"])
    .index("by_league_published", ["leagueId", "publishedAt"])
    // Receipts: one writer's back catalogue in one league (spec §8.4).
    .index("by_league_persona", ["leagueId", "persona"])
    // Season spend roll-up (spec §10.1 cap, §10.3.4 accounting).
    .index("by_league_season", ["leagueId", "seasonId"]),

  // Reader reactions on published (or league-visible) articles. One reaction
  // per user per article — see articleEngagement.toggleReaction.
  articleReactions: defineTable({
    articleId: v.id("aiContent"),
    userId: v.string(), // Auth subject (Clerk user id), same convention as leagueMemberships.userId
    reaction: v.union(
      v.literal("fire"),
      v.literal("lol"),
      v.literal("salty"),
      v.literal("respect")
    ),
    createdAt: v.number(),
  })
    .index("by_article", ["articleId"])
    .index("by_article_user", ["articleId", "userId"]),

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
    credits: v.number(), // User's credit balance
    createdAt: v.number(),
    // Set by convex/claimRollover.ts when this claim was carried forward from
    // a prior season's claim on the matching ESPN team (same `externalId`)
    // rather than created by the manager claiming their team directly.
    // Optional so every pre-existing claim (and every claim inserted by
    // teamClaims.claimTeam) is still valid without either field.
    source: v.optional(v.literal("rollover")),
    rolledOverFromClaimId: v.optional(v.id("teamClaims")),
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
    // Denormalized fields for fast querying
    position: v.optional(v.string()),
    actualAppliedTotal: v.optional(v.number()),
    actualAppliedAverage: v.optional(v.number()),
    
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
    .index("by_league_season", ["leagueId", "season"])
    .index("by_player", ["espnId"]) 
    .index("by_league_season_total", ["leagueId", "season", "actualAppliedTotal"]) 
    .index("by_league_season_position_total", ["leagueId", "season", "position", "actualAppliedTotal"]),

  // Cached top performers per league/season to avoid heavy reads at query time
  leagueTopPerformers: defineTable({
    leagueId: v.id("leagues"),
    season: v.number(),
    // positions -> array of top players with minimal fields needed for UI
    positions: v.record(
      v.string(),
      v.array(
        v.object({
          espnId: v.string(),
          fullName: v.string(),
          defaultPosition: v.string(),
          proTeamAbbrev: v.optional(v.string()),
          ownerTeamName: v.optional(v.string()),
          appliedTotal: v.number(),
          appliedAverage: v.optional(v.number()),
        })
      )
    ),
    generatedAt: v.number(),
  })
    .index("by_league_season", ["leagueId", "season"]),

  // Trade transactions
  trades: defineTable({
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    tradeDate: v.number(),
    /** ESPN transaction id of the TRADE_ACCEPT row this trade was derived from (dedupe key). */
    espnTransactionId: v.optional(v.string()),
    /** Scoring period the trade executed in (from the TRADE_ACCEPT row); scopes it to a week. */
    week: v.optional(v.number()),
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
    .index("by_status", ["status"])
    .index("by_espn_transaction", ["espnTransactionId"]),

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
    status: v.string(),
    scoringPeriod: v.number(),
    teamId: v.number(), // Primary team involved

    // FAAB waiver-wire report fields (spec: account for winning/losing bids
    // and remaining budgets). `outcome`/`failureReason` are the normalized
    // read of `status`+`isPending` (see `convex/lib/espnTransactions.ts`'s
    // `classifyTransactionStatus`) - kept alongside the raw ESPN `status`
    // rather than replacing it. `source` distinguishes a row synced from
    // the ESPN transaction log (`view=mTransactions2`, complete but only
    // available per-scoring-period) from the older per-player-payload feed
    // (`syncPlayerTransactions`, which misses most of the log - production
    // had none before December 2025).
    processDate: v.optional(v.number()),
    outcome: v.optional(v.union(
      v.literal("executed"),
      v.literal("failed"),
      v.literal("pending"),
      v.literal("cancelled")
    )),
    failureReason: v.optional(v.string()),
    source: v.optional(v.union(v.literal("player_feed"), v.literal("transaction_log"))),
    rating: v.optional(v.number()),
    relatedTransactionId: v.optional(v.string()),

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
      v.literal("bank_statement"),
      v.literal("mock_draft"),
      v.literal("draft_rankings"),
      v.literal("rivalry_week_special"),
      v.literal("emergency_hot_takes"),
      v.literal("mid_season_awards"),
      v.literal("championship_manifesto"),
      v.literal("season_recap"),
      v.literal("custom_roast"),
      v.literal("season_welcome"),
      // Added with the automatic-by-default calendar (spec section 9.1): these
      // three ship as part of the default roster of schedules (playoff_picture
      // enabled for weeks 12-14, the other two created disabled).
      v.literal("playoff_picture"),
      v.literal("hall_of_shame"),
      v.literal("commissioner_corner")
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
        // "season_start", "champion_determined", "championship_week",
        // "week_<n>", or "weeks_<from>_<to>" for a repeating in-range slot.
        trigger: v.string(),
        delayDays: v.optional(v.number()),
        hour: v.number(),
        minute: v.number(),
        // When set, the target is moved forward to this weekday (0=Sunday)
        // inside the triggered NFL week, so "week 9, Wednesday 09:00" is exact
        // regardless of where the week boundary starts.
        dayOfWeek: v.optional(v.number()),
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
      // Handed to the Anthropic Message Batches API ahead of print time
      // (spec §10.3.5). `aiBatch.pollBatches` moves it on to `completed`;
      // `processScheduledContentCron` falls back to direct generation if the
      // batch is still processing when print time arrives.
      v.literal("batched"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      // Held because the league's ESPN cookies are rejected: not retried, no
      // credits or spend, resumed in order by `contentScheduling.resumeBacklog`
      // once the commissioner fixes the connection.
      v.literal("backlogged")
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
      // The raw payload of the event that produced this row (trade sides, draft
      // info). triggerEventBasedContent has always written it; it was missing
      // from the validator, so an event row failed insert validation.
      eventData: v.optional(v.any()),
      tradeId: v.optional(v.id("trades")),
      additionalContext: v.optional(v.any()),
    })),
    
    // Target period, stamped at execution time by processScheduledContent so
    // the idempotency index below reflects the week the article is actually
    // about (contextData keeps the same values for the generation payload).
    seasonId: v.optional(v.number()),
    week: v.optional(v.number()),

    // Why a row was cancelled ("low_credits", "disabled", "budget", ...).
    cancelReason: v.optional(v.string()),
    // Backlog bookkeeping ("espn_credentials_invalid").
    backlogReason: v.optional(v.string()),
    backloggedAt: v.optional(v.number()),
    resumedAt: v.optional(v.number()),
    // Resumed rows that are days old generate without opening interviews.
    skipCommentRequests: v.optional(v.boolean()),
    // Season backfill rows (convex/seasonBackfill.ts): written about a past
    // period on purpose, run by the backfill chain only. The cron, the stuck-row
    // sweeper and the retry loop leave them alone, they open no interviews, and
    // their article publishes quietly, backdated to `scheduledFor`.
    backfill: v.optional(v.boolean()),
    // How many times execution was deferred for stale/absent league data.
    deferrals: v.optional(v.number()),
    // Dedupe key for event-triggered rows (trade id, draft id, ...).
    eventKey: v.optional(v.string()),

    // --- Batch API bookkeeping (spec §10.3.5) ----------------------------
    // The Anthropic Message Batch this row's article was submitted in, and the
    // custom id of its request inside that batch. `batchSubmittedAt` is set as
    // soon as a submission is scheduled (so the lookahead pass never queues two
    // for the same row) and re-stamped by `aiBatch` when the batch is accepted.
    batchId: v.optional(v.string()),
    batchCustomId: v.optional(v.string()),
    batchSubmittedAt: v.optional(v.number()),

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
    .index("by_schedule_config", ["contentScheduleId"])
    // Idempotency (spec section 9.2.6): one row per league/type/season/week.
    .index("by_league_type_season_week", ["leagueId", "contentType", "seasonId", "week"])
    // Event fan-out dedupe (spec section 9.2.9).
    .index("by_league_type_event", ["leagueId", "contentType", "eventKey"]),

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
    // Deprecated (owner ask, Sept 2026): no longer written; kept so old rows still validate.
    contentStyle: v.optional(v.union(
      v.literal("professional"),
      v.literal("casual"),
      v.literal("humorous"),
      v.literal("analytical")
    )),
    // League-level language rating (owner ask, Sept 2026): how far the desk's writers can go.
    // Absent means "clean".
    languageRating: v.optional(languageRatingValidator),

    // Auto-publish settings
    autoPublish: v.boolean(), // Automatically publish generated content
    requireApproval: v.boolean(), // Require commissioner approval before publishing

    // Set the first time a commissioner edits these preferences. Absent means
    // "never touched", which is what the automatic-defaults migration keys on
    // (spec section 9.1) so a commissioner's own choices are never overwritten.
    preferencesTouchedAt: v.optional(v.number()),

    // The Wire (ffsn-the-wire-spec.md §11 kill switches): commissioner toggle on the settings
    // page. Absent means on - most leagues never touch this.
    wireEnabled: v.optional(v.boolean()),

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
    // Broadcast Desk (spec §5): sam-ortega conducts every interview; the
    // writer whose article the quotes are destined for.
    interviewerPersona: v.optional(v.string()),
    writerPersona: v.optional(v.string()),
    scheduledContentId: v.optional(v.id("scheduledContent")), // The article this comment is for (optional for manual content)
    manualContentId: v.optional(v.id("aiContent")), // For manually generated content with comments
    targetUserId: v.id("users"), // User being asked for comment
    
    // Request context
    contentType: v.string(), // "weekly_recap", etc. (copied from scheduledContent)
    articleContext: v.object({
      week: v.optional(v.number()),
      seasonId: v.optional(v.number()),
      topic: v.optional(v.string()), // "Your team's performance", "Trade impact", etc.
      focusAreas: v.optional(v.array(v.string())), // Specific topics to comment on
      // Draft-related context for draft analysis content
      draftType: v.optional(v.string()),
      draftOrder: v.optional(v.array(v.any())),
      userDraftPicks: v.optional(v.any()), // Map of userId to their draft picks
      // Weekly recap-related context
      userTeamInfo: v.optional(v.any()), // User's specific team information for weekly recaps
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
    scheduledSendTime: v.number(),    // When to send the request (immediately or scheduled)
    articleGenerationTime: v.number(), // When the article will be generated (user-specified deadline)
    
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
    declinedAt: v.optional(v.number()), // Set by declineCommentRequest ("No comment")
    // Measured API cost of this interview (opener + analysis + follow-up),
    // accumulated by `aiContent.addInterviewCost` (spec §10.3.4). Counts
    // against the league's per-season automated spend cap.
    interviewCostUsd: v.optional(v.number()),
  })
    .index("by_scheduled_content", ["scheduledContentId"])
    .index("by_manual_content", ["manualContentId"])
    .index("by_user", ["targetUserId"])
    .index("by_league", ["leagueId"])
    .index("by_status", ["status"])
    .index("by_send_time", ["scheduledSendTime"]) // For cron jobs to pick up
    .index("by_generation_time", ["articleGenerationTime"]) // For scheduling article generation
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
      // Sam's sign-off asking the manager to approve the quotes we plan to
      // print. The chat UI renders commentResponses.quoteReview under it (spec §8.1).
      v.literal("quote_approval"),
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
      // Verbatim spans of this message that may be quoted. processCompletedResponse
      // builds extractedQuotes from these only (spec §5).
      quotableSegments: v.optional(v.array(v.string())),
      // How the manager talked about each writer named in context; each entry
      // records an interview_jab / interview_praise relationship event (spec §6).
      writerSentiment: v.optional(v.array(writerSentimentValidator)),
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
    scheduledContentId: v.union(v.id("scheduledContent"), v.null()), // For scheduled article integration
    manualContentId: v.optional(v.id("aiContent")), // For manually generated content with comments
    
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
    
    // Quotes the manager approved for print, verbatim (spec §4.2 CommentResponseData.quotes)
    approvedQuotes: v.optional(v.array(v.string())),

    // Quote approval (spec §8.1). Seeded pending from the verified extracted
    // quotes when the response row is created; the manager approves, edits or
    // withdraws each one, and whatever is still pending at the deadline is
    // auto-approved. This is the source of truth for what the writer may print.
    quoteReview: v.optional(v.array(quoteReviewEntryValidator)),

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
    .index("by_manual_content", ["manualContentId"])
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

  // Stripe payment tracking - all Stripe transactions
  stripePayments: defineTable({
    // Stripe identifiers
    // Absent for a checkout session paid entirely with a promotion code -
    // Stripe creates no PaymentIntent for a $0 session. `checkoutSessionId`
    // is the key fulfillment uses.
    paymentIntentId: v.optional(v.string()),
    checkoutSessionId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    
    // Payment details
    amount: v.number(), // Amount in cents
    currency: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("refunded")
    ),
    
    // User and league context
    userId: v.string(), // Clerk user ID
    leagueId: v.optional(v.id("leagues")),
    paymentType: v.union(
      v.literal("league_creation"),
      v.literal("credits_purchase")
    ),
    
    // Metadata
    description: v.string(),
    metadata: v.optional(v.object({
      seasonYear: v.optional(v.number()),
      creditsPurchased: v.optional(v.number()),
      isCommissionerPayment: v.optional(v.boolean()),
      appliedCouponId: v.optional(v.string()),
      appliedPromotionCodeId: v.optional(v.string()),
      discountAmount: v.optional(v.number()),
    })),
    
    // Webhook tracking
    webhookProcessed: v.boolean(),
    webhookProcessedAt: v.optional(v.number()),
    
    // Timing
    createdAt: v.number(),
    updatedAt: v.number(),
    paidAt: v.optional(v.number()),
  })
    .index("by_payment_intent", ["paymentIntentId"])
    .index("by_checkout_session", ["checkoutSessionId"])
    .index("by_user", ["userId"])
    .index("by_league", ["leagueId"])
    .index("by_status", ["status"])
    .index("by_payment_type", ["paymentType"])
    .index("by_webhook_status", ["webhookProcessed"]),

  // Credit transactions - audit trail for all credit movements
  creditTransactions: defineTable({
    // User context
    userId: v.string(), // Clerk user ID
    leagueId: v.optional(v.id("leagues")),
    
    // Transaction details
    type: v.union(
      v.literal("earned"), // Initial credits, join bonus
      v.literal("spent"), // AI content generation
      v.literal("purchased"), // Credit purchase
      v.literal("refunded"), // Credit refund
      v.literal("bonus"), // Special bonuses
      v.literal("expired") // Season end swept the unspent balance (spec §10.1)
    ),
    amount: v.number(), // Credits (positive for earned, negative for spent)
    
    // Context
    description: v.string(),
    // Machine-readable grant reason, e.g. "league_pass" / "seat" / "top_up".
    // This - not the human `description` - is what the idempotent grants in
    // `credits.ts` dedupe on, via by_league_user_reason below (spec §10.1).
    reason: v.optional(v.string()),
    // When the credits this row granted stop being spendable. Mirrors
    // `userCredits.creditsExpireAt`; kept per-row so the ledger explains a
    // sweep after the fact.
    expiresAt: v.optional(v.number()),
    relatedPaymentId: v.optional(v.id("stripePayments")),
    relatedContentId: v.optional(v.id("aiContent")), // If spent on AI content
    
    // Balance tracking
    balanceAfter: v.number(), // User's balance after this transaction
    
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_league", ["leagueId"])
    .index("by_type", ["type"])
    .index("by_payment", ["relatedPaymentId"])
    .index("by_user_type", ["userId", "type"])
    // Idempotency for the League Pass grants: one row per (league, user, reason).
    .index("by_league_user_reason", ["leagueId", "userId", "reason"])
    .index("by_created_at", ["createdAt"]),

  // League payment tracking - season-based payment records
  leaguePayments: defineTable({
    leagueId: v.id("leagues"),
    stripePaymentId: v.id("stripePayments"),
    
    // Season context
    seasonYear: v.number(), // e.g., 2025
    
    // Payment details
    amount: v.number(), // Amount in cents ($99.99 = 9999)
    currency: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("refunded")
    ),
    
    // Commissioner who paid
    paidByUserId: v.string(), // Clerk user ID
    
    // Timing
    paidAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_season", ["seasonYear"])
    .index("by_league_season", ["leagueId", "seasonYear"])
    .index("by_payment", ["stripePaymentId"])
    .index("by_commissioner", ["paidByUserId"]),

  // User credit balances - centralized credit tracking per user
  userCredits: defineTable({
    userId: v.string(), // Clerk user ID
    
    // Current balance
    balance: v.number(), // Current credit balance
    
    // Lifetime stats
    totalEarned: v.number(),
    totalSpent: v.number(),
    totalPurchased: v.number(),
    
    // Last transaction reference for validation
    lastTransactionId: v.optional(v.id("creditTransactions")),

    // Credits do not roll over between seasons (spec §10.1). This is the
    // instant the current balance stops being spendable - February 15 UTC
    // after the pass season ends. `credits.expireSeasonCredits` sweeps rows
    // whose expiry has passed; absent means "no expiry set yet".
    creditsExpireAt: v.optional(v.number()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    // The weekly expiry sweep scans by expiry, not by user.
    .index("by_expiry", ["creditsExpireAt"]),

  // Email queue and logs for tracking sent emails and debugging
  emailLogs: defineTable({
    userId: v.union(v.id("users"), v.literal("system")), // Support system emails
    email: v.string(),
    templateType: v.string(), // "comment_request", "reminder", etc.
    templateId: v.string(), // SendGrid template ID
    messageId: v.string(), // SendGrid message ID or "queued"
    status: v.union(
      v.literal("queued"), 
      v.literal("sent"), 
      v.literal("error"), 
      v.literal("bounced"), 
      v.literal("delivered")
    ),
    error: v.optional(v.string()),
    relatedEntityType: v.optional(v.string()),
    relatedEntityId: v.optional(v.string()), // Also used to store template data temporarily
    sentAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"])
    .index("by_template_type", ["templateType"])
    .index("by_sent_date", ["sentAt"])
    .index("by_related_entity", ["relatedEntityType", "relatedEntityId"]),

  // Stripe webhook event idempotency ledger - one row per Stripe event ID so
  // retried deliveries can be detected and short-circuited before dispatch.
  stripeWebhookEvents: defineTable({
    eventId: v.string(), // Stripe event.id (evt_...)
    type: v.string(), // Stripe event.type, e.g. "checkout.session.completed"
    receivedAt: v.number(),
    status: v.union(
      v.literal("processing"),
      v.literal("processed"),
      v.literal("failed")
    ),
    error: v.optional(v.string()),
  })
    .index("by_event_id", ["eventId"]),

  // --- Broadcast Desk relationship meter (spec §6.1) ---

  // Running score between one manager (users row) and one writer persona,
  // scoped to a league. No row exists until the first event; a missing row
  // reads as { score: 0, tier: "neutral" }.
  writerRelationships: defineTable({
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    teamId: v.optional(v.id("teams")),
    persona: v.string(),
    score: v.number(), // clamped to [-100, 100]
    tier: relationshipTierValidator,
    eventCount: v.number(),
    lastEventAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_league_user", ["leagueId", "userId"])
    .index("by_league_persona", ["leagueId", "persona"])
    .index("by_league_user_persona", ["leagueId", "userId", "persona"]),

  // Append-only ledger of everything that moved a relationship score, with one
  // exception: `type: "reaction"` rows mirror the reader's CURRENT reaction on an
  // article (relationships.syncReactionEvent reconciles - deletes and re-inserts -
  // so switching or removing a reaction never leaves a stale row behind).
  relationshipEvents: defineTable({
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    persona: v.string(),
    type: relationshipEventTypeValidator,
    delta: v.number(),
    articleId: v.optional(v.id("aiContent")),
    commentRequestId: v.optional(v.id("commentRequests")),
    week: v.optional(v.number()),
    evidence: v.string(), // <= 280 chars: the sentence or quote that caused it
    createdAt: v.number(),
    // The Wire (spec §17): set on a "reaction" event synced from a wire post reaction, or a
    // "wire_jab"/"wire_praise" event recorded from a writer-reply's read of a manager's post - the
    // key `syncWireReaction` reconciles against, same convention as `articleId` for article reactions.
    wirePostKey: v.optional(v.string()),
  })
    .index("by_league_user_persona", ["leagueId", "userId", "persona"])
    .index("by_article", ["articleId"])
    .index("by_league", ["leagueId"]),

  // --- Operator alerting (spec §11.3.10) --------------------------------
  //
  // One row per operator notice actually claimed, keyed on what the notice is
  // about ("held:<articleId>", "failed:<articleId>", "digest:<yyyy-mm-dd>").
  // The insert IS the dedupe: `deskMetrics.claimOperatorNotice` refuses to
  // write a key that already exists, so an article that is finalized twice, or
  // a failure that is retried, still costs the operator exactly one email.
  operatorNotices: defineTable({
    key: v.string(),
    kind: v.string(), // "held" | "failed" | "digest"
    leagueId: v.optional(v.id("leagues")),
    articleId: v.optional(v.id("aiContent")),
    subject: v.string(),
    sentAt: v.number(),
    /** False when ADMIN_ALERT_EMAIL is unset or SendGrid refused it. */
    delivered: v.boolean(),
  })
    .index("by_key", ["key"])
    .index("by_kind_sent", ["kind", "sentAt"]),

  // --- Player intelligence layer (Sept 2026) --------------------------
  //
  // Fresh, cited color for AI sportswriters: injuries, practice status,
  // depth chart, and market data (ADP/trending) sourced from Sleeper,
  // nflverse, and the Fantasy Football Calculator, keyed to the same
  // ESPN athlete id as `playersEnhanced.espnId`. See `convex/intelSync.ts`
  // for the sync actions that populate this table and `convex/intel.ts` /
  // `convex/lib/intelFreshness.ts` for how it is read back with a
  // freshness policy applied (stale feeds are dropped, not shown as current).
  //
  // One row per (espnId, season, source, kind) - UPSERT, never append -
  // except `kind: "market"`, where the `market` field ("ppr-10", "ppr-12",
  // half-ppr/standard x 10/12) is an additional part of the identity: FFC
  // publishes six ADP boards per season and each is worth keeping.
  playerIntel: defineTable({
    espnId: v.string(),
    season: v.number(),
    source: v.union(v.literal("sleeper"), v.literal("nflverse"), v.literal("ffc")),
    kind: v.union(
      v.literal("injury"),
      v.literal("practice"),
      v.literal("depth_chart"),
      v.literal("market"),
      v.literal("trending"),
    ),
    fetchedAt: v.number(),
    // When the source itself says the value changed (Sleeper `news_updated` /
    // `injury_start_date`, nflverse `date_modified`) - not always available.
    observedAt: v.optional(v.number()),
    team: v.optional(v.string()),
    position: v.optional(v.string()),

    // kind: "injury"
    injuryStatus: v.optional(v.string()),
    injuryBodyPart: v.optional(v.string()),
    injuryNotes: v.optional(v.string()),
    // Previous value + when it changed, tracked only on the injury row, so
    // "questionable since Wednesday" (etc.) can be stated instead of just
    // the current snapshot.
    previousInjuryStatus: v.optional(v.string()),
    statusChangedAt: v.optional(v.number()),

    // kind: "practice"
    practiceStatus: v.optional(v.string()),
    practiceDescription: v.optional(v.string()),

    // kind: "depth_chart"
    depthPosition: v.optional(v.string()),
    depthOrder: v.optional(v.number()),

    // kind: "market" (source: "ffc")
    adp: v.optional(v.number()),
    adpPositionRank: v.optional(v.number()),
    timesDrafted: v.optional(v.number()),
    bye: v.optional(v.number()),
    // Format + league size this ADP board came from, e.g. "ppr-10" - part of
    // this row's identity (see table comment above), not just metadata.
    market: v.optional(v.string()),

    // kind: "trending" (source: "sleeper")
    trendingAdds: v.optional(v.number()),
  })
    .index("by_player_season", ["espnId", "season"])
    .index("by_season_kind", ["season", "kind"])
    .index("by_fetched", ["fetchedAt"]),

  // Cross-reference from ESPN's athlete id (this codebase's primary player
  // key) to the id space each intel source uses instead: Sleeper's players/nfl
  // feed carries `espn_id`, nflverse's players.csv carries both `espn_id` and
  // `gsis_id`. Built and kept current by `convex/intelSync.ts`.
  // One row per intel sync run (convex/intelSync.ts `runIntelSync`), so "are the feeds
  // current?" is a stored fact the operator digest reads, not something re-derived from
  // playerIntel.fetchedAt across thousands of rows.
  intelSyncRuns: defineTable({
    source: v.union(
      v.literal("sleeper_players"),
      v.literal("sleeper_trending"),
      v.literal("nflverse_injuries"),
      v.literal("ffc_adp"),
    ),
    ranAt: v.number(),
    ok: v.boolean(),
    summary: v.string(),
    error: v.optional(v.string()),
  }).index("by_source_ranAt", ["source", "ranAt"]),

  playerIdMap: defineTable({
    espnId: v.string(),
    sleeperId: v.optional(v.string()),
    gsisId: v.optional(v.string()),
    fullName: v.string(),
    position: v.optional(v.string()),
    team: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_espn", ["espnId"])
    .index("by_sleeper", ["sleeperId"])
    .index("by_gsis", ["gsisId"]),

  /* ------------------------------------------------------------------------ *
   * The Wire (ffsn-the-wire-spec.md §4). A live, league-scoped feed of short
   * posts reacting to NFL injuries, news, transactions and league events.
   * `wireEvents` is the global, deduped fact log (one row per real-world
   * event); `wirePosts` is the global tier-1 take/card; `wireLeaguePosts` is
   * the per-league tier-2 overlay + tier-3 routine post; `wireSourceState` is
   * the cursor + health row every poller keeps (mirrors `intelSyncRuns`, with
   * a cursor). The fact card itself (`facts`) is validated by
   * `src/lib/ai/wire/card.ts#validateFactCard`, not by this schema - it is
   * `v.any()` here for the same reason `playerIntel`-adjacent blobs are: the
   * card's shape is the pure prompt layer's contract, not the database's.
   * ------------------------------------------------------------------------ */
  wireEvents: defineTable({
    kind: v.string(), // GlobalEventKind (src/lib/ai/wire/types.ts) - see that file for the full P1/P2 list
    dedupeKey: v.string(), // e.g. "injury_status:3116389:Out"
    observedAt: v.number(), // the source's own timestamp when it has one
    detectedAt: v.number(),
    players: v.array(
      v.object({
        espnId: v.string(),
        name: v.string(),
        position: v.optional(v.string()),
        nflTeam: v.optional(v.string()),
        percentOwned: v.optional(v.number()),
        adpPositionRank: v.optional(v.number()),
      })
    ),
    nflTeam: v.optional(v.string()),
    facts: v.any(), // WireFactCard - validated by src/lib/ai/wire/card.ts#validateFactCard
    interest: v.number(), // 0-100, spec §7
    source: v.object({
      type: v.string(), // WireSourceType (src/lib/ai/wire/types.ts)
      id: v.optional(v.string()),
      url: v.optional(v.string()),
      fetchedAt: v.number(),
    }),
    // Set when a later event for the same player coalesces into an earlier
    // one's post instead of creating a new one (spec §6 "Coalesce").
    coalescedInto: v.optional(v.id("wireEvents")),
    // The first card player's espnId, copied out of `players` so the per-player lookups
    // (same-player penalty, coalesce target) are an indexed range instead of a window scan -
    // the first dev poll read past Convex's 16 MB limit doing 100 such scans (2026-09-05).
    primaryEspnId: v.optional(v.string()),
  })
    .index("by_dedupe", ["dedupeKey"])
    .index("by_detected", ["detectedAt"])
    .index("by_kind_detected", ["kind", "detectedAt"])
    .index("by_player_detected", ["primaryEspnId", "detectedAt"]),

  wirePosts: defineTable({
    // Global tier (spec §3.1): one post per event, patched in place when a
    // pending take lands or a later event coalesces into this one.
    eventId: v.id("wireEvents"),
    kind: v.string(), // GlobalEventKind - carried here too so readers/digest never re-join wireEvents just for it
    persona: v.string(), // WirePersona
    text: v.string(), // the global take, or the plain card rendering while a take is pending/failed
    tags: v.array(v.string()), // WireTag[]
    variants: v.optional(
      v.object({
        owner: v.optional(v.string()),
        opponent: v.optional(v.string()),
        freeAgent: v.optional(v.string()),
      })
    ),
    status: v.union(v.literal("card"), v.literal("take_pending"), v.literal("take"), v.literal("held")),
    interest: v.number(),
    generationStats: v.optional(
      v.object({
        costUsd: v.number(),
        model: v.string(),
        effort: v.string(),
        batchId: v.optional(v.string()),
        flags: v.array(v.string()),
      })
    ),
    // Denormalized reaction tally (spec §17), patched by wire.react - the same "count on the post,
    // never .collect() the reactions table" pattern as articleReactions would use if it kept one.
    reactionCounts: v.optional(
      v.object({ fire: v.number(), lol: v.number(), salty: v.number(), respect: v.number() })
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_event", ["eventId"])
    .index("by_status_created", ["status", "createdAt"]),

  wireLeaguePosts: defineTable({
    // League tier (spec §3.2/§3.3): overlays (globalPostId set) and routine
    // posts (globalPostId absent), both filled with no model call. Also the social layer (spec §17):
    // a manager_post/manager_reply has an author instead of a persona, and a writer_reply answers one.
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    week: v.optional(v.number()),
    kind: v.string(), // WireEventKind
    // Absent on a manager post/reply - see `authorUserId` below instead.
    persona: v.optional(v.string()),
    text: v.string(),
    tags: v.array(v.string()),
    globalPostId: v.optional(v.id("wirePosts")), // set for overlays; the UI nests this under the global post
    impact: v.optional(
      v.object({
        teamId: v.id("teams"),
        variant: v.string(), // OverlayVariant ("owner" | "opponent" | "freeAgent")
        slots: v.record(v.string(), v.string()),
      })
    ),
    featuredTeams: v.array(v.id("teams")),
    dedupeKey: v.string(),
    generationStats: v.optional(
      v.object({ costUsd: v.number(), model: v.string(), effort: v.string() })
    ),
    // Social layer (spec §17). A manager_post/manager_reply carries the author instead of a
    // persona; `replyTo` is what it answers (a global writer post or a league post); `rootScope`/
    // `rootId` is the THREAD ROOT - a reply to a reply still points at the original root so the
    // whole thread can be fetched with one `by_root` range instead of walking `replyTo` chains.
    authorUserId: v.optional(v.string()), // Clerk subject
    authorTeamId: v.optional(v.id("teams")),
    replyTo: v.optional(
      v.object({ scope: v.union(v.literal("global"), v.literal("league")), id: v.string() })
    ),
    rootScope: v.optional(v.union(v.literal("global"), v.literal("league"))),
    rootId: v.optional(v.string()),
    // Soft delete (author or commissioner): replies and reactions on the post stay, the UI shows a
    // placeholder in their place.
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.union(v.literal("author"), v.literal("commissioner"))),
    // How the WRITER read the manager's text, set by the writer-reply call on a manager_post/
    // manager_reply (never on the writer_reply itself) - drives the relationship move (spec §17.3).
    sentiment: v.optional(v.union(v.literal("jab"), v.literal("thanks"), v.literal("neutral"))),
    reactionCounts: v.optional(
      v.object({ fire: v.number(), lol: v.number(), salty: v.number(), respect: v.number() })
    ),
    createdAt: v.number(),
  })
    .index("by_league_created", ["leagueId", "createdAt"])
    .index("by_league_dedupe", ["leagueId", "dedupeKey"])
    .index("by_global_post", ["globalPostId"])
    .index("by_global_post_league", ["globalPostId", "leagueId"])
    // Every reply on one target (global or league post id), oldest first (spec §17: getGlobalPosts/
    // getLeaguePosts thread the replies onto their target).
    .index("by_league_reply", ["leagueId", "replyTo.id", "createdAt"])
    // One manager's own posts in a league, newest first - the per-manager rate limit and
    // `getManagerStatementsForArticle`'s per-author grouping.
    .index("by_league_author_created", ["leagueId", "authorUserId", "createdAt"])
    // Every reply in one thread (never the root itself - see wireSocialData.ts's header comment),
    // oldest first. Scoped by leagueId first: a GLOBAL post's thread can have replies from many
    // different leagues, each of which must only ever see its own league's replies.
    .index("by_root", ["leagueId", "rootId", "createdAt"])
    // Season roll-up for deskMetrics.getLeagueSeasonSpend: writer_reply generation cost counts
    // toward the league's automation cap just like an article does.
    .index("by_league_season", ["leagueId", "seasonId"]),

  // Reactions on a wire post (spec §17), mirroring `articleReactions`. `postKey` is
  // `"global:<wirePosts id>"` or `"league:<wireLeaguePosts id>"` - a single string key lets one
  // table and one pair of indexes cover both post tables without a union id column.
  wireReactions: defineTable({
    postKey: v.string(),
    scope: v.union(v.literal("global"), v.literal("league")),
    leagueId: v.id("leagues"),
    userId: v.string(), // Clerk subject, same convention as articleReactions.userId
    reaction: v.union(
      v.literal("fire"),
      v.literal("lol"),
      v.literal("salty"),
      v.literal("respect")
    ),
    createdAt: v.number(),
  })
    .index("by_post_user", ["postKey", "userId"])
    .index("by_post", ["postKey"]),

  // One row per source: cursor + health, so a poll diffs instead of
  // re-reading and a broken source shows up in the operator digest (spec §11).
  wireSourceState: defineTable({
    source: v.string(), // "espn_injuries" | "espn_news" | ...
    cursor: v.optional(v.any()),
    lastRunAt: v.number(),
    ok: v.boolean(),
    summary: v.string(),
    error: v.optional(v.string()),
  }).index("by_source", ["source"]),

});