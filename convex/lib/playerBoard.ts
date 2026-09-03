/**
 * PlayerBoard: every rostered player's season line and this-week projection, ranked within
 * position, so a writer can cite league-relative context ("WR1 in the league vs WR12") instead
 * of a bare point total. Owner directive (2026-09-03, verbatim): "It should go based on
 * projections week by week for the weekly matchup previews and mention their records and stats
 * going forward as well as notable players and their rankings" - `basis` is what lets the same
 * shape serve a week-1 preview (nobody has a stat line yet) and a week-10 recap (nobody cares
 * about the projection anymore) without the writer having to know which week it is.
 *
 * Intentionally pure - no `ctx.db`, no wall clock, no import of anything that itself references
 * `internal`/`api` - so this is safe to import as a value from `convex/aiQueries.ts`, from a
 * mutation or action, and from a plain vitest file with no Convex runtime at all (see
 * `convex/lib/playoffs.ts`'s header for why that matters in this repo).
 */

/** ESPN lineup slot ids for bench and IR - shared with the recap/preview roster logic in
 * `convex/aiQueries.ts` (`topPerformersFor`) and `src/lib/ai/prompt-builder.ts`. */
const BENCH_SLOT = 20;
const IR_SLOT = 21;

/**
 * Canonical fantasy position order - deliberately not alphabetical (that would wedge "DST"
 * between "D" and "K" style listings), matching how a league's own position groups are usually
 * presented. Anything outside this list (rare or legacy position strings) sorts after it.
 */
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DST"];

function positionOrderIndex(position: string): number {
  const index = POSITION_ORDER.indexOf(position);
  return index === -1 ? POSITION_ORDER.length : index;
}

/**
 * ESPN spells the defense/special-teams position two ways depending on endpoint ("D/ST" on some
 * roster payloads, "DST" on others). Normalised here so a league's lone defense doesn't get
 * counted as two separate one-player "positions" with two different #1 ranks.
 */
export function normalizePosition(position: string): string {
  const upper = position.toUpperCase();
  return upper === "D/ST" ? "DST" : upper;
}

function isStarterSlot(lineupSlotId: number): boolean {
  return lineupSlotId !== BENCH_SLOT && lineupSlotId !== IR_SLOT;
}

/* -------------------------------------------------------------------------- *
 * Input shapes
 * -------------------------------------------------------------------------- */

export interface PlayerBoardRosterPlayer {
  playerId: string;
  playerName: string;
  position: string;
  team?: string;
  injuryStatus?: string;
  /** Only meaningful on a team's stored roster entry - the upcoming-week lineup slot (below) is
   * preferred whenever that week's matchup roster has this player. */
  lineupSlotId?: number;
}

export interface PlayerBoardTeamInput {
  externalId: string;
  name: string;
  roster: PlayerBoardRosterPlayer[];
}

export interface PlayerBoardLineupPlayer {
  espnId: number;
  fullName: string;
  position: string;
  points: number;
  projectedPoints?: number;
  lineupSlotId: number;
}

export interface PlayerBoardRosterSide {
  players: PlayerBoardLineupPlayer[];
}

export interface PlayerBoardMatchupInput {
  matchupPeriod: number;
  homeTeamId: string;
  awayTeamId: string;
  homeRoster?: PlayerBoardRosterSide;
  awayRoster?: PlayerBoardRosterSide;
}

export interface PlayerBoardDraftPickInput {
  playerId: string;
  overallPickNumber: number;
}

export interface BuildPlayerBoardInput {
  teams: PlayerBoardTeamInput[];
  /** Played weeks only - a later week's real result must never leak into `seasonPoints`
   * (the caller is responsible for that boundary, same as every other historical-mode
   * computation in `convex/aiQueries.ts`). */
  playedMatchups: PlayerBoardMatchupInput[];
  /** The preview week's own (unplayed) matchup rows - `getLeagueDataForAI`'s raw rows for
   * `previewWeek`, before they are reshaped into the display `upcomingMatchups` array. */
  upcomingMatchups: PlayerBoardMatchupInput[];
  draftPicks: PlayerBoardDraftPickInput[];
  /** Last played week the board's `seasonPoints`/`gamesPlayed` cover - 0 before week 1. Also
   * what decides `basis` (see below). */
  throughWeek: number;
}

