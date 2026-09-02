import { describe, expect, it } from "vitest";
import { nflSeasonYearFor } from "../convex/lib/season";
import { nflSeasonYear } from "../src/hooks/use-league-season";

// convex/lib/season.ts (server) and src/hooks/use-league-season.ts (client)
// each implement the "which NFL season does this date belong to" rule
// independently. These must never drift apart.
describe("NFL season year resolution", () => {
  const cases: Array<[string, Date, number]> = [
    ["Jan 15 2027 (playoffs) still belongs to the 2026 season", new Date(2027, 0, 15), 2026],
    ["Jul 15 2026 (offseason) still belongs to the 2025 season", new Date(2026, 6, 15), 2025],
    ["Aug 1 2026 (preseason) starts the 2026 season", new Date(2026, 7, 1), 2026],
    ["Sep 10 2026 (Week 1) is the 2026 season", new Date(2026, 8, 10), 2026],
  ];

  it.each(cases)("%s", (_label, date, expected) => {
    expect(nflSeasonYearFor(date)).toBe(expected);
    expect(nflSeasonYear(date)).toBe(expected);
  });
});
