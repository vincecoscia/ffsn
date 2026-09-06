/**
 * The Wire — detectors (ffsn-the-wire-spec.md §6, §7, §8.2). Default Convex runtime: every
 * detector here is a plain mutation, so a poller (`wireSourcesNode.ts`, "use node") or a hook at
 * an existing sync site can schedule straight into it without crossing a runtime boundary.
 *
 * Every `ingest*` function follows the same shape: build a `WireFactCard` (validated by the pure
 * `src/lib/ai/wire/card.ts`), dedupe against `wireEvents.by_dedupe`, score interest
 * (`src/lib/ai/wire/interest.ts`), insert the event, and — above the interest floor — create the
 * global `wirePosts` row (a plain card immediately, or `take_pending` for the batch generator in
 * `wireGenerate.ts` to pick up). `getPendingTakes`/`applyTake`/`failTake` are that generator's other
 * side of the same table; `getSourceCursor`/`recordSourceRun` are the pollers' cursor + health
 * bookkeeping (mirrors `convex/intelSync.ts`'s `intelSyncRuns`, with an actual cursor payload).
 *
 * Every read here is bounded (indexed range + `.take()`) per the repo's Convex guidelines — see
 * each helper's comment for why its cap is safe. Nothing throws: a card that fails validation is
 * logged and skipped, never a failed mutation (a detector must never take down its whole batch over
 * one malformed source row).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { nflSeasonYearFor } from "./lib/season";
import {
  CARD_MIN_INTEREST,
  COALESCE_WINDOW_MS,
  GLOBAL_TAKES_PER_HOUR,
  MAX_NOTE_CHARS,
  MAX_POST_CHARS,
  SAME_PLAYER_PENALTY_WINDOW_MS,
  STATUS_DEDUPE_WINDOW_MS,
  TAKE_MIN_INTEREST,
  WIRE_DEFAULT_ROUTE,
  WIRE_PERSONA_FOR_KIND,
} from "../src/lib/ai/wire/types";
import type { GlobalEventKind, InjuryStatus, WireCardPlayer, WireFactCard } from "../src/lib/ai/wire/types";
import { extractTimetable } from "../src/lib/ai/wire/timetable";
import { scoreInterest } from "../src/lib/ai/wire/interest";
import { validateFactCard, renderCard } from "../src/lib/ai/wire/card";
import { injuryEntryToCard, newsArticleToCard, type EspnInjuryEntry, type EspnNewsArticle } from "../src/lib/ai/wire/espn";
import { wireEnabled } from "./lib/wireLeaguePosting";

/** A status change re-reported inside this window is a "daily" confirmation, not a new event —
 *  same idea as `STATUS_DEDUPE_WINDOW_MS` (6h) but for depth-chart moves, which the source (a
 *  4-hourly Sleeper sync) can otherwise flap on across consecutive runs in the same day. */
const DEPTH_CHART_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- *
 * Shared helpers
 * -------------------------------------------------------------------------- */

