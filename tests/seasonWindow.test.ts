import { describe, expect, it } from "vitest";
import {
  FALLBACK_SEASON_END_WEEK,
  resolveSeasonEndWeek,
  weeklyTargetWeekInSeason,
} from "../convex/lib/seasonWindow";

describe("resolveSeasonEndWeek", () => {
  it("falls back to 17 (14 regular + 3 single-week playoff rounds) when settings are missing or don't parse", () => {
    expect(FALLBACK_SEASON_END_WEEK).toBe(17);
    expect(resolveSeasonEndWeek(undefined)).toBe(FALLBACK_SEASON_END_WEEK);
    expect(resolveSeasonEndWeek(null)).toBe(FALLBACK_SEASON_END_WEEK);
    expect(resolveSeasonEndWeek({ size: 12, scoringType: "PPR" })).toBe(FALLBACK_SEASON_END_WEEK);
  });

  it("derives the league's real season end week from synced settings (14 reg / 4 playoff teams / 2-week rounds -> week 18)", () => {
    expect(
      resolveSeasonEndWeek({
        regularSeasonMatchupPeriods: 14,
        playoffRounds: 2,
        playoffMatchupPeriodLength: 2,
      }),
    ).toBe(18);
  });

  it("derives a 1:1 13-week regular season / 3 single-week rounds league as week 16", () => {
    expect(
      resolveSeasonEndWeek({
        regularSeasonMatchupPeriods: 13,
        playoffRounds: 3,
        playoffMatchupPeriodLength: 1,
      }),
    ).toBe(16);
  });
});

describe("weeklyTargetWeekInSeason", () => {
  const seasonEndWeek = 17;

  it("allows a recap at the league's final week (a Tuesday-morning recap's lookback-resolved target week for NFL week seasonEndWeek + 1)", () => {
    const result = weeklyTargetWeekInSeason({
      contentType: "weekly_recap",
      targetWeek: seasonEndWeek,
      seasonEndWeek,
    });
    expect(result.inSeason).toBe(true);
  });

  it("refuses a preview for the week after the season ends", () => {
    const result = weeklyTargetWeekInSeason({
      contentType: "weekly_preview",
      targetWeek: seasonEndWeek + 1,
      seasonEndWeek,
    });
    expect(result.inSeason).toBe(false);
    expect(result.reason).toMatch(/past the league's season end/);
  });

  it("refuses week 0", () => {
    const result = weeklyTargetWeekInSeason({
      contentType: "weekly_recap",
      targetWeek: 0,
      seasonEndWeek,
    });
    expect(result.inSeason).toBe(false);
    expect(result.reason).toMatch(/before the season starts/);
  });

  it("allows every week from 1 through seasonEndWeek", () => {
    for (let week = 1; week <= seasonEndWeek; week++) {
      expect(
        weeklyTargetWeekInSeason({ contentType: "power_rankings", targetWeek: week, seasonEndWeek }).inSeason,
      ).toBe(true);
    }
  });
});
