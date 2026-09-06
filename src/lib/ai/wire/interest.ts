// The Wire — interest score (spec §7), as a pure function of the fact card.
//
//   interest = base(kind, transition) + min(50, percentOwned / 2) + bonuses − penalty, clamped 0–100
//
// The thresholds that read this number live in types.ts (TAKE_MIN_INTEREST, CARD_MIN_INTEREST).

import { SAME_PLAYER_PENALTY_WINDOW_MS, type WireCardPlayer, type WireFactCard } from "./types";
import { isMultiWeekTimetable, isSeasonEndingTimetable } from "./timetable";

/** Base for a kind or transition the §7 table does not name. */
const DEFAULT_BASE = 15;

const OUT_TIER_STATUSES: ReadonlySet<string> = new Set(["out", "injured reserve"]);

function normaliseStatus(status: string | undefined): string {
  return (status ?? "").trim().toLowerCase();
}

/** The §7 base row for this card. */
export function interestBase(card: WireFactCard): number {
  switch (card.kind) {
    case "injury_status": {
      const to = normaliseStatus(card.statusTo);
      if (OUT_TIER_STATUSES.has(to) || isSeasonEndingTimetable(card.timetable)) return 60;
      if (to === "doubtful") return 45;
      if (to === "questionable") return 30;
      if (to === "active") return 35;
      return DEFAULT_BASE;
    }
    case "injury_note":
      return card.timetable ? 40 : DEFAULT_BASE;
    case "news":
      return 20;
    case "depth_chart":
      return card.depthOrderTo === 1 ? 30 : DEFAULT_BASE;
    case "trending":
      return 20;
    case "ownership_swing":
      return 20;
    default:
      return DEFAULT_BASE;
  }
}

function maxPercentOwned(players: ReadonlyArray<WireCardPlayer>): number {
  let max = 0;
  for (const player of players) {
    if (typeof player.percentOwned === "number" && Number.isFinite(player.percentOwned)) {
      max = Math.max(max, player.percentOwned);
    }
  }
  return Math.max(0, Math.min(100, max));
}

function isPremiumPlayer(players: ReadonlyArray<WireCardPlayer>): boolean {
  return players.some(
    player =>
      (player.position ?? "").trim().toUpperCase() === "QB" ||
      (typeof player.adpPositionRank === "number" && player.adpPositionRank >= 1 && player.adpPositionRank <= 12)
  );
}

export interface ScoreInterestOptions {
  /** When the same player was last posted about; inside SAME_PLAYER_PENALTY_WINDOW_MS of `now` it costs 20. */
  recentSamePlayerPostAt?: number;
  /** Defaults to Date.now(); injectable for tests. */
  now?: number;
}

/** Spec §7, clamped to 0–100 and rounded to an integer. */
export function scoreInterest(card: WireFactCard, opts: ScoreInterestOptions = {}): number {
  let interest = interestBase(card);
  interest += Math.min(50, maxPercentOwned(card.players) / 2);
  if (isMultiWeekTimetable(card.timetable)) interest += 15;
  if (isPremiumPlayer(card.players)) interest += 10;
  if (typeof opts.recentSamePlayerPostAt === "number") {
    const now = opts.now ?? Date.now();
    if (Math.abs(now - opts.recentSamePlayerPostAt) <= SAME_PLAYER_PENALTY_WINDOW_MS) interest -= 20;
  }
  return Math.max(0, Math.min(100, Math.round(interest)));
}
