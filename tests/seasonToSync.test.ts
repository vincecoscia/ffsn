/**
 * `convex/lib/seasonToSync.ts` - the single "what season(s) should a routine
 * ESPN sync touch right now" helper (ESPN refresh audit, Sept 2026, section
 * 2 "Rollover"). Pure, so every boundary is exercised directly against
 * fixed `now` timestamps rather than mocking the wall clock.
 */
import { describe, expect, it } from "vitest";
import { seasonsToSync } from "../convex/lib/seasonToSync";

/** `Date.UTC` would shift these across the Aug/Jan boundaries under test in
 * some timezones; use local-time `Date` the same way `nflSeasonYearFor` and
 * `seasonsToSync` themselves do. */
const localTime = (year: number, monthIndex: number, day: number): number =>
  new Date(year, monthIndex, day).getTime();

describe("seasonsToSync", () => {
  it("Jan 3 2027 -> current 2026 (still in the 2026 season's playoffs/offseason)", () => {
    const result = seasonsToSync({
      league: null,
      seasons: [],
      now: localTime(2027, 0, 3),
    });
    expect(result.current).toBe(2026);
  });

  it("Aug 20 2026 -> current 2026 (fresh preseason)", () => {
    const result = seasonsToSync({
      league: null,
      seasons: [],
      now: localTime(2026, 7, 20),
    });
    expect(result.current).toBe(2026);
  });

  it("prefers league.espnData.seasonId over the wall clock when ESPN already rolled over ahead of it", () => {
    // July 2027 - nflSeasonYearFor says 2026, but a prior sync already
    // landed ESPN's freshly-opened 2027 shell.
    const result = seasonsToSync({
      league: { espnData: { seasonId: 2027 } },
      seasons: [],
      now: localTime(2027, 6, 15),
    });
    expect(result.current).toBe(2027);
  });

  it("ignores league.espnData.seasonId when it is NOT higher than the wall-clock season", () => {
    const result = seasonsToSync({
      league: { espnData: { seasonId: 2025 } },
      seasons: [],
      now: localTime(2026, 8, 1),
    });
    expect(result.current).toBe(2026);
  });

  it("alsoSync includes the previous season on Jan 3 2027 when it exists and is unfinalized", () => {
    const result = seasonsToSync({
      league: null,
      seasons: [{ seasonId: 2025 }, { seasonId: 2026 }],
      now: localTime(2027, 0, 3),
    });
    expect(result.current).toBe(2026);
    expect(result.alsoSync).toEqual([2025]);
  });

  it("alsoSync includes the previous season on Aug 20 2026 when it exists and is unfinalized (before Feb 15 2027)", () => {
    const result = seasonsToSync({
      league: null,
      seasons: [{ seasonId: 2025 }],
      now: localTime(2026, 7, 20),
    });
    expect(result.current).toBe(2026);
    expect(result.alsoSync).toEqual([2025]);
  });

  it("alsoSync is empty once the previous season is finalized", () => {
    const result = seasonsToSync({
      league: null,
      seasons: [{ seasonId: 2025, finalizedAt: 1_735_000_000_000 }],
      now: localTime(2026, 0, 5),
    });
    expect(result.alsoSync).toEqual([]);
  });

  it("alsoSync is empty when the previous season was never synced at all (nothing to refresh)", () => {
    const result = seasonsToSync({
      league: null,
      seasons: [],
      now: localTime(2026, 0, 5),
    });
    expect(result.alsoSync).toEqual([]);
  });

  it("alsoSync closes on Feb 15 of the year after the previous season's December", () => {
    const stillOpen = seasonsToSync({
      league: null,
      seasons: [{ seasonId: 2025 }],
      now: localTime(2027, 1, 14), // Feb 14 2027
    });
    expect(stillOpen.alsoSync).toEqual([2025]);

    const closed = seasonsToSync({
      league: null,
      seasons: [{ seasonId: 2025 }],
      now: localTime(2027, 1, 15), // Feb 15 2027
    });
    expect(closed.alsoSync).toEqual([]);
  });

  it("never includes a season two years back, even unfinalized (only the immediate previous season qualifies)", () => {
    const result = seasonsToSync({
      // 2025 (the immediate previous season) is deliberately absent - only
      // an older, two-years-back row exists.
      league: null,
      seasons: [{ seasonId: 2024 }],
      now: localTime(2027, 0, 3),
    });
    expect(result.current).toBe(2026);
    expect(result.alsoSync).toEqual([]);
  });
});
