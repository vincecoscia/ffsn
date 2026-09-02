import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

describe("nflSeasonSetup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ensureSeason inserts the 2026 season once and is a no-op on a repeat call", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: 2026 });
    expect(first.success).toBe(true);

    const second = await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: 2026 });
    expect(second.success).toBe(false);
    expect(second.message).toMatch(/already exists/);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("nflSeasons")
        .withIndex("by_year", (q) => q.eq("year", 2026))
        .collect()
    );
    expect(rows).toHaveLength(1);
  });

  it("seeds the 2026 season with the confirmed schedule facts", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.nflSeasonSetup.ensureSeason, { year: 2026 });

    const row = await t.run((ctx) =>
      ctx.db
        .query("nflSeasons")
        .withIndex("by_year", (q) => q.eq("year", 2026))
        .first()
    );
    if (!row) throw new Error("expected a 2026 nflSeasons row to have been inserted");

    // 18 regular-season weeks + 4 playoff weeks.
    expect(row.weekBoundaries).toHaveLength(22);
    // Week 1 boundary starts Tuesday Sep 8 2026 (local), the Tuesday before
    // the earliest confirmed Week 1 kickoff.
    expect(row.weekBoundaries[0].start).toBe(new Date(2026, 8, 8).getTime());
    expect(row.weekBoundaries[0].isPlayoffs).toBe(false);
    // Regular season: Sep 10 2026 -> Jan 11 2027.
    expect(row.phases.regularSeason.start).toBe(new Date(2026, 8, 10).getTime());
    expect(row.phases.regularSeason.end).toBe(new Date(2027, 0, 11).getTime());
    // Super Bowl LXI: Feb 14 2027.
    expect(row.phases.superBowl.start).toBe(new Date(2027, 1, 14).getTime());
  });

  it("ensureCurrentSeason reports the 2026 season ensured when the clock reads 2026-09-01", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 1));

    const result = await t.mutation(internal.nflSeasonSetup.ensureCurrentSeason, {});

    expect(result.ensured).toContainEqual(
      expect.objectContaining({ year: 2026, success: true })
    );
  });
});
