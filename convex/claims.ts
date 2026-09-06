/**
 * Receipts (spec §8.4).
 *
 * Every writer's explicit predictions are stored on the article that made them
 * (`aiContent.claims`, written with `outcome: "open"` by `aiContent.updateGeneratedContent`).
 * This module settles them against what actually happened and hands the writer their
 * own record back on the next article, so "Mel's Receipts: 4-2" is a fact rather than
 * a boast.
 *
 * Only the mechanically checkable kinds are judged here: `team_win` from `matchups`,
 * `team_finish` from the standings, `player_points` from matchup rosters.
 * `trade_verdict` and `general` stay open for the P3 LLM judge - a claim we cannot
 * check is never counted as a hit or a miss.
 *
 * Claim team ids arrive either as FACTS ids ("T" + ESPN externalId) or as Convex team
 * ids, exactly as in `relationships.recordArticleMentions`; both are accepted.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireLeagueMember } from "./lib/auth";
import { leagueCurrentSeason } from "./lib/season";
import { ACTIVE_WRITERS } from "./relationships";
import { priorClaimValidator, priorRecordValidator } from "./validators";

/* -------------------------------------------------------------------------- */
/* Types and constants                                                          */
/* -------------------------------------------------------------------------- */

type StoredClaim = NonNullable<Doc<"aiContent">["claims"]>[number];
type Outcome = "open" | "hit" | "miss";

/** How many of a writer's articles we look back over. Bounded by design. */
const ARTICLE_SCAN_LIMIT = 200;

/** Default number of prior claims handed to the writer (spec §8.4). */
const DEFAULT_PRIOR_CLAIM_LIMIT = 12;

/**
 * The "Disputed" show's host persona and article type (spec: Disputed). Every episode is
 * an `aiContent` row stamped with the host's own byline (`persona: SHOW_HOST`,
 * `type: SHOW_TYPE`), but its individual claims are stamped with whichever desk member
 * actually made them (`claim.persona`) - not always the host. Defined locally rather than
 * imported from `src/` so this module stays self-contained.
 */
const SHOW_HOST = "curtis-vaughn";
const SHOW_TYPE = "desk_show";

/** How many recent Disputed episodes we scan for a non-host writer's show claims. One
 * season of weekly episodes is well under this. */
const SHOW_SCAN_LIMIT = 60;

/* -------------------------------------------------------------------------- */
/* Id and name normalization                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A claim's team id -> that team's ESPN `externalId`, which is what `matchups`
 * stores in `homeTeamId` / `awayTeamId`. Accepts a Convex team id or a FACTS id.
 * Returns null when the id names no team in this league, which leaves the claim open.
 */
async function teamExternalId(
  ctx: QueryCtx | MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  raw: string | undefined
): Promise<string | null> {
  if (!raw) return null;

  const convexId = ctx.db.normalizeId("teams", raw);
  if (convexId) {
    const team = await ctx.db.get(convexId);
    if (team && team.leagueId === leagueId) return team.externalId;
  }

  const candidates = raw.startsWith("T") ? [raw.slice(1), raw] : [raw];
  for (const externalId of candidates) {
    if (!externalId) continue;
    const team = await ctx.db
      .query("teams")
      .withIndex("by_external", (q) =>
        q
          .eq("leagueId", leagueId)
          .eq("externalId", externalId)
          .eq("seasonId", seasonId)
      )
      .first();
    if (team) return team.externalId;
  }
  return null;
}

/** Player names come from the model; compare on letters and digits only. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Current standings, ranked the way `aiQueries` ranks them: wins, then win
 * percentage, then points for. Computed once per league batch.
 */
function rankTeams(teams: Array<Doc<"teams">>): Map<string, number> {
  const ordered = [...teams].sort((a, b) => {
    if (a.record.wins !== b.record.wins) {
      return (b.record.wins || 0) - (a.record.wins || 0);
    }
    const aGames = (a.record.wins || 0) + (a.record.losses || 0) + (a.record.ties || 0);
    const bGames = (b.record.wins || 0) + (b.record.losses || 0) + (b.record.ties || 0);
    const aPct = aGames > 0 ? (a.record.wins || 0) / aGames : 0;
    const bPct = bGames > 0 ? (b.record.wins || 0) / bGames : 0;
    if (aPct !== bPct) return bPct - aPct;
    return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
  });

  const ranks = new Map<string, number>();
  ordered.forEach((team, index) => ranks.set(team.externalId, index + 1));
  return ranks;
}

interface LeagueResolutionContext {
  leagueId: Id<"leagues">;
  seasonId: number;
  /** The league's latest synced scoring period, or undefined when unknown. */
  currentWeek?: number;
  ranks: Map<string, number>;
  teamCount: number;
}

