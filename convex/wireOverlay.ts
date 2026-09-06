/**
 * The Wire — league overlay, tier 2 (ffsn-the-wire-spec.md §3.2). No model call: a global post is
 * turned into up to three per-league variants (owner / opponent / freeAgent) by filling a template
 * with facts this league already has - roster ownership, this week's matchup, FAAB math, the best
 * free agent at the position. `fanOutGlobalPost` runs once per posted/taken global event and
 * schedules `fanOutGlobalPostForLeague` for every pass-holding, wire-enabled league;
 * `fanOutGlobalPostForLeague` does the actual per-league lookup and insert.
 *
 * `{backup}` (next man up on the NFL depth chart) doesn't vary by league, so it's resolved once in
 * `fanOutGlobalPost` and passed down to every per-league call rather than re-scanned per league.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { hasActivePass } from "./credits";
import { leagueCurrentSeason, nflSeasonYearFor } from "./lib/season";
import { draftPhaseFor } from "./lib/draftPhase";
import { currentMatchupPeriod, faabSlot, insertLeaguePostIfNew, managerNameFor } from "./lib/wireLeaguePosting";
import {
  CARD_MIN_INTEREST,
  FREE_AGENT_MIN_PERCENT_OWNED,
  FREE_AGENT_MIN_TRENDING_ADDS,
  STARTER_OVERLAY_BONUS,
} from "../src/lib/ai/wire/types";
import type { OverlayVariant, WireCardPlayer, WireFactCard, WireSlots } from "../src/lib/ai/wire/types";
import { validateFactCard } from "../src/lib/ai/wire/card";
import { defaultVariants, fillVariant, ownershipSwingSlots } from "../src/lib/ai/wire/fill";
import { verifyLeagueText } from "../src/lib/ai/wire/verify";

const BENCH_SLOT_ID = 20;
const IR_SLOT_ID = 21;

/* -------------------------------------------------------------------------- *
 * Roster / matchup lookups (bounded, season-scoped)
 * -------------------------------------------------------------------------- */

async function findOwnerTeam(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  espnId: string
): Promise<{ team: Doc<"teams">; lineupSlotId?: number } | null> {
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .take(40); // a league's team count, generously bounded
  for (const team of teams) {
    const rosterEntry = team.roster.find((r) => r.playerId === espnId);
    if (rosterEntry) return { team, lineupSlotId: rosterEntry.lineupSlotId };
  }
  return null;
}

async function findOpponentTeam(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  ownerExternalId: string,
  week: number
): Promise<Doc<"teams"> | null> {
  const matchups = await ctx.db
    .query("matchups")
    .withIndex("by_league_period", (q) => q.eq("leagueId", leagueId).eq("matchupPeriod", week))
    .filter((q) => q.eq(q.field("seasonId"), seasonId))
    .take(40);
  const match = matchups.find((m) => m.homeTeamId === ownerExternalId || m.awayTeamId === ownerExternalId);
  if (!match) return null;
  const opponentExternalId = match.homeTeamId === ownerExternalId ? match.awayTeamId : match.homeTeamId;
  return await ctx.db
    .query("teams")
    .withIndex("by_external", (q) =>
      q.eq("leagueId", leagueId).eq("externalId", opponentExternalId).eq("seasonId", seasonId)
    )
    .first();
}

/** Highest-owned free agent/waiver player at this position in this league (spec §3.2 point 3):
 *  scanned by the `by_position` index (season isn't part of it) and filtered/sorted in memory, per
 *  the letter of the spec - best-effort against a table that spans multiple seasons' history. */
async function findBestFreeAgent(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  season: number,
  position: string | undefined
): Promise<string | undefined> {
  if (!position) return undefined;
  const candidates = await ctx.db
    .query("playersEnhanced")
    .withIndex("by_position", (q) => q.eq("defaultPosition", position))
    .filter((q) => q.eq(q.field("season"), season))
    .take(300);
  const sorted = [...candidates].sort((a, b) => b.ownership.percentOwned - a.ownership.percentOwned);
  for (const candidate of sorted) {
    const status = await ctx.db
      .query("leaguePlayerStatus")
      .withIndex("by_league_player", (q) => q.eq("leagueId", leagueId).eq("playerId", candidate.espnId))
      .first();
    if (status && (status.status === "free_agent" || status.status === "waivers")) {
      return candidate.fullName;
    }
  }
  return undefined;
}

