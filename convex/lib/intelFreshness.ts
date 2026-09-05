/**
 * The player-intelligence freshness policy (pure, no Convex imports).
 *
 * The owner's rule of thumb: a story from a month ago is not relevant unless
 * it is an injury that is still active. `selectFreshIntel` takes every
 * `playerIntel` row this codebase has for one player + a window of that
 * player's `espnNews` rows, and decides what's still current enough to hand
 * an AI sportswriter as color - dropping anything a stale sync left behind.
 *
 * Kept dependency-free and DB-shape-free (plain interfaces, not
 * `Doc<"playerIntel">>`) so it is trivial to unit test and safe to import
 * from both `convex/intel.ts` (a query) and `convex/intelSync.ts` (actions)
 * without pulling either module's `internal` references along with it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type IntelSource = "sleeper" | "nflverse" | "ffc";
export type IntelKind = "injury" | "practice" | "depth_chart" | "market" | "trending";

/** Mirrors the kind-specific subset of the `playerIntel` schema this module reads. */
export interface FreshIntelRow {
  source: IntelSource;
  kind: IntelKind;
  /** The season label the sync stamped; read back so a fallback board can say which year it is. */
  season?: number;
  fetchedAt: number;
  observedAt?: number;
  team?: string;
  // kind: "injury"
  injuryStatus?: string;
  injuryBodyPart?: string;
  injuryNotes?: string;
  statusChangedAt?: number;
  // kind: "practice" (also piggybacked onto the nflverse "injury" row - see
  // `convex/intelSync.ts`'s `syncNflverseInjuries`, which is the only place
  // nflverse practice data lives)
  practiceStatus?: string;
  practiceDescription?: string;
  // kind: "depth_chart"
  depthPosition?: string;
  depthOrder?: number;
  // kind: "market" (source: "ffc")
  adp?: number;
  adpPositionRank?: number;
  timesDrafted?: number;
  bye?: number;
  market?: string;
  // kind: "trending" (source: "sleeper")
  trendingAdds?: number;
}

/** The subset of an `espnNews` row this module needs. */
export interface FreshNewsRow {
  headline: string;
  description?: string;
  published: string; // ISO date string
  url?: string;
}

export interface SelectFreshIntelOptions {
  /** This player's espnNews rows (any age - this function does the date filtering). */
  newsRows?: FreshNewsRow[];
  /** `playersEnhanced.injuryStatus` for this player, surfaced for disagreement visibility. */
  espnInjuryStatus?: string;

  // Freshness windows (days unless noted), overridable for tests. Defaults
  // implement the owner's policy described in the module comment above.
  newsFreshDays?: number;
  newsWithActiveInjuryFreshDays?: number;
  injuryFreshDays?: number;
  practiceFreshDays?: number;
  depthChartFreshDays?: number;
  marketFreshDays?: number;
  trendingFreshHours?: number;
  /** Preference order for which FFC market board to surface when several are fresh. */
  marketFormatPreference?: string[];
  /** Cap on the number of news items returned. */
  maxNewsItems?: number;
}

export interface FreshInjury {
  status: string;
  bodyPart?: string;
  /** Freshest practice status/description for this player, only surfaced alongside an active injury. */
  practice?: string;
  notes?: string;
  /** When this status began: `statusChangedAt` if we've observed a change, else the source's own `observedAt`. */
  since?: number;
  source: "sleeper" | "nflverse";
  fetchedAt: number;
  /** ESPN's own `playersEnhanced.injuryStatus`, so a disagreement between feeds is visible. */
  espnStatus?: string;
}

export interface FreshDepthChart {
  team?: string;
  position: string;
  order: number;
  source: "sleeper";
}

export interface FreshMarket {
  season?: number;
  ffcAdp?: number;
  ffcPositionRank?: number;
  bye?: number;
  timesDrafted?: number;
  market?: string;
  trendingAdds?: number;
}

export interface FreshNewsItem {
  headline: string;
  description?: string;
  publishedAt: string;
  url?: string;
  source: "espn";
}

/**
 * A fresh feed row that lists NO injury while ESPN still carries a designation (2026-09-05: ESPN
 * had Chase, Nacua and Jeanty QUESTIONABLE on draft week; Sleeper, fetched that morning, had
 * nothing). The article says both, dated, instead of selling ESPN's tag as an injury story.
 */
export interface FreshCleared {
  source: "sleeper" | "nflverse";
  fetchedAt: number;
  espnStatus: string;
}

export interface FreshIntelOutput {
  injury?: FreshInjury;
  cleared?: FreshCleared;
  depthChart?: FreshDepthChart;
  market?: FreshMarket;
  news: FreshNewsItem[];
}