/** Every matchup of one week, keyed off the unique-matchup index. */
async function matchupsForWeek(
  ctx: QueryCtx | MutationCtx,
  league: LeagueResolutionContext,
  week: number
): Promise<Array<Doc<"matchups">>> {
  return await ctx.db
    .query("matchups")
    .withIndex("by_unique_matchup", (q) =>
      q
        .eq("leagueId", league.leagueId)
        .eq("seasonId", league.seasonId)
        .eq("matchupPeriod", week)
    )
    .collect();
}

/**
 * Judge one claim. Returns `"open"` whenever the data needed to judge it is
 * missing or the event has not happened yet - being unable to check is never a miss.
 */
async function resolveClaim(
  ctx: QueryCtx | MutationCtx,
  league: LeagueResolutionContext,
  claim: StoredClaim
): Promise<Outcome> {
  switch (claim.kind) {
    case "team_win": {
      if (claim.week === undefined) return "open";
      const subject = await teamExternalId(
        ctx,
        league.leagueId,
        league.seasonId,
        claim.subjectTeamId
      );
      if (!subject) return "open";

      const opponent = await teamExternalId(
        ctx,
        league.leagueId,
        league.seasonId,
        claim.opponentTeamId
      );

      const matchups = await matchupsForWeek(ctx, league, claim.week);
      const game = matchups.find((m) => {
        const involvesSubject =
          m.homeTeamId === subject || m.awayTeamId === subject;
        if (!involvesSubject) return false;
        if (!opponent) return true;
        return m.homeTeamId === opponent || m.awayTeamId === opponent;
      });
      if (!game || !game.winner) return "open";

      const won =
        (game.winner === "home" && game.homeTeamId === subject) ||
        (game.winner === "away" && game.awayTeamId === subject);
      return won ? "hit" : "miss";
    }

    case "team_finish": {
      // The standings we have are the current ones, so a claim about a future
      // week cannot be judged yet (spec §8.4).
      if (
        claim.week !== undefined &&
        league.currentWeek !== undefined &&
        claim.week > league.currentWeek
      ) {
        return "open";
      }
      if (claim.minRank === undefined && claim.maxRank === undefined) return "open";

      const subject = await teamExternalId(
        ctx,
        league.leagueId,
        league.seasonId,
        claim.subjectTeamId
      );
      if (!subject) return "open";

      const rank = league.ranks.get(subject);
      if (rank === undefined) return "open";

      const min = claim.minRank ?? 1;
      const max = claim.maxRank ?? league.teamCount;
      return rank >= min && rank <= max ? "hit" : "miss";
    }

    case "player_points": {
      if (
        claim.week === undefined ||
        claim.minPoints === undefined ||
        !claim.subjectPlayer
      ) {
        return "open";
      }

      const subject = await teamExternalId(
        ctx,
        league.leagueId,
        league.seasonId,
        claim.subjectTeamId
      );

      const matchups = await matchupsForWeek(ctx, league, claim.week);
      const wanted = normalizeName(claim.subjectPlayer);
      if (!wanted) return "open";

      for (const matchup of matchups) {
        const sides: Array<{ teamId: string; roster: typeof matchup.homeRoster }> = [
          { teamId: matchup.homeTeamId, roster: matchup.homeRoster },
          { teamId: matchup.awayTeamId, roster: matchup.awayRoster },
        ];
        for (const side of sides) {
          if (subject && side.teamId !== subject) continue;
          const player = side.roster?.players.find(
            (p) => normalizeName(p.fullName) === wanted
          );
          if (player) {
            return player.points >= claim.minPoints ? "hit" : "miss";
          }
        }
      }
      return "open";
    }

    // P3 LLM judge (spec §8.4). Left open rather than guessed at.
    case "trade_verdict":
    case "general":
    default:
      return "open";
  }
}

/* -------------------------------------------------------------------------- */
/* Weekly resolution cron                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Settle every open claim in the league's current season (spec §8.4).
 *
 * Called with no arguments by the Tuesday 09:30 UTC cron: that pass fans out one
 * scheduled run per league, and each league run pages its own articles by
 * `_creationTime` so no single transaction has to hold a whole back catalogue.
 */
