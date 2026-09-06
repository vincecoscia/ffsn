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
import type { Doc, Id } from "./_generated/dataModel";
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
  TRENDING_BOARD_MIN_GAP_MS,
  TRENDING_BOARD_SIZE,
  TRENDING_DEDUPE_WINDOW_MS,
  TRENDING_RELATED_WINDOW_MS,
  TRENDING_SPIKE_MAX_PERCENT_OWNED,
  TRENDING_SPIKE_MIN_ADDS,
  TRENDING_SPIKE_MIN_RATIO,
  TRENDING_SPIKES_PER_SYNC,
  WIRE_DEFAULT_ROUTE,
  WIRE_PERSONA_FOR_KIND,
} from "../src/lib/ai/wire/types";
import type {
  GlobalEventKind,
  InjuryStatus,
  WireCardBoardEntry,
  WireCardPlayer,
  WireCardRelated,
  WireFactCard,
} from "../src/lib/ai/wire/types";
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

/**
 * Upsert one source's cursor + health row. Shared by `recordSourceRun` (every poller's own health
 * check-in) and `ingestTrendingRows` (which writes the trending cursor inline, since it needs to
 * read it back in the same mutation rather than round-tripping through a query + a second mutation).
 */
async function writeSourceState(
  ctx: MutationCtx,
  args: { source: string; cursor?: unknown; ok: boolean; summary: string; error?: string }
): Promise<void> {
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
}

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
    await writeSourceState(ctx, args);
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
  returns: v.object({ posted: v.number(), stored: v.number(), skipped: v.number() }),
  handler: async (ctx, { espnIds }) => {
    let posted = 0;
    let stored = 0;
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
      // shape src/lib/ai/wire/espn.ts expects, so the relevance check, note-trimming and
      // player-scoped timetable extraction are the same logic the poller/eval script use.
      const espnArticle: EspnNewsArticle = {
        id: article.espnId,
        type: article.type,
        headline: article.headline,
        description: article.description,
        published: article.published,
        url: article.links.web,
        athletes: article.categories.athletes.map((athlete) => ({ espnId: String(athlete.id), name: athlete.name })),
      };
      const rawCard = newsArticleToCard(espnArticle, { fetchedAt: now });
      if (!rawCard) {
        skipped++; // untagged, too broadly tagged, or not relevant (src/lib/ai/wire/espn.ts#newsRelevance)
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

      // The event is stored either way (spec update 2026-09-06) - article writers and the intel
      // pipeline still want a relevant story even when it isn't wire-worthy on its own. Only a
      // take-worthy story, or one with a concrete timetable, earns an actual post: the two ESPN
      // "Story" features that prompted this change (a field-blessing piece, a Daniel Jones return
      // piece) were relevant enough to keep as events but never should have posted as a bare
      // headline below the take bar.
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
      const worthPosting = interest >= TAKE_MIN_INTEREST || card.timetable !== undefined;
      if (worthPosting && (await createPostForEvent(ctx, now, eventId, "news", card, interest))) {
        posted++;
      } else {
        stored++;
      }
    }

    return { posted, stored, skipped };
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

/**
 * Sleeper trending (rewritten owner request, 2026-09-06): a full 50-row nightly board was reposting
 * itself every night — 32 of 34 posts on prod were the same board, all from one preseason draft-week
 * sync. `syncSleeperTrending` now forwards every mapped row; this detector owns the rules for what,
 * if anything, is worth posting:
 *   - A nightly "most added" BOARD card (top TRENDING_BOARD_SIZE by adds), reposted only after
 *     TRENDING_BOARD_MIN_GAP_MS and only when its top-N set actually changed. Fixed interest
 *     (TRENDING_BOARD_INTEREST) — a ranking is never a take, however widely rostered its names are.
 *   - Up to TRENDING_SPIKES_PER_SYNC genuine SPIKES: a player's adds at least doubled since the
 *     PREVIOUS sync (not a fixed rank in tonight's board), cleared TRENDING_SPIKE_MIN_ADDS outright,
 *     and is still lightly rostered (below TRENDING_SPIKE_MAX_PERCENT_OWNED — a 93%-owned name isn't
 *     news). Preseason is exempt entirely (`seasonHasKickedOff`): draft-week adds are noise.
 * A season with no week-1 schedule rows yet fails the gate quietly (trending is the lowest-value
 * kind here), storing nothing rather than guessing.
 */

interface TrendingCursor {
  /** Every mapped player's add count as of the last sync — the spike math's "previous" value. */
  counts: Record<string, number>;
  /** The lowest count seen last sync — what a player NOT in `counts` (a first sighting) compares
   *  against, so a brand-new riser can still spike on his first appearance. */
  floor: number;
  /** The espnIds on the last posted board, so an unchanged top-N never reposts. */
  top: string[];
  /** When the board last posted (not merely last checked) — the repost gate's own clock. */
  lastBoardAt?: number;
  syncedAt: number;
}

const trendingRowValidator = v.object({
  espnId: v.string(),
  trendingAdds: v.number(),
  team: v.optional(v.string()),
  position: v.optional(v.string()),
  rank: v.number(),
});

type TrendingRow = { espnId: string; trendingAdds: number; team?: string; position?: string; rank: number };

const TRENDING_SOURCE = "sleeper_trending";
const RELATED_EVENT_KINDS: ReadonlySet<string> = new Set(["injury_status", "injury_note", "news", "depth_chart"]);

/** Is week 1 of the current NFL season already underway? Fails quiet (false) with no schedule rows -
 *  trending is the lowest-value kind here, not worth guessing about. Bounded: 32 teams x home/away
 *  rows for one week is well under 64. */
async function seasonHasKickedOff(ctx: Pick<MutationCtx, "db">, now: number): Promise<boolean> {
  const rows = await ctx.db
    .query("nflSchedules")
    .withIndex("by_week", (q) => q.eq("season", nflSeasonYearFor()).eq("week", 1))
    .take(64);
  return rows.some((row) => row.gameTime <= now);
}

/** Same members, order ignored - the board's "did the top-N actually change" check. */
function sameIdSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}

