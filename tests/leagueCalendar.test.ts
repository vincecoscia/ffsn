/**
 * `convex/lib/leagueCalendar.ts` - pure functions, no Convex runtime needed.
 *
 * Derives against the same real ESPN fixture `tests/espnSettings.test.ts`
 * uses (`tests/fixtures/espn-settings-public-2025.json`: 14-week regular
 * season, 4 playoff teams, 2-week playoff rounds -> matchup periods 15 and
 * 16 cover NFL weeks 15-18), plus a synthetic 13-week/6-team/1-week league to
 * prove the arithmetic fallback (no `matchupPeriods` map) matches the old
 * 1:1 matchup-period-to-week assumption exactly.
 */
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/espn-settings-public-2025.json";
import { parseEspnLeagueSettings } from "../convex/lib/espnSettings";
import {
  deriveLeagueCalendar,
  leagueCalendarInputFromSettings,
  describeLeagueCalendar,
  matchupPeriodIdsFromSettings,
  type LeagueCalendarInput,
} from "../convex/lib/leagueCalendar";

describe("deriveLeagueCalendar", () => {
  describe("against the real ESPN fixture (14 regular, 4 teams, 2-week rounds)", () => {
    const parsed = parseEspnLeagueSettings(fixture.settings);
    const input: LeagueCalendarInput = {
      regularSeasonMatchupPeriods: parsed.regularSeasonMatchupPeriods!,
      playoffRounds: parsed.playoffRounds!,
      playoffMatchupPeriodLength: parsed.playoffMatchupPeriodLength!,
      matchupPeriods: parsed.matchupPeriods,
    };
    const calendar = deriveLeagueCalendar(input);

    it("uses the matchupPeriods map so the 2-week rounds count as NFL weeks 15-18", () => {
      expect(calendar.lastRegularSeasonWeek).toBe(14);
      expect(calendar.playoffStartWeek).toBe(15);
      expect(calendar.championshipWeeks).toEqual([17, 18]);
      expect(calendar.seasonEndWeek).toBe(18);
    });

    it("derives mid-season and playoff-picture weeks arithmetically off the regular season length", () => {
      expect(calendar.midSeasonWeek).toBe(7); // ceil(14/2)
      expect(calendar.playoffPictureWeeks).toEqual([12, 13, 14]);
    });

    it("matches parseEspnLeagueSettings's own fantasyChampionshipWeek (18)", () => {
      expect(calendar.seasonEndWeek).toBe(18);
    });
  });

  describe("a 13-week/6-team/1-week league (no matchupPeriods map - arithmetic fallback)", () => {
    // playoffTeamCount 6 -> ceil(log2(6)) = 3 rounds, all 1 week each - the
    // fallback should behave exactly like the old 1:1 period===week mapping.
    const input: LeagueCalendarInput = {
      regularSeasonMatchupPeriods: 13,
      playoffRounds: 3,
      playoffMatchupPeriodLength: 1,
    };
    const calendar = deriveLeagueCalendar(input);

    it("treats every playoff round as exactly one NFL week", () => {
      expect(calendar.lastRegularSeasonWeek).toBe(13);
      expect(calendar.playoffStartWeek).toBe(14);
      // 3 rounds x 1 week starting week 14 -> weeks 14,15,16; championship is the last one.
      expect(calendar.championshipWeeks).toEqual([16]);
      expect(calendar.seasonEndWeek).toBe(16);
    });

    it("derives mid-season and playoff-picture weeks off the 13-week regular season", () => {
      expect(calendar.midSeasonWeek).toBe(7); // ceil(13/2)
      expect(calendar.playoffPictureWeeks).toEqual([11, 12, 13]);
    });
  });

  it("an irregular map (e.g. a 3-week final round) overrides the arithmetic assumption", () => {
    const input: LeagueCalendarInput = {
      regularSeasonMatchupPeriods: 10,
      playoffRounds: 2,
      playoffMatchupPeriodLength: 1, // arithmetic alone would predict a 1-week final
      matchupPeriods: {
        "10": [10],
        "11": [11],
        "12": [12, 13, 14], // ESPN reported a 3-week championship round
      },
    };
    const calendar = deriveLeagueCalendar(input);
    expect(calendar.championshipWeeks).toEqual([12, 13, 14]);
    expect(calendar.seasonEndWeek).toBe(14);
  });
});

