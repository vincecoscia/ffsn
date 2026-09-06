import { describe, expect, it } from "vitest";
import {
  almanacLineFor,
  buildAlmanac,
  emptyAlmanac,
  type AlmanacInput,
  type AlmanacMatchupInput,
  type AlmanacTeamInput,
  type LeagueAlmanac,
} from "../src/lib/ai/almanac";

/**
 * Pure unit tests for `buildAlmanac` / `almanacLineFor` (src/lib/ai/almanac.ts). No Convex, no
 * network - plain rows in, a `LeagueAlmanac` out.
 *
 * The main fixture below is a synthetic 3-season (2021-2023), 4-team league, current season
 * 2024, hand-computed so every derived number below can be checked by hand:
 *
 *  - Alice Anderson ("Alpha Wolves") wins back-to-back titles in 2021 and 2022, trusted from the
 *    stored `champion` both times.
 *  - Bob Baker ("Bravo Blitz") wins 2023 with a losing 1-2 record (unlikely champion) - the
 *    stored `champion` for 2023 is corrupted (0-0-0 record), so the winner has to be derived
 *    from the CHAMPIONSHIP game itself.
 *  - Dave Diaz plays as "Lemon Party" in 2021 and "Dave's Dynasty" from 2022 on (a manager who
 *    changed team names), never makes the playoffs, and finishes last all three seasons; he has
 *    no team in the current (2024) season - a past manager, still in history.
 *  - Carol Chen ("Charlie Crushers") is the 2021 runner-up and never wins.
 *  - A week-4 2022 row for Carol is a bye (`awayTeamId: ""`) inside a consolation bracket, with
 *    a lopsided 91.5-0 line that would otherwise dwarf every real blowout.
 *  - 2022 and 2023 each carry a first-round draft; 2022's is mostly unsynced (1 of 4 picks has
 *    points), 2023's is mostly synced (3 of 4).
 */

const CURRENT_SEASON = 2024;

function team(
  season: number,
  externalId: string,
  name: string,
  managerKey: string,
  manager: string,
  wins: number,
  losses: number,
  ties: number,
  pointsFor: number,
  playoffSeed?: number
): AlmanacTeamInput {
  return { season, externalId, name, managerKey, manager, wins, losses, ties, pointsFor, playoffSeed };
}

function game(
  season: number,
  week: number,
  homeTeamId: string,
  awayTeamId: string | undefined,
  homeScore: number,
  awayScore: number,
  opts: { winner?: "home" | "away" | "tie"; playoffTier?: string } = {}
): AlmanacMatchupInput {
  return { season, week, homeTeamId, awayTeamId, homeScore, awayScore, ...opts };
}

const teams: AlmanacTeamInput[] = [
  // 2021 - playoffTeamCount 2: seeds 1 (alice) and 2 (carol) reach the championship.
  team(2021, "1", "Alpha Wolves", "alice", "Alice Anderson", 3, 0, 0, 330, 1),
  team(2021, "2", "Bravo Blitz", "bob", "Bob Baker", 1, 2, 0, 265, 3),
  team(2021, "3", "Charlie Crushers", "carol", "Carol Chen", 2, 1, 0, 295, 2),
  team(2021, "4", "Lemon Party", "dave", "Dave Diaz", 0, 3, 0, 240, 4),
  // 2022 - seeds 1 (alice) and 2 (bob) reach the championship.
  team(2022, "1", "Alpha Wolves", "alice", "Alice Anderson", 3, 0, 0, 320, 1),
  team(2022, "2", "Bravo Blitz", "bob", "Bob Baker", 2, 1, 0, 280, 2),
  team(2022, "3", "Charlie Crushers", "carol", "Carol Chen", 1, 2, 0, 235, 3),
  team(2022, "4", "Dave's Dynasty", "dave", "Dave Diaz", 0, 3, 0, 225, 4),
  // 2023 - no stored seeds; playoff membership comes purely from the bracket rows below.
  team(2023, "1", "Alpha Wolves", "alice", "Alice Anderson", 2, 1, 0, 287),
  team(2023, "2", "Bravo Blitz", "bob", "Bob Baker", 1, 2, 0, 283),
  team(2023, "3", "Charlie Crushers", "carol", "Carol Chen", 2, 1, 0, 284),
  team(2023, "4", "Dave's Dynasty", "dave", "Dave Diaz", 1, 2, 0, 281),
  // 2024 (current season) - Dave has left the league.
  team(2024, "1", "Alpha Wolves", "alice", "Alice Anderson", 0, 0, 0, 0),
  team(2024, "2", "Bravo Blitz", "bob", "Bob Baker", 0, 0, 0, 0),
  team(2024, "3", "Charlie Crushers", "carol", "Carol Chen", 0, 0, 0, 0),
];

