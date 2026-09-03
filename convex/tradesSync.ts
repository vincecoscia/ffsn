/**
 * Populates `trades` from the ESPN transaction log's `TRADE_ACCEPT` rows (ESPN refresh audit,
 * Sept 2026, item 4.10: `trades` has 0 rows in prod - its only writer, `espnSync.ts`'s
 * `storeTrades`, is called only from commented-out code, so `trade_occurred` content never
 * fires and every reader of `trades` sees an empty table).
 *
 * `deriveTradesForSeason` re-derives every trade for a season from whatever `transactions` rows
 * already exist (idempotent upsert by `espnTransactionId` + team pair, see
 * `convex/lib/tradesFromTransactions.ts`'s header comment on multi-team splits) - safe to run as
 * a season backfill or repeatedly from the season-closed sync job.
 * `deriveTradesForTransactionIds` does the same for a specific set of freshly-synced rows -
 * `espnSync.ts`'s `upsertTransactions` schedules it for any `TRADE_ACCEPT` ids it just wrote, so
 * a new trade shows up without waiting for the next season-level sync.
 */

import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { tradesFromTransactions, type DerivedTrade } from "./lib/tradesFromTransactions";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const resultValidator = v.object({
  derived: v.number(),
  inserted: v.number(),
  updated: v.number(),
});

/** Finds the stored `trades` row this `DerivedTrade` corresponds to, if any. Can't rely on
 * `by_espn_transaction` alone: a 3+-team trade derives more than one `DerivedTrade` per
 * `espnTransactionId` (one per team pair, `tradesFromTransactions.ts`), so the team pair is
 * also part of the identity. */
async function findExistingTrade(
  ctx: MutationCtx,
  trade: DerivedTrade
): Promise<Doc<"trades"> | null> {
  const candidates = await ctx.db
    .query("trades")
    .withIndex("by_espn_transaction", (q) => q.eq("espnTransactionId", trade.espnTransactionId))
    .take(10);
  return (
    candidates.find(
      (candidate) =>
        (candidate.teamA.teamId === trade.teamA.teamId && candidate.teamB.teamId === trade.teamB.teamId) ||
        (candidate.teamA.teamId === trade.teamB.teamId && candidate.teamB.teamId === trade.teamA.teamId)
    ) ?? null
  );
}

/**
 * `DerivedTrade` -> `trades` row upsert, shared by `deriveTradesForSeason` and
 * `deriveTradesForTransactionIds` so the two can never disagree about dedupe or the
 * `trade_occurred` firing rule. Fires the event only for a NEWLY inserted trade whose
 * `tradeDate` is within the last 7 days - a season backfill (import, or a rebuild of an old
 * season) must not spawn trade-analysis content for years-old trades, and a re-run that only
 * patches an existing row is never a "new" trade either.
 */
async function upsertDerivedTrades(
  ctx: MutationCtx,
  derivedTrades: DerivedTrade[]
): Promise<{ derived: number; inserted: number; updated: number }> {
  const now = Date.now();
  let inserted = 0;
  let updated = 0;

  for (const trade of derivedTrades) {
    const existing = await findExistingTrade(ctx, trade);

    const patch: Omit<Doc<"trades">, "_id" | "_creationTime" | "createdAt" | "updatedAt" | "analysis"> = {
      leagueId: trade.leagueId,
      seasonId: trade.seasonId,
      tradeDate: trade.tradeDate,
      espnTransactionId: trade.espnTransactionId,
      status: trade.status,
      teamA: trade.teamA,
      teamB: trade.teamB,
      playersFromTeamA: trade.playersFromTeamA,
      playersFromTeamB: trade.playersFromTeamB,
    };

    if (existing) {
      // Never touch `analysis` here - it may already hold commissioner-approved AI grades from
      // an earlier `trade_occurred` run, and a resync must not clobber those.
      await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
      updated += 1;
      continue;
    }

    // `picks` has no column of its own on `trades` (only `draftPicksFromTeamA/B`, which need a
    // round/year the transaction log doesn't carry) - fold it into `analysis.summary` as a plain
    // note instead of silently dropping it.
    const analysis =
      trade.picks.length > 0
        ? { summary: `Also includes: ${trade.picks.map((pick) => pick.description).join(", ")}.` }
        : undefined;

    const tradeId = await ctx.db.insert("trades", {
      ...patch,
      ...(analysis ? { analysis } : {}),
      createdAt: now,
      updatedAt: now,
    });
    inserted += 1;

    if (trade.tradeDate <= now && now - trade.tradeDate <= SEVEN_DAYS_MS) {
      await ctx.scheduler.runAfter(0, internal.contentScheduling.triggerEventBasedContent, {
        leagueId: trade.leagueId,
        eventType: "trade_occurred",
        eventData: {
          tradeId,
          tradeDate: trade.tradeDate,
          teamA: trade.teamA,
          teamB: trade.teamB,
        },
      });
    }
  }

  return { derived: derivedTrades.length, inserted, updated };
}

