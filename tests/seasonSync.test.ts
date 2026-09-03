/**
 * `convex/lib/seasonSyncPlan.ts` - pure functions, no Convex runtime needed (same style as
 * `tests/playoffs.test.ts`, which this file's bracket fixture is trimmed from: the real 2025 prod
 * bracket for league `jn74dn16bts1gg94596srgsvh17nevtq` - 10 teams, 6 playoff teams, 3 single-week
 * rounds, championship decided week 17 with Chodie mcgruber over GLORY ASSHOLE).
 */
import { describe, expect, it } from "vitest";
import {
  rangeInclusive,
  recheckDue,
  seasonClosePlan,
  seasonIsDecided,
  weeksReadyToClose,
} from "../convex/lib/seasonSyncPlan";
import type { PlayoffFormatInput, PlayoffMatchupInput, PlayoffTeamInput } from "../convex/lib/playoffs";

const CHODIE = "2"; // seed 1, champion
const STINKY = "8"; // seed 2
const GLORY = "11"; // seed 3, runner-up

// FORMAT below is a 6-team playoff field, so the fixture needs all 6 seeds (not just the three
// that appear in MATCHUPS) - buildPlayoffContext's round-one slate pairs every seed 1-6 even in a
// league with zero playoff matchups synced yet (the "projected"/no-data case a real season starts
// in), and seeds 4-6 here never actually play a synced game in this fixture.
const TEAMS: PlayoffTeamInput[] = [
  { externalId: CHODIE, name: "Chodie mcgruber", record: { wins: 10, losses: 4, ties: 0, pointsFor: 1600, playoffSeed: 1 } },
  { externalId: STINKY, name: "The Stinky Faggots", record: { wins: 10, losses: 4, ties: 0, pointsFor: 1580, playoffSeed: 2 } },
  { externalId: GLORY, name: "GLORY ASSHOLE", record: { wins: 8, losses: 6, ties: 0, pointsFor: 1550, playoffSeed: 3 } },
  { externalId: "3", name: "IR Squad", record: { wins: 8, losses: 6, ties: 0, pointsFor: 1530, playoffSeed: 4 } },
  { externalId: "10", name: "Moisty Loins", record: { wins: 7, losses: 7, ties: 0, pointsFor: 1500, playoffSeed: 5 } },
  { externalId: "12", name: "IM NOT GAY", record: { wins: 7, losses: 7, ties: 0, pointsFor: 1480, playoffSeed: 6 } },
];

// Round one (wk15): CHODIE and STINKY bye. Round two (wk16): CHODIE beats a round-one winner,
// GLORY beats STINKY. Championship (wk17): CHODIE beats GLORY - matches tests/playoffs.test.ts.
const MATCHUPS: PlayoffMatchupInput[] = [
  { matchupPeriod: 15, homeTeamId: CHODIE, awayTeamId: "", homeScore: 130.5, awayScore: 0, playoffTier: "WINNERS_BRACKET" },
  { matchupPeriod: 15, homeTeamId: STINKY, awayTeamId: "", homeScore: 128.0, awayScore: 0, playoffTier: "WINNERS_BRACKET" },
  { matchupPeriod: 15, homeTeamId: GLORY, awayTeamId: "12", homeScore: 127.12, awayScore: 120.16, winner: "home", playoffTier: "WINNERS_BRACKET" },
  { matchupPeriod: 15, homeTeamId: "10", awayTeamId: "3", homeScore: 145.2, awayScore: 115.1, winner: "home", playoffTier: "WINNERS_BRACKET" },
  { matchupPeriod: 16, homeTeamId: CHODIE, awayTeamId: "10", homeScore: 187.32, awayScore: 171.86, winner: "home", playoffTier: "WINNERS_BRACKET" },
  { matchupPeriod: 16, homeTeamId: GLORY, awayTeamId: STINKY, homeScore: 143.48, awayScore: 137.2, winner: "home", playoffTier: "WINNERS_BRACKET" },
  { matchupPeriod: 17, homeTeamId: CHODIE, awayTeamId: GLORY, homeScore: 139.38, awayScore: 96.66, winner: "home", playoffTier: "WINNERS_BRACKET" },
];

const FORMAT: PlayoffFormatInput = { playoffTeamCount: 6, regularSeasonMatchupPeriods: 14, playoffMatchupPeriodLength: 1 };

