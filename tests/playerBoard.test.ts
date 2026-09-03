/**
 * `convex/lib/playerBoard.ts` - pure functions, no Convex runtime needed.
 *
 * Covers: the season_points/upcoming_projection basis switch (owner directive - week 1 goes on
 * projections, everything after goes on stats to date), tie-breaking by name, "D/ST" vs "DST"
 * normalisation, the draftPick join, and the per-matchup `topKeyPlayers`/`sumStarterProjected`
 * helpers the preview slate uses (brief K, brief-preview-common.md's shared contract).
 */
import { describe, expect, it } from "vitest";
import {
  buildPlayerBoard,
  normalizePosition,
  sumStarterProjected,
  topKeyPlayers,
  type BuildPlayerBoardInput,
  type PlayerBoardLineupPlayer,
  type PlayerBoardMatchupInput,
  type PlayerBoardTeamInput,
} from "../convex/lib/playerBoard";

const TEAM_A = "1";
const TEAM_B = "2";

function lineupPlayer(
  espnId: number,
  fullName: string,
  position: string,
  points: number,
  projectedPoints: number | undefined,
  lineupSlotId: number
): PlayerBoardLineupPlayer {
  return { espnId, fullName, position, points, projectedPoints, lineupSlotId };
}

function matchup(
  matchupPeriod: number,
  homeTeamId: string,
  awayTeamId: string,
  homePlayers: PlayerBoardLineupPlayer[],
  awayPlayers: PlayerBoardLineupPlayer[]
): PlayerBoardMatchupInput {
  return {
    matchupPeriod,
    homeTeamId,
    awayTeamId,
    homeRoster: { players: homePlayers },
    awayRoster: { players: awayPlayers },
  };
}

const TEAMS: PlayerBoardTeamInput[] = [
  {
    externalId: TEAM_A,
    name: "Team A",
    roster: [
      { playerId: "101", playerName: "QB One", position: "QB" },
      { playerId: "102", playerName: "RB One", position: "RB" },
      { playerId: "103", playerName: "RB Two", position: "RB" },
      { playerId: "104", playerName: "Defense A", position: "D/ST" },
    ],
  },
  {
    externalId: TEAM_B,
    name: "Team B",
    roster: [
      { playerId: "201", playerName: "QB Two", position: "QB" },
      { playerId: "202", playerName: "RB Three", position: "RB" },
      { playerId: "203", playerName: "RB Four (tie)", position: "RB" },
      { playerId: "204", playerName: "Defense B", position: "DST" },
    ],
  },
];

describe("buildPlayerBoard - basis switch", () => {
  it("uses upcoming_projection before any week has been played (throughWeek 0)", () => {
    const upcoming: PlayerBoardMatchupInput[] = [
      matchup(
        1,
        TEAM_A,
        TEAM_B,
        [
          lineupPlayer(101, "QB One", "QB", 0, 22.5, 0),
          lineupPlayer(102, "RB One", "RB", 0, 15, 2),
          lineupPlayer(103, "RB Two", "RB", 0, 5, 20), // bench
        ],
        [
          lineupPlayer(201, "QB Two", "QB", 0, 18, 0),
          lineupPlayer(202, "RB Three", "RB", 0, 20, 2),
          lineupPlayer(203, "RB Four (tie)", "RB", 0, 5, 20), // bench
        ]
      ),
    ];
    const input: BuildPlayerBoardInput = {
      teams: TEAMS,
      playedMatchups: [],
      upcomingMatchups: upcoming,
      draftPicks: [],
      throughWeek: 0,
    };

    const board = buildPlayerBoard(input);
    expect(board.basis).toBe("upcoming_projection");
    expect(board.throughWeek).toBe(0);

    const rb1 = board.entries.find((e) => e.playerId === "102")!;
    const rb3 = board.entries.find((e) => e.playerId === "202")!;
    // RB Three (20 projected) outranks RB One (15 projected) on the projection basis.
    expect(rb3.positionRank).toBe(1);
    expect(rb1.positionRank).toBe(2);
    expect(rb1.lineup).toBe("starter");
    expect(rb1.upcomingProjected).toBe(15);

    // Bench players get no upcomingProjected even though ESPN reports a projection for them.
    const rb2 = board.entries.find((e) => e.playerId === "103")!;
    expect(rb2.lineup).toBe("bench");
    expect(rb2.upcomingProjected).toBeUndefined();
  });

  it("uses season_points once at least one week has been played", () => {
    const played: PlayerBoardMatchupInput[] = [
      matchup(
        1,
        TEAM_A,
        TEAM_B,
        [lineupPlayer(101, "QB One", "QB", 20, 18, 0), lineupPlayer(102, "RB One", "RB", 10, 12, 2)],
        [lineupPlayer(201, "QB Two", "QB", 30, 25, 0), lineupPlayer(202, "RB Three", "RB", 5, 8, 2)]
      ),
    ];
    const input: BuildPlayerBoardInput = {
      teams: TEAMS,
      playedMatchups: played,
      upcomingMatchups: [],
      draftPicks: [],
      throughWeek: 1,
    };

    const board = buildPlayerBoard(input);
    expect(board.basis).toBe("season_points");
    expect(board.throughWeek).toBe(1);

    const qb1 = board.entries.find((e) => e.playerId === "101")!;
    const qb2 = board.entries.find((e) => e.playerId === "201")!;
    expect(qb1.seasonPoints).toBe(20);
    expect(qb1.gamesPlayed).toBe(1);
    // QB Two (30 pts) outranks QB One (20 pts) on the season-points basis.
    expect(qb2.positionRank).toBe(1);
    expect(qb1.positionRank).toBe(2);

    // A player with no matchup entry at all (never appeared in a played lineup) still shows up,
    // with a zeroed line rather than being dropped from the board.
    const rb2 = board.entries.find((e) => e.playerId === "103")!;
    expect(rb2.seasonPoints).toBe(0);
    expect(rb2.gamesPlayed).toBe(0);
  });
});

