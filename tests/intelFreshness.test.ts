import { describe, expect, it } from "vitest";
import { FreshIntelRow, FreshNewsRow, selectFreshIntel } from "../convex/lib/intelFreshness";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0); // 2026-09-05T12:00:00Z, a fixed "now" for every test

const daysAgo = (n: number) => NOW - n * DAY_MS;
const hoursAgo = (n: number) => NOW - n * HOUR_MS;
const isoDaysAgo = (n: number) => new Date(daysAgo(n)).toISOString();

function injuryRow(overrides: Partial<FreshIntelRow>): FreshIntelRow {
  return { source: "sleeper", kind: "injury", fetchedAt: daysAgo(1), ...overrides };
}

describe("selectFreshIntel - injury resolution", () => {
  it("reports no injury when Sleeper says healthy (no designation)", () => {
    const rows: FreshIntelRow[] = [injuryRow({ injuryStatus: undefined, fetchedAt: daysAgo(1) })];
    expect(selectFreshIntel(rows, NOW).injury).toBeUndefined();
  });

  it("reports no injury when Sleeper explicitly says Active", () => {
    const rows: FreshIntelRow[] = [injuryRow({ injuryStatus: "Active", fetchedAt: daysAgo(1) })];
    expect(selectFreshIntel(rows, NOW).injury).toBeUndefined();
  });

  it("surfaces a fresh non-healthy Sleeper status", () => {
    const rows: FreshIntelRow[] = [injuryRow({ injuryStatus: "Questionable", injuryBodyPart: "Knee", fetchedAt: daysAgo(1) })];
    const { injury } = selectFreshIntel(rows, NOW);
    expect(injury).toMatchObject({ status: "Questionable", bodyPart: "Knee", source: "sleeper" });
  });

  it("drops a stale Sleeper injury row (fetched more than 3 days ago) instead of trusting an old status", () => {
    const rows: FreshIntelRow[] = [injuryRow({ injuryStatus: "Questionable", fetchedAt: daysAgo(4) })];
    expect(selectFreshIntel(rows, NOW).injury).toBeUndefined();
  });

  it("falls back to a fresh nflverse row when Sleeper has none at all", () => {
    const rows: FreshIntelRow[] = [
      { source: "nflverse", kind: "injury", fetchedAt: daysAgo(1), injuryStatus: "Out", injuryBodyPart: "Hamstring" },
    ];
    const { injury } = selectFreshIntel(rows, NOW);
    expect(injury).toMatchObject({ status: "Out", bodyPart: "Hamstring", source: "nflverse" });
  });

  it("falls back to nflverse when Sleeper's row is present but stale", () => {
    const rows: FreshIntelRow[] = [
      injuryRow({ injuryStatus: "Questionable", fetchedAt: daysAgo(10) }),
      { source: "nflverse", kind: "injury", fetchedAt: daysAgo(1), injuryStatus: "Doubtful" },
    ];
    const { injury } = selectFreshIntel(rows, NOW);
    expect(injury).toMatchObject({ status: "Doubtful", source: "nflverse" });
  });

  it("trusts a fresh healthy Sleeper row over a disagreeing nflverse row (Sleeper preferred, not merely a fallback source)", () => {
    const rows: FreshIntelRow[] = [
      injuryRow({ injuryStatus: "Active", fetchedAt: daysAgo(1) }),
      { source: "nflverse", kind: "injury", fetchedAt: daysAgo(1), injuryStatus: "Questionable" },
    ];
    expect(selectFreshIntel(rows, NOW).injury).toBeUndefined();
  });

  it("treats an nflverse row with empty report_status as healthy", () => {
    const rows: FreshIntelRow[] = [{ source: "nflverse", kind: "injury", fetchedAt: daysAgo(1), injuryStatus: "" }];
    expect(selectFreshIntel(rows, NOW).injury).toBeUndefined();
  });

  it("treats a lingering nflverse report_status as healthy once practice_status shows full participation", () => {
    const rows: FreshIntelRow[] = [
      { source: "nflverse", kind: "injury", fetchedAt: daysAgo(1), injuryStatus: "Questionable", practiceStatus: "Full Participation in Practice" },
    ];
    expect(selectFreshIntel(rows, NOW).injury).toBeUndefined();
  });

  it("surfaces ESPN's own status alongside the feed's for visibility, even when they disagree", () => {
    const rows: FreshIntelRow[] = [injuryRow({ injuryStatus: "Questionable", fetchedAt: daysAgo(1) })];
    const { injury } = selectFreshIntel(rows, NOW, { espnInjuryStatus: "ACTIVE" });
    expect(injury).toMatchObject({ status: "Questionable", espnStatus: "ACTIVE" });
  });

  it("states 'since' from statusChangedAt when available, else falls back to observedAt", () => {
    const changedAt = daysAgo(2);
    const rowsWithChange: FreshIntelRow[] = [injuryRow({ injuryStatus: "Out", statusChangedAt: changedAt, observedAt: daysAgo(6) })];
    expect(selectFreshIntel(rowsWithChange, NOW).injury?.since).toBe(changedAt);

    const observedAt = daysAgo(2);
    const rowsWithoutChange: FreshIntelRow[] = [injuryRow({ injuryStatus: "Out", observedAt })];
    expect(selectFreshIntel(rowsWithoutChange, NOW).injury?.since).toBe(observedAt);
  });
});

