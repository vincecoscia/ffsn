/**
 * The Wire — live game engine (ffsn-the-wire-spec.md §19, §9): every pure decision the game clock
 * makes, isolated from Convex so it can be unit-tested with small fixtures
 * (tests/wire/wireLiveRules.test.ts) instead of a live network call.
 *
 * Three families of pure function live here:
 *   - Parsers for ESPN's public scoreboard / summary (`scoringPlays[]`) / boxscore
 *     (`boxscore.players[].statistics[].athletes[]`) payloads. Shapes probed 2026-09-05 directly
 *     against `site.web.api.espn.com` while building this file (a completed 2025 week 1 game, e.g.
 *     event 401772510) - every field is read defensively (a game/play/line whose shape doesn't
 *     parse is dropped, never thrown - spec §12.5's "a shape change is a parse error, not a bad
 *     post").
 *   - ESPN-standard (non-PPR) fantasy-point math from a box line, and the big_line/bust_watch
 *     threshold checks.
 *   - The matchup-live diff rules (lead change / blowout / comeback) and the clock's own
 *     reschedule decision.
 *
 * No Convex imports (no `./_generated/*`, no `internal`/`api`) - safe to import from a plain
 * vitest file and from both `wireLive.ts` (the action) and `wireLiveData.ts` (the mutations).
 */

import {
  BIG_LINE_PASS_YARDS,
  BIG_LINE_RUSH_REC_YARDS,
  BIG_LINE_TD,
  BUST_WATCH_MAX_ADP_RANK,
  BUST_WATCH_MAX_POINTS,
  CLOCK_PRE_KICKOFF_MS,
  GAME_CLOCK_TICK_MS,
  MATCHUP_LIVE_BLOWOUT_MARGIN,
  MATCHUP_LIVE_COMEBACK_FROM,
} from "../../src/lib/ai/wire/types";

/* ------------------------------------------------------------------------------------------- *
 * Small defensive readers - every parser below reads an untyped ESPN payload through these so a
 * missing/malformed field degrades to "absent" instead of throwing mid-parse.
 * ------------------------------------------------------------------------------------------- */

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/* ------------------------------------------------------------------------------------------- *
 * Scoreboard (`…/nfl/scoreboard`): `events[].competitions[0]`, `status.type.state` pre/in/post.
 * ------------------------------------------------------------------------------------------- */

export type GameState = "pre" | "in" | "post";

export interface ParsedGame {
  eventId: string;
  state: GameState;
  homeAbbrev: string;
  awayAbbrev: string;
  homeScore: number;
  awayScore: number;
  period?: number;
  /** ESPN's own display clock, e.g. "4:12". */
  clock?: string;
  kickoffAt?: number;
}

const GAME_STATES: ReadonlySet<string> = new Set(["pre", "in", "post"]);

function asGameState(value: unknown): GameState | undefined {
  const state = str(value);
  return GAME_STATES.has(state) ? (state as GameState) : undefined;
}

/** Every game on the scoreboard payload with a state ESPN recognizes and both team abbreviations
 *  present. A malformed event is dropped, never thrown. */
export function parseScoreboard(payload: unknown): ParsedGame[] {
  const events = asArray(asRecord(payload).events);
  const games: ParsedGame[] = [];

  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    const competition = asRecord(asArray(event.competitions)[0]);
    if (Object.keys(competition).length === 0) continue;

    const eventId = str(event.id) || str(competition.id);
    if (!eventId) continue;

    const status = asRecord(competition.status);
    const state = asGameState(asRecord(status.type).state);
    if (!state) continue;

    const competitors = asArray(competition.competitors).map(asRecord);
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    const homeAbbrev = str(asRecord(home?.team).abbreviation);
    const awayAbbrev = str(asRecord(away?.team).abbreviation);
    if (!homeAbbrev || !awayAbbrev) continue;

    games.push({
      eventId,
      state,
      homeAbbrev,
      awayAbbrev,
      homeScore: num(home?.score) ?? 0,
      awayScore: num(away?.score) ?? 0,
      period: num(status.period),
      clock: str(status.displayClock) || undefined,
      kickoffAt: parseIsoMs(event.date) ?? parseIsoMs(competition.date),
    });
  }

  return games;
}