/* -------------------------------------------------------------------------- *
 * Output shapes
 * -------------------------------------------------------------------------- */

export interface PlayerBoardEntry {
  playerId: string;
  name: string;
  position: string;
  nflTeam?: string;
  fantasyTeamId: string;
  fantasyTeamName: string;
  lineup: "starter" | "bench";
  /** This week's projection from the upcoming matchup lineup - only set for starters. */
  upcomingProjected?: number;
  seasonPoints: number;
  gamesPlayed: number;
  /** 1-based rank among rostered players at this position, by `basis`. */
  positionRank: number;
  positionCount: number;
  draftPick?: number;
  injuryStatus?: string;
}

export interface PlayerBoard {
  /** "upcoming_projection" before any game has been played (week 1, or a preview written before
   * kickoff); "season_points" from then on - the same switch the owner asked for on the weekly
   * preview itself. */
  basis: "season_points" | "upcoming_projection";
  throughWeek: number;
  /** Every rostered player, sorted by position (fantasy-standard order) then rank. */
  entries: PlayerBoardEntry[];
}

/* -------------------------------------------------------------------------- *
 * buildPlayerBoard
 * -------------------------------------------------------------------------- */

export function buildPlayerBoard(input: BuildPlayerBoardInput): PlayerBoard {
  const statsByPlayerId = new Map<string, { seasonPoints: number; gamesPlayed: number }>();
  for (const matchup of input.playedMatchups) {
    for (const side of [matchup.homeRoster, matchup.awayRoster]) {
      if (!side) continue;
      for (const player of side.players) {
        const playerId = String(player.espnId);
        const existing = statsByPlayerId.get(playerId) ?? { seasonPoints: 0, gamesPlayed: 0 };
        existing.seasonPoints += player.points;
        existing.gamesPlayed += 1;
        statsByPlayerId.set(playerId, existing);
      }
    }
  }

  const upcomingByPlayerId = new Map<string, PlayerBoardLineupPlayer>();
  for (const matchup of input.upcomingMatchups) {
    for (const side of [matchup.homeRoster, matchup.awayRoster]) {
      if (!side) continue;
      for (const player of side.players) {
        upcomingByPlayerId.set(String(player.espnId), player);
      }
    }
  }

  // First pick wins - a player traded/re-drafted mid-keeper-league shows the pick that actually
  // brought him to his CURRENT roster in every case this repo has data for (draft transactions
  // read oldest-first is not guaranteed, but a duplicate here is a data anomaly either way, and a
  // deterministic "first seen" beats a nondeterministic "last seen").
  const draftPickByPlayerId = new Map<string, number>();
  for (const pick of input.draftPicks) {
    if (!draftPickByPlayerId.has(pick.playerId)) {
      draftPickByPlayerId.set(pick.playerId, pick.overallPickNumber);
    }
  }

  const basis: PlayerBoard["basis"] = input.throughWeek >= 1 ? "season_points" : "upcoming_projection";
  const rankValue = (entry: PlayerBoardEntry): number =>
    basis === "season_points" ? entry.seasonPoints : entry.upcomingProjected ?? 0;

  const entries: PlayerBoardEntry[] = input.teams.flatMap((team) =>
    team.roster.map((player): PlayerBoardEntry => {
      const upcoming = upcomingByPlayerId.get(player.playerId);
      let lineup: "starter" | "bench";
      let upcomingProjected: number | undefined;
      if (upcoming) {
        const starter = isStarterSlot(upcoming.lineupSlotId);
        lineup = starter ? "starter" : "bench";
        if (starter) upcomingProjected = upcoming.projectedPoints;
      } else {
        // No lineup data for the preview week (bye, or a sync gap) - fall back to the stored
        // roster's own slot, defaulting to bench when even that is missing.
        lineup = player.lineupSlotId !== undefined && isStarterSlot(player.lineupSlotId) ? "starter" : "bench";
      }
      const stats = statsByPlayerId.get(player.playerId);
      return {
        playerId: player.playerId,
        name: player.playerName,
        position: normalizePosition(player.position),
        nflTeam: player.team || undefined,
        fantasyTeamId: team.externalId,
        fantasyTeamName: team.name,
        lineup,
        upcomingProjected,
        seasonPoints: stats?.seasonPoints ?? 0,
        gamesPlayed: stats?.gamesPlayed ?? 0,
        // Filled in below, once every entry at this position is known.
        positionRank: 0,
        positionCount: 0,
        draftPick: draftPickByPlayerId.get(player.playerId),
        injuryStatus: player.injuryStatus,
      };
    })
  );

  const byPosition = new Map<string, PlayerBoardEntry[]>();
  for (const entry of entries) {
    const group = byPosition.get(entry.position);
    if (group) group.push(entry);
    else byPosition.set(entry.position, [entry]);
  }
  for (const group of byPosition.values()) {
    group.sort((a, b) => rankValue(b) - rankValue(a) || a.name.localeCompare(b.name));
    group.forEach((entry, index) => {
      entry.positionRank = index + 1;
      entry.positionCount = group.length;
    });
  }

  entries.sort((a, b) => {
    const byPositionOrder = positionOrderIndex(a.position) - positionOrderIndex(b.position);
    return byPositionOrder !== 0 ? byPositionOrder : a.positionRank - b.positionRank;
  });

  return { basis, throughWeek: input.throughWeek, entries };
}

