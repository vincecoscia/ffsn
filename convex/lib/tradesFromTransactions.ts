/**
 * Derives `trades` rows from ESPN's `TRADE_ACCEPT` transaction log rows (ESPN refresh audit,
 * Sept 2026, item 4.10: the `trades` table has 0 rows in prod because its sole writer,
 * `espnSync.ts`'s `storeTrades`, is only ever called from commented-out code. A `TRADE_ACCEPT`
 * transaction already carries everything a trade needs in its `items` array
 * (`{ fromTeamId, toTeamId, playerId, type }`, see `convex/lib/espnTransactions.ts`), so a trade
 * is a read of data we already sync, not a new ESPN request.
 *
 * This module is intentionally pure - no imports from `./_generated/api` or any other
 * `convex/*.ts` module that itself references `internal`/`api` (the same rule documented in
 * `./espnClient.ts` and `./espnTransactions.ts`). `convex/tradesSync.ts` imports it as a plain
 * value; a recursive `api` type (TS7022/7023) follows if that rule is broken.
 */

import type { Id } from "../_generated/dataModel";

/** The subset of a raw/normalized ESPN transaction item this module needs. */
export interface TradeTransactionItem {
  fromTeamId: number;
  toTeamId: number;
  playerId: number;
  type: string;
}

/**
 * The subset of a stored `transactions` row (schema.ts, `convex/lib/espnTransactions.ts`'s
 * `NormalizedEspnTransaction`) this module needs. A `Doc<"transactions">` satisfies this
 * structurally, so callers can pass query results straight through.
 */
export interface TransactionLike {
  leagueId: Id<"leagues">;
  seasonId: number;
  espnTransactionId: string;
  type: string;
  status: string;
  teamId: number;
  items: TradeTransactionItem[];
  proposedDate: number;
  processDate?: number;
  createdAt?: number;
  scoringPeriod: number;
}

export interface DerivedTradeTeam {
  teamId: string;
  teamName: string;
  manager: string;
}

export interface DerivedTradePlayer {
  playerId: string;
  playerName: string;
  position: string;
  /** NFL team abbreviation, "" when unknown. */
  team: string;
}

/**
 * An asset that changed hands with no real "from" team attached - ESPN represents a traded
 * draft pick (or other non-roster asset) inside a `TRADE_ACCEPT` row's `items` with
 * `fromTeamId: 0` ("no team"), never as a player. Kept separate from
 * `playersFromTeamA`/`playersFromTeamB` so a pick is never mistaken for a player in a recap.
 */
export interface DerivedTradePick {
  toTeamId: string;
  description: string;
}

export interface DerivedTrade {
  leagueId: Id<"leagues">;
  seasonId: number;
  /** Dedupe key back to the `TRADE_ACCEPT` row (`trades.espnTransactionId`, by_espn_transaction). */
  espnTransactionId: string;
  tradeDate: number;
  status: "completed";
  /** The scoring period the trade processed in. Not a `trades` column today - callers that only
   * need the DB shape can drop it; kept here because it's cheap context for content generation. */
  week: number;
  teamA: DerivedTradeTeam;
  teamB: DerivedTradeTeam;
  playersFromTeamA: DerivedTradePlayer[];
  playersFromTeamB: DerivedTradePlayer[];
  picks: DerivedTradePick[];
}

export interface TradeTeamRef {
  externalId: string;
  name: string;
  owner?: string;
}

export interface TradePlayerRef {
  name: string;
  position: string;
  proTeam?: string;
}

function resolveTeam(teamId: number, teamsByExternalId: Map<string, TradeTeamRef>): DerivedTradeTeam {
  const key = String(teamId);
  const team = teamsByExternalId.get(key);
  return {
    teamId: key,
    teamName: team?.name ?? `Team ${teamId}`,
    manager: team?.owner ?? "Unknown",
  };
}

/**
 * ESPN's convention: a negative `playerId` is a team defense/special-teams slot, not a real
 * roster player - never render it as "Player -16006". Named via `players` (from
 * `playersEnhanced`) when we have it, else a generic "Team Defense" fallback.
 */
function resolvePlayer(
  playerId: number,
  players: Map<string, TradePlayerRef> | undefined
): DerivedTradePlayer {
  const entry = players?.get(String(playerId));
  if (entry) {
    return { playerId: String(playerId), playerName: entry.name, position: entry.position, team: entry.proTeam ?? "" };
  }
  if (playerId < 0) {
    return { playerId: String(playerId), playerName: "Team Defense", position: "D/ST", team: "" };
  }
  return { playerId: String(playerId), playerName: `Player ${playerId}`, position: "Unknown", team: "" };
}

/**
 * Every pair of teams that directly exchanged a player-side item, in first-seen order.
 * Only used for a genuine 3+-team trade (see `tradesFromTransactions`'s header comment) - a
 * plain 2-team trade never reaches this.
 */
