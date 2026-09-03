/**
 * `PlayoffContext` fixtures for building/reviewing `PlayoffBracket` against real bracket shapes
 * before `api.matchups.getPlayoffBracket` (agent E, brief-playoffs-common.md) lands. Dev/test only -
 * not imported by any page.
 *
 * The team names, seeds, pairings and final scores reproduce the actual 2025 prod bracket recorded
 * in `brief-playoffs-common.md` (10 teams, 6 playoff teams, 3 single-week rounds: wks 15-17; seeds 1
 * and 2 bye round one; champion = seed 1 "Chodie mcgruber", runner-up = seed 3 "GLORY ASSHOLE").
 * `pointsFor` and every consolation-ladder score are illustrative filler (not pulled from ESPN) -
 * the brief didn't record those numbers, only the winners-bracket results.
 */

import type { BracketGame, BracketTeam, PlayoffContext } from "../../../../convex/lib/playoffTypes";

const SEED_1_CHODIE: BracketTeam = { teamId: "2", name: "Chodie mcgruber", seed: 1, record: "10-4-0", pointsFor: 1789.4 };
const SEED_2_STINKY: BracketTeam = { teamId: "8", name: "The Stinky Faggots", seed: 2, record: "10-4-0", pointsFor: 1654.2 };
const SEED_3_GLORY: BracketTeam = { teamId: "11", name: "GLORY ASSHOLE", seed: 3, record: "8-6-0", pointsFor: 1702.8 };
const SEED_4_IR: BracketTeam = { teamId: "3", name: "IR Squad", seed: 4, record: "8-6-0", pointsFor: 1611.3 };
const SEED_5_MOISTY: BracketTeam = { teamId: "10", name: "Moisty Loins", seed: 5, record: "7-7-0", pointsFor: 1583.7 };
const SEED_6_GAY: BracketTeam = { teamId: "12", name: "IM NOT GAY", seed: 6, record: "7-7-0", pointsFor: 1549.9 };
const SEED_7_SAGGY: BracketTeam = { teamId: "1", name: "SAGGY NUTS", seed: 7, record: "6-8-0", pointsFor: 1522.1 };
const SEED_8_RIVE: BracketTeam = { teamId: "4", name: "Team Rive", seed: 8, record: "5-9-0", pointsFor: 1498.6 };
// Non-playoff teams that only ever appear inside the losers' consolation ladder, never in
// `seeds`/`bubble` (the "next out" list is capped at 2 - see `PlayoffContext.bubble`).
const SEED_9_TUA = { teamId: "5", name: "Tua Deez Nuts" };
const SEED_10_PROLAPSED = { teamId: "6", name: "Prolapsed Peehole" };

const SEEDS: BracketTeam[] = [SEED_1_CHODIE, SEED_2_STINKY, SEED_3_GLORY, SEED_4_IR, SEED_5_MOISTY, SEED_6_GAY];
const BUBBLE: BracketTeam[] = [SEED_7_SAGGY, SEED_8_RIVE];

// --- Round 1 (week 15): seeds 1-2 bye, 3v6 and 4v5 play ---
const R1_BYE_1: BracketGame = { week: 15, tier: "WINNERS_BRACKET", bye: { teamId: SEED_1_CHODIE.teamId, name: SEED_1_CHODIE.name, seed: 1 }, status: "bye" };
const R1_BYE_2: BracketGame = { week: 15, tier: "WINNERS_BRACKET", bye: { teamId: SEED_2_STINKY.teamId, name: SEED_2_STINKY.name, seed: 2 }, status: "bye" };
const R1_GAME_3V6_FINAL: BracketGame = {
  week: 15,
  tier: "WINNERS_BRACKET",
  home: { teamId: SEED_3_GLORY.teamId, name: SEED_3_GLORY.name, seed: 3, score: 127.12 },
  away: { teamId: SEED_6_GAY.teamId, name: SEED_6_GAY.name, seed: 6, score: 120.16 },
  winnerTeamId: SEED_3_GLORY.teamId,
  status: "final",
};
const R1_GAME_4V5_FINAL: BracketGame = {
  week: 15,
  tier: "WINNERS_BRACKET",
  home: { teamId: SEED_5_MOISTY.teamId, name: SEED_5_MOISTY.name, seed: 5, score: 145.2 },
  away: { teamId: SEED_4_IR.teamId, name: SEED_4_IR.name, seed: 4, score: 115.1 },
  winnerTeamId: SEED_5_MOISTY.teamId,
  status: "final",
};
const R1_GAME_3V6_SCHEDULED: BracketGame = {
  week: 15,
  tier: "WINNERS_BRACKET",
  home: { teamId: SEED_3_GLORY.teamId, name: SEED_3_GLORY.name, seed: 3 },
  away: { teamId: SEED_6_GAY.teamId, name: SEED_6_GAY.name, seed: 6 },
  status: "scheduled",
};
const R1_GAME_4V5_SCHEDULED: BracketGame = {
  week: 15,
  tier: "WINNERS_BRACKET",
  home: { teamId: SEED_4_IR.teamId, name: SEED_4_IR.name, seed: 4 },
  away: { teamId: SEED_5_MOISTY.teamId, name: SEED_5_MOISTY.name, seed: 5 },
  status: "scheduled",
};

