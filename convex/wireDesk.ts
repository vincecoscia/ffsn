/**
 * Dex Desk — league activity from ESPN's transaction log (ffsn-the-wire-spec.md §18). Everything
 * here is a stock line (no model call, `pickStockLine` from `src/lib/ai/wire/stock-lines.ts`)
 * except `sam_question`, which schedules `wireSocial.askSamAboutMove`. Hooked from:
 *
 *   - `espnSync.ts#upsertTransactions`      -> `onTransactionsUpsertedForDex` (lineup_move family,
 *                                              trade_proposal/declined, streaming_churn, claims_in)
 *   - `espnSync.ts#updateTeams`             -> `onRosterSynced` (roster_note, faab_watch)
 *   - `playerSync.ts#syncPlayersDefaultStats` -> `detectOwnershipSwings` (global card)
 *   - `wire.ts#postAsManager`               -> `checkRumor` (rumor_check)
 *   - `wireSourcesNode.ts#pollNflSchedule`   -> `upsertNflScheduleRows` + `scheduleLineupLockChecks`
 *   - `crons.ts`                            -> `pollTransactionLogs`, `hourlyDeskCron`
 *
 * Default Convex runtime throughout (no `"use node"`): every write here is a plain mutation, and
 * the two actions (`pollTransactionLogs`, `hourlyDeskCron`, `detectOwnershipSwings`) only call
 * `fetch`-free internal queries/mutations/actions, never the network directly.
 */

import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { LanguageRating } from "../src/lib/ai/language";
import { hasActivePass } from "./credits";
import { leagueCurrentSeason, nflSeasonYearFor } from "./lib/season";
import { draftPhaseFor } from "./lib/draftPhase";
import { BENCH_SLOT_ID, IR_SLOT_ID, isStartingSlot, lineupSlotName } from "./lib/lineupSlots";
import { userForTeam } from "./lib/teamClaims";
import {
  currentMatchupPeriod,
  faabSlot,
  insertLeaguePostIfNew,
  leagueRateLimited,
  managerNameFor,
  wireEnabled,
} from "./lib/wireLeaguePosting";
import {
  claimsHeat,
  countWord,
  faabRemainingFraction,
  findUniqueRosteredMention,
  firstSundayKickoff,
  hoursAgoPhrase,
  isInSeasonByMonth,
  isLateScratch,
  isLateSwap,
  isLineupMoveItem,
  isLockoutStatus,
  isQuietDeskDay,
  isReadsTheWire,
  isWeeklyRundownHour,
  isWithinQuietDeskWindow,
  isWorseThanActive,
  looksLikeRumor,
  minutesUntil,
  ordinalWord,
  summarizeLineupMove,
  type LineupItemLike,
} from "./lib/wireDeskRules";
import {
  CARD_MIN_INTEREST,
  CLAIMS_IN_MIN_TEAMS,
  FAAB_WATCH_MAX_FRACTION,
  FAAB_WATCH_MIN_WEEKS_LEFT,
  GLOBAL_TAKES_PER_HOUR,
  LINEUP_LOCK_WARNING_MS,
  OWNERSHIP_SWING_MIN_OWNED,
  OWNERSHIP_SWING_MIN_POINTS,
  ROSTER_NOTE_BENCH_MIN,
  SAM_NOTABLE_MIN_PERCENT_OWNED,
  STREAMING_CHURN_MIN_ADDS,
  STREAMING_CHURN_WEEKS,
  TAKE_MIN_INTEREST,
  WIRE_DEFAULT_ROUTE,
  WIRE_PERSONA_FOR_KIND,
} from "../src/lib/ai/wire/types";
import type { LeagueEventKind, WireFactCard, WirePersona, WireSlots } from "../src/lib/ai/wire/types";
import { pickStockLine } from "../src/lib/ai/wire/stock-lines";
import { renderCard, validateFactCard } from "../src/lib/ai/wire/card";
import { scoreInterest } from "../src/lib/ai/wire/interest";
import { joinNames, type MoveDescriptionInput } from "../src/lib/ai/wire/moves";

const RECENT_TXN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/* -------------------------------------------------------------------------- *
 * Shared helpers (duplicated in spirit from wireRoutine.ts/wireOverlay.ts rather than imported -
 * both those files define internalMutations against `internal.*`, and a convex/*.ts module that
 * references `internal`/`api` makes the generated `api` type recursive for anything that imports
 * it as a plain value; see convex/lib/wireLeaguePosting.ts's header comment).
 * -------------------------------------------------------------------------- */

async function getPrefs(ctx: MutationCtx, leagueId: Id<"leagues">): Promise<Doc<"leagueContentPreferences"> | null> {
  return await ctx.db
    .query("leagueContentPreferences")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .first();
}

async function effectiveRating(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  featuredTeamIds: Id<"teams">[]
): Promise<LanguageRating> {
  const language = await ctx.runQuery(internal.languageSettings.getLeagueLanguage, { leagueId });
  for (const teamId of featuredTeamIds) {
    const team = await ctx.db.get(teamId);
    if (team && language.cleanTeamNames.includes(team.name)) return "clean";
  }
  return language.languageRating;
}

interface PostDeskArgs {
  leagueId: Id<"leagues">;
  seasonId: number;
  week?: number;
  kind: LeagueEventKind;
  persona: WirePersona;
  slots: WireSlots;
  dedupeKey: string;
  featuredTeams: Id<"teams">[];
  now: number;
}

/** Pick a stock line and insert it (subject to the league rate limit + dedupe), mirroring
 *  wireRoutine.ts's `postRoutine` - the "no line resolves" case is a silent no-op (spec §8.1). */
async function postDeskRoutine(
  ctx: MutationCtx,
  args: PostDeskArgs
): Promise<{ inserted: boolean; id?: Id<"wireLeaguePosts"> }> {
  const rating = await effectiveRating(ctx, args.leagueId, args.featuredTeams);
  const seed = `${args.leagueId}:${args.seasonId}:${args.week ?? 0}:${args.kind}:${args.dedupeKey}`;
  const picked = pickStockLine(args.persona, args.kind, args.slots, seed, rating);
  if (!picked) return { inserted: false };
  return await insertLeaguePostIfNew(ctx, args.now, {
    leagueId: args.leagueId,
    seasonId: args.seasonId,
    week: args.week,
    kind: args.kind,
    persona: args.persona,
    text: picked.text,
    tags: picked.tags,
    featuredTeams: args.featuredTeams,
    dedupeKey: args.dedupeKey,
  });
}

async function resolvePlayerFull(
  ctx: MutationCtx,
  espnId: string,
  season: number
): Promise<
  | { name: string; position?: string; nflTeam?: string; percentOwned?: number; injuryStatus?: string }
  | undefined
> {
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
  if (!row) return undefined;
  return {
    name: row.fullName,
    position: row.defaultPosition,
    nflTeam: row.proTeamAbbrev,
    percentOwned: row.ownership.percentOwned,
    injuryStatus: row.injuryStatus,
  };
}

/** The most recent injury_status/injury_note wireEvent for this player, if any (spec §18
 *  reads_the_wire / lineup_lock late-scratch). Bounded: a handful of events per player at most. */
async function findRecentInjuryEvent(
  ctx: MutationCtx,
  espnId: string
): Promise<{ observedAt: number; statusTo?: string } | null> {
  const events = await ctx.db
    .query("wireEvents")
    .withIndex("by_player_detected", (q) => q.eq("primaryEspnId", espnId))
    .order("desc")
    .take(20);
  for (const event of events) {
    if (event.kind !== "injury_status" && event.kind !== "injury_note") continue;
    try {
      const card = validateFactCard(event.facts);
      return { observedAt: event.observedAt, statusTo: card.statusTo };
    } catch {
      continue;
    }
  }
  return null;
}

function clampPostText(text: string, maxChars = 280): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

async function scheduleSamQuestion(
  ctx: MutationCtx,
  args: {
    leaguePostId: Id<"wireLeaguePosts">;
    leagueId: Id<"leagues">;
    seasonId: number;
    week?: number;
    teamId: Id<"teams">;
    move: MoveDescriptionInput;
  }
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.wireSocial.askSamAboutMove, {
    leaguePostId: args.leaguePostId,
    leagueId: args.leagueId,
    seasonId: args.seasonId,
    week: args.week,
    teamId: args.teamId,
    move: args.move,
  });
}

