/**
 * The Wire — public surface (ffsn-the-wire-spec.md §2, §4, §8.2). Two paginated reactive queries
 * the client merges (`getGlobalPosts` on `by_created`, `getLeaguePosts` on `by_league_created`),
 * plus the small status/ticker/settings surface the page and header chrome need. The global wire is
 * open to any signed-in league member regardless of pass (spec §1.2's upsell); the league tier and
 * this global tier's per-league overlays are pass-gated.
 */

import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getLeagueMembership, requireCommissioner, requireLeagueMember } from "./lib/auth";
import { hasActivePass } from "./credits";
import { DEFAULT_TIMEZONE } from "./contentScheduling";
import { CARD_MIN_INTEREST } from "../src/lib/ai/wire/types";
import type { WireCardPlayer, WireFactCard } from "../src/lib/ai/wire/types";
import { validateFactCard } from "../src/lib/ai/wire/card";

const teamRefValidator = v.object({
  teamId: v.string(),
  name: v.string(),
  abbreviation: v.optional(v.string()),
  logo: v.optional(v.string()),
});

const leaguePostViewValidator = v.object({
  _id: v.string(),
  leagueId: v.string(),
  kind: v.string(),
  persona: v.string(),
  text: v.string(),
  tags: v.array(v.string()),
  week: v.optional(v.number()),
  createdAt: v.number(),
  globalPostId: v.optional(v.string()),
  impact: v.optional(v.object({ team: teamRefValidator, variant: v.string() })),
  featuredTeams: v.array(teamRefValidator),
});

const globalPostViewValidator = v.object({
  _id: v.string(),
  kind: v.string(),
  persona: v.string(),
  text: v.string(),
  tags: v.array(v.string()),
  status: v.string(),
  interest: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
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
  timetable: v.optional(v.string()),
  source: v.object({ type: v.string(), url: v.optional(v.string()) }),
  overlays: v.array(leaguePostViewValidator),
});

/** Resolve a team id to the ticket-sized ref the UI renders, tolerating a deleted team. */
async function teamRef(ctx: QueryCtx, teamId: Id<"teams">): Promise<{ teamId: string; name: string; abbreviation?: string; logo?: string }> {
  const team = await ctx.db.get(teamId);
  return team
    ? { teamId: team._id, name: team.name, abbreviation: team.abbreviation, logo: team.logo }
    : { teamId, name: "Unknown team" };
}

async function toLeaguePostView(ctx: QueryCtx, row: Doc<"wireLeaguePosts">) {
  const impact = row.impact ? { team: await teamRef(ctx, row.impact.teamId), variant: row.impact.variant } : undefined;
  const featuredTeams = await Promise.all(row.featuredTeams.map((id) => teamRef(ctx, id)));
  return {
    _id: row._id,
    leagueId: row.leagueId,
    kind: row.kind,
    persona: row.persona,
    text: row.text,
    tags: row.tags,
    week: row.week,
    createdAt: row.createdAt,
    globalPostId: row.globalPostId,
    impact,
    featuredTeams,
  };
}

/** Every overlay for this league on one global post, newest first - bounded: a global event has at
 *  most three overlay variants (owner/opponent/freeAgent) per league. */
async function overlaysFor(ctx: QueryCtx, postId: Id<"wirePosts">, leagueId: Id<"leagues">) {
  const rows = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_global_post_league", (q) => q.eq("globalPostId", postId).eq("leagueId", leagueId))
    .take(10);
  return Promise.all(rows.map((row) => toLeaguePostView(ctx, row)));
}

async function toGlobalPostView(ctx: QueryCtx, post: Doc<"wirePosts">, leagueId: Id<"leagues">, passActive: boolean) {
  let players: WireCardPlayer[] = [];
  let nflTeam: string | undefined;
  let timetable: string | undefined;
  let sourceType = "internal";
  let sourceUrl: string | undefined;

  const event = await ctx.db.get(post.eventId);
  if (event) {
    try {
      const card: WireFactCard = validateFactCard(event.facts);
      players = card.players;
      nflTeam = card.nflTeam;
      timetable = card.timetable;
      sourceType = card.source.type;
      sourceUrl = card.source.url;
    } catch {
      // A malformed stored card shouldn't break the whole page - just render without card facts.
    }
  }

  const overlays = passActive ? await overlaysFor(ctx, post._id, leagueId) : [];

  return {
    _id: post._id,
    kind: post.kind,
    persona: post.persona,
    text: post.text,
    tags: post.tags,
    status: post.status,
    interest: post.interest,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    players,
    nflTeam,
    timetable,
    source: { type: sourceType, url: sourceUrl },
    overlays,
  };
}