const matchups: AlmanacMatchupInput[] = [
  // --- 2021 ---
  game(2021, 1, "1", "2", 110, 90),
  game(2021, 1, "3", "4", 100, 80),
  game(2021, 2, "1", "3", 115, 95),
  game(2021, 2, "2", "4", 90, 85),
  game(2021, 3, "1", "4", 105, 75),
  game(2021, 3, "3", "2", 100, 85),
  game(2021, 4, "1", "3", 120, 100, { playoffTier: "CHAMPIONSHIP" }),
  // --- 2022 ---
  game(2022, 1, "1", "3", 108, 70),
  game(2022, 1, "2", "4", 95, 90),
  game(2022, 2, "1", "4", 112, 60),
  game(2022, 2, "2", "3", 88, 85),
  game(2022, 3, "1", "2", 100, 97),
  game(2022, 3, "3", "4", 80, 75),
  game(2022, 4, "1", "2", 130, 128, { playoffTier: "CHAMPIONSHIP" }),
  // A bye into the consolation ladder - not a game, and must never read as a 91.5-point blowout.
  game(2022, 4, "3", "", 91.5, 0, { playoffTier: "LOSERS_CONSOLATION_LADDER" }),
  // --- 2023 ---
  game(2023, 1, "1", "2", 105, 95),
  game(2023, 1, "3", "4", 100, 90),
  game(2023, 2, "1", "3", 90, 85),
  game(2023, 2, "2", "4", 100, 95),
  game(2023, 3, "1", "4", 92, 96),
  game(2023, 3, "2", "3", 88, 99),
  // Bob upsets Alice for the title; the stored champion below is corrupted, so this game is the
  // only source of truth for who actually won.
  game(2023, 4, "1", "2", 100, 105, { winner: "away", playoffTier: "CHAMPIONSHIP" }),
];

const input: AlmanacInput = {
  currentSeason: CURRENT_SEASON,
  teams,
  matchups,
  seasons: [
    {
      season: 2021,
      champion: { teamId: "1", teamName: "Alpha Wolves", record: { wins: 3, losses: 0, ties: 0 }, pointsFor: 330 },
      runnerUp: { teamId: "3", teamName: "Charlie Crushers", record: { wins: 2, losses: 1, ties: 0 }, pointsFor: 295 },
      regularSeasonChampion: { teamId: "1", teamName: "Alpha Wolves", record: { wins: 3, losses: 0, ties: 0 }, pointsFor: 330 },
      playoffTeamCount: 2,
    },
    {
      season: 2022,
      champion: { teamId: "1", teamName: "Alpha Wolves", record: { wins: 3, losses: 0, ties: 0 }, pointsFor: 320 },
      runnerUp: { teamId: "2", teamName: "Bravo Blitz", record: { wins: 2, losses: 1, ties: 0 }, pointsFor: 280 },
      regularSeasonChampion: { teamId: "1", teamName: "Alpha Wolves", record: { wins: 3, losses: 0, ties: 0 }, pointsFor: 320 },
      playoffTeamCount: 2,
      draft: [
        { overallPickNumber: 1, roundId: 1, roundPickNumber: 1, teamId: 1, playerId: 601, keeper: false },
        { overallPickNumber: 2, roundId: 1, roundPickNumber: 2, teamId: 2, playerId: 602, keeper: false },
        { overallPickNumber: 3, roundId: 1, roundPickNumber: 3, teamId: 3, playerId: 603, keeper: false },
        { overallPickNumber: 4, roundId: 1, roundPickNumber: 4, teamId: 4, playerId: 604, keeper: false },
      ],
    },
    {
      season: 2023,
      // Corrupted stored champion (prod pattern: 0-0-0 record, evidently a rolled-over sync
      // artifact) - the real champion must come from the bracket, not this row.
      champion: { teamId: "99", teamName: "Ghost Team", record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0 },
      // runnerUp and regularSeasonChampion are simply absent this season - also fully derived.
      playoffTeamCount: 2,
      draft: [
        { overallPickNumber: 1, roundId: 1, roundPickNumber: 1, teamId: 4, playerId: 501, keeper: false },
        { overallPickNumber: 2, roundId: 1, roundPickNumber: 2, teamId: 3, playerId: 502, keeper: false },
        { overallPickNumber: 3, roundId: 1, roundPickNumber: 3, teamId: 2, playerId: 503, keeper: false },
        { overallPickNumber: 4, roundId: 1, roundPickNumber: 4, teamId: 1, playerId: 504, keeper: false },
      ],
    },
  ],
  players: [
    // 2022 draft: only one of four picks has synced points (25% < 60%) - no best/worst.
    { season: 2022, playerId: "601", name: "Yancy Young", pos: "RB", seasonPoints: 200 },
    { season: 2022, playerId: "602", name: "Zeke Zephyr", pos: "WR" },
    { season: 2022, playerId: "603", name: "Wade Watts", pos: "QB" },
    { season: 2022, playerId: "604", name: "Vic Vance", pos: "TE" },
    // 2023 draft: three of four have points (75% >= 60%) - best/worst computed.
    { season: 2023, playerId: "501", name: "Player A", pos: "RB", seasonPoints: 250 },
    { season: 2023, playerId: "502", name: "Player B", pos: "WR", seasonPoints: 220 },
    { season: 2023, playerId: "503", name: "Player C", pos: "QB" },
    { season: 2023, playerId: "504", name: "Player D", pos: "TE", seasonPoints: 180 },
  ],
};

