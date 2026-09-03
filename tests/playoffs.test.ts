/**
 * `convex/lib/playoffs.ts` - pure functions, no Convex runtime needed.
 *
 * Fixture is the real 2025 prod bracket (10 teams, 6 playoff teams, 3 single-week rounds -
 * playoffStartWeek 15, championship week 17), from the playoffs-round common brief's audit of
 * `jn74dn16bts1gg94596srgsvh17nevtq`:
 *   wk15 WINNERS_BRACKET: byes for seed 1 (Chodie mcgruber, "2") and seed 2 (The Stinky Faggots,
 *     "8"); GLORY ASSHOLE ("11", seed 3) beat IM NOT GAY ("12", seed 6) 127.12-120.16; Moisty
 *     Loins ("10", seed 5) beat IR Squad ("3", seed 4) 145.2-115.1.
 *   wk16 WINNERS_BRACKET: "2" beat "10" 187.32-171.86; "11" beat "8" 143.48-137.2.
 *   wk17 WINNERS_BRACKET (championship): "2" beat "11" 139.38-96.66.
 * Byes are stored as real matchup rows with `awayTeamId: ""` - never recognised anywhere in the
 * app before this module (see `convex/lib/playoffs.ts`'s header comment).
 */
import { describe, expect, it } from "vitest";
import {
  buildPlayoffContext,
  deriveSeasonResults,
  isByeMatchup,
  isCorruptedSeasonResult,
  highestFinishedMatchupPeriod,
  playoffRoundName,
  type BuildPlayoffContextInput,
  type PlayoffMatchupInput,
  type PlayoffStandingRow,
  type PlayoffTeamInput,
} from "../convex/lib/playoffs";

// Seeds 1-6 are the playoff field; 7-10 missed it. ESPN externalIds (never the same as the seed
// number) come straight from the common brief's audit.
const CHODIE = "2"; // seed 1
const STINKY = "8"; // seed 2
const GLORY = "11"; // seed 3
const IR_SQUAD = "3"; // seed 4
const MOISTY = "10"; // seed 5
const IM_NOT_GAY = "12"; // seed 6
const SAGGY = "1"; // seed 7
const RIVE = "4"; // seed 8
const TUA = "5"; // seed 9
const PROLAPSED = "6"; // seed 10

function team(externalId: string, name: string, seed: number, wins: number, losses: number, pointsFor: number): PlayoffTeamInput {
  return { externalId, name, record: { wins, losses, ties: 0, pointsFor, playoffSeed: seed } };
}

const TEAMS: PlayoffTeamInput[] = [
  team(CHODIE, "Chodie mcgruber", 1, 10, 4, 1600),
  team(STINKY, "The Stinky Faggots", 2, 10, 4, 1580),
  team(GLORY, "GLORY ASSHOLE", 3, 8, 6, 1550),
  team(IR_SQUAD, "IR Squad", 4, 8, 6, 1530),
  team(MOISTY, "Moisty Loins", 5, 7, 7, 1500),
  team(IM_NOT_GAY, "IM NOT GAY", 6, 7, 7, 1480),
  team(SAGGY, "SAGGY NUTS", 7, 6, 8, 1450),
  team(RIVE, "Team Rive", 8, 5, 9, 1420),
  team(TUA, "Tua Deez Nuts", 9, 4, 10, 1400),
  team(PROLAPSED, "Prolapsed Peehole", 10, 3, 11, 1380),
];

