/**
 * The Wire — Sunday-night digest (ffsn-the-wire-spec.md §19.3, §10). Monday 04:00 UTC in season
 * (midnight ET after Sunday night football): one email per opted-in manager who has a claimed team
 * in a pass-holding, wire-enabled league, covering the last 24 h - owner overlays about their team,
 * the wire_alert notifications raised, Sam's unanswered questions, and the league's top headlines.
 * Nothing to say -> no email; a league with nothing in the window is dropped from the digest, not
 * shown empty.
 *
 * `buildDigestForUser` is a pure-read internalQuery (no email sent, no wall-clock read - the
 * caller passes the window) so `tests/wire/wireDigest.test.ts` can seed data and assert the shape
 * and the skip rules directly. `sendDigestForAllUsers` (the Monday cron) and `sendDigestNow` (dev
 * tool) share `deliverDigestToUser`, which renders and sends through the same
 * `emailService.sendPlainEmail` path every other Broadcast email uses.
 */

import { v } from "convex/values";
import { internalAction, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hasActivePass } from "./credits";
import { inSeasonNow } from "./wireDesk";
import { articleRefFor } from "./lib/wireArticleRef";
import { wireEnabled } from "./lib/wireLeaguePosting";
import { DIGEST_MAX_HEADLINES, DIGEST_MAX_YOUR_TEAM, type WireDigestData, type WireDigestLeague } from "../src/lib/ai/wire/types";
import { renderWireDigestEmail } from "../src/lib/email/templates";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches the zone every other Dex Desk wall-clock check uses (convex/lib/wireDeskRules.ts). */
const DIGEST_TIME_ZONE = "America/New_York";
/** Bounded scan caps - a league's post volume in any 24h window is already capped by
 *  LEAGUE_POSTS_PER_DAY (80), so these are generous rather than tight. */
const LEAGUE_POST_SCAN_CAP = 300;
const GLOBAL_POST_SCAN_CAP = 400;

function siteBaseUrl(): string {
  return (process.env.SITE_URL || "https://ffsn.ai").replace(/\/$/, "");
}

/* ------------------------------------------------------------------------------------------- *
 * buildDigestForUser — the pure shape, directly testable
 * ------------------------------------------------------------------------------------------- */

async function buildLeagueDigest(
  ctx: QueryCtx,
  args: { league: Doc<"leagues">; team: Doc<"teams">; userId: Id<"users">; windowStart: number; windowEnd: number }
): Promise<WireDigestLeague | null> {
  const { league, team, userId, windowStart, windowEnd } = args;
  const leagueId = league._id;
  const baseUrl = siteBaseUrl();

  const recentLeaguePosts = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId).gt("createdAt", windowStart))
    .take(LEAGUE_POST_SCAN_CAP);
  const inWindow = recentLeaguePosts.filter((p) => p.createdAt <= windowEnd && !p.deletedAt);

  // Owner overlays about the manager's own team (spec §19.3): globalPostId set (an overlay, not a
  // routine post), impact.teamId is this team, and the variant is "owner" - not the opponent-framed
  // overlay a rival's overlay would also carry with this team as impact.teamId.
  const yourTeamSliced = inWindow
    .filter((p) => p.globalPostId !== undefined && p.impact?.teamId === team._id && p.impact?.variant === "owner")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, DIGEST_MAX_YOUR_TEAM);
  const yourTeam = await Promise.all(
    yourTeamSliced.map(async (p) => {
      const ref = await articleRefFor(ctx, p.dedupeKey);
      return { persona: p.persona, text: p.text, createdAt: p.createdAt, article: ref ? { id: ref.id, title: ref.title } : undefined };
    })
  );

  // Sam's questions addressed to this team, still without a manager reply in the thread.
  const samQuestions = inWindow.filter((p) => p.kind === "sam_question" && p.featuredTeams.includes(team._id));
  const openQuestions: WireDigestLeague["openQuestions"] = [];
  for (const question of samQuestions) {
    const reply = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_reply", (q) => q.eq("leagueId", leagueId).eq("replyTo.id", question._id))
      .first();
    if (!reply) openQuestions.push({ text: question.text, createdAt: question.createdAt, postId: question._id });
  }

  const recentNotifications = await ctx.db
    .query("userNotifications")
    .withIndex("by_user_type", (q) => q.eq("userId", userId).eq("type", "wire_alert"))
    .order("desc")
    .take(200);
  const alerts = recentNotifications
    .filter((n) => n.leagueId === leagueId && n.createdAt >= windowStart && n.createdAt <= windowEnd)
    .map((n) => ({ title: n.title, message: n.message, createdAt: n.createdAt }));

  // Top global posts by interest in the window - a reader-visible status only (never take_pending
  // or held).
  const recentGlobalPosts = await ctx.db
    .query("wirePosts")
    .withIndex("by_created", (q) => q.gt("createdAt", windowStart))
    .take(GLOBAL_POST_SCAN_CAP);
  // `article` is always absent here (spec deviation - see report): headlines come from the GLOBAL
  // `wirePosts` table, which carries no `dedupeKey` to resolve an article from, and
  // `article_published` is a league-only event kind (types.ts's LEAGUE_EVENT_KINDS) that a global
  // post could never be in the first place. The field is still present, undefined, so the UI can
  // treat `yourTeam` and `headlines` items identically.
  const headlines = recentGlobalPosts
    .filter((p) => p.createdAt <= windowEnd && (p.status === "card" || p.status === "take"))
    .sort((a, b) => b.interest - a.interest)
    .slice(0, DIGEST_MAX_HEADLINES)
    .map((p) => ({
      persona: p.persona,
      text: p.text,
      createdAt: p.createdAt,
      article: undefined as { id: string; title: string } | undefined,
    }));

  // A league earns a block only when the desk had something about THIS manager's team (an overlay,
  // an alert, an open question); the shared headlines ride along but never justify a block on their
  // own - four leagues repeating the same five global posts is not a digest.
  if (yourTeam.length === 0 && alerts.length === 0 && openQuestions.length === 0) return null;

  return {
    leagueId,
    leagueName: league.name,
    teamName: team.name,
    yourTeam,
    alerts,
    openQuestions,
    headlines,
    wireUrl: `${baseUrl}/leagues/${leagueId}/wire`,
  };
}