function clampInterest(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Fill in a card player's gaps from `playersEnhanced` (current season, falling back to last season
 * for a player whose new-season row hasn't synced yet): position/nflTeam/percentOwned, and - when
 * the caller had nothing better than the espnId itself as a placeholder (the Sleeper-derived hooks
 * carry no name) - a display name. Never overwrites a real value the caller already had (an
 * ESPN-sourced card's own name/position/team are more current than a synced snapshot).
 * `adpPositionRank` is deliberately left unset: no P1 ingest path needs it, and resolving ADP would
 * mean an extra playerIntel scan per player on every event.
 */
async function enrichCardPlayers(ctx: MutationCtx, players: WireCardPlayer[]): Promise<WireCardPlayer[]> {
  const season = nflSeasonYearFor();
  const out: WireCardPlayer[] = [];
  for (const player of players) {
    let row = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_espn_id_season", (q) => q.eq("espnId", player.espnId).eq("season", season))
      .first();
    if (!row) {
      row = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_espn_id_season", (q) => q.eq("espnId", player.espnId).eq("season", season - 1))
        .first();
    }
    out.push({
      ...player,
      name: player.name && player.name !== player.espnId ? player.name : (row?.fullName ?? player.name),
      position: player.position ?? row?.defaultPosition,
      nflTeam: player.nflTeam ?? row?.proTeamAbbrev,
      percentOwned: player.percentOwned ?? row?.ownership.percentOwned,
    });
  }
  return out;
}

/** `enrichCardPlayers` for the single-player case (every Sleeper-derived ingest path). */
async function enrichOnePlayer(ctx: MutationCtx, base: WireCardPlayer): Promise<WireCardPlayer> {
  const [enriched] = await enrichCardPlayers(ctx, [base]);
  return enriched;
}

/** This player's `ownership.percentOwned`, when known - the one enrichment `injuryEntryToCard`
 *  needs from us (everything else it can build straight off the ESPN payload). */
async function lookupPercentOwned(ctx: MutationCtx, espnId: string): Promise<number | undefined> {
  const season = nflSeasonYearFor();
  let row = await ctx.db
    .query("playersEnhanced")
    .withIndex("by_espn_id_season", (q) => q.eq("espnId", espnId).eq("season", season))
    .first();
  if (!row) {
    row = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_espn_id_season", (q) => q.eq("espnId", espnId).eq("season", season - 1))
      .first();
  }
  return row?.ownership.percentOwned;
}

/** Does a row with this exact dedupe key already exist, ever (replay protection, spec §6)? */
async function existsExact(ctx: MutationCtx, dedupeKey: string): Promise<boolean> {
  const row = await ctx.db
    .query("wireEvents")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
    .first();
  return row !== null;
}

/** Does a row with this exact dedupe key exist within `windowMs` (a "confirmation", spec §6/§7)? */
async function dedupeWithinWindow(
  ctx: MutationCtx,
  dedupeKey: string,
  windowMs: number,
  now: number
): Promise<boolean> {
  // Bounded: at most a handful of rows ever share one dedupe key inside any window this short.
  const rows = await ctx.db
    .query("wireEvents")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
    .order("desc")
    .take(5);
  return rows.some((row) => now - row.detectedAt < windowMs);
}

/**
 * The newest event for this player within the §7 penalty window, across every kind — the signal
 * `scoreInterest` uses for "same player already posted within 6h". Bounded to a `by_detected`
 * window scan (spec §4 note: `players` is deliberately not indexed).
 */
async function recentSamePlayerPostAt(
  ctx: MutationCtx,
  espnId: string,
  now: number
): Promise<number | undefined> {
  const event = await ctx.db
    .query("wireEvents")
    .withIndex("by_player_detected", (q) =>
      q.eq("primaryEspnId", espnId).gt("detectedAt", now - SAME_PLAYER_PENALTY_WINDOW_MS)
    )
    .order("desc")
    .first();
  return event?.detectedAt;
}

/** The most recent *posted* event for this player within the coalesce window (spec §6), if any. */
async function findCoalesceTarget(
  ctx: MutationCtx,
  espnId: string,
  now: number
): Promise<{ eventId: Id<"wireEvents">; postId: Id<"wirePosts"> } | null> {
  const events = await ctx.db
    .query("wireEvents")
    .withIndex("by_player_detected", (q) => q.eq("primaryEspnId", espnId).gt("detectedAt", now - COALESCE_WINDOW_MS))
    .order("desc")
    .take(10);
  for (const event of events) {
    if (event.coalescedInto) continue;
    const post = await ctx.db
      .query("wirePosts")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .first();
    if (post) return { eventId: event._id, postId: post._id };
  }
  return null;
}

/** Posts with status `take`/`take_pending` created in the last hour — the global rate limit's own count (spec §11). */
async function countRecentTakePosts(ctx: MutationCtx, now: number): Promise<number> {
  const hourAgo = now - 60 * 60 * 1000;
  const [pending, taken] = await Promise.all([
    ctx.db
      .query("wirePosts")
      .withIndex("by_status_created", (q) => q.eq("status", "take_pending").gt("createdAt", hourAgo))
      .take(200),
    ctx.db
      .query("wirePosts")
      .withIndex("by_status_created", (q) => q.eq("status", "take").gt("createdAt", hourAgo))
      .take(200),
  ]);
  return pending.length + taken.length;
}

/**
 * Insert the global `wirePosts` row for a freshly-inserted event, or do nothing when the event is
 * below the posting floor (spec §7: stored, never shown) - returns whether it actually posted, so
 * callers count `posted` correctly instead of assuming every call inserts a row. Below the take
 * floor it posts as a plain card with no model call; at/above it, `take_pending` unless the hourly
 * take budget is spent, in which case it's downgraded to a card with a `rate_limited` flag (spec
 * §11). A card is fanned out to leagues immediately; a `take_pending` post is fanned out later,
 * when its take lands or fails.
 *
 * Exported so `wireLiveData.ts` (the live game engine, spec §19) can post its five live kinds
 * through this exact same path, per the spec: "every event goes through the existing global
 * posting path".
 */
export async function createPostForEvent(
  ctx: MutationCtx,
  now: number,
  eventId: Id<"wireEvents">,
  kind: GlobalEventKind,
  card: WireFactCard,
  interest: number
): Promise<boolean> {
  if (interest < CARD_MIN_INTEREST) return false;
  if (!wireEnabled()) return false;

  const persona = WIRE_PERSONA_FOR_KIND[kind];
  const rendered = renderCard(card);

  let status: "card" | "take_pending" = "card";
  let flags: string[] = [];
  if (interest >= TAKE_MIN_INTEREST) {
    const takesLastHour = await countRecentTakePosts(ctx, now);
    if (takesLastHour >= GLOBAL_TAKES_PER_HOUR) {
      flags = ["rate_limited"];
    } else {
      status = "take_pending";
    }
  }

  const postId = await ctx.db.insert("wirePosts", {
    eventId,
    kind,
    persona,
    text: rendered.text,
    tags: rendered.tags,
    status,
    interest,
    generationStats:
      flags.length > 0
        ? { costUsd: 0, model: WIRE_DEFAULT_ROUTE.model, effort: WIRE_DEFAULT_ROUTE.effort, flags }
        : undefined,
    createdAt: now,
    updatedAt: now,
  });

  if (status === "card") {
    await ctx.scheduler.runAfter(0, internal.wireOverlay.fanOutGlobalPost, { postId });
  }
  return true;
}

/* -------------------------------------------------------------------------- *
 * Source cursor + health (mirrors intelSyncRuns, with an actual cursor)
 * -------------------------------------------------------------------------- */

export const getSourceCursor = internalQuery({
  args: { source: v.string() },
  returns: v.union(v.object({ cursor: v.optional(v.any()), lastRunAt: v.number(), ok: v.boolean() }), v.null()),
  handler: async (ctx, { source }) => {
    const row = await ctx.db
      .query("wireSourceState")
      .withIndex("by_source", (q) => q.eq("source", source))
      .first();
    if (!row) return null;
    return { cursor: row.cursor, lastRunAt: row.lastRunAt, ok: row.ok };
  },
});

export const recordSourceRun = internalMutation({
  args: {
    source: v.string(),
    cursor: v.optional(v.any()),
    ok: v.boolean(),
    summary: v.string(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("wireSourceState")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .first();
    const patch = { cursor: args.cursor, lastRunAt: now, ok: args.ok, summary: args.summary, error: args.error };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("wireSourceState", { source: args.source, ...patch });
    }
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * ESPN injuries (pollEspnInjuries -> here)
 * -------------------------------------------------------------------------- */

const espnInjuryEntryValidator = v.object({
  id: v.string(),
  status: v.string(),
  date: v.optional(v.string()),
  shortComment: v.optional(v.string()),
  longComment: v.optional(v.string()),
  typeAbbreviation: v.optional(v.string()),
  athlete: v.object({
    espnId: v.string(),
    name: v.string(),
    position: v.optional(v.string()),
    nflTeam: v.optional(v.string()),
  }),
});

/**
 * Same-status-decision rule `src/lib/ai/wire/espn.ts#injuryEntryToCard` uses internally (a missing
 * `previousStatus` defaults to "Active"), duplicated here only so the dedupe key can be chosen
 * *before* building the card - the detector, the poller (which reads this same default off its
 * cursor) and the eval script all decide injury_status vs injury_note this same way.
 */
function isInjuryStatusChange(entry: EspnInjuryEntry, previousStatus: string | undefined): boolean {
  const from = (previousStatus ?? "Active").trim().toLowerCase();
  return from !== entry.status.trim().toLowerCase();
}

export const ingestInjuryEntries = internalMutation({
  args: {
    entries: v.array(v.object({ entry: espnInjuryEntryValidator, previousStatus: v.optional(v.string()) })),
    fetchedAt: v.number(),
  },
  returns: v.object({ posted: v.number(), coalesced: v.number(), skipped: v.number() }),
  handler: async (ctx, { entries, fetchedAt }) => {
    let posted = 0;
    let coalesced = 0;
    let skipped = 0;
    const now = Date.now();

    for (const { entry, previousStatus } of entries) {
      const isStatusChange = isInjuryStatusChange(entry, previousStatus);
      const kind: GlobalEventKind = isStatusChange ? "injury_status" : "injury_note";

      const dedupeKey = isStatusChange
        ? `injury_status:${entry.athlete.espnId}:${entry.status}`
        : `injury_note:${entry.id}:${entry.date ?? ""}`;
      const isDuplicate = isStatusChange
        ? await dedupeWithinWindow(ctx, dedupeKey, STATUS_DEDUPE_WINDOW_MS, now)
        : await existsExact(ctx, dedupeKey);
      if (isDuplicate) {
        skipped++;
        continue;
      }

      // Resolve the athlete against playersEnhanced BEFORE the card is built: `injuryEntryToCard`'s
      // timetable rule only lifts a phrase from a sentence naming the player, so a placeholder name
      // (the dev tool passes the espnId) would silently drop "6-8 weeks" (found 2026-09-05).
      const athlete = await enrichOnePlayer(ctx, {
        espnId: entry.athlete.espnId,
        name: entry.athlete.name,
        position: entry.athlete.position,
      });
      const resolvedEntry = {
        ...entry,
        athlete: { ...entry.athlete, name: athlete.name, position: athlete.position ?? entry.athlete.position },
      };
      const percentOwned = athlete.percentOwned ?? (await lookupPercentOwned(ctx, entry.athlete.espnId));
      const rawCard = injuryEntryToCard(resolvedEntry, { fetchedAt, statusFrom: previousStatus, percentOwned });
      if (athlete.nflTeam) {
        rawCard.players = rawCard.players.map((p) => ({ ...p, nflTeam: p.nflTeam ?? athlete.nflTeam }));
        rawCard.nflTeam = rawCard.nflTeam ?? athlete.nflTeam;
      }

      let card: WireFactCard;
      try {
        card = validateFactCard(rawCard);
      } catch (err) {
        console.warn(`wireDetect.ingestInjuryEntries: invalid card for espnId ${entry.athlete.espnId}`, err);
        skipped++;
        continue;
      }

      const recentAt = await recentSamePlayerPostAt(ctx, entry.athlete.espnId, now);
      const interest = clampInterest(scoreInterest(card, { recentSamePlayerPostAt: recentAt, now }));

      if (!isStatusChange) {
        const target = await findCoalesceTarget(ctx, entry.athlete.espnId, now);
        if (target) {
          await ctx.db.insert("wireEvents", {
            kind,
            dedupeKey,
            observedAt: card.observedAt,
            detectedAt: now,
            players: card.players,
            primaryEspnId: (card.players)[0]?.espnId,
            nflTeam: card.nflTeam,
            facts: card,
            interest,
            source: card.source,
            coalescedInto: target.eventId,
          });
          const updateText = `UPDATE: ${renderCard(card).text}`.slice(0, MAX_POST_CHARS);
          await ctx.db.patch(target.postId, { text: updateText, updatedAt: now });
          coalesced++;
          continue;
        }
      }

      const eventId = await ctx.db.insert("wireEvents", {
        kind,
        dedupeKey,
        observedAt: card.observedAt,
        detectedAt: now,
        players: card.players,
        primaryEspnId: (card.players)[0]?.espnId,
        nflTeam: card.nflTeam,
        facts: card,
        interest,
        source: card.source,
      });
      if (await createPostForEvent(ctx, now, eventId, kind, card, interest)) posted++;
    }

    return { posted, coalesced, skipped };
  },
});

/* -------------------------------------------------------------------------- *
 * ESPN news (news.ts's storeNewsArticles -> here, article espnIds only)
 * -------------------------------------------------------------------------- */

export const ingestNews = internalMutation({
  args: { espnIds: v.array(v.string()) },
  returns: v.object({ posted: v.number(), skipped: v.number() }),
  handler: async (ctx, { espnIds }) => {
    let posted = 0;
    let skipped = 0;
    const now = Date.now();

    for (const articleEspnId of espnIds) {
      const article = await ctx.db
        .query("espnNews")
        .withIndex("by_espn_id", (q) => q.eq("espnId", articleEspnId))
        .first();
      if (!article) {
        skipped++;
        continue;
      }

      // Adapt the already-parsed, already-stored row (convex/espnNews.ts's own transform) into the
      // shape src/lib/ai/wire/espn.ts expects, so the listicle filter, note-trimming and
      // player-scoped timetable extraction are the same logic the poller/eval script use.
      const espnArticle: EspnNewsArticle = {
        id: article.espnId,
        headline: article.headline,
        description: article.description,
        published: article.published,
        url: article.links.web,
        athletes: article.categories.athletes.map((athlete) => ({ espnId: String(athlete.id), name: athlete.name })),
      };
      const rawCard = newsArticleToCard(espnArticle, { fetchedAt: now });
      if (!rawCard) {
        skipped++; // 0 or > NEWS_MAX_ATHLETES athletes (spec §5.1's listicle filter)
        continue;
      }

      const dedupeKey = `news:${articleEspnId}`;
      if (await existsExact(ctx, dedupeKey)) {
        skipped++;
        continue;
      }

      const enrichedPlayers = await enrichCardPlayers(ctx, rawCard.players);
      const cardInput = { ...rawCard, players: enrichedPlayers, nflTeam: enrichedPlayers[0]?.nflTeam };

      let card: WireFactCard;
      try {
        card = validateFactCard(cardInput);
      } catch (err) {
        console.warn(`wireDetect.ingestNews: invalid card for article ${articleEspnId}`, err);
        skipped++;
        continue;
      }

      const recentAt = card.players[0] ? await recentSamePlayerPostAt(ctx, card.players[0].espnId, now) : undefined;
      const interest = clampInterest(scoreInterest(card, { recentSamePlayerPostAt: recentAt, now }));

      const eventId = await ctx.db.insert("wireEvents", {
        kind: "news",
        dedupeKey,
        observedAt: card.observedAt,
        detectedAt: now,
        players: card.players,
        primaryEspnId: (card.players)[0]?.espnId,
        nflTeam: card.nflTeam,
        facts: card,
        interest,
        source: card.source,
      });
      if (await createPostForEvent(ctx, now, eventId, "news", card, interest)) posted++;
    }

    return { posted, skipped };
  },
});

/* -------------------------------------------------------------------------- *
 * Sleeper: status change, depth chart, trending (intelSync.ts hooks -> here)
 * -------------------------------------------------------------------------- */

const statusChangeRowValidator = v.object({
  espnId: v.string(),
  statusFrom: v.optional(v.string()),
  statusTo: v.string(),
  team: v.optional(v.string()),
  position: v.optional(v.string()),
  notes: v.optional(v.string()),
  observedAt: v.optional(v.number()),
});

/** Sleeper-sourced injury status changes feed the same `injury_status` kind and dedupe space as
 *  ESPN's own poller (`ingestInjuryEntries`) — a status either source already reported inside the
 *  window is a confirmation, not a second event (spec §6/§7). */
export const ingestStatusChange = internalMutation({
  args: { rows: v.array(statusChangeRowValidator) },
  returns: v.object({ posted: v.number(), skipped: v.number() }),
  handler: async (ctx, { rows }) => {
    let posted = 0;
    let skipped = 0;
    const now = Date.now();

    for (const row of rows) {
      const dedupeKey = `injury_status:${row.espnId}:${row.statusTo}`;
      if (await dedupeWithinWindow(ctx, dedupeKey, STATUS_DEDUPE_WINDOW_MS, now)) {
        skipped++;
        continue;
      }

      const enriched = await enrichOnePlayer(ctx, { espnId: row.espnId, name: row.espnId, position: row.position, nflTeam: row.team });
      const note = row.notes ? row.notes.slice(0, MAX_NOTE_CHARS) : undefined;
      const cardInput = {
        kind: "injury_status" as const,
        observedAt: row.observedAt ?? now,
        players: [enriched],
        nflTeam: enriched.nflTeam,
        statusFrom: row.statusFrom as InjuryStatus | undefined,
        statusTo: row.statusTo as InjuryStatus,
        note,
        timetable: extractTimetable(note),
        source: { type: "sleeper" as const, fetchedAt: now },
      };

      let card: WireFactCard;
      try {
        card = validateFactCard(cardInput);
      } catch (err) {
        console.warn(`wireDetect.ingestStatusChange: invalid card for espnId ${row.espnId}`, err);
        skipped++;
        continue;
      }

      const recentAt = await recentSamePlayerPostAt(ctx, row.espnId, now);
      const interest = clampInterest(scoreInterest(card, { recentSamePlayerPostAt: recentAt, now }));

      const eventId = await ctx.db.insert("wireEvents", {
        kind: "injury_status",
        dedupeKey,
        observedAt: cardInput.observedAt,
        detectedAt: now,
        players: [enriched],
        primaryEspnId: ([enriched])[0]?.espnId,
        nflTeam: enriched.nflTeam,
        facts: card,
        interest,
        source: cardInput.source,
      });
      if (await createPostForEvent(ctx, now, eventId, "injury_status", card, interest)) posted++;
    }

    return { posted, skipped };
  },
});

const depthChartRowValidator = v.object({
  espnId: v.string(),
  depthOrderFrom: v.optional(v.number()),
  depthOrderTo: v.number(),
  team: v.optional(v.string()),
  position: v.optional(v.string()),
  observedAt: v.optional(v.number()),
});

export const ingestDepthChart = internalMutation({
  args: { rows: v.array(depthChartRowValidator) },
  returns: v.object({ posted: v.number(), skipped: v.number() }),
  handler: async (ctx, { rows }) => {
    let posted = 0;
    let skipped = 0;
    const now = Date.now();

    for (const row of rows) {
      const dedupeKey = `depth_chart:${row.espnId}:${row.depthOrderTo}`;
      if (await dedupeWithinWindow(ctx, dedupeKey, DEPTH_CHART_DEDUPE_WINDOW_MS, now)) {
        skipped++;
        continue;
      }

      const enriched = await enrichOnePlayer(ctx, { espnId: row.espnId, name: row.espnId, position: row.position, nflTeam: row.team });
      const cardInput = {
        kind: "depth_chart" as const,
        observedAt: row.observedAt ?? now,
        players: [enriched],
        nflTeam: enriched.nflTeam,
        depthOrderFrom: row.depthOrderFrom,
        depthOrderTo: row.depthOrderTo,
        depthPosition: row.position ?? enriched.position,
        source: { type: "sleeper" as const, fetchedAt: now },
      };

      let card: WireFactCard;
      try {
        card = validateFactCard(cardInput);
      } catch (err) {
        console.warn(`wireDetect.ingestDepthChart: invalid card for espnId ${row.espnId}`, err);
        skipped++;
        continue;
      }

      const recentAt = await recentSamePlayerPostAt(ctx, row.espnId, now);
      const interest = clampInterest(scoreInterest(card, { recentSamePlayerPostAt: recentAt, now }));

      const eventId = await ctx.db.insert("wireEvents", {
        kind: "depth_chart",
        dedupeKey,
        observedAt: cardInput.observedAt,
        detectedAt: now,
        players: [enriched],
        primaryEspnId: ([enriched])[0]?.espnId,
        nflTeam: enriched.nflTeam,
        facts: card,
        interest,
        source: cardInput.source,
      });
      if (await createPostForEvent(ctx, now, eventId, "depth_chart", card, interest)) posted++;
    }

    return { posted, skipped };
  },
});

/** How many of one Sleeper trending sync's rows may become takes (the rest are cards). */
const TRENDING_TAKES_PER_SYNC = 3;

const trendingRowValidator = v.object({
  espnId: v.string(),
  trendingAdds: v.number(),
  team: v.optional(v.string()),
  position: v.optional(v.string()),
});

export const ingestTrending = internalMutation({
  args: { rows: v.array(trendingRowValidator) },
  returns: v.object({ posted: v.number(), skipped: v.number() }),
  handler: async (ctx, { rows }) => {
    let posted = 0;
    let skipped = 0;
    const now = Date.now();
    const dateKey = new Date(now).toISOString().slice(0, 10);

    // One sync's trending board is a ranking, not eight separate stories (beta, 2026-09-05: eight
    // Nina takes from one preseason waiver frenzy). Only the top three by adds may earn a take; the
    // rest post as plain cards.
    const takeEligible = new Set(
      [...rows]
        .sort((a, b) => b.trendingAdds - a.trendingAdds)
        .slice(0, TRENDING_TAKES_PER_SYNC)
        .map((row) => row.espnId)
    );

    for (const row of rows) {
      const dedupeKey = `trending:${row.espnId}:${dateKey}`;
      if (await existsExact(ctx, dedupeKey)) {
        skipped++;
        continue;
      }

      const enriched = await enrichOnePlayer(ctx, { espnId: row.espnId, name: row.espnId, position: row.position, nflTeam: row.team });
      const cardInput = {
        kind: "trending" as const,
        observedAt: now,
        players: [enriched],
        nflTeam: enriched.nflTeam,
        trendingAdds: row.trendingAdds,
        source: { type: "sleeper" as const, fetchedAt: now },
      };

      let card: WireFactCard;
      try {
        card = validateFactCard(cardInput);
      } catch (err) {
        console.warn(`wireDetect.ingestTrending: invalid card for espnId ${row.espnId}`, err);
        skipped++;
        continue;
      }

      const recentAt = await recentSamePlayerPostAt(ctx, row.espnId, now);
      const rawInterest = clampInterest(scoreInterest(card, { recentSamePlayerPostAt: recentAt, now }));
      const interest = takeEligible.has(row.espnId) ? rawInterest : Math.min(rawInterest, TAKE_MIN_INTEREST - 1);

      const eventId = await ctx.db.insert("wireEvents", {
        kind: "trending",
        dedupeKey,
        observedAt: now,
        detectedAt: now,
        players: [enriched],
        primaryEspnId: ([enriched])[0]?.espnId,
        nflTeam: enriched.nflTeam,
        facts: card,
        interest,
        source: cardInput.source,
      });
      if (await createPostForEvent(ctx, now, eventId, "trending", card, interest)) posted++;
    }

    return { posted, skipped };
  },
});

/* -------------------------------------------------------------------------- *
 * Take batch plumbing (wireGenerate.ts's other side)
 * -------------------------------------------------------------------------- */

/** Pending take requests for the batch flush, bounded to a window well above the hourly cap. */
export const getPendingTakes = internalQuery({
  args: {},
  returns: v.array(v.object({ postId: v.id("wirePosts"), persona: v.string(), card: v.any() })),
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("wirePosts")
      .withIndex("by_status_created", (q) => q.eq("status", "take_pending"))
      .take(200);
    const out: Array<{ postId: Id<"wirePosts">; persona: string; card: unknown }> = [];
    for (const post of pending) {
      const event = await ctx.db.get(post.eventId);
      if (!event) continue;
      out.push({ postId: post._id, persona: post.persona, card: event.facts });
    }
    return out;
  },
});

const wireTakeSetValidator = v.object({
  global: v.string(),
  owner: v.optional(v.string()),
  opponent: v.optional(v.string()),
  freeAgent: v.optional(v.string()),
  tags: v.array(v.string()),
});

export const applyTake = internalMutation({
  args: {
    postId: v.id("wirePosts"),
    take: wireTakeSetValidator,
    stats: v.object({
      costUsd: v.number(),
      model: v.string(),
      effort: v.string(),
      batchId: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { postId, take, stats }) => {
    const post = await ctx.db.get(postId);
    if (!post) return null;

    await ctx.db.patch(postId, {
      text: take.global.slice(0, MAX_POST_CHARS),
      tags: take.tags,
      variants: { owner: take.owner, opponent: take.opponent, freeAgent: take.freeAgent },
      status: "take",
      generationStats: { ...stats, flags: [] },
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.wireOverlay.fanOutGlobalPost, { postId });
    return null;
  },
});

export const failTake = internalMutation({
  args: {
    postId: v.id("wirePosts"),
    flags: v.array(v.string()),
    // What the failed attempt still cost (a take the verifier rejected was paid for), so the daily
    // cap (`getGlobalSpendToday`) sees the money. Absent for cap/transport failures that spent nothing.
    stats: v.optional(v.object({ costUsd: v.number(), model: v.string(), effort: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, { postId, flags, stats }) => {
    const post = await ctx.db.get(postId);
    if (!post) return null;

    // The card text was already set at creation time (the plain fact-card rendering) - a failed
    // take falls back to it rather than being rewritten, per spec §8.1.
    await ctx.db.patch(postId, {
      status: "card",
      generationStats: {
        costUsd: stats?.costUsd ?? 0,
        model: stats?.model ?? WIRE_DEFAULT_ROUTE.model,
        effort: stats?.effort ?? WIRE_DEFAULT_ROUTE.effort,
        flags,
      },
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.wireOverlay.fanOutGlobalPost, { postId });
    return null;
  },
});

/** `wireSourceState`'s health row for one source - the operator digest's feed-freshness line. */
export const getSourceHealth = internalQuery({
  args: { source: v.string() },
  returns: v.union(
    v.object({ lastRunAt: v.number(), ok: v.boolean(), summary: v.string(), error: v.optional(v.string()) }),
    v.null()
  ),
  handler: async (ctx, { source }) => {
    const row = await ctx.db
      .query("wireSourceState")
      .withIndex("by_source", (q) => q.eq("source", source))
      .first();
    if (!row) return null;
    return { lastRunAt: row.lastRunAt, ok: row.ok, summary: row.summary, error: row.error };
  },
});

/** One Dex Desk kind's count in the digest window - `wireLeaguePosts.by_kind_created` is
 *  deployment-wide (unlike every other index on that table, which keys on `leagueId` first), so
 *  this never needs to scan league by league. Bounded the same way the rest of this file is. */
async function countDeskKind(ctx: Pick<QueryCtx, "db">, kind: string, since: number): Promise<number> {
  const rows = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_kind_created", (q) => q.eq("kind", kind).gt("createdAt", since))
    .take(2000);
  return rows.length;
}

/** Events/posts/takes/card-fallbacks/cost since `since`, for the operator digest's "Wire:" line,
 *  plus Dex Desk's own activity counts (spec §18 "Not built": "a digest line for the desk"). */
export const getDigestStats = internalQuery({
  args: { since: v.number() },
  returns: v.object({
    events: v.number(),
    posts: v.number(),
    takes: v.number(),
    cardFallbacks: v.number(),
    costUsd: v.number(),
    desk: v.object({
      lineupMoves: v.number(),
      lateSwaps: v.number(),
      proposals: v.number(),
      claimsIn: v.number(),
      lockWarnings: v.number(),
      samQuestions: v.number(),
    }),
  }),
  handler: async (ctx, { since }) => {
    const events = await ctx.db
      .query("wireEvents")
      .withIndex("by_detected", (q) => q.gt("detectedAt", since))
      .take(2000);
    const posts = await ctx.db
      .query("wirePosts")
      .withIndex("by_created", (q) => q.gt("createdAt", since))
      .take(2000);
    const takes = posts.filter((p) => p.status === "take").length;
    const cardFallbacks = posts.filter((p) => p.status === "card" && (p.generationStats?.flags.length ?? 0) > 0).length;
    const costUsd = posts.reduce((sum, p) => sum + (p.generationStats?.costUsd ?? 0), 0);

    const [lineupMoves, lateSwaps, proposals, claimsIn, samQuestions] = await Promise.all([
      countDeskKind(ctx, "lineup_move", since),
      countDeskKind(ctx, "late_swap", since),
      countDeskKind(ctx, "trade_proposal", since),
      countDeskKind(ctx, "claims_in", since),
      countDeskKind(ctx, "sam_question", since),
    ]);
    // lineup_lock's private warning is a `userNotifications` row (type "wire_alert"), never a
    // wireLeaguePosts row - `by_created_at` is the only global-scan index that table has.
    const wireAlerts = await ctx.db
      .query("userNotifications")
      .withIndex("by_created_at", (q) => q.gt("createdAt", since))
      .take(2000);
    const lockWarnings = wireAlerts.filter((n) => n.type === "wire_alert").length;

    return {
      events: events.length,
      posts: posts.length,
      takes,
      cardFallbacks,
      costUsd,
      desk: { lineupMoves, lateSwaps, proposals, claimsIn, lockWarnings, samQuestions },
    };
  },
});

/** Today's (UTC) global wire spend, for `wireGenerate.ts`'s daily cap check. Bounded: even at the
 *  40/hour take cap plus cards, a day's `wirePosts` volume stays well under this cap. */
export const getGlobalSpendToday = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const midnightUtc = new Date();
    midnightUtc.setUTCHours(0, 0, 0, 0);
    const rows = await ctx.db
      .query("wirePosts")
      .withIndex("by_created", (q) => q.gt("createdAt", midnightUtc.getTime()))
      .take(2000);
    return rows.reduce((sum, row) => sum + (row.generationStats?.costUsd ?? 0), 0);
  },
});