/* -------------------------------------------------------------------------- *
 * lineup_move / late_swap / reads_the_wire (spec §18, §16)
 * -------------------------------------------------------------------------- */

const LINEUP_MOVE_KINDS: ReadonlySet<string> = new Set(["lineup_move", "late_swap", "reads_the_wire"]);

/** The most recent lineup-move-family post for this team within the coalesce window (spec §18:
 *  "one post per team per 30 min; a further move in the window folds in"). */
async function findRecentLineupPost(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  teamId: Id<"teams">,
  now: number,
  windowMs: number
): Promise<Doc<"wireLeaguePosts"> | null> {
  const recent = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId).gt("createdAt", now - windowMs))
    .order("desc")
    .take(200);
  return (
    recent.find(
      (row) => LINEUP_MOVE_KINDS.has(row.kind) && row.deletedAt === undefined && row.featuredTeams.includes(teamId)
    ) ?? null
  );
}

interface LineupMoveArgs {
  leagueId: Id<"leagues">;
  seasonId: number;
  txn: Doc<"transactions">;
  teamByExternalId: Map<string, Doc<"teams">>;
  now: number;
}

async function handleLineupMove(ctx: MutationCtx, { leagueId, seasonId, txn, teamByExternalId, now }: LineupMoveArgs): Promise<void> {
  const items: LineupItemLike[] = txn.items.map((item) => ({
    type: item.type,
    playerId: item.playerId,
    fromLineupSlotId: item.fromLineupSlotId,
    toLineupSlotId: item.toLineupSlotId,
  }));
  const summary = summarizeLineupMove(items);
  if (summary.movedInPlayerId === undefined) return;

  const team = teamByExternalId.get(String(txn.teamId));
  if (!team) return;

  const player = await resolvePlayerFull(ctx, String(summary.movedInPlayerId), seasonId);
  const benchedPlayer =
    summary.benchedPlayerId !== undefined ? await resolvePlayerFull(ctx, String(summary.benchedPlayerId), seasonId) : undefined;

  const isFuture = txn.type === "FUTURE_ROSTER";
  const week = txn.scoringPeriod;

  let kind: "lineup_move" | "late_swap" | "reads_the_wire" = "lineup_move";
  let extraSlots: WireSlots = {};

  if (!isFuture) {
    // The kickoff lookup needs the moved player's NFL team; when it's unknown (or no schedule row
    // exists yet), `kickoff` stays undefined - late_swap simply never fires, and `isReadsTheWire`
    // treats a missing kickoff as "can't prove it was in-game" rather than excluding the move.
    const kickoff = player?.nflTeam ? await findTeamKickoff(ctx, seasonId, week, player.nflTeam) : undefined;
    if (kickoff !== undefined && isLateSwap(txn.proposedDate, kickoff)) {
      kind = "late_swap";
      extraSlots = { minutes: String(minutesUntil(kickoff, txn.proposedDate)) };
    } else {
      const injuryEvent = await findRecentInjuryEvent(ctx, String(summary.movedInPlayerId));
      if (
        injuryEvent &&
        isWorseThanActive(injuryEvent.statusTo) &&
        isReadsTheWire({ injuryObservedAt: injuryEvent.observedAt, proposedDate: txn.proposedDate, teamKickoffAt: kickoff })
      ) {
        kind = "reads_the_wire";
        extraSlots = { hoursAgo: hoursAgoPhrase(injuryEvent.observedAt, txn.proposedDate), status: injuryEvent.statusTo };
      }
    }
  }

  const slots: WireSlots = {
    team: team.name,
    manager: managerNameFor(team),
    player: player?.name,
    pos: player?.position,
    slot: lineupSlotName(summary.movedInToSlotId ?? -1),
    benched: benchedPlayer?.name,
    week: isFuture ? String(week) : undefined,
    ...extraSlots,
  };

  const existing = await findRecentLineupPost(ctx, leagueId, team._id, now, LINEUP_MOVE_COALESCE_MS_LOCAL);
  if (existing) {
    const baseText = existing.evolvingBaseText ?? existing.text;
    const count = (existing.evolvingCount ?? 1) + 1;
    const newText = clampPostText(`${baseText} UPDATE: ${countWord(count)} moves in the last half hour.`);
    await ctx.db.patch(existing._id, {
      text: newText,
      tags: [...new Set([...existing.tags, "UPDATE"])],
      evolvingCount: count,
      evolvingBaseText: baseText,
    });
    return;
  }

  if (!wireEnabled()) return;
  if (await leagueRateLimited(ctx, leagueId, kind, now)) return;

  const rating = await effectiveRating(ctx, leagueId, [team._id]);
  const seed = `${leagueId}:${seasonId}:${week}:${kind}:${team._id}:${now}`;
  const picked = pickStockLine("dex-alvarez", kind, slots, seed, rating);
  if (!picked) return;

  const postId = await ctx.db.insert("wireLeaguePosts", {
    leagueId,
    seasonId,
    week: isFuture ? undefined : week,
    kind,
    persona: "dex-alvarez",
    text: picked.text,
    tags: picked.tags,
    featuredTeams: [team._id],
    dedupeKey: `lineup:${leagueId}:${team._id}:${now}`,
    evolvingCount: 1,
    evolvingBaseText: picked.text,
    createdAt: now,
  });

  const notable = kind === "late_swap" || (player?.percentOwned ?? 0) >= SAM_NOTABLE_MIN_PERCENT_OWNED;
  if (notable && kind !== "reads_the_wire") {
    await scheduleSamQuestion(ctx, {
      leaguePostId: postId,
      leagueId,
      seasonId,
      week: isFuture ? undefined : week,
      teamId: team._id,
      move: {
        kind: kind === "late_swap" ? "late_swap" : "lineup_move",
        team: team.name,
        manager: managerNameFor(team) ?? "the manager",
        players: player?.name ? [player.name] : [],
        slot: slots.slot,
        benched: benchedPlayer?.name,
        minutes: extraSlots.minutes !== undefined ? Number(extraSlots.minutes) : undefined,
      },
    });
  }
}

// Local alias so this file doesn't need a second import line for the same constant under a
// different name collision with the schema field `evolvingCount`'s own semantics.
const LINEUP_MOVE_COALESCE_MS_LOCAL = 30 * 60 * 1000;

async function findTeamKickoff(
  ctx: MutationCtx,
  season: number,
  week: number,
  teamAbbrev: string
): Promise<number | undefined> {
  const row = await ctx.db
    .query("nflSchedules")
    .withIndex("by_season_week_team", (q) => q.eq("season", season).eq("week", week).eq("teamAbbrev", teamAbbrev))
    .first();
  return row?.gameTime;
}

/* -------------------------------------------------------------------------- *
 * trade_proposal / trade_declined (spec §18)
 * -------------------------------------------------------------------------- */

interface TradeArgs {
  leagueId: Id<"leagues">;
  seasonId: number;
  txn: Doc<"transactions">;
  teamByExternalId: Map<string, Doc<"teams">>;
  now: number;
  prefs: Doc<"leagueContentPreferences"> | null;
}

async function sidesFor(
  ctx: MutationCtx,
  seasonId: number,
  items: Doc<"transactions">["items"]
): Promise<Map<number, string[]>> {
  const bySide = new Map<number, string[]>();
  for (const item of items) {
    const player = await resolvePlayerFull(ctx, String(item.playerId), seasonId);
    if (!player) continue;
    const side = item.toTeamId > 0 ? item.toTeamId : item.fromTeamId;
    if (side <= 0) continue;
    const list = bySide.get(side) ?? [];
    list.push(player.name);
    bySide.set(side, list);
  }
  return bySide;
}