/** `eventId -> state` as of the last tick, so a transition can be told from a repeat. */
export type GameStateCursor = Record<string, { state: GameState }>;

export function nextGameStateCursor(games: ReadonlyArray<ParsedGame>): GameStateCursor {
  const cursor: GameStateCursor = {};
  for (const game of games) cursor[game.eventId] = { state: game.state };
  return cursor;
}

export type GameTransitionKind = "game_started" | "game_final";
export interface GameTransition {
  eventId: string;
  kind: GameTransitionKind;
}

/**
 * pre→in and in→post transitions only (spec §19.1). `coldStart` (the clock's very first tick, or
 * any tick with no prior cursor) never emits a transition - same "seed the cursor, post nothing"
 * rule `wireSourcesNode.ts#pollEspnInjuries` uses, so restarting the clock never floods the wire
 * with "started" events for every game already in progress.
 */
export function detectGameTransitions(
  games: ReadonlyArray<ParsedGame>,
  prevCursor: GameStateCursor,
  coldStart: boolean
): GameTransition[] {
  if (coldStart) return [];
  const transitions: GameTransition[] = [];
  for (const game of games) {
    const prevState = prevCursor[game.eventId]?.state;
    if (prevState === undefined) continue; // a game that appeared mid-week (rare); wait for a real prior state
    if (prevState === "pre" && game.state === "in") {
      transitions.push({ eventId: game.eventId, kind: "game_started" });
    } else if (prevState === "in" && game.state === "post") {
      transitions.push({ eventId: game.eventId, kind: "game_final" });
    }
  }
  return transitions;
}

export function anyGameLive(games: ReadonlyArray<ParsedGame>): boolean {
  return games.some((g) => g.state === "in");
}

/* ------------------------------------------------------------------------------------------- *
 * Summary scoring plays (`…/nfl/summary?event=`): `scoringPlays[]`.
 * ------------------------------------------------------------------------------------------- */

export interface ParsedScoringPlay {
  id: string;
  /** ESPN's `type.text`, e.g. "Rushing Touchdown", "Passing Touchdown", "Field Goal Good". */
  typeText: string;
  /** Verbatim play text, e.g. "Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)". */
  text: string;
  homeScore: number;
  awayScore: number;
  period?: number;
  clock?: string;
  teamAbbrev?: string;
  /** ESPN athlete id, when the payload's own `participants[]` names the scorer directly - some
   *  weeks carry this, some don't (spec §19.1 hedge: "when present"). */
  participantEspnId?: string;
}

function firstParticipantEspnId(rawParticipants: unknown): string | undefined {
  const participants = asArray(rawParticipants).map(asRecord);
  if (participants.length === 0) return undefined;
  const scorer = participants.find((p) => /score/i.test(str(p.type)));
  const chosen = scorer ?? participants[0];
  const id = str(asRecord(chosen.athlete).id);
  return id || undefined;
}

export function parseScoringPlays(payload: unknown): ParsedScoringPlay[] {
  const plays = asArray(asRecord(payload).scoringPlays);
  const out: ParsedScoringPlay[] = [];
  for (const rawPlay of plays) {
    const play = asRecord(rawPlay);
    const id = str(play.id);
    const text = str(play.text);
    if (!id || !text) continue;
    out.push({
      id,
      typeText: str(asRecord(play.type).text),
      text,
      homeScore: num(play.homeScore) ?? 0,
      awayScore: num(play.awayScore) ?? 0,
      period: num(asRecord(play.period).number) ?? num(play.period),
      clock: str(asRecord(play.clock).displayValue) || undefined,
      teamAbbrev: str(asRecord(play.team).abbreviation) || undefined,
      participantEspnId: firstParticipantEspnId(play.participants),
    });
  }
  return out;
}

