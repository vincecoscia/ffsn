/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  mutation,
  query,
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireCommissioner, requireLeagueMember } from "./lib/auth";
import { leagueSeatAllowance } from "./credits";
import { normalizeEspnCredentials } from "./lib/espnClient";
import {
  divisionValidator,
  parsedLeagueSettingsValidator,
  pickMirroredLeagueSettings,
  waiverTypeValidator,
} from "./lib/espnSettings";

/**
 * The error a full league throws (spec §10.1). A machine-readable code rather
 * than a sentence, because the join flow catches it and renders the
 * commissioner's "buy a seat" prompt - see PRICE-D's at-capacity message.
 */
export const LEAGUE_AT_CAPACITY = "LEAGUE_AT_CAPACITY";

/** How many membership rows one capacity check reads. Leagues are small. */
const MAX_MEMBERSHIPS_SCANNED = 200;

/**
 * How many `scheduledContent` rows one backlog count reads. A league only
 * accumulates a "backlogged" row per scheduled/event piece of content that
 * would have generated while its ESPN connection was broken, so this is
 * generous headroom rather than a real limit in practice.
 */
const MAX_BACKLOG_SCANNED = 500;

/** Stories currently held for a league because its ESPN credentials are invalid. */
async function countBackloggedContent(
  ctx: QueryCtx | MutationCtx,
  leagueId: Id<"leagues">
): Promise<number> {
  const rows = await ctx.db
    .query("scheduledContent")
    .withIndex("by_league_status", (q) => q.eq("leagueId", leagueId).eq("status", "backlogged"))
    .take(MAX_BACKLOG_SCANNED);
  return rows.length;
}

/**
 * Seats used and seats left in a league.
 *
 * The League Pass covers `includedManagers` (12 by default); each $10 seat the
 * commissioner buys adds one. `managers` counts membership rows, which is what
 * every other seat-consuming path in this codebase writes.
 */
export async function leagueCapacity(
  ctx: QueryCtx | MutationCtx,
  leagueId: Id<"leagues">
): Promise<{ managers: number; included: number; extraSeats: number; remaining: number }> {
  const league = await ctx.db.get(leagueId);
  if (!league) throw new Error("League not found");

  const memberships = await ctx.db
    .query("leagueMemberships")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .take(MAX_MEMBERSHIPS_SCANNED);

  const { included, extraSeats, total } = leagueSeatAllowance(league);
  const managers = memberships.length;

  return { managers, included, extraSeats, remaining: Math.max(0, total - managers) };
}

// ESPN session credentials (espnS2/swid) are live auth cookies for the
// commissioner's ESPN account. They are needed server-side for syncing but must
// NEVER be returned to a client — strip them from any league document before it
// leaves a public query.
function redactEspnCredentials<L extends { espnData?: Record<string, unknown> | undefined }>(
  league: L
): L {
  if (!league.espnData) return league;
  const safeEspnData = { ...league.espnData };
  delete safeEspnData.espnS2;
  delete safeEspnData.swid;
  return { ...league, espnData: safeEspnData } as L;
}