/**
 * The most recent wire event on the SAME nfl team that plausibly explains a trending spike (an
 * injury, a depth-chart move, a news story) within TRENDING_RELATED_WINDOW_MS - preferring one
 * about a player at the same position, then higher interest, then newer. Bounded: `by_team_detected`
 * range capped at 20, a generous width for two days of one team's wire activity.
 */
async function findRelatedEvent(
  ctx: MutationCtx,
  player: WireCardPlayer,
  now: number
): Promise<WireCardRelated | undefined> {
  if (!player.nflTeam) return undefined;
  const events = await ctx.db
    .query("wireEvents")
    .withIndex("by_team_detected", (q) => q.eq("nflTeam", player.nflTeam).gt("detectedAt", now - TRENDING_RELATED_WINDOW_MS))
    .order("desc")
    .take(20);

  const parsed: Array<{ event: Doc<"wireEvents">; card: WireFactCard; samePosition: boolean }> = [];
  for (const event of events) {
    if (!RELATED_EVENT_KINDS.has(event.kind)) continue;
    let card: WireFactCard;
    try {
      card = validateFactCard(event.facts);
    } catch {
      continue; // A malformed stored card must never break the spike it's related to.
    }
    parsed.push({ event, card, samePosition: card.players.some((p) => !!p.position && p.position === player.position) });
  }
  if (parsed.length === 0) return undefined;

  // (a) same position first, (b) higher interest, (c) newer - `events` already came back newest
  // first, and Array#sort is stable, so an interest tie keeps that order.
  parsed.sort((a, b) => (a.samePosition !== b.samePosition ? (a.samePosition ? -1 : 1) : b.event.interest - a.event.interest));

  const { event: best, card } = parsed[0];
  return {
    kind: best.kind as GlobalEventKind,
    players: card.players.map((p) => p.name),
    nflTeam: card.nflTeam,
    statusTo: card.statusTo,
    headline: card.headline,
    timetable: card.timetable,
    observedAt: card.observedAt,
    source: card.source.type,
  };
}

/**
 * The actual detector body, factored out so `devTools.runTrendingNow` and tests can drive it
 * directly with an injectable `now` and a gate bypass, without going through the internalMutation
 * wrapper. `opts.now` defaults to `Date.now()`; `opts.bypassGate` skips `seasonHasKickedOff` (dev/
 * test only - the real sync never bypasses it).
 */