/** Reads the season's teams + the players named in `rows`, derives trades, and upserts them. */
async function deriveAndUpsertTrades(
  ctx: MutationCtx,
  leagueId: Id<"leagues">,
  seasonId: number,
  rows: Doc<"transactions">[]
): Promise<{ derived: number; inserted: number; updated: number }> {
  const tradeRows = rows.filter((row) => row.type === "TRADE_ACCEPT");
  if (tradeRows.length === 0) return { derived: 0, inserted: 0, updated: 0 };

  const teams = await ctx.db
    .query("teams")
    .withIndex("by_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .take(50);

  const playerIds = new Set<number>();
  for (const row of tradeRows) {
    for (const item of row.items) {
      if (item.playerId) playerIds.add(item.playerId);
    }
  }

  const players = new Map<string, { name: string; position: string; proTeam?: string }>();
  await Promise.all(
    Array.from(playerIds).map(async (playerId) => {
      const enhanced = await ctx.db
        .query("playersEnhanced")
        .withIndex("by_espn_id_season", (q) => q.eq("espnId", String(playerId)).eq("season", seasonId))
        .unique();
      if (enhanced) {
        players.set(String(playerId), {
          name: enhanced.fullName,
          position: enhanced.defaultPosition,
          proTeam: enhanced.proTeamAbbrev,
        });
      }
    })
  );

  const derivedTrades = tradesFromTransactions(
    tradeRows,
    teams.map((team) => ({ externalId: team.externalId, name: team.name, owner: team.owner })),
    players
  );

  return upsertDerivedTrades(ctx, derivedTrades);
}

/**
 * Re-derives every trade for one league/season from its already-synced `transactions` rows.
 * Idempotent - safe to call from a season backfill, the season-closed sync job, or by hand.
 * `.take(200)`: a season's `TRADE_ACCEPT` rows are a small fraction of its full transaction log
 * (prod's busiest season is nowhere close to 200 trades).
 */
export const deriveTradesForSeason = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
  },
  returns: resultValidator,
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_season", (q) => q.eq("leagueId", args.leagueId).eq("seasonId", args.seasonId))
      .filter((q) => q.eq(q.field("type"), "TRADE_ACCEPT"))
      .take(200);
    return deriveAndUpsertTrades(ctx, args.leagueId, args.seasonId, rows);
  },
});

/**
 * Same derivation for a specific set of transaction ids - `espnSync.ts`'s `upsertTransactions`
 * schedules this for any `TRADE_ACCEPT` ids it just wrote, so a trade appears without waiting on
 * the next full-season sync. Takes bare ids (not `{leagueId, seasonId}`) because a single
 * `upsertTransactions` batch is already scoped to one league/season - looking each id up keeps
 * this correct even if that ever changes.
 */
export const deriveTradesForTransactionIds = internalMutation({
  args: {
    espnTransactionIds: v.array(v.string()),
  },
  returns: resultValidator,
  handler: async (ctx, args) => {
    if (args.espnTransactionIds.length === 0) return { derived: 0, inserted: 0, updated: 0 };

    const rows = (
      await Promise.all(
        args.espnTransactionIds.map((espnTransactionId) =>
          ctx.db
            .query("transactions")
            .withIndex("by_espn_id", (q) => q.eq("espnTransactionId", espnTransactionId))
            .unique()
        )
      )
    ).filter((row): row is Doc<"transactions"> => row !== null && row.type === "TRADE_ACCEPT");

    if (rows.length === 0) return { derived: 0, inserted: 0, updated: 0 };

    const groups = new Map<string, { leagueId: Id<"leagues">; seasonId: number; rows: Doc<"transactions">[] }>();
    for (const row of rows) {
      const key = `${row.leagueId}:${row.seasonId}`;
      const group = groups.get(key) ?? { leagueId: row.leagueId, seasonId: row.seasonId, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }

    let derived = 0;
    let inserted = 0;
    let updated = 0;
    for (const group of groups.values()) {
      const result = await deriveAndUpsertTrades(ctx, group.leagueId, group.seasonId, group.rows);
      derived += result.derived;
      inserted += result.inserted;
      updated += result.updated;
    }
    return { derived, inserted, updated };
  },
});
