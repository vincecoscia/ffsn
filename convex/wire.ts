/**
 * The Wire — public surface (ffsn-the-wire-spec.md §2, §4, §8.2, §17). Two paginated reactive
 * queries the client merges (`getGlobalPosts` on `by_created`, `getLeaguePosts` on
 * `by_league_created`), plus the small status/ticker/settings surface the page and header chrome
 * need, plus the social layer (§17): reactions, manager posts/replies, and the manager statements
 * the article writers may quote. The global wire is open to any signed-in league member
 * regardless of pass (spec §1.2's upsell); the league tier, this global tier's per-league
 * overlays, and every social-layer write are pass-gated.
 */

import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { mutation, query, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getLeagueMembership, requireLeagueMember, requireCommissioner } from "./lib/auth";
import { hasActivePass } from "./credits";
import { DEFAULT_TIMEZONE } from "./contentScheduling";
import {
  CARD_MIN_INTEREST,
  EMPTY_REACTION_COUNTS,
  MANAGER_POSTS_PER_DAY,
  MANAGER_POSTS_PER_HOUR,
} from "../src/lib/ai/wire/types";
import type { WireCardPlayer, WireFactCard, WireReaction } from "../src/lib/ai/wire/types";
import { validateFactCard } from "../src/lib/ai/wire/card";
import { moderateManagerText } from "../src/lib/ai/wire/moderate";
import { leagueCurrentSeason } from "./lib/season";
import { teamForUser, userByClerkId } from "./lib/teamClaims";
import { currentMatchupPeriod, managerNameFor, wireEnabled } from "./lib/wireLeaguePosting";
import { resolveLeagueLanguage } from "./languageSettings";
import { commentResponseDataValidator, languageRatingValidator } from "./validators";

/* -------------------------------------------------------------------------- *
 * Shared validators / small helpers
 * -------------------------------------------------------------------------- */

const teamRefValidator = v.object({
  teamId: v.string(),
  name: v.string(),
  abbreviation: v.optional(v.string()),
  logo: v.optional(v.string()),
});

const reactionValidator = v.union(
  v.literal("fire"),
  v.literal("lol"),
  v.literal("salty"),
  v.literal("respect")
);

const reactionsViewValidator = v.object({
  counts: v.object({ fire: v.number(), lol: v.number(), salty: v.number(), respect: v.number() }),
  mine: v.optional(reactionValidator),
});

const authorRefValidator = v.object({
  userId: v.string(),
  displayName: v.string(),
  team: v.optional(teamRefValidator),
});

const replyViewValidator = v.object({
  _id: v.string(),
  kind: v.union(v.literal("manager_reply"), v.literal("writer_reply")),
  author: v.optional(authorRefValidator),
  persona: v.optional(v.string()),
  text: v.string(),
  createdAt: v.number(),
  reactions: reactionsViewValidator,
  deleted: v.optional(v.boolean()),
});

const leaguePostViewValidator = v.object({
  _id: v.string(),
  leagueId: v.string(),
  kind: v.string(),
  persona: v.optional(v.string()),
  author: v.optional(authorRefValidator),
  text: v.string(),
  tags: v.array(v.string()),
  week: v.optional(v.number()),
  createdAt: v.number(),
  reactions: reactionsViewValidator,
  replies: v.array(replyViewValidator),
  deleted: v.optional(v.boolean()),
  canDelete: v.boolean(),
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
  reactions: reactionsViewValidator,
  replies: v.array(replyViewValidator),
});

/** Resolve a team id to the ticket-sized ref the UI renders, tolerating a deleted team. */
async function teamRef(ctx: QueryCtx, teamId: Id<"teams">): Promise<{ teamId: string; name: string; abbreviation?: string; logo?: string }> {
  const team = await ctx.db.get(teamId);
  return team
    ? { teamId: team._id, name: team.name, abbreviation: team.abbreviation, logo: team.logo }
    : { teamId, name: "Unknown team" };
}

/** `WireAuthorRef` for a manager post/reply: `users.name` wins, then the team's ESPN-mirrored
 *  display name or raw owner id (same preference `managerNameFor` already encodes), never blank. */