export const create = mutation({
  args: {
    name: v.string(),
    platform: v.literal("espn"),
    externalId: v.string(),
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
      // Parsed fields from `convex/lib/espnSettings.ts` the setup wizard now
      // passes through from `espn.fetchLeagueData` (see `src/app/setup/page.tsx`).
      // Mirrors the new optional fields on `leagues.settings` in `schema.ts`.
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
    // Captured by the setup wizard from the commissioner's browser
    // (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Every default
    // content schedule is expressed in this zone (spec section 9.1).
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // A commissioner who abandons Checkout and comes back through the wizard
    // must land on the league they already created, not a second copy of it:
    // the pass is bought per league, and the duplicate would sit unpaid
    // forever. Same platform + ESPN id + commissioner is the same league, so
    // refresh what the wizard just fetched and hand back the existing id.
    const existing = await ctx.db
      .query("leagues")
      .withIndex("by_external_id", (q) =>
        q.eq("platform", args.platform).eq("externalId", args.externalId)
      )
      .filter((q) => q.eq(q.field("commissionerUserId"), identity.subject))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        settings: args.settings,
        ...(args.espnData
          ? {
              espnData: {
                ...existing.espnData,
                ...args.espnData,
                // Keep the stored ESPN cookies when the wizard didn't send new ones.
                espnS2: args.espnData.espnS2 ?? existing.espnData?.espnS2,
                swid: args.espnData.swid ?? existing.espnData?.swid,
              },
            }
          : {}),
        ...(args.history ? { history: args.history } : {}),
      });
      console.log(
        `leagues.create: ${identity.subject} re-imported ${args.platform}:${args.externalId}; returning existing league ${existing._id}`
      );
      return existing._id;
    }

    const leagueId = await ctx.db.insert("leagues", {
      name: args.name,
      platform: args.platform,
      externalId: args.externalId,
      commissionerUserId: identity.subject,
      settings: args.settings,
      espnData: args.espnData,
      history: args.history,
      subscription: {
        tier: "season_pass",
        status: "pending",
        creditsRemaining: 0,
        creditsMonthly: 0,
        paymentStatus: "pending" as const,
        seasonYear: new Date().getFullYear(),
      },
      lastSync: Date.now(),
      createdAt: Date.now(),
    });

    // Add commissioner as member
    await ctx.db.insert("leagueMemberships", {
      leagueId,
      userId: identity.subject,
      role: "commissioner",
      joinedAt: Date.now(),
    });

    // Set up the automatic-by-default content calendar (spec section 9.1) in
    // the timezone the commissioner imported from.
    try {
      await ctx.scheduler.runAfter(0, internal.contentScheduling.createDefaultContentSchedules, {
        leagueId,
        timezone: args.timezone && args.timezone.trim().length > 0
          ? args.timezone
          : "America/New_York",
      });
    } catch (error) {
      console.error("Failed to create default content schedules:", error);
    }

    return leagueId;
  },
});

/**
 * Mirrors a subset of one season's parsed ESPN settings onto `leagues.settings`
 * so the "current" league config every non-season-scoped reader uses (setup
 * summary, `dataProcessing.ts`'s playoff-week math, roster display) reflects
 * the most recently synced season instead of whatever the setup wizard sent
 * once at league creation and never again (the exact bug the audit found:
 * `dataProcessing.ts` computing `remainingWeeks` from a `playoffWeeks` value
 * that was 4+ months stale by the fantasy playoffs).
 *
 * Contract:
 * - Caller: intended to run once per season sync, after `espnSync` parses
 *   that season's raw ESPN settings blob with
 *   `parseEspnLeagueSettings` (`convex/lib/espnSettings.ts`) and writes it to
 *   `leagueSeasons.settings`. Not wired up to a caller yet - `espnSync.ts` is
 *   being edited elsewhere; this mutation is the landing point for that call.
 * - `args.settings` is the FULL `ParsedLeagueSettings` for `args.seasonId`.
 *   Only `MIRRORED_LEAGUE_SETTINGS_KEYS` (`convex/lib/espnSettings.ts`) are
 *   actually written - fields like `name`, `size`, `vetoVotesRequired`, and
 *   `draft` are accepted but intentionally not mirrored onto
 *   `leagues.settings` (they don't belong in that object, or aren't consumed
 *   from it anywhere yet).
 * - Merge semantics: `leagues.settings` is spread first, then overridden with
 *   only the DEFINED mirrored keys (`pickMirroredLeagueSettings` drops
 *   `undefined`s) - a field ESPN didn't emit in this particular sync is left
 *   exactly as it was, never reset to `undefined`. Every other
 *   `leagues.settings` field (`categories`, `rosterSize`, `rosterComposition`,
 *   ...) is untouched.
 * - Always stamps `settingsSyncedAt = Date.now()`, even when nothing else
 *   changed - it's evidence the sync ran, not evidence something changed.
 * - Idempotent and safe to call multiple times with the same input.
 * - Does NOT check `args.seasonId` against the league's current season - the
 *   caller must only invoke this for the season it wants mirrored (normally
 *   the season that was just synced).
 */
export const mirrorSeasonSettings = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    settings: parsedLeagueSettingsValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      throw new Error(`mirrorSeasonSettings: league ${args.leagueId} not found`);
    }

    const mirrored = pickMirroredLeagueSettings(args.settings);

    await ctx.db.patch(args.leagueId, {
      settings: {
        ...league.settings,
        ...mirrored,
        settingsSyncedAt: Date.now(),
      },
    });

    return null;
  },
});

export const getByUser = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const memberships = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .collect();

    const leagues = await Promise.all(
      memberships.map(async (membership) => {
        const league = await ctx.db.get(membership.leagueId);
        if (!league) return null;
        return {
          ...redactEspnCredentials(league),
          role: membership.role,
          joinedAt: membership.joinedAt,
        };
      })
    );

    return leagues.filter((league): league is NonNullable<typeof league> => league !== null);
  },
});