export async function ingestTrendingRows(
  ctx: MutationCtx,
  rows: TrendingRow[],
  opts: { now?: number; bypassGate?: boolean } = {}
): Promise<{ posted: number; skipped: number; gated: boolean; seeded: boolean; board: boolean }> {
  const now = opts.now ?? Date.now();

  if (!opts.bypassGate && !(await seasonHasKickedOff(ctx, now))) {
    // Store nothing: no event, no post, no cursor - preseason draft-week adds are noise, and a
    // cursor written now would only make the first real spike look artificially small later.
    return { posted: 0, skipped: 0, gated: true, seeded: false, board: false };
  }

  const existing = await ctx.db
    .query("wireSourceState")
    .withIndex("by_source", (q) => q.eq("source", TRENDING_SOURCE))
    .first();
  const cursor = existing?.cursor as TrendingCursor | undefined;
  const seeded = cursor === undefined;

  const enriched: Array<{ row: TrendingRow; player: WireCardPlayer }> = [];
  for (const row of rows) {
    enriched.push({
      row,
      player: await enrichOnePlayer(ctx, { espnId: row.espnId, name: row.espnId, position: row.position, nflTeam: row.team }),
    });
  }

  let boardPosted = false;
  let nextTop = cursor?.top ?? [];
  let nextBoardAt = cursor?.lastBoardAt;

  const dueForBoardCheck = cursor?.lastBoardAt === undefined || now - cursor.lastBoardAt >= TRENDING_BOARD_MIN_GAP_MS;
  if (dueForBoardCheck) {
    const top = [...enriched].sort((a, b) => b.row.trendingAdds - a.row.trendingAdds).slice(0, TRENDING_BOARD_SIZE);
    const topIds = top.map(({ row }) => row.espnId);
    const changed = top.length > 0 && (!cursor || cursor.top.length === 0 || !sameIdSet(topIds, cursor.top));
    if (changed) {
      const dedupeKey = `trending_board:${new Date(now).toISOString().slice(0, 10)}`;
      if (!(await existsExact(ctx, dedupeKey))) {
        const board: WireCardBoardEntry[] = top.map(({ row, player }) => ({
          espnId: row.espnId,
          name: player.name,
          position: player.position,
          nflTeam: player.nflTeam,
          percentOwned: player.percentOwned,
          trendingAdds: row.trendingAdds,
        }));
        const players = top.map(({ player }) => player);
        try {
          const card = validateFactCard({
            kind: "trending_board" as const,
            observedAt: now,
            players,
            board,
            source: { type: "sleeper" as const, fetchedAt: now },
          });
          const interest = clampInterest(scoreInterest(card));
          const eventId = await ctx.db.insert("wireEvents", {
            kind: "trending_board",
            dedupeKey,
            observedAt: now,
            detectedAt: now,
            players,
            facts: card,
            interest,
            source: card.source,
          });
          if (await createPostForEvent(ctx, now, eventId, "trending_board", card, interest)) boardPosted = true;
        } catch (err) {
          console.warn("wireDetect.ingestTrendingRows: invalid trending_board card", err);
        }
      }
      nextTop = topIds;
      nextBoardAt = now;
    }
    // An unchanged top-N is not an error, just nothing to say - `nextBoardAt` stays at its previous
    // value so the NEXT sync re-checks immediately rather than waiting out another full gap.
  }

  let posted = 0;
  let skipped = 0;

  // Spikes are skipped entirely on the seed run: with no previous counts, every row would look like
  // an infinite-ratio "spike" against a floor of 0.
  if (!seeded) {
    const counts = cursor!.counts;
    const floor = cursor!.floor;
    const candidates = enriched
      .map(({ row, player }) => ({ row, player, prev: counts[row.espnId] ?? floor }))
      .filter(
        ({ row, player, prev }) =>
          row.trendingAdds >= TRENDING_SPIKE_MIN_RATIO * prev &&
          row.trendingAdds >= TRENDING_SPIKE_MIN_ADDS &&
          (player.percentOwned ?? 0) < TRENDING_SPIKE_MAX_PERCENT_OWNED
      )
      .sort((a, b) => b.row.trendingAdds - a.row.trendingAdds)
      .slice(0, TRENDING_SPIKES_PER_SYNC);

    for (const { row, player, prev } of candidates) {
      const dedupeKey = `trending:${row.espnId}`;
      if (await dedupeWithinWindow(ctx, dedupeKey, TRENDING_DEDUPE_WINDOW_MS, now)) {
        skipped++;
        continue;
      }

      const related = await findRelatedEvent(ctx, player, now);
      const cardInput = {
        kind: "trending" as const,
        observedAt: now,
        players: [player],
        nflTeam: player.nflTeam,
        trendingAdds: row.trendingAdds,
        trendingPrevAdds: prev,
        ...(related ? { related } : {}),
        source: { type: "sleeper" as const, fetchedAt: now },
      };

      let card: WireFactCard;
      try {
        card = validateFactCard(cardInput);
      } catch (err) {
        console.warn(`wireDetect.ingestTrendingRows: invalid card for espnId ${row.espnId}`, err);
        skipped++;
        continue;
      }

      const recentAt = await recentSamePlayerPostAt(ctx, row.espnId, now);
      const interest = clampInterest(scoreInterest(card, { recentSamePlayerPostAt: recentAt, now }));

      const eventId = await ctx.db.insert("wireEvents", {
        kind: "trending",
        dedupeKey,
        observedAt: now,
        detectedAt: now,
        players: [player],
        primaryEspnId: player.espnId,
        nflTeam: player.nflTeam,
        facts: card,
        interest,
        source: cardInput.source,
      });
      if (await createPostForEvent(ctx, now, eventId, "trending", card, interest)) posted++;
    }
  }

  // Always write the cursor when not gated, so tonight's counts become tomorrow's "previous".
  const counts: Record<string, number> = {};
  let floor = Number.POSITIVE_INFINITY;
  for (const { row } of enriched) {
    counts[row.espnId] = row.trendingAdds;
    if (row.trendingAdds < floor) floor = row.trendingAdds;
  }
  const nextCursor: TrendingCursor = {
    counts,
    floor: Number.isFinite(floor) ? floor : 0,
    top: nextTop,
    ...(nextBoardAt !== undefined ? { lastBoardAt: nextBoardAt } : {}),
    syncedAt: now,
  };
  await writeSourceState(ctx, {
    source: TRENDING_SOURCE,
    cursor: nextCursor,
    ok: true,
    summary: `${rows.length} rows, ${posted} spike(s), board ${boardPosted ? "posted" : "unchanged"}`,
  });

  return { posted, skipped, gated: false, seeded, board: boardPosted };
}