describe("buildPlayerBoard - ties and DST normalisation", () => {
  it("breaks ties by name ascending", () => {
    const played: PlayerBoardMatchupInput[] = [
      matchup(
        1,
        TEAM_A,
        TEAM_B,
        [lineupPlayer(102, "RB One", "RB", 10, undefined, 2)],
        [lineupPlayer(203, "RB Four (tie)", "RB", 10, undefined, 2)]
      ),
    ];
    const board = buildPlayerBoard({
      teams: TEAMS,
      playedMatchups: played,
      upcomingMatchups: [],
      draftPicks: [],
      throughWeek: 1,
    });

    const rbOne = board.entries.find((e) => e.playerId === "102")!;
    const rbFour = board.entries.find((e) => e.playerId === "203")!;
    // Both scored 10; "RB Four (tie)" sorts before "RB One" alphabetically.
    expect(rbFour.positionRank).toBeLessThan(rbOne.positionRank);
  });

  it("treats D/ST and DST as the same position group", () => {
    const played: PlayerBoardMatchupInput[] = [
      matchup(
        1,
        TEAM_A,
        TEAM_B,
        [lineupPlayer(104, "Defense A", "D/ST", 8, undefined, 16)],
        [lineupPlayer(204, "Defense B", "DST", 12, undefined, 16)]
      ),
    ];
    const board = buildPlayerBoard({
      teams: TEAMS,
      playedMatchups: played,
      upcomingMatchups: [],
      draftPicks: [],
      throughWeek: 1,
    });

    const defA = board.entries.find((e) => e.playerId === "104")!;
    const defB = board.entries.find((e) => e.playerId === "204")!;
    expect(defA.position).toBe("DST");
    expect(defB.position).toBe("DST");
    expect(defB.positionCount).toBe(2);
    expect(defA.positionCount).toBe(2);
    expect(defB.positionRank).toBe(1); // 12 > 8
    expect(defA.positionRank).toBe(2);
  });

  it("normalizePosition maps only D/ST, leaves everything else untouched", () => {
    expect(normalizePosition("D/ST")).toBe("DST");
    expect(normalizePosition("DST")).toBe("DST");
    expect(normalizePosition("RB")).toBe("RB");
  });
});

