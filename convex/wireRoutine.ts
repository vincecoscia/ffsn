/**
 * The Wire — league routine posts, tier 3 (ffsn-the-wire-spec.md §3.3). No model call: a
 * hand-written stock line (`src/lib/ai/wire/stock-lines.ts`) is picked per persona/kind and filled
 * with facts pulled straight off an existing sync's own writes. Every function here is scheduled
 * (never called inline) from a small hook at the existing sync site, so a Wire failure can never
 * block the sync itself:
 *
 *   - `onTransactionsUpserted` <- `espnSync.ts#upsertTransactions` (waiver/add-drop/trade)
 *   - `onMatchupsUpdated`      <- `espnSync.ts#updateMatchups` (week final + its follow-ups)
 *   - `onArticlePublished`     <- `aiContent.ts`'s `notifyArticlePublished` call site
 *   - `onClaimSettled`         <- `claims.ts#resolveOpenClaims`
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { leagueCurrentSeason, nflSeasonYearFor } from "./lib/season";
import { faabSlot, insertLeaguePostIfNew, managerNameFor } from "./lib/wireLeaguePosting";
import type { LeagueEventKind, WirePersona, WireSlots } from "../src/lib/ai/wire/types";
import type { LanguageRating } from "../src/lib/ai/language";
import { pickStockLine } from "../src/lib/ai/wire/stock-lines";

const BENCH_SLOT_ID = 20;
const RECENT_TXN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Any team with a streak this long or longer gets a routine post (spec §5.2). */
const STREAK_POST_MIN = 3;

/* -------------------------------------------------------------------------- *
 * Shared helpers
 * -------------------------------------------------------------------------- */

/** The league's language rating, downgraded to "clean" if any featured team opted down. */
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

async function resolvePlayer(
  ctx: MutationCtx,
  espnId: string,
  season: number
): Promise<{ name: string; position?: string } | undefined> {
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
  return row ? { name: row.fullName, position: row.defaultPosition } : undefined;
}

interface PostRoutineArgs {
  leagueId: Id<"leagues">;
  seasonId: number;
  week?: number;
  kind: string;
  persona: string;
  slots: WireSlots;
  dedupeKey: string;
  featuredTeams: Id<"teams">[];
  now: number;
}

/** Pick a stock line and insert it (subject to the league rate limit + dedupe) - or do nothing if
 *  no line resolves for this persona/kind/rating (spec §8.1: never a blank or a raw token). */
