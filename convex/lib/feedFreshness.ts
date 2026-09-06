/**
 * The feeds line of the operator digest (2026-09-05, owner ask: "make sure we're constantly
 * updating ADP and news/injuries"): one glance says whether every feed ran on time and
 * succeeded. Pure, so the thresholds are unit-tested.
 */

export type FeedName =
  | "sleeper_players"
  | "sleeper_trending"
  | "nflverse_injuries"
  | "ffc_adp"
  | "espn_news"
  // The Wire (spec ffsn-the-wire-spec.md §11): ESPN's injuries poll, every 5 min in season.
  | "espn_injuries"
  // Dex Desk (spec §18): the transaction-log poll, every 15 min in season.
  | "espn_transactions"
  // Dex Desk (spec §18): the NFL schedule/kickoffs poll, every 6 hours.
  | "nfl_kickoffs";

export interface FeedRun {
  source: FeedName;
  ranAt: number;
  ok: boolean;
  summary?: string;
  error?: string;
}

const LABELS: Record<FeedName, string> = {
  sleeper_players: "Sleeper injuries/depth",
  sleeper_trending: "Sleeper trending",
  nflverse_injuries: "nflverse injuries",
  ffc_adp: "FFC ADP",
  espn_news: "ESPN news",
  espn_injuries: "ESPN injuries",
  espn_transactions: "ESPN transactions",
  nfl_kickoffs: "NFL kickoffs",
};

/** How old the last successful run may be before the feed counts as stale (ms). */
export const STALE_AFTER_MS: Record<FeedName, number> = {
  sleeper_players: 10 * 60 * 60 * 1000, // cron every 4h
  sleeper_trending: 14 * 60 * 60 * 1000, // every 6h
  nflverse_injuries: 50 * 60 * 60 * 1000, // daily; 404s before the season count as failures
  ffc_adp: 50 * 60 * 60 * 1000, // daily
  espn_news: 6 * 60 * 60 * 1000, // hourly
  espn_injuries: 2 * 60 * 60 * 1000, // polled every 5 min in season, 30 min otherwise (Wire spec §5.1/§6)
  espn_transactions: 1 * 60 * 60 * 1000, // polled every 15 min in season (Dex Desk spec §18)
  nfl_kickoffs: 8 * 60 * 60 * 1000, // polled every 6h (Dex Desk spec §18)
};

const ORDER: FeedName[] = [
  "sleeper_players",
  "sleeper_trending",
  "nflverse_injuries",
  "ffc_adp",
  "espn_news",
  "espn_injuries",
  "espn_transactions",
  "nfl_kickoffs",
];

export function ago(ms: number): string {
  if (ms < 60 * 60 * 1000) return `${Math.max(1, Math.round(ms / 60000))}m ago`;
  if (ms < 48 * 60 * 60 * 1000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

/** Feeds whose last OK run is older than their threshold, or that have never run. */
export function staleFeeds(runs: FeedRun[], now: number): FeedName[] {
  return ORDER.filter((name) => {
    const run = runs.find((r) => r.source === name);
    if (!run) return true;
    if (!run.ok) return true;
    return now - run.ranAt > STALE_AFTER_MS[name];
  });
}

export function formatFeedFreshness(runs: FeedRun[], now: number): string {
  const parts = ORDER.map((name) => {
    const run = runs.find((r) => r.source === name);
    if (!run) return `${LABELS[name]}: never`;
    const when = ago(now - run.ranAt);
    if (!run.ok) return `${LABELS[name]}: FAILED ${when}${run.error ? ` (${run.error})` : ""}`;
    const stale = now - run.ranAt > STALE_AFTER_MS[name] ? " STALE" : "";
    return `${LABELS[name]}: ${when}${stale}${run.summary ? `, ${run.summary}` : ""}`;
  });
  return `Feeds: ${parts.join(" · ")}`;
}