// --- Round 2 / Semifinals (week 16): the two byes meet the two round-one winners ---
const R2_GAME_CHODIE_MOISTY_FINAL: BracketGame = {
  week: 16,
  tier: "WINNERS_BRACKET",
  home: { teamId: SEED_1_CHODIE.teamId, name: SEED_1_CHODIE.name, seed: 1, score: 187.32 },
  away: { teamId: SEED_5_MOISTY.teamId, name: SEED_5_MOISTY.name, seed: 5, score: 171.86 },
  winnerTeamId: SEED_1_CHODIE.teamId,
  status: "final",
};
const R2_GAME_GLORY_STINKY_FINAL: BracketGame = {
  week: 16,
  tier: "WINNERS_BRACKET",
  home: { teamId: SEED_3_GLORY.teamId, name: SEED_3_GLORY.name, seed: 3, score: 143.48 },
  away: { teamId: SEED_2_STINKY.teamId, name: SEED_2_STINKY.name, seed: 2, score: 137.2 },
  winnerTeamId: SEED_3_GLORY.teamId,
  status: "final",
};

// --- Round 3 / Championship (week 17) ---
const R3_CHAMPIONSHIP_FINAL: BracketGame = {
  week: 17,
  tier: "WINNERS_BRACKET",
  home: { teamId: SEED_1_CHODIE.teamId, name: SEED_1_CHODIE.name, seed: 1, score: 139.38 },
  away: { teamId: SEED_3_GLORY.teamId, name: SEED_3_GLORY.name, seed: 3, score: 96.66 },
  winnerTeamId: SEED_1_CHODIE.teamId,
  status: "final",
};
const R3_CHAMPIONSHIP_LIVE: BracketGame = {
  week: 17,
  tier: "WINNERS_BRACKET",
  home: { teamId: SEED_1_CHODIE.teamId, name: SEED_1_CHODIE.name, seed: 1, score: 41.2 },
  away: { teamId: SEED_3_GLORY.teamId, name: SEED_3_GLORY.name, seed: 3, score: 38.6 },
  status: "live",
};

// --- Consolation ladders (illustrative scores; brief only recorded the winners bracket) ---
const CONSOLATION_LIVE_AND_FINAL: BracketGame[] = [
  {
    week: 16,
    tier: "WINNERS_CONSOLATION_LADDER",
    home: { teamId: SEED_4_IR.teamId, name: SEED_4_IR.name, seed: 4, score: 98.4 },
    away: { teamId: SEED_6_GAY.teamId, name: SEED_6_GAY.name, seed: 6, score: 91.7 },
    winnerTeamId: SEED_4_IR.teamId,
    status: "final",
  },
  {
    week: 17,
    tier: "WINNERS_CONSOLATION_LADDER",
    home: { teamId: SEED_2_STINKY.teamId, name: SEED_2_STINKY.name, seed: 2, score: 110.5 },
    away: { teamId: SEED_5_MOISTY.teamId, name: SEED_5_MOISTY.name, seed: 5, score: 104.9 },
    winnerTeamId: SEED_2_STINKY.teamId,
    status: "final",
  },
  {
    week: 15,
    tier: "LOSERS_CONSOLATION_LADDER",
    home: { teamId: SEED_7_SAGGY.teamId, name: SEED_7_SAGGY.name, score: 92.6 },
    away: { teamId: SEED_8_RIVE.teamId, name: SEED_8_RIVE.name, score: 85.1 },
    winnerTeamId: SEED_7_SAGGY.teamId,
    status: "final",
  },
  {
    week: 15,
    tier: "LOSERS_CONSOLATION_LADDER",
    home: { teamId: SEED_9_TUA.teamId, name: SEED_9_TUA.name, score: 87.3 },
    away: { teamId: SEED_10_PROLAPSED.teamId, name: SEED_10_PROLAPSED.name, score: 79.8 },
    winnerTeamId: SEED_9_TUA.teamId,
    status: "final",
  },
];