describe("selectFreshIntel - practice (nested inside an active injury)", () => {
  it("includes a fresh Sleeper practice status alongside an active injury", () => {
    const rows: FreshIntelRow[] = [
      injuryRow({ injuryStatus: "Questionable", fetchedAt: daysAgo(1) }),
      { source: "sleeper", kind: "practice", fetchedAt: daysAgo(2), practiceStatus: "Limited Participation in Practice" },
    ];
    expect(selectFreshIntel(rows, NOW).injury?.practice).toBe("Limited Participation in Practice");
  });

  it("drops a stale practice row (fetched more than 5 days ago)", () => {
    const rows: FreshIntelRow[] = [
      injuryRow({ injuryStatus: "Questionable", fetchedAt: daysAgo(1) }),
      { source: "sleeper", kind: "practice", fetchedAt: daysAgo(6), practiceStatus: "Did Not Participate In Practice" },
    ];
    expect(selectFreshIntel(rows, NOW).injury?.practice).toBeUndefined();
  });

  it("falls back to the nflverse injury row's piggybacked practice_status when Sleeper has none", () => {
    const rows: FreshIntelRow[] = [
      { source: "nflverse", kind: "injury", fetchedAt: daysAgo(1), injuryStatus: "Doubtful", practiceStatus: "Limited Participation in Practice" },
    ];
    expect(selectFreshIntel(rows, NOW).injury?.practice).toBe("Limited Participation in Practice");
  });

  it("never surfaces practice info when there is no active injury", () => {
    const rows: FreshIntelRow[] = [{ source: "sleeper", kind: "practice", fetchedAt: daysAgo(1), practiceStatus: "Full Participation in Practice" }];
    expect(selectFreshIntel(rows, NOW).injury).toBeUndefined();
  });
});

describe("selectFreshIntel - depth chart", () => {
  it("includes a fresh Sleeper depth chart row", () => {
    const rows: FreshIntelRow[] = [
      { source: "sleeper", kind: "depth_chart", fetchedAt: daysAgo(5), team: "CHI", depthPosition: "RB", depthOrder: 1 },
    ];
    expect(selectFreshIntel(rows, NOW).depthChart).toEqual({ team: "CHI", position: "RB", order: 1, source: "sleeper" });
  });

  it("drops a depth chart row older than 14 days", () => {
    const rows: FreshIntelRow[] = [
      { source: "sleeper", kind: "depth_chart", fetchedAt: daysAgo(15), team: "CHI", depthPosition: "RB", depthOrder: 1 },
    ];
    expect(selectFreshIntel(rows, NOW).depthChart).toBeUndefined();
  });

  it("omits depth chart when the fresh row has no position/order to report", () => {
    const rows: FreshIntelRow[] = [{ source: "sleeper", kind: "depth_chart", fetchedAt: daysAgo(1), team: "CHI" }];
    expect(selectFreshIntel(rows, NOW).depthChart).toBeUndefined();
  });
});