const MATCHUPS: PlayoffMatchupInput[] = [
  // Week 15 - round one (Quarterfinals): two byes, two real games.
  { matchupPeriod: 15, homeTeamId: CHODIE, awayTeamId: "", homeScore: 130.5, awayScore: 0, playoffTier: "WINNERS_BRACKET" },
  { matchupPeriod: 15, homeTeamId: STINKY, awayTeamId: "", homeScore: 128.0, awayScore: 0, playoffTier: "WINNERS_BRACKET" },
  {
    matchupPeriod: 15,
    homeTeamId: GLORY,
    awayTeamId: IM_NOT_GAY,
    homeScore: 127.12,
    awayScore: 120.16,
    winner: "home",
    playoffTier: "WINNERS_BRACKET",
  },
  {
    matchupPeriod: 15,
    homeTeamId: MOISTY,
    awayTeamId: IR_SQUAD,
    homeScore: 145.2,
    awayScore: 115.1,
    winner: "home",
    playoffTier: "WINNERS_BRACKET",
  },
  // Week 15 consolation: the four non-playoff teams play their own ladder.
  {
    matchupPeriod: 15,
    homeTeamId: SAGGY,
    awayTeamId: RIVE,
    homeScore: 95.4,
    awayScore: 88.2,
    winner: "home",
    playoffTier: "LOSERS_CONSOLATION_LADDER",
  },
  {
    matchupPeriod: 15,
    homeTeamId: TUA,
    awayTeamId: PROLAPSED,
    homeScore: 90.1,
    awayScore: 101.3,
    winner: "away",
    playoffTier: "LOSERS_CONSOLATION_LADDER",
  },

  // Week 16 - round two (Semifinals): the bracket reseeds by surviving seed (1v5, 2v3), not a
  // fixed bracket slot - see `pairAdvancing`'s header comment.
  {
    matchupPeriod: 16,
    homeTeamId: CHODIE,
    awayTeamId: MOISTY,
    homeScore: 187.32,
    awayScore: 171.86,
    winner: "home",
    playoffTier: "WINNERS_BRACKET",
  },
  {
    matchupPeriod: 16,
    homeTeamId: GLORY,
    awayTeamId: STINKY,
    homeScore: 143.48,
    awayScore: 137.2,
    winner: "home",
    playoffTier: "WINNERS_BRACKET",
  },
  // Week 16 consolation: the two week-15 winners-bracket losers play for 5th.
  {
    matchupPeriod: 16,
    homeTeamId: IM_NOT_GAY,
    awayTeamId: IR_SQUAD,
    homeScore: 100.0,
    awayScore: 92.5,
    winner: "home",
    playoffTier: "WINNERS_CONSOLATION_LADDER",
  },

  // Week 17 - round three (Championship).
  {
    matchupPeriod: 17,
    homeTeamId: CHODIE,
    awayTeamId: GLORY,
    homeScore: 139.38,
    awayScore: 96.66,
    winner: "home",
    playoffTier: "WINNERS_BRACKET",
  },
];

const FORMAT = { playoffTeamCount: 6, regularSeasonMatchupPeriods: 14, playoffMatchupPeriodLength: 1 };

function baseInput(throughWeek: number): BuildPlayoffContextInput {
  return { teams: TEAMS, matchups: MATCHUPS, format: FORMAT, throughWeek };
}

describe("isByeMatchup", () => {
  it("recognises an empty side as a bye, either side", () => {
    expect(isByeMatchup({ homeTeamId: CHODIE, awayTeamId: "" })).toBe(true);
    expect(isByeMatchup({ homeTeamId: "", awayTeamId: CHODIE })).toBe(true);
  });

  it("is false for a real game", () => {
    expect(isByeMatchup({ homeTeamId: GLORY, awayTeamId: IM_NOT_GAY })).toBe(false);
  });
});

describe("bye-aware week finality (regression: a bye row must not read as an unfinished game)", () => {
  it("a week of only byes has no real matchups", () => {
    const byeOnlyWeek = [
      { homeTeamId: CHODIE, awayTeamId: "" },
      { homeTeamId: STINKY, awayTeamId: "" },
    ];
    expect(byeOnlyWeek.every(isByeMatchup)).toBe(true);
    expect(byeOnlyWeek.filter((m) => !isByeMatchup(m))).toHaveLength(0);
  });

  it("week 15's real (non-bye) games are all decided in the fixture", () => {
    const week15WinnersBracket = MATCHUPS.filter((m) => m.matchupPeriod === 15 && m.playoffTier === "WINNERS_BRACKET");
    expect(week15WinnersBracket).toHaveLength(4); // 2 byes + 2 games
    const realGames = week15WinnersBracket.filter((m) => !isByeMatchup(m));
    expect(realGames).toHaveLength(2);
    expect(realGames.every((m) => m.winner !== undefined)).toBe(true);
  });
});

