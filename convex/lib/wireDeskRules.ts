/**
 * Dex Desk — pure decision logic (ffsn-the-wire-spec.md §18). Everything here is a plain function
 * of plain data: no `ctx.db`, no `internal`/`api` import, so it is safe to import from any
 * convex/*.ts module (the repo's documented cross-module value-import gotcha - see
 * `convex/lib/wireLeaguePosting.ts`'s header comment) and to unit-test directly
 * (tests/wire/wireDeskRules.test.ts) with no Convex runtime at all.
 */

import {
  CLAIMS_HOT_FRACTION,
  LATE_SCRATCH_WINDOW_MS,
  LATE_SWAP_WINDOW_MS,
  QUIET_DESK_WINDOW_MS,
  READS_THE_WIRE_WINDOW_MS,
  SAM_QUESTIONS_PER_LEAGUE_PER_DAY,
  SAM_QUESTIONS_PER_MANAGER_PER_DAY,
} from "../../src/lib/ai/wire/types";
import { BENCH_SLOT_ID, IR_SLOT_ID, NON_STARTER_SLOT_IDS } from "./lineupSlots";

/* -------------------------------------------------------------------------- *
 * lineup_move / late_swap (spec §18)
 * -------------------------------------------------------------------------- */

export interface LineupItemLike {
  type: string;
  playerId: number;
  fromLineupSlotId: number;
  toLineupSlotId: number;
}

/**
 * True for a LINEUP item that moves a player INTO a starting slot (`to` not bench/IR) or OUT of one
 * to the bench (`from` not bench/IR, `to` bench). A pure IR move (20<->21) satisfies neither
 * condition and is correctly excluded - it stays the existing `ir_move` behavior (spec §18).
 */
export function isLineupMoveItem(item: LineupItemLike): boolean {
  if (item.type !== "LINEUP") return false;
  const { fromLineupSlotId: from, toLineupSlotId: to } = item;
  const intoStarting = !NON_STARTER_SLOT_IDS.has(to);
  const outToBench = !NON_STARTER_SLOT_IDS.has(from) && to === BENCH_SLOT_ID;
  return intoStarting || outToBench;
}

export interface LineupMoveSummary {
  movedInPlayerId?: number;
  movedInToSlotId?: number;
  /** A different player moved to the bench in the same transaction, if any. */
  benchedPlayerId?: number;
}

/** Summarize a transaction's LINEUP items into the primary "moved in" player (preferring a move
 *  into a starting slot over a move-to-bench when a transaction carries both, i.e. a swap) and the
 *  benched player from the same move, if any. `{}` when the transaction has no qualifying move. */
export function summarizeLineupMove(items: readonly LineupItemLike[]): LineupMoveSummary {
  const moveItems = items.filter(isLineupMoveItem);
  if (moveItems.length === 0) return {};
  const primary = moveItems.find((item) => !NON_STARTER_SLOT_IDS.has(item.toLineupSlotId)) ?? moveItems[0];
  const benched = moveItems.find(
    (item) => item.playerId !== primary.playerId && item.toLineupSlotId === BENCH_SLOT_ID
  );
  return {
    movedInPlayerId: primary.playerId,
    movedInToSlotId: primary.toLineupSlotId,
    benchedPlayerId: benched?.playerId,
  };
}

/** Late swap (spec §18): the moved-in player's NFL kickoff falls within LATE_SWAP_WINDOW_MS AFTER
 *  the transaction's own `proposedDate` - i.e. the manager acted this close to that kickoff. */
export function isLateSwap(proposedDate: number, kickoffAt: number): boolean {
  const delta = kickoffAt - proposedDate;
  return delta >= 0 && delta <= LATE_SWAP_WINDOW_MS;
}

/** Minutes from `from` to `kickoffAt`, floored at 0 (never negative for a past kickoff). */
export function minutesUntil(kickoffAt: number, from: number): number {
  return Math.max(0, Math.round((kickoffAt - from) / 60000));
}

export function hoursBetween(earlierMs: number, laterMs: number): number {
  return Math.max(0, Math.round((laterMs - earlierMs) / (60 * 60 * 1000)));
}

/** Plain-English gap for the `reads_the_wire` `{hoursAgo}` slot (stock-lines.ts's header: "two
 *  hours", "40 minutes" - the lines read "{hoursAgo} after the {status} tag"). Under an hour reads
 *  as a digit count of minutes; an hour or more reads as a spelled-out count of hours. */
export function hoursAgoPhrase(earlierMs: number, laterMs: number): string {
  const totalMinutes = Math.max(0, Math.round((laterMs - earlierMs) / 60000));
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.round(totalMinutes / 60));
  return `${countWord(hours)} hour${hours === 1 ? "" : "s"}`;
}

/* -------------------------------------------------------------------------- *
 * reads_the_wire (spec §18, §16 in-game injury rule)
 * -------------------------------------------------------------------------- */

/** Any status other than "Active" reads as an injury tag worth flagging (spec §18's "worse than
 *  Active" wording) - case/whitespace insensitive so "OUT", "Out", " out " all match. */
