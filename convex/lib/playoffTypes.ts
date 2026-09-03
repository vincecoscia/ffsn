/**
 * Playoff picture and bracket, shared by the data layer (`convex/lib/playoffs.ts`), the schedule
 * page bracket (`api.matchups.getPlayoffBracket`) and the writers' FACTS block.
 *
 * Owner ask (Sept 2026): the playoffs and the championship have to read as something different
 * and special, on the schedule page and in the articles - a bracket at playoff time, an "if the
 * season ended today" bracket during the regular season, and articles centred on the teams still
 * in contention.
 *
 * Every id here is the team's ESPN `externalId` (the string ESPN uses for the team in that
 * season), never a Convex document id: matchups, standings and the FACTS block all speak that id.
 *
 * Types only: no imports from `convex/_generated`, so this file is safe to import from the
 * frontend (type-only), from `src/lib/ai/*` and from plain vitest files.
 */

export type PlayoffMode =
  /** Regular season: seeds are "if the season ended today"; the bracket is a projection. */
  | "projected"
  /** Playoffs under way: seeds are locked; some bracket games are played, later slots are TBD. */
  | "live"
  /** The championship has been decided. */
  | "final";

export type PlayoffTier = "WINNERS_BRACKET" | "WINNERS_CONSOLATION_LADDER" | "LOSERS_CONSOLATION_LADDER";

export interface BracketTeam {
  teamId: string;
  name: string;
  seed: number;
  /** "10-4-0" */
  record: string;
  pointsFor: number;
}

export interface BracketSide {
  teamId: string;
  name: string;
  seed?: number;
  score?: number;
}

export interface BracketGame {
  week: number;
  tier: PlayoffTier;
  /** Absent while the slot is still to be decided (a later round whose feeder games are unplayed). */
  home?: BracketSide;
  away?: BracketSide;
  /** A round-one rest for a top seed: the team advances without playing. `home`/`away` are absent. */
  bye?: { teamId: string; name: string; seed: number };
  winnerTeamId?: string;
  status: "final" | "live" | "scheduled" | "bye" | "tbd";
}

export interface BracketRound {
  week: number;
  /** "Quarterfinals" | "Semifinals" | "Championship" | "Round 1" ... */
  name: string;
  /** Winners-bracket games (and byes) for this round only. */
  games: BracketGame[];
}

export interface PlayoffContext {
  mode: PlayoffMode;
  playoffTeamCount: number;
  rounds: number;
  /** Top seeds that rest in round one: 2^rounds - playoffTeamCount. */
  byes: number;
  /** First and last NFL matchup periods of the playoffs. */
  playoffStartWeek: number;
  championshipWeek: number;
  /** In live mode, the round the week being written about / viewed belongs to. */
  currentRound?: { week: number; name: string };
  /** The playoff field in seed order (projected: the top `playoffTeamCount` of the standings). */
  seeds: BracketTeam[];
  /** Projected mode only: the next teams out, in standings order (at most 2). */
  bubble: BracketTeam[];
  /** Winners bracket, one entry per round, round one first. Projected mode fills round one only. */
  bracket: BracketRound[];
  /** Consolation-ladder games, all weeks, in week order. Empty in projected mode. */
  consolation: BracketGame[];
  /** Live/final: winners-bracket teams still able to win the title / already knocked out of it. */
  alive: string[];
  eliminated: string[];
  champion?: BracketTeam;
  runnerUp?: BracketTeam;
}
