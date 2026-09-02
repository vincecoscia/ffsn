/**
 * Commissioner-facing ESPN credential lifecycle (owner's words: "notify the
 * private league's commissioner via email 2 weeks before that token expires
 * (if we know that info) or when the token has expired so they can fix it
 * ASAP").
 *
 * `leagues.setEspnCredentialStatus` is the single write path for
 * `espnData.credentialStatus` (every sync/probe callsite already goes
 * through it) and schedules `onInvalid` / `onRestored` below on the actual
 * transition (something other than "invalid" -> "invalid", or "invalid" ->
 * "valid"). `dailyCredentialReminders` covers what a one-shot transition
 * can't: a connection that's still broken days later, an upcoming expiry the
 * commissioner hasn't fixed yet, and a token that silently expired between
 * sync attempts with nothing around to notice.
 *
 * Content pause/resume itself belongs to the scheduler
 * (`contentScheduling.onEspnCredentialsInvalid` / `onEspnCredentialsRestored`)
 * - this module only reacts to their result counts for the email copy.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  localTemplateId,
  type EspnConnectionBrokenEmailData,
  type EspnConnectionExpiringEmailData,
  type EspnConnectionRestoredEmailData,
} from "../src/lib/email";

const SITE_URL = (process.env.SITE_URL || "https://ffsn.ai").replace(/\/+$/, "");

function settingsUrl(leagueId: Id<"leagues">): string {
  return `${SITE_URL}/leagues/${leagueId}/settings`;
}

function preferencesUrl(): string {
  return `${SITE_URL}/dashboard/settings/notifications`;
}

/** `league.commissionerUserId` (Clerk id) resolved to a `users` row with an email, or null. */
export const getCommissionerContact = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.union(
    v.object({ userId: v.id("users"), email: v.string(), name: v.optional(v.string()) }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", league.commissionerUserId))
      .first();
    if (!user?.email) return null;

    return { userId: user._id, email: user.email, name: user.name };
  },
});

/**
 * Fired by `leagues.setEspnCredentialStatus` the moment a private league's
 * ESPN credentials flip to "invalid". Pauses automated content
 * (`contentScheduling.onEspnCredentialsInvalid`) and emails the commissioner
 * what broke, what's paused, and how to fix it.
 */