export const buildDigestForUser = internalQuery({
  args: { userId: v.id("users"), windowStart: v.number(), windowEnd: v.number() },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { userId, windowStart, windowEnd }): Promise<WireDigestData | null> => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    if (user.preferences?.emailNotifications === false) return null;
    if (user.preferences?.wireAlerts === "off") return null;

    const claims = await ctx.db
      .query("teamClaims")
      .withIndex("by_user", (q) => q.eq("userId", user.clerkId))
      .take(50);
    // One block per league: a manager holds a claim per season, so keep the newest season's claim
    // for each league (dev, 2026-09-05: every league rendered twice).
    const newestClaimByLeague = new Map<string, (typeof claims)[number]>();
    for (const claim of claims) {
      if (claim.status !== "active") continue;
      const current = newestClaimByLeague.get(claim.leagueId);
      if (!current || claim.seasonId > current.seasonId) newestClaimByLeague.set(claim.leagueId, claim);
    }
    const activeClaims = [...newestClaimByLeague.values()];

    const leagues: WireDigestLeague[] = [];
    for (const claim of activeClaims) {
      const league = await ctx.db.get(claim.leagueId);
      if (!league || !hasActivePass(league)) continue;
      const prefs = await ctx.db
        .query("leagueContentPreferences")
        .withIndex("by_league", (q) => q.eq("leagueId", claim.leagueId))
        .first();
      if (prefs?.wireEnabled === false) continue;
      const team = await ctx.db.get(claim.teamId);
      if (!team) continue;

      const built = await buildLeagueDigest(ctx, { league, team, userId, windowStart, windowEnd });
      if (built) leagues.push(built);
    }

    if (leagues.length === 0) return null;

    const baseUrl = siteBaseUrl();
    return {
      recipientName: user.name,
      windowStart,
      windowEnd,
      leagues,
      settingsUrl: `${baseUrl}/dashboard/settings/notifications`,
      siteUrl: baseUrl,
      timeZone: DIGEST_TIME_ZONE,
    };
  },
});

/* ------------------------------------------------------------------------------------------- *
 * Recipient contact + candidate enumeration
 * ------------------------------------------------------------------------------------------- */

export const getRecipientContact = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.object({ email: v.optional(v.string()), name: v.optional(v.string()) }), v.null()),
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return { email: user.email, name: user.name };
  },
});

/**
 * Every user with at least one active claim in a pass-holding, wire-enabled league - found by
 * walking leagues (bounded, the same convention `wireOverlay.fanOutGlobalPost` and
 * `wireDesk.findLockedStarters` already use) rather than scanning the `users` table, which this
 * feature has no reason to touch in full.
 */
