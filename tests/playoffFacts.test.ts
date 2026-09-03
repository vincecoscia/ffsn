import { describe, expect, it } from "vitest";
import type {
  BracketGame,
  BracketRound,
  BracketSide,
  BracketTeam,
  PlayoffContext,
  PlayoffTier,
} from "../convex/lib/playoffTypes";
import { buildFactsBlock, serializeFacts } from "../src/lib/ai/facts";
import type { FactsBlock } from "../src/lib/ai/facts";
import { findEliminatedAsContender, resolvePath, verifyArticle } from "../src/lib/ai/fact-verifier";
import { PromptBuilder } from "../src/lib/ai/prompt-builder";
import type { LeagueDataContext, PromptBuilderOptions } from "../src/lib/ai/prompt-builder";
import type { GeneratedArticleT } from "../src/lib/ai/content-generation-service";

/**
 * Playoffs in FACTS and in the writers' prompts (owner ask, Sept 2026: the playoffs and the
 * championship have to read as something different and special, and the articles have to be
 * centred on the teams still in contention). The bracket below is the league's real 2025 bracket
 * as stored in prod, with ESPN's team ids for that season: seeds 1 and 2 rested in week 15 (ESPN
 * stores a rest as a matchup with an empty side), the semifinals were week 16, and the No. 1 seed
 * beat the No. 3 seed 139.38-96.66 in the week-17 final. This is the pure prompt-layer half: a
 * PlayoffContext in, FACTS block / prompt text / verifier verdicts out. Both halves of the
 * contract are covered: with `playoffs` on the payload, and without it (today's behaviour).
 */

interface RosterRow {
  id: string;
  name: string;
  manager: string;
  wins: number;
  losses: number;
  pointsFor: number;
  seed: number;
}

const ROSTER: RosterRow[] = [
  { id: "2", name: "Chodie mcgruber", manager: "Cody", wins: 10, losses: 4, pointsFor: 1611.4, seed: 1 },
  { id: "8", name: "The Stinky Faggots", manager: "Stan", wins: 10, losses: 4, pointsFor: 1580.2, seed: 2 },
  { id: "11", name: "GLORY ASSHOLE", manager: "Glen", wins: 8, losses: 6, pointsFor: 1522.7, seed: 3 },
  { id: "3", name: "IR Squad", manager: "Ira", wins: 8, losses: 6, pointsFor: 1490.1, seed: 4 },
  { id: "10", name: "Moisty Loins", manager: "Manny", wins: 7, losses: 7, pointsFor: 1475.9, seed: 5 },
  { id: "12", name: "IM NOT GAY", manager: "Ian", wins: 7, losses: 7, pointsFor: 1440.3, seed: 6 },
  { id: "1", name: "SAGGY NUTS", manager: "Sal", wins: 6, losses: 8, pointsFor: 1402.8, seed: 7 },
  { id: "4", name: "Team Rive", manager: "Riv", wins: 5, losses: 9, pointsFor: 1388.0, seed: 8 },
  { id: "5", name: "Tua Deez Nuts", manager: "Tua", wins: 4, losses: 10, pointsFor: 1301.5, seed: 9 },
  { id: "6", name: "Prolapsed Peehole", manager: "Pete", wins: 3, losses: 11, pointsFor: 1250.9, seed: 10 },
];

function byId(id: string): RosterRow {
  const row = ROSTER.find(candidate => candidate.id === id);
  if (!row) throw new Error(`no roster row ${id}`);
  return row;
}

const recordOf = (row: RosterRow) => `${row.wins}-${row.losses}-0`;

function team(id: string): BracketTeam {
  const row = byId(id);
  return { teamId: id, name: row.name, seed: row.seed, record: recordOf(row), pointsFor: row.pointsFor };
}

function side(id: string, score?: number): BracketSide {
  return { teamId: id, name: byId(id).name, seed: byId(id).seed, score };
}

function bye(id: string): BracketGame {
  return { week: 15, tier: "WINNERS_BRACKET", bye: { teamId: id, name: byId(id).name, seed: byId(id).seed }, status: "bye" };
}

function played(week: number, tier: PlayoffTier, home: string, homeScore: number, away: string, awayScore: number): BracketGame {
  return {
    week,
    tier,
    home: side(home, homeScore),
    away: side(away, awayScore),
    winnerTeamId: homeScore > awayScore ? home : away,
    status: "final",
  };
}

function scheduled(week: number, tier: PlayoffTier, home: string, away: string): BracketGame {
  return { week, tier, home: side(home), away: side(away), status: "scheduled" };
}