// List all leagues. INTERNAL ONLY — returns full documents including ESPN
// credentials, and is used by sync jobs to enumerate leagues. Never expose this
// publicly (it previously leaked every commissioner's ESPN session cookies).
export const listLeagues = internalQuery({
  handler: async (ctx) => {
    return await ctx.db.query("leagues").collect();
  },
});

export const getById = query({
  args: { id: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    // Check if user is a member of this league
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.id).eq("userId", identity.subject)
      )
      .first();

    if (!membership) {
      return null;
    }

    const league = await ctx.db.get(args.id);
    if (!league) {
      return null;
    }

    return {
      ...redactEspnCredentials(league),
      role: membership.role,
    };
  },
});

// Distinct seasons (years) with league data, for season-selector UI. Sorted
// most-recent-first. Membership-checked, same pattern as getById.
export const getAvailableSeasons = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<number[]> => {
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

    const leagueSeasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    const years = Array.from(new Set(leagueSeasons.map((ls) => ls.seasonId)));
    years.sort((a, b) => b - a);

    return years;
  },
});

export const getPublicInfo = query({
  args: { id: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.id);
    if (!league) return null;
    
    // Return only public information about the league
    return {
      _id: league._id,
      name: league.name,
      createdAt: league.createdAt,
    };
  },
});

// Internal query for fetching league data without authentication
export const getByIdInternal = internalQuery({
  args: { id: v.id("leagues") },
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.id);
    if (!league) {
      console.log("🔍 getByIdInternal: League not found");
      return null;
    }
    
    console.log("✅ getByIdInternal: League found:", {
      leagueId: league._id,
      name: league.name,
      hasEspnData: !!league.espnData
    });
    
    return league;
  },
});

/* ========================================================================== *
 * ESPN connection health (audit: credential health / cron alerting)
 * ========================================================================== */

/**
 * Persist the outcome of an ESPN credential probe. Called by
 * `espnSync.testEspnConnection` (when testing the STORED credentials, not a
 * caller-supplied trial pair) and by the sync crons whenever they classify a
 * private league's credentials as good or bad. Internal only: it writes
 * `credentialStatus`/`credentialError`, which a client must never set
 * directly - only a real probe against ESPN gets to decide that.
 *
 * `alertedAt`, when passed, stamps `credentialAlertedAt` so the cron's
 * "alert at most once per 24h" check has something to read next time.
 */
export const setEspnCredentialStatus = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    status: v.union(v.literal("valid"), v.literal("invalid"), v.literal("unknown")),
    error: v.optional(v.string()),
    alertedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league || !league.espnData) return null;

    const previousStatus = league.espnData.credentialStatus ?? "unknown";

    await ctx.db.patch(args.leagueId, {
      espnData: {
        ...league.espnData,
        credentialStatus: args.status,
        credentialCheckedAt: Date.now(),
        // Never leave a stale error message sitting under a "valid" status.
        credentialError: args.status === "valid" ? undefined : args.error,
        ...(args.alertedAt !== undefined ? { credentialAlertedAt: args.alertedAt } : {}),
      },
    });

    // Commissioner-facing credential lifecycle (audit: 2-week-expiry /
    // rejected-cookie emails). Fires only on the actual transition, not on
    // every re-confirmation of the same status, so a league that stays
    // invalid across many sync attempts doesn't re-trigger this on each one -
    // `espnCredentialLifecycle.dailyCredentialReminders` owns the "still
    // broken" nudge on its own cadence.
    if (previousStatus !== "invalid" && args.status === "invalid" && league.espnData.isPrivate) {
      await ctx.scheduler.runAfter(0, internal.espnCredentialLifecycle.onInvalid, {
        leagueId: args.leagueId,
      });
    } else if (previousStatus === "invalid" && args.status === "valid") {
      await ctx.scheduler.runAfter(0, internal.espnCredentialLifecycle.onRestored, {
        leagueId: args.leagueId,
      });
    }

    return null;
  },
});

/**
 * Stamp (or clear) `credentialInvalidNotifiedAt` on a private league's ESPN
 * data. Called by `espnCredentialLifecycle.onInvalid`/`dailyCredentialReminders`
 * right after sending (or attempting to send) the commissioner's
 * "connection broken" email, and by `onRestored` to clear it once the
 * connection is fixed again. Omit `notifiedAt` to clear.
 */