describe("buildAlmanac - the empty case", () => {
  it("returns emptyAlmanac when there are no completed seasons", () => {
    expect(buildAlmanac({ currentSeason: 2025, seasons: [], teams: [], matchups: [] })).toEqual(
      emptyAlmanac(2025)
    );
  });

  it("still returns emptyAlmanac when every season is the current one (nothing completed yet)", () => {
    const preseason: AlmanacInput = {
      currentSeason: 2025,
      seasons: [{ season: 2025 }],
      teams: [team(2025, "1", "Alpha Wolves", "alice", "Alice Anderson", 0, 0, 0, 0)],
      matchups: [],
    };
    expect(buildAlmanac(preseason)).toEqual(emptyAlmanac(2025));
  });
});

describe("buildAlmanac - the main synthetic league", () => {
  const almanac = buildAlmanac(input);

  it("covers exactly the completed seasons, ascending, and finds the founding season", () => {
    expect(almanac.seasonsCovered).toEqual([2021, 2022, 2023]);
    expect(almanac.foundedSeason).toBe(2021);
    expect(almanac.currentSeason).toBe(CURRENT_SEASON);
  });

  it("trusts a valid stored champion (2021, 2022) and derives a corrupted one from the bracket (2023)", () => {
    const s2021 = almanac.seasons.find((s) => s.season === 2021)!;
    expect(s2021.champion?.manager).toBe("Alice Anderson");
    expect(s2021.champion?.team).toBe("Alpha Wolves");
    expect(s2021.runnerUp?.manager).toBe("Carol Chen");
    expect(s2021.final).toMatchObject({ winnerScore: 120, loserScore: 100, margin: 20, week: 4 });

    const s2022 = almanac.seasons.find((s) => s.season === 2022)!;
    expect(s2022.champion?.manager).toBe("Alice Anderson");
    expect(s2022.runnerUp?.manager).toBe("Bob Baker");

    // The corrupted case: the stored champion is a 0-0-0 ghost row, so Bob's real 105-100 win in
    // the CHAMPIONSHIP game is the only source of truth.
    const s2023 = almanac.seasons.find((s) => s.season === 2023)!;
    expect(s2023.champion?.manager).toBe("Bob Baker");
    expect(s2023.champion?.team).toBe("Bravo Blitz");
    expect(s2023.runnerUp?.manager).toBe("Alice Anderson");
    expect(s2023.regularSeasonChampion?.manager).toBe("Alice Anderson"); // 2-1/287 beats Carol's 2-1/284
    expect(s2023.final).toMatchObject({ winnerScore: 105, loserScore: 100, margin: 5, week: 4 });
  });

  it("flags Bob's 2023 title as unlikely - he won it with a losing regular-season record", () => {
    const s2023 = almanac.seasons.find((s) => s.season === 2023)!;
    expect(s2023.unlikelyChampion?.reason).toBe("won the title at 1-2");
  });

  it("flags a low playoff seed as unlikely too, independent of record", () => {
    const seedInput: AlmanacInput = {
      currentSeason: 2025,
      seasons: [{ season: 2024, playoffTeamCount: 6 }],
      teams: [
        team(2024, "1", "Top Dogs", "alice", "Alice Anderson", 10, 3, 0, 1500, 1),
        team(2024, "2", "Longshots", "bob", "Bob Baker", 8, 5, 0, 1400, 5),
      ],
      matchups: [game(2024, 16, "2", "1", 130, 120, { playoffTier: "CHAMPIONSHIP" })],
    };
    const seedAlmanac = buildAlmanac(seedInput);
    const s = seedAlmanac.seasons[0];
    expect(s.champion?.manager).toBe("Bob Baker");
    expect(s.unlikelyChampion?.reason).toBe("won from the No. 5 seed");
  });

  it("finds Dave's worst regular-season finish every year and never a playoff appearance", () => {
    const s2021 = almanac.seasons.find((s) => s.season === 2021)!;
    const s2022 = almanac.seasons.find((s) => s.season === 2022)!;
    const s2023 = almanac.seasons.find((s) => s.season === 2023)!;
    expect(s2021.lastPlace?.manager).toBe("Dave Diaz");
    expect(s2022.lastPlace?.manager).toBe("Dave Diaz");
    expect(s2023.lastPlace?.manager).toBe("Dave Diaz");
  });

  it("excludes the 2022 bye row from the record book entirely", () => {
    // The bye's fake 91.5-0 line would be a bigger "blowout" than anything real in this league
    // if it leaked through - the true biggest blowout is Alice's 112-60 rout of Dave in 2022.
    expect(almanac.records.biggestBlowout?.margin).toBe(52);
    expect(almanac.records.biggestBlowout?.season).toBe(2022);
    expect(almanac.records.closestGame?.margin).toBe(2); // the 2022 championship, 130-128
  });

  it("finds the highest and lowest single-week regular-season scores", () => {
    expect(almanac.records.highestScore).toMatchObject({ season: 2021, week: 2, manager: "Alice Anderson", score: 115 });
    expect(almanac.records.lowestScore).toMatchObject({ season: 2022, week: 2, manager: "Dave Diaz", score: 60 });
  });

  it("ranks best/worst regular seasons and the single-season points record by win% then points", () => {
    expect(almanac.records.bestRegularSeason).toMatchObject({ manager: "Alice Anderson", season: 2021, record: "3-0", pointsFor: 330 });
    expect(almanac.records.worstRegularSeason).toMatchObject({ manager: "Dave Diaz", season: 2022, record: "0-3", pointsFor: 225 });
    expect(almanac.records.mostPointsInASeason).toMatchObject({ manager: "Alice Anderson", season: 2021, pointsFor: 330 });
  });

  it("crowns Alice's back-to-back titles as both mostTitles and the only backToBack entry", () => {
    expect(almanac.records.mostTitles).toEqual({ manager: "Alice Anderson", count: 2, seasons: [2021, 2022] });
    expect(almanac.records.backToBack).toEqual([{ manager: "Alice Anderson", seasons: [2021, 2022] }]);
  });

  it("tracks Dave's changed team name in first-used order", () => {
    const dave = almanac.managers.find((m) => m.key === "dave")!;
    expect(dave.teamNames).toEqual(["Lemon Party", "Dave's Dynasty"]);
    expect(dave.currentTeamId).toBeUndefined(); // left the league before 2024
    expect(dave.lastPlaceFinishes).toEqual([2021, 2022, 2023]);
  });

  it("resolves the current-season roster and flags a past manager", () => {
    const alice = almanac.managers.find((m) => m.key === "alice")!;
    expect(alice.currentTeamId).toBe("T1");
    expect(alice.currentTeam).toBe("Alpha Wolves");
    expect(alice.playoffStreak).toBe(3);

    const bob = almanac.managers.find((m) => m.key === "bob")!;
    expect(bob.playoffStreak).toBe(2); // 2022, 2023 - broken by 2021

    const carol = almanac.managers.find((m) => m.key === "carol")!;
    expect(carol.playoffStreak).toBe(0); // last completed season (2023) was not a playoff year
  });

  it("computes yearsSinceTitle as completed seasons since the last title", () => {
    const alice = almanac.managers.find((m) => m.key === "alice")!;
    const bob = almanac.managers.find((m) => m.key === "bob")!;
    expect(alice.yearsSinceTitle).toBe(1); // last title 2022, current season 2024 -> 1
    expect(bob.yearsSinceTitle).toBe(0); // last title 2023, current season 2024 -> 0
  });

  it("builds the curse board", () => {
    expect(almanac.curseBoard.mostPointsNoTitle?.manager).toBe("Carol Chen");
    expect(almanac.curseBoard.longestDrought).toMatchObject({ manager: "Alice Anderson", yearsSinceTitle: 1, lastTitle: 2022 });
    expect(almanac.curseBoard.neverWon.map((m) => m.manager)).toEqual(["Carol Chen", "Dave Diaz"]);
    expect(almanac.curseBoard.neverWon[0].currentTeamId).toBeDefined(); // Carol - current managers first
    expect(almanac.curseBoard.neverWon[1].currentTeamId).toBeUndefined(); // Dave - no longer in the league
    expect(almanac.curseBoard.alwaysTheBridesmaid).toEqual({ manager: "Carol Chen", currentTeamId: "T3", runnerUps: 1 });
    expect(almanac.curseBoard.neverMadePlayoffs.map((m) => m.manager)).toEqual(["Dave Diaz"]);
    expect(almanac.curseBoard.mostLastPlaces).toMatchObject({ manager: "Dave Diaz", count: 3, seasons: [2021, 2022, 2023] });
  });

  it("finds rivalries among current managers only, excluding Dave entirely", () => {
    expect(almanac.rivalries).toHaveLength(3);
    expect(almanac.rivalries.every((r) => r.a.manager !== "Dave Diaz" && r.b.manager !== "Dave Diaz")).toBe(true);

    const byPair = (x: string, y: string) =>
      almanac.rivalries.find(
        (r) => (r.a.manager === x && r.b.manager === y) || (r.a.manager === y && r.b.manager === x)
      )!;

    const aliceBob = byPair("Alice Anderson", "Bob Baker");
    expect(aliceBob.games).toBe(5);
    const aliceBobWins = aliceBob.a.manager === "Alice Anderson" ? aliceBob.aWins : aliceBob.bWins;
    const bobWins = aliceBob.a.manager === "Bob Baker" ? aliceBob.aWins : aliceBob.bWins;
    expect(aliceBobWins).toBe(4);
    expect(bobWins).toBe(1);
    expect(aliceBob.lastMeeting).toMatchObject({ season: 2023, week: 4, winnerManager: "Bob Baker", margin: 5 });
    expect(aliceBob.currentStreak).toEqual({ manager: "Bob Baker", wins: 1 });

    const aliceCarol = byPair("Alice Anderson", "Carol Chen");
    expect(aliceCarol.games).toBe(4);
    expect(aliceCarol.currentStreak?.manager).toBe("Alice Anderson");
    expect(aliceCarol.currentStreak?.wins).toBe(4);

    const bobCarol = byPair("Bob Baker", "Carol Chen");
    expect(bobCarol.games).toBe(3);

    // Sorted by games played, descending.
    expect(almanac.rivalries.map((r) => r.games)).toEqual([5, 4, 3]);
  });

  it("builds draft receipts, applying the 60% coverage rule for best/worst", () => {
    const d2022 = almanac.drafts.find((d) => d.season === 2022)!;
    expect(d2022.firstRound).toHaveLength(4);
    // Only 1 of 4 picks has points (25%) - below the 60% floor, so no best/worst.
    expect(d2022.best).toBeUndefined();
    expect(d2022.worst).toBeUndefined();
    // The one pick with points still gets a rank.
    const yancy = d2022.firstRound.find((p) => p.player === "Yancy Young")!;
    expect(yancy.firstRoundRank).toBe(1);
    // Alice won 2022, and her own first-rounder was pick 1 (Yancy Young).
    expect(d2022.titlePick?.player).toBe("Yancy Young");

    const d2023 = almanac.drafts.find((d) => d.season === 2023)!;
    expect(d2023.firstRound).toHaveLength(4);
    // 3 of 4 picks have points (75%) - at/above the 60% floor.
    expect(d2023.best?.player).toBe("Player A"); // 250 pts, Dave's pick
    expect(d2023.worst?.player).toBe("Player D"); // 180 pts, Alice's pick
    // Bob won 2023, and his own first-rounder (Player C) never synced any points.
    expect(d2023.titlePick?.player).toBe("Player C");
    expect(d2023.titlePick?.seasonPoints).toBeUndefined();
    expect(d2023.titlePick?.teamFinish).toMatchObject({ record: "1-2", madePlayoffs: true, champion: true });

    const alicePick = d2023.firstRound.find((p) => p.player === "Player D")!;
    expect(alicePick.teamFinish).toMatchObject({ record: "2-1", madePlayoffs: true, champion: false });
  });

  it("notes the odd-sized history and the draft data's real coverage", () => {
    expect(almanac.notes).toContain("2021 was a four-team season.");
    expect(almanac.notes).toContain("2022 was a four-team season.");
    expect(almanac.notes).toContain("2023 was a four-team season.");
    expect(almanac.notes).toContain("draft data on record for 2022 and 2023 only");
  });

  it("flags a genuine two-week playoff total (2.66x average, the real 2020 prod ratio) but not a legitimate single-week explosion (1.65x, 2025's real ratio)", () => {
    // Threshold is 2.0x, not 1.6x (owner correction, measured against real prod ratios): 2021
    // (1.46x), 2022 (1.54x), 2023 (1.36x), 2024 (1.38x) and 2025 (1.65x, a real 217.6-point
    // single week) must never flag; only 2020's genuine two-week, 329-point total (2.66x) should.
    const multiWeekInput: AlmanacInput = {
      currentSeason: 2022,
      seasons: [{ season: 2021, playoffTeamCount: 2 }],
      teams: [
        team(2021, "1", "Alpha Wolves", "alice", "Alice Anderson", 2, 0, 0, 200, 1),
        team(2021, "2", "Bravo Blitz", "bob", "Bob Baker", 0, 2, 0, 180, 2),
      ],
      matchups: [
        game(2021, 1, "1", "2", 100, 90),
        game(2021, 2, "1", "2", 100, 90),
        // A two-week bracket total at 2.66x the ~95 regular-season average - must flag.
        game(2021, 3, "1", "2", 266, 250, { playoffTier: "CHAMPIONSHIP" }),
      ],
    };
    const flagged = buildAlmanac(multiWeekInput);
    expect(flagged.notes).toContain("playoff-round scores in 2021 are multi-week totals");

    const legitimateInput: AlmanacInput = {
      ...multiWeekInput,
      matchups: [
        multiWeekInput.matchups[0],
        multiWeekInput.matchups[1],
        // A big but genuine single week at 1.65x average - must never flag.
        game(2021, 3, "1", "2", 165, 150, { playoffTier: "CHAMPIONSHIP" }),
      ],
    };
    const notFlagged = buildAlmanac(legitimateInput);
    expect(notFlagged.notes).not.toContain("playoff-round scores in 2021 are multi-week totals");
  });

  it("reports no draft data when nothing was ever synced", () => {
    const undrafted = buildAlmanac({
      currentSeason: 2025,
      seasons: [{ season: 2024 }],
      teams: [team(2024, "1", "Alpha Wolves", "alice", "Alice Anderson", 5, 5, 0, 800)],
      matchups: [],
    });
    expect(undrafted.notes).toContain("no draft data on record");
  });
});

