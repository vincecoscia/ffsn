/**
 * Pure helpers for ESPN's `view=mTransactions2` transaction log - the FAAB
 * waiver wire report's data source (spec: the report needs winning bids,
 * losing bids, and remaining budgets; `transactions` rows used to come only
 * from the per-player `transactions` arrays inside the league payload
 * (`espnSync.ts`'s `syncPlayerTransactions`), which misses most of the real
 * log - production had none before December 2025).
 *
 * This module is intentionally pure - no imports from `./_generated/api` or
 * any other `convex/*.ts` module that itself references `internal`/`api`
 * (the same rule documented in `./espnClient.ts` and `./espnSettings.ts`).
 * `convex/espnSync.ts` imports it as a plain value; a recursive `api` type
 * (TS7022/7023) follows if that rule is broken.
 *
 * Verified against `tests/fixtures/espn-transactions-public.json` (public
 * league 899513, `view=mTransactions2&scoringPeriodId=N`): ESPN only
 * returns a `transactions` array when the request names a single
 * `scoringPeriodId`, so a sync fetches one scoring period per request.
 */

import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";

/** How this codebase classifies an ESPN transaction's resolution. */
export type TransactionOutcome = "executed" | "failed" | "pending" | "cancelled";

export const transactionOutcomeValidator = v.union(
  v.literal("executed"),
  v.literal("failed"),
  v.literal("pending"),
  v.literal("cancelled")
);

/** Where a stored `transactions` row came from. See `normalizeEspnTransaction`
 * (transaction_log) and `espnSync.ts`'s `storePlayerTransactions`
 * (player_feed, the older per-player-payload source). */
export const transactionSourceValidator = v.union(
  v.literal("player_feed"),
  v.literal("transaction_log")
);

export const espnTransactionItemValidator = v.object({
  fromLineupSlotId: v.number(),
  fromTeamId: v.number(),
  isKeeper: v.boolean(),
  overallPickNumber: v.number(),
  playerId: v.number(),
  toLineupSlotId: v.number(),
  toTeamId: v.number(),
  type: v.string(),
});

export type EspnTransactionItem = Infer<typeof espnTransactionItemValidator>;

/**
 * The shape `normalizeEspnTransaction` returns and `espnSync.ts`'s
 * `upsertTransactions` accepts as its `transactions` arg - matches the
 * `transactions` table (schema.ts) minus system fields and `createdAt`
 * (stamped by the mutation at insert time, preserved across updates).
 */
export const normalizedTransactionValidator = v.object({
  leagueId: v.id("leagues"),
  seasonId: v.number(),
  espnTransactionId: v.string(),
  bidAmount: v.number(),
  executionType: v.string(),
  isActingAsTeamOwner: v.boolean(),
  isLeagueManager: v.boolean(),
  isPending: v.boolean(),
  items: v.array(espnTransactionItemValidator),
  type: v.string(),
  proposedDate: v.number(),
  processDate: v.optional(v.number()),
  scoringPeriod: v.number(),
  status: v.string(),
  teamId: v.number(),
  outcome: transactionOutcomeValidator,
  failureReason: v.optional(v.string()),
  source: transactionSourceValidator,
  rating: v.optional(v.number()),
  relatedTransactionId: v.optional(v.string()),
});

export type NormalizedEspnTransaction = Infer<typeof normalizedTransactionValidator>;

/** Raw item within an ESPN `mTransactions2` transaction. A `TRADE_DECLINE`
 * row carries no `items` at all - always optional-chain/default this. */
export interface RawEspnTransactionItem {
  type?: string;
  playerId?: number;
  fromTeamId?: number;
  toTeamId?: number;
  fromLineupSlotId?: number;
  toLineupSlotId?: number;
  isKeeper?: boolean;
  overallPickNumber?: number;
}

/**
 * Raw ESPN `view=mTransactions2` transaction row, as returned per requested
 * `scoringPeriodId`. Production rows also carry a `memberId` (a person's
 * ESPN id) - deliberately left out of this type and never read by
 * `normalizeEspnTransaction`, so it can never end up in a stored row.
 */
export interface RawEspnTransaction {
  id: string;
  type: string;
  status: string;
  bidAmount?: number;
  executionType?: string;
  isActingAsTeamOwner?: boolean;
  isLeagueManager?: boolean;
  isPending?: boolean;
  items?: RawEspnTransactionItem[];
  proposedDate?: number;
  processDate?: number;
  scoringPeriodId?: number;
  teamId: number;
  rating?: number;
  relatedTransactionId?: string;
  subOrder?: number;
}

/**
 * Classify an ESPN transaction's raw `status` (plus `isPending`) into the
 * outcome the waiver report cares about.
 *
 * Verified live statuses (`tests/fixtures/espn-transactions-public.json`,
 * period 5 of 2025): `EXECUTED` (a claim that won or an immediate
 * add/drop), `FAILED_INVALIDPLAYERSOURCE` / `FAILED_PLAYERALREADYDROPPED` /
 * `FAILED_ROSTERLOCK` (a losing or otherwise-rejected claim - every
 * `FAILED*` status is a loss, `bidAmount` is the losing bid), `CANCELED`
 * (`executionType: "CANCEL"`, `bidAmount: 0` - the manager withdrew the
 * claim before it processed; NOT a losing bid, must not appear as one in a
 * waiver-run summary).
 *
 * `isPending` (or a literal `"PENDING"` status, not seen live but ESPN's
 * documented value for a claim that hasn't processed yet) always wins over
 * the status text - a claim can't simultaneously be pending and resolved.
 * Any other/unrecognized status - ESPN adding a new one, or a status we
 * haven't seen - falls back to "pending" rather than being silently
 * miscounted as a win or a loss.
 */