export const onInvalid = internalAction({
  args: { leagueId: v.id("leagues") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league || !league.espnData?.isPrivate) return null;

    let waiting = 0;
    try {
      const result = await ctx.runMutation(internal.contentScheduling.onEspnCredentialsInvalid, {
        leagueId: args.leagueId,
      });
      waiting = result.waiting;
    } catch (error) {
      console.error(
        `espnCredentialLifecycle.onInvalid: failed to pause content for league ${args.leagueId}:`,
        error
      );
    }

    const contact: { userId: Id<"users">; email: string; name?: string } | null = await ctx.runQuery(
      internal.espnCredentialLifecycle.getCommissionerContact,
      { leagueId: args.leagueId }
    );

    if (contact) {
      const data: EspnConnectionBrokenEmailData = {
        leagueName: league.name,
        errorDetail: league.espnData.credentialError,
        waitingCount: waiting,
        fixUrl: settingsUrl(args.leagueId),
        preferencesUrl: preferencesUrl(),
        siteUrl: SITE_URL,
      };
      try {
        await ctx.runMutation(internal.emailService.queueEmailInternal, {
          to: contact.email,
          templateId: localTemplateId("espn_connection_broken"),
          data,
          userId: contact.userId,
          relatedEntityType: "espn_connection_broken",
          relatedEntityId: args.leagueId,
        });
      } catch (error) {
        console.error(
          `espnCredentialLifecycle.onInvalid: failed to queue email for league ${args.leagueId}:`,
          error
        );
      }
    } else {
      console.warn(
        `espnCredentialLifecycle.onInvalid: no commissioner email on file for league ${args.leagueId}; skipping notification`
      );
    }

    await ctx.runMutation(internal.leagues.markCredentialNotified, {
      leagueId: args.leagueId,
      notifiedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Fired by `leagues.setEspnCredentialStatus` the moment a previously-invalid
 * private league's ESPN credentials flip back to "valid" - whether from a
 * routine sync succeeding again or from `leagues.updateEspnCredentials`
 * scheduling a probe of a freshly-saved pair.
 */
export const onRestored = internalAction({
  args: { leagueId: v.id("leagues") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const league = await ctx.runQuery(internal.leagues.getByIdInternal, { id: args.leagueId });
    if (!league || !league.espnData?.isPrivate) return null;

    let resumed = 0;
    let withoutInterviews = 0;
    try {
      const result = await ctx.runMutation(internal.contentScheduling.onEspnCredentialsRestored, {
        leagueId: args.leagueId,
      });
      resumed = result.resumed;
      withoutInterviews = result.withoutInterviews;
    } catch (error) {
      console.error(
        `espnCredentialLifecycle.onRestored: failed to resume content for league ${args.leagueId}:`,
        error
      );
    }

    const contact: { userId: Id<"users">; email: string; name?: string } | null = await ctx.runQuery(
      internal.espnCredentialLifecycle.getCommissionerContact,
      { leagueId: args.leagueId }
    );

    if (contact) {
      const data: EspnConnectionRestoredEmailData = {
        leagueName: league.name,
        resumedCount: resumed,
        withoutInterviewsCount: withoutInterviews,
        leagueUrl: `${SITE_URL}/leagues/${args.leagueId}`,
        preferencesUrl: preferencesUrl(),
        siteUrl: SITE_URL,
      };
      try {
        await ctx.runMutation(internal.emailService.queueEmailInternal, {
          to: contact.email,
          templateId: localTemplateId("espn_connection_restored"),
          data,
          userId: contact.userId,
          relatedEntityType: "espn_connection_restored",
          relatedEntityId: args.leagueId,
        });
      } catch (error) {
        console.error(
          `espnCredentialLifecycle.onRestored: failed to queue email for league ${args.leagueId}:`,
          error
        );
      }
    }

    await ctx.runMutation(internal.leagues.markCredentialNotified, { leagueId: args.leagueId });

    return null;
  },
});

/* -------------------------------------------------------------------------- */
/* Daily reminder selection - pure, unit-tested                               */
/* -------------------------------------------------------------------------- */

const INVALID_RESEND_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The slice of `leagues.espnData` the reminder decision needs. */
export interface CredentialReminderEspnData {
  credentialStatus?: "valid" | "invalid" | "unknown";
  credentialInvalidNotifiedAt?: number;
  credentialExpiresAt?: number;
  expiryReminderSentFor?: number;
}

export interface CredentialReminderDecision {
  /** Resend the "connection broken" email - status is invalid and the last notice is stale. */
  resendBrokenEmail: boolean;
  /** Send the "expires soon" email - a known expiry is within the 14-day window and unwarned. */
  sendExpiringEmail: boolean;
  /** Probe the stored pair - a known expiry has passed but nothing has caught it yet. */
  probeStoredCredentials: boolean;
  /** Only set when `sendExpiringEmail` is true; whole days remaining, minimum 1. */
  daysLeft?: number;
}

/**
 * What `dailyCredentialReminders` should do for one private league's
 * `espnData`, given the current time. Pure and side-effect free so its three
 * branches (still-broken resend, upcoming-expiry warning, silently-expired
 * probe) are unit-testable without a Convex context. The branches are not
 * mutually exclusive by construction (a league could in principle be both
 * invalid and carry an unrelated future expiry date), so callers should act
 * on every flag that's true rather than treating this as a single choice.
 */
export function decideReminder(
  espnData: CredentialReminderEspnData,
  now: number
): CredentialReminderDecision {
  const resendBrokenEmail =
    espnData.credentialStatus === "invalid" &&
    (espnData.credentialInvalidNotifiedAt === undefined ||
      now - espnData.credentialInvalidNotifiedAt >= INVALID_RESEND_COOLDOWN_MS);

  const expiresAt = espnData.credentialExpiresAt;
  const hasFutureExpiry = typeof expiresAt === "number" && expiresAt > now;
  const sendExpiringEmail =
    hasFutureExpiry &&
    (expiresAt as number) - now <= EXPIRY_WARNING_WINDOW_MS &&
    espnData.expiryReminderSentFor !== expiresAt;

  const hasPastExpiry = typeof expiresAt === "number" && expiresAt <= now;
  const probeStoredCredentials = hasPastExpiry && espnData.credentialStatus !== "invalid";

  return {
    resendBrokenEmail,
    sendExpiringEmail,
    probeStoredCredentials,
    daysLeft: sendExpiringEmail
      ? Math.max(1, Math.ceil(((expiresAt as number) - now) / MS_PER_DAY))
      : undefined,
  };
}

/**
 * Daily sweep (crons.ts, 13:30 UTC) over every private league: resends the
 * "still broken" email every 3 days while credentials stay invalid, warns
 * about an upcoming expiry once per expiry value, and probes a token whose
 * commissioner-entered expiry has passed but that no sync has caught yet.
 */
export const dailyCredentialReminders = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const leagues = await ctx.runQuery(internal.leagues.listLeagues, {});
    const now = Date.now();

    for (const league of leagues) {
      if (!league.espnData?.isPrivate) continue;
      const decision = decideReminder(league.espnData, now);
      if (!decision.resendBrokenEmail && !decision.sendExpiringEmail && !decision.probeStoredCredentials) {
        continue;
      }

      if (decision.resendBrokenEmail) {
        try {
          const waiting: number = await ctx.runQuery(internal.leagues.getBackloggedContentCountInternal, {
            leagueId: league._id,
          });
          const contact: { userId: Id<"users">; email: string; name?: string } | null = await ctx.runQuery(
            internal.espnCredentialLifecycle.getCommissionerContact,
            { leagueId: league._id }
          );
          if (contact) {
            const data: EspnConnectionBrokenEmailData = {
              leagueName: league.name,
              errorDetail: league.espnData.credentialError,
              waitingCount: waiting,
              isReminder: true,
              fixUrl: settingsUrl(league._id),
              preferencesUrl: preferencesUrl(),
              siteUrl: SITE_URL,
            };
            await ctx.runMutation(internal.emailService.queueEmailInternal, {
              to: contact.email,
              templateId: localTemplateId("espn_connection_broken"),
              data,
              userId: contact.userId,
              relatedEntityType: "espn_connection_broken",
              relatedEntityId: league._id,
            });
          }
          await ctx.runMutation(internal.leagues.markCredentialNotified, {
            leagueId: league._id,
            notifiedAt: now,
          });
        } catch (error) {
          console.error(
            `dailyCredentialReminders: failed to resend the broken-connection email for league ${league._id}:`,
            error
          );
        }
      }

      if (decision.sendExpiringEmail && league.espnData.credentialExpiresAt !== undefined) {
        const expiresAt = league.espnData.credentialExpiresAt;
        try {
          const contact: { userId: Id<"users">; email: string; name?: string } | null = await ctx.runQuery(
            internal.espnCredentialLifecycle.getCommissionerContact,
            { leagueId: league._id }
          );
          if (contact) {
            const daysLeft = decision.daysLeft ?? 1;
            const data: EspnConnectionExpiringEmailData = {
              leagueName: league.name,
              daysLeft,
              fixUrl: settingsUrl(league._id),
              preferencesUrl: preferencesUrl(),
              siteUrl: SITE_URL,
            };
            await ctx.runMutation(internal.emailService.queueEmailInternal, {
              to: contact.email,
              templateId: localTemplateId("espn_connection_expiring"),
              data,
              userId: contact.userId,
              relatedEntityType: "espn_connection_expiring",
              relatedEntityId: league._id,
            });
            await ctx.runMutation(internal.notifications.createNotification, {
              userId: contact.userId,
              leagueId: league._id,
              type: "account_update" as const,
              title: `Your ESPN login for ${league.name} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
              message: `Reconnect ESPN from League settings before it expires so FFSN doesn't lose access to ${league.name}.`,
              actionUrl: `/leagues/${league._id}/settings`,
              actionText: "Open League settings",
              relatedEntityType: "league" as const,
              relatedEntityId: league._id,
              priority: "medium" as const,
              deliveryChannels: ["in_app"] as const,
              dedupeKey: `espn_expiring:${league._id}:${expiresAt}`,
            });
          }
          await ctx.runMutation(internal.leagues.markExpiryReminderSent, {
            leagueId: league._id,
            expiresAt,
          });
        } catch (error) {
          console.error(
            `dailyCredentialReminders: failed to send the expiring-connection email for league ${league._id}:`,
            error
          );
        }
      }

      if (decision.probeStoredCredentials) {
        try {
          await ctx.runAction(internal.espnSync.validateStoredCredentials, { leagueId: league._id });
        } catch (error) {
          console.error(
            `dailyCredentialReminders: failed to probe stored credentials for league ${league._id}:`,
            error
          );
        }
      }
    }

    return null;
  },
});