const QUARTERFINALS_SET: BracketRound = {
  week: 15,
  name: "Quarterfinals",
  games: [bye("2"), bye("8"), scheduled(15, "WINNERS_BRACKET", "11", "12"), scheduled(15, "WINNERS_BRACKET", "3", "10")],
};
const QUARTERFINALS: BracketRound = {
  week: 15,
  name: "Quarterfinals",
  games: [
    bye("2"),
    bye("8"),
    played(15, "WINNERS_BRACKET", "11", 127.12, "12", 120.16),
    played(15, "WINNERS_BRACKET", "3", 115.1, "10", 145.2),
  ],
};
const SEMIFINALS_SET: BracketRound = {
  week: 16,
  name: "Semifinals",
  games: [scheduled(16, "WINNERS_BRACKET", "2", "10"), scheduled(16, "WINNERS_BRACKET", "8", "11")],
};
const SEMIFINALS: BracketRound = {
  week: 16,
  name: "Semifinals",
  games: [played(16, "WINNERS_BRACKET", "2", 187.32, "10", 171.86), played(16, "WINNERS_BRACKET", "8", 137.2, "11", 143.48)],
};
const FINAL_TBD: BracketRound = {
  week: 17,
  name: "Championship",
  games: [{ week: 17, tier: "WINNERS_BRACKET", status: "tbd" }],
};
const FINAL_SET: BracketRound = { week: 17, name: "Championship", games: [scheduled(17, "WINNERS_BRACKET", "2", "11")] };
const FINAL: BracketRound = {
  week: 17,
  name: "Championship",
  games: [played(17, "WINNERS_BRACKET", "2", 139.38, "11", 96.66)],
};

const CONSOLATION: BracketGame[] = [
  played(15, "LOSERS_CONSOLATION_LADDER", "1", 101.3, "6", 88.9),
  played(15, "LOSERS_CONSOLATION_LADDER", "4", 95.4, "5", 97.8),
  played(16, "WINNERS_CONSOLATION_LADDER", "12", 110.5, "3", 99.2),
  played(17, "WINNERS_CONSOLATION_LADDER", "10", 120.0, "8", 118.4),
];

const FORMAT = { playoffTeamCount: 6, rounds: 3, byes: 2, playoffStartWeek: 15, championshipWeek: 17 };
const SEEDS = ["2", "8", "11", "3", "10", "12"].map(team);

/** Through week 12: a projection. */
const projected: PlayoffContext = {
  mode: "projected",
  ...FORMAT,
  seeds: SEEDS,
  bubble: [team("1"), team("4")],
  bracket: [QUARTERFINALS_SET],
  consolation: [],
  alive: [],
  eliminated: [],
};

/** The regular season is over, nothing played yet: the week-15 slate. */
const fieldSet: PlayoffContext = {
  mode: "live",
  ...FORMAT,
  currentRound: { week: 15, name: "Quarterfinals" },
  seeds: SEEDS,
  bubble: [],
  bracket: [QUARTERFINALS_SET, { ...SEMIFINALS_SET, games: [] }, FINAL_TBD],
  consolation: [],
  alive: ["2", "8", "11", "3", "10", "12"],
  eliminated: [],
};

/** Through week 15: the quarterfinals are in. */
const afterQuarterfinals: PlayoffContext = {
  mode: "live",
  ...FORMAT,
  currentRound: { week: 15, name: "Quarterfinals" },
  seeds: SEEDS,
  bubble: [],
  bracket: [QUARTERFINALS, SEMIFINALS_SET, FINAL_TBD],
  consolation: CONSOLATION.slice(0, 2),
  alive: ["2", "8", "11", "10"],
  eliminated: ["12", "3"],
};

/** Through week 16: the final is set. */
const afterSemifinals: PlayoffContext = {
  mode: "live",
  ...FORMAT,
  currentRound: { week: 17, name: "Championship" },
  seeds: SEEDS,
  bubble: [],
  bracket: [QUARTERFINALS, SEMIFINALS, FINAL_SET],
  consolation: [...CONSOLATION.slice(0, 3), scheduled(17, "WINNERS_CONSOLATION_LADDER", "10", "8")],
  alive: ["2", "11"],
  eliminated: ["12", "3", "10", "8"],
};

/** Through week 17: decided. */
const decided: PlayoffContext = {
  mode: "final",
  ...FORMAT,
  currentRound: { week: 17, name: "Championship" },
  seeds: SEEDS,
  bubble: [],
  bracket: [QUARTERFINALS, SEMIFINALS, FINAL],
  consolation: CONSOLATION,
  alive: ["2"],
  eliminated: ["12", "3", "10", "8", "11"],
  champion: team("2"),
  runnerUp: team("11"),
};