const DEFAULT_MARKET_PREFERENCE = ["ppr-12", "ppr-10", "half-ppr-12", "half-ppr-10", "standard-12", "standard-10"];

function withinDays(fetchedAt: number, now: number, days: number): boolean {
  return now - fetchedAt <= days * DAY_MS;
}

function withinHours(fetchedAt: number, now: number, hours: number): boolean {
  return now - fetchedAt <= hours * HOUR_MS;
}

/** Sleeper's healthy states: no designation at all, or explicitly "Active". */
function isSleeperHealthy(status: string | undefined): boolean {
  if (!status) return true;
  return status.trim().toLowerCase() === "active";
}

/**
 * nflverse's `report_status` is empty/"Active" for a healthy player, but a
 * lingering stale designation with `practice_status` now "Full Participation
 * in Practice" means the player has since cleared - treat that as healthy
 * too rather than reporting a phantom injury from an unset report_status field.
 */
function isNflverseHealthy(reportStatus: string | undefined, practiceStatus: string | undefined): boolean {
  const rs = (reportStatus ?? "").trim().toLowerCase();
  if (rs === "" || rs === "active") return true;
  const ps = (practiceStatus ?? "").trim().toLowerCase();
  return ps.startsWith("full participation");
}

function pickFreshest(rows: FreshIntelRow[], predicate: (row: FreshIntelRow) => boolean): FreshIntelRow | undefined {
  let best: FreshIntelRow | undefined;
  for (const row of rows) {
    if (!predicate(row)) continue;
    if (!best || row.fetchedAt > best.fetchedAt) best = row;
  }
  return best;
}

/**
 * Apply the freshness policy to one player's `playerIntel` rows (every
 * source/kind this codebase has for them) plus a window of their
 * `espnNews` rows, returning only what's current enough to state as fact.
 *
 * `rows`: every `playerIntel` row for this player+season (any source/kind -
 * this function does the source-preference and freshness filtering).
 * `now`: caller-supplied wall-clock time (never read internally, so this
 * stays pure and safe to call from a Convex query).
 */