export const getGlobalPosts = query({
  args: { leagueId: v.id("leagues"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(globalPostViewValidator),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    const passActive = hasActivePass(league);

    const result = await ctx.db
      .query("wirePosts")
      .withIndex("by_created")
      .order("desc")
      .filter((q) => q.gte(q.field("interest"), CARD_MIN_INTEREST))
      .paginate(args.paginationOpts);

    const page = await Promise.all(result.page.map((post) => toGlobalPostView(ctx, post, args.leagueId, passActive)));
    return { ...result, page };
  },
});

export const getLeaguePosts = query({
  args: { leagueId: v.id("leagues"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(leaguePostViewValidator),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    if (!hasActivePass(league)) {
      return { page: [], isDone: true, continueCursor: args.paginationOpts.cursor ?? "" };
    }

    // Non-overlay rows only - overlays are attached to their global post by getGlobalPosts above,
    // and must never be listed twice (spec §4's "no per-league copy of global posts is stored").
    const result = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_created", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .filter((q) => q.eq(q.field("globalPostId"), undefined))
      .paginate(args.paginationOpts);

    const page = await Promise.all(result.page.map((row) => toLeaguePostView(ctx, row)));
    return { ...result, page };
  },
});

export const getWireStatus = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({ passActive: v.boolean(), wireEnabled: v.boolean(), isCommissioner: v.boolean() }),
  handler: async (ctx, args) => {
    const membership = await getLeagueMembership(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    const prefs = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();

    return {
      passActive: hasActivePass(league),
      wireEnabled: prefs?.wireEnabled !== false,
      isCommissioner: membership?.membership.role === "commissioner",
    };
  },
});

export const getRecentForTicker = query({
  args: { leagueId: v.id("leagues"), limit: v.number() },
  returns: v.array(
    v.object({
      _id: v.string(),
      persona: v.string(),
      text: v.string(),
      tags: v.array(v.string()),
      createdAt: v.number(),
      scope: v.union(v.literal("global"), v.literal("league")),
    })
  ),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    const passActive = hasActivePass(league);
    const cap = Math.min(Math.max(Math.trunc(args.limit) || 1, 1), 50);

    const globalPosts = await ctx.db
      .query("wirePosts")
      .withIndex("by_created")
      .order("desc")
      .filter((q) => q.gte(q.field("interest"), CARD_MIN_INTEREST))
      .take(cap);

    const leaguePosts = passActive
      ? await ctx.db
          .query("wireLeaguePosts")
          .withIndex("by_league_created", (q) => q.eq("leagueId", args.leagueId))
          .order("desc")
          .take(cap)
      : [];

    const merged = [
      ...globalPosts.map((p) => ({
        _id: p._id as string,
        persona: p.persona,
        text: p.text,
        tags: p.tags,
        createdAt: p.createdAt,
        scope: "global" as const,
      })),
      ...leaguePosts.map((p) => ({
        _id: p._id as string,
        persona: p.persona,
        text: p.text,
        tags: p.tags,
        createdAt: p.createdAt,
        scope: "league" as const,
      })),
    ];
    merged.sort((a, b) => b.createdAt - a.createdAt);
    return merged.slice(0, cap);
  },
});

export const setWireEnabled = mutation({
  args: { leagueId: v.id("leagues"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCommissioner(ctx, args.leagueId);

    const existing = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();
    const now = Date.now();

    if (!existing) {
      // Mirrors contentScheduling.ts's upsert-with-defaults shape, but deliberately does NOT
      // stamp `preferencesTouchedAt` - the Wire toggle is unrelated to the automatic-defaults
      // migration that field gates (spec: "do NOT stamp preferencesTouchedAt").
      await ctx.db.insert("leagueContentPreferences", {
        leagueId: args.leagueId,
        contentEnabled: true,
        timezone: DEFAULT_TIMEZONE,
        notifyCommissioner: true,
        notifyFailures: true,
        autoPublish: true,
        requireApproval: false,
        currentMonthSpent: 0,
        budgetResetDate: now,
        wireEnabled: args.enabled,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, { wireEnabled: args.enabled, updatedAt: now });
    }
    return null;
  },
});