/** "Javonte Williams 1 Yd Rush" -> 1; "Quentin Johnston 5 Yd pass from Justin Herbert" -> 5. Every
 *  ESPN scoring-play sentence names its subject immediately before "N Yd" - the rusher, the
 *  receiver, or the kicker. */
const NAME_YARDS_PATTERN = /^(.*?)\s+(\d+)\s+Yd\b/i;

export function parsePlayYards(text: string): number | undefined {
  const match = text.match(NAME_YARDS_PATTERN);
  if (!match) return undefined;
  return num(match[2]);
}

export interface ScorerNameGuess {
  fullName: string;
  firstInitial: string;
  lastName: string;
}

/** The play's own subject, read straight off its text (spec §19.1: "resolve the scorer from the
 *  play text ... by last name + first initial"). */
export function guessScorerName(text: string): ScorerNameGuess | undefined {
  const match = text.match(NAME_YARDS_PATTERN);
  if (!match) return undefined;
  const fullName = match[1].trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const firstInitial = parts[0].charAt(0).toUpperCase();
  if (!firstInitial) return undefined;
  return { fullName, firstInitial, lastName: parts[parts.length - 1] };
}

/** How many of this player's touchdowns (by name match) have happened in this game up to and
 *  including `uptoIndex` - `WireCardPlay.tdCountToday`. Counts by name rather than by athlete id so
 *  it needs nothing beyond the scoring-plays array itself. */
export function touchdownCountForPlayer(
  plays: ReadonlyArray<ParsedScoringPlay>,
  teamAbbrev: string | undefined,
  guess: ScorerNameGuess,
  uptoIndex: number
): number {
  let count = 0;
  const lastName = guess.lastName.toLowerCase();
  for (let i = 0; i <= uptoIndex && i < plays.length; i++) {
    const play = plays[i];
    if (teamAbbrev && play.teamAbbrev && play.teamAbbrev !== teamAbbrev) continue;
    if (!/touchdown/i.test(play.typeText)) continue;
    const playGuess = guessScorerName(play.text);
    if (!playGuess) continue;
    if (playGuess.lastName.toLowerCase() === lastName && playGuess.firstInitial === guess.firstInitial) count++;
  }
  return count;
}

/* ------------------------------------------------------------------------------------------- *
 * Boxscore (`…/nfl/summary?event=`): `boxscore.players[].statistics[].athletes[]`, stats arrays
 * keyed by each group's own `keys[]` (semantic names - "passingYards", not the display "YDS",
 * which repeats across groups).
 * ------------------------------------------------------------------------------------------- */

export interface BoxAthleteLine {
  espnId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  teamAbbrev: string;
  /** group name ("passing" | "rushing" | "receiving" | "fumbles") -> ESPN `keys[i]` -> parsed number. */
  stats: Record<string, Record<string, number>>;
}

const BOX_GROUPS: ReadonlySet<string> = new Set(["passing", "rushing", "receiving", "fumbles"]);

export function parseBoxscore(payload: unknown): BoxAthleteLine[] {
  const teamBlocks = asArray(asRecord(asRecord(payload).boxscore).players).map(asRecord);
  const byId = new Map<string, BoxAthleteLine>();

  for (const block of teamBlocks) {
    const teamAbbrev = str(asRecord(block.team).abbreviation);
    const groups = asArray(block.statistics).map(asRecord);
    for (const group of groups) {
      const groupName = str(group.name);
      if (!BOX_GROUPS.has(groupName)) continue;
      const keys = asArray(group.keys).map((k) => str(k));
      const athleteRows = asArray(group.athletes).map(asRecord);

      for (const row of athleteRows) {
        const athlete = asRecord(row.athlete);
        const espnId = str(athlete.id);
        if (!espnId) continue;
        const statValues = asArray(row.stats);
        const parsed: Record<string, number> = {};
        keys.forEach((key, i) => {
          if (!key) return;
          const value = num(statValues[i]);
          if (value !== undefined) parsed[key] = value;
        });

        const line: BoxAthleteLine = byId.get(espnId) ?? {
          espnId,
          firstName: str(athlete.firstName),
          lastName: str(athlete.lastName),
          displayName: str(athlete.displayName),
          teamAbbrev,
          stats: {},
        };
        line.stats[groupName] = { ...(line.stats[groupName] ?? {}), ...parsed };
        byId.set(espnId, line);
      }
    }
  }

  return [...byId.values()];
}