async function authorRefFor(
  ctx: QueryCtx,
  authorUserId: string,
  authorTeamId: Id<"teams"> | undefined
): Promise<{ userId: string; displayName: string; team?: { teamId: string; name: string; abbreviation?: string; logo?: string } }> {
  const user = await userByClerkId(ctx, authorUserId);
  const team = authorTeamId ? await ctx.db.get(authorTeamId) : null;
  const displayName = user?.name?.trim() || (team ? managerNameFor(team) : undefined) || "A manager";
  return {
    userId: authorUserId,
    displayName,
    team: team ? { teamId: team._id, name: team.name, abbreviation: team.abbreviation, logo: team.logo } : undefined,
  };
}

/** `postKey` convention shared with `wireReactions`/`wireSocialData.ts` (spec §17). */
function postKeyFor(scope: "global" | "league", id: string): string {
  return `${scope}:${id}`;
}

async function reactionsFor(
  ctx: QueryCtx,
  postKey: string,
  viewerId: string | undefined,
  counts: { fire: number; lol: number; salty: number; respect: number } | undefined
): Promise<{ counts: { fire: number; lol: number; salty: number; respect: number }; mine?: WireReaction }> {
  let mine: WireReaction | undefined;
  if (viewerId) {
    const row = await ctx.db
      .query("wireReactions")
      .withIndex("by_post_user", (q) => q.eq("postKey", postKey).eq("userId", viewerId))
      .unique();
    mine = row?.reaction;
  }
  return { counts: counts ?? EMPTY_REACTION_COUNTS, mine };
}

/** Every reply in one thread (root + every nested reply, flattened - see wireSocialData.ts's
 *  header comment for how `rootId` makes this a single bounded range read), oldest first. */
async function repliesFor(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  rootId: string,
  viewerId: string | undefined
): Promise<Array<{
  _id: string;
  kind: "manager_reply" | "writer_reply";
  author?: { userId: string; displayName: string; team?: { teamId: string; name: string; abbreviation?: string; logo?: string } };
  persona?: string;
  text: string;
  createdAt: number;
  reactions: { counts: { fire: number; lol: number; salty: number; respect: number }; mine?: WireReaction };
  deleted?: boolean;
}>> {
  const rows = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_root", (q) => q.eq("leagueId", leagueId).eq("rootId", rootId))
    .order("asc")
    .take(200);

  const out = [];
  for (const row of rows) {
    const deleted = row.deletedAt !== undefined;
    const reactions = await reactionsFor(ctx, postKeyFor("league", row._id), viewerId, row.reactionCounts);
    out.push({
      _id: row._id as string,
      kind: (row.kind === "writer_reply" ? "writer_reply" : "manager_reply") as "manager_reply" | "writer_reply",
      author: row.authorUserId ? await authorRefFor(ctx, row.authorUserId, row.authorTeamId) : undefined,
      persona: row.persona,
      text: deleted ? "This post was removed." : row.text,
      createdAt: row.createdAt,
      reactions,
      deleted: deleted || undefined,
    });
  }
  return out;
}

/** One league-tier post (a root, or an overlay nested under a global post) - shared by
 *  `getLeaguePosts` and `getGlobalPosts`'s `overlaysFor`. */
async function toLeaguePostView(
  ctx: QueryCtx,
  row: Doc<"wireLeaguePosts">,
  viewerId: string | undefined,
  isCommissioner: boolean
) {
  const impact = row.impact ? { team: await teamRef(ctx, row.impact.teamId), variant: row.impact.variant } : undefined;
  const featuredTeams = await Promise.all(row.featuredTeams.map((id) => teamRef(ctx, id)));
  const deleted = row.deletedAt !== undefined;
  const canDelete = viewerId !== undefined && (row.authorUserId === viewerId || isCommissioner);
  const reactions = await reactionsFor(ctx, postKeyFor("league", row._id), viewerId, row.reactionCounts);
  const replies = await repliesFor(ctx, row.leagueId, row._id, viewerId);

  return {
    _id: row._id,
    leagueId: row.leagueId,
    kind: row.kind,
    persona: row.persona,
    author: row.authorUserId ? await authorRefFor(ctx, row.authorUserId, row.authorTeamId) : undefined,
    text: deleted ? "This post was removed." : row.text,
    tags: row.tags,
    week: row.week,
    createdAt: row.createdAt,
    reactions,
    replies,
    deleted: deleted || undefined,
    canDelete,
    globalPostId: row.globalPostId,
    impact,
    featuredTeams,
  };
}