describe("curse board prefers current managers over departed ones (owner correction, 2026-09-06)", () => {
  const CURRENT = 2023;

  it("longestDrought: a current champion's shorter drought beats a departed champion's longer one", () => {
    const fixture: AlmanacInput = {
      currentSeason: CURRENT,
      seasons: [
        { season: 2020, champion: { teamId: "2", teamName: "Ryan's Ravens", record: { wins: 3, losses: 1, ties: 0 } } },
        { season: 2021, champion: { teamId: "1", teamName: "Alpha Wolves", record: { wins: 1, losses: 3, ties: 0 } } },
      ],
      teams: [
        team(2020, "1", "Alpha Wolves", "alice", "Alice Anderson", 3, 1, 0, 300),
        team(2020, "2", "Ryan's Ravens", "ryan", "Ryan Granda", 3, 1, 0, 290),
        team(2021, "1", "Alpha Wolves", "alice", "Alice Anderson", 1, 3, 0, 250),
        team(2021, "2", "Ryan's Ravens", "ryan", "Ryan Granda", 1, 3, 0, 240),
        // Ryan has left the league; only Alice has a team in the current season.
        team(CURRENT, "1", "Alpha Wolves", "alice", "Alice Anderson", 0, 0, 0, 0),
      ],
      matchups: [],
    };
    const almanac = buildAlmanac(fixture);
    // Ryan's title was 2020 (drought = 2023-2020-1 = 2); Alice's was 2021 (drought = 1). Ryan's
    // is objectively longer, but he is gone - the piece needs Alice's, the one that still means
    // something to a manager still in the league.
    expect(almanac.curseBoard.longestDrought).toMatchObject({ manager: "Alice Anderson", yearsSinceTitle: 1 });
    expect(almanac.notes).not.toContain("no current manager has won a title");
  });

  it("longestDrought: falls back to a departed champion when no current manager has ever won, and says so in notes", () => {
    const fixture: AlmanacInput = {
      currentSeason: CURRENT,
      seasons: [
        { season: 2020, champion: { teamId: "2", teamName: "Ryan's Ravens", record: { wins: 3, losses: 1, ties: 0 } } },
      ],
      teams: [
        team(2020, "1", "Gabe's Gladiators", "gabe", "Gabe Coscia", 1, 3, 0, 250),
        team(2020, "2", "Ryan's Ravens", "ryan", "Ryan Granda", 3, 1, 0, 290),
        // Only Gabe (who never won) remains; Ryan (the only champion in the league's history)
        // has left.
        team(CURRENT, "1", "Gabe's Gladiators", "gabe", "Gabe Coscia", 0, 0, 0, 0),
      ],
      matchups: [],
    };
    const almanac = buildAlmanac(fixture);
    expect(almanac.curseBoard.longestDrought).toMatchObject({ manager: "Ryan Granda", currentTeamId: undefined });
    expect(almanac.notes).toContain("no current manager has won a title");
  });

  it("mostLastPlaces: a current manager's last-place finish is surfaced over a departed manager's, even on a tied count", () => {
    const fixture: AlmanacInput = {
      currentSeason: CURRENT,
      seasons: [{ season: 2020 }, { season: 2021 }],
      teams: [
        team(2020, "1", "Cara's Crew", "cara", "Cara Current", 0, 4, 0, 200), // last place, finish 2/2
        team(2020, "2", "Erin's Eagles", "erin", "Erin Exile", 3, 1, 0, 400),
        team(2021, "1", "Cara's Crew", "cara", "Cara Current", 3, 1, 0, 400),
        team(2021, "2", "Erin's Eagles", "erin", "Erin Exile", 0, 4, 0, 200), // last place, finish 2/2
        // Cara is still in the league; Erin is gone.
        team(CURRENT, "1", "Cara's Crew", "cara", "Cara Current", 0, 0, 0, 0),
      ],
      matchups: [],
    };
    const almanac = buildAlmanac(fixture);
    // Both finish last exactly once - a tied count - but only Cara is still in the league.
    const cara = almanac.managers.find((m) => m.key === "cara")!;
    const erin = almanac.managers.find((m) => m.key === "erin")!;
    expect(cara.lastPlaceFinishes).toHaveLength(1);
    expect(erin.lastPlaceFinishes).toHaveLength(1);
    expect(almanac.curseBoard.mostLastPlaces).toMatchObject({ manager: "Cara Current", count: 1 });
  });

  it("alwaysTheBridesmaid: a current manager's runner-up finish is surfaced over a departed manager's, even on a tied count", () => {
    const fixture: AlmanacInput = {
      currentSeason: CURRENT,
      seasons: [
        {
          season: 2020,
          champion: { teamId: "3", teamName: "Champ's Champs", record: { wins: 4, losses: 0, ties: 0 } },
          runnerUp: { teamId: "1", teamName: "Cara's Crew", record: { wins: 2, losses: 2, ties: 0 } },
        },
        {
          season: 2021,
          champion: { teamId: "3", teamName: "Champ's Champs", record: { wins: 4, losses: 0, ties: 0 } },
          runnerUp: { teamId: "2", teamName: "Erin's Eagles", record: { wins: 2, losses: 2, ties: 0 } },
        },
      ],
      teams: [
        team(2020, "1", "Cara's Crew", "cara", "Cara Current", 2, 2, 0, 300),
        team(2020, "2", "Erin's Eagles", "erin", "Erin Exile", 1, 3, 0, 200),
        team(2020, "3", "Champ's Champs", "champ", "Champ Champion", 4, 0, 0, 500),
        team(2021, "1", "Cara's Crew", "cara", "Cara Current", 1, 3, 0, 200),
        team(2021, "2", "Erin's Eagles", "erin", "Erin Exile", 2, 2, 0, 300),
        team(2021, "3", "Champ's Champs", "champ", "Champ Champion", 4, 0, 0, 500),
        // Cara and Champ are still in the league; Erin is gone.
        team(CURRENT, "1", "Cara's Crew", "cara", "Cara Current", 0, 0, 0, 0),
        team(CURRENT, "3", "Champ's Champs", "champ", "Champ Champion", 0, 0, 0, 0),
      ],
      matchups: [],
    };
    const almanac = buildAlmanac(fixture);
    const cara = almanac.managers.find((m) => m.key === "cara")!;
    const erin = almanac.managers.find((m) => m.key === "erin")!;
    expect(cara.runnerUps).toHaveLength(1);
    expect(erin.runnerUps).toHaveLength(1);
    expect(almanac.curseBoard.alwaysTheBridesmaid).toMatchObject({ manager: "Cara Current", runnerUps: 1 });
  });
});