export function matchAthleteByName(
  athletes: ReadonlyArray<BoxAthleteLine>,
  guess: ScorerNameGuess
): BoxAthleteLine | undefined {
  const lastName = guess.lastName.toLowerCase();
  return athletes.find(
    (a) =>
      a.lastName.toLowerCase() === lastName &&
      a.firstName.trim().charAt(0).toUpperCase() === guess.firstInitial
  );
}

/* ------------------------------------------------------------------------------------------- *
 * Fantasy points (ESPN standard, non-PPR) and the big_line / bust_watch checks.
 * ------------------------------------------------------------------------------------------- */

export interface BoxLineTotals {
  passYds: number;
  passTd: number;
  interceptions: number;
  rushYds: number;
  rushTd: number;
  recYds: number;
  recTd: number;
  fumblesLost: number;
}

export function boxLineTotals(stats: BoxAthleteLine["stats"]): BoxLineTotals {
  return {
    passYds: stats.passing?.passingYards ?? 0,
    passTd: stats.passing?.passingTouchdowns ?? 0,
    interceptions: stats.passing?.interceptions ?? 0,
    rushYds: stats.rushing?.rushingYards ?? 0,
    rushTd: stats.rushing?.rushingTouchdowns ?? 0,
    recYds: stats.receiving?.receivingYards ?? 0,
    recTd: stats.receiving?.receivingTouchdowns ?? 0,
    fumblesLost: stats.fumbles?.fumblesLost ?? 0,
  };
}

/** ESPN standard scoring, no PPR: 0.1/rush-rec yd, 0.04/pass yd, 4 pass TD, 6 other TD, -2
 *  INT/fumble lost. Rounded to one decimal. */
export function computeFantasyPoints(stats: BoxAthleteLine["stats"]): number {
  const t = boxLineTotals(stats);
  const points =
    t.passYds * 0.04 +
    t.passTd * 4 -
    t.interceptions * 2 +
    (t.rushYds + t.recYds) * 0.1 +
    (t.rushTd + t.recTd) * 6 -
    t.fumblesLost * 2;
  return Math.round(points * 10) / 10;
}

export type BigLineMetric = "rush_rec_yds" | "pass_yds" | "td";
export interface BigLineHit {
  metric: BigLineMetric;
  value: number;
}

/**
 * Which box-score thresholds this line currently meets (spec §19.1: 100 rush/rec, 300 pass, 3 TD).
 * "rush/rec" is read as combined scrimmage yards (rushing + receiving) - the standard fantasy
 * "100 yards from scrimmage" line - rather than either category alone; "3 TD" is any combination
 * of passing/rushing/receiving touchdowns. The caller dedupes per (event, player, metric) so a
 * player over a threshold every tick from here only ever posts once.
 */
export function bigLineMetricsCrossed(stats: BoxAthleteLine["stats"]): BigLineHit[] {
  const t = boxLineTotals(stats);
  const out: BigLineHit[] = [];
  const scrimmage = t.rushYds + t.recYds;
  if (scrimmage >= BIG_LINE_RUSH_REC_YARDS) out.push({ metric: "rush_rec_yds", value: scrimmage });
  if (t.passYds >= BIG_LINE_PASS_YARDS) out.push({ metric: "pass_yds", value: t.passYds });
  const totalTd = t.passTd + t.rushTd + t.recTd;
  if (totalTd >= BIG_LINE_TD) out.push({ metric: "td", value: totalTd });
  return out;
}

