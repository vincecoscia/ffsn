import { describe, expect, it } from "vitest";
import { buildFactsBlock, serializeFacts } from "../src/lib/ai/facts";
import { findRecordsBeforeKickoff, resolvePath, verifyArticle } from "../src/lib/ai/fact-verifier";
import { PromptBuilder } from "../src/lib/ai/prompt-builder";
import type {
  LeagueDataContext,
  PlayerBoard,
  PlayerBoardEntry,
  PromptBuilderOptions,
  UpcomingKeyPlayer,
} from "../src/lib/ai/prompt-builder";
import { contentTemplates } from "../src/lib/ai/content-templates";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";

/**
 * Previews on projections and positional rank (owner directive, 2026-09-03: in week 1 nobody has
 * played a snap, so the preview goes on projections, draft slots and "WR1 vs WR12"; from week 2
 * the projections lead and the records follow). This is the pure prompt-layer half: a
 * `playerBoard` and per-game `keyPlayers` in, FACTS board / prompt text / verifier verdicts out,
 * and today's output when the board is absent.
 */

const TEAMS = [
  { id: "1", name: "Halyard Bay", manager: "Hal" },
  { id: "2", name: "Ridge Runners", manager: "Rita" },
  { id: "3", name: "Bay Blitz", manager: "Bea" },
  { id: "4", name: "Grinders", manager: "Gus" },
];

/** Position, names in rank order, the projection of the No. 1 at the position. */
const POSITIONS: Array<[string, string[], number]> = [
  ["QB", ["Josh Allen", "Lamar Jackson", "Jalen Hurts", "Joe Burrow", "Jayden Daniels", "Baker Mayfield", "Bo Nix", "Jared Goff", "Brock Purdy"], 24],
  ["RB", ["Bijan Robinson", "Saquon Barkley", "Jahmyr Gibbs", "Derrick Henry", "Josh Jacobs", "Chase Brown", "Kyren Williams", "Breece Hall"], 20],
  [
    "WR",
    ["Justin Jefferson", "CeeDee Lamb", "Puka Nacua", "Malik Nabers", "Nico Collins", "Drake London", "Brian Thomas", "Tyreek Hill", "Garrett Wilson", "Mike Evans", "Terry McLaurin", "Ladd McConkey", "Davante Adams"],
    19,
  ],
  ["TE", ["Brock Bowers", "Trey McBride", "George Kittle", "Sam LaPorta"], 14],
  ["K", ["Brandon Aubrey", "Cameron Dicker", "Chris Boswell", "Jake Bates"], 9],
  ["DST", ["Broncos Defense", "Eagles Defense", "Ravens Defense", "Steelers Defense"], 8],
];