export const ingestTrending = internalMutation({
  args: { rows: v.array(trendingRowValidator) },
  returns: v.object({
    posted: v.number(),
    skipped: v.number(),
    gated: v.boolean(),
    seeded: v.boolean(),
    board: v.boolean(),
  }),
  handler: async (ctx, { rows }) => ingestTrendingRows(ctx, rows),
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

/* -------------------------------------------------------------------------- *
 * One-time cleanup (spec update 2026-09-06): the old `ingestTrending` reposted the same full
 * board every night as separate `trending` cards - prod carries 32 of them from a single preseason
 * sync. This retracts them (and their per-league overlays/reactions) without touching the underlying
 * `wireEvents` history. Not dev-guarded (it must run once on prod too), so it is internal-only and
 * never wired to a public mutation or a cron - an operator runs it by hand, once.
 * -------------------------------------------------------------------------- */
export const retractTrendingCards = internalMutation({
  args: { dryRun: v.boolean() },
  returns: v.object({ posts: v.number(), overlays: v.number(), reactions: v.number(), dryRun: v.boolean() }),
  handler: async (ctx, { dryRun }) => {
    // No index on `kind` alone for wirePosts (a handful of hundred rows deployment-wide today) - a
    // bounded scan, capped and self-rescheduling, same shape as intelSync.ts#deleteStaleTrending.
    const rows = await ctx.db
      .query("wirePosts")
      .filter((q) => q.eq(q.field("kind"), "trending"))
      .take(500);

    let overlays = 0;
    let reactions = 0;
    for (const post of rows) {
      const leaguePosts = await ctx.db
        .query("wireLeaguePosts")
        .withIndex("by_global_post_league", (q) => q.eq("globalPostId", post._id))
        .take(500);
      for (const overlay of leaguePosts) {
        overlays++;
        if (!dryRun) await ctx.db.delete(overlay._id);
      }

      const reactionRows = await ctx.db
        .query("wireReactions")
        .withIndex("by_post", (q) => q.eq("postKey", `global:${post._id}`))
        .take(500);
      for (const reaction of reactionRows) {
        reactions++;
        if (!dryRun) await ctx.db.delete(reaction._id);
      }

      if (!dryRun) await ctx.db.delete(post._id);
    }

    if (!dryRun && rows.length === 500) {
      await ctx.scheduler.runAfter(0, internal.wireDetect.retractTrendingCards, { dryRun });
    }

    return { posts: rows.length, overlays, reactions, dryRun };
  },
});