const teams = ROSTER.map(row => ({
  id: `cxt${row.id}`,
  name: row.name,
  manager: row.manager,
  externalId: row.id,
  record: { wins: row.wins, losses: row.losses, ties: 0, pointsFor: row.pointsFor },
  pointsFor: row.pointsFor,
  pointsAgainst: 1400,
  playoffSeed: row.seed,
  roster: [],
}));

const standings = ROSTER.map(row => ({
  rank: row.seed,
  team: row.name,
  teamId: row.id,
  wins: row.wins,
  losses: row.losses,
  ties: 0,
  pointsFor: row.pointsFor,
  pointsAgainst: 1400,
  playoffSeed: row.seed,
}));

/** Generic-query matchup shape (ids in teamA/teamB, names alongside), as the recap and rankings paths see it. */
function game(week: number, home: string, homeScore: number, away: string, awayScore: number, playoffTier?: string) {
  return {
    week,
    teamA: home,
    teamB: away,
    teamAName: byId(home).name,
    teamBName: byId(away).name,
    scoreA: homeScore,
    scoreB: awayScore,
    playoffTier,
    topPerformers: [],
  };
}

/** ESPN's rest: a matchup row with an empty away side, no winner, the home team's real score. */
const legacyByeRow = {
  week: 15,
  teamA: "2",
  teamB: "",
  teamAName: "Chodie mcgruber",
  teamBName: "",
  scoreA: 150.1,
  scoreB: 0,
  playoffTier: "WINNERS_BRACKET",
  topPerformers: [],
};

function slateGame(week: number, home: string, away: string, extra: Record<string, unknown> = {}) {
  return {
    week,
    teamA: byId(home).name,
    teamB: byId(away).name,
    teamAId: home,
    teamBId: away,
    teamARecord: recordOf(byId(home)),
    teamBRecord: recordOf(byId(away)),
    teamAPointsFor: byId(home).pointsFor,
    teamBPointsFor: byId(away).pointsFor,
    ...extra,
  };
}

function leagueData(overrides: Record<string, unknown>): LeagueDataContext {
  return {
    leagueName: "Prod League",
    season: 2025,
    currentWeek: 17,
    teams,
    standings,
    transactions: [],
    trades: [],
    ...overrides,
  } as unknown as LeagueDataContext;
}

/** A full request is assignable to `FactsRequest`, so one helper feeds both the FACTS builder and the prompt builder. */
function request(contentType: string, data: LeagueDataContext, extra: Partial<PromptBuilderOptions> = {}): PromptBuilderOptions {
  return {
    leagueId: "lg-2025",
    contentType,
    persona: "curtis-vaughn",
    leagueData: data,
    priorClaims: [],
    ...extra,
  };
}

const week17Recap = leagueData({
  currentWeek: 17,
  recentMatchups: [
    game(17, "2", 139.38, "11", 96.66, "WINNERS_BRACKET"),
    game(17, "10", 120.0, "8", 118.4, "WINNERS_CONSOLATION_LADDER"),
  ],
  byes: [],
  playoffs: decided,
});

const week15Recap = leagueData({
  currentWeek: 15,
  recentMatchups: [
    game(15, "11", 127.12, "12", 120.16, "WINNERS_BRACKET"),
    game(15, "3", 115.1, "10", 145.2, "WINNERS_BRACKET"),
    legacyByeRow,
  ],
  byes: [
    { teamId: "2", teamName: "Chodie mcgruber", seed: 1 },
    { teamId: "8", teamName: "The Stinky Faggots", seed: 2 },
  ],
  playoffs: afterQuarterfinals,
});

const championshipPreview = leagueData({
  currentWeek: 16,
  recentMatchups: [
    game(16, "2", 187.32, "10", 171.86, "WINNERS_BRACKET"),
    game(16, "8", 137.2, "11", 143.48, "WINNERS_BRACKET"),
  ],
  upcomingMatchups: [
    slateGame(17, "2", "11", { projectedScoreA: 131.2, projectedScoreB: 118.7, tier: "WINNERS_BRACKET", round: "Championship" }),
    slateGame(17, "10", "8", { tier: "WINNERS_CONSOLATION_LADDER" }),
  ],
  playoffs: afterSemifinals,
});

