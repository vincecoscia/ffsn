import { describe, expect, it } from "vitest";
import {
  anyGameLive,
  bigLineMetricsCrossed,
  boxLineTotals,
  capEvents,
  computeFantasyPoints,
  decideReschedule,
  detectGameTransitions,
  detectMatchupTriggers,
  guessScorerName,
  isBustWatchCandidate,
  matchAthleteByName,
  nextGameStateCursor,
  parseBoxscore,
  parsePlayYards,
  parseScoreboard,
  parseScoringPlays,
  touchdownCountForPlayer,
  type BoxAthleteLine,
} from "../../convex/lib/wireLiveRules";

// Fixtures below are trimmed to the fields the parsers read, shaped exactly like the real payloads
// probed 2026-09-05 against site.web.api.espn.com/apis/site/v2/sports/football/nfl/{scoreboard,summary}
// (event 401772510, PHI @ DAL, week 1 2025 — final).

const SCOREBOARD_PRE = {
  week: { number: 1 },
  events: [
    {
      id: "401872656",
      date: "2026-09-10T00:20Z",
      competitions: [
        {
          id: "401872656",
          date: "2026-09-10T00:20Z",
          status: { type: { state: "pre", name: "STATUS_SCHEDULED" }, period: 0, displayClock: "0:00" },
          competitors: [
            { homeAway: "home", score: "0", team: { abbreviation: "SEA" } },
            { homeAway: "away", score: "0", team: { abbreviation: "NE" } },
          ],
        },
      ],
    },
  ],
};

const SCOREBOARD_LIVE = {
  week: { number: 1 },
  events: [
    {
      id: "401872656",
      date: "2026-09-10T00:20Z",
      competitions: [
        {
          id: "401872656",
          date: "2026-09-10T00:20Z",
          status: { type: { state: "in", name: "STATUS_IN_PROGRESS" }, period: 2, displayClock: "4:12" },
          competitors: [
            { homeAway: "home", score: "10", team: { abbreviation: "SEA" } },
            { homeAway: "away", score: "7", team: { abbreviation: "NE" } },
          ],
        },
      ],
    },
  ],
};

const SCOREBOARD_FINAL = {
  week: { number: 1 },
  events: [
    {
      id: "401872656",
      date: "2026-09-10T00:20Z",
      competitions: [
        {
          id: "401872656",
          date: "2026-09-10T00:20Z",
          status: { type: { state: "post", name: "STATUS_FINAL" }, period: 4, displayClock: "0:00" },
          competitors: [
            { homeAway: "home", score: "24", team: { abbreviation: "SEA" } },
            { homeAway: "away", score: "20", team: { abbreviation: "NE" } },
          ],
        },
      ],
    },
  ],
};