describe("playoffRoundName", () => {
  it("names from the championship backward regardless of total rounds", () => {
    expect(playoffRoundName(0, 3)).toBe("Quarterfinals");
    expect(playoffRoundName(1, 3)).toBe("Semifinals");
    expect(playoffRoundName(2, 3)).toBe("Championship");

    expect(playoffRoundName(0, 2)).toBe("Semifinals");
    expect(playoffRoundName(1, 2)).toBe("Championship");

    expect(playoffRoundName(0, 4)).toBe("Round 1");
    expect(playoffRoundName(1, 4)).toBe("Quarterfinals");
    expect(playoffRoundName(2, 4)).toBe("Semifinals");
    expect(playoffRoundName(3, 4)).toBe("Championship");

    expect(playoffRoundName(0, 1)).toBe("Championship");
  });
});

describe("buildPlayoffContext - projected mode (before the playoffs)", () => {
  const WEEK10_STANDINGS: PlayoffStandingRow[] = [
    { externalId: CHODIE, wins: 7, losses: 3, ties: 0, pointsFor: 1150, rank: 1 },
    { externalId: STINKY, wins: 7, losses: 3, ties: 0, pointsFor: 1130, rank: 2 },
    { externalId: GLORY, wins: 6, losses: 4, ties: 0, pointsFor: 1100, rank: 3 },
    { externalId: IR_SQUAD, wins: 6, losses: 4, ties: 0, pointsFor: 1080, rank: 4 },
    { externalId: MOISTY, wins: 5, losses: 5, ties: 0, pointsFor: 1050, rank: 5 },
    { externalId: IM_NOT_GAY, wins: 5, losses: 5, ties: 0, pointsFor: 1030, rank: 6 },
    { externalId: SAGGY, wins: 4, losses: 6, ties: 0, pointsFor: 1000, rank: 7 },
    { externalId: RIVE, wins: 4, losses: 6, ties: 0, pointsFor: 980, rank: 8 },
    { externalId: TUA, wins: 3, losses: 7, ties: 0, pointsFor: 950, rank: 9 },
    { externalId: PROLAPSED, wins: 2, losses: 8, ties: 0, pointsFor: 930, rank: 10 },
  ];

  const projected = buildPlayoffContext({
    teams: TEAMS,
    matchups: MATCHUPS,
    format: FORMAT,
    throughWeek: 10,
    standings: WEEK10_STANDINGS,
  });

  it("is a projection with the top 6 seeded and the next two on the bubble", () => {
    expect(projected.mode).toBe("projected");
    expect(projected.playoffStartWeek).toBe(15);
    expect(projected.championshipWeek).toBe(17);
    expect(projected.seeds.map((s) => s.teamId)).toEqual([CHODIE, STINKY, GLORY, IR_SQUAD, MOISTY, IM_NOT_GAY]);
    expect(projected.bubble.map((b) => b.teamId)).toEqual([SAGGY, RIVE]);
    expect(projected.consolation).toEqual([]);
    expect(projected.alive).toEqual([]);
    expect(projected.eliminated).toEqual([]);
    expect(projected.champion).toBeUndefined();
  });

  it("rests seeds 1-2 and pairs the rest 3v6 and 4v5, unplayed", () => {
    expect(projected.bracket).toHaveLength(1);
    const round1 = projected.bracket[0];
    expect(round1.name).toBe("Quarterfinals");

    const byeTeamIds = round1.games.filter((g) => g.bye).map((g) => g.bye!.teamId).sort();
    expect(byeTeamIds).toEqual([CHODIE, STINKY].sort());

    const pairingGames = round1.games.filter((g) => g.home && g.away);
    expect(pairingGames).toHaveLength(2);
    const seed3Game = pairingGames.find((g) => g.home!.seed === 3)!;
    expect(seed3Game.away!.seed).toBe(6);
    expect(seed3Game.status).toBe("scheduled");
    expect(seed3Game.home!.score).toBeUndefined();
    const seed4Game = pairingGames.find((g) => g.home!.seed === 4)!;
    expect(seed4Game.away!.seed).toBe(5);
  });
});