/**
 * The next player at the same NFL team + position, one slot behind this card's subject on the
 * Sleeper depth chart - league-agnostic, so `fanOutGlobalPost` computes it once per event rather
 * than once per league. Best effort (spec §3.2 point 3): a player with no depth-chart row of his
 * own is assumed to be the starter (order 1).
 */
async function findBackupCandidate(
  ctx: MutationCtx,
  player: WireCardPlayer
): Promise<{ espnId: string; name: string } | null> {
  if (!player.nflTeam || !player.position) return null;
  const season = nflSeasonYearFor();

  const ownRow = await ctx.db
    .query("playerIntel")
    .withIndex("by_player_season", (q) => q.eq("espnId", player.espnId).eq("season", season))
    .filter((q) => q.eq(q.field("kind"), "depth_chart"))
    .first();
  const ownOrder = ownRow?.depthOrder ?? 1;

  // Bounded: a season's full depth-chart table (32 teams x a handful of skill positions).
  const depthChart = await ctx.db
    .query("playerIntel")
    .withIndex("by_season_kind", (q) => q.eq("season", season).eq("kind", "depth_chart"))
    .take(1000);
  const nextUp = depthChart.find(
    (row) => row.team === player.nflTeam && row.position === player.position && row.depthOrder === ownOrder + 1
  );
  if (!nextUp) return null;

  const enriched = await ctx.db
    .query("playersEnhanced")
    .withIndex("by_espn_id_season", (q) => q.eq("espnId", nextUp.espnId).eq("season", season))
    .first();
  return enriched ? { espnId: nextUp.espnId, name: enriched.fullName } : null;
}

const ADP_MARKET_PREFERENCE = ["ppr-12", "ppr-10", "half-ppr-12", "half-ppr-10", "standard-12", "standard-10"];

/** `{adp}` / `{adpRank}` from the freshest FFC market board for this player (intel sync), if any. */
async function adpSlotsFor(ctx: MutationCtx, player: WireCardPlayer): Promise<WireSlots> {
  const season = nflSeasonYearFor();
  const rows = await ctx.db
    .query("playerIntel")
    .withIndex("by_player_season", (q) => q.eq("espnId", player.espnId).eq("season", season))
    .filter((q) => q.eq(q.field("kind"), "market"))
    .take(12);
  const byPreference = [...rows].sort(
    (a, b) => ADP_MARKET_PREFERENCE.indexOf(a.market ?? "") - ADP_MARKET_PREFERENCE.indexOf(b.market ?? "")
  );
  const board = byPreference.find((row) => row.adp !== undefined);
  if (!board || board.adp === undefined) return {};
  const slots: WireSlots = { adp: board.adp.toFixed(1) };
  if (board.adpPositionRank !== undefined && player.position) slots.adpRank = `${player.position}${board.adpPositionRank}`;
  return slots;
}

function basePlayerSlots(card: WireFactCard, player: WireCardPlayer): WireSlots {
  const slots: WireSlots = { player: player.name };
  if (player.position) slots.pos = player.position;
  if (player.nflTeam) slots.nflTeam = player.nflTeam;
  if (card.statusTo) slots.status = card.statusTo;
  if (card.timetable) slots.timetable = card.timetable;
  if (card.trendingAdds !== undefined) slots.trendingAdds = String(card.trendingAdds);
  // Dex Desk (spec §18): {pct}/{direction} for an ownership_swing card's overlay sentences -
  // absent (both keys) when the card carries no signed percentChange, so those sentences drop.
  if (card.kind === "ownership_swing") Object.assign(slots, ownershipSwingSlots(card));
  return slots;
}

/* -------------------------------------------------------------------------- *
 * fanOutGlobalPost — enumerate pass-holding, wire-enabled leagues
 * -------------------------------------------------------------------------- */