export function isWorseThanActive(status: string | undefined): boolean {
  if (!status) return false;
  return status.trim().toLowerCase() !== "active";
}

export interface ReadsTheWireInput {
  /** When the injury tag was observed (`wireEvents.observedAt`). */
  injuryObservedAt: number;
  /** The transaction's own `proposedDate`. */
  proposedDate: number;
  /** This player's NFL team's kickoff for the week the move happens in, if known. */
  teamKickoffAt: number | undefined;
}

/**
 * A bench move within READS_THE_WIRE_WINDOW_MS of an injury tag on that SAME player "reads the
 * wire" - UNLESS the injury was observed after that team's own kickoff (spec §16: an in-game injury
 * is never framed as a decision the manager made ahead of time). In that case a plain `lineup_move`
 * posts instead - this function returning `false` is exactly the signal callers need for that.
 */
export function isReadsTheWire(input: ReadsTheWireInput): boolean {
  const { injuryObservedAt, proposedDate, teamKickoffAt } = input;
  if (teamKickoffAt !== undefined && injuryObservedAt > teamKickoffAt) return false;
  const delta = proposedDate - injuryObservedAt;
  return delta >= 0 && delta <= READS_THE_WIRE_WINDOW_MS;
}

/* -------------------------------------------------------------------------- *
 * lineup_lock / late scratch (spec §18, §16)
 * -------------------------------------------------------------------------- */

/** A status observed this close before kickoff is a late scratch - never framed as the manager's
 *  call (spec §16/§18): the public `lineup_lock` post is skipped, though the private warning still
 *  fired earlier. */
export function isLateScratch(statusObservedAt: number, kickoffAt: number): boolean {
  const delta = kickoffAt - statusObservedAt;
  return delta >= 0 && delta <= LATE_SCRATCH_WINDOW_MS;
}

const LOCKOUT_STATUSES: ReadonlySet<string> = new Set([
  "out",
  "ir",
  "injured reserve",
  "doubtful",
  "suspension",
  "suspended",
]);

/** Whether a status string is one of the lineup-lock designations (spec §18: "OUT / IR / Injured
 *  Reserve / Doubtful / Suspension"), case/whitespace insensitive. */
export function isLockoutStatus(status: string | undefined): boolean {
  if (!status) return false;
  return LOCKOUT_STATUSES.has(status.trim().toLowerCase());
}

/* -------------------------------------------------------------------------- *
 * claims_in (spec §18 leak policy)
 * -------------------------------------------------------------------------- */

/** Never a team name or dollar amount (owner policy) - just a read on how hot the bidding is. */
export function claimsHeat(topPendingBid: number, faabBudget: number | undefined): string {
  if (!faabBudget || faabBudget <= 0) return "a bid or two in";
  return topPendingBid / faabBudget >= CLAIMS_HOT_FRACTION ? "the bidding looks high" : "a bid or two in";
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** "three" for small counts (the claims_in/lineup_move `{count}` slot reads as a word, never a
 *  team-identifying number); falls back to the digit past ten. */
export function countWord(n: number): string {
  return n >= 0 && n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n);
}

const ORDINAL_WORDS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** "fourth" for the streaming_churn `{streak}` slot ("fourth D/ST in five weeks"). */
export function ordinalWord(n: number): string {
  return n >= 0 && n < ORDINAL_WORDS.length ? ORDINAL_WORDS[n] : `${n}th`;
}

/* -------------------------------------------------------------------------- *
 * Season / calendar gates
 * -------------------------------------------------------------------------- */

/** In season by month alone (spec §18 cadence fallback, when `nflSeasons` phase data is
 *  unavailable): September through January, UTC month. */
export function isInSeasonByMonth(date: Date): boolean {
  const month = date.getUTCMonth(); // 0-indexed: Jan=0 ... Dec=11
  return month >= 8 || month === 0; // Sep(8)-Dec(11), Jan(0)
}

/** quiet_desk runs only inside QUIET_DESK_WINDOW_MS before the trade deadline (the caller checks
 *  "is it Tuesday, league-local" separately - see `localWeekdayAndHour`). */
export function isWithinQuietDeskWindow(now: number, tradeDeadline: number | undefined): boolean {
  if (tradeDeadline === undefined) return false;
  const delta = tradeDeadline - now;
  return delta > 0 && delta <= QUIET_DESK_WINDOW_MS;
}

/* -------------------------------------------------------------------------- *
 * faab_watch (spec §18)
 * -------------------------------------------------------------------------- */

export function faabRemainingFraction(budget: number, spent: number): number {
  if (budget <= 0) return 0;
  return Math.max(0, budget - spent) / budget;
}

/* -------------------------------------------------------------------------- *
 * rumor_check (spec §18)
 * -------------------------------------------------------------------------- */

const RUMOR_PATTERN = /\b(rumou?r|hearing|shopping|trade)\b/i;

/** Whether a manager post's text is a rumor-shaped statement worth Dex's attention. */
export function looksLikeRumor(text: string): boolean {
  return RUMOR_PATTERN.test(text);
}

