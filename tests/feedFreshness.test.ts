import { describe, expect, it } from "vitest";
import { formatFeedFreshness, staleFeeds, type FeedRun } from "../convex/lib/feedFreshness";

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const H = 60 * 60 * 1000;

const runs: FeedRun[] = [
  { source: "sleeper_players", ranAt: NOW - 3 * H, ok: true, summary: "2312 players, 40 changed" },
  { source: "sleeper_trending", ranAt: NOW - 1 * H, ok: true, summary: "11 of 50 trending mapped" },
  { source: "nflverse_injuries", ranAt: NOW - 2 * H, ok: false, error: "nflverse injuries_2026.csv HTTP 404" },
  { source: "ffc_adp", ranAt: NOW - 60 * H, ok: true, summary: "6 boards (2026), 0 changed" },
  { source: "espn_news", ranAt: NOW - 20 * 60 * 1000, ok: true },
  { source: "espn_injuries", ranAt: NOW - 10 * 60 * 1000, ok: true, summary: "3 changed" },
  { source: "espn_transactions", ranAt: NOW - 5 * 60 * 1000, ok: true, summary: "2 league(s) polled" },
  { source: "nfl_kickoffs", ranAt: NOW - 4 * H, ok: true, summary: "3 new kickoff(s) scheduled, 0 bye check(s) scheduled" },
  { source: "espn_scoreboard", ranAt: NOW - 2 * 60 * 1000, ok: true, summary: "16 games, 3 live" },
];

describe("feed freshness", () => {
  it("names the feeds that failed, went stale, or never ran", () => {
    expect(staleFeeds(runs, NOW)).toEqual(["nflverse_injuries", "ffc_adp"]);
    expect(staleFeeds(runs.filter(r => r.source !== "espn_news"), NOW)).toContain("espn_news");
  });

  it("prints one dated part per feed with failures and staleness marked", () => {
    const line = formatFeedFreshness(runs, NOW);
    expect(line).toContain("Sleeper injuries/depth: 3h ago, 2312 players, 40 changed");
    expect(line).toContain("nflverse injuries: FAILED 2h ago (nflverse injuries_2026.csv HTTP 404)");
    expect(line).toContain("FFC ADP: 3d ago STALE");
    expect(line).toContain("ESPN news: 20m ago");
    expect(line).toContain("ESPN injuries: 10m ago, 3 changed");
    expect(line).toContain("ESPN transactions: 5m ago, 2 league(s) polled");
    expect(line).toContain("NFL kickoffs: 4h ago, 3 new kickoff(s) scheduled, 0 bye check(s) scheduled");
    expect(line).toContain("ESPN scoreboard (live): 2m ago, 16 games, 3 live");
    expect(formatFeedFreshness([], NOW)).toContain("Sleeper injuries/depth: never");
  });
});
