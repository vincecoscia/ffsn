import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { IntelUpsertRow } from "../convex/intelSync";

/** A `playerIntel` row shape for direct seeding: the sync's upsert row plus `fetchedAt` (normally stamped by `upsertPlayerIntelBatch`, set explicitly here to control freshness in tests). */
type SeedIntelRow = IntelUpsertRow & { fetchedAt: number };

const modules = import.meta.glob("../convex/**/*.*s");

const SEASON = 2026;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0); // 2026-09-05T12:00:00Z
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY_MS;
const isoDaysAgo = (n: number) => new Date(daysAgo(n)).toISOString();

/**
 * `getIntelForPlayers` reads two tables directly (`playerIntel`,
 * `playersEnhanced`) plus a shared 30-day `espnNews` scan - this exercises
 * the whole read path the way `convex/aiQueries.ts` will call it during
 * article generation, not just the pure freshness policy (see
 * tests/intelFreshness.test.ts for that).
 */

async function seedPlayerEnhanced(
  t: ReturnType<typeof convexTest>,
  args: { espnId: string; fullName: string; position?: string; team?: string; injuryStatus?: string },
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("playersEnhanced", {
      espnId: args.espnId,
      season: SEASON,
      fullName: args.fullName,
      defaultPositionId: 4,
      defaultPosition: args.position ?? "WR",
      eligibleSlots: [],
      eligiblePositions: [args.position ?? "WR"],
      proTeamId: 1,
      proTeamAbbrev: args.team,
      active: true,
      injured: false,
      injuryStatus: args.injuryStatus,
      droppable: true,
      ownership: { percentOwned: 50, percentStarted: 40 },
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedIntel(t: ReturnType<typeof convexTest>, rows: SeedIntelRow[]) {
  await t.run(async (ctx) => {
    for (const row of rows) {
      await ctx.db.insert("playerIntel", row);
    }
  });
}

async function seedNews(
  t: ReturnType<typeof convexTest>,
  args: { espnId: string; athleteEspnId: number; headline: string; published: string },
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("espnNews", {
      espnId: args.espnId,
      type: "Story",
      headline: args.headline,
      description: `${args.headline} description`,
      lastModified: args.published,
      published: args.published,
      premium: false,
      links: { web: `https://espn.com/story/${args.espnId}` },
      images: [],
      categories: {
        teams: [],
        athletes: [{ id: args.athleteEspnId, name: "Some Athlete" }],
        leagues: [{ id: 28, name: "NFL" }],
      },
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("intel.getIntelForPlayers", () => {
  it("assembles injury (with ESPN disagreement visible), practice, depth chart, market+trending, and news for a player with fresh data everywhere", async () => {
    const t = convexTest(schema, modules);
    await seedPlayerEnhanced(t, { espnId: "100", fullName: "Test Player", position: "RB", team: "CHI", injuryStatus: "ACTIVE" });
    await seedIntel(t, [
      { espnId: "100", season: SEASON, source: "sleeper", kind: "injury", fetchedAt: daysAgo(1), injuryStatus: "Questionable", injuryBodyPart: "Ankle" },
      { espnId: "100", season: SEASON, source: "sleeper", kind: "practice", fetchedAt: daysAgo(1), practiceStatus: "Limited Participation in Practice" },
      { espnId: "100", season: SEASON, source: "sleeper", kind: "depth_chart", fetchedAt: daysAgo(2), team: "CHI", depthPosition: "RB", depthOrder: 1 },
      { espnId: "100", season: SEASON, source: "ffc", kind: "market", fetchedAt: daysAgo(3), market: "ppr-12", adp: 15.4, adpPositionRank: 6, bye: 7, timesDrafted: 900 },
      { espnId: "100", season: SEASON, source: "sleeper", kind: "trending", fetchedAt: daysAgo(0), trendingAdds: 3000 },
    ]);
    await seedNews(t, { espnId: "n1", athleteEspnId: 100, headline: "Player X practices in full", published: isoDaysAgo(1) });

    const result = await t.query(internal.intel.getIntelForPlayers, { season: SEASON, espnIds: ["100"], now: NOW });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      espnId: "100",
      name: "Test Player",
      injury: {
        status: "Questionable",
        bodyPart: "Ankle",
        practice: "Limited Participation in Practice",
        source: "sleeper",
        espnStatus: "ACTIVE", // ESPN disagrees with Sleeper - both visible
      },
      depthChart: { team: "CHI", position: "RB", order: 1, source: "sleeper" },
      market: { market: "ppr-12", ffcAdp: 15.4, ffcPositionRank: 6, bye: 7, timesDrafted: 900, trendingAdds: 3000 },
    });
    expect(result[0].news).toEqual([
      {
        headline: "Player X practices in full",
        description: "Player X practices in full description",
        publishedAt: isoDaysAgo(1),
        url: "https://espn.com/story/n1",
        source: "espn",
      },
    ]);
  });

  it("returns an all-undefined/empty entry for a healthy player with no intel or news rows", async () => {
    const t = convexTest(schema, modules);
    await seedPlayerEnhanced(t, { espnId: "200", fullName: "Healthy Player" });

    const result = await t.query(internal.intel.getIntelForPlayers, { season: SEASON, espnIds: ["200"], now: NOW });

    expect(result).toEqual([{ espnId: "200", name: "Healthy Player", injury: undefined, depthChart: undefined, market: undefined, news: [] }]);
  });

  it("drops a stale injury row and stale news (no active injury, so the 7-day window applies)", async () => {
    const t = convexTest(schema, modules);
    await seedPlayerEnhanced(t, { espnId: "300", fullName: "Stale Player" });
    await seedIntel(t, [{ espnId: "300", season: SEASON, source: "sleeper", kind: "injury", fetchedAt: daysAgo(10), injuryStatus: "Questionable" }]);
    await seedNews(t, { espnId: "n2", athleteEspnId: 300, headline: "Old story", published: isoDaysAgo(10) });

    const result = await t.query(internal.intel.getIntelForPlayers, { season: SEASON, espnIds: ["300"], now: NOW });

    expect(result[0].injury).toBeUndefined();
    expect(result[0].news).toEqual([]);
  });

  it("keeps news attribution per-player when the shared 30-day scan sees multiple players' articles", async () => {
    const t = convexTest(schema, modules);
    await seedPlayerEnhanced(t, { espnId: "400", fullName: "Player Four" });
    await seedPlayerEnhanced(t, { espnId: "401", fullName: "Player Five" });
    await seedNews(t, { espnId: "n3", athleteEspnId: 400, headline: "About player four", published: isoDaysAgo(1) });
    await seedNews(t, { espnId: "n4", athleteEspnId: 401, headline: "About player five", published: isoDaysAgo(1) });

    const result = await t.query(internal.intel.getIntelForPlayers, { season: SEASON, espnIds: ["400", "401"], now: NOW });

    const byId = new Map(result.map((r) => [r.espnId, r]));
    expect(byId.get("400")?.news.map((n) => n.headline)).toEqual(["About player four"]);
    expect(byId.get("401")?.news.map((n) => n.headline)).toEqual(["About player five"]);
  });

  it("caps the number of players processed at 250", async () => {
    const t = convexTest(schema, modules);
    const ids = Array.from({ length: 260 }, (_, i) => `id-${i}`);

    const result = await t.query(internal.intel.getIntelForPlayers, { season: SEASON, espnIds: ids, now: NOW });

    expect(result).toHaveLength(250);
    expect(result.map((r) => r.espnId)).toEqual(ids.slice(0, 250));
  });

  it("returns an empty array for an empty espnIds list", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(internal.intel.getIntelForPlayers, { season: SEASON, espnIds: [], now: NOW });
    expect(result).toEqual([]);
  });
});

describe("getIntelForPlayers - season fallback (offseason / dynasty drafts)", () => {
  it("reads last season's injury, depth and board rows when the requested season has none, and labels the board's season", async () => {
    const t = convexTest(schema, modules);
    await seedPlayerEnhanced(t, { espnId: "900", fullName: "Offseason Back", position: "RB", team: "DET" });
    await seedIntel(t, [
      { espnId: "900", season: SEASON - 1, source: "sleeper", kind: "injury", injuryStatus: "Questionable", injuryBodyPart: "Knee", fetchedAt: daysAgo(1) },
      { espnId: "900", season: SEASON - 1, source: "sleeper", kind: "depth_chart", depthPosition: "RB", depthOrder: 1, fetchedAt: daysAgo(1) },
      { espnId: "900", season: SEASON - 1, source: "ffc", kind: "market", market: "ppr-12", adp: 8.5, adpPositionRank: 4, fetchedAt: daysAgo(2) },
    ]);
    const [entry] = await t.query(internal.intel.getIntelForPlayers, { season: SEASON, espnIds: ["900"], now: NOW });
    expect(entry?.injury).toMatchObject({ status: "Questionable", bodyPart: "Knee", source: "sleeper" });
    expect(entry?.depthChart).toMatchObject({ position: "RB", order: 1 });
    expect(entry?.market).toMatchObject({ ffcAdp: 8.5, season: SEASON - 1 });
  });

  it("prefers this season's rows and does not mix in last season's when they exist", async () => {
    const t = convexTest(schema, modules);
    await seedPlayerEnhanced(t, { espnId: "901", fullName: "Current Back", position: "RB", team: "DET" });
    await seedIntel(t, [
      { espnId: "901", season: SEASON, source: "sleeper", kind: "injury", injuryStatus: undefined, fetchedAt: daysAgo(1) },
      { espnId: "901", season: SEASON - 1, source: "sleeper", kind: "injury", injuryStatus: "Out", fetchedAt: daysAgo(1) },
      { espnId: "901", season: SEASON, source: "ffc", kind: "market", market: "ppr-12", adp: 3.1, adpPositionRank: 2, fetchedAt: daysAgo(1) },
      { espnId: "901", season: SEASON - 1, source: "ffc", kind: "market", market: "ppr-12", adp: 40, adpPositionRank: 20, fetchedAt: daysAgo(1) },
    ]);
    const [entry] = await t.query(internal.intel.getIntelForPlayers, { season: SEASON, espnIds: ["901"], now: NOW });
    expect(entry?.injury).toBeUndefined();
    expect(entry?.market).toMatchObject({ ffcAdp: 3.1, season: SEASON });
  });
});