const SUMMARY = {
  scoringPlays: [
    {
      id: "401772510247",
      type: { text: "Rushing Touchdown" },
      text: "Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)",
      awayScore: 7,
      homeScore: 0,
      period: { number: 1 },
      clock: { displayValue: "11:49" },
      team: { abbreviation: "DAL" },
    },
    {
      id: "401772510907",
      type: { text: "Rushing Touchdown" },
      text: "Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)",
      awayScore: 14,
      homeScore: 7,
      period: { number: 2 },
      clock: { displayValue: "14:56" },
      team: { abbreviation: "DAL" },
    },
    {
      id: "4017725101782",
      type: { text: "Rushing Touchdown" },
      text: "Saquon Barkley 10 Yd Rush (Jake Elliott Kick)",
      awayScore: 17,
      homeScore: 21,
      period: { number: 2 },
      clock: { displayValue: "0:51" },
      team: { abbreviation: "PHI" },
    },
  ],
  boxscore: {
    players: [
      {
        team: { abbreviation: "DAL" },
        statistics: [
          {
            name: "passing",
            keys: ["completions/passingAttempts", "passingYards", "yardsPerPassAttempt", "passingTouchdowns", "interceptions"],
            labels: ["C/ATT", "YDS", "AVG", "TD", "INT"],
            athletes: [
              {
                athlete: { id: "2577417", firstName: "Dak", lastName: "Prescott", displayName: "Dak Prescott" },
                stats: ["21/34", "188", "5.5", "0", "0"],
              },
            ],
          },
          {
            name: "rushing",
            keys: ["rushingAttempts", "rushingYards", "yardsPerRushAttempt", "rushingTouchdowns", "longRushing"],
            labels: ["CAR", "YDS", "AVG", "TD", "LONG"],
            athletes: [
              {
                athlete: { id: "4361579", firstName: "Javonte", lastName: "Williams", displayName: "Javonte Williams" },
                stats: ["15", "104", "6.9", "2", "11"],
              },
            ],
          },
          {
            name: "receiving",
            keys: ["receptions", "receivingYards", "yardsPerReception", "receivingTouchdowns", "longReception", "receivingTargets"],
            labels: ["REC", "YDS", "AVG", "TD", "LONG", "TGTS"],
            athletes: [
              {
                athlete: { id: "4241389", firstName: "CeeDee", lastName: "Lamb", displayName: "CeeDee Lamb" },
                stats: ["7", "110", "15.7", "0", "32", "13"],
              },
            ],
          },
          {
            name: "fumbles",
            keys: ["fumbles", "fumblesLost", "fumblesRecovered"],
            labels: ["FUM", "LOST", "REC"],
            athletes: [
              {
                athlete: { id: "4045163", firstName: "Miles", lastName: "Sanders", displayName: "Miles Sanders" },
                stats: ["1", "1", "0"],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("wireLiveRules — scoreboard", () => {
  it("parses pre/in/post games with scores, period and clock", () => {
    const [pre] = parseScoreboard(SCOREBOARD_PRE);
    expect(pre).toMatchObject({ eventId: "401872656", state: "pre", homeAbbrev: "SEA", awayAbbrev: "NE", homeScore: 0, awayScore: 0 });
    expect(pre.kickoffAt).toBe(Date.parse("2026-09-10T00:20Z"));

    const [live] = parseScoreboard(SCOREBOARD_LIVE);
    expect(live).toMatchObject({ state: "in", homeScore: 10, awayScore: 7, period: 2, clock: "4:12" });

    const [final] = parseScoreboard(SCOREBOARD_FINAL);
    expect(final).toMatchObject({ state: "post", homeScore: 24, awayScore: 20 });
  });

  it("drops an event with no recognizable state or team abbreviation instead of throwing", () => {
    expect(parseScoreboard({ events: [{ competitions: [{ status: { type: {} } }] }] })).toEqual([]);
    expect(parseScoreboard(null)).toEqual([]);
    expect(parseScoreboard({})).toEqual([]);
  });

  it("reports whether any game is live", () => {
    expect(anyGameLive(parseScoreboard(SCOREBOARD_PRE))).toBe(false);
    expect(anyGameLive(parseScoreboard(SCOREBOARD_LIVE))).toBe(true);
  });
});

describe("wireLiveRules — game transitions", () => {
  it("never posts on a cold start (no prior cursor)", () => {
    const games = parseScoreboard(SCOREBOARD_LIVE);
    expect(detectGameTransitions(games, {}, true)).toEqual([]);
  });

  it("fires game_started on pre->in and game_final on in->post", () => {
    const pre = parseScoreboard(SCOREBOARD_PRE);
    const preCursor = nextGameStateCursor(pre);

    const live = parseScoreboard(SCOREBOARD_LIVE);
    expect(detectGameTransitions(live, preCursor, false)).toEqual([{ eventId: "401872656", kind: "game_started" }]);

    const liveCursor = nextGameStateCursor(live);
    const final = parseScoreboard(SCOREBOARD_FINAL);
    expect(detectGameTransitions(final, liveCursor, false)).toEqual([{ eventId: "401872656", kind: "game_final" }]);

    // A repeat "in" tick against an "in" cursor fires nothing.
    expect(detectGameTransitions(live, liveCursor, false)).toEqual([]);
  });

  it("waits for a real prior state before firing (a game unseen last tick)", () => {
    const live = parseScoreboard(SCOREBOARD_LIVE);
    expect(detectGameTransitions(live, {}, false)).toEqual([]);
  });
});

describe("wireLiveRules — scoring plays", () => {
  it("parses id, type, text, scores, period, clock and team", () => {
    const plays = parseScoringPlays(SUMMARY);
    expect(plays).toHaveLength(3);
    expect(plays[0]).toMatchObject({
      id: "401772510247",
      typeText: "Rushing Touchdown",
      text: "Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)",
      awayScore: 7,
      homeScore: 0,
      period: 1,
      clock: "11:49",
      teamAbbrev: "DAL",
    });
  });

  it("parses yards and guesses the scorer's name from the play text", () => {
    expect(parsePlayYards("Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)")).toBe(1);
    expect(parsePlayYards("Quentin Johnston 5 Yd pass from Justin Herbert (Cameron Dicker Kick)")).toBe(5);
    expect(parsePlayYards("no yardage here")).toBeUndefined();

    expect(guessScorerName("Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)")).toEqual({
      fullName: "Javonte Williams",
      firstInitial: "J",
      lastName: "Williams",
    });
    expect(guessScorerName("Quentin Johnston 5 Yd pass from Justin Herbert (Cameron Dicker Kick)")).toMatchObject({
      lastName: "Johnston",
      firstInitial: "Q",
    });
    expect(guessScorerName("garbage text")).toBeUndefined();
  });

  it("counts a player's touchdowns so far today by name, scoped to his team", () => {
    const plays = parseScoringPlays(SUMMARY);
    const guess = guessScorerName(plays[1].text)!; // Javonte Williams, 2nd TD
    expect(touchdownCountForPlayer(plays, "DAL", guess, 1)).toBe(2);
    expect(touchdownCountForPlayer(plays, "DAL", guess, 0)).toBe(1);

    const barkley = guessScorerName(plays[2].text)!;
    expect(touchdownCountForPlayer(plays, "PHI", barkley, 2)).toBe(1);
  });
});

describe("wireLiveRules — boxscore + fantasy points", () => {
  it("parses per-athlete stats keyed by each group's own semantic keys", () => {
    const athletes = parseBoxscore(SUMMARY);
    const williams = athletes.find((a) => a.espnId === "4361579")!;
    expect(williams.stats.rushing).toMatchObject({ rushingYards: 104, rushingTouchdowns: 2 });
    expect(williams.teamAbbrev).toBe("DAL");

    const lamb = athletes.find((a) => a.espnId === "4241389")!;
    expect(lamb.stats.receiving).toMatchObject({ receivingYards: 110, receivingTouchdowns: 0 });
  });

  it("matches an athlete by last name + first initial", () => {
    const athletes = parseBoxscore(SUMMARY);
    const guess = guessScorerName("Javonte Williams 1 Yd Rush (Brandon Aubrey Kick)")!;
    expect(matchAthleteByName(athletes, guess)?.espnId).toBe("4361579");
    expect(matchAthleteByName(athletes, { fullName: "Nobody Home", firstInitial: "N", lastName: "Home" })).toBeUndefined();
  });

  it("computes ESPN-standard (non-PPR) fantasy points from a box line", () => {
    const athletes = parseBoxscore(SUMMARY);
    const williams = athletes.find((a) => a.espnId === "4361579")!;
    // 104 rush yds * 0.1 + 2 TD * 6 = 10.4 + 12 = 22.4
    expect(computeFantasyPoints(williams.stats)).toBeCloseTo(22.4, 5);

    const prescott = athletes.find((a) => a.espnId === "2577417")!;
    // 188 pass yds * 0.04 = 7.52 -> rounded to 7.5
    expect(computeFantasyPoints(prescott.stats)).toBeCloseTo(7.5, 5);

    const empty: BoxAthleteLine["stats"] = {};
    expect(computeFantasyPoints(empty)).toBe(0);
  });

  it("reports the totals a line rolled up across groups", () => {
    const athletes = parseBoxscore(SUMMARY);
    const williams = athletes.find((a) => a.espnId === "4361579")!;
    expect(boxLineTotals(williams.stats)).toMatchObject({ rushYds: 104, rushTd: 2, passYds: 0, fumblesLost: 0 });
  });
});

describe("wireLiveRules — big_line / bust_watch", () => {
  it("flags a big line only for the metrics actually crossed", () => {
    const athletes = parseBoxscore(SUMMARY);
    const williams = athletes.find((a) => a.espnId === "4361579")!;
    // 104 rush yds >= 100, 2 TD < 3 -> only rush_rec_yds
    expect(bigLineMetricsCrossed(williams.stats)).toEqual([{ metric: "rush_rec_yds", value: 104 }]);

    const bigDay: BoxAthleteLine["stats"] = { rushing: { rushingYards: 150, rushingTouchdowns: 3 } };
    expect(bigLineMetricsCrossed(bigDay).map((h) => h.metric).sort()).toEqual(["rush_rec_yds", "td"]);

    const quiet: BoxAthleteLine["stats"] = { rushing: { rushingYards: 40, rushingTouchdowns: 0 } };
    expect(bigLineMetricsCrossed(quiet)).toEqual([]);
  });

  it("combines rushing + receiving yards toward the 100-yard line", () => {
    const stats: BoxAthleteLine["stats"] = { rushing: { rushingYards: 60 }, receiving: { receivingYards: 45 } };
    expect(bigLineMetricsCrossed(stats)).toEqual([{ metric: "rush_rec_yds", value: 105 }]);
  });

  it("flags a bust only for a top-24 ADP player under 5 points", () => {
    expect(isBustWatchCandidate(12, 3.2)).toBe(true);
    expect(isBustWatchCandidate(24, 4.9)).toBe(true);
    expect(isBustWatchCandidate(25, 2)).toBe(false); // outside top 24
    expect(isBustWatchCandidate(12, 5)).toBe(false); // not under 5
    expect(isBustWatchCandidate(undefined, 1)).toBe(false); // no ADP known
  });
});

describe("wireLiveRules — matchup_live triggers", () => {
  it("fires nothing on a matchup's first pull (no prior snapshot)", () => {
    expect(detectMatchupTriggers(undefined, { homeScore: 50, awayScore: 10 })).toEqual([]);
  });

  it("detects a lead change only when both scores are on the board", () => {
    expect(detectMatchupTriggers({ homeScore: 10, awayScore: 20 }, { homeScore: 25, awayScore: 20 })).toEqual(["lead_change"]);
    // 0-0 to 7-0 is not a "change" - there was no prior leader.
    expect(detectMatchupTriggers({ homeScore: 0, awayScore: 0 }, { homeScore: 7, awayScore: 0 })).toEqual([]);
  });

  it("detects a blowout only the tick the margin first crosses the line", () => {
    expect(detectMatchupTriggers({ homeScore: 20, awayScore: 10 }, { homeScore: 55, awayScore: 10 })).toEqual(["blowout"]);
    // Already over the line last tick - no repeat.
    expect(detectMatchupTriggers({ homeScore: 45, awayScore: 0 }, { homeScore: 52, awayScore: 0 })).toEqual([]);
  });

  it("detects a comeback when the trailing-by-25+ team takes the lead", () => {
    const triggers = detectMatchupTriggers({ homeScore: 10, awayScore: 40 }, { homeScore: 45, awayScore: 40 });
    expect(triggers.sort()).toEqual(["comeback", "lead_change"]);
    // Trailed by less than the comeback threshold - not a comeback, but still a lead change.
    expect(detectMatchupTriggers({ homeScore: 30, awayScore: 40 }, { homeScore: 45, awayScore: 40 })).toEqual(["lead_change"]);
  });
});

describe("wireLiveRules — reschedule", () => {
  it("ticks again in GAME_CLOCK_TICK_MS while any game is live", () => {
    const decision = decideReschedule({ anyLive: true, nextKickoffAt: undefined, now: 1000 });
    expect(decision).toEqual({ mode: "live", delayMs: 60_000 });
  });

  it("wakes 5 minutes before the next kickoff when nothing is live", () => {
    const now = 1_000_000;
    const kickoff = now + 3 * 60 * 60 * 1000;
    expect(decideReschedule({ anyLive: false, nextKickoffAt: kickoff, now })).toEqual({
      mode: "prekickoff",
      runAt: kickoff - 5 * 60 * 1000,
    });
  });

  it("never schedules a wake-up in the past", () => {
    const now = 1_000_000;
    expect(decideReschedule({ anyLive: false, nextKickoffAt: now - 1000, now })).toEqual({ mode: "prekickoff", runAt: now });
  });

  it("stops the clock when nothing is live and no kickoff is within range", () => {
    expect(decideReschedule({ anyLive: false, nextKickoffAt: undefined, now: 0 })).toEqual({ mode: "stop" });
  });
});

describe("wireLiveRules — event cap", () => {
  it("keeps at most `max` events and reports how many were dropped", () => {
    const events = Array.from({ length: 45 }, (_, i) => i);
    const { kept, dropped } = capEvents(events, 40);
    expect(kept).toHaveLength(40);
    expect(dropped).toBe(5);
    expect(kept[0]).toBe(0);
  });

  it("keeps everything when under the cap", () => {
    const { kept, dropped } = capEvents([1, 2, 3], 40);
    expect(kept).toEqual([1, 2, 3]);
    expect(dropped).toBe(0);
  });
});