describe("buildPlayoffContext - the regular-season-end boundary (throughWeek === regularSeasonMatchupPeriods)", () => {
  it("is live (not projected) the moment the regular season ends, with a real locked round-one bracket even though no playoff row exists yet", () => {
    const live14 = buildPlayoffContext(baseInput(14)); // 14 = FORMAT.regularSeasonMatchupPeriods

    expect(live14.mode).toBe("live");
    expect(live14.seeds.map((s) => s.teamId)).toEqual([CHODIE, STINKY, GLORY, IR_SQUAD, MOISTY, IM_NOT_GAY]);
    expect(live14.bubble).toEqual([]); // bubble is a projected-mode-only field
    expect(live14.consolation).toEqual([]);
    expect(live14.alive).toEqual([CHODIE, STINKY, GLORY, IR_SQUAD, MOISTY, IM_NOT_GAY]); // nothing played yet
    expect(live14.eliminated).toEqual([]);
    expect(live14.champion).toBeUndefined();
    expect(live14.currentRound).toEqual({ week: 15, name: "Quarterfinals" });

    // Locked seeds produce a real round-one slate (byes + pairings), the same shape a projection
    // shows - it's just no longer a projection, since the regular season (and thus the seeding) is
    // done. Later rounds are still just TBD - the round-one games themselves haven't been played.
    const round1 = live14.bracket[0].games;
    const byeTeamIds = round1.filter((g) => g.bye).map((g) => g.bye!.teamId).sort();
    expect(byeTeamIds).toEqual([CHODIE, STINKY].sort());
    const pairingGames = round1.filter((g) => g.home && g.away);
    expect(pairingGames).toHaveLength(2);
    expect(pairingGames.every((g) => g.status === "scheduled")).toBe(true);
    expect(live14.bracket[1].games.every((g) => g.status === "tbd")).toBe(true);
  });

  it("is still projected one week earlier (throughWeek 13)", () => {
    const projected13 = buildPlayoffContext(baseInput(13));
    expect(projected13.mode).toBe("projected");
  });
});

describe("buildPlayoffContext - live mode", () => {
  it("after week 15: byes rest, the two round-one games are decided, round two reseeds the survivors, the championship is still TBD", () => {
    const live15 = buildPlayoffContext(baseInput(15));

    expect(live15.mode).toBe("live");
    expect(live15.currentRound).toEqual({ week: 15, name: "Quarterfinals" });
    expect(new Set(live15.alive)).toEqual(new Set([CHODIE, STINKY, GLORY, MOISTY]));
    expect(new Set(live15.eliminated)).toEqual(new Set([IM_NOT_GAY, IR_SQUAD]));
    expect(live15.champion).toBeUndefined();

    expect(live15.bracket[0].games).toHaveLength(4);

    // Round one is fully decided, so round two's pairing is already knowable (ESPN reseeds by
    // surviving seed - ties out to 1v5 and 2v3 here) even though week 16 hasn't started: shown as
    // "scheduled", not a bare TBD slot.
    const round2 = live15.bracket[1].games;
    expect(round2).toHaveLength(2);
    expect(round2.every((g) => g.status === "scheduled")).toBe(true);
    const seed1Game = round2.find((g) => g.home?.seed === 1 || g.away?.seed === 1)!;
    expect([seed1Game.home?.teamId, seed1Game.away?.teamId].sort()).toEqual([CHODIE, MOISTY].sort());
    const seed2Game = round2.find((g) => g.home?.seed === 2 || g.away?.seed === 2)!;
    expect([seed2Game.home?.teamId, seed2Game.away?.teamId].sort()).toEqual([STINKY, GLORY].sort());

    // The championship can't be known yet - round two itself hasn't been played.
    expect(live15.bracket[2].games).toHaveLength(1);
    expect(live15.bracket[2].games[0].status).toBe("tbd");

    // Week 15's consolation ladder is in, byes are not consolation games.
    expect(live15.consolation).toHaveLength(2);
    expect(live15.consolation.every((g) => g.tier === "LOSERS_CONSOLATION_LADDER")).toBe(true);
  });

  it("after week 16: the semifinals are decided and the championship pairing is knowable before ESPN posts week 17", () => {
    const live16 = buildPlayoffContext(baseInput(16));

    expect(live16.mode).toBe("live");
    expect(live16.currentRound).toEqual({ week: 16, name: "Semifinals" });
    expect(new Set(live16.alive)).toEqual(new Set([CHODIE, GLORY]));
    expect(new Set(live16.eliminated)).toEqual(new Set([IM_NOT_GAY, IR_SQUAD, STINKY, MOISTY]));

    const championshipSlot = live16.bracket[2].games[0];
    expect(championshipSlot.status).toBe("scheduled");
    expect(championshipSlot.home?.teamId).toBe(CHODIE);
    expect(championshipSlot.away?.teamId).toBe(GLORY);
    expect(live16.champion).toBeUndefined();
  });
});