describe("almanacLineFor", () => {
  function almanacWithOneManager(manager: LeagueAlmanac["managers"][number]): LeagueAlmanac {
    return { ...emptyAlmanac(2026), managers: [manager] };
  }

  it("renders the full line: record, titles, playoff trips, best and worst season", () => {
    const almanac = almanacWithOneManager({
      key: "gabe",
      manager: "Gabe Coscia",
      seasons: 6,
      firstSeason: 2018,
      lastSeason: 2023,
      wins: 33,
      losses: 50,
      ties: 0,
      record: "33-50",
      winPct: 0.398,
      pointsFor: 9000,
      pointsPerGame: 108.4,
      titles: [],
      runnerUps: [],
      regularSeasonTitles: [],
      playoffAppearances: 6,
      playoffStreak: 0,
      lastPlaceFinishes: [],
      bestSeason: { season: 2021, team: "Lemon Party", record: "8-6", pointsFor: 1200, finish: 1, madePlayoffs: true, champion: false, runnerUp: false },
      worstSeason: { season: 2020, team: "Lemon Party", record: "3-10", pointsFor: 950, finish: 8, madePlayoffs: false, champion: false, runnerUp: false },
      teamNames: ["Lemon Party"],
      lines: [],
    });

    expect(almanacLineFor(almanac, "gabe")).toBe(
      "33-50 all-time over six seasons, no title, six playoff trips, best 8-6 in 2021 as Lemon Party, worst 3-10 in 2020"
    );
  });

  it("pluralizes titles and playoff trips correctly, and returns undefined for an unknown manager", () => {
    const almanac = almanacWithOneManager({
      key: "alice",
      manager: "Alice Anderson",
      seasons: 3,
      firstSeason: 2021,
      lastSeason: 2023,
      wins: 8,
      losses: 1,
      ties: 0,
      record: "8-1",
      winPct: 0.889,
      pointsFor: 937,
      pointsPerGame: 104.1,
      titles: [2021, 2022],
      runnerUps: [],
      regularSeasonTitles: [2021, 2022],
      playoffAppearances: 1,
      playoffStreak: 1,
      lastPlaceFinishes: [],
      teamNames: ["Alpha Wolves"],
      lines: [],
    });

    expect(almanacLineFor(almanac, "alice")).toBe(
      "8-1 all-time over three seasons, two titles (2021, 2022), one playoff trip"
    );
    expect(almanacLineFor(almanac, "nobody")).toBeUndefined();
  });
});