const DRAFT_PICKS: Record<string, number> = {
  "Bijan Robinson": 1,
  "Saquon Barkley": 2,
  "Justin Jefferson": 3,
  "Jahmyr Gibbs": 4,
  "CeeDee Lamb": 5,
  "Puka Nacua": 14,
  "Josh Allen": 21,
  "Jalen Hurts": 22,
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Two RB/WR starters per team, one everywhere else; the rest of the position is bench. */
const starterCount = (position: string) => (position === "RB" || position === "WR" ? 8 : 4);

/** Every rostered player, one entry each, round-robin across the four teams; rank = list order. */
function boardEntries(basis: PlayerBoard["basis"]): PlayerBoardEntry[] {
  const entries: PlayerBoardEntry[] = [];
  POSITIONS.forEach(([position, names, top], posIndex) => {
    names.forEach((name, i) => {
      const team = TEAMS[i % TEAMS.length];
      const starter = i < starterCount(position);
      entries.push({
        playerId: `${posIndex + 1}${String(i).padStart(2, "0")}`,
        name,
        position,
        nflTeam: "KC",
        fantasyTeamId: team.id,
        fantasyTeamName: team.name,
        lineup: starter ? "starter" : "bench",
        upcomingProjected: starter ? round1(top - i * 0.8) : undefined,
        seasonPoints: basis === "season_points" ? round1(top * 4 - i * 3.1) : 0,
        gamesPlayed: basis === "season_points" ? 4 : 0,
        positionRank: i + 1,
        positionCount: names.length,
        draftPick: DRAFT_PICKS[name],
      });
    });
  });
  return entries;
}

function board(basis: PlayerBoard["basis"]): PlayerBoard {
  return { basis, throughWeek: basis === "season_points" ? 4 : 0, entries: boardEntries(basis) };
}

/** The top three projected starters on one side, as the data layer sends them. */
function keyPlayers(entries: PlayerBoardEntry[], teamId: string, side: "A" | "B"): UpcomingKeyPlayer[] {
  return entries
    .filter(entry => entry.fantasyTeamId === teamId && entry.lineup === "starter")
    .sort((a, b) => (b.upcomingProjected ?? 0) - (a.upcomingProjected ?? 0))
    .slice(0, 3)
    .map(entry => ({
      side,
      playerId: entry.playerId,
      name: entry.name,
      position: entry.position,
      projected: entry.upcomingProjected,
      positionRank: entry.positionRank,
    }));
}

function teamById(id: string) {
  const team = TEAMS.find(candidate => candidate.id === id);
  if (!team) throw new Error(`no team ${id}`);
  return team;
}

function slateGame(entries: PlayerBoardEntry[], week: number, home: string, away: string, extra: Record<string, unknown> = {}) {
  return {
    week,
    teamA: teamById(home).name,
    teamB: teamById(away).name,
    teamAId: home,
    teamBId: away,
    teamAOwner: teamById(home).manager,
    teamBOwner: teamById(away).manager,
    keyPlayers: [...keyPlayers(entries, home, "A"), ...keyPlayers(entries, away, "B")],
    ...extra,
  };
}

type Record3 = [wins: number, losses: number, pointsFor: number];
const BLANK: Record3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
const AFTER_WEEK_FOUR: Record3[] = [[3, 1, 421.7], [2, 2, 398.3], [2, 2, 390.1], [1, 3, 358.2]];

function teamRows(entries: PlayerBoardEntry[], records: Record3[]) {
  return TEAMS.map((team, index) => ({
    id: `cxt${team.id}`,
    name: team.name,
    manager: team.manager,
    externalId: team.id,
    record: { wins: records[index][0], losses: records[index][1], ties: 0, pointsFor: records[index][2] },
    pointsFor: records[index][2],
    pointsAgainst: 0,
    roster: entries
      .filter(entry => entry.fantasyTeamId === team.id)
      .map(entry => ({ playerId: entry.playerId, playerName: entry.name, position: entry.position, team: entry.nflTeam ?? "" })),
  }));
}

function standingsRows(records: Record3[]) {
  return TEAMS.map((team, index) => ({
    rank: index + 1,
    team: team.name,
    teamId: team.id,
    wins: records[index][0],
    losses: records[index][1],
    ties: 0,
    pointsFor: records[index][2],
    pointsAgainst: 0,
  }));
}

const weekOneEntries = boardEntries("upcoming_projection");
/** The week-1 slate: the draft is in, nothing has been played, game 2 has no ESPN team projection. */
const weekOne = {
  leagueName: "Board League",
  currentSeason: 2026,
  currentWeek: 0,
  teams: teamRows(weekOneEntries, BLANK),
  standings: standingsRows(BLANK),
  recentMatchups: [],
  transactions: [],
  trades: [],
  playerBoard: board("upcoming_projection"),
  upcomingMatchups: [
    slateGame(weekOneEntries, 1, "1", "2", { projectedScoreA: 121.5, projectedScoreB: 116.2, teamARecord: "0-0-0", teamBRecord: "0-0-0" }),
    slateGame(weekOneEntries, 1, "3", "4", { teamARecord: "0-0-0", teamBRecord: "0-0-0" }),
  ],
} as unknown as LeagueDataContext;

const weekFiveEntries = boardEntries("season_points");
/** The week-5 slate: four weeks of points on the board, records and a last result to lean on. */
const weekFive = {
  leagueName: "Board League",
  currentSeason: 2026,
  currentWeek: 4,
  teams: teamRows(weekFiveEntries, AFTER_WEEK_FOUR),
  standings: standingsRows(AFTER_WEEK_FOUR),
  recentMatchups: [
    { week: 4, teamA: "1", teamB: "2", teamAName: "Halyard Bay", teamBName: "Ridge Runners", scoreA: 128.4, scoreB: 121.9, topPerformers: [] },
  ],
  transactions: [],
  trades: [],
  playerBoard: board("season_points"),
  upcomingMatchups: [
    slateGame(weekFiveEntries, 5, "1", "3", {
      projectedScoreA: 118.2,
      projectedScoreB: 109.4,
      teamARecord: "3-1-0",
      teamBRecord: "2-2-0",
      teamAPointsFor: 421.7,
      teamBPointsFor: 390.1,
    }),
    slateGame(weekFiveEntries, 5, "2", "4", {
      projectedScoreA: 112.0,
      projectedScoreB: 101.3,
      teamARecord: "2-2-0",
      teamBRecord: "1-3-0",
      teamAPointsFor: 398.3,
      teamBPointsFor: 358.2,
    }),
  ],
} as unknown as LeagueDataContext;

/** Today's payload: the same week-5 slate with no board and no key players. */
const noBoard = {
  ...weekFive,
  playerBoard: undefined,
  upcomingMatchups: (weekFive.upcomingMatchups ?? []).map(row => ({ ...row, keyPlayers: undefined })),
} as unknown as LeagueDataContext;

function request(contentType: string, data: LeagueDataContext): PromptBuilderOptions {
  return { leagueId: "lg-2026", contentType, persona: "curtis-vaughn", leagueData: data, priorClaims: [] };
}

function article(body: string, overrides: Partial<GeneratedArticleT> = {}): GeneratedArticleT {
  return {
    title: "The opener",
    summary: "A preview.",
    tone: "analytical",
    sections: [{ name: "introduction", content: body, wordCount: body.split(" ").length }],
    featuredTeams: [],
    featuredPlayers: [],
    keyStats: [],
    quotes: [],
    managerMentions: [],
    claims: [],
    ...overrides,
  };
}

const template = contentTemplates.weekly_preview;
const weekOneFacts = buildFactsBlock(request("weekly_preview", weekOne));
const weekFiveFacts = buildFactsBlock(request("weekly_preview", weekFive));
const noBoardFacts = buildFactsBlock(request("weekly_preview", noBoard));

/* -------------------------------------------------------------------------- */
/* FACTS                                                                        */
/* -------------------------------------------------------------------------- */

describe("FACTS board block", () => {
  it("ranks every position, id first, capped at the top 12 at RB/WR, 8 at QB/TE, 5 at K/DST", () => {
    const facts = weekOneFacts;
    expect(facts.board?.basis).toBe("this week's projections");
    expect(facts.board?.throughWeek).toBe(0);
    expect(facts.board?.positions.map(position => position.pos)).toEqual(["QB", "RB", "WR", "TE", "K", "DST"]);

    const wr = facts.board?.positions.find(position => position.pos === "WR");
    expect(wr?.count).toBe(13);
    expect(wr?.top).toHaveLength(12);
    expect(wr?.top[2]).toEqual({
      id: "P302",
      name: "Puka Nacua",
      teamId: "T3",
      rank: 3,
      seasonPoints: 0,
      upcomingProjected: 17.4,
      draftPick: 14,
      lineup: "starter",
    });
    expect(wr?.top.map(player => player.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const qb = facts.board?.positions.find(position => position.pos === "QB");
    expect(qb?.count).toBe(9);
    expect(qb?.top).toHaveLength(8);
    const k = facts.board?.positions.find(position => position.pos === "K");
    expect(k?.count).toBe(4);
    expect(k?.top).toHaveLength(4);

    // Every board id is a roster id, so the verifier already knows the player.
    const rosterIds = new Set((facts.rosters ?? []).flatMap(roster => roster.players.map(player => player.id)));
    for (const position of facts.board?.positions ?? []) {
      for (const player of position.top) expect(rosterIds.has(player.id)).toBe(true);
    }
    expect(serializeFacts(facts)).not.toContain('"T?"');
  });

  it("carries each side's key players on the slate and fills a missing team projection from the board", () => {
    const facts = weekOneFacts;
    expect(facts.upcoming.map(game => game.id)).toEqual(["U1", "U2"]);
    expect(facts.upcoming[0].keyPlayers).toEqual([
      { id: "P100", name: "Josh Allen", side: "home", projected: 24, rank: "QB1", draftPick: 21 },
      { id: "P200", name: "Bijan Robinson", side: "home", projected: 20, rank: "RB1", draftPick: 1 },
      { id: "P300", name: "Justin Jefferson", side: "home", projected: 19, rank: "WR1", draftPick: 3 },
      { id: "P101", name: "Lamar Jackson", side: "away", projected: 23.2, rank: "QB2" },
      { id: "P201", name: "Saquon Barkley", side: "away", projected: 19.2, rank: "RB2", draftPick: 2 },
      { id: "P301", name: "CeeDee Lamb", side: "away", projected: 18.2, rank: "WR2", draftPick: 5 },
    ]);
    // Game 1 keeps ESPN's own number; game 2 had none, so it is the sum of each side's starters.
    expect(facts.upcoming[0].home.projected).toBe(121.5);
    expect(facts.upcoming[0].away.projected).toBe(116.2);
    expect(facts.upcoming[1].home.projected).toBeCloseTo(113.8, 1);
    expect(facts.upcoming[1].away.projected).toBeCloseTo(107.4, 1);
  });

  it("keys the week-5 board by points to date, and puts points to date on the key players", () => {
    const facts = weekFiveFacts;
    expect(facts.board?.basis).toBe("points to date");
    expect(facts.board?.throughWeek).toBe(4);
    expect(facts.board?.positions.find(position => position.pos === "WR")?.top[0]).toMatchObject({
      id: "P300",
      name: "Justin Jefferson",
      rank: 1,
      seasonPoints: 76,
    });
    expect(facts.upcoming[0].keyPlayers?.[0]).toEqual({
      id: "P100",
      name: "Josh Allen",
      side: "home",
      projected: 24,
      rank: "QB1",
      draftPick: 21,
      seasonPoints: 96,
    });
    expect(facts.missing.some(entry => entry.startsWith("no games played yet"))).toBe(false);
  });

  it("names the gap before kickoff, and nothing at all without a board", () => {
    expect(weekOneFacts.missing).toContain(
      "no games played yet - every record is 0-0; do not cite records, standings or scores as if they meant something; projections, draft slots and positional rank are the material"
    );
    // The records stay truthful in FACTS; the note is what keeps them out of the prose.
    expect(weekOneFacts.upcoming[0].home.record).toBe("0-0-0");

    expect(noBoardFacts.board).toBeUndefined();
    expect(noBoardFacts.upcoming[0].keyPlayers).toBeUndefined();
    expect(noBoardFacts.upcoming[0].home.projected).toBe(118.2);
    expect(noBoardFacts.missing.some(entry => entry.startsWith("no games played yet"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Prompts                                                                      */
/* -------------------------------------------------------------------------- */

describe("preview prompt", () => {
  it("writes week 1 on projections, draft slots and rank, with no records and no standings", () => {
    const built = new PromptBuilder(request("weekly_preview", weekOne)).build();
    const prompt = built.userPrompt;
    expect(prompt).toContain("WEEK 1 SLATE — NONE OF THESE GAMES HAS BEEN PLAYED.");
    expect(prompt).toContain("WEEK 1 - PROJECTIONS, NOT RESULTS");
    expect(prompt).toContain("GAME 1: Halyard Bay vs Ridge Runners, projected 121.5 - 116.2 (a projection, not a result)");
    expect(prompt).toContain("GAME 2: Bay Blitz vs Grinders, projected 113.8 - 107.4 (a projection, not a result)");
    expect(prompt).toContain(
      "Bay Blitz's key players: Jalen Hurts (QB3 in this league, drafted 22nd overall, projected 22.4); Jahmyr Gibbs (RB3 in this league, drafted 4th overall, projected 18.4); Puka Nacua (WR3 in this league, drafted 14th overall, projected 17.4)"
    );
    expect(prompt).toContain(
      "- WR, 13 rostered: WR1 Justin Jefferson (Halyard Bay, projected 19.0, drafted 3rd overall); WR2 CeeDee Lamb (Ridge Runners, projected 18.2, drafted 5th overall); WR3 Puka Nacua (Bay Blitz, projected 17.4, drafted 14th overall)"
    );
    // A kicker's rank is spelled out: the verifier reads "K1" as an internal id.
    expect(prompt).toContain("- K, 4 rostered: the No. 1 kicker Brandon Aubrey (Halyard Bay, projected 9.0)");
    expect(prompt).not.toContain("K1 ");
    expect(prompt).toContain('No records, no "0-0", no standings talk, no "points for"');
    expect(prompt).toContain("The draft and the projections are the story.");
    expect(prompt).not.toContain("STANDINGS GOING IN");
    expect(prompt).not.toContain("[0-0-0");
    expect(prompt).not.toContain("last time out");
    expect(prompt).not.toContain("season-to-date form");
    expect(built.systemPrompt).toContain("- no games played yet - every record is 0-0;");
  });

  it("puts the projections block before the records from week 2, and states rank by points to date", () => {
    const prompt = new PromptBuilder(request("weekly_preview", weekFive)).build().userPrompt;
    const projections = prompt.indexOf("THIS WEEK - PROJECTIONS FIRST");
    const firstRecord = prompt.indexOf("[3-1-0, 421.7 PF]");
    const standings = prompt.indexOf("STANDINGS GOING IN");
    expect(projections).toBeGreaterThan(0);
    expect(firstRecord).toBeGreaterThan(projections);
    expect(standings).toBeGreaterThan(firstRecord);
    expect(prompt).toContain(
      "Halyard Bay's key players: Josh Allen (QB1 in the league, 96.0 points to date, drafted 21st overall, projected 24.0)"
    );
    expect(prompt).toContain("Saquon Barkley (RB2 in the league, 76.9 points to date, drafted 2nd overall, projected 19.2)");
    expect(prompt).toContain("Top of each position in this league (by points to date through week 4");
    expect(prompt).toContain("Lead with the projections and the player matchups");
    expect(prompt).toContain("Halyard Bay last time out: week 4, beat Ridge Runners 128.4-121.9");
    expect(prompt).toContain("records, points for, projections, key players and head-to-head above");
    expect(prompt).not.toContain("PROJECTIONS, NOT RESULTS");
  });

  it("is today's preview when the payload carries no board", () => {
    const prompt = new PromptBuilder(request("weekly_preview", noBoard)).build().userPrompt;
    expect(prompt).not.toContain("PROJECTIONS FIRST");
    expect(prompt).not.toContain("PROJECTIONS, NOT RESULTS");
    expect(prompt).not.toContain("key players");
    expect(prompt).toContain("season-to-date form and, where ESPN published one, a projection.");
    expect(prompt).toContain("GAME 1: Halyard Bay (Hal) [3-1-0, 421.7 PF] vs Bay Blitz (Bea) [2-2-0, 390.1 PF]");
    expect(prompt).toContain("Projected: 118.2 - 109.4 (a projection, not a result)");
    expect(prompt).toContain("STANDINGS GOING IN");
    expect(prompt).toContain("the records, points for, projections and head-to-head above.");
  });
});

/* -------------------------------------------------------------------------- */
/* Verifier                                                                     */
/* -------------------------------------------------------------------------- */

describe("verifier on the board", () => {
  it("resolves board and key-player paths by position label and player id", () => {
    expect(resolvePath(weekOneFacts, "board.positions.WR.top.P302.rank")).toBe(3);
    expect(resolvePath(weekOneFacts, "board.positions.WR.count")).toBe(13);
    expect(resolvePath(weekOneFacts, "board.positions.QB.top.P100.draftPick")).toBe(21);
    expect(resolvePath(weekOneFacts, "upcoming.U2.keyPlayers.P302.projected")).toBe(17.4);
    expect(resolvePath(weekOneFacts, "upcoming.U2.home.projected")).toBeCloseTo(113.8, 1);
    expect(resolvePath(weekOneFacts, "board.positions.OL.top")).toBeUndefined();
  });

  it("accepts key stats sourced from the board, and knows its numbers in the prose", () => {
    const piece = article("Puka Nacua is projected for 17.4 and Josh Allen has 96.0 points to date.", {
      keyStats: [
        { stat: "rank", value: "3", context: "WR3", source: "board.positions.WR.top.P302.rank" },
        { stat: "projection", value: "17.4", context: "week 5", source: "upcoming.U1.keyPlayers.P302.projected" },
      ],
    });
    expect(verifyArticle(piece, weekFiveFacts)).toEqual([]);
  });

  it("warns on a record beside a team, or 'points for', in a preview written before kickoff", () => {
    const piece = article(
      "Halyard Bay (0-0) hosts Ridge Runners in the opener. Ridge Runners led the league in points for last year."
    );
    const hits = verifyArticle(piece, weekOneFacts, { template }).filter(violation => violation.kind === "records_before_kickoff");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ severity: "warn", section: "introduction" });
    expect(hits[0].detail).toContain('"0-0" in a preview written before kickoff');
    expect(hits[1].detail).toContain('"points for"');
  });

  it("leaves projections, a week-5 preview and an untemplated check alone", () => {
    const kinds = (piece: GeneratedArticleT, facts = weekOneFacts, options?: { template: typeof template }) =>
      verifyArticle(piece, facts, options).filter(violation => violation.kind === "records_before_kickoff");
    // A projected score line is not a record, and "121.5 points for the opener" is a projection sentence.
    expect(kinds(article("Halyard Bay is projected 121.5-116.2 over Ridge Runners, 121.5 points for the opener."), weekOneFacts, { template })).toEqual([]);
    // Week 5: records are the story again.
    expect(kinds(article("Halyard Bay (3-1) hosts Bay Blitz."), weekFiveFacts, { template })).toEqual([]);
    // No template: the verifier cannot know this is a preview.
    expect(kinds(article("Halyard Bay (0-0) hosts Ridge Runners."))).toEqual([]);
  });

  it("finds a record only beside a team name", () => {
    expect(findRecordsBeforeKickoff("Grinders went 0-0-0 in August.", ["Grinders"])).toEqual([
      { phrase: "0-0-0", sentence: "Grinders went 0-0-0 in August." },
    ]);
    expect(findRecordsBeforeKickoff("A 10-4 record is nothing yet.", ["Grinders"])).toEqual([]);
    expect(findRecordsBeforeKickoff("Nobody has any points for yet.", [])).toEqual([
      { phrase: "points for", sentence: "Nobody has any points for yet." },
    ]);
  });
});