/* -------------------------------------------------------------------------- *
 * Per-matchup "notable players" (spec: WR1-vs-WR12 style callouts on the preview slate)
 * -------------------------------------------------------------------------- */

export interface KeyPlayer {
  side: "A" | "B";
  playerId: string;
  name: string;
  position: string;
  projected?: number;
  positionRank?: number;
}

/**
 * Top `limit` projected starters on one side of an upcoming matchup. `positionRankByPlayerId`
 * should come from this same league's `PlayerBoard.entries` (built once per `getLeagueDataForAI`
 * call) so a game's key players cite the same rank the rest of the article does.
 */
export function topKeyPlayers(
  side: "A" | "B",
  players: PlayerBoardLineupPlayer[],
  positionRankByPlayerId: Map<string, number>,
  limit = 3
): KeyPlayer[] {
  return players
    .filter((p) => isStarterSlot(p.lineupSlotId))
    .slice()
    .sort((a, b) => (b.projectedPoints ?? 0) - (a.projectedPoints ?? 0))
    .slice(0, limit)
    .map((p) => ({
      side,
      playerId: String(p.espnId),
      name: p.fullName,
      position: normalizePosition(p.position),
      projected: p.projectedPoints,
      positionRank: positionRankByPlayerId.get(String(p.espnId)),
    }));
}

/**
 * A team's projected total for an upcoming matchup, summed from its starters' own
 * `projectedPoints` - the fallback `getLeagueDataForAI` uses when ESPN hasn't published a
 * team-level projection for the week yet. `undefined` (never 0) when there is no lineup to sum,
 * so the caller can tell "no projection" apart from "projected for zero."
 */
export function sumStarterProjected(side: PlayerBoardRosterSide | undefined): number | undefined {
  if (!side) return undefined;
  const starters = side.players.filter((p) => isStarterSlot(p.lineupSlotId));
  if (starters.length === 0) return undefined;
  return starters.reduce((sum, p) => sum + (p.projectedPoints ?? 0), 0);
}