async function handleTradeProposal(ctx: MutationCtx, { leagueId, seasonId, txn, teamByExternalId, now, prefs }: TradeArgs): Promise<void> {
  if (prefs?.wireLeaks === false) return;

  // The proposer is the transaction's own `teamId` (spec §18 / stock-lines.ts's header: "team =
  // proposer, otherTeam = recipient") - never inferred from the items' from/toTeamId ordering.
  const externalIds = new Set<number>();
  for (const item of txn.items) {
    if (item.fromTeamId > 0) externalIds.add(item.fromTeamId);
    if (item.toTeamId > 0) externalIds.add(item.toTeamId);
  }
  const teamAExternal = txn.teamId;
  const teamBExternal = [...externalIds].find((id) => id !== teamAExternal);
  const teamA = teamByExternalId.get(String(teamAExternal));
  const teamB = teamBExternal !== undefined ? teamByExternalId.get(String(teamBExternal)) : undefined;
  if (!teamA) return;

  const bySide = await sidesFor(ctx, seasonId, txn.items);
  const sideA = (bySide.get(teamAExternal) ?? []).join(" & ");
  const sideB = teamBExternal !== undefined ? (bySide.get(teamBExternal) ?? []).join(" & ") : undefined;
  const playersLine = sideA && sideB ? `${sideA} for ${sideB}` : sideA || sideB;

  const dedupeKey = `proposal:${txn.espnTransactionId}`;
  const featuredTeams = teamB ? [teamA._id, teamB._id] : [teamA._id];
  const slots: WireSlots = { team: teamA.name, otherTeam: teamB?.name, players: playersLine, manager: managerNameFor(teamA) };

  const result = await postDeskRoutine(ctx, {
    leagueId,
    seasonId,
    week: txn.scoringPeriod,
    kind: "trade_proposal",
    persona: "dex-alvarez",
    slots,
    dedupeKey,
    featuredTeams,
    now,
  });

  if (result.inserted && result.id) {
    const movePlayers = [sideA, sideB].filter((s): s is string => Boolean(s));
    await scheduleSamQuestion(ctx, {
      leaguePostId: result.id,
      leagueId,
      seasonId,
      week: txn.scoringPeriod,
      teamId: teamA._id,
      move: { kind: "trade_proposal", team: teamA.name, manager: managerNameFor(teamA) ?? "the manager", players: movePlayers, otherTeam: teamB?.name },
    });
    if (teamB) {
      await scheduleSamQuestion(ctx, {
        leaguePostId: result.id,
        leagueId,
        seasonId,
        week: txn.scoringPeriod,
        teamId: teamB._id,
        move: { kind: "trade_proposal", team: teamB.name, manager: managerNameFor(teamB) ?? "the manager", players: movePlayers, otherTeam: teamA.name },
      });
    }
  }
}

async function handleTradeDeclined(ctx: MutationCtx, { leagueId, seasonId, txn, teamByExternalId, now, prefs }: TradeArgs): Promise<void> {
  if (prefs?.wireLeaks === false) return;

  const externalIds = new Set<number>();
  for (const item of txn.items) {
    if (item.fromTeamId > 0) externalIds.add(item.fromTeamId);
    if (item.toTeamId > 0) externalIds.add(item.toTeamId);
  }
  const declinerExternal = txn.teamId;
  const declinerTeam = teamByExternalId.get(String(declinerExternal));
  const otherExternal = [...externalIds].find((id) => id !== declinerExternal);
  const otherTeam = otherExternal !== undefined ? teamByExternalId.get(String(otherExternal)) : undefined;
  if (!declinerTeam) return;

  const dedupeKey = `declined:${txn.espnTransactionId}`;
  const featuredTeams = otherTeam ? [declinerTeam._id, otherTeam._id] : [declinerTeam._id];
  const slots: WireSlots = { team: declinerTeam.name, otherTeam: otherTeam?.name, manager: managerNameFor(declinerTeam) };
  await postDeskRoutine(ctx, {
    leagueId,
    seasonId,
    week: txn.scoringPeriod,
    kind: "trade_declined",
    persona: "dex-alvarez",
    slots,
    dedupeKey,
    featuredTeams,
    now,
  });
}

/* -------------------------------------------------------------------------- *
 * claims_in (spec §18 leak policy)
 * -------------------------------------------------------------------------- */

async function detectClaimsIn(
  ctx: MutationCtx,
  args: { league: Doc<"leagues">; leagueId: Id<"leagues">; seasonId: number; period: number; now: number; prefs: Doc<"leagueContentPreferences"> | null }
): Promise<void> {
  const { league, leagueId, seasonId, period, now, prefs } = args;
  if (prefs?.wireLeaks === false) return;

  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .filter((q) => q.and(q.eq(q.field("type"), "WAIVER"), q.eq(q.field("outcome"), "pending"), q.eq(q.field("scoringPeriod"), period)))
    .take(300);

  const byPlayer = new Map<number, { teams: Set<number>; topBid: number }>();
  for (const row of rows) {
    const addItem = row.items.find((item) => item.type === "ADD");
    if (!addItem) continue;
    const group = byPlayer.get(addItem.playerId) ?? { teams: new Set<number>(), topBid: 0 };
    group.teams.add(row.teamId);
    group.topBid = Math.max(group.topBid, row.bidAmount);
    byPlayer.set(addItem.playerId, group);
  }

  for (const [playerId, group] of byPlayer) {
    if (group.teams.size < CLAIMS_IN_MIN_TEAMS) continue;
    const player = await resolvePlayerFull(ctx, String(playerId), seasonId);
    const dedupeKey = `claims_in:${leagueId}:${seasonId}:${period}:${playerId}`;
    const heat = claimsHeat(group.topBid, league.settings?.faabBudget);
    const slots: WireSlots = { player: player?.name, pos: player?.position, count: countWord(group.teams.size), heat };

    const existing = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_dedupe", (q) => q.eq("leagueId", leagueId).eq("dedupeKey", dedupeKey))
      .first();
    if (existing) {
      if ((existing.evolvingCount ?? 0) < group.teams.size) {
        const baseText = existing.evolvingBaseText ?? existing.text;
        const newText = clampPostText(`${baseText} UPDATE: now ${countWord(group.teams.size)} teams.`);
        await ctx.db.patch(existing._id, {
          text: newText,
          tags: [...new Set([...existing.tags, "UPDATE"])],
          evolvingCount: group.teams.size,
          evolvingBaseText: baseText,
        });
      }
      continue;
    }

    if (!wireEnabled()) continue;
    if (await leagueRateLimited(ctx, leagueId, "claims_in", now)) continue;
    const rating = await effectiveRating(ctx, leagueId, []);
    const picked = pickStockLine("dex-alvarez", "claims_in", slots, dedupeKey, rating);
    if (!picked) continue;

    await ctx.db.insert("wireLeaguePosts", {
      leagueId,
      seasonId,
      week: period,
      kind: "claims_in",
      persona: "dex-alvarez",
      text: picked.text,
      tags: picked.tags,
      featuredTeams: [],
      dedupeKey,
      evolvingCount: group.teams.size,
      evolvingBaseText: picked.text,
      createdAt: now,
    });
  }
}

/* -------------------------------------------------------------------------- *
 * streaming_churn (spec §18)
 * -------------------------------------------------------------------------- */

async function handleStreamingChurn(ctx: MutationCtx, { leagueId, seasonId, txn, teamByExternalId, now }: LineupMoveArgs): Promise<void> {
  const addItem = txn.items.find((item) => item.type === "ADD");
  if (!addItem) return;
  const player = await resolvePlayerFull(ctx, String(addItem.playerId), seasonId);
  if (!player) return;
  const unit = player.position === "D/ST" ? "D/ST" : player.position === "K" ? "K" : undefined;
  if (!unit) return;
  const team = teamByExternalId.get(String(txn.teamId));
  if (!team) return;

  const periodFrom = txn.scoringPeriod - STREAMING_CHURN_WEEKS + 1;
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .filter((q) =>
      q.and(
        q.eq(q.field("teamId"), txn.teamId),
        q.eq(q.field("outcome"), "executed"),
        q.gte(q.field("scoringPeriod"), periodFrom),
        q.lte(q.field("scoringPeriod"), txn.scoringPeriod)
      )
    )
    .take(300);

  const distinctPlayers = new Set<number>();
  for (const row of rows) {
    if (row.type !== "FREEAGENT" && row.type !== "WAIVER") continue;
    const add = row.items.find((item) => item.type === "ADD");
    if (!add) continue;
    const p = await resolvePlayerFull(ctx, String(add.playerId), seasonId);
    if (p?.position === unit) distinctPlayers.add(add.playerId);
  }
  if (distinctPlayers.size < STREAMING_CHURN_MIN_ADDS) return;

  const weekBucket = Math.floor(txn.scoringPeriod / 3);
  const dedupeKey = `streaming_churn:${leagueId}:${team._id}:${unit}:${weekBucket}`;
  const slots: WireSlots = {
    team: team.name,
    manager: managerNameFor(team),
    unit,
    count: countWord(distinctPlayers.size),
    player: player.name,
    streak: `${ordinalWord(distinctPlayers.size)} ${unit} in ${STREAMING_CHURN_WEEKS} weeks`,
  };
  await postDeskRoutine(ctx, {
    leagueId,
    seasonId,
    week: txn.scoringPeriod,
    kind: "streaming_churn",
    persona: "dex-alvarez",
    slots,
    dedupeKey,
    featuredTeams: [team._id],
    now,
  });
}