export const resolveOpenClaims = internalMutation({
  args: {
    leagueId: v.optional(v.id("leagues")),
    after: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    articlesUpdated: v.number(),
    hits: v.number(),
    misses: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    scanned: number;
    articlesUpdated: number;
    hits: number;
    misses: number;
    isDone: boolean;
  }> => {
    const batchSize = Math.min(Math.max(args.batchSize ?? 50, 1), 200);
    const after = args.after ?? -1;

    // Fan-out pass: page the leagues, schedule one run each.
    if (!args.leagueId) {
      const leagues = await ctx.db
        .query("leagues")
        .withIndex("by_creation_time", (q) => q.gt("_creationTime", after))
        .take(batchSize);

      for (const league of leagues) {
        await ctx.scheduler.runAfter(0, internal.claims.resolveOpenClaims, {
          leagueId: league._id,
        });
      }

      const isDone = leagues.length < batchSize;
      if (!isDone) {
        await ctx.scheduler.runAfter(0, internal.claims.resolveOpenClaims, {
          after: leagues[leagues.length - 1]._creationTime,
          batchSize,
        });
      }
      return {
        scanned: leagues.length,
        articlesUpdated: 0,
        hits: 0,
        misses: 0,
        isDone,
      };
    }

    const league = await ctx.db.get(args.leagueId);
    if (!league) {
      return { scanned: 0, articlesUpdated: 0, hits: 0, misses: 0, isDone: true };
    }

    const seasonId = leagueCurrentSeason(league);
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) =>
        q.eq("leagueId", args.leagueId!).eq("seasonId", seasonId)
      )
      .collect();

    const resolutionContext: LeagueResolutionContext = {
      leagueId: args.leagueId,
      seasonId,
      currentWeek: league.espnData?.currentScoringPeriod,
      ranks: rankTeams(teams),
      teamCount: teams.length,
    };

    const articles = await ctx.db
      .query("aiContent")
      .withIndex("by_league", (q) =>
        q.eq("leagueId", args.leagueId!).gt("_creationTime", after)
      )
      .take(batchSize);

    let articlesUpdated = 0;
    let hits = 0;
    let misses = 0;
    const now = Date.now();

    for (const article of articles) {
      const claims = article.claims;
      if (!claims || claims.length === 0) continue;

      let changed = false;
      const next: StoredClaim[] = [];
      for (const claim of claims) {
        // Only this season's open claims. A claim with no season predates the
        // field and is treated as belonging to the season we are resolving.
        if (claim.outcome !== "open" || (claim.season !== undefined && claim.season !== seasonId)) {
          next.push(claim);
          continue;
        }

        const outcome = await resolveClaim(ctx, resolutionContext, claim);
        if (outcome === "open") {
          next.push(claim);
          continue;
        }

        changed = true;
        if (outcome === "hit") hits++;
        else misses++;
        next.push({ ...claim, outcome, resolvedAt: now });

        // The Wire (ffsn-the-wire-spec.md §5.2/§8.2): "Nina called it" routine post. `next.length -
        // 1` is this claim's stable index within the article's own `claims` array (one push per
        // iterated claim, in order), used as the dedupe key since a stored claim carries no id of
        // its own.
        await ctx.scheduler.runAfter(0, internal.wireRoutine.onClaimSettled, {
          leagueId: article.leagueId,
          articleId: article._id,
          claimIndex: next.length - 1,
          persona: claim.persona,
          text: claim.text,
          outcome,
        });
      }

      if (changed) {
        await ctx.db.patch(article._id, { claims: next });
        articlesUpdated++;
      }
    }

    const isDone = articles.length < batchSize;
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.claims.resolveOpenClaims, {
        leagueId: args.leagueId,
        after: articles[articles.length - 1]._creationTime,
        batchSize,
      });
    }

    return { scanned: articles.length, articlesUpdated, hits, misses, isDone };
  },
});

/* -------------------------------------------------------------------------- */
/* Reads                                                                        */
/* -------------------------------------------------------------------------- */

/** One writer's articles in one league, newest first, bounded. */
async function articlesForWriter(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  persona: string
): Promise<Array<Doc<"aiContent">>> {
  return await ctx.db
    .query("aiContent")
    .withIndex("by_league_persona", (q) =>
      q.eq("leagueId", leagueId).eq("persona", persona)
    )
    .order("desc")
    .take(ARTICLE_SCAN_LIMIT);
}

/** The league's recent Disputed episodes - `desk_show` rows under the host's own
 * byline - newest first, bounded. Individual claims on these rows may belong to any
 * desk member (spec: Disputed). */
async function showArticlesForLeague(
  ctx: QueryCtx,
  leagueId: Id<"leagues">
): Promise<Array<Doc<"aiContent">>> {
  const rows = await ctx.db
    .query("aiContent")
    .withIndex("by_league_persona", (q) =>
      q.eq("leagueId", leagueId).eq("persona", SHOW_HOST)
    )
    .order("desc")
    .take(SHOW_SCAN_LIMIT);
  return rows.filter((row) => row.type === SHOW_TYPE);
}