describe("rangeInclusive", () => {
  it("builds an ascending inclusive range", () => {
    expect(rangeInclusive(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(rangeInclusive(4, 4)).toEqual([4]);
  });
});

describe("weeksReadyToClose", () => {
  it("sorts ascending and dedupes", () => {
    const ready = weeksReadyToClose({
      seasonEndWeek: 17,
      finalWeeks: [3, 1, 2, 1, 3],
      periodsFinal: [],
    });
    expect(ready).toEqual([1, 2, 3]);
  });

  it("drops weeks already recorded in periodsFinal", () => {
    const ready = weeksReadyToClose({
      seasonEndWeek: 17,
      finalWeeks: [1, 2, 3, 4],
      periodsFinal: [1, 2],
    });
    expect(ready).toEqual([3, 4]);
  });

  it("ignores a final week outside the league's own season (defensive - isWeekFinal is never blindly trusted)", () => {
    const ready = weeksReadyToClose({
      seasonEndWeek: 17,
      finalWeeks: [17, 18, 0, -1],
      periodsFinal: [],
    });
    expect(ready).toEqual([17]);
  });

  it("is empty once every final week is already closed", () => {
    const ready = weeksReadyToClose({
      seasonEndWeek: 3,
      finalWeeks: [1, 2, 3],
      periodsFinal: [1, 2, 3],
    });
    expect(ready).toEqual([]);
  });
});

describe("seasonIsDecided", () => {
  it("is decided once the championship game is final, with the bracket's champion/runnerUp", () => {
    const result = seasonIsDecided({ teams: TEAMS, matchups: MATCHUPS, format: FORMAT, seasonEndWeek: 17 });
    expect(result.decided).toBe(true);
    expect(result.champion?.teamId).toBe(CHODIE);
    expect(result.runnerUp?.teamId).toBe(GLORY);
  });

  it("is not decided before the championship game is played", () => {
    const result = seasonIsDecided({ teams: TEAMS, matchups: MATCHUPS, format: FORMAT, seasonEndWeek: 16 });
    expect(result.decided).toBe(false);
    expect(result.champion).toBeUndefined();
  });

  it("is not decided with no playoff matchups synced at all", () => {
    const result = seasonIsDecided({ teams: TEAMS, matchups: [], format: FORMAT, seasonEndWeek: 17 });
    expect(result.decided).toBe(false);
  });
});

describe("seasonClosePlan", () => {
  it("both period lists are the whole season, 1..seasonEndWeek", () => {
    const plan = seasonClosePlan({ seasonId: 2025, regularSeasonMatchupPeriods: 14, seasonEndWeek: 17 });
    expect(plan.periods).toEqual(rangeInclusive(1, 17));
    expect(plan.transactionPeriods).toEqual(rangeInclusive(1, 17));
  });

  it("shrinks with a shorter season", () => {
    const plan = seasonClosePlan({ seasonId: 2024, regularSeasonMatchupPeriods: 10, seasonEndWeek: 12 });
    expect(plan.periods).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(plan.transactionPeriods).toEqual(plan.periods);
  });
});

describe("recheckDue", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("is false when the season was never finalized", () => {
    expect(recheckDue({ finalizedAt: undefined, finalizationRecheckAt: undefined, now: Date.now() })).toBe(false);
  });

  it("is false once finalized but with no recheck scheduled (never set, or already consumed)", () => {
    expect(recheckDue({ finalizedAt: 1000, finalizationRecheckAt: undefined, now: 1000 + 8 * DAY_MS })).toBe(false);
  });

  it("is false before the 7-day mark", () => {
    const finalizedAt = 1_700_000_000_000;
    expect(
      recheckDue({ finalizedAt, finalizationRecheckAt: finalizedAt + 7 * DAY_MS, now: finalizedAt + 6 * DAY_MS }),
    ).toBe(false);
  });

  it("is true at or after the 7-day mark", () => {
    const finalizedAt = 1_700_000_000_000;
    const recheckAt = finalizedAt + 7 * DAY_MS;
    expect(recheckDue({ finalizedAt, finalizationRecheckAt: recheckAt, now: recheckAt })).toBe(true);
    expect(recheckDue({ finalizedAt, finalizationRecheckAt: recheckAt, now: recheckAt + DAY_MS })).toBe(true);
  });
});