export const markCredentialNotified = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    notifiedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league || !league.espnData) return null;

    await ctx.db.patch(args.leagueId, {
      espnData: {
        ...league.espnData,
        credentialInvalidNotifiedAt: args.notifiedAt,
      },
    });
    return null;
  },
});

/**
 * Stamp the `credentialExpiresAt` value the 14-day expiry reminder was just
 * sent for, so `dailyCredentialReminders` doesn't send it again for the same
 * expiry date every day it stays inside the 14-day window.
 */
export const markExpiryReminderSent = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league || !league.espnData) return null;

    await ctx.db.patch(args.leagueId, {
      espnData: {
        ...league.espnData,
        expiryReminderSentFor: args.expiresAt,
      },
    });
    return null;
  },
});

/** Backlog count for a league, for the daily reminder cron (no auth - internal only). */
export const getBackloggedContentCountInternal = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.number(),
  handler: async (ctx, args) => countBackloggedContent(ctx, args.leagueId),
});

/**
 * The ESPN connection panel's read model (contract with the setup/settings
 * UI). Member-gated like every other per-league read; NEVER returns the
 * cookie values themselves - only whether they're present and, per the last
 * probe, whether ESPN still accepts them.
 */
export const getEspnConnection = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    hasCredentials: v.boolean(),
    isPrivate: v.boolean(),
    credentialStatus: v.union(v.literal("valid"), v.literal("invalid"), v.literal("unknown")),
    credentialCheckedAt: v.optional(v.number()),
    credentialError: v.optional(v.string()),
    lastSyncedAt: v.optional(v.number()),
    // --- Credential lifecycle (commissioner-facing) ---
    credentialSavedAt: v.optional(v.number()),
    credentialExpiresAt: v.optional(v.number()),
    contentPausedAt: v.optional(v.number()),
    // Scheduled content rows held back while credentials were invalid.
    backloggedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const espnData = league.espnData;
    const backloggedCount = await countBackloggedContent(ctx, args.leagueId);

    return {
      hasCredentials: !!(espnData?.espnS2 && espnData?.swid),
      isPrivate: !!espnData?.isPrivate,
      credentialStatus: espnData?.credentialStatus ?? "unknown",
      credentialCheckedAt: espnData?.credentialCheckedAt,
      credentialError: espnData?.credentialError,
      lastSyncedAt: espnData?.lastSyncedAt,
      credentialSavedAt: espnData?.credentialSavedAt,
      credentialExpiresAt: espnData?.credentialExpiresAt,
      contentPausedAt: espnData?.contentPausedAt,
      backloggedCount,
    };
  },
});

/**
 * Save a fresh espn_s2/SWID pair for a private league. Commissioner-gated:
 * these are live ESPN session cookies for whoever's account is connected, so
 * only the person running the league gets to change them. Normalizes before
 * storing (trims, decodes espn_s2 once, brace-wraps SWID) so every downstream
 * ESPN call site can assume the stored value is already clean.
 *
 * Marks the credentials `unknown` rather than `valid` - saving a pair doesn't
 * prove ESPN accepts it; that's what `espnSync.testEspnConnection` is for,
 * and the setup/settings UI is expected to call it right after this.
 */