export const listCandidateUserIds = internalQuery({
  args: {},
  returns: v.array(v.id("users")),
  handler: async (ctx) => {
    const leagues = await ctx.db.query("leagues").take(1000);
    const userIds = new Set<Id<"users">>();
    for (const league of leagues) {
      if (!hasActivePass(league)) continue;
      const prefs = await ctx.db
        .query("leagueContentPreferences")
        .withIndex("by_league", (q) => q.eq("leagueId", league._id))
        .first();
      if (prefs?.wireEnabled === false) continue;

      const claims = await ctx.db
        .query("teamClaims")
        .withIndex("by_league", (q) => q.eq("leagueId", league._id))
        .take(60);
      for (const claim of claims) {
        if (claim.status !== "active") continue;
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", claim.userId))
          .first();
        if (user) userIds.add(user._id);
      }
    }
    return [...userIds];
  },
});

/* ------------------------------------------------------------------------------------------- *
 * Send path (shared by the Monday cron and the dev tool)
 * ------------------------------------------------------------------------------------------- */

async function deliverDigestToUser(
  ctx: ActionCtx,
  userId: Id<"users">,
  windowStart: number,
  windowEnd: number
): Promise<{ sent: boolean; reason: string }> {
  // Per-user-per-day dedupe (spec §19.3), in wireSourceState - the same generic cursor/health row
  // every other Wire poller keeps, keyed uniquely enough that a retried cron never double-sends.
  const dateStr = new Date(windowEnd).toISOString().slice(0, 10);
  const dedupeSource = `wire_digest:${userId}:${dateStr}`;
  const already: { ok: boolean } | null = await ctx.runQuery(internal.wireDetect.getSourceCursor, { source: dedupeSource });
  if (already) return { sent: false, reason: "already sent today" };

  const data: WireDigestData | null = await ctx.runQuery(internal.wireDigest.buildDigestForUser, { userId, windowStart, windowEnd });
  if (!data) {
    await ctx.runMutation(internal.wireDetect.recordSourceRun, { source: dedupeSource, ok: true, summary: "nothing to say" });
    return { sent: false, reason: "nothing to say" };
  }

  const contact: { email?: string; name?: string } | null = await ctx.runQuery(internal.wireDigest.getRecipientContact, { userId });
  if (!contact?.email) {
    await ctx.runMutation(internal.wireDetect.recordSourceRun, { source: dedupeSource, ok: false, summary: "no email on file" });
    return { sent: false, reason: "no email on file" };
  }

  const rendered = renderWireDigestEmail(data);
  const result: { success: boolean; error?: string } = await ctx.runAction(internal.emailService.sendPlainEmail, {
    to: contact.email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    fromName: rendered.fromName,
    relatedEntityType: "wire_digest",
  });

  await ctx.runMutation(internal.wireDetect.recordSourceRun, {
    source: dedupeSource,
    ok: result.success,
    summary: result.success ? `sent, ${data.leagues.length} league(s)` : "send failed",
    error: result.success ? undefined : result.error,
  });

  return { sent: result.success, reason: result.success ? "sent" : (result.error ?? "send failed") };
}

/** The Monday 04:00 UTC cron (crons.ts): every candidate user, in season only. */
export const sendDigestForAllUsers = internalAction({
  args: {},
  returns: v.object({ sent: v.number(), skipped: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    if (!wireEnabled()) return { sent: 0, skipped: 0 };
    if (!(await inSeasonNow(ctx, now))) return { sent: 0, skipped: 0 };

    const windowEnd = now;
    const windowStart = now - DAY_MS;
    const userIds = await ctx.runQuery(internal.wireDigest.listCandidateUserIds, {});

    let sent = 0;
    let skipped = 0;
    for (const userId of userIds) {
      try {
        const result = await deliverDigestToUser(ctx, userId, windowStart, windowEnd);
        if (result.sent) sent++;
        else skipped++;
      } catch (err) {
        console.error(`wireDigest.sendDigestForAllUsers: failed for user ${userId}:`, err instanceof Error ? err.message : err);
        skipped++;
      }
    }
    return { sent, skipped };
  },
});

/** Dev tool (spec §19.3 "for a dev run"): one user, or every candidate when `userId` is omitted.
 *  Still respects the per-user-per-day dedupe, so a second call the same day is a no-op. */
export const sendDigestNow = internalAction({
  args: { userId: v.optional(v.id("users")) },
  returns: v.object({ sent: v.number(), skipped: v.number() }),
  handler: async (ctx, { userId }) => {
    const now = Date.now();
    const windowEnd = now;
    const windowStart = now - DAY_MS;
    const targets = userId ? [userId] : await ctx.runQuery(internal.wireDigest.listCandidateUserIds, {});

    let sent = 0;
    let skipped = 0;
    for (const id of targets) {
      const result = await deliverDigestToUser(ctx, id, windowStart, windowEnd);
      if (result.sent) sent++;
      else skipped++;
    }
    return { sent, skipped };
  },
});
