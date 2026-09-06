/**
 * ESPN lineup slot id -> display name (Dex Desk, ffsn-the-wire-spec.md §18). Used by the
 * `lineup_move`/`late_swap`/`lineup_lock` stock-line slots (`{slot}` = the name of `toLineupSlotId`).
 *
 * Pure, no imports from `./_generated/api` or any other `convex/*.ts` module that itself references
 * `internal`/`api` (the repo's documented cross-module value-import gotcha - see
 * `convex/lib/wireLeaguePosting.ts`'s header comment) - safe to import from any convex module or a
 * plain vitest file.
 */

/** ESPN's lineup slot ids, as seen across the codebase's fixtures and `getPositionAbbrev` (the
 *  player-position id map in `convex/playerSyncInternal.ts` uses an overlapping but distinct id
 *  space - this one is specifically the roster SLOT a player occupies, not his position). */
export const LINEUP_SLOT_NAMES: Record<number, string> = {
  0: "QB",
  1: "QB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  8: "DT",
  9: "DE",
  10: "LB",
  11: "DL",
  12: "CB",
  13: "S",
  14: "DB",
  15: "DP",
  16: "D/ST",
  17: "K",
  18: "P",
  19: "HC",
  20: "Bench",
  21: "IR",
  22: "IDL",
  23: "FLEX",
  24: "EDR",
  25: "RB/WR/TE",
};

/** The display name for a lineup slot id, e.g. `{slot}` in a Dex Desk stock line. Never blank -
 *  an id ESPN hasn't documented yet degrades to `"Slot {id}"` rather than an empty token. */
export function lineupSlotName(lineupSlotId: number): string {
  return LINEUP_SLOT_NAMES[lineupSlotId] ?? `Slot ${lineupSlotId}`;
}

export const BENCH_SLOT_ID = 20;
export const IR_SLOT_ID = 21;
export const NON_STARTER_SLOT_IDS: ReadonlySet<number> = new Set([BENCH_SLOT_ID, IR_SLOT_ID]);

/** A "starting" slot is anything but bench/IR (spec §18: `to not in {20,21}`). */
export function isStartingSlot(lineupSlotId: number): boolean {
  return !NON_STARTER_SLOT_IDS.has(lineupSlotId);
}