/**
 * Every article that can carry one of this persona's claims: their own byline
 * (`articlesForWriter`) plus the league's Disputed episodes, whose claims are stamped
 * per-speaker rather than by the show's own byline (spec: Disputed). When `persona` is
 * the show host itself, its own byline query above already returns every episode, so the
 * show rows are not fetched a second time. Newest first, bounded, deduped.
 */
async function claimSourceArticlesForWriter(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  persona: string
): Promise<Array<Doc<"aiContent">>> {
  const own = await articlesForWriter(ctx, leagueId, persona);
  if (persona === SHOW_HOST) return own;

  const shows = await showArticlesForLeague(ctx, leagueId);
  if (shows.length === 0) return own;

  return [...own, ...shows].sort((a, b) => b._creationTime - a._creationTime);
}

/**
 * A claim's own `persona` wins over its article's (spec: Disputed): a multi-speaker piece like
 * the "Disputed" show stamps each claim with the desk member who actually made it, which is not
 * always the article's own byline (the host, for a show). `persona` is a required field on every
 * stored claim (`updateGeneratedContent` always stamps one), so this only ever falls back to
 * `article.persona` for rows written before that field existed.
 */
function countRecord(articles: Array<Doc<"aiContent">>, persona: string) {
  let hits = 0;
  let misses = 0;
  let open = 0;
  for (const article of articles) {
    for (const claim of article.claims ?? []) {
      if ((claim.persona ?? article.persona) !== persona) continue;
      if (claim.outcome === "hit") hits++;
      else if (claim.outcome === "miss") misses++;
      else open++;
    }
  }
  return { hits, misses, open };
}

/**
 * Every id form a caller's `teamIds` filter could match: the string as given, the
 * FACTS id with its "T" stripped, and both the Convex id and `externalId` of any
 * team it resolves to. Claim ids are matched against this set on either side.
 */
async function expandTeamIds(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  teamIds: string[]
): Promise<Set<string>> {
  const set = new Set<string>();
  for (const raw of teamIds) {
    if (!raw) continue;
    set.add(raw);
    if (raw.startsWith("T")) set.add(raw.slice(1));

    const externalId = await teamExternalId(ctx, leagueId, seasonId, raw);
    if (externalId) {
      set.add(externalId);
      set.add(`T${externalId}`);
      const team = await ctx.db
        .query("teams")
        .withIndex("by_external", (q) =>
          q
            .eq("leagueId", leagueId)
            .eq("externalId", externalId)
            .eq("seasonId", seasonId)
        )
        .first();
      if (team) set.add(team._id as string);
    }
  }
  return set;
}

/**
 * The writer's own back catalogue for the FACTS block (spec §8.4).
 *
 * `items` are this persona's claims in this league, newest first, optionally
 * narrowed to the teams the article is about. `record` always counts every claim
 * the persona has made in the league, filter or no filter - a writer's record is
 * their record, not a slice of it.
 */
export const getPriorClaimsForWriter = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    persona: v.string(),
    teamIds: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    items: v.array(priorClaimValidator),
    record: priorRecordValidator,
  }),
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(args.limit ?? DEFAULT_PRIOR_CLAIM_LIMIT, 1),
      50
    );

    const articles = await claimSourceArticlesForWriter(ctx, args.leagueId, args.persona);
    const record = countRecord(articles, args.persona);

    let wanted: Set<string> | null = null;
    if (args.teamIds && args.teamIds.length > 0) {
      const league = await ctx.db.get(args.leagueId);
      wanted = await expandTeamIds(
        ctx,
        args.leagueId,
        leagueCurrentSeason(league),
        args.teamIds
      );
    }

    const items = [];
    for (const article of articles) {
      for (const claim of article.claims ?? []) {
        if ((claim.persona ?? article.persona) !== args.persona) continue;
        if (wanted) {
          const touches =
            (claim.subjectTeamId && wanted.has(claim.subjectTeamId)) ||
            (claim.opponentTeamId && wanted.has(claim.opponentTeamId));
          if (!touches) continue;
        }
        items.push({
          articleId: article._id as string,
          week: claim.week,
          claim: claim.text,
          outcome: claim.outcome,
        });
        if (items.length >= limit) return { items, record };
      }
    }

    return { items, record };
  },
});

/**
 * Every active writer's prediction record in one league, for the lineup cards
 * ("Receipts 4-2"). Any league member may read it.
 */
export const getWriterRecords = query({
  args: { leagueId: v.id("leagues") },
  returns: v.array(
    v.object({
      persona: v.string(),
      hits: v.number(),
      misses: v.number(),
      open: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    await requireLeagueMember(ctx, args.leagueId);

    const records = [];
    for (const persona of ACTIVE_WRITERS) {
      const articles = await claimSourceArticlesForWriter(ctx, args.leagueId, persona);
      records.push({ persona, ...countRecord(articles, persona) });
    }
    return records;
  },
});