describe("buildPlayerBoard - draftPick join and lineup fallback", () => {
  it("attaches the overall pick number from draftPicks, leaving undrafted players undefined", () => {
    const board = buildPlayerBoard({
      teams: TEAMS,
      playedMatchups: [],
      upcomingMatchups: [],
      draftPicks: [
        { playerId: "101", overallPickNumber: 3 },
        { playerId: "202", overallPickNumber: 25 },
      ],
      throughWeek: 0,
    });

    expect(board.entries.find((e) => e.playerId === "101")!.draftPick).toBe(3);
    expect(board.entries.find((e) => e.playerId === "202")!.draftPick).toBe(25);
    expect(board.entries.find((e) => e.playerId === "102")!.draftPick).toBeUndefined();
  });

  it("first draft pick wins on a duplicate playerId", () => {
    const board = buildPlayerBoard({
      teams: TEAMS,
      playedMatchups: [],
      upcomingMatchups: [],
      draftPicks: [
        { playerId: "101", overallPickNumber: 3 },
        { playerId: "101", overallPickNumber: 45 },
      ],
      throughWeek: 0,
    });
    expect(board.entries.find((e) => e.playerId === "101")!.draftPick).toBe(3);
  });

  it("falls back to the stored roster's lineupSlotId when there is no upcoming lineup entry", () => {
    const teamsWithStoredSlot: PlayerBoardTeamInput[] = [
      {
        externalId: TEAM_A,
        name: "Team A",
        roster: [{ playerId: "101", playerName: "QB One", position: "QB", lineupSlotId: 20 }], // bench
      },
    ];
    const board = buildPlayerBoard({
      teams: teamsWithStoredSlot,
      playedMatchups: [],
      upcomingMatchups: [], // preview week has no lineup for this team (bye, or sync gap)
      draftPicks: [],
      throughWeek: 0,
    });
    expect(board.entries[0].lineup).toBe("bench");
  });

  it("defaults to bench when neither an upcoming lineup nor a stored slot is known", () => {
    const teamsNoSlot: PlayerBoardTeamInput[] = [
      { externalId: TEAM_A, name: "Team A", roster: [{ playerId: "101", playerName: "QB One", position: "QB" }] },
    ];
    const board = buildPlayerBoard({
      teams: teamsNoSlot,
      playedMatchups: [],
      upcomingMatchups: [],
      draftPicks: [],
      throughWeek: 0,
    });
    expect(board.entries[0].lineup).toBe("bench");
  });
});

describe("buildPlayerBoard - entry ordering", () => {
  it("sorts by fantasy position order (QB, RB, WR, TE, K, DST) then rank", () => {
    const teams: PlayerBoardTeamInput[] = [
      {
        externalId: TEAM_A,
        name: "Team A",
        roster: [
          { playerId: "1", playerName: "Kicker", position: "K" },
          { playerId: "2", playerName: "Def", position: "DST" },
          { playerId: "3", playerName: "Quarterback", position: "QB" },
          { playerId: "4", playerName: "Wideout", position: "WR" },
        ],
      },
    ];
    const board = buildPlayerBoard({
      teams,
      playedMatchups: [],
      upcomingMatchups: [],
      draftPicks: [],
      throughWeek: 0,
    });
    expect(board.entries.map((e) => e.position)).toEqual(["QB", "WR", "K", "DST"]);
  });
});

describe("topKeyPlayers", () => {
  it("returns the top `limit` projected starters, tagged with the given side and position rank", () => {
    const players: PlayerBoardLineupPlayer[] = [
      lineupPlayer(1, "Star WR", "WR", 0, 25, 2),
      lineupPlayer(2, "Bench WR", "WR", 0, 30, 20), // bench - excluded even though projected higher
      lineupPlayer(3, "RB", "RB", 0, 18, 2),
      lineupPlayer(4, "TE", "TE", 0, 10, 2),
      lineupPlayer(5, "Flex", "WR", 0, 8, 2),
    ];
    const ranks = new Map([
      ["1", 1],
      ["3", 4],
      ["4", 1],
    ]);

    const keyPlayers = topKeyPlayers("A", players, ranks, 3);
    expect(keyPlayers.map((p) => p.playerId)).toEqual(["1", "3", "4"]);
    expect(keyPlayers[0]).toMatchObject({ side: "A", name: "Star WR", position: "WR", projected: 25, positionRank: 1 });
    expect(keyPlayers.every((p) => p.playerId !== "2")).toBe(true);
  });

  it("returns an empty list when there are no starters", () => {
    const players: PlayerBoardLineupPlayer[] = [lineupPlayer(1, "Bench Guy", "RB", 0, 12, 20)];
    expect(topKeyPlayers("B", players, new Map())).toEqual([]);
  });
});

describe("sumStarterProjected", () => {
  it("sums only starters' projectedPoints", () => {
    const side = {
      players: [
        lineupPlayer(1, "Starter", "QB", 0, 20, 0),
        lineupPlayer(2, "Also starter", "RB", 0, 15.5, 2),
        lineupPlayer(3, "Bench", "RB", 0, 999, 20),
        lineupPlayer(4, "IR", "RB", 0, 999, 21),
      ],
    };
    expect(sumStarterProjected(side)).toBe(35.5);
  });

  it("treats a missing projectedPoints as 0 rather than dropping the starter", () => {
    const side = { players: [lineupPlayer(1, "Starter", "QB", 0, undefined, 0)] };
    expect(sumStarterProjected(side)).toBe(0);
  });

  it("returns undefined for an absent side or an empty starter list", () => {
    expect(sumStarterProjected(undefined)).toBeUndefined();
    expect(sumStarterProjected({ players: [lineupPlayer(1, "Bench", "RB", 0, 10, 20)] })).toBeUndefined();
  });
});