async function postRoutine(ctx: MutationCtx, args: PostRoutineArgs): Promise<void> {
  const rating = await effectiveRating(ctx, args.leagueId, args.featuredTeams);
  const seed = `${args.leagueId}:${args.seasonId}:${args.week ?? 0}:${args.kind}:${args.dedupeKey}`;
  const picked = pickStockLine(args.persona as WirePersona, args.kind as LeagueEventKind, args.slots, seed, rating);
  if (!picked) return;

  await insertLeaguePostIfNew(ctx, args.now, {
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

/* -------------------------------------------------------------------------- *
 * Transactions (espnSync.ts#upsertTransactions -> here)
 * -------------------------------------------------------------------------- */

async function countFailedWaivers(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  playerId: string | undefined,
  scoringPeriod: number,
  excludeEspnTransactionId: string
): Promise<number> {
  if (!playerId) return 0;
  // Bounded: one league-season's transaction log, generously capped (see espnSync.ts for the same
  // per-season scan pattern in hasTransactionLogForSeason).
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .filter((q) =>
      q.and(
        q.eq(q.field("type"), "WAIVER"),
        q.eq(q.field("outcome"), "failed"),
        q.eq(q.field("scoringPeriod"), scoringPeriod)
      )
    )
    .take(300);
  return rows.filter(
    (row) => row.espnTransactionId !== excludeEspnTransactionId && row.items.some((item) => String(item.playerId) === playerId)
  ).length;
}

async function postWaiverProcessed(
  ctx: MutationCtx,
  league: Doc<"leagues">,
  leagueId: Id<"leagues">,
  seasonId: number,
  txn: Doc<"transactions">,
  team: Doc<"teams">,
  now: number
): Promise<void> {
  const addedItem = txn.items.find((item) => item.type === "ADD" || item.toTeamId === txn.teamId);
  const playerId = addedItem ? String(addedItem.playerId) : undefined;
  const player = playerId ? await resolvePlayer(ctx, playerId, seasonId) : undefined;
  const losingBids = await countFailedWaivers(ctx, leagueId, seasonId, playerId, txn.scoringPeriod, txn.espnTransactionId);

  const slots: WireSlots = {
    team: team.name,
    manager: managerNameFor(team),
    player: player?.name,
    pos: player?.position,
    bid: `$${txn.bidAmount}`,
    losingBids: losingBids > 0 ? `${losingBids} losing bid${losingBids === 1 ? "" : "s"}` : undefined,
    faab: faabSlot(league, team),
    week: String(txn.scoringPeriod),
  };
  await postRoutine(ctx, {
    leagueId,
    seasonId,
    week: txn.scoringPeriod,
    kind: "waiver_processed",
    persona: "dex-alvarez",
    slots,
    dedupeKey: `txn:${txn.espnTransactionId}`,
    featuredTeams: [team._id],
    now,
  });
}

async function postAddDrop(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  txn: Doc<"transactions">,
  team: Doc<"teams">,
  now: number
): Promise<void> {
  const item = txn.items.find((i) => i.type === "ADD") ?? txn.items.find((i) => i.type === "DROP") ?? txn.items[0];
  if (!item) return;
  const player = await resolvePlayer(ctx, String(item.playerId), seasonId);

  const slots: WireSlots = {
    team: team.name,
    manager: managerNameFor(team),
    player: player?.name,
    pos: player?.position,
    week: String(txn.scoringPeriod),
  };
  await postRoutine(ctx, {
    leagueId,
    seasonId,
    week: txn.scoringPeriod,
    kind: "add_drop",
    persona: "dex-alvarez",
    slots,
    dedupeKey: `txn:${txn.espnTransactionId}`,
    featuredTeams: [team._id],
    now,
  });
}

/**
 * A trade's slot vocabulary is necessarily a simplification: `WireSlots` has one `{team}` and one
 * `{ownerTeam}` token, not an arbitrary number of sides/players, so this names the two receiving
 * teams and joins each side's incoming players into one string rather than describing a true
 * multi-player, multi-team trade structurally.
 */
async function postTrade(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  txn: Doc<"transactions">,
  teamByExternalId: Map<string, Doc<"teams">>,
  now: number
): Promise<void> {
  const byReceivingTeam = new Map<number, string[]>();
  for (const item of txn.items) {
    if (item.toTeamId <= 0) continue;
    const player = await resolvePlayer(ctx, String(item.playerId), seasonId);
    if (!player) continue;
    const list = byReceivingTeam.get(item.toTeamId) ?? [];
    list.push(player.name);
    byReceivingTeam.set(item.toTeamId, list);
  }
  const receivingExternalIds = [...byReceivingTeam.keys()];
  const teamA = teamByExternalId.get(String(receivingExternalIds[0]));
  if (!teamA) return;
  const teamB = receivingExternalIds[1] ? teamByExternalId.get(String(receivingExternalIds[1])) : undefined;

  const slots: WireSlots = {
    team: teamA.name,
    ownerTeam: teamB?.name,
    player: byReceivingTeam.get(receivingExternalIds[0])?.join(" & "),
    week: String(txn.scoringPeriod),
  };
  const featuredTeams = teamB ? [teamA._id, teamB._id] : [teamA._id];
  await postRoutine(ctx, {
    leagueId,
    seasonId,
    week: txn.scoringPeriod,
    kind: "trade",
    persona: "dex-alvarez",
    slots,
    dedupeKey: `txn:${txn.espnTransactionId}`,
    featuredTeams,
    now,
  });
}

export const onTransactionsUpserted = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    espnTransactionIds: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { leagueId, seasonId, espnTransactionIds }) => {
    const league = await ctx.db.get(leagueId);
    if (!league) return null;

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .take(40);
    const teamByExternalId = new Map(teams.map((t) => [t.externalId, t]));

    const now = Date.now();
    const cutoff = now - RECENT_TXN_WINDOW_MS;

    // Bounded: one sync batch's worth of transaction ids (the caller already chunks its own writes).
    for (const espnTransactionId of espnTransactionIds.slice(0, 300)) {
      const txn = await ctx.db
        .query("transactions")
        .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", espnTransactionId))
        .first();
      if (!txn) continue;

      const eventDate = txn.processDate ?? txn.proposedDate;
      if (eventDate < cutoff) continue;

      const team = teamByExternalId.get(String(txn.teamId));
      if (!team) continue;

      if (txn.type === "WAIVER" && txn.outcome === "executed") {
        await postWaiverProcessed(ctx, league, leagueId, seasonId, txn, team, now);
      } else if (txn.type === "FREEAGENT") {
        await postAddDrop(ctx, leagueId, seasonId, txn, team, now);
      } else if (txn.type === "TRADE_ACCEPT") {
        await postTrade(ctx, leagueId, seasonId, txn, teamByExternalId, now);
      }
    }
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * Matchups (espnSync.ts#updateMatchups -> here)
 * -------------------------------------------------------------------------- */

function sumBenchPoints(roster: unknown): number {
  if (!Array.isArray(roster)) return 0;
  let total = 0;
  for (const entry of roster) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as {
      lineupSlotId?: number;
      playerStats?: { appliedTotal?: number; actual?: { appliedTotal?: number } };
    };
    if (row.lineupSlotId !== BENCH_SLOT_ID) continue;
    total += row.playerStats?.actual?.appliedTotal ?? row.playerStats?.appliedTotal ?? 0;
  }
  return total;
}

export const onMatchupsUpdated = internalMutation({
  args: { leagueId: v.id("leagues"), seasonId: v.number(), matchupPeriod: v.number() },
  returns: v.null(),
  handler: async (ctx, { leagueId, seasonId, matchupPeriod }) => {
    const matchups = await ctx.db
      .query("matchups")
      .withIndex("by_league_period", (q) => q.eq("leagueId", leagueId).eq("matchupPeriod", matchupPeriod))
      .filter((q) => q.eq(q.field("seasonId"), seasonId))
      .take(40);
    if (matchups.length === 0 || matchups.some((m) => !m.winner)) return null; // not final yet - idempotent no-op

    const teams = await ctx.db
      .query("teams")
      .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
      .take(40);
    const teamByExternalId = new Map(teams.map((t) => [t.externalId, t]));
    const now = Date.now();

    // The period's closest margin doubles as week_final's own marquee callout (stock-lines.ts's
    // slot vocabulary for week_final is the same shape as game_of_week: team/opponentTeam/score/
    // opponentScore/margin/record), so both posts are built from the same computed match.
    let closest: (typeof matchups)[number] | undefined;
    let closestMargin = Infinity;
    for (const m of matchups) {
      const margin = Math.abs(m.homeScore - m.awayScore);
      if (margin < closestMargin) {
        closestMargin = margin;
        closest = m;
      }
    }

    let marqueeSlots: WireSlots = { week: String(matchupPeriod) };
    let marqueeFeaturedTeams: Id<"teams">[] = [];
    if (closest) {
      const homeIsHigher = closest.homeScore >= closest.awayScore;
      const winnerExternalId = homeIsHigher ? closest.homeTeamId : closest.awayTeamId;
      const loserExternalId = homeIsHigher ? closest.awayTeamId : closest.homeTeamId;
      const winnerTeam = teamByExternalId.get(winnerExternalId);
      const loserTeam = teamByExternalId.get(loserExternalId);
      if (winnerTeam) {
        marqueeSlots = {
          team: winnerTeam.name,
          opponentTeam: loserTeam?.name,
          margin: closestMargin.toFixed(1),
          score: Math.max(closest.homeScore, closest.awayScore).toFixed(1),
          opponentScore: Math.min(closest.homeScore, closest.awayScore).toFixed(1),
          record: `${winnerTeam.record.wins}-${winnerTeam.record.losses}${winnerTeam.record.ties ? `-${winnerTeam.record.ties}` : ""}`,
          week: String(matchupPeriod),
        };
        marqueeFeaturedTeams = loserTeam ? [winnerTeam._id, loserTeam._id] : [winnerTeam._id];
      }
    }

    await postRoutine(ctx, {
      leagueId,
      seasonId,
      week: matchupPeriod,
      kind: "week_final",
      persona: "curtis-vaughn",
      slots: marqueeSlots,
      dedupeKey: `week_final:${leagueId}:${seasonId}:${matchupPeriod}`,
      featuredTeams: marqueeFeaturedTeams,
      now,
    });

    if (closest && marqueeFeaturedTeams.length > 0) {
      await postRoutine(ctx, {
        leagueId,
        seasonId,
        week: matchupPeriod,
        kind: "game_of_week",
        persona: "curtis-vaughn",
        slots: marqueeSlots,
        dedupeKey: `game_of_week:${leagueId}:${seasonId}:${matchupPeriod}`,
        featuredTeams: marqueeFeaturedTeams,
        now,
      });
    }

    // top_score / low_score across every team that played this period.
    let topScore = -Infinity;
    let lowScore = Infinity;
    let topTeam: Doc<"teams"> | undefined;
    let lowTeam: Doc<"teams"> | undefined;
    for (const m of matchups) {
      const sides: Array<[string, number]> = [
        [m.homeTeamId, m.homeScore],
        [m.awayTeamId, m.awayScore],
      ];
      for (const [externalId, score] of sides) {
        const team = teamByExternalId.get(externalId);
        if (!team) continue;
        if (score > topScore) {
          topScore = score;
          topTeam = team;
        }
        if (score < lowScore) {
          lowScore = score;
          lowTeam = team;
        }
      }
    }
    if (topTeam) {
      await postRoutine(ctx, {
        leagueId,
        seasonId,
        week: matchupPeriod,
        kind: "top_score",
        persona: "reggie-banks",
        slots: { team: topTeam.name, manager: managerNameFor(topTeam), score: topScore.toFixed(1), week: String(matchupPeriod) },
        dedupeKey: `top_score:${leagueId}:${seasonId}:${matchupPeriod}`,
        featuredTeams: [topTeam._id],
        now,
      });
    }
    if (lowTeam) {
      await postRoutine(ctx, {
        leagueId,
        seasonId,
        week: matchupPeriod,
        kind: "low_score",
        persona: "walt-brennan",
        slots: { team: lowTeam.name, manager: managerNameFor(lowTeam), score: lowScore.toFixed(1), week: String(matchupPeriod) },
        dedupeKey: `low_score:${leagueId}:${seasonId}:${matchupPeriod}`,
        featuredTeams: [lowTeam._id],
        now,
      });
    }

    // bench_points: the period's single highest bench total (lineupSlotId 20).
    let benchTop = -Infinity;
    let benchTeam: Doc<"teams"> | undefined;
    for (const m of matchups) {
      const homeTeam = teamByExternalId.get(m.homeTeamId);
      const awayTeam = teamByExternalId.get(m.awayTeamId);
      const homeBench = sumBenchPoints(m.homeRoster);
      const awayBench = sumBenchPoints(m.awayRoster);
      if (homeTeam && homeBench > benchTop) {
        benchTop = homeBench;
        benchTeam = homeTeam;
      }
      if (awayTeam && awayBench > benchTop) {
        benchTop = awayBench;
        benchTeam = awayTeam;
      }
    }
    if (benchTeam) {
      await postRoutine(ctx, {
        leagueId,
        seasonId,
        week: matchupPeriod,
        kind: "bench_points",
        persona: "nina-sharpe",
        slots: { team: benchTeam.name, manager: managerNameFor(benchTeam), points: benchTop.toFixed(1), week: String(matchupPeriod) },
        dedupeKey: `bench_points:${leagueId}:${seasonId}:${matchupPeriod}`,
        featuredTeams: [benchTeam._id],
        now,
      });
    }

    // streak: every team riding a streak of STREAK_POST_MIN+ games.
    for (const team of teams) {
      const streakLength = team.record.streakLength ?? 0;
      if (streakLength < STREAK_POST_MIN) continue;
      const streakLabel = `${team.record.streakType ?? "W"}${streakLength}`;
      const record = `${team.record.wins}-${team.record.losses}${team.record.ties ? `-${team.record.ties}` : ""}`;
      await postRoutine(ctx, {
        leagueId,
        seasonId,
        week: matchupPeriod,
        kind: "streak",
        persona: "curtis-vaughn",
        slots: { team: team.name, manager: managerNameFor(team), streak: streakLabel, record, week: String(matchupPeriod) },
        dedupeKey: `streak:${leagueId}:${seasonId}:${matchupPeriod}:${team._id}`,
        featuredTeams: [team._id],
        now,
      });
    }

    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * Article published (aiContent.ts's notifyArticlePublished call site -> here)
 * -------------------------------------------------------------------------- */

export const onArticlePublished = internalMutation({
  args: { articleId: v.id("aiContent") },
  returns: v.null(),
  handler: async (ctx, { articleId }) => {
    const article = await ctx.db.get(articleId);
    if (!article) return null;

    const seasonId = article.seasonId ?? nflSeasonYearFor();
    const slots: WireSlots = {
      title: article.title,
      url: `/articles/${articleId}`,
      writer: article.persona,
    };
    await postRoutine(ctx, {
      leagueId: article.leagueId,
      seasonId,
      week: article.metadata.week,
      kind: "article_published",
      persona: article.persona,
      slots,
      dedupeKey: `article:${articleId}`,
      featuredTeams: article.metadata.featured_teams,
      now: Date.now(),
    });
    return null;
  },
});

/* -------------------------------------------------------------------------- *
 * Claim settled (claims.ts#resolveOpenClaims -> here)
 * -------------------------------------------------------------------------- */

export const onClaimSettled = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    articleId: v.id("aiContent"),
    claimIndex: v.number(),
    persona: v.string(),
    text: v.string(),
    outcome: v.union(v.literal("hit"), v.literal("miss")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    const seasonId = leagueCurrentSeason(league);
    const slots: WireSlots = { writer: args.persona, claim: args.text, outcome: args.outcome };
    await postRoutine(ctx, {
      leagueId: args.leagueId,
      seasonId,
      kind: "claim_settled",
      persona: args.persona,
      slots,
      dedupeKey: `claim_settled:${args.articleId}:${args.claimIndex}`,
      featuredTeams: [],
      now: Date.now(),
    });
    return null;
  },
});
