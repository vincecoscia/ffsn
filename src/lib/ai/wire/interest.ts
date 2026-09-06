// The Wire — interest score (spec §7), as a pure function of the fact card.
//
//   interest = base(kind, transition) + min(50, percentOwned / 2) + bonuses − penalty, clamped 0–100
//
// Live kinds (spec §19): game_started / game_final 30, scoring_play 25 (+25 when the TD is long or
// the player's Nth of the day — the "take" bar), big_line 45, bust_watch 40.
//
// The thresholds that read this number live in types.ts (TAKE_MIN_INTEREST, CARD_MIN_INTEREST).

import {
  SAME_PLAYER_PENALTY_WINDOW_MS,
  SCORING_PLAY_TAKE_MIN_TD_COUNT,
  SCORING_PLAY_TAKE_MIN_YARDS,
  TRENDING_BOARD_INTEREST,
  type WireCardPlayer,
  type WireFactCard,
} from "./types";
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
      // A timetable on a news story ("out 4-6 weeks") carries the same weight as one on a note.
      return card.timetable ? 40 : 20;
    case "depth_chart":
      return card.depthOrderTo === 1 ? 30 : DEFAULT_BASE;
    case "trending":
      // A spike that plausibly answers a known event (an injury, a depth-chart move) reads as news;
      // a bare spike is still just a waiver signal.
      return card.related ? 45 : 20;
    case "trending_board":
      return TRENDING_BOARD_INTEREST;
    case "ownership_swing":
      return 20;
    // Live game engine (spec §19)
    case "game_started":
    case "game_final":
      return 30;
    case "scoring_play":
      return 25;
    case "big_line":
      return 45;
    case "bust_watch":
      return 40;
    default:
      return DEFAULT_BASE;
  }
}

/**
 * A scoring play worth a take rather than a card (spec §19.1): the touchdown covered
 * SCORING_PLAY_TAKE_MIN_YARDS or more, or it was the player's SCORING_PLAY_TAKE_MIN_TD_COUNTth of
 * the day. Worth +25 on top of the base.
 */
export function isTakeWorthyScoringPlay(card: WireFactCard): boolean {
  if (card.kind !== "scoring_play" || !card.play) return false;
  const { yards, tdCountToday } = card.play;
  if (typeof yards === "number" && yards >= SCORING_PLAY_TAKE_MIN_YARDS) return true;
  return typeof tdCountToday === "number" && tdCountToday >= SCORING_PLAY_TAKE_MIN_TD_COUNT;
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
  // A board is a ranking, not a story about one player - no ownership term, no bonuses, no penalty.
  // A 93%-rostered name in the top 5 must never push this into take territory (spec update 2026-09-06).
  if (card.kind === "trending_board") return TRENDING_BOARD_INTEREST;
  let interest = interestBase(card);
  interest += Math.min(50, maxPercentOwned(card.players) / 2);
  if (isMultiWeekTimetable(card.timetable)) interest += 15;
  if (isPremiumPlayer(card.players)) interest += 10;
  if (isTakeWorthyScoringPlay(card)) interest += 25;
  if (typeof opts.recentSamePlayerPostAt === "number") {
    const now = opts.now ?? Date.now();
    if (Math.abs(now - opts.recentSamePlayerPostAt) <= SAME_PLAYER_PENALTY_WINDOW_MS) interest -= 20;
  }
  return Math.max(0, Math.min(100, Math.round(interest)));
}