export function classifyTransactionStatus(
  status: string | null | undefined,
  isPending: boolean
): TransactionOutcome {
  if (isPending) return "pending";

  const normalized = (status ?? "").trim().toUpperCase();
  if (normalized === "PENDING") return "pending";
  if (normalized === "EXECUTED") return "executed";
  if (normalized.startsWith("FAILED")) return "failed";
  if (normalized === "CANCELED" || normalized === "CANCELLED") return "cancelled";

  return "pending";
}

export interface NormalizeTransactionContext {
  leagueId: Id<"leagues">;
  seasonId: number;
  /** The scoring period this row was fetched for - used only as a fallback
   * when the raw row's own `scoringPeriodId` is missing. */
  scoringPeriod: number;
}

/**
 * Turn one raw ESPN `mTransactions2` row into our stored shape. Never reads
 * or forwards `raw.memberId` - a person's ESPN id has no reason to live in
 * this table.
 */
export function normalizeEspnTransaction(
  raw: RawEspnTransaction,
  ctx: NormalizeTransactionContext
): NormalizedEspnTransaction {
  const isPending = raw.isPending ?? false;
  const outcome = classifyTransactionStatus(raw.status, isPending);

  return {
    leagueId: ctx.leagueId,
    seasonId: ctx.seasonId,
    espnTransactionId: raw.id,
    bidAmount: raw.bidAmount ?? 0,
    executionType: raw.executionType ?? "UNKNOWN",
    isActingAsTeamOwner: raw.isActingAsTeamOwner ?? false,
    isLeagueManager: raw.isLeagueManager ?? false,
    isPending,
    items: (raw.items ?? []).map((item) => ({
      fromLineupSlotId: item.fromLineupSlotId ?? -1,
      fromTeamId: item.fromTeamId ?? 0,
      isKeeper: item.isKeeper ?? false,
      overallPickNumber: item.overallPickNumber ?? 0,
      playerId: item.playerId ?? 0,
      toLineupSlotId: item.toLineupSlotId ?? -1,
      toTeamId: item.toTeamId ?? 0,
      type: item.type ?? "UNKNOWN",
    })),
    type: raw.type,
    proposedDate: raw.proposedDate ?? Date.now(),
    processDate: raw.processDate,
    scoringPeriod: raw.scoringPeriodId ?? ctx.scoringPeriod,
    status: raw.status,
    teamId: raw.teamId,
    outcome,
    failureReason: outcome === "failed" ? raw.status : undefined,
    source: "transaction_log",
    rating: raw.rating,
    relatedTransactionId: raw.relatedTransactionId,
  };
}

/** One player's FAAB waiver run outcome for a scoring period: the winning
 * bid (if any claim executed) and every losing bid, descending. */
export interface WaiverRunPlayerSummary {
  scoringPeriod: number;
  playerId: number;
  winnerBid?: number;
  winnerTeamId?: number;
  /** Losing (`FAILED*`) bid amounts for this player/period, descending.
   * Cancelled claims are excluded entirely - a withdrawn bid was never a
   * real losing bid. */
  loserBids: number[];
}

/** The subset of a normalized (or raw-shaped) transaction row
 * `summarizeWaiverRun` needs. */
export interface WaiverRunRow {
  type: string;
  status: string;
  isPending?: boolean;
  scoringPeriod: number;
  teamId: number;
  bidAmount: number;
  items: Array<{ type: string; playerId: number }>;
}

/**
 * Group `WAIVER`-type rows by (scoringPeriod, playerId) into a winner and
 * loser bids, for building the waiver wire report. Restricted to `type ===
 * "WAIVER"` - `FREEAGENT` adds aren't a bidding contest (first-come,
 * $0), and every other type (`DRAFT`, `ROSTER`, `TRADE_ACCEPT`,
 * `TRADE_DECLINE`, `FUTURE_ROSTER`, ...) isn't a FAAB claim at all.
 *
 * The player identified for each row is the item with `type === "ADD"`
 * (the player being acquired) - a WAIVER row's DROP item, if any, names a
 * different player being cut to make room.
 */
export function summarizeWaiverRun(rows: WaiverRunRow[]): WaiverRunPlayerSummary[] {
  const groups = new Map<string, WaiverRunPlayerSummary>();

  for (const row of rows) {
    if (row.type !== "WAIVER") continue;
    const addItem = row.items.find((item) => item.type === "ADD");
    if (!addItem) continue;

    const outcome = classifyTransactionStatus(row.status, row.isPending ?? false);
    if (outcome === "cancelled") continue;

    const key = `${row.scoringPeriod}:${addItem.playerId}`;
    let group = groups.get(key);
    if (!group) {
      group = { scoringPeriod: row.scoringPeriod, playerId: addItem.playerId, loserBids: [] };
      groups.set(key, group);
    }

    if (outcome === "executed") {
      group.winnerBid = row.bidAmount;
      group.winnerTeamId = row.teamId;
    } else if (outcome === "failed") {
      group.loserBids.push(row.bidAmount);
    }
    // "pending" claims haven't resolved yet - not a winner or a loser.
  }

  const summaries = Array.from(groups.values());
  for (const group of summaries) {
    group.loserBids.sort((a, b) => b - a);
  }
  summaries.sort((a, b) => a.scoringPeriod - b.scoringPeriod || a.playerId - b.playerId);
  return summaries;
}