describe("leagueCalendarInputFromSettings", () => {
  it("reads the three required numeric fields plus matchupPeriods off a leagueSeasons.settings-shaped blob", () => {
    const input = leagueCalendarInputFromSettings({
      name: "Test League",
      regularSeasonMatchupPeriods: 14,
      playoffRounds: 2,
      playoffMatchupPeriodLength: 2,
      matchupPeriods: { "14": [14], "15": [15, 16], "16": [17, 18] },
    });
    expect(input).toEqual({
      regularSeasonMatchupPeriods: 14,
      playoffRounds: 2,
      playoffMatchupPeriodLength: 2,
      matchupPeriods: { "14": [14], "15": [15, 16], "16": [17, 18] },
    });
  });

  it("returns undefined when settings is null/undefined/not an object", () => {
    expect(leagueCalendarInputFromSettings(undefined)).toBeUndefined();
    expect(leagueCalendarInputFromSettings(null)).toBeUndefined();
    expect(leagueCalendarInputFromSettings("garbage")).toBeUndefined();
  });

  it("returns undefined when any of the three required numeric fields is missing (legacy-only settings, no re-sync yet)", () => {
    expect(
      leagueCalendarInputFromSettings({
        name: "Legacy League",
        regularSeasonMatchupPeriods: 14,
        playoffTeamCount: 6,
        playoffWeeks: 3, // legacy count field, not the new playoffRounds/playoffMatchupPeriodLength pair
      })
    ).toBeUndefined();
  });

  it("omits matchupPeriods (rather than throwing) when it is present but malformed", () => {
    const input = leagueCalendarInputFromSettings({
      regularSeasonMatchupPeriods: 13,
      playoffRounds: 3,
      playoffMatchupPeriodLength: 1,
      matchupPeriods: "not-a-record",
    });
    expect(input?.matchupPeriods).toBeUndefined();
    expect(input?.regularSeasonMatchupPeriods).toBe(13);
  });
});

describe("describeLeagueCalendar", () => {
  it("formats the one-line per-league summary (spec: log which path was used)", () => {
    const calendar = deriveLeagueCalendar({
      regularSeasonMatchupPeriods: 14,
      playoffRounds: 2,
      playoffMatchupPeriodLength: 2,
      matchupPeriods: { "14": [14], "15": [15, 16], "16": [17, 18] },
    });
    const summary = describeLeagueCalendar(calendar, {
      regularSeasonMatchupPeriods: 14,
      playoffTeamCount: 4,
      playoffMatchupPeriodLength: 2,
    });
    expect(summary).toBe(
      "14-week regular season, 4 playoff teams, 2-week rounds -> " +
        "playoff picture wks 12-14, awards wk 7, hall of shame wk 14, " +
        "championship wks 17-18, recap after wk 18"
    );
  });
});

describe("matchupPeriodIdsFromSettings", () => {
  it("tier 1: uses the exact matchupPeriods map keys, sorted, against the real fixture (16 periods, not 18)", () => {
    const parsed = parseEspnLeagueSettings(fixture.settings);
    const ids = matchupPeriodIdsFromSettings({
      regularSeasonMatchupPeriods: parsed.regularSeasonMatchupPeriods,
      playoffRounds: parsed.playoffRounds,
      playoffMatchupPeriodLength: parsed.playoffMatchupPeriodLength,
      matchupPeriods: parsed.matchupPeriods,
    });
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("tier 2: regularSeasonMatchupPeriods + playoffRounds x playoffMatchupPeriodLength when no map is present", () => {
    const ids = matchupPeriodIdsFromSettings({
      regularSeasonMatchupPeriods: 14,
      playoffRounds: 2,
      playoffMatchupPeriodLength: 2,
    });
    expect(ids).toHaveLength(18); // 14 + 2*2, deliberately generous vs. the true 16 periods
    expect(ids[0]).toBe(1);
    expect(ids[ids.length - 1]).toBe(18);
  });

  it("tier 3: the historic 14 + 4 default when nothing is available", () => {
    expect(matchupPeriodIdsFromSettings(undefined)).toHaveLength(18);
    expect(matchupPeriodIdsFromSettings({})).toHaveLength(18);
  });

  it("tier 3: honors an explicit legacy playoffWeeks count when the new fields are absent", () => {
    const ids = matchupPeriodIdsFromSettings({ regularSeasonMatchupPeriods: 13, playoffWeeks: 3 });
    expect(ids).toHaveLength(16);
  });
});