export const updateEspnCredentials = mutation({
  args: {
    leagueId: v.id("leagues"),
    espnS2: v.string(),
    swid: v.string(),
    // As read by the commissioner from the browser's cookie panel (ESPN
    // doesn't publish a lifetime for espn_s2). Optional; omit/undefined
    // clears any previously-entered expiry. Drives the 14-day reminder.
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args) => {
    await requireCommissioner(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const normalized = normalizeEspnCredentials({ espnS2: args.espnS2, swid: args.swid });
    if (!normalized.hasCredentials) {
      throw new Error("Both espn_s2 and SWID are required");
    }

    const existingEspnData = league.espnData ?? {
      seasonId: new Date().getFullYear(),
      currentScoringPeriod: 1,
      size: 0,
      lastSyncedAt: 0,
      isPrivate: true,
    };

    const now = Date.now();

    await ctx.db.patch(args.leagueId, {
      espnData: {
        ...existingEspnData,
        isPrivate: true,
        espnS2: normalized.espnS2,
        swid: normalized.swid,
        credentialStatus: "unknown" as const,
        credentialCheckedAt: undefined,
        credentialError: undefined,
        credentialSavedAt: now,
        credentialExpiresAt: args.expiresAt,
        // A fresh pair invalidates whatever expiry reminder was already sent.
        expiryReminderSentFor: undefined,
      },
    });

    // Probe the freshly-saved pair right away. A successful probe writes
    // "valid" through setEspnCredentialStatus, which - if the connection was
    // previously invalid - schedules espnCredentialLifecycle.onRestored on
    // its own, so a fixed connection resumes the backlog without the
    // commissioner doing anything else.
    await ctx.scheduler.runAfter(0, internal.espnSync.validateStoredCredentials, {
      leagueId: args.leagueId,
    });

    return { ok: true as const };
  },
});

export const getDraftData = query({
  args: { 
    leagueId: v.id("leagues"),
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

    // Get league season data
    const leagueSeason = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .first();

    if (!leagueSeason) {
      return null;
    }

    // Get teams for this season
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .collect();

    // Get enhanced player data - ensure string conversion for espnId matching
    const playerIds = leagueSeason.draft?.map(pick => pick.playerId.toString()) || [];
    const players = await Promise.all(
      playerIds.map(async (playerId) => {
        const player = await ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => 
            q.eq("espnId", playerId).eq("season", args.seasonId)
          )
          .first();
        return player;
      })
    );

    // Create a map for quick lookup - use string keys to match draft data
    const teamMap = new Map(teams.map(t => [parseInt(t.externalId), t]));
    const playerMap = new Map(players.filter(p => p).map(p => [p!.espnId, p]));

    return {
      draftSettings: leagueSeason.draftSettings,
      draftInfo: leagueSeason.draftInfo,
      picks: leagueSeason.draft?.map(pick => ({
        ...pick,
        team: teamMap.get(pick.teamId),
        player: playerMap.get(pick.playerId.toString())
      })) || [],
      hasData: !!leagueSeason.draft && leagueSeason.draft.length > 0
    };
  },
});
export const getLeagueSeasons = query({
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

    // Get all seasons for this league
    const seasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();

    return seasons;
  },
});
export const getLeagueSeasonByYear = query({
  args: { 
    leagueId: v.id("leagues"),
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

    // Get specific season for this league
    const season = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league_season", (q) => 
        q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId)
      )
      .first();

    return season;
  },
});

export const joinLeague = mutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if already a member
    const existingMembership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) => 
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();

    if (existingMembership) {
      throw new Error("Already a member of this league");
    }

    // Seats (spec §10.1). The pass covers 12 managers; the 13th needs a $10
    // seat the commissioner buys, which `recordExtraSeat` records. Checked
    // before the insert so the league can never hold more managers than it
    // has paid for.
    const capacity = await leagueCapacity(ctx, args.leagueId);
    if (capacity.remaining <= 0) {
      throw new Error(LEAGUE_AT_CAPACITY);
    }

    // Add as member
    await ctx.db.insert("leagueMemberships", {
      leagueId: args.leagueId,
      userId: identity.subject,
      role: "member",
      joinedAt: Date.now(),
    });

    // The manager's share of the League Pass, when the league has one. The
    // grant refuses on an unpaid league and is idempotent per season, so a
    // manager who joins after the pass was bought gets their 100 exactly once.
    try {
      await ctx.runMutation(internal.credits.grantJoinCredits, {
        userId: identity.subject,
        leagueId: args.leagueId,
      });
    } catch (error) {
      console.error("Failed to grant League Pass credits on join:", error);
    }

    return args.leagueId;
  },
});

