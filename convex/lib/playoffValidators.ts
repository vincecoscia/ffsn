/**
 * Convex validators mirroring `convex/lib/playoffTypes.ts` exactly - one definition, reused by
 * every function that returns (or receives) a `PlayoffContext`: `api.matchups.getPlayoffBracket`
 * today, and any future action/query that needs to pass a bracket across a Convex function
 * boundary. Keeping this in its own file (rather than inline on the query) means the shape can
 * never drift between two call sites the way a hand-copied validator would.
 *
 * Pure - `convex/values` only, no `_generated` imports - safe to import as a value from anywhere,
 * including a plain vitest file.
 */

import { v } from "convex/values";

export const playoffModeValidator = v.union(v.literal("projected"), v.literal("live"), v.literal("final"));

export const playoffTierValidator = v.union(
  v.literal("WINNERS_BRACKET"),
  v.literal("WINNERS_CONSOLATION_LADDER"),
  v.literal("LOSERS_CONSOLATION_LADDER")
);

export const bracketTeamValidator = v.object({
  teamId: v.string(),
  name: v.string(),
  seed: v.number(),
  /** "10-4-0" */
  record: v.string(),
  pointsFor: v.number(),
});

export const bracketSideValidator = v.object({
  teamId: v.string(),
  name: v.string(),
  seed: v.optional(v.number()),
  score: v.optional(v.number()),
});

export const bracketGameStatusValidator = v.union(
  v.literal("final"),
  v.literal("live"),
  v.literal("scheduled"),
  v.literal("bye"),
  v.literal("tbd")
);

export const bracketGameValidator = v.object({
  week: v.number(),
  tier: playoffTierValidator,
  home: v.optional(bracketSideValidator),
  away: v.optional(bracketSideValidator),
  bye: v.optional(v.object({ teamId: v.string(), name: v.string(), seed: v.number() })),
  winnerTeamId: v.optional(v.string()),
  status: bracketGameStatusValidator,
});

export const bracketRoundValidator = v.object({
  week: v.number(),
  name: v.string(),
  games: v.array(bracketGameValidator),
});

export const playoffContextValidator = v.object({
  mode: playoffModeValidator,
  playoffTeamCount: v.number(),
  rounds: v.number(),
  byes: v.number(),
  playoffStartWeek: v.number(),
  championshipWeek: v.number(),
  currentRound: v.optional(v.object({ week: v.number(), name: v.string() })),
  seeds: v.array(bracketTeamValidator),
  bubble: v.array(bracketTeamValidator),
  bracket: v.array(bracketRoundValidator),
  consolation: v.array(bracketGameValidator),
  alive: v.array(v.string()),
  eliminated: v.array(v.string()),
  champion: v.optional(bracketTeamValidator),
  runnerUp: v.optional(bracketTeamValidator),
});