/**
 * The unique rostered player whose last name (>= 4 letters) appears, case-insensitively, in `text`.
 * `null` when no candidate matches or more than one does (an ambiguous mention names nobody, per
 * spec: "unique match"). `lastNames` maps a lowercased last name to the candidate full name(s)
 * sharing it - a name shared by two rostered players is deliberately never a match.
 */
export function findUniqueRosteredMention(
  text: string,
  lastNames: ReadonlyMap<string, readonly string[]>
): string | null {
  const lowerText = text.toLowerCase();
  let match: string | null = null;
  for (const [lastName, fullNames] of lastNames) {
    if (lastName.length < 4) continue;
    if (fullNames.length !== 1) continue; // shared last name across rostered players: ambiguous
    const pattern = new RegExp(`\\b${lastName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (!pattern.test(lowerText)) continue;
    if (match !== null && match !== fullNames[0]) return null; // more than one distinct player named
    match = fullNames[0];
  }
  return match;
}

/* -------------------------------------------------------------------------- *
 * sam_question gates (spec §18)
 * -------------------------------------------------------------------------- */

export type SamQuestionGateReason = "manager_daily_limit" | "league_daily_limit" | "season_spend_cap";

export interface SamQuestionGateCounts {
  /** `sam_question` posts already featuring this team today. */
  perManagerToday: number;
  /** `sam_question` posts anywhere in this league today. */
  perLeagueToday: number;
  seasonSpendUsd: number;
  spendCapUsd: number;
}

/** Why Sam's question was skipped, or `null` when every gate passes (spec §18: 1 per manager per
 *  day, 10 per league per day, plus the league's season automation spend cap). */
export function samQuestionGateReason(counts: SamQuestionGateCounts): SamQuestionGateReason | null {
  if (counts.perManagerToday >= SAM_QUESTIONS_PER_MANAGER_PER_DAY) return "manager_daily_limit";
  if (counts.perLeagueToday >= SAM_QUESTIONS_PER_LEAGUE_PER_DAY) return "league_daily_limit";
  if (counts.seasonSpendUsd >= counts.spendCapUsd) return "season_spend_cap";
  return null;
}

/* -------------------------------------------------------------------------- *
 * Local wall-clock (weekly_rundown / quiet_desk day-of-week + hour gates)
 * -------------------------------------------------------------------------- */

const WEEKDAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Local day-of-week (0=Sun) and hour (0-23) for a UTC instant in an IANA timezone, via `Intl`.
 * Deliberately duplicated rather than imported from `convex/contentScheduling.ts`'s
 * `wallClockPartsAt`/`convertUTCToTimeZone`: that module defines Convex functions (imports
 * `internal`), so importing a plain value out of it risks the recursive-`api`-type gotcha this
 * file's header warns about. Falls back to UTC on an unknown timezone id.
 */
export function localWeekdayAndHour(utcMs: number, timeZone: string): { weekday: number; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
    }).formatToParts(new Date(utcMs));
    const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
    const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
    const hour = parseInt(hourPart, 10) % 24;
    const weekday = WEEKDAY_SHORT_NAMES.indexOf(weekdayShort);
    return { weekday: weekday >= 0 ? weekday : 0, hour: Number.isFinite(hour) ? hour : 0 };
  } catch {
    const d = new Date(utcMs);
    return { weekday: d.getUTCDay(), hour: d.getUTCHours() };
  }
}

export const SUNDAY = 0;
export const MONDAY = 1;
export const TUESDAY = 2;
export const WEDNESDAY = 3;

/** weekly_rundown fires once, Wednesday 07:00 league-local (spec §18); the cron polls hourly, so
 *  this checks "is the local wall clock inside the 07:00 hour on Wednesday right now". */
export function isWeeklyRundownHour(utcMs: number, timeZone: string, targetHour = 7): boolean {
  const { weekday, hour } = localWeekdayAndHour(utcMs, timeZone);
  return weekday === WEDNESDAY && hour === targetHour;
}

/** quiet_desk runs on Tuesdays, league-local (spec §18). */
export function isQuietDeskDay(utcMs: number, timeZone: string): boolean {
  return localWeekdayAndHour(utcMs, timeZone).weekday === TUESDAY;
}

/* -------------------------------------------------------------------------- *
 * lineup_lock on bye (spec §18 "Not built": "the on-bye trigger for lineup_lock")
 * -------------------------------------------------------------------------- */

/**
 * The earliest kickoff, among `kickoffTimes`, that falls on a Sunday in `timeZone` (default
 * America/New_York, the same league-local clock `isWeeklyRundownHour`/`isQuietDeskDay` use) -
 * a bye check has no game of its own to anchor to, so it anchors to the week's first Sunday
 * kickoff instead (spec §18). `undefined` when none of the given kickoffs falls on a Sunday.
 */
export function firstSundayKickoff(kickoffTimes: readonly number[], timeZone = "America/New_York"): number | undefined {
  const sundays = kickoffTimes.filter((t) => localWeekdayAndHour(t, timeZone).weekday === SUNDAY);
  if (sundays.length === 0) return undefined;
  return Math.min(...sundays);
}