describe("buildPlayoffContext / deriveSeasonResults - final mode", () => {
  const final = buildPlayoffContext(baseInput(17));

  it("crowns the champion once the championship game is decided", () => {
    expect(final.mode).toBe("final");
    expect(final.currentRound).toEqual({ week: 17, name: "Championship" });
    expect(final.champion?.teamId).toBe(CHODIE);
    expect(final.champion?.name).toBe("Chodie mcgruber");
    expect(final.runnerUp?.teamId).toBe(GLORY);
    expect(final.seeds[0].teamId).toBe(CHODIE); // regular-season champion = seed 1
  });

  it("deriveSeasonResults matches the bracket exactly", () => {
    const derived = deriveSeasonResults(baseInput(17));
    expect(derived.champion?.teamId).toBe(CHODIE);
    expect(derived.runnerUp?.teamId).toBe(GLORY);
    expect(derived.regularSeasonChampion?.teamId).toBe(CHODIE);
  });

  it("is undefined before the championship has been played", () => {
    expect(deriveSeasonResults(baseInput(16))).toEqual({});
    expect(deriveSeasonResults(baseInput(10))).toEqual({});
  });
});

describe("buildPlayoffContext - rounds and byes for other field sizes", () => {
  it("a 4-team playoff field is 2 rounds with no byes", () => {
    const ctx = buildPlayoffContext({
      teams: TEAMS.slice(0, 4),
      matchups: [],
      format: { playoffTeamCount: 4, regularSeasonMatchupPeriods: 10, playoffMatchupPeriodLength: 1 },
      throughWeek: 5, // projected - only the static fields matter here
    });
    expect(ctx.rounds).toBe(2);
    expect(ctx.byes).toBe(0);
    expect(ctx.playoffStartWeek).toBe(11);
    expect(ctx.championshipWeek).toBe(12);
  });

  it("an 8-team playoff field is 3 rounds with no byes", () => {
    const ctx = buildPlayoffContext({
      teams: TEAMS.slice(0, 8),
      matchups: [],
      format: { playoffTeamCount: 8, regularSeasonMatchupPeriods: 12, playoffMatchupPeriodLength: 1 },
      throughWeek: 5,
    });
    expect(ctx.rounds).toBe(3);
    expect(ctx.byes).toBe(0);
    expect(ctx.playoffStartWeek).toBe(13);
    expect(ctx.championshipWeek).toBe(15);
  });
});

describe("highestFinishedMatchupPeriod", () => {
  it("is the highest matchupPeriod with a winner, 0 when nothing has finished", () => {
    expect(highestFinishedMatchupPeriod(MATCHUPS)).toBe(17);
    expect(highestFinishedMatchupPeriod([{ matchupPeriod: 3, winner: undefined }])).toBe(0);
    expect(highestFinishedMatchupPeriod([])).toBe(0);
  });
});

describe("isCorruptedSeasonResult", () => {
  it("flags a 0-0-0 record or an Unknown owner as corrupted (spec: prod's rolled-over 2025 champion)", () => {
    expect(isCorruptedSeasonResult({ owner: "Unknown", record: { wins: 0, losses: 0, ties: 0 } })).toBe(true);
    expect(isCorruptedSeasonResult({ owner: "Real Person", record: { wins: 0, losses: 0, ties: 0 } })).toBe(true);
    expect(isCorruptedSeasonResult({ owner: "Unknown", record: { wins: 10, losses: 4, ties: 0 } })).toBe(true);
  });

  it("passes a real, decided result", () => {
    expect(isCorruptedSeasonResult({ owner: "Real Person", record: { wins: 10, losses: 4, ties: 0 } })).toBe(false);
  });

  it("is false for an absent entry (nothing stored yet is not 'corrupted')", () => {
    expect(isCorruptedSeasonResult(undefined)).toBe(false);
    expect(isCorruptedSeasonResult(null)).toBe(false);
  });
});