const quarterfinalPreview = leagueData({
  currentWeek: 14,
  recentMatchups: [game(14, "2", 120.4, "8", 118.9)],
  upcomingMatchups: [
    { week: 15, bye: { teamId: "2", name: "Chodie mcgruber", seed: 1 } },
    { week: 15, bye: { teamId: "8", name: "The Stinky Faggots", seed: 2 } },
    slateGame(15, "11", "12", { tier: "WINNERS_BRACKET" }),
    slateGame(15, "3", "10", { tier: "WINNERS_BRACKET" }),
    slateGame(15, "1", "6", { tier: "LOSERS_CONSOLATION_LADDER" }),
  ],
  playoffs: fieldSet,
});

const regularSeasonPreview = leagueData({
  currentWeek: 12,
  recentMatchups: [game(12, "2", 120.4, "8", 118.9)],
  upcomingMatchups: [slateGame(13, "2", "11"), slateGame(13, "1", "4")],
  playoffs: projected,
});

const finalFacts = buildFactsBlock(request("weekly_recap", week17Recap));

function article(body: string, overrides: Partial<GeneratedArticleT> = {}): GeneratedArticleT {
  return {
    title: "Week 17",
    summary: "The final.",
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

/* -------------------------------------------------------------------------- */
/* FACTS                                                                        */
/* -------------------------------------------------------------------------- */

describe("FACTS playoffs block", () => {
  it("resolves every team through the same ids as the rest of FACTS", () => {
    const playoffs = finalFacts.playoffs;
    expect(playoffs).toBeDefined();
    expect(playoffs?.mode).toBe("final");
    expect(playoffs?.seeds.map(seed => seed.teamId)).toEqual(["T2", "T8", "T11", "T3", "T10", "T12"]);
    expect(playoffs?.seeds[0]).toEqual({ teamId: "T2", seed: 1, record: "10-4-0", pointsFor: 1611.4 });
    expect(playoffs?.bracket.flatMap(round => round.games.map(game => game.id))).toEqual([
      "B1", "B2", "B3", "B4", "B5", "B6", "B7",
    ]);
    expect(playoffs?.bracket[2].games[0]).toEqual({
      id: "B7",
      home: "T2",
      away: "T11",
      homeSeed: 1,
      awaySeed: 3,
      homeScore: 139.4,
      awayScore: 96.7,
      winner: "T2",
      status: "final",
    });
    expect(playoffs?.consolation.map(game => game.id)).toEqual(["K1", "K2", "K3", "K4"]);
    expect(playoffs?.consolation[3]).toMatchObject({ week: 17, tier: "third-place ladder", home: "T10", away: "T8", winner: "T10" });
    expect(playoffs?.consolation[0].tier).toBe("consolation ladder");
    expect(playoffs?.alive).toEqual(["T2"]);
    expect(playoffs?.eliminated).toEqual(["T12", "T3", "T10", "T8", "T11"]);
    expect(playoffs?.champion).toBe("T2");
    expect(playoffs?.runnerUp).toBe("T11");
    expect(playoffs?.round).toBe("Championship");
    expect(playoffs).toMatchObject({ fieldSize: 6, byes: 2, playoffStartWeek: 15, championshipWeek: 17 });
  });

  it("never lets a raw tier, an unresolved id or an ESPN enum reach the writer", () => {
    const serialized = serializeFacts(finalFacts);
    expect(serialized).not.toContain("WINNERS_BRACKET");
    expect(serialized).not.toContain("CONSOLATION_LADDER");
    expect(serialized).not.toContain('"T?"');
    expect(finalFacts.matchups.map(matchup => matchup.bracket)).toEqual(["winners bracket", "third-place ladder"]);
  });

  it("renders a rest as a bye entry, never as a game with a blank side", () => {
    const facts = buildFactsBlock(request("weekly_recap", week15Recap));
    expect(facts.playoffs?.bracket[0].games.slice(0, 2)).toEqual([
      { id: "B1", bye: "T2", note: "rests this round, advances automatically", status: "bye" },
      { id: "B2", bye: "T8", note: "rests this round, advances automatically", status: "bye" },
    ]);
    // The ESPN bye row is dropped from the matchups once the payload knows what a bye is...
    expect(facts.matchups).toHaveLength(2);
    expect(facts.matchups.flatMap(matchup => [matchup.home.teamId, matchup.away.teamId])).not.toContain("T?");
    // ...and kept, as today, when it does not.
    const legacy = buildFactsBlock(request("weekly_recap", { ...week15Recap, byes: undefined, playoffs: undefined }));
    expect(legacy.playoffs).toBeUndefined();
    expect(legacy.matchups).toHaveLength(3);
  });

  it("keeps rests off the look-ahead slate and labels the bracket games", () => {
    const facts = buildFactsBlock(request("weekly_preview", quarterfinalPreview));
    expect(facts.upcoming.map(game => game.id)).toEqual(["U1", "U2", "U3"]);
    expect(facts.upcoming.flatMap(game => [game.home.teamId, game.away.teamId])).not.toContain("T?");
    // The round comes from the bracket when the row itself does not say.
    expect(facts.upcoming[0]).toMatchObject({ home: { teamId: "T11" }, away: { teamId: "T12" }, round: "Quarterfinals", bracket: "winners bracket", isPlayoff: true });
    expect(facts.upcoming[2]).toMatchObject({ bracket: "consolation ladder", isPlayoff: true });
    expect(facts.upcoming[2].round).toBeUndefined();
    expect(facts.missing).not.toContain("upcoming matchups — not available");
  });

  it("names the projection and the eliminated in plain English, and says nothing without a picture", () => {
    const projectedFacts = buildFactsBlock(request("weekly_preview", regularSeasonPreview));
    expect(projectedFacts.missing).toContain("playoff seeds are a projection (if the season ended today), not clinched");

    const liveFacts = buildFactsBlock(request("weekly_recap", week15Recap));
    expect(liveFacts.missing).toContain("eliminated teams: IM NOT GAY, IR Squad - not contenders");
    expect(liveFacts.missing.some(entry => entry.includes("projection"))).toBe(false);

    expect(finalFacts.missing.some(entry => entry.includes("projection") || entry.includes("eliminated"))).toBe(false);

    const none = buildFactsBlock(request("weekly_recap", { ...week17Recap, playoffs: undefined }));
    expect(none.playoffs).toBeUndefined();
    expect(none.missing.some(entry => entry.includes("projection") || entry.includes("eliminated"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Prompts                                                                      */
/* -------------------------------------------------------------------------- */

describe("playoff prompt framing", () => {
  it("makes a championship-week preview the final, both paths in, no eliminated team a contender", () => {
    const built = new PromptBuilder(request("weekly_preview", championshipPreview)).build();
    const prompt = built.userPrompt;
    expect(prompt).toContain("CHAMPIONSHIP WEEK - THE WHOLE PIECE IS THE FINAL.");
    expect(prompt).toContain("The final: No. 1 Chodie mcgruber vs No. 3 GLORY ASSHOLE: not played yet.");
    expect(prompt).toContain(
      "Chodie mcgruber's path: rested in the Quarterfinals; beat No. 5 Moisty Loins 187.3-171.9 in the Semifinals"
    );
    expect(prompt).toContain(
      "GLORY ASSHOLE's path: beat No. 6 IM NOT GAY 127.1-120.2 in the Quarterfinals; beat No. 2 The Stinky Faggots 143.5-137.2 in the Semifinals"
    );
    expect(prompt).toContain("Still in the title chase: Chodie mcgruber, GLORY ASSHOLE.");
    expect(prompt).toContain("Out of the title race (consolation only): IM NOT GAY, IR Squad, Moisty Loins, The Stinky Faggots.");
    expect(prompt).toContain("Do not preview eliminated teams as contenders.");
    expect(prompt).toContain("Records are regular-season records; playoff results never change them.");
    expect(prompt).toContain("GAME 1 [PLAYOFF - Championship]:");
    expect(prompt).toContain("GAME 2 [third-place ladder]:");
    expect(prompt).toContain("Consolation this week, a footnote at most");
    expect(prompt).not.toContain("[WINNERS_");
    expect(prompt).not.toContain("_LADDER]");
  });

  it("puts the bracket first and states the rests when the playoffs open", () => {
    const prompt = new PromptBuilder(request("weekly_preview", quarterfinalPreview)).build().userPrompt;
    expect(prompt).toContain("PLAYOFFS - QUARTERFINALS (WEEK 15). THE BRACKET IS THE STORY.");
    expect(prompt).toContain("1. No. 3 GLORY ASSHOLE vs No. 6 IM NOT GAY: not played yet");
    expect(prompt).toContain(
      "Resting this round (no game, no opponent, advances automatically): No. 1 Chodie mcgruber, No. 2 The Stinky Faggots. Each rests this week and plays in the Semifinals next week."
    );
    expect(prompt).toContain("GAME 1 [PLAYOFF - Quarterfinals]:");
    expect(prompt).toContain("GAME 3 [consolation ladder]:");
    // Only the three games are on the slate; a rest is never a GAME line.
    expect(prompt).not.toContain("GAME 4");
  });

  it("frames a regular-season preview as 'if the season ended today'", () => {
    const prompt = new PromptBuilder(request("weekly_preview", regularSeasonPreview)).build().userPrompt;
    expect(prompt).toContain("PLAYOFF PICTURE - IF THE SEASON ENDED TODAY (a projection; nothing is clinched):");
    expect(prompt).toContain("- No. 1 Chodie mcgruber (10-4-0, 1611.4 PF) [rests round one]");
    expect(prompt).toContain("Next in line (out as of today): SAGGY NUTS (6-8-0, 1402.8 PF), Team Rive (5-9-0, 1388.0 PF)");
    expect(prompt).not.toContain("THE BRACKET IS THE STORY");
  });

  it("splits a live power ranking into the alive and the eliminated, labelled and in that order", () => {
    const data = leagueData({
      currentWeek: 16,
      recentMatchups: championshipPreview.recentMatchups,
      playoffs: afterSemifinals,
    });
    const prompt = new PromptBuilder(request("power_rankings", data)).build().userPrompt;
    const groupOne = prompt.indexOf('Group 1, "Still in the title chase"');
    const groupTwo = prompt.indexOf('Group 2, "Eliminated"');
    expect(groupOne).toBeGreaterThan(0);
    expect(groupTwo).toBeGreaterThan(groupOne);
    const chodie = prompt.indexOf("- No. 1 Chodie mcgruber (10-4-0): rested in the Quarterfinals; beat No. 5 Moisty Loins 187.3-171.9 in the Semifinals; plays No. 3 GLORY ASSHOLE in the Championship");
    const glory = prompt.indexOf("- No. 3 GLORY ASSHOLE (8-6-0): beat No. 6 IM NOT GAY");
    const moisty = prompt.indexOf("- No. 5 Moisty Loins (7-7-0): lost to No. 1 Chodie mcgruber 171.9-187.3 in the Semifinals");
    const saggy = prompt.indexOf("- SAGGY NUTS (6-8-0): missed the playoffs; beat Prolapsed Peehole 101.3-88.9 in the consolation ladder, week 15");
    expect(chodie).toBeGreaterThan(groupOne);
    expect(glory).toBeGreaterThan(groupOne);
    expect(chodie).toBeLessThan(groupTwo);
    expect(glory).toBeLessThan(groupTwo);
    expect(moisty).toBeGreaterThan(groupTwo);
    expect(saggy).toBeGreaterThan(moisty);
    expect(prompt).toContain("Never call an eliminated team a contender, alive, in the hunt or in the title chase.");
  });

  it("lets a regular-season power ranking note playoff position without changing the basis", () => {
    const data = leagueData({ currentWeek: 12, recentMatchups: regularSeasonPreview.recentMatchups, playoffs: projected });
    const prompt = new PromptBuilder(request("power_rankings", data)).build().userPrompt;
    expect(prompt).toContain("PLAYOFF POSITION - IF THE SEASON ENDED TODAY");
    expect(prompt).toContain("- Chodie mcgruber: in, No. 1 seed, would rest round one");
    expect(prompt).toContain("- SAGGY NUTS: on the bubble, next in line");
    expect(prompt).toContain("- Tua Deez Nuts: out as of today");
    expect(prompt).not.toContain('Group 2, "Eliminated"');
  });

  it("crowns the champion explicitly in the championship recap and opens the championship section", () => {
    const built = new PromptBuilder(request("weekly_recap", week17Recap)).build();
    expect(built.userPrompt).toContain(
      "CHAMPION: Chodie mcgruber. The final: No. 1 Chodie mcgruber vs No. 3 GLORY ASSHOLE: Chodie mcgruber won 139.4-96.7. Crown them explicitly; this is the season's last word. Runner-up: GLORY ASSHOLE."
    );
    expect(built.userPrompt).toContain("- championship_game (");
    expect(built.userPrompt).not.toContain("- playoff_games (");
    expect(built.userPrompt).toContain("Records are regular-season records");
  });

  it("says who rested, who advanced and who is out in a playoff-week recap", () => {
    const built = new PromptBuilder(request("weekly_recap", week15Recap)).build();
    const prompt = built.userPrompt;
    expect(prompt).toContain("PLAYOFFS - QUARTERFINALS (WEEK 15):");
    expect(prompt).toContain("Rested this week (no game; advanced automatically): No. 1 Chodie mcgruber, No. 2 The Stinky Faggots.");
    expect(prompt).toContain("Advanced: Chodie mcgruber, The Stinky Faggots, GLORY ASSHOLE, Moisty Loins.");
    expect(prompt).toContain("Knocked out of the title race this week: IM NOT GAY, IR Squad.");
    expect(prompt).toContain("Still in the title chase: Chodie mcgruber, The Stinky Faggots, GLORY ASSHOLE, Moisty Loins.");
    expect(prompt).toContain("- playoff_games (");
    expect(prompt).toContain("- playoff_implications (");
    expect(prompt).not.toContain("- championship_game (");
    expect(prompt).not.toContain("[WINNERS_BRACKET]");
    // The ESPN bye row is not read out as a game either.
    expect(prompt).not.toContain("(150.1) vs  (0)");
  });

  it("makes the projected bracket the core of a regular-season playoff picture, and the real one later", () => {
    const projectedPrompt = new PromptBuilder(
      request("playoff_picture", leagueData({ currentWeek: 12, recentMatchups: regularSeasonPreview.recentMatchups, playoffs: projected }))
    ).build().userPrompt;
    expect(projectedPrompt).toContain("PROJECTED BRACKET - IF THE SEASON ENDED TODAY");
    expect(projectedPrompt).toContain("Round one as it would stand:");
    expect(projectedPrompt).toContain("- No. 1 Chodie mcgruber rests this round and advances automatically");
    expect(projectedPrompt).toContain("- No. 3 GLORY ASSHOLE vs No. 6 IM NOT GAY: not played yet");

    const livePrompt = new PromptBuilder(request("playoff_picture", championshipPreview)).build().userPrompt;
    expect(livePrompt).toContain("THE BRACKET - REAL, AS IT STANDS (Championship):");
    expect(livePrompt).toContain("Week 16, Semifinals:");
    expect(livePrompt).toContain("- No. 2 The Stinky Faggots vs No. 3 GLORY ASSHOLE: GLORY ASSHOLE won 143.5-137.2");
    expect(livePrompt).toContain("Still in the title chase: Chodie mcgruber, GLORY ASSHOLE.");
  });

  it("takes last season's champion from the decided bracket ahead of the stored (wrong) one", () => {
    const history = {
      foundedYear: 2020,
      totalSeasons: 6,
      seasons: [
        { year: 2024, champion: { teamId: "5", teamName: "Tua Deez Nuts", owner: "Tua" } },
        { year: 2025, champion: { teamId: "12", teamName: "joey's Scary Team", owner: "Unknown" } },
      ],
    };
    const withBracket = new PromptBuilder(
      request("season_welcome", leagueData({ currentWeek: 0, currentSeason: 2026, leagueHistory: history, playoffs: decided }))
    ).build().userPrompt;
    expect(withBracket).toContain("LAST SEASON (2025):");
    expect(withBracket).toContain("- Champion: No. 1 Chodie mcgruber (10-4-0), beat No. 3 GLORY ASSHOLE 139.4-96.7 in the week 17 final");
    expect(withBracket).toContain("- Runner-up: No. 3 GLORY ASSHOLE");
    expect(withBracket).toContain("- 2024: Tua Deez Nuts (Tua)");
    expect(withBracket).not.toContain("joey's Scary Team");

    // Without a bracket the stored history is all there is, as today.
    const stored = new PromptBuilder(
      request("season_welcome", leagueData({ currentWeek: 0, currentSeason: 2026, leagueHistory: history }))
    ).build().userPrompt;
    expect(stored).toContain("- Champion: joey's Scary Team (Unknown)");

    const recap = new PromptBuilder(request("season_recap", week17Recap)).build().userPrompt;
    expect(recap).toContain("HOW THE TITLE WAS DECIDED:");
    expect(recap).toContain("- Champion: No. 1 Chodie mcgruber (10-4-0), beat No. 3 GLORY ASSHOLE 139.4-96.7 in the week 17 final");
  });

  it("states that no interviews were sent, only when neither quotes nor non-respondents exist", () => {
    const silent = new PromptBuilder(request("weekly_recap", week17Recap)).build().systemPrompt;
    expect(silent).toContain("NO INTERVIEWS FOR THIS PIECE");
    expect(silent).toContain("Do not say the desk reached out, asked, or heard back");

    const asked = new PromptBuilder(
      request("weekly_recap", week17Recap, {
        nonRespondents: [{ userId: "u11", userName: "Glen", teamName: "GLORY ASSHOLE", status: "no_response" }],
      })
    ).build().systemPrompt;
    expect(asked).not.toContain("NO INTERVIEWS FOR THIS PIECE");
    expect(asked).toContain("Glen (T11) did not respond");
  });
});

/* -------------------------------------------------------------------------- */
/* Verifier                                                                     */
/* -------------------------------------------------------------------------- */

describe("verifier: contention and bracket paths", () => {
  it("blocks 'GLORY ASSHOLE is still alive' once they have lost the final", () => {
    const violations = verifyArticle(article("GLORY ASSHOLE is still alive. Chodie mcgruber won the title."), finalFacts);
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: "eliminated_as_contender", severity: "block", section: "introduction" })
    );
    expect(violations.find(violation => violation.kind === "eliminated_as_contender")?.detail).toContain("GLORY ASSHOLE");
  });

  it("does not flag the same sentence after the semifinals, when they were alive", () => {
    const liveFacts = buildFactsBlock(request("weekly_preview", championshipPreview));
    expect(liveFacts.playoffs?.alive).toContain("T11");
    const violations = verifyArticle(article("GLORY ASSHOLE is still alive."), liveFacts);
    expect(violations.filter(violation => violation.kind === "eliminated_as_contender")).toEqual([]);
  });

  it("stays narrow: negation, the past tense, a different team's sentence, and whole names only", () => {
    for (const body of [
      "GLORY ASSHOLE is no longer a contender.",
      "GLORY ASSHOLE was a contender until Sunday.",
      "Chodie mcgruber is the last contender standing. GLORY ASSHOLE went home.",
      "Their squad is still in the hunt for third place.",
    ]) {
      expect(
        verifyArticle(article(body), finalFacts).filter(violation => violation.kind === "eliminated_as_contender"),
        body
      ).toEqual([]);
    }
    expect(findEliminatedAsContender("IR Squad is still in the hunt.", ["ir squad"])).toHaveLength(1);
    expect(findEliminatedAsContender("Their squad is still in the hunt.", ["ir squad"])).toHaveLength(0);
  });

  it("checks the title too", () => {
    const violations = verifyArticle(article("Fine.", { title: "Moisty Loins: still in the hunt" }), finalFacts);
    expect(violations).toContainEqual(expect.objectContaining({ kind: "eliminated_as_contender", section: "__title__" }));
  });

  it("resolves bracket games, consolation games, seeds and the champion by id", () => {
    expect(resolvePath(finalFacts, "playoffs.bracket.B7.homeScore")).toBe(139.4);
    expect(resolvePath(finalFacts, "playoffs.bracket.B7.awayScore")).toBe(96.7);
    expect(resolvePath(finalFacts, "playoffs.bracket.2.games.B7.winner")).toBe("T2");
    expect(resolvePath(finalFacts, "playoffs.consolation.K4.tier")).toBe("third-place ladder");
    expect(resolvePath(finalFacts, "playoffs.seeds.T11.record")).toBe("8-6-0");
    expect(resolvePath(finalFacts, "playoffs.champion")).toBe("T2");
  });

  it("accepts a champion keyStat by id or by name, and the final's score as known numbers", () => {
    const byName = article("Chodie mcgruber won the final 139.4 to 96.7.", {
      keyStats: [
        { stat: "champion", value: "Chodie mcgruber", context: "week 17", source: "playoffs.champion" },
        { stat: "final score", value: "139.4", context: "week 17", source: "playoffs.bracket.B7.homeScore" },
      ],
    });
    expect(verifyArticle(byName, finalFacts)).toEqual([]);

    const wrongName = article("Fine.", {
      keyStats: [{ stat: "champion", value: "GLORY ASSHOLE", context: "week 17", source: "playoffs.champion" }],
    });
    expect(verifyArticle(wrongName, finalFacts)).toContainEqual(expect.objectContaining({ kind: "unverified_number" }));
  });

  it("does not call a resting team's player wrongly attributed", () => {
    const facts = buildFactsBlock(request("weekly_recap", week15Recap));
    // A player whose only FACTS line came off the unresolved side of a bye row.
    const withGhost: FactsBlock = {
      ...facts,
      matchups: [
        {
          ...facts.matchups[0],
          players: [
            ...facts.matchups[0].players,
            { id: "M1P999", name: "Bench Guy", pos: "RB", fantasyTeamId: "T?", points: 12.3, lineup: "starter" },
          ],
        },
        ...facts.matchups.slice(1),
      ],
    };
    const feature = (fantasyTeamId: string) =>
      article("Fine.", {
        featuredPlayers: [{ playerId: "M1P999", playerName: "Bench Guy", position: "RB", fantasyTeamId, nflTeam: "BUF", mentions: 1 }],
      });
    // Chodie mcgruber rested in week 15: the roster is the authority, the attribution stands.
    expect(verifyArticle(feature("T2"), withGhost).filter(violation => violation.kind === "wrong_fantasy_team")).toEqual([]);
    // Moisty Loins played: an unresolved attribution to them is still wrong.
    expect(verifyArticle(feature("T10"), withGhost)).toContainEqual(expect.objectContaining({ kind: "wrong_fantasy_team" }));
  });
});