/** Every overlay for this league on one global post, newest first - bounded: a global event has at
 *  most three overlay variants (owner/opponent/freeAgent) per league. */
async function overlaysFor(
  ctx: QueryCtx,
  postId: Id<"wirePosts">,
  leagueId: Id<"leagues">,
  viewerId: string | undefined,
  isCommissioner: boolean
) {
  const rows = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_global_post_league", (q) => q.eq("globalPostId", postId).eq("leagueId", leagueId))
    .take(10);
  return Promise.all(rows.map((row) => toLeaguePostView(ctx, row, viewerId, isCommissioner)));
}

async function toGlobalPostView(
  ctx: QueryCtx,
  post: Doc<"wirePosts">,
  leagueId: Id<"leagues">,
  passActive: boolean,
  viewerId: string | undefined,
  isCommissioner: boolean
) {
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

  const overlays = passActive ? await overlaysFor(ctx, post._id, leagueId, viewerId, isCommissioner) : [];
  const reactions = await reactionsFor(ctx, postKeyFor("global", post._id), viewerId, post.reactionCounts);
  const replies = await repliesFor(ctx, leagueId, post._id, viewerId);

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
    reactions,
    replies,
  };
}

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

export const getGlobalPosts = query({
  args: { leagueId: v.id("leagues"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(globalPostViewValidator),
  handler: async (ctx, args) => {
    const { identity, membership } = await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    const passActive = hasActivePass(league);
    const isCommissioner = membership.role === "commissioner";

    const result = await ctx.db
      .query("wirePosts")
      .withIndex("by_created")
      .order("desc")
      .filter((q) => q.gte(q.field("interest"), CARD_MIN_INTEREST))
      .paginate(args.paginationOpts);

    const page = await Promise.all(
      result.page.map((post) => toGlobalPostView(ctx, post, args.leagueId, passActive, identity.subject, isCommissioner))
    );
    return { ...result, page };
  },
});

export const getLeaguePosts = query({
  args: { leagueId: v.id("leagues"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(leaguePostViewValidator),
  handler: async (ctx, args) => {
    const { identity, membership } = await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    if (!hasActivePass(league)) {
      return { page: [], isDone: true, continueCursor: args.paginationOpts.cursor ?? "" };
    }
    const isCommissioner = membership.role === "commissioner";

    // ROOT posts only: never an overlay (globalPostId set) and never a reply (replyTo set) -
    // overlays are attached to their global post by getGlobalPosts above, and a reply is rendered
    // inside its root's `replies` array, never listed on its own (spec §17).
    const result = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_created", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .filter((q) => q.and(q.eq(q.field("globalPostId"), undefined), q.eq(q.field("replyTo"), undefined)))
      .paginate(args.paginationOpts);

    const page = await Promise.all(result.page.map((row) => toLeaguePostView(ctx, row, identity.subject, isCommissioner)));
    return { ...result, page };
  },
});

export const getWireStatus = query({
  args: { leagueId: v.id("leagues") },
  returns: v.object({
    passActive: v.boolean(),
    wireEnabled: v.boolean(),
    isCommissioner: v.boolean(),
    myTeam: v.optional(teamRefValidator),
    languageRating: languageRatingValidator,
    wireLeaks: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const membership = await getLeagueMembership(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    const prefs = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();

    let myTeam: { teamId: string; name: string; abbreviation?: string; logo?: string } | undefined;
    if (membership) {
      const user = await userByClerkId(ctx, membership.identity.subject);
      const team = await teamForUser(ctx, args.leagueId, user, leagueCurrentSeason(league));
      if (team) myTeam = await teamRef(ctx, team._id);
    }

    const language = await resolveLeagueLanguage(ctx, args.leagueId);

    return {
      passActive: hasActivePass(league),
      wireEnabled: prefs?.wireEnabled !== false,
      isCommissioner: membership?.membership.role === "commissioner",
      myTeam,
      languageRating: language.languageRating,
      wireLeaks: prefs?.wireLeaks !== false,
    };
  },
});

export const getRecentForTicker = query({
  args: { leagueId: v.id("leagues"), limit: v.number() },
  returns: v.array(
    v.object({
      _id: v.string(),
      persona: v.optional(v.string()),
      authorName: v.optional(v.string()),
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

    // Replies and deleted posts never show on the ticker; over-fetch a little to absorb them.
    const leagueRows = passActive
      ? await ctx.db
          .query("wireLeaguePosts")
          .withIndex("by_league_created", (q) => q.eq("leagueId", args.leagueId))
          .order("desc")
          .take(cap * 3)
      : [];
    const leaguePosts = leagueRows.filter((row) => !row.replyTo && row.deletedAt === undefined).slice(0, cap);

    const leagueItems = await Promise.all(
      leaguePosts.map(async (row) => {
        let authorName: string | undefined;
        if (row.authorUserId) {
          authorName = (await authorRefFor(ctx, row.authorUserId, row.authorTeamId)).displayName;
        }
        return {
          _id: row._id as string,
          persona: row.persona,
          authorName,
          text: row.text,
          tags: row.tags,
          createdAt: row.createdAt,
          scope: "league" as const,
        };
      })
    );

    const merged = [
      ...globalPosts.map((p) => ({
        _id: p._id as string,
        persona: p.persona as string | undefined,
        authorName: undefined as string | undefined,
        text: p.text,
        tags: p.tags,
        createdAt: p.createdAt,
        scope: "global" as const,
      })),
      ...leagueItems,
    ];
    merged.sort((a, b) => b.createdAt - a.createdAt);
    return merged.slice(0, cap);
  },
});

/**
 * Manager wire statements quotable by the article writers (spec §17.5): one entry per author who
 * posted (or replied) since `since`, up to 3 of their most recent posts, 6 quotes total across
 * authors. Internal - called from `aiContentHelpers.generateAIContentWithData` and
 * `aiContent.generateContentAction` before generation, same as an interview's `CommentResponseData`.
 */
const MAX_WIRE_QUOTES = 6;
const MAX_WIRE_QUOTES_PER_AUTHOR = 3;
/** Bounded scan of recent league posts - generously above what a league could produce in the
 *  quotable window (spec's own per-league rate limits cap this at 80/day). */
const MANAGER_STATEMENT_SCAN_CAP = 1000;

export const getManagerStatementsForArticle = internalQuery({
  args: { leagueId: v.id("leagues"), since: v.number() },
  returns: v.array(commentResponseDataValidator),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_created", (q) => q.eq("leagueId", args.leagueId).gt("createdAt", args.since))
      .order("desc")
      .take(MANAGER_STATEMENT_SCAN_CAP);

    const byAuthor = new Map<string, Array<Doc<"wireLeaguePosts">>>();
    for (const row of rows) {
      if (row.deletedAt !== undefined) continue;
      if (row.kind !== "manager_post" && row.kind !== "manager_reply") continue;
      if (!row.authorUserId) continue;
      const list = byAuthor.get(row.authorUserId) ?? [];
      list.push(row); // rows arrive newest-first, so each author's list stays newest-first too
      byAuthor.set(row.authorUserId, list);
    }

    const league = await ctx.db.get(args.leagueId);
    const seasonId = leagueCurrentSeason(league);

    const entries: Array<{
      userId: string;
      userName: string;
      teamId: string;
      teamName: string;
      questionTopic: string;
      quotes: string[];
      rawResponse: string;
      source: "wire";
    }> = [];
    let totalQuotes = 0;

    for (const [authorUserId, posts] of byAuthor) {
      if (totalQuotes >= MAX_WIRE_QUOTES) break;
      const user = await userByClerkId(ctx, authorUserId);
      if (!user) continue;
      const team = await teamForUser(ctx, args.leagueId, user, seasonId);

      const take = Math.min(MAX_WIRE_QUOTES_PER_AUTHOR, MAX_WIRE_QUOTES - totalQuotes);
      const quotes = posts.slice(0, take).map((p) => p.text);
      if (quotes.length === 0) continue;
      totalQuotes += quotes.length;

      entries.push({
        userId: user._id as string,
        userName: user.name?.trim() || "A league manager",
        teamId: (team?._id ?? "") as string,
        teamName: team?.name ?? "Unclaimed team",
        questionTopic: "said on The Wire",
        quotes,
        rawResponse: quotes.join("\n"),
        source: "wire",
      });
    }

    return entries;
  },
});

/* -------------------------------------------------------------------------- *
 * Writes
 * -------------------------------------------------------------------------- */

export const react = mutation({
  args: {
    leagueId: v.id("leagues"),
    scope: v.union(v.literal("global"), v.literal("league")),
    postId: v.string(),
    reaction: reactionValidator,
  },
  returns: v.object({ mine: v.union(reactionValidator, v.null()) }),
  handler: async (ctx, args) => {
    const { identity } = await requireLeagueMember(ctx, args.leagueId);

    // Resolved once and reused below (validation, then the reactionCounts patch) - a discriminated
    // union rather than two branches of near-duplicate code, since the two post tables differ.
    const postRef: { table: "wirePosts"; id: Id<"wirePosts"> } | { table: "wireLeaguePosts"; id: Id<"wireLeaguePosts"> } =
      args.scope === "global"
        ? { table: "wirePosts", id: ctx.db.normalizeId("wirePosts", args.postId) as Id<"wirePosts"> }
        : { table: "wireLeaguePosts", id: ctx.db.normalizeId("wireLeaguePosts", args.postId) as Id<"wireLeaguePosts"> };

    if (!postRef.id) throw new Error("Post not found");
    if (postRef.table === "wirePosts") {
      if (!(await ctx.db.get(postRef.id))) throw new Error("Post not found");
    } else {
      const post = await ctx.db.get(postRef.id);
      if (!post || post.leagueId !== args.leagueId) throw new Error("Post not found");
    }

    const postKey = postKeyFor(args.scope, args.postId);
    const existing = await ctx.db
      .query("wireReactions")
      .withIndex("by_post_user", (q) => q.eq("postKey", postKey).eq("userId", identity.subject))
      .unique();

    let mine: WireReaction | null;
    if (existing) {
      if (existing.reaction === args.reaction) {
        await ctx.db.delete(existing._id);
        mine = null;
      } else {
        await ctx.db.patch(existing._id, { reaction: args.reaction });
        mine = args.reaction;
      }
    } else {
      await ctx.db.insert("wireReactions", {
        postKey,
        scope: args.scope,
        leagueId: args.leagueId,
        userId: identity.subject,
        reaction: args.reaction,
        createdAt: Date.now(),
      });
      mine = args.reaction;
    }

    // Recompute the denormalized tally from `by_post` (bounded) - same pattern as
    // articleEngagement's live count, just patched onto the post instead of summed on every read.
    const rows = await ctx.db
      .query("wireReactions")
      .withIndex("by_post", (q) => q.eq("postKey", postKey))
      .take(500);
    const counts = { fire: 0, lol: 0, salty: 0, respect: 0 };
    for (const row of rows) counts[row.reaction]++;

    if (postRef.table === "wirePosts") {
      await ctx.db.patch(postRef.id, { reactionCounts: counts });
    } else {
      await ctx.db.patch(postRef.id, { reactionCounts: counts });
    }

    // Relationship-meter sync (spec §17.2) happens off to the side: a reaction on a manager's own
    // post is a no-op there (wireSocial.syncWireReaction checks and returns early), so this is
    // scheduled unconditionally rather than duplicating that check here.
    await ctx.scheduler.runAfter(0, internal.wireSocial.syncWireReaction, {
      postKey,
      leagueId: args.leagueId,
      userId: identity.subject,
    });

    return { mine };
  },
});

const MANAGER_POST_RATE_SCAN_CAP = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const postAsManager = mutation({
  args: {
    leagueId: v.id("leagues"),
    text: v.string(),
    replyTo: v.optional(v.object({ scope: v.union(v.literal("global"), v.literal("league")), id: v.string() })),
  },
  returns: v.object({ postId: v.id("wireLeaguePosts") }),
  handler: async (ctx, args) => {
    const { identity } = await requireLeagueMember(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    if (!hasActivePass(league)) {
      throw new Error("Posting on The Wire is a League Pass feature");
    }

    const prefs = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .first();
    if (prefs?.wireEnabled === false || !wireEnabled()) {
      throw new Error("The Wire is turned off for this league");
    }

    const seasonId = leagueCurrentSeason(league);
    const user = await userByClerkId(ctx, identity.subject);
    const team = await teamForUser(ctx, args.leagueId, user, seasonId);
    if (!team) {
      throw new Error("Claim your team to post on The Wire");
    }

    const language = await ctx.runQuery(internal.languageSettings.getLeagueLanguage, { leagueId: args.leagueId });
    const moderation = moderateManagerText(args.text, language.languageRating);
    if (!moderation.ok) {
      throw new Error(moderation.violations.join(" "));
    }

    const now = Date.now();
    const recentOwn = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_author_created", (q) =>
        q.eq("leagueId", args.leagueId).eq("authorUserId", identity.subject).gt("createdAt", now - DAY_MS)
      )
      .take(MANAGER_POST_RATE_SCAN_CAP);
    if (recentOwn.length >= MANAGER_POSTS_PER_DAY) {
      throw new Error(`Slow down: ${MANAGER_POSTS_PER_DAY} posts a day`);
    }
    const lastHour = recentOwn.filter((row) => row.createdAt > now - HOUR_MS).length;
    if (lastHour >= MANAGER_POSTS_PER_HOUR) {
      throw new Error(`Slow down: ${MANAGER_POSTS_PER_HOUR} posts an hour`);
    }

    let replyTo: { scope: "global" | "league"; id: string } | undefined;
    let rootScope: "global" | "league" | undefined;
    let rootId: string | undefined;

    if (args.replyTo) {
      if (args.replyTo.scope === "global") {
        const targetId = ctx.db.normalizeId("wirePosts", args.replyTo.id);
        const target = targetId ? await ctx.db.get(targetId) : null;
        if (!target) throw new Error("The post you're replying to no longer exists");
        replyTo = { scope: "global", id: args.replyTo.id };
        // wirePosts is always a root - it carries no replyTo of its own.
        rootScope = "global";
        rootId = args.replyTo.id;
      } else {
        const targetId = ctx.db.normalizeId("wireLeaguePosts", args.replyTo.id);
        const target = targetId ? await ctx.db.get(targetId) : null;
        if (!target || target.leagueId !== args.leagueId || target.deletedAt !== undefined) {
          throw new Error("The post you're replying to no longer exists");
        }
        replyTo = { scope: "league", id: args.replyTo.id };
        // The target's own root when it is itself a reply; otherwise the target IS the root.
        rootScope = target.replyTo ? target.rootScope ?? "league" : "league";
        rootId = target.replyTo ? target.rootId ?? args.replyTo.id : args.replyTo.id;
      }
    }

    const week = (await currentMatchupPeriod(ctx, args.leagueId, seasonId)) ?? undefined;

    const postId = await ctx.db.insert("wireLeaguePosts", {
      leagueId: args.leagueId,
      seasonId,
      week,
      kind: args.replyTo ? "manager_reply" : "manager_post",
      text: moderation.text,
      tags: [],
      featuredTeams: [team._id],
      dedupeKey: `manager:${identity.subject}:${now}`,
      authorUserId: identity.subject,
      authorTeamId: team._id,
      replyTo,
      rootScope,
      rootId,
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.wireSocial.onManagerPost, { leaguePostId: postId });

    // rumor_check (Dex Desk, spec §18): standalone posts only - a reply is never framed as a fresh
    // rumor about the thread it is answering.
    if (!args.replyTo) {
      await ctx.scheduler.runAfter(0, internal.wireDesk.checkRumor, { leaguePostId: postId });
    }

    return { postId };
  },
});

export const deletePost = mutation({
  args: { leagueId: v.id("leagues"), postId: v.id("wireLeaguePosts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, membership } = await requireLeagueMember(ctx, args.leagueId);
    const post = await ctx.db.get(args.postId);
    if (!post || post.leagueId !== args.leagueId) {
      throw new Error("Post not found");
    }
    if (post.deletedAt !== undefined) return null; // already gone - idempotent

    const isAuthor = post.authorUserId === identity.subject;
    const isCommissioner = membership.role === "commissioner";
    if (!isAuthor && !isCommissioner) {
      throw new Error("Not authorized: only the author or the commissioner may delete this post");
    }

    await ctx.db.patch(args.postId, {
      deletedAt: Date.now(),
      deletedBy: isAuthor ? "author" : "commissioner",
    });
    return null;
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

/**
 * Dex Desk leak policy toggle (spec §18, commissioner only): silences `claims_in`,
 * `trade_proposal`, `trade_declined` and the confirm branch of `rumor_check`. Absent means on.
 */
export const setWireLeaks = mutation({
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
        wireLeaks: args.enabled,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, { wireLeaks: args.enabled, updatedAt: now });
    }
    return null;
  },
});