/** Regular season, week 12 of 14: the field "if the season ended today". */
export const playoffBracketFixtureProjected: PlayoffContext = {
  mode: "projected",
  playoffTeamCount: 6,
  rounds: 3,
  byes: 2,
  playoffStartWeek: 15,
  championshipWeek: 17,
  seeds: SEEDS,
  bubble: BUBBLE,
  bracket: [
    {
      week: 15,
      name: "Round 1",
      games: [R1_BYE_1, R1_BYE_2, R1_GAME_3V6_SCHEDULED, R1_GAME_4V5_SCHEDULED],
    },
  ],
  consolation: [],
  alive: [],
  eliminated: [],
};

/** Mid-playoffs: round one and the semifinals are final, the championship is being played right now. */
export const playoffBracketFixtureLive: PlayoffContext = {
  mode: "live",
  playoffTeamCount: 6,
  rounds: 3,
  byes: 2,
  playoffStartWeek: 15,
  championshipWeek: 17,
  currentRound: { week: 17, name: "Championship" },
  seeds: SEEDS,
  bubble: [],
  bracket: [
    { week: 15, name: "Round 1", games: [R1_BYE_1, R1_BYE_2, R1_GAME_3V6_FINAL, R1_GAME_4V5_FINAL] },
    { week: 16, name: "Semifinals", games: [R2_GAME_CHODIE_MOISTY_FINAL, R2_GAME_GLORY_STINKY_FINAL] },
    { week: 17, name: "Championship", games: [R3_CHAMPIONSHIP_LIVE] },
  ],
  consolation: CONSOLATION_LIVE_AND_FINAL,
  alive: [SEED_1_CHODIE.teamId, SEED_3_GLORY.teamId],
  eliminated: [SEED_2_STINKY.teamId, SEED_5_MOISTY.teamId, SEED_4_IR.teamId, SEED_6_GAY.teamId],
};

/** The decided 2025 bracket: champion Chodie mcgruber (seed 1), runner-up GLORY ASSHOLE (seed 3). */
export const playoffBracketFixtureFinal: PlayoffContext = {
  mode: "final",
  playoffTeamCount: 6,
  rounds: 3,
  byes: 2,
  playoffStartWeek: 15,
  championshipWeek: 17,
  seeds: SEEDS,
  bubble: [],
  bracket: [
    { week: 15, name: "Round 1", games: [R1_BYE_1, R1_BYE_2, R1_GAME_3V6_FINAL, R1_GAME_4V5_FINAL] },
    { week: 16, name: "Semifinals", games: [R2_GAME_CHODIE_MOISTY_FINAL, R2_GAME_GLORY_STINKY_FINAL] },
    { week: 17, name: "Championship", games: [R3_CHAMPIONSHIP_FINAL] },
  ],
  consolation: CONSOLATION_LIVE_AND_FINAL,
  alive: [],
  eliminated: [SEED_2_STINKY.teamId, SEED_5_MOISTY.teamId, SEED_4_IR.teamId, SEED_6_GAY.teamId, SEED_3_GLORY.teamId],
  champion: SEED_1_CHODIE,
  runnerUp: SEED_3_GLORY,
};

/** Pre-draft / no-results-yet: `PlayoffBracket` reads an empty `seeds` array as "not started". */
export const playoffBracketFixtureEmpty: PlayoffContext = {
  mode: "projected",
  playoffTeamCount: 6,
  rounds: 3,
  byes: 2,
  playoffStartWeek: 15,
  championshipWeek: 17,
  seeds: [],
  bubble: [],
  bracket: [],
  consolation: [],
  alive: [],
  eliminated: [],
};