// Debug mutation to clear all league data and refetch from ESPN
// Refresh league data from ESPN without clearing existing data
// This preserves team IDs and relationships (like team claims)
export const refreshLeagueData = action({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args): Promise<{
    success: boolean;
    message?: string;
    syncResult?: any;
    error?: string;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if user has permission (commissioner only for now)
    const membership = await ctx.runQuery(api.leagues.getById, { id: args.leagueId });
    if (!membership || membership.role !== "commissioner") {
      throw new Error("Only commissioners can perform this debug operation");
    }

    try {
      // NOTE: We no longer clear data - we use upsert logic in the sync functions
      // This preserves team IDs and maintains relationships with teamClaims
      
      // Refetch all data from ESPN (current season + 10 years of history)
      const syncResult: any = await ctx.runAction(api.espnSync.syncAllLeagueData, {
        leagueId: args.leagueId,
        includeCurrentSeason: true,
        historicalYears: 10,
      });

      return {
        success: true,
        message: "Successfully refreshed all data from ESPN (data updated, not replaced)",
        syncResult,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  },
});;

// Helper mutation to clear all league data. DESTRUCTIVE — only the league
// commissioner may run it.
export const clearAllLeagueData = mutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.leagueId).eq("userId", identity.subject)
      )
      .first();
    if (!membership || membership.role !== "commissioner") {
      throw new Error("Only the league commissioner can clear league data");
    }

    // Clear teams
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const team of teams) {
      await ctx.db.delete(team._id);
    }

    // Clear matchups
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_season", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const matchup of matchups) {
      await ctx.db.delete(matchup._id);
    }

    // Clear league seasons
    const leagueSeasons = await ctx.db
      .query("leagueSeasons")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const season of leagueSeasons) {
      await ctx.db.delete(season._id);
    }

    // Clear AI content associated with this league
    const aiContent = await ctx.db
      .query("aiContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const content of aiContent) {
      await ctx.db.delete(content._id);
    }

    // Clear weekly stats
    const weeklyStats = await ctx.db
      .query("weeklyStats")
      .withIndex("by_league_week", (q) => q.eq("leagueId", args.leagueId))
      .collect();
    
    for (const stat of weeklyStats) {
      await ctx.db.delete(stat._id);
    }

    return { cleared: true };
  },
});
// Membership role lookup for action-side auth checks (see convex/lib/auth.ts
// requireLeagueMemberFromAction). Internal only: takes the userId as an argument.
export const getMembershipRoleInternal = internalQuery({
  args: { leagueId: v.id("leagues"), userId: v.string() },
  handler: async (ctx, args): Promise<"commissioner" | "member" | null> => {
    const membership = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league_user", (q) =>
        q.eq("leagueId", args.leagueId).eq("userId", args.userId)
      )
      .first();
    return membership?.role ?? null;
  },
});

// The `users` row id for every commissioner membership of a league. Internal
// only - used by the ESPN-credential-invalid alert (espnSync.ts) to notify
// each commissioner in-app; mirrors the join `claimRollover.ts` does for its
// own "team changed owner" notice.
export const getCommissionerUserIdsInternal = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.array(v.id("users")),
  handler: async (ctx, args): Promise<Id<"users">[]> => {
    const commissionerMemberships = await ctx.db
      .query("leagueMemberships")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .filter((q) => q.eq(q.field("role"), "commissioner"))
      .collect();

    const userIds: Id<"users">[] = [];
    for (const membership of commissionerMemberships) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", membership.userId))
        .first();
      if (user) userIds.push(user._id);
    }
    return userIds;
  },
});

/* ========================================================================== *
 * League Pass seats (spec §10.1)
 * ========================================================================== */

/**
 * How many managers this league has paid for, and how many seats are left.
 *
 * League members only: seat counts are the commissioner's billing position,
 * and the join flow only ever needs them for a league the caller is already
 * in. The at-capacity message a would-be joiner sees comes from the
 * {@link LEAGUE_AT_CAPACITY} error on `joinLeague`, not from this query.
 */
export const getLeagueCapacity = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    managers: v.number(),
    included: v.number(),
    extraSeats: v.number(),
    remaining: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    return await leagueCapacity(ctx, args.leagueId);
  },
});

/**
 * Record one bought $10 seat. Called by PRICE-D's Stripe webhook once the seat
 * payment settles; `credits.grantSeatCredits` mints that seat's 100 credits.
 *
 * Internal on purpose: this widens what the league is allowed to hold, so it
 * may only ever be reached from a settled payment, never from a client.
 */
export const recordExtraSeat = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    /** Seats bought in one go. Defaults to one. */
    count: v.optional(v.number()),
  },
  returns: v.object({ extraSeats: v.number(), included: v.number(), total: v.number() }),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const count = Math.max(1, Math.floor(args.count ?? 1));
    const { included, extraSeats } = leagueSeatAllowance(league);
    const nextExtraSeats = extraSeats + count;

    await ctx.db.patch(args.leagueId, {
      subscription: {
        ...league.subscription,
        // Written explicitly rather than left to default, so the league's own
        // allowance survives a later change to INCLUDED_MANAGERS_DEFAULT.
        includedManagers: included,
        extraSeats: nextExtraSeats,
      },
    });

    return { extraSeats: nextExtraSeats, included, total: included + nextExtraSeats };
  },
});