describe("selectFreshIntel - market", () => {
  it("prefers the ppr-12 board over standard-10 when both are fresh", () => {
    const rows: FreshIntelRow[] = [
      { source: "ffc", kind: "market", fetchedAt: daysAgo(1), market: "standard-10", adp: 20 },
      { source: "ffc", kind: "market", fetchedAt: daysAgo(1), market: "ppr-12", adp: 15 },
    ];
    expect(selectFreshIntel(rows, NOW).market).toMatchObject({ market: "ppr-12", ffcAdp: 15 });
  });

  it("falls back to whatever board is fresh when the preferred ones are missing", () => {
    const rows: FreshIntelRow[] = [{ source: "ffc", kind: "market", fetchedAt: daysAgo(1), market: "half-ppr-10", adp: 42, bye: 9 }];
    expect(selectFreshIntel(rows, NOW).market).toMatchObject({ market: "half-ppr-10", ffcAdp: 42, bye: 9 });
  });

  it("drops a market board older than 14 days", () => {
    const rows: FreshIntelRow[] = [{ source: "ffc", kind: "market", fetchedAt: daysAgo(20), market: "ppr-12", adp: 15 }];
    expect(selectFreshIntel(rows, NOW).market).toBeUndefined();
  });

  it("includes fresh trending adds even with no ADP board at all", () => {
    const rows: FreshIntelRow[] = [{ source: "sleeper", kind: "trending", fetchedAt: hoursAgo(10), trendingAdds: 5000 }];
    expect(selectFreshIntel(rows, NOW).market).toEqual({
      ffcAdp: undefined,
      ffcPositionRank: undefined,
      bye: undefined,
      timesDrafted: undefined,
      market: undefined,
      trendingAdds: 5000,
    });
  });

  it("drops trending adds older than 48 hours", () => {
    const rows: FreshIntelRow[] = [{ source: "sleeper", kind: "trending", fetchedAt: hoursAgo(60), trendingAdds: 5000 }];
    expect(selectFreshIntel(rows, NOW).market).toBeUndefined();
  });

  it("layers fresh trending adds on top of a fresh ADP board", () => {
    const rows: FreshIntelRow[] = [
      { source: "ffc", kind: "market", fetchedAt: daysAgo(1), market: "ppr-12", adp: 15, adpPositionRank: 3 },
      { source: "sleeper", kind: "trending", fetchedAt: hoursAgo(5), trendingAdds: 1200 },
    ];
    expect(selectFreshIntel(rows, NOW).market).toMatchObject({ market: "ppr-12", ffcAdp: 15, ffcPositionRank: 3, trendingAdds: 1200 });
  });
});

describe("selectFreshIntel - news", () => {
  function news(publishedDaysAgo: number, headline: string): FreshNewsRow {
    return { headline, published: isoDaysAgo(publishedDaysAgo) };
  }

  it("includes news within 7 days and excludes older news when there is no active injury", () => {
    const rows: FreshIntelRow[] = [];
    const result = selectFreshIntel(rows, NOW, { newsRows: [news(3, "recent"), news(10, "old")] });
    expect(result.news.map((n) => n.headline)).toEqual(["recent"]);
  });

  it("relaxes the news window to 30 days while an active injury is present", () => {
    const rows: FreshIntelRow[] = [injuryRow({ injuryStatus: "Out", fetchedAt: daysAgo(1) })];
    const result = selectFreshIntel(rows, NOW, { newsRows: [news(25, "recent-ish"), news(35, "too old")] });
    expect(result.news.map((n) => n.headline)).toEqual(["recent-ish"]);
  });

  it("sorts newest first and caps at 3 items", () => {
    const rows: FreshIntelRow[] = [];
    const items = [news(1, "d1"), news(4, "d4"), news(2, "d2"), news(6, "d6"), news(0, "d0")];
    const result = selectFreshIntel(rows, NOW, { newsRows: items });
    expect(result.news.map((n) => n.headline)).toEqual(["d0", "d1", "d2"]);
  });

  it("maps espnNews fields onto the output shape", () => {
    const rows: FreshIntelRow[] = [];
    const result = selectFreshIntel(rows, NOW, {
      newsRows: [{ headline: "Headline", description: "Desc", published: isoDaysAgo(1), url: "https://espn.com/story" }],
    });
    expect(result.news).toEqual([
      { headline: "Headline", description: "Desc", publishedAt: isoDaysAgo(1), url: "https://espn.com/story", source: "espn" },
    ]);
  });

  it("returns an empty news array when none is supplied", () => {
    expect(selectFreshIntel([], NOW).news).toEqual([]);
  });
});