/** A top-ADP player (positional rank <= 24) who finished under 5 fantasy points (spec §19.1). */
export function isBustWatchCandidate(adpPositionRank: number | undefined, fantasyPoints: number): boolean {
  if (adpPositionRank === undefined) return false;
  return adpPositionRank <= BUST_WATCH_MAX_ADP_RANK && fantasyPoints < BUST_WATCH_MAX_POINTS;
}

/* ------------------------------------------------------------------------------------------- *
 * matchup_live triggers: lead change, blowout, comeback (spec §5.2, §19.1).
 * ------------------------------------------------------------------------------------------- */

export interface MatchupScoreSnapshot {
  homeScore: number;
  awayScore: number;
}

export type MatchupTrigger = "lead_change" | "blowout" | "comeback";

/**
 * Every trigger that newly fires between `prev` (the last stored snapshot for this matchup, or
 * `undefined` on its first pull) and `curr`. More than one may fire in the same pull (a margin can
 * cross the blowout line the same tick a lead changes).
 */
export function detectMatchupTriggers(
  prev: MatchupScoreSnapshot | undefined,
  curr: MatchupScoreSnapshot
): MatchupTrigger[] {
  if (!prev) return [];
  const triggers: MatchupTrigger[] = [];
  const prevMargin = prev.homeScore - prev.awayScore; // positive = home led
  const currMargin = curr.homeScore - curr.awayScore;

  const prevSign = Math.sign(prevMargin);
  const currSign = Math.sign(currMargin);
  if (curr.homeScore > 0 && curr.awayScore > 0 && prevSign !== 0 && currSign !== 0 && prevSign !== currSign) {
    triggers.push("lead_change");
  }

  if (Math.abs(prevMargin) < MATCHUP_LIVE_BLOWOUT_MARGIN && Math.abs(currMargin) >= MATCHUP_LIVE_BLOWOUT_MARGIN) {
    triggers.push("blowout");
  }

  // Comeback: a team trailing by >= MATCHUP_LIVE_COMEBACK_FROM now leads outright.
  if (prevMargin <= -MATCHUP_LIVE_COMEBACK_FROM && currMargin > 0) triggers.push("comeback"); // away came back
  if (prevMargin >= MATCHUP_LIVE_COMEBACK_FROM && currMargin < 0) triggers.push("comeback"); // home came back

  return triggers;
}

/* ------------------------------------------------------------------------------------------- *
 * The clock's own reschedule (spec §19.1 step 4).
 * ------------------------------------------------------------------------------------------- */

export type RescheduleMode = "live" | "prekickoff" | "stop";

export interface RescheduleDecision {
  mode: RescheduleMode;
  /** "live": delay before the next tick, from now. */
  delayMs?: number;
  /** "prekickoff": the absolute time to wake up at. */
  runAt?: number;
}

export function decideReschedule(params: {
  anyLive: boolean;
  /** The earliest kickoff strictly after `now`, within the next 7 days, or `undefined` if none. */
  nextKickoffAt: number | undefined;
  now: number;
}): RescheduleDecision {
  if (params.anyLive) return { mode: "live", delayMs: GAME_CLOCK_TICK_MS };
  if (params.nextKickoffAt !== undefined) {
    return { mode: "prekickoff", runAt: Math.max(params.now, params.nextKickoffAt - CLOCK_PRE_KICKOFF_MS) };
  }
  return { mode: "stop" };
}

/* ------------------------------------------------------------------------------------------- *
 * Per-tick global event cap (spec §11: "at most 40 global events per tick").
 * ------------------------------------------------------------------------------------------- */

export function capEvents<T>(events: ReadonlyArray<T>, max: number): { kept: T[]; dropped: number } {
  if (events.length <= max) return { kept: [...events], dropped: 0 };
  return { kept: events.slice(0, max), dropped: events.length - max };
}
