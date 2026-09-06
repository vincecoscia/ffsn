/**
 * In-game injuries (ffsn-the-wire-spec.md §16, owner ask 2026-09-05): "a player hurt during the
 * game scores like a bad start in the box score" - so a recap/interview must never call starting
 * him mismanagement, and a bench-impact comparison must never say a healthy bench player "would
 * have replaced" him. This module is the CONVEX-side half of the shared `InGameInjury` shape (the
 * prompt layer, `src/lib/ai/*`, independently declares the identical interface for
 * `LeagueDataContext`/FACTS - see that half's own header for its consumers).
 *
 * Pure: no `ctx.db`, no `./_generated/api` import - safe to import from any convex/*.ts module
 * (the repo's documented cross-module value-import gotcha; see
 * `convex/lib/wireLeaguePosting.ts`'s header comment) and to unit-test directly with no Convex
 * runtime at all (tests/wire/wireInGameInjuries.test.ts covers the query end-to-end via
 * convex-test; the pure functions here are exercised directly too).
 */

import { isStartingSlot } from "./lineupSlots";
// Re-exported rather than reimplemented: `wireDeskRules.ts` already defines this exact rule
// ("any status other than Active") for `reads_the_wire`/`lineup_lock`, and §16's in-game-injury
// rule uses the identical test - see that file's own doc comment.
export { isWorseThanActive } from "./wireDeskRules";
import { isWorseThanActive } from "./wireDeskRules";

/** A tag observed from kickoff through this many ms after is "in-game" (spec §16: "inside the
 *  game window"). 4.5 hours comfortably covers a full NFL game including overtime. */
export const IN_GAME_WINDOW_MS = 4.5 * 60 * 60 * 1000;

/** The shared shape (see this file's header): both the Convex side and the prompt layer declare
 *  it independently rather than one importing the other across the src/convex boundary. */
export interface InGameInjury {
  espnId: string;
  name: string;
  position?: string;
  nflTeam?: string;
  /** ESPN external team id as a string - the same key `recentMatchups`/`topPerformers` use. */
  fantasyTeamId: string;
  fantasyTeamName: string;
  /** Matchup period. */
  week: number;
  /** ESPN spelling: "Out", "Questionable", "Injured Reserve", ... */
  status: string;
  /** When the tag landed (`wireEvents.observedAt`). */
  observedAt: number;
  /** That NFL game's kickoff (`nflSchedules.gameTime`). */
  kickoffAt: number;
  /** In a starting slot on that week's roster (lineupSlotId not 20/21). */
  started: boolean;
  /** Fantasy points he still scored that week, when known. */
  points?: number;
}

/** True when `observedAt` falls inside the game window: at or after kickoff, and no more than
 *  `IN_GAME_WINDOW_MS` after it (spec §16). Before kickoff is never "in-game" - that's a pre-game
 *  tag, handled by the ordinary lineup_lock/reads_the_wire rules instead. */
export function isInGameWindow(observedAt: number, kickoffAt: number): boolean {
  const delta = observedAt - kickoffAt;
  return delta >= 0 && delta <= IN_GAME_WINDOW_MS;
}

export interface InGameInjuryRosterPlayer {
  espnId: string;
  name: string;
  position?: string;
  /** ESPN lineup slot id - `isStartingSlot` decides `started` from this. */
  lineupSlotId: number;
  points?: number;
}

export interface InGameInjuryTeamRoster {
  fantasyTeamId: string;
  fantasyTeamName: string;
  players: readonly InGameInjuryRosterPlayer[];
}

/** One candidate `wireEvents` injury_status row for a player, already reduced to what the window
 *  rule needs. */
export interface InGameInjuryEventCandidate {
  observedAt: number;
  /** The card's `statusTo`. */
  status: string;
}

/**
 * Join a week's rosters against known kickoffs and injury events into the `InGameInjury[]` FACTS
 * need (spec §16). A player is included when: his NFL team's kickoff for the week is known, at
 * least one injury event on him both reads "worse than Active" and falls inside that kickoff's
 * game window, and the map lookups below resolve his NFL team.
 *
 * Pure join - every lookup is a plain `Map`/`Set` the caller (an internalQuery) has already
 * fetched from the database, so this function itself never touches `ctx.db` and is safe to unit
 * test with hand-built maps.
 */
export function buildInGameInjuries(args: {
  week: number;
  rosters: readonly InGameInjuryTeamRoster[];
  /** Player espnId -> his NFL team abbreviation, when known. */
  nflTeamByEspnId: ReadonlyMap<string, string | undefined>;
  /** NFL team abbreviation -> that team's kickoff this week, when known. */
  kickoffByNflTeam: ReadonlyMap<string, number | undefined>;
  /** Player espnId -> his candidate injury events this week (any order - the first one that both
   *  reads worse-than-Active and falls in the game window wins). */
  injuryEventsByEspnId: ReadonlyMap<string, readonly InGameInjuryEventCandidate[]>;
}): InGameInjury[] {
  const { week, rosters, nflTeamByEspnId, kickoffByNflTeam, injuryEventsByEspnId } = args;
  const hits: InGameInjury[] = [];

  for (const roster of rosters) {
    for (const player of roster.players) {
      const nflTeam = nflTeamByEspnId.get(player.espnId);
      if (!nflTeam) continue;
      const kickoffAt = kickoffByNflTeam.get(nflTeam);
      if (kickoffAt === undefined) continue;

      const events = injuryEventsByEspnId.get(player.espnId) ?? [];
      const hit = events.find((event) => isWorseThanActive(event.status) && isInGameWindow(event.observedAt, kickoffAt));
      if (!hit) continue;

      hits.push({
        espnId: player.espnId,
        name: player.name,
        position: player.position,
        nflTeam,
        fantasyTeamId: roster.fantasyTeamId,
        fantasyTeamName: roster.fantasyTeamName,
        week,
        status: hit.status,
        observedAt: hit.observedAt,
        kickoffAt,
        started: isStartingSlot(player.lineupSlotId),
        points: player.points,
      });
    }
  }

  return hits;
}