export function selectFreshIntel(
  rows: FreshIntelRow[],
  now: number,
  opts: SelectFreshIntelOptions = {},
): FreshIntelOutput {
  const newsFreshDays = opts.newsFreshDays ?? 7;
  const newsWithActiveInjuryFreshDays = opts.newsWithActiveInjuryFreshDays ?? 30;
  const injuryFreshDays = opts.injuryFreshDays ?? 3;
  const practiceFreshDays = opts.practiceFreshDays ?? 5;
  const depthChartFreshDays = opts.depthChartFreshDays ?? 14;
  const marketFreshDays = opts.marketFreshDays ?? 14;
  const trendingFreshHours = opts.trendingFreshHours ?? 48;
  const marketFormatPreference = opts.marketFormatPreference ?? DEFAULT_MARKET_PREFERENCE;
  const maxNewsItems = opts.maxNewsItems ?? 3;

  const sleeperInjuryRow = pickFreshest(rows, (r) => r.kind === "injury" && r.source === "sleeper");
  const nflverseInjuryRow = pickFreshest(rows, (r) => r.kind === "injury" && r.source === "nflverse");
  const sleeperPracticeRow = pickFreshest(rows, (r) => r.kind === "practice" && r.source === "sleeper");
  const sleeperDepthRow = pickFreshest(rows, (r) => r.kind === "depth_chart" && r.source === "sleeper");
  const trendingRow = pickFreshest(rows, (r) => r.kind === "trending" && r.source === "sleeper");
  const ffcMarketRows = rows.filter((r) => r.kind === "market" && r.source === "ffc");

  // --- Injury resolution: prefer Sleeper, fall back to nflverse only when
  // Sleeper's row is missing or stale (not merely when it disagrees). ---
  let injuryRow: FreshIntelRow | undefined;
  let injurySource: "sleeper" | "nflverse" | undefined;

  if (sleeperInjuryRow && withinDays(sleeperInjuryRow.fetchedAt, now, injuryFreshDays)) {
    if (!isSleeperHealthy(sleeperInjuryRow.injuryStatus)) {
      injuryRow = sleeperInjuryRow;
      injurySource = "sleeper";
    }
    // Sleeper is fresh and says healthy: trust it, don't consult nflverse.
  } else if (nflverseInjuryRow && withinDays(nflverseInjuryRow.fetchedAt, now, injuryFreshDays)) {
    if (!isNflverseHealthy(nflverseInjuryRow.injuryStatus, nflverseInjuryRow.practiceStatus)) {
      injuryRow = nflverseInjuryRow;
      injurySource = "nflverse";
    }
  }

  const hasActiveInjury = injuryRow !== undefined && injurySource !== undefined;

  // ESPN flags the player, the fresh feed does not: surface the disagreement with its date.
  let cleared: FreshCleared | undefined;
  const espnStatus = (opts.espnInjuryStatus ?? "").trim();
  if (!hasActiveInjury && espnStatus !== "" && espnStatus.toUpperCase() !== "ACTIVE") {
    if (sleeperInjuryRow && withinDays(sleeperInjuryRow.fetchedAt, now, injuryFreshDays)) {
      cleared = { source: "sleeper", fetchedAt: sleeperInjuryRow.fetchedAt, espnStatus };
    } else if (nflverseInjuryRow && withinDays(nflverseInjuryRow.fetchedAt, now, injuryFreshDays)) {
      cleared = { source: "nflverse", fetchedAt: nflverseInjuryRow.fetchedAt, espnStatus };
    }
  }

  let injury: FreshInjury | undefined;
  if (injuryRow && injurySource) {
    let practice: string | undefined;
    if (
      sleeperPracticeRow &&
      withinDays(sleeperPracticeRow.fetchedAt, now, practiceFreshDays) &&
      sleeperPracticeRow.practiceStatus
    ) {
      practice = sleeperPracticeRow.practiceStatus;
    } else if (
      nflverseInjuryRow &&
      withinDays(nflverseInjuryRow.fetchedAt, now, practiceFreshDays) &&
      nflverseInjuryRow.practiceStatus
    ) {
      practice = nflverseInjuryRow.practiceStatus;
    }

    injury = {
      status: injuryRow.injuryStatus!,
      bodyPart: injuryRow.injuryBodyPart,
      practice,
      notes: injuryRow.injuryNotes,
      since: injuryRow.statusChangedAt ?? injuryRow.observedAt,
      source: injurySource,
      fetchedAt: injuryRow.fetchedAt,
      espnStatus: opts.espnInjuryStatus,
    };
  }

  // --- Depth chart: Sleeper only in this build (nflverse carries no depth
  // chart feed), so there is no fallback source despite the general
  // Sleeper-preferred/nflverse-fallback rule. ---
  let depthChart: FreshDepthChart | undefined;
  if (
    sleeperDepthRow &&
    withinDays(sleeperDepthRow.fetchedAt, now, depthChartFreshDays) &&
    sleeperDepthRow.depthPosition &&
    sleeperDepthRow.depthOrder != null
  ) {
    depthChart = {
      team: sleeperDepthRow.team,
      position: sleeperDepthRow.depthPosition,
      order: sleeperDepthRow.depthOrder,
      source: "sleeper",
    };
  }

  // --- Market: pick the freshest board in preference order, then layer on
  // Sleeper's trending-adds count (a different sync entirely) if it's fresh -
  // trending alone is still worth surfacing even with no fresh ADP board. ---
  let chosenMarketRow: FreshIntelRow | undefined;
  for (const format of marketFormatPreference) {
    const candidate = ffcMarketRows.find((r) => r.market === format && withinDays(r.fetchedAt, now, marketFreshDays));
    if (candidate) {
      chosenMarketRow = candidate;
      break;
    }
  }
  if (!chosenMarketRow) {
    chosenMarketRow = pickFreshest(ffcMarketRows, (r) => withinDays(r.fetchedAt, now, marketFreshDays));
  }

  const freshTrendingAdds =
    trendingRow && withinHours(trendingRow.fetchedAt, now, trendingFreshHours) ? trendingRow.trendingAdds : undefined;

  let market: FreshMarket | undefined;
  if (chosenMarketRow || freshTrendingAdds !== undefined) {
    market = {
      season: chosenMarketRow?.season,
      ffcAdp: chosenMarketRow?.adp,
      ffcPositionRank: chosenMarketRow?.adpPositionRank,
      bye: chosenMarketRow?.bye,
      timesDrafted: chosenMarketRow?.timesDrafted,
      market: chosenMarketRow?.market,
      trendingAdds: freshTrendingAdds,
    };
  }

  // --- News: 7-day window normally, relaxed to 30 days while the player has
  // an active injury (the owner's stated exception - "a story from a month
  // ago is not relevant unless it is an injury that is still active"). ---
  const newsWindowDays = hasActiveInjury ? newsWithActiveInjuryFreshDays : newsFreshDays;
  const news: FreshNewsItem[] = (opts.newsRows ?? [])
    .map((row) => ({ row, publishedAt: Date.parse(row.published) }))
    .filter(({ publishedAt }) => Number.isFinite(publishedAt) && now - publishedAt <= newsWindowDays * DAY_MS)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, maxNewsItems)
    .map(({ row }) => ({
      headline: row.headline,
      description: row.description,
      publishedAt: row.published,
      url: row.url,
      source: "espn" as const,
    }));

  return { injury, cleared, depthChart, market, news };
}