function pairsThatExchangedAssets(items: TradeTransactionItem[], teamIds: number[]): Array<[number, number]> {
  const seen = new Set<string>();
  const pairs: Array<[number, number]> = [];
  for (const item of items) {
    if (item.fromTeamId === item.toTeamId) continue;
    if (!teamIds.includes(item.fromTeamId) || !teamIds.includes(item.toTeamId)) continue;
    const [a, b] = item.fromTeamId < item.toTeamId ? [item.fromTeamId, item.toTeamId] : [item.toTeamId, item.fromTeamId];
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([a, b]);
  }
  return pairs;
}

function buildTrade(
  row: TransactionLike,
  teamAId: number,
  teamBId: number,
  playerItems: TradeTransactionItem[],
  pickItems: TradeTransactionItem[],
  teamsByExternalId: Map<string, TradeTeamRef>,
  players: Map<string, TradePlayerRef> | undefined
): DerivedTrade {
  const playersFromTeamA = playerItems
    .filter((item) => item.fromTeamId === teamAId && item.toTeamId === teamBId)
    .map((item) => resolvePlayer(item.playerId, players));
  const playersFromTeamB = playerItems
    .filter((item) => item.fromTeamId === teamBId && item.toTeamId === teamAId)
    .map((item) => resolvePlayer(item.playerId, players));
  const picks = pickItems
    .filter((item) => item.toTeamId === teamAId || item.toTeamId === teamBId)
    .map((item) => ({ toTeamId: String(item.toTeamId), description: "Future draft pick" }));

  return {
    leagueId: row.leagueId,
    seasonId: row.seasonId,
    espnTransactionId: row.espnTransactionId,
    tradeDate: row.processDate ?? row.proposedDate ?? row.createdAt ?? Date.now(),
    status: "completed",
    week: row.scoringPeriod,
    teamA: resolveTeam(teamAId, teamsByExternalId),
    teamB: resolveTeam(teamBId, teamsByExternalId),
    playersFromTeamA,
    playersFromTeamB,
    picks,
  };
}

/**
 * Turns `TRADE_ACCEPT` transaction rows into `DerivedTrade`s, one per pair of teams that
 * exchanged a player (almost always exactly one trade per row).
 *
 * `teamA` is the row's own `teamId` (ESPN stamps the proposing/accepting team there) when it's
 * one of the trade's participants, else the first `fromTeamId` seen - matters for prod rows
 * whose `teamId` doesn't line up with `items` (rare, but seen in historical data).
 *
 * ESPN sometimes reports a "no team" side (`fromTeamId: 0`) inside an otherwise 2-team trade's
 * `items` (a prod row's team set looked like `[0, 4, 6]`, not a real 3-team trade) - that's how
 * a traded pick or other non-roster asset shows up, never as a player. Those items are pulled
 * out into `picks` before the real teams are counted, so they can never masquerade as a third
 * trading partner.
 *
 * A genuine 3+-team trade (3+ distinct real team ids exchanging players with each other) has no
 * single teamA/teamB framing, so it's split into one `DerivedTrade` per pair of teams that
 * exchanged a player directly - each pairing keeps only its own players/picks, so it can be
 * graded and reported on independently. All resulting trades share the same
 * `espnTransactionId`; callers that dedupe by it must also key on the team pair (see
 * `tradesSync.ts`).
 */
export function tradesFromTransactions(
  rows: TransactionLike[],
  teams: TradeTeamRef[],
  players?: Map<string, TradePlayerRef>
): DerivedTrade[] {
  const teamsByExternalId = new Map(teams.map((team) => [team.externalId, team]));
  const trades: DerivedTrade[] = [];

  for (const row of rows) {
    if (row.type !== "TRADE_ACCEPT") continue;
    if ((row.status ?? "").toUpperCase() !== "EXECUTED") continue;

    const items = row.items ?? [];
    if (items.length === 0) continue;

    const playerItems = items.filter((item) => item.fromTeamId !== 0);
    const pickItems = items.filter((item) => item.fromTeamId === 0);

    const teamIds = Array.from(
      new Set(playerItems.flatMap((item) => [item.fromTeamId, item.toTeamId]).filter((id) => id !== 0))
    );
    if (teamIds.length < 2) continue; // nothing to pair a trade from

    const teamAId = teamIds.includes(row.teamId) ? row.teamId : playerItems[0].fromTeamId;
    const otherTeamIds = teamIds.filter((id) => id !== teamAId);

    if (otherTeamIds.length === 1) {
      trades.push(buildTrade(row, teamAId, otherTeamIds[0], playerItems, pickItems, teamsByExternalId, players));
    } else {
      for (const [a, b] of pairsThatExchangedAssets(playerItems, teamIds)) {
        trades.push(buildTrade(row, a, b, playerItems, pickItems, teamsByExternalId, players));
      }
    }
  }

  return trades;
}