/* -------------------------------------------------------------------------- *
 * onTransactionsUpsertedForDex (espnSync.ts#upsertTransactions -> here, alongside
 * wireRoutine.onTransactionsUpserted)
 * -------------------------------------------------------------------------- */

export const onTransactionsUpsertedForDex = internalMutation({
  args: { leagueId: v.id("leagues"), seasonId: v.number(), espnTransactionIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { leagueId, seasonId, espnTransactionIds }) => {
    const league = await ctx.db.get(leagueId);
    if (!league || !hasActivePass(league)) return null;
    const prefs = await getPrefs(ctx, leagueId);
    if (prefs?.wireEnabled === false) return null;

    const draftPhase = await draftPhaseFor(ctx, leagueId, seasonId);

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .take(40);
    const teamByExternalId = new Map(teams.map((t) => [t.externalId, t]));

    const now = Date.now();
    const cutoff = now - RECENT_TXN_WINDOW_MS;
    const periodsSeen = new Set<number>();

    for (const espnTransactionId of espnTransactionIds.slice(0, 300)) {
      const txn = await ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", espnTransactionId))
        .first();
      if (!txn) continue;
      periodsSeen.add(txn.scoringPeriod);

      const eventDate = txn.processDate ?? txn.proposedDate;
      if (eventDate < cutoff) continue;

      const commonArgs = { leagueId, seasonId, txn, teamByExternalId, now };

      if ((txn.type === "ROSTER" || txn.type === "FUTURE_ROSTER") && draftPhase !== "predraft_redraft") {
        await handleLineupMove(ctx, commonArgs);
      } else if (txn.type === "TRADE_PROPOSAL") {
        if (txn.outcome === "pending") await handleTradeProposal(ctx, { ...commonArgs, prefs });
        else if (txn.outcome === "cancelled") await handleTradeDeclined(ctx, { ...commonArgs, prefs });
      } else if (txn.type === "TRADE_DECLINE" && txn.outcome === "executed") {
        await handleTradeDeclined(ctx, { ...commonArgs, prefs });
      } else if ((txn.type === "FREEAGENT" || txn.type === "WAIVER") && txn.outcome === "executed") {
        await handleStreamingChurn(ctx, commonArgs);
      }
    }

    if (draftPhase !== "predraft_redraft") {
      for (const period of periodsSeen) {
        await detectClaimsIn(ctx, { league, leagueId, seasonId, period, now, prefs });
      }
    }

    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * roster_note / faab_watch (espnSync.ts#updateTeams -> here)
 * -------------------------------------------------------------------------- */

const ROSTER_NOTE_WINDOW_MS = 14 * DAY_MS;
/** roster_note IR branch (spec §18 "Not built"): an Active player parked in an IR slot for at
 *  least this long fires once (the season-scoped dedupeKey below then keeps it from repeating). */
const IR_ACTIVE_MIN_AGE_MS = 14 * DAY_MS;

export const onRosterSynced = internalMutation({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  returns: v.null(),
  handler: async (ctx, { leagueId, seasonId }) => {
    const league = await ctx.db.get(leagueId);
    if (!league || !hasActivePass(league)) return null;
    const prefs = await getPrefs(ctx, leagueId);
    if (prefs?.wireEnabled === false) return null;

    const draftPhase = await draftPhaseFor(ctx, leagueId, seasonId);
    if (draftPhase === "predraft_redraft") return null;

    const now = Date.now();
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .take(40);

    for (const team of teams) {
      const benchByPosition = new Map<string, number>();
      for (const entry of team.roster) {
        if (entry.lineupSlotId !== BENCH_SLOT_ID) continue;
        benchByPosition.set(entry.position, (benchByPosition.get(entry.position) ?? 0) + 1);
      }
      for (const [position, count] of benchByPosition) {
        if (count < ROSTER_NOTE_BENCH_MIN) continue;
        const windowBucket = Math.floor(now / ROSTER_NOTE_WINDOW_MS);
        const dedupeKey = `roster_note:${leagueId}:${team._id}:${position}:${windowBucket}`;
        const slots: WireSlots = { team: team.name, manager: managerNameFor(team), position, benchCount: String(count) };
        await postDeskRoutine(ctx, { leagueId, seasonId, kind: "roster_note", persona: "nina-sharpe", slots, dedupeKey, featuredTeams: [team._id], now });
      }

      if (league.settings?.waiverType === "faab" && league.settings.faabBudget !== undefined) {
        const budget = league.settings.faabBudget;
        const spent = team.transactionCounter?.acquisitionBudgetSpent ?? 0;
        const fraction = faabRemainingFraction(budget, spent);
        if (fraction < FAAB_WATCH_MAX_FRACTION) {
          const currentWeek = (await currentMatchupPeriod(ctx, leagueId, seasonId)) ?? 1;
          const regularSeasonWeeks = league.settings?.regularSeasonMatchupPeriods ?? 14;
          const weeksLeft = Math.max(0, regularSeasonWeeks - currentWeek);
          if (weeksLeft >= FAAB_WATCH_MIN_WEEKS_LEFT) {
            const dedupeKey = `faab_watch:${leagueId}:${seasonId}:${team._id}`;
            const left = Math.max(0, budget - spent);
            const slots: WireSlots = { team: team.name, manager: managerNameFor(team), faabLeft: `$${left}`, weeksLeft: String(weeksLeft) };
            await postDeskRoutine(ctx, { leagueId, seasonId, kind: "faab_watch", persona: "nina-sharpe", slots, dedupeKey, featuredTeams: [team._id], now });
          }
        }
      }
    }

    // roster_note IR branch (spec §18 "Not built"): a player parked in the IR slot (21) while
    // ESPN still lists him Active for 14+ days. `wireDeskState` (kind "ir_active") tracks how long
    // he's been sitting there and dedupes the post to once a season. A separate pass from the
    // per-team loop above: a tracked player's row must be cleared the moment he leaves IR (or his
    // status stops reading Active) even on a sync where his CURRENT roster entry never lands on
    // slot 21 at all (traded away, dropped, moved to the bench) - reconciling against every
    // existing tracked row, not just this sync's IR-slot entries, is what catches that case.
    const activeIrPlayers = new Map<string, { team: Doc<"teams">; playerName: string; status: string }>();
    for (const team of teams) {
      for (const entry of team.roster) {
        if (entry.lineupSlotId !== IR_SLOT_ID) continue;
        const player = await resolvePlayerFull(ctx, entry.playerId, seasonId);
        const status = player?.injuryStatus;
        if ((status ?? "").trim().toLowerCase() !== "active") continue;
        activeIrPlayers.set(entry.playerId, { team, playerName: player?.name ?? entry.playerName, status: status ?? "Active" });
      }
    }

    const existingIrStates = await ctx.db
      .query("wireDeskState")
      .withIndex("by_league_kind_key", (q) => q.eq("leagueId", leagueId).eq("kind", "ir_active"))
      .take(200);
    for (const row of existingIrStates) {
      if (!activeIrPlayers.has(row.key)) await ctx.db.delete(row._id);
    }

    for (const [playerId, info] of activeIrPlayers) {
      const existingState = existingIrStates.find((row) => row.key === playerId);
      if (existingState) {
        await ctx.db.patch(existingState._id, { lastSeenAt: now });
      } else {
        await ctx.db.insert("wireDeskState", { leagueId, kind: "ir_active", key: playerId, firstSeenAt: now, lastSeenAt: now });
      }

      const firstSeenAt = existingState?.firstSeenAt ?? now;
      if (now - firstSeenAt < IR_ACTIVE_MIN_AGE_MS) continue;

      const dedupeKey = `roster_note_ir:${leagueId}:${seasonId}:${playerId}`;
      const slots: WireSlots = { team: info.team.name, player: info.playerName, status: info.status };
      await postDeskRoutine(ctx, { leagueId, seasonId, kind: "roster_note", persona: "nina-sharpe", slots, dedupeKey, featuredTeams: [info.team._id], now });
    }

    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * rumor_check (wire.ts#postAsManager -> here, manager_post only)
 * -------------------------------------------------------------------------- */

export const checkRumor = internalMutation({
  args: { leaguePostId: v.id("wireLeaguePosts") },
  returns: v.null(),
  handler: async (ctx, { leaguePostId }) => {
    const post = await ctx.db.get(leaguePostId);
    if (!post || post.deletedAt !== undefined || post.kind !== "manager_post") return null;
    if (!looksLikeRumor(post.text)) return null;

    const league = await ctx.db.get(post.leagueId);
    if (!league || !hasActivePass(league)) return null;
    const prefs = await getPrefs(ctx, post.leagueId);
    if (prefs?.wireEnabled === false) return null;

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", post.leagueId).eq("seasonId", post.seasonId))
      .take(40);
    const lastNames = new Map<string, string[]>();
    const nameToPlayerId = new Map<string, string>();
    for (const team of teams) {
      for (const entry of team.roster) {
        const parts = entry.playerName.trim().split(/\s+/);
        const last = parts[parts.length - 1]?.toLowerCase();
        if (!last) continue;
        const names = lastNames.get(last) ?? [];
        if (!names.includes(entry.playerName)) names.push(entry.playerName);
        lastNames.set(last, names);
        nameToPlayerId.set(entry.playerName, entry.playerId);
      }
    }
    const mentioned = findUniqueRosteredMention(post.text, lastNames);
    if (!mentioned) return null;
    const mentionedPlayerId = nameToPlayerId.get(mentioned);

    // Confirm branch (spec §18, gated by wireLeaks): {players} carries the pieces on the matching
    // pending proposal - pickStockLine (via stock-lines.ts's rumorBranchFor) infers confirm vs deny
    // from whether {players} resolves, so it is set ONLY when a real match exists.
    let playersLine: string | undefined;
    if (mentionedPlayerId !== undefined && prefs?.wireLeaks !== false) {
      const proposals = await ctx.db
        .query("transactions")
        .withIndex("by_season", (q) => q.eq("leagueId", post.leagueId).eq("seasonId", post.seasonId))
        .filter((q) => q.and(q.eq(q.field("type"), "TRADE_PROPOSAL"), q.eq(q.field("outcome"), "pending")))
        .take(200);
      const matching = proposals.find((p) => p.items.some((item) => String(item.playerId) === mentionedPlayerId));
      if (matching) {
        const names: string[] = [];
        for (const item of matching.items) {
          const p = await resolvePlayerFull(ctx, String(item.playerId), post.seasonId);
          if (p) names.push(p.name);
        }
        if (names.length > 0) playersLine = joinNames(names);
      }
    }

    let managerName: string | undefined;
    if (post.authorUserId) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", post.authorUserId!))
        .unique();
      managerName = user?.name?.trim();
    }
    if (!managerName && post.authorTeamId) {
      const team = await ctx.db.get(post.authorTeamId);
      managerName = team ? managerNameFor(team) : undefined;
    }

    const dedupeKey = `rumor_check:${leaguePostId}`;
    const slots: WireSlots = { manager: managerName ?? "A manager", player: mentioned, players: playersLine };
    await postDeskRoutine(ctx, {
      leagueId: post.leagueId,
      seasonId: post.seasonId,
      week: post.week,
      kind: "rumor_check",
      persona: "dex-alvarez",
      slots,
      dedupeKey,
      featuredTeams: post.authorTeamId ? [post.authorTeamId] : [],
      now: Date.now(),
    });
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * ownership_swing (global card; playerSync.ts#syncPlayersDefaultStats -> here)
 * -------------------------------------------------------------------------- */

const OWNERSHIP_SWING_DAILY_CAP = 10;
const OWNERSHIP_SWING_MAX_PAGES = 20;

export const listPlayersForSeasonPage = internalQuery({
  args: { season: v.number(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      espnId: v.string(),
      fullName: v.string(),
      defaultPosition: v.string(),
      proTeamAbbrev: v.optional(v.string()),
      percentOwned: v.number(),
      percentChange: v.optional(v.number()),
    })
  ),
  handler: async (ctx, { season, paginationOpts }) => {
    const result = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_season", (q) => q.eq("season", season))
      .paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map((p) => ({
        espnId: p.espnId,
        fullName: p.fullName,
        defaultPosition: p.defaultPosition,
        proTeamAbbrev: p.proTeamAbbrev,
        percentOwned: p.ownership.percentOwned,
        percentChange: p.ownership.percentChange,
      })),
    };
  },
});

export const detectOwnershipSwings = internalAction({
  args: { season: v.number() },
  returns: v.null(),
  handler: async (ctx, { season }) => {
    if (!wireEnabled()) return null;
    let cursor: string | null = null;
    const candidates: Array<{
      espnId: string;
      fullName: string;
      defaultPosition: string;
      proTeamAbbrev?: string;
      percentOwned: number;
      percentChange: number;
    }> = [];

    for (let page = 0; page < OWNERSHIP_SWING_MAX_PAGES; page++) {
      const result: {
        page: Array<{ espnId: string; fullName: string; defaultPosition: string; proTeamAbbrev?: string; percentOwned: number; percentChange?: number }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.wireDesk.listPlayersForSeasonPage, { season, paginationOpts: { numItems: 500, cursor } });
      for (const p of result.page) {
        if (typeof p.percentChange !== "number") continue;
        if (Math.abs(p.percentChange) < OWNERSHIP_SWING_MIN_POINTS) continue;
        if (p.percentOwned < OWNERSHIP_SWING_MIN_OWNED) continue;
        candidates.push({ ...p, percentChange: p.percentChange });
      }
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    candidates.sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange));
    const top = candidates.slice(0, OWNERSHIP_SWING_DAILY_CAP);
    for (const c of top) {
      await ctx.runMutation(internal.wireDesk.insertOwnershipSwingEvent, { season, ...c });
    }
    return null;
  },
});

export const insertOwnershipSwingEvent = internalMutation({
  args: {
    season: v.number(),
    espnId: v.string(),
    fullName: v.string(),
    defaultPosition: v.string(),
    proTeamAbbrev: v.optional(v.string()),
    percentOwned: v.number(),
    percentChange: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!wireEnabled()) return null;
    const now = Date.now();
    const dateKey = new Date(now).toISOString().slice(0, 10);
    const dedupeKey = `ownership_swing:${args.espnId}:${dateKey}`;
    const already = await ctx.db
      .query("wireEvents")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
      .first();
    if (already) return null;

    const direction = args.percentChange >= 0 ? "added" : "dropped";
    const pct = `${Math.abs(Math.round(args.percentChange))}%`;
    const headline = `${args.fullName} ${direction} in ${pct} of ESPN leagues overnight.`;

    const cardInput = {
      kind: "ownership_swing" as const,
      observedAt: now,
      players: [
        {
          espnId: args.espnId,
          name: args.fullName,
          position: args.defaultPosition,
          nflTeam: args.proTeamAbbrev,
          percentOwned: args.percentOwned,
        },
      ],
      nflTeam: args.proTeamAbbrev,
      headline,
      ownershipChange: args.percentChange,
      source: { type: "espn_fantasy" as const, fetchedAt: now },
    };

    let card: WireFactCard;
    try {
      card = validateFactCard(cardInput);
    } catch (err) {
      console.warn(`wireDesk.insertOwnershipSwingEvent: invalid card for espnId ${args.espnId}`, err);
      return null;
    }

    const interest = Math.max(0, Math.min(100, Math.round(scoreInterest(card))));
    if (interest < CARD_MIN_INTEREST) return null;

    const eventId = await ctx.db.insert("wireEvents", {
      kind: "ownership_swing",
      dedupeKey,
      observedAt: now,
      detectedAt: now,
      players: card.players,
      primaryEspnId: args.espnId,
      nflTeam: args.proTeamAbbrev,
      facts: card,
      interest,
      source: cardInput.source,
    });

    const persona = WIRE_PERSONA_FOR_KIND.ownership_swing;
    const rendered = renderCard(card);
    let status: "card" | "take_pending" = "card";
    let flags: string[] = [];
    if (interest >= TAKE_MIN_INTEREST) {
      const hourAgo = now - HOUR_MS;
      const [pending, taken] = await Promise.all([
        ctx.db.query("wirePosts").withIndex("by_status_created", (q) => q.eq("status", "take_pending").gt("createdAt", hourAgo)).take(200),
        ctx.db.query("wirePosts").withIndex("by_status_created", (q) => q.eq("status", "take").gt("createdAt", hourAgo)).take(200),
      ]);
      if (pending.length + taken.length >= GLOBAL_TAKES_PER_HOUR) {
        flags = ["rate_limited"];
      } else {
        status = "take_pending";
      }
    }

    const postId = await ctx.db.insert("wirePosts", {
      eventId,
      kind: "ownership_swing",
      persona,
      text: rendered.text,
      tags: rendered.tags,
      status,
      interest,
      generationStats: flags.length > 0 ? { costUsd: 0, model: WIRE_DEFAULT_ROUTE.model, effort: WIRE_DEFAULT_ROUTE.effort, flags } : undefined,
      createdAt: now,
      updatedAt: now,
    });

    if (status === "card") {
      await ctx.scheduler.runAfter(0, internal.wireOverlay.fanOutGlobalPost, { postId });
    }
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * NFL schedule polling + lineup-lock scheduling (wireSourcesNode.ts#pollNflSchedule -> here)
 * -------------------------------------------------------------------------- */

const nflScheduleRowValidator = v.object({
  season: v.number(),
  week: v.number(),
  teamId: v.number(),
  teamAbbrev: v.string(),
  opponent: v.string(),
  isHome: v.boolean(),
  gameTime: v.number(),
  isByeWeek: v.boolean(),
});

export const upsertNflScheduleRows = internalMutation({
  args: { rows: v.array(nflScheduleRowValidator) },
  returns: v.object({ upserted: v.number() }),
  handler: async (ctx, { rows }) => {
    const now = Date.now();
    let upserted = 0;
    for (const row of rows.slice(0, 500)) {
      const existing = await ctx.db
        .query("nflSchedules")
        .withIndex("by_season_week_team", (q) => q.eq("season", row.season).eq("week", row.week).eq("teamAbbrev", row.teamAbbrev))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          teamId: row.teamId,
          opponent: row.opponent,
          isHome: row.isHome,
          gameTime: row.gameTime,
          isByeWeek: row.isByeWeek,
        });
      } else {
        await ctx.db.insert("nflSchedules", { ...row, createdAt: now });
      }
      upserted++;
    }
    return { upserted };
  },
});

const kickoffToScheduleValidator = v.object({ kickoffAt: v.number(), season: v.number(), week: v.number() });

interface KickoffCursor {
  scheduled: number[];
  /** "season:week" pairs whose on-bye lineup_lock check (spec §18) has already been scheduled. */
  byeScheduled?: string[];
}

export const scheduleLineupLockChecks = internalMutation({
  args: { kickoffs: v.array(kickoffToScheduleValidator) },
  returns: v.object({ scheduled: v.number(), byeScheduled: v.number() }),
  handler: async (ctx, { kickoffs }) => {
    const state = await ctx.db
      .query("wireSourceState")
      .withIndex("by_source", (q) => q.eq("source", "nfl_kickoffs"))
      .first();
    const priorCursor = (state?.cursor as KickoffCursor | undefined) ?? { scheduled: [] };
    const already = new Set(priorCursor.scheduled ?? []);
    const byeAlready = new Set(priorCursor.byeScheduled ?? []);
    const now = Date.now();
    let scheduled = 0;

    for (const { kickoffAt, season, week } of kickoffs) {
      if (already.has(kickoffAt) || kickoffAt <= now) continue;
      await ctx.scheduler.runAt(Math.max(now, kickoffAt - LINEUP_LOCK_WARNING_MS), internal.wireDesk.lineupLockWarning, {
        kickoffAt,
        season,
        week,
      });
      await ctx.scheduler.runAt(kickoffAt + 2 * 60 * 1000, internal.wireDesk.lineupLockPublic, { kickoffAt, season, week });
      already.add(kickoffAt);
      scheduled++;
    }

    // The on-bye lineup_lock trigger (spec §18 "Not built"): a bye has no kickoff of its own to
    // anchor to, so it anchors to the week's FIRST SUNDAY kickoff instead - scheduled once per
    // (season, week), from whichever future kickoffs this call happens to see for that week.
    const kickoffsByWeek = new Map<string, number[]>();
    for (const { kickoffAt, season, week } of kickoffs) {
      if (kickoffAt <= now) continue;
      const key = `${season}:${week}`;
      const list = kickoffsByWeek.get(key) ?? [];
      list.push(kickoffAt);
      kickoffsByWeek.set(key, list);
    }
    let byeScheduled = 0;
    for (const [key, times] of kickoffsByWeek) {
      if (byeAlready.has(key)) continue;
      const sundayKickoff = firstSundayKickoff(times);
      if (sundayKickoff === undefined) continue;
      const [seasonStr, weekStr] = key.split(":");
      const season = Number(seasonStr);
      const week = Number(weekStr);
      await ctx.scheduler.runAt(Math.max(now, sundayKickoff - LINEUP_LOCK_WARNING_MS), internal.wireDesk.lineupLockWarning, {
        kickoffAt: sundayKickoff,
        season,
        week,
        bye: true,
      });
      await ctx.scheduler.runAt(sundayKickoff + 2 * 60 * 1000, internal.wireDesk.lineupLockPublic, {
        kickoffAt: sundayKickoff,
        season,
        week,
        bye: true,
      });
      byeAlready.add(key);
      byeScheduled++;
    }

    const pruned = [...already].filter((ts) => ts > now - DAY_MS);
    // "season:week" strings never carry their own timestamp to age out by - capped by count instead.
    const prunedBye = [...byeAlready].slice(-100);
    const summary = `${scheduled} new kickoff(s) scheduled, ${byeScheduled} bye check(s) scheduled`;
    const cursor: KickoffCursor = { scheduled: pruned, byeScheduled: prunedBye };
    if (state) {
      await ctx.db.patch(state._id, { cursor, lastRunAt: now, ok: true, summary });
    } else {
      await ctx.db.insert("wireSourceState", { source: "nfl_kickoffs", cursor, lastRunAt: now, ok: true, summary });
    }
    return { scheduled, byeScheduled };
  },
});

/* -------------------------------------------------------------------------- *
 * lineup_lock: private warning, then public post unless a late scratch (spec §16/§18)
 * -------------------------------------------------------------------------- */

interface LockedStarterHit {
  leagueId: Id<"leagues">;
  team: Doc<"teams">;
  playerId: string;
  playerName: string;
  slot: string;
  status: string;
}

async function findLockedStarters(ctx: MutationCtx, season: number, week: number, kickoffAt: number): Promise<LockedStarterHit[]> {
  const schedRows = await ctx.db
    .query("nflSchedules")
    .withIndex("by_week", (q) => q.eq("season", season).eq("week", week))
    .take(64);
  const teamsAtKickoff = new Set(schedRows.filter((r) => r.gameTime === kickoffAt).map((r) => r.teamAbbrev));
  if (teamsAtKickoff.size === 0) return [];

  const hits: LockedStarterHit[] = [];
  // Bounded: the whole `leagues` table, same pattern as `wireOverlay.fanOutGlobalPost`'s
  // `internal.leagues.listLeagues` (a handful of hundred leagues at most today).
  const leagues = await ctx.db.query("leagues").take(1000);
  for (const league of leagues) {
    if (!hasActivePass(league)) continue;
    const prefs = await getPrefs(ctx, league._id);
    if (prefs?.wireEnabled === false) continue;

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", league._id).eq("seasonId", season))
      .take(40);
    for (const team of teams) {
      for (const entry of team.roster) {
        if (entry.lineupSlotId === undefined || !isStartingSlot(entry.lineupSlotId)) continue;
        const player = await resolvePlayerFull(ctx, entry.playerId, season);
        if (!player?.nflTeam || !teamsAtKickoff.has(player.nflTeam)) continue;
        if (!isLockoutStatus(player.injuryStatus)) continue;
        hits.push({
          leagueId: league._id,
          team,
          playerId: entry.playerId,
          playerName: player.name,
          slot: lineupSlotName(entry.lineupSlotId),
          status: player.injuryStatus!,
        });
      }
    }
  }
  return hits;
}

/** The on-bye lineup_lock trigger (spec §18 "Not built"): every starter whose NFL team has no
 *  game at all this week (no `nflSchedules` row for that team, or one explicitly marked
 *  `isByeWeek`). Unlike {@link findLockedStarters} this isn't anchored to one exact kickoff
 *  instant - the caller passes the week's first Sunday kickoff (`firstSundayKickoff`) purely for
 *  the notification/post's own "minutes to kickoff" framing and dedupe key. */
async function findByeStarters(ctx: MutationCtx, season: number, week: number): Promise<LockedStarterHit[]> {
  const schedRows = await ctx.db
    .query("nflSchedules")
    .withIndex("by_week", (q) => q.eq("season", season).eq("week", week))
    .take(64);
  const teamsWithGame = new Set(schedRows.filter((r) => !r.isByeWeek).map((r) => r.teamAbbrev));
  const explicitByeTeams = new Set(schedRows.filter((r) => r.isByeWeek).map((r) => r.teamAbbrev));

  const hits: LockedStarterHit[] = [];
  const leagues = await ctx.db.query("leagues").take(1000);
  for (const league of leagues) {
    if (!hasActivePass(league)) continue;
    const prefs = await getPrefs(ctx, league._id);
    if (prefs?.wireEnabled === false) continue;

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", league._id).eq("seasonId", season))
      .take(40);
    for (const team of teams) {
      for (const entry of team.roster) {
        if (entry.lineupSlotId === undefined || !isStartingSlot(entry.lineupSlotId)) continue;
        const player = await resolvePlayerFull(ctx, entry.playerId, season);
        if (!player?.nflTeam) continue;
        const onBye = explicitByeTeams.has(player.nflTeam) || !teamsWithGame.has(player.nflTeam);
        if (!onBye) continue;
        hits.push({
          leagueId: league._id,
          team,
          playerId: entry.playerId,
          playerName: player.name,
          slot: lineupSlotName(entry.lineupSlotId),
          status: "on bye",
        });
      }
    }
  }
  return hits;
}

export const lineupLockWarning = internalMutation({
  args: { kickoffAt: v.number(), season: v.number(), week: v.number(), bye: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { kickoffAt, season, week, bye }) => {
    const hits = bye ? await findByeStarters(ctx, season, week) : await findLockedStarters(ctx, season, week, kickoffAt);
    const now = Date.now();
    for (const found of hits) {
      const user = await userForTeam(ctx, found.team._id, season);
      if (!user) continue;
      const minutes = minutesUntil(kickoffAt, now);
      await ctx.runMutation(internal.notifications.createNotification, {
        userId: user._id,
        leagueId: found.leagueId,
        type: "wire_alert",
        title: `${found.playerName} is ${found.status} and still in your lineup`,
        message: `${found.playerName} (${found.slot}) is ${found.status} with about ${minutes} minutes to kickoff.`,
        actionUrl: `/leagues/${found.leagueId}/wire`,
        relatedEntityType: "wire_post",
        priority: "high",
        deliveryChannels: ["in_app"],
        dedupeKey: `lock:${found.team._id}:${found.playerId}:${kickoffAt}`,
      });
    }
    return null;
  },
});

export const lineupLockPublic = internalMutation({
  args: { kickoffAt: v.number(), season: v.number(), week: v.number(), bye: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { kickoffAt, season, week, bye }) => {
    const hits = bye ? await findByeStarters(ctx, season, week) : await findLockedStarters(ctx, season, week, kickoffAt);
    const now = Date.now();
    for (const found of hits) {
      if (!bye) {
        // Late scratch (spec §16/§18): only meaningful for a real kickoff - a bye has no status
        // that can land "just before" it.
        const injuryEvent = await findRecentInjuryEvent(ctx, found.playerId);
        if (injuryEvent && isLateScratch(injuryEvent.observedAt, kickoffAt)) continue; // no post
      }

      const dedupeKey = `lineup_lock:${found.team._id}:${found.playerId}:${kickoffAt}`;
      const slots: WireSlots = { team: found.team.name, manager: managerNameFor(found.team), player: found.playerName, status: found.status };
      await postDeskRoutine(ctx, {
        leagueId: found.leagueId,
        seasonId: season,
        week,
        kind: "lineup_lock",
        persona: "dex-alvarez",
        slots,
        dedupeKey,
        featuredTeams: [found.team._id],
        now,
      });
    }
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * Crons: pollTransactionLogs (15 min, in season), hourlyDeskCron (weekly_rundown, quiet_desk)
 * -------------------------------------------------------------------------- */

export const getPrefsInternal = internalQuery({
  args: { leagueId: v.id("leagues") },
  returns: v.union(
    v.object({ wireEnabled: v.optional(v.boolean()), wireLeaks: v.optional(v.boolean()), timezone: v.optional(v.string()) }),
    v.null()
  ),
  handler: async (ctx, { leagueId }) => {
    const prefs = await ctx.db
      .query("leagueContentPreferences")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .first();
    if (!prefs) return null;
    return { wireEnabled: prefs.wireEnabled, wireLeaks: prefs.wireLeaks, timezone: prefs.timezone };
  },
});

/** Exported so `wireLive.ts` (the live game engine, spec §19) can gate `pullLeagueLive` the same
 *  way `pollTransactionLogs` gates itself - drafts and the first lineup moves happen before Week 1. */
export async function inSeasonNow(ctx: ActionCtx, now: number): Promise<boolean> {
  try {
    const phase: { phase: string } | null = await ctx.runQuery(internal.nflSeasonBoundaries.getNFLSeasonPhase, { date: now });
    // Preseason counts: drafts and the first lineup moves happen before Week 1 (owner's league
    // drafts the week before kickoff), and the poll is one cheap call per league.
    if (phase) return phase.phase === "PRESEASON" || phase.phase === "REGULAR_SEASON" || phase.phase === "PLAYOFFS";
  } catch {
    // fall through to the month fallback
  }
  return isInSeasonByMonth(new Date(now));
}

export const pollTransactionLogs = internalAction({
  args: {},
  returns: v.object({ success: v.boolean(), leaguesPolled: v.number(), error: v.optional(v.string()) }),
  handler: async (ctx) => {
    const now = Date.now();
    try {
      if (!wireEnabled()) return { success: true, leaguesPolled: 0 };
      if (!(await inSeasonNow(ctx, now))) {
        await ctx.runMutation(internal.wireDetect.recordSourceRun, { source: "espn_transactions", ok: true, summary: "off season - skipped" });
        return { success: true, leaguesPolled: 0 };
      }

      const leagues: Array<Doc<"leagues">> = await ctx.runQuery(internal.leagues.listLeagues, {});
      let leaguesPolled = 0;
      for (const league of leagues) {
        if (!hasActivePass(league)) continue;
        if (!league.espnData || league.espnData.credentialStatus === "invalid") continue;
        const prefs = await ctx.runQuery(internal.wireDesk.getPrefsInternal, { leagueId: league._id });
        if (prefs?.wireEnabled === false) continue;

        const period = league.espnData.currentScoringPeriod;
        if (!period) continue;
        try {
          await ctx.runAction(internal.espnSync.syncTransactionLog, {
            leagueId: league._id,
            seasonId: league.espnData.seasonId,
            scoringPeriods: [period],
          });
          leaguesPolled++;
        } catch (err) {
          console.error(`wireDesk.pollTransactionLogs: failed for league ${league._id}`, err);
        }
      }

      await ctx.runMutation(internal.wireDetect.recordSourceRun, {
        source: "espn_transactions",
        ok: true,
        summary: `${leaguesPolled} league(s) polled`,
      });
      return { success: true, leaguesPolled };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to poll transaction logs";
      console.error("wireDesk.pollTransactionLogs failed:", message);
      try {
        await ctx.runMutation(internal.wireDetect.recordSourceRun, { source: "espn_transactions", ok: false, summary: "threw", error: message });
      } catch {
        // best-effort
      }
      return { success: false, leaguesPolled: 0, error: message };
    }
  },
});

export const hourlyDeskCron = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!wireEnabled()) return null;
    const now = Date.now();
    if (!(await inSeasonNow(ctx, now))) return null;

    const leagues: Array<Doc<"leagues">> = await ctx.runQuery(internal.leagues.listLeagues, {});
    for (const league of leagues) {
      if (!hasActivePass(league)) continue;
      const prefs = await ctx.runQuery(internal.wireDesk.getPrefsInternal, { leagueId: league._id });
      if (prefs?.wireEnabled === false) continue;
      const timezone = prefs?.timezone ?? "America/New_York";

      if (isWeeklyRundownHour(now, timezone)) {
        await ctx.scheduler.runAfter(0, internal.wireDesk.postWeeklyRundownForLeague, { leagueId: league._id });
      }

      if (isQuietDeskDay(now, timezone) && prefs?.wireLeaks !== false) {
        const tradeDeadline = league.settings?.tradeDeadline;
        if (isWithinQuietDeskWindow(now, tradeDeadline)) {
          await ctx.scheduler.runAfter(0, internal.wireDesk.postQuietDeskForLeague, { leagueId: league._id });
        }
      }
    }
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * weekly_rundown (spec §18)
 * -------------------------------------------------------------------------- */

export const postWeeklyRundownForLeague = internalMutation({
  args: { leagueId: v.id("leagues") },
  returns: v.null(),
  handler: async (ctx, { leagueId }) => {
    const league = await ctx.db.get(leagueId);
    if (!league || !hasActivePass(league)) return null;
    const prefs = await getPrefs(ctx, leagueId);
    if (prefs?.wireEnabled === false) return null;

    const seasonId = leagueCurrentSeason(league);
    const draftPhase = await draftPhaseFor(ctx, leagueId, seasonId);
    if (draftPhase === "predraft_redraft") return null;

    const week = (await currentMatchupPeriod(ctx, leagueId, seasonId)) ?? 1;
    const dedupeKey = `rundown:${leagueId}:${seasonId}:${week}`;
    const existing = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_dedupe", (q) => q.eq("leagueId", leagueId).eq("dedupeKey", dedupeKey))
      .first();
    if (existing) return null;

    const now = Date.now();
    const weekAgo = now - RECENT_TXN_WINDOW_MS;
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .filter((q) => q.gte(q.field("proposedDate"), weekAgo))
      .take(500);

    let adds = 0;
    let drops = 0;
    let claims = 0;
    const byPlayerClaims = new Map<number, { count: number; winningBid?: number }>();
    for (const row of rows) {
      if (row.type === "FREEAGENT") {
        for (const item of row.items) {
          if (item.type === "ADD") adds++;
          if (item.type === "DROP") drops++;
        }
      }
      if (row.type === "WAIVER" && row.outcome !== "cancelled") {
        const addItem = row.items.find((item) => item.type === "ADD");
        if (addItem) {
          claims++;
          const g = byPlayerClaims.get(addItem.playerId) ?? { count: 0 };
          g.count++;
          if (row.outcome === "executed") g.winningBid = row.bidAmount;
          byPlayerClaims.set(addItem.playerId, g);
        }
      }
    }

    let topPlayerId: number | undefined;
    let topCount = 0;
    for (const [playerId, g] of byPlayerClaims) {
      if (g.count > topCount) {
        topCount = g.count;
        topPlayerId = playerId;
      }
    }
    const topPlayer = topPlayerId !== undefined ? await resolvePlayerFull(ctx, String(topPlayerId), seasonId) : undefined;
    const topBid = topPlayerId !== undefined ? byPlayerClaims.get(topPlayerId)?.winningBid : undefined;
    const isFaab = league.settings?.waiverType === "faab";

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .take(40);
    let faabLeaderTeam: Doc<"teams"> | undefined;
    let faabLeaderLeft = -1;
    if (isFaab && league.settings?.faabBudget !== undefined) {
      const budget = league.settings.faabBudget;
      for (const team of teams) {
        const left = budget - (team.transactionCounter?.acquisitionBudgetSpent ?? 0);
        if (left > faabLeaderLeft) {
          faabLeaderLeft = left;
          faabLeaderTeam = team;
        }
      }
    }

    const slots: WireSlots = {
      week: String(week),
      adds: String(adds),
      drops: String(drops),
      claims: String(claims),
      topPlayer: topPlayer?.name,
      topBid: isFaab && topBid !== undefined ? `$${topBid}` : undefined,
      faabLeader: faabLeaderTeam?.name,
      faabLeft: faabLeaderTeam ? `$${faabLeaderLeft}` : undefined,
    };

    await postDeskRoutine(ctx, { leagueId, seasonId, week, kind: "weekly_rundown", persona: "dex-alvarez", slots, dedupeKey, featuredTeams: [], now });
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * quiet_desk (spec §18)
 * -------------------------------------------------------------------------- */

export const postQuietDeskForLeague = internalMutation({
  args: { leagueId: v.id("leagues") },
  returns: v.null(),
  handler: async (ctx, { leagueId }) => {
    const league = await ctx.db.get(leagueId);
    if (!league || !hasActivePass(league)) return null;
    const prefs = await getPrefs(ctx, leagueId);
    if (prefs?.wireEnabled === false || prefs?.wireLeaks === false) return null;

    const tradeDeadline = league.settings?.tradeDeadline;
    const now = Date.now();
    if (!isWithinQuietDeskWindow(now, tradeDeadline)) return null;

    const seasonId = leagueCurrentSeason(league);
    const draftPhase = await draftPhaseFor(ctx, leagueId, seasonId);
    if (draftPhase === "predraft_redraft") return null;

    const currentWeek = (await currentMatchupPeriod(ctx, leagueId, seasonId)) ?? 1;
    const sinceWeek = Math.max(1, currentWeek - 4);

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .take(40);

    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .filter((q) =>
        q.and(
          q.gte(q.field("scoringPeriod"), sinceWeek),
          q.or(q.eq(q.field("type"), "TRADE_PROPOSAL"), q.eq(q.field("type"), "TRADE_ACCEPT"), q.eq(q.field("type"), "TRADE_DECLINE"))
        )
      )
      .take(500);

    const activeExternalIds = new Set<number>();
    for (const row of rows) {
      activeExternalIds.add(row.teamId);
      for (const item of row.items) {
        if (item.fromTeamId > 0) activeExternalIds.add(item.fromTeamId);
        if (item.toTeamId > 0) activeExternalIds.add(item.toTeamId);
      }
    }

    const quietTeams = teams.filter((t) => !activeExternalIds.has(Number(t.externalId)));
    if (quietTeams.length === 0) return null;

    // At most 3 teams named in the sentence (spec §18 leaves the exact rendering to us) - a joined
    // list in `{team}` (stock-lines.ts's header: "team (one team or a joined list 'A, B and C' - no
    // line conjugates it)"), one post for the whole league rather than one per quiet team.
    const teamsLine = joinNames(quietTeams.slice(0, 3).map((t) => t.name));

    const deadlineText =
      tradeDeadline !== undefined
        ? new Date(tradeDeadline).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
        : undefined;

    const dedupeKey = `quiet_desk:${leagueId}:${seasonId}:${currentWeek}`;
    const slots: WireSlots = { team: teamsLine, deadline: deadlineText, weeksSilent: String(currentWeek - sinceWeek) };
    await postDeskRoutine(ctx, {
      leagueId,
      seasonId,
      week: currentWeek,
      kind: "quiet_desk",
      persona: "dex-alvarez",
      slots,
      dedupeKey,
      featuredTeams: quietTeams.slice(0, 3).map((t) => t._id),
      now,
    });
    return null;
  },
});