export const fanOutGlobalPost = internalMutation({
  args: { postId: v.id("wirePosts") },
  returns: v.null(),
  handler: async (ctx, { postId }) => {
    const post = await ctx.db.get(postId);
    if (!post || post.status === "take_pending" || post.status === "held") return null;

    const event = await ctx.db.get(post.eventId);
    if (!event) return null;

    let card: WireFactCard;
    try {
      card = validateFactCard(event.facts);
    } catch (err) {
      console.warn(`wireOverlay.fanOutGlobalPost: invalid card on event ${event._id}`, err);
      return null;
    }

    const primaryPlayer = card.players[0];
    const backup = primaryPlayer ? await findBackupCandidate(ctx, primaryPlayer) : null;

    // Bounded via internal.leagues.listLeagues (an existing sync-jobs-only internal query); a
    // handful of hundred leagues at most today, and each iteration below is O(1) (schedule only).
    const leagues = await ctx.runQuery(internal.leagues.listLeagues, {});
    for (const league of leagues) {
      if (!hasActivePass(league)) continue;
      const prefs = await ctx.db
        .query("leagueContentPreferences")
        .withIndex("by_league", (q) => q.eq("leagueId", league._id))
        .first();
      if (prefs?.wireEnabled === false) continue;

      await ctx.scheduler.runAfter(0, internal.wireOverlay.fanOutGlobalPostForLeague, {
        postId,
        leagueId: league._id,
        backupEspnId: backup?.espnId,
        backupName: backup?.name,
      });
    }
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * fanOutGlobalPostForLeague — the actual per-league fill
 * -------------------------------------------------------------------------- */

export const fanOutGlobalPostForLeague = internalMutation({
  args: {
    postId: v.id("wirePosts"),
    leagueId: v.id("leagues"),
    backupEspnId: v.optional(v.string()),
    backupName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { postId, leagueId, backupEspnId, backupName }) => {
    // Idempotent: a retried schedule (or a direct re-invocation from devTools) never double-posts.
    const already = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_global_post_league", (q) => q.eq("globalPostId", postId).eq("leagueId", leagueId))
      .first();
    if (already) return null;

    const post = await ctx.db.get(postId);
    if (!post || post.status === "take_pending" || post.status === "held") return null;
    const event = await ctx.db.get(post.eventId);
    if (!event) return null;

    let card: WireFactCard;
    try {
      card = validateFactCard(event.facts);
    } catch {
      return null;
    }

    const league = await ctx.db.get(leagueId);
    if (!league || !hasActivePass(league)) return null;
    const prefs = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .first();
    if (prefs?.wireEnabled === false) return null;

    const player = card.players[0];
    if (!player) return null;

    const seasonId = leagueCurrentSeason(league);
    const now = Date.now();

    // Draft phase (owner ask, 2026-09-05): before its draft a REDRAFT league has no rosters and no
    // waiver wire, so it gets the global wire only - no overlay at all. A KEEPER league before its
    // draft keeps owner notes for the players already kept, and an unrostered player gets a
    // draft-board note (ADP) instead of a waiver note. Unknown/unsynced draft state counts as drafted.
    const draftPhase = await draftPhaseFor(ctx, leagueId, seasonId);
    if (draftPhase === "predraft_redraft") return null;
    const preDraft = draftPhase === "predraft_keeper";

    const week = preDraft ? undefined : ((await currentMatchupPeriod(ctx, leagueId, seasonId)) ?? undefined);

    const language = await ctx.runQuery(internal.languageSettings.getLeagueLanguage, { leagueId });
    const baseSlots = basePlayerSlots(card, player);

    const ownership = await findOwnerTeam(ctx, leagueId, seasonId, player.espnId);

    if (ownership) {
      const isStarter = ownership.lineupSlotId !== undefined && ![BENCH_SLOT_ID, IR_SLOT_ID].includes(ownership.lineupSlotId);
      const effectiveInterest = post.interest + (isStarter ? STARTER_OVERLAY_BONUS : 0);
      if (effectiveInterest < CARD_MIN_INTEREST) return null;

      // Pre-draft (keeper): no waiver wire yet, so the FAAB / best-free-agent sentences drop.
      const bestFA = preDraft ? undefined : await findBestFreeAgent(ctx, leagueId, seasonId, player.position);

      // Owner variant.
      const ownerSlots: WireSlots = {
        ...baseSlots,
        team: ownership.team.name,
        manager: managerNameFor(ownership.team),
        faab: preDraft ? undefined : faabSlot(league, ownership.team),
        bestFA,
      };
      await tryInsertVariant(ctx, {
        leagueId,
        seasonId,
        week,
        post,
        card,
        variant: "owner",
        slots: ownerSlots,
        teamId: ownership.team._id,
        featuredTeams: [ownership.team._id],
        featuredTeamNames: [ownership.team.name],
        language,
        now,
      });

      // Opponent variant: this week's matchup for the owner's team (none before the draft).
      const opponentTeam = preDraft
        ? null
        : await findOpponentTeam(ctx, leagueId, seasonId, ownership.team.externalId, week ?? 0);
      if (opponentTeam) {
        const opponentSlots: WireSlots = {
          ...baseSlots,
          team: opponentTeam.name,
          ownerTeam: ownership.team.name,
          manager: managerNameFor(opponentTeam),
          bestFA,
        };
        await tryInsertVariant(ctx, {
          leagueId,
          seasonId,
          week,
          post,
          card,
          variant: "opponent",
          slots: opponentSlots,
          teamId: opponentTeam._id,
          featuredTeams: [opponentTeam._id, ownership.team._id],
          featuredTeamNames: [opponentTeam.name, ownership.team.name],
          language,
          now,
        });
      }
      return null;
    }

    // Unrostered here: free-agent variant, gated on wide-enough relevance (spec §3.2 point 5).
    if (post.interest < CARD_MIN_INTEREST) return null;
    const widelyRelevant =
      (player.percentOwned ?? 0) >= FREE_AGENT_MIN_PERCENT_OWNED ||
      (card.trendingAdds ?? 0) >= FREE_AGENT_MIN_TRENDING_ADDS;
    if (!widelyRelevant) return null;

    // Pre-draft keeper league: he is on the board, not the wire - a draft-board note with his ADP.
    if (preDraft) {
      const adp = await adpSlotsFor(ctx, player);
      await tryInsertVariant(ctx, {
        leagueId,
        seasonId,
        week,
        post,
        card,
        variant: "draftBoard",
        slots: { ...baseSlots, ...adp },
        teamId: undefined,
        featuredTeams: [],
        featuredTeamNames: [],
        language,
        now,
      });
      return null;
    }

    const bestFA = await findBestFreeAgent(ctx, leagueId, seasonId, player.position);
    const backup = await backupSlotFor(ctx, leagueId, seasonId, backupEspnId, backupName);
    if (!bestFA && !backup) return null;

    const freeAgentSlots: WireSlots = { ...baseSlots, bestFA, backup };
    await tryInsertVariant(ctx, {
      leagueId,
      seasonId,
      week,
      post,
      card,
      variant: "freeAgent",
      slots: freeAgentSlots,
      teamId: undefined,
      featuredTeams: [],
      featuredTeamNames: [],
      language,
      now,
    });
    return null;
  },
});

async function backupSlotFor(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  backupEspnId: string | undefined,
  backupName: string | undefined
): Promise<string | undefined> {
  if (!backupEspnId || !backupName) return undefined;
  const owned = await findOwnerTeam(ctx, leagueId, seasonId, backupEspnId);
  return owned ? undefined : backupName;
}

interface VariantInsertArgs {
  leagueId: Id<"leagues">;
  seasonId: number;
  week: number | undefined;
  post: Doc<"wirePosts">;
  card: WireFactCard;
  variant: OverlayVariant;
  slots: WireSlots;
  teamId: Id<"teams"> | undefined;
  featuredTeams: Id<"teams">[];
  featuredTeamNames: string[];
  language: { languageRating: "clean" | "salty" | "unfiltered"; cleanTeamNames: string[] };
  now: number;
}

/** Fill the variant's template, verify it, and insert (or silently drop it - spec §3.2 point 4/6). */
async function tryInsertVariant(ctx: MutationCtx, args: VariantInsertArgs): Promise<void> {
  const { leagueId, seasonId, week, post, card, variant, slots, teamId, featuredTeams, featuredTeamNames, language, now } = args;

  // The model writes owner/opponent/freeAgent; draftBoard (and any variant it skipped) falls back
  // to the deterministic default template.
  const modelVariants = post.variants as Partial<Record<OverlayVariant, string>> | undefined;
  const template = modelVariants?.[variant] ?? defaultVariants(card)[variant];
  const filled = fillVariant(template, slots);
  if (!filled.ok) return;

  const isCleanTeam = featuredTeamNames.some((name) => language.cleanTeamNames.includes(name));
  const rating = isCleanTeam ? "clean" : language.languageRating;
  const verified = verifyLeagueText(filled.text, rating, language.cleanTeamNames);
  if (!verified.ok) return;

  const dedupeKey = teamId
    ? `overlay:${post._id}:${teamId}:${variant}`
    : `overlay:${post._id}:league:${variant}`;

  await insertLeaguePostIfNew(ctx, now, {
    leagueId,
    seasonId,
    week,
    kind: post.kind,
    persona: post.persona,
    text: filled.text,
    tags: post.tags,
    globalPostId: post._id,
    impact: teamId ? { teamId, variant, slots: cleanSlots(slots) } : undefined,
    featuredTeams,
    dedupeKey,
  });
}

/** Drop `undefined`-valued slot entries before storing - `impact.slots` validates as
 *  `v.record(v.string(), v.string())`, which requires every value to be a real string. */
function cleanSlots(slots: WireSlots): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(slots)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
