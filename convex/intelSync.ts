/**
 * Player-intelligence sync: pulls fresh injury/practice/depth-chart/market
 * data from Sleeper, nflverse, and the Fantasy Football Calculator (FFC),
 * mapped onto this codebase's primary player key (`playersEnhanced.espnId`)
 * via `playerIdMap`. See `convex/intel.ts` for the read side and
 * `convex/lib/intelFreshness.ts` for the freshness policy applied there.
 *
 * Every sync action is idempotent and safe to rerun: writes go through
 * `upsertPlayerIntelBatch` / `upsertPlayerIdMapBatch`, which only touch
 * `fetchedAt` (not the whole row) when nothing meaningful changed - see the
 * comment on `intelRowChanged` below for why a plain "skip unless changed"
 * would silently make freshness wrong on an unchanging-but-still-active
 * injury. Each action catches its own errors and returns a result object
 * (mirroring `convex/espnNews.ts`'s `syncESPNNews`) rather than throwing, so
 * `syncAllPlayerIntel` (and the crons below) never lose the other three
 * feeds to one broken one.
 */
import { v, Infer } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { nflSeasonYearFor } from "./lib/season";
import { buildEspnMatchIndex, EspnPlayerRef, matchPlayerToEspnId, normalizePosition, parseCsvRecords, resolveEspnId } from "./lib/intelMapping";

// --- Shared fetch helper ------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_RETRIES = 1;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with a 30s timeout and one retry on a 5xx response or a
 * network-level failure (DNS, timeout, connection reset). 4xx responses
 * (404 in particular - nflverse hasn't published this season's injuries
 * file yet, say) are returned as-is: retrying an answer that isn't going to
 * change just burns the retry budget.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const { timeoutMs = FETCH_TIMEOUT_MS, retries = FETCH_RETRIES } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      if (response.status >= 500 && attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`fetch failed: ${url}`);
}

const USER_AGENT = "FFSN/1.0 (+https://www.ffsn.ai)";

// --- playerIntel upsert (shared by every sync below) --------------------

const intelSourceValidator = v.union(v.literal("sleeper"), v.literal("nflverse"), v.literal("ffc"));
const intelKindValidator = v.union(
  v.literal("injury"),
  v.literal("practice"),
  v.literal("depth_chart"),
  v.literal("market"),
  v.literal("trending"),
);

const intelUpsertRowValidator = v.object({
  espnId: v.string(),
  season: v.number(),
  source: intelSourceValidator,
  kind: intelKindValidator,
  observedAt: v.optional(v.number()),
  team: v.optional(v.string()),
  position: v.optional(v.string()),
  injuryStatus: v.optional(v.string()),
  injuryBodyPart: v.optional(v.string()),
  injuryNotes: v.optional(v.string()),
  practiceStatus: v.optional(v.string()),
  practiceDescription: v.optional(v.string()),
  depthPosition: v.optional(v.string()),
  depthOrder: v.optional(v.number()),
  adp: v.optional(v.number()),
  adpPositionRank: v.optional(v.number()),
  timesDrafted: v.optional(v.number()),
  bye: v.optional(v.number()),
  market: v.optional(v.string()),
  trendingAdds: v.optional(v.number()),
});

export type IntelUpsertRow = Infer<typeof intelUpsertRowValidator>;

/** Per-kind meaningful fields to diff (excludes identity fields and fetchedAt/history bookkeeping). */
const KIND_FIELDS: Record<Infer<typeof intelKindValidator>, Array<keyof IntelUpsertRow>> = {
  injury: ["injuryStatus", "injuryBodyPart", "injuryNotes", "observedAt", "team"],
  practice: ["practiceStatus", "practiceDescription", "team"],
  depth_chart: ["depthPosition", "depthOrder", "team"],
  market: ["adp", "adpPositionRank", "timesDrafted", "bye", "market"],
  trending: ["trendingAdds"],
};

function intelRowChanged(existing: Doc<"playerIntel">, candidate: IntelUpsertRow): boolean {
  const fields = KIND_FIELDS[candidate.kind];
  return fields.some((field) => existing[field] !== candidate[field]);
}

/**
 * Upsert a batch of `playerIntel` rows. Never appends: the identity key is
 * (espnId, season, source, kind), except `kind: "market"` where `market`
 * ("ppr-10", etc.) is also part of the identity, since FFC publishes six
 * boards per season and each is worth keeping (see the schema comment).
 *
 * When an existing row's meaningful fields (per `KIND_FIELDS`) are
 * unchanged, this only touches `fetchedAt` - not a no-op, because the
 * freshness policy in `convex/lib/intelFreshness.ts` gates on how recently
 * a row was *confirmed*, not how recently it last changed. Skipping the
 * touch entirely would make an unchanging-but-still-active injury (the
 * exact case the owner most wants surfaced) go "stale" and disappear from
 * article context after a few days, which is the opposite of the point.
 * The touch is a single-field patch, so a daily run still "writes little"
 * in the sense the content never gets rewritten unless it actually moved.
 */
export const upsertPlayerIntelBatch = internalMutation({
  args: { rows: v.array(intelUpsertRowValidator) },
  returns: v.object({ inserted: v.number(), updated: v.number(), touched: v.number() }),
  handler: async (ctx, { rows }) => {
    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    let touched = 0;
    // The Wire (ffsn-the-wire-spec.md §5.1/§8.2): Sleeper-sourced status changes and depth-chart
    // moves into slot 1, batched and scheduled once at the end of this mutation (not per row) so a
    // busy sync doesn't schedule hundreds of individual functions.
    const statusChangeRows: Array<{
      espnId: string;
      statusFrom?: string;
      statusTo: string;
      team?: string;
      position?: string;
      notes?: string;
      observedAt?: number;
    }> = [];
    const depthChartRows: Array<{
      espnId: string;
      depthOrderFrom?: number;
      depthOrderTo: number;
      team?: string;
      position?: string;
      observedAt?: number;
    }> = [];

    for (const row of rows) {
      const candidates = await ctx.db
        .query("playerIntel")
        .withIndex("by_player_season", (q) => q.eq("espnId", row.espnId).eq("season", row.season))
        .collect();
      const existing = candidates.find(
        (r) => r.source === row.source && r.kind === row.kind && (row.kind !== "market" || r.market === row.market),
      );

      if (!existing) {
        await ctx.db.insert("playerIntel", { ...row, fetchedAt: now });
        inserted++;
        continue;
      }

      if (!intelRowChanged(existing, row)) {
        await ctx.db.patch(existing._id, { fetchedAt: now });
        touched++;
        continue;
      }

      const patch: Record<string, unknown> = { ...row, fetchedAt: now };
      if (row.kind === "injury" && existing.injuryStatus !== row.injuryStatus) {
        patch.previousInjuryStatus = existing.injuryStatus;
        patch.statusChangedAt = now;
        if (row.injuryStatus) {
          statusChangeRows.push({
            espnId: row.espnId,
            statusFrom: existing.injuryStatus,
            statusTo: row.injuryStatus,
            team: row.team ?? existing.team,
            position: row.position ?? existing.position,
            notes: row.injuryNotes ?? existing.injuryNotes,
            observedAt: row.observedAt ?? now,
          });
        }
      }
      if (row.kind === "depth_chart" && existing.depthOrder !== 1 && row.depthOrder === 1) {
        depthChartRows.push({
          espnId: row.espnId,
          depthOrderFrom: existing.depthOrder,
          depthOrderTo: 1,
          team: row.team ?? existing.team,
          position: row.position ?? existing.position,
          observedAt: now,
        });
      }
      await ctx.db.patch(existing._id, patch);
      updated++;
    }

    if (statusChangeRows.length > 0) {
      await ctx.scheduler.runAfter(0, internal.wireDetect.ingestStatusChange, { rows: statusChangeRows });
    }
    if (depthChartRows.length > 0) {
      await ctx.scheduler.runAfter(0, internal.wireDetect.ingestDepthChart, { rows: depthChartRows });
    }

    return { inserted, updated, touched };
  },
});

// --- playerIdMap upsert (shared by Sleeper + nflverse syncs) ------------

const idMapUpsertRowValidator = v.object({
  espnId: v.string(),
  sleeperId: v.optional(v.string()),
  gsisId: v.optional(v.string()),
  fullName: v.string(),
  position: v.optional(v.string()),
  team: v.optional(v.string()),
});

export const upsertPlayerIdMapBatch = internalMutation({
  args: { rows: v.array(idMapUpsertRowValidator) },
  returns: v.object({ inserted: v.number(), updated: v.number() }),
  handler: async (ctx, { rows }) => {
    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    for (const row of rows) {
      const existing = await ctx.db
        .query("playerIdMap")
        .withIndex("by_espn", (q) => q.eq("espnId", row.espnId))
        .first();

      if (!existing) {
        await ctx.db.insert("playerIdMap", { ...row, updatedAt: now });
        inserted++;
        continue;
      }

      // Merge: never let one source's sync blank out a field only the other
      // source populates (e.g. nflverse never sees Sleeper's sleeperId).
      const patch: Record<string, unknown> = { updatedAt: now };
      if (row.sleeperId !== undefined) patch.sleeperId = row.sleeperId;
      if (row.gsisId !== undefined) patch.gsisId = row.gsisId;
      if (row.fullName) patch.fullName = row.fullName;
      if (row.position !== undefined) patch.position = row.position;
      if (row.team !== undefined) patch.team = row.team;

      const changed = Object.entries(patch).some(([key, value]) => key !== "updatedAt" && existing[key as keyof typeof existing] !== value);
      if (!changed) continue; // Nothing new from this source - don't even bump updatedAt.

      await ctx.db.patch(existing._id, patch);
      updated++;
    }

    return { inserted, updated };
  },
});

// Explicit result types for every self-referencing `ctx.runQuery` /
// `ctx.runMutation` / `ctx.runAction` call below (i.e. `internal.intelSync.*`
// called from within this same file): per the Convex guidelines, annotating
// these breaks a TypeScript circularity that a same-file `internal.*`
// reference otherwise hits during typechecking.
type IntelUpsertResult = { inserted: number; updated: number; touched: number };
type IdMapUpsertResult = { inserted: number; updated: number };
type IdMapBySleeperLookup = { espnId: string; team?: string; position?: string } | null;
type IdMapByGsisLookup = { espnId: string } | null;
type PlayersEnhancedForMatch = Array<{ espnId: string; fullName: string; position: string; team?: string }>;

/**
 * Whether the id map still needs nflverse's players.csv: true while fewer than
 * `GSIS_COVERAGE_MIN` rows carry a gsis_id. The Sleeper sync fills sleeperId and (where Sleeper
 * has it) gsisId, but Sleeper's gsis coverage is thin, and nflverse injuries are keyed on gsis -
 * checking only for an empty map (the first build) left in-season injuries unable to resolve.
 */
export const playerIdMapNeedsGsis = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const withGsis = await ctx.db
      .query("playerIdMap")
      .withIndex("by_gsis", (q) => q.gt("gsisId", ""))
      .take(GSIS_COVERAGE_MIN);
    return withGsis.length < GSIS_COVERAGE_MIN;
  },
});

const GSIS_COVERAGE_MIN = 500;

/** Minimal `playersEnhanced` projection used to match FFC's ADP list onto ESPN ids. */
export const listPlayersEnhancedForSeason = internalQuery({
  args: { season: v.number() },
  returns: v.array(v.object({ espnId: v.string(), fullName: v.string(), position: v.string(), team: v.optional(v.string()) })),
  handler: async (ctx, { season }) => {
    // Bounded per Convex query guidelines; a season's player pool (~1-1.5k
    // rows in this codebase's data) is well under this cap.
    const players = await ctx.db
      .query("playersEnhanced")
      .withIndex("by_season", (q) => q.eq("season", season))
      .take(5000);
    return players.map((p) => ({ espnId: p.espnId, fullName: p.fullName, position: p.defaultPosition, team: p.proTeamAbbrev }));
  },
});

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Rows written per `upsertPlayerIntelBatch`/`upsertPlayerIdMapBatch` call - each call reads + writes one row per item, so this stays comfortably under the repo's ≤300-documents-per-mutation guidance. */
const UPSERT_BATCH_SIZE = 150;

// --- Sleeper: players (injury / practice / depth chart + id map) --------

const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
const REAL_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

interface SleeperPlayer {
  espn_id?: number | string | null;
  gsis_id?: string | null;
  active?: boolean | null;
  position?: string | null;
  team?: string | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  injury_start_date?: string | number | null;
  news_updated?: number | string | null;
  practice_participation?: string | null;
  practice_description?: string | null;
  depth_chart_position?: string | null;
  depth_chart_order?: number | null;
}

/** Sleeper gives `news_updated` as an epoch-ms number; `injury_start_date` has historically been either an epoch number or a date string. Handles both, defensively. */
function parseSleeperTimestamp(value: string | number | null | undefined): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "") return asNumber;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const syncSleeperPlayers = internalAction({
  args: {},
  returns: v.object({
    success: v.boolean(),
    fetched: v.number(),
    kept: v.number(),
    /** Players Sleeper carried no espn_id for that a name + position (+ team) match resolved. */
    matchedByName: v.number(),
    idMap: v.object({ inserted: v.number(), updated: v.number() }),
    intel: v.object({ inserted: v.number(), updated: v.number(), touched: v.number() }),
    error: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const empty = { success: false, fetched: 0, kept: 0, matchedByName: 0, idMap: { inserted: 0, updated: 0 }, intel: { inserted: 0, updated: 0, touched: 0 } };
    try {
      const season = nflSeasonYearFor();
      // This season's ESPN pool, for the players Sleeper has no espn_id for (about half of the
      // active skill players, 2026-09-05): matched by name + position, team as the tiebreak.
      const pool: PlayersEnhancedForMatch = await ctx.runQuery(internal.intelSync.listPlayersEnhancedForSeason, { season });
      const matchIndex = buildEspnMatchIndex(pool.map((p) => ({ espnId: p.espnId, fullName: p.fullName, position: p.position, team: p.team })));
      let matchedByName = 0;
      const response = await fetchWithRetry(SLEEPER_PLAYERS_URL, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (!response.ok) {
        return { ...empty, error: `Sleeper players HTTP ${response.status}` };
      }
      const data = (await response.json()) as Record<string, SleeperPlayer>;
      const entries = Object.entries(data);

      const idMapRows: Infer<typeof idMapUpsertRowValidator>[] = [];
      const intelRows: IntelUpsertRow[] = [];

      for (const [sleeperId, p] of entries) {
        if (!p || !p.position || !REAL_POSITIONS.has(p.position)) continue;
        // A retired player keeps his row in Sleeper's feed (active: false); he has no injury
        // or depth-chart line worth a row, and a name match could hand his status to a
        // namesake still playing.
        if (p.active === false) continue;

        const fullName = p.full_name || `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
        const team = p.team ?? undefined;
        const resolved = resolveEspnId(p.espn_id, { name: fullName, position: p.position, team }, matchIndex);
        if (!resolved) continue;
        if (resolved.via === "name") matchedByName++;
        const espnId = resolved.espnId;

        idMapRows.push({ espnId, sleeperId, gsisId: p.gsis_id ?? undefined, fullName, position: p.position, team });

        const observedAt = (() => {
          const start = parseSleeperTimestamp(p.injury_start_date);
          const updated = parseSleeperTimestamp(p.news_updated);
          if (start === undefined) return updated;
          if (updated === undefined) return start;
          return Math.max(start, updated);
        })();

        intelRows.push({
          espnId,
          season,
          source: "sleeper",
          kind: "injury",
          observedAt,
          team,
          position: p.position,
          injuryStatus: p.injury_status ?? undefined,
          injuryBodyPart: p.injury_body_part ?? undefined,
          injuryNotes: p.injury_notes ?? undefined,
        });

        if (p.practice_participation != null || p.practice_description != null) {
          intelRows.push({
            espnId,
            season,
            source: "sleeper",
            kind: "practice",
            team,
            position: p.position,
            practiceStatus: p.practice_participation ?? undefined,
            practiceDescription: p.practice_description ?? undefined,
          });
        }

        if (p.depth_chart_position != null || p.depth_chart_order != null) {
          intelRows.push({
            espnId,
            season,
            source: "sleeper",
            kind: "depth_chart",
            team,
            position: p.position,
            depthPosition: p.depth_chart_position ?? undefined,
            depthOrder: p.depth_chart_order ?? undefined,
          });
        }
      }

      let idMapInserted = 0;
      let idMapUpdated = 0;
      for (const batch of chunk(idMapRows, UPSERT_BATCH_SIZE)) {
        const result: IdMapUpsertResult = await ctx.runMutation(internal.intelSync.upsertPlayerIdMapBatch, { rows: batch });
        idMapInserted += result.inserted;
        idMapUpdated += result.updated;
      }

      let intelInserted = 0;
      let intelUpdated = 0;
      let intelTouched = 0;
      for (const batch of chunk(intelRows, UPSERT_BATCH_SIZE)) {
        const result: IntelUpsertResult = await ctx.runMutation(internal.intelSync.upsertPlayerIntelBatch, { rows: batch });
        intelInserted += result.inserted;
        intelUpdated += result.updated;
        intelTouched += result.touched;
      }

      return {
        success: true,
        fetched: entries.length,
        kept: idMapRows.length,
        matchedByName,
        idMap: { inserted: idMapInserted, updated: idMapUpdated },
        intel: { inserted: intelInserted, updated: intelUpdated, touched: intelTouched },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync Sleeper players";
      console.error("syncSleeperPlayers failed:", message);
      return { ...empty, error: message };
    }
  },
});

// --- Sleeper: trending adds ----------------------------------------------

const SLEEPER_TRENDING_URL = "https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=50";
const TRENDING_STALE_MS = 48 * 60 * 60 * 1000;

interface SleeperTrendingEntry {
  player_id: string;
  count: number;
}

export const syncSleeperTrending = internalAction({
  args: {},
  returns: v.object({
    success: v.boolean(),
    fetched: v.number(),
    mapped: v.number(),
    unmapped: v.number(),
    intel: v.object({ inserted: v.number(), updated: v.number(), touched: v.number() }),
    deletedStale: v.number(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const empty = { success: false, fetched: 0, mapped: 0, unmapped: 0, intel: { inserted: 0, updated: 0, touched: 0 }, deletedStale: 0 };
    try {
      const season = nflSeasonYearFor();
      const response = await fetchWithRetry(SLEEPER_TRENDING_URL, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (!response.ok) {
        return { ...empty, error: `Sleeper trending HTTP ${response.status}` };
      }
      const entries = (await response.json()) as SleeperTrendingEntry[];

      let mapped = 0;
      let unmapped = 0;
      const intelRows: IntelUpsertRow[] = [];
      // The Wire (spec update 2026-09-06): every mapped row is forwarded - the detector
      // (wireDetect.ingestTrendingRows) owns the rules for what becomes a board post, a genuine
      // spike, or nothing at all. Forwarding a fixed "top 5" here duplicated that decision and
      // reposted the whole board nightly (a preseason draft-week sync ingesting all 50 rows).
      const wireRows: Array<{ espnId: string; trendingAdds: number; team?: string; position?: string; rank: number }> = [];
      for (const [index, entry] of entries.entries()) {
        const mapping: IdMapBySleeperLookup = await ctx.runQuery(internal.intelSync.lookupIdMapBySleeperId, {
          sleeperId: entry.player_id,
        });
        if (!mapping) {
          unmapped++;
          continue;
        }
        mapped++;
        intelRows.push({
          espnId: mapping.espnId,
          season,
          source: "sleeper",
          kind: "trending",
          team: mapping.team,
          position: mapping.position,
          trendingAdds: entry.count,
        });
        wireRows.push({ espnId: mapping.espnId, trendingAdds: entry.count, team: mapping.team, position: mapping.position, rank: index });
      }

      let inserted = 0;
      let updated = 0;
      let touched = 0;
      for (const batch of chunk(intelRows, UPSERT_BATCH_SIZE)) {
        const result: IntelUpsertResult = await ctx.runMutation(internal.intelSync.upsertPlayerIntelBatch, { rows: batch });
        inserted += result.inserted;
        updated += result.updated;
        touched += result.touched;
      }

      if (wireRows.length > 0) {
        // Scheduled (not awaited inline): a Wire-side failure must never surface as "Sleeper
        // trending sync failed" - this whole action is wrapped in the try/catch below.
        await ctx.scheduler.runAfter(0, internal.wireDetect.ingestTrending, { rows: wireRows });
      }

      const deletedStale: number = await ctx.runMutation(internal.intelSync.deleteStaleTrending, {
        season,
        olderThan: Date.now() - TRENDING_STALE_MS,
      });

      return { success: true, fetched: entries.length, mapped, unmapped, intel: { inserted, updated, touched }, deletedStale };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync Sleeper trending";
      console.error("syncSleeperTrending failed:", message);
      return { ...empty, error: message };
    }
  },
});

export const lookupIdMapBySleeperId = internalQuery({
  args: { sleeperId: v.string() },
  returns: v.union(v.object({ espnId: v.string(), team: v.optional(v.string()), position: v.optional(v.string()) }), v.null()),
  handler: async (ctx, { sleeperId }) => {
    const row = await ctx.db
      .query("playerIdMap")
      .withIndex("by_sleeper", (q) => q.eq("sleeperId", sleeperId))
      .first();
    if (!row) return null;
    return { espnId: row.espnId, team: row.team, position: row.position };
  },
});

export const deleteStaleTrending = internalMutation({
  args: { season: v.number(), olderThan: v.number() },
  returns: v.number(),
  handler: async (ctx, { season, olderThan }) => {
    // Capped at 300 (the repo's per-mutation batch guidance): the trending
    // list is at most 50 wide per 6-hourly sync, so a backlog this large
    // would mean cleanup has been broken for a long time - worth surfacing,
    // not silently working through in a loop.
    const stale = await ctx.db
      .query("playerIntel")
      .withIndex("by_season_kind", (q) => q.eq("season", season).eq("kind", "trending"))
      .filter((q) => q.lt(q.field("fetchedAt"), olderThan))
      .take(300);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    return stale.length;
  },
});

// --- nflverse: injuries (+ players.csv id-map bootstrap) ----------------

const NFLVERSE_PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv";
const nflverseInjuriesUrl = (season: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.csv`;

export const syncNflverseInjuries = internalAction({
  args: {},
  returns: v.object({
    success: v.boolean(),
    idMapBootstrapped: v.boolean(),
    rowsParsed: v.number(),
    playersConsidered: v.number(),
    matched: v.number(),
    unmatched: v.number(),
    intel: v.object({ inserted: v.number(), updated: v.number(), touched: v.number() }),
    error: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const empty = {
      success: false,
      idMapBootstrapped: false,
      rowsParsed: 0,
      playersConsidered: 0,
      matched: 0,
      unmatched: 0,
      intel: { inserted: 0, updated: 0, touched: 0 },
    };
    try {
      const season = nflSeasonYearFor();

      let idMapBootstrapped = false;
      const needsGsis: boolean = await ctx.runQuery(internal.intelSync.playerIdMapNeedsGsis, {});
      if (needsGsis) {
        idMapBootstrapped = await bootstrapPlayerIdMapFromNflverse(ctx);
      }

      const response = await fetchWithRetry(nflverseInjuriesUrl(season), { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) {
        return { ...empty, idMapBootstrapped, error: `nflverse injuries_${season}.csv HTTP ${response.status}` };
      }
      const text = await response.text();
      const records = parseCsvRecords(text);

      // Latest row per player: max week, then last occurrence in file order
      // (nflverse's own `date_modified` column isn't present in every
      // season's export - when it is, prefer it as the tiebreak).
      const latestByGsis = new Map<string, { record: Record<string, string>; week: number; order: number }>();
      records.forEach((record, order) => {
        const gsisId = (record.gsis_id ?? "").trim();
        if (!gsisId) return;
        const week = Number(record.week);
        const weekValue = Number.isFinite(week) ? week : 0;
        const current = latestByGsis.get(gsisId);
        if (!current) {
          latestByGsis.set(gsisId, { record, week: weekValue, order });
          return;
        }
        const currentModified = current.record.date_modified;
        const candidateModified = record.date_modified;
        const isNewer =
          weekValue > current.week ||
          (weekValue === current.week &&
            candidateModified &&
            currentModified &&
            Date.parse(candidateModified) > Date.parse(currentModified)) ||
          (weekValue === current.week && !candidateModified && !currentModified && order > current.order);
        if (isNewer) latestByGsis.set(gsisId, { record, week: weekValue, order });
      });

      let matched = 0;
      let unmatched = 0;
      const intelRows: IntelUpsertRow[] = [];
      for (const { record } of latestByGsis.values()) {
        const gsisId = record.gsis_id.trim();
        const mapping: IdMapByGsisLookup = await ctx.runQuery(internal.intelSync.lookupIdMapByGsisId, { gsisId });
        if (!mapping) {
          unmatched++;
          continue;
        }
        matched++;

        const observedAt = record.date_modified ? (() => {
          const parsed = Date.parse(record.date_modified);
          return Number.isFinite(parsed) ? parsed : undefined;
        })() : undefined;

        intelRows.push({
          espnId: mapping.espnId,
          season,
          source: "nflverse",
          kind: "injury",
          observedAt,
          team: record.team || undefined,
          position: record.position || undefined,
          injuryStatus: record.report_status || undefined,
          injuryBodyPart: record.report_primary_injury || undefined,
          practiceStatus: record.practice_status || undefined,
        });
      }

      let inserted = 0;
      let updated = 0;
      let touched = 0;
      for (const batch of chunk(intelRows, UPSERT_BATCH_SIZE)) {
        const result: IntelUpsertResult = await ctx.runMutation(internal.intelSync.upsertPlayerIntelBatch, { rows: batch });
        inserted += result.inserted;
        updated += result.updated;
        touched += result.touched;
      }

      return {
        success: true,
        idMapBootstrapped,
        rowsParsed: records.length,
        playersConsidered: latestByGsis.size,
        matched,
        unmatched,
        intel: { inserted, updated, touched },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync nflverse injuries";
      console.error("syncNflverseInjuries failed:", message);
      return { ...empty, error: message };
    }
  },
});

export const lookupIdMapByGsisId = internalQuery({
  args: { gsisId: v.string() },
  returns: v.union(v.object({ espnId: v.string() }), v.null()),
  handler: async (ctx, { gsisId }) => {
    const row = await ctx.db
      .query("playerIdMap")
      .withIndex("by_gsis", (q) => q.eq("gsisId", gsisId))
      .first();
    return row ? { espnId: row.espnId } : null;
  },
});

/** Populate `playerIdMap` from nflverse's players.csv (gsis_id + espn_id) when it's still empty - lets nflverse injuries resolve even before the Sleeper sync has ever run. Returns whether it actually wrote anything. */
async function bootstrapPlayerIdMapFromNflverse(ctx: ActionCtx): Promise<boolean> {
  const response = await fetchWithRetry(NFLVERSE_PLAYERS_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    console.warn(`nflverse players.csv bootstrap failed: HTTP ${response.status}`);
    return false;
  }
  const text = await response.text();
  const records = parseCsvRecords(text);

  const rows: Infer<typeof idMapUpsertRowValidator>[] = [];
  for (const record of records) {
    const espnId = (record.espn_id ?? "").trim();
    const gsisId = (record.gsis_id ?? "").trim();
    if (!espnId || !gsisId) continue;
    rows.push({
      espnId,
      gsisId,
      fullName: record.display_name || "",
      position: record.position || undefined,
      team: record.latest_team || undefined,
    });
  }

  for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
    const result: IdMapUpsertResult = await ctx.runMutation(internal.intelSync.upsertPlayerIdMapBatch, { rows: batch });
    void result;
  }
  return rows.length > 0;
}

// --- Fantasy Football Calculator: ADP / market -------------------------

const FFC_FORMATS = ["ppr", "half-ppr", "standard"] as const;
const FFC_TEAM_SIZES = [10, 12] as const;

interface FfcPlayer {
  name: string;
  position: string;
  team?: string;
  adp: number;
  times_drafted?: number;
  bye?: number;
}

/** Next season's boards are fetched once ESPN has at least this many players in the new pool. */
const NEXT_SEASON_POOL_MIN = 200;

const ffcAdpUrl = (format: string, teams: number, season: number) =>
  `https://fantasyfootballcalculator.com/api/v1/adp/${format}?teams=${teams}&year=${season}`;

export const syncFfcAdp = internalAction({
  args: {},
  returns: v.object({
    success: v.boolean(),
    boards: v.array(
      v.object({ market: v.string(), season: v.number(), fetched: v.number(), matched: v.number(), unmatched: v.number(), error: v.optional(v.string()) }),
    ),
    intel: v.object({ inserted: v.number(), updated: v.number(), touched: v.number() }),
  }),
  handler: async (ctx) => {
    const boards: Array<{ market: string; season: number; fetched: number; matched: number; unmatched: number; error?: string }> = [];
    const allIntelRows: IntelUpsertRow[] = [];

    // This season's boards, and next season's as soon as ESPN has opened the new player pool
    // (the ids the boards are keyed to): a dynasty or best-ball league drafting in May reads the
    // new year's ADP while the app's own season label (Aug->Jul) still says last year.
    const thisSeason = nflSeasonYearFor();
    const seasons = [thisSeason];
    const nextPool: PlayersEnhancedForMatch = await ctx.runQuery(internal.intelSync.listPlayersEnhancedForSeason, { season: thisSeason + 1 });
    if (nextPool.length >= NEXT_SEASON_POOL_MIN) seasons.push(thisSeason + 1);

    for (const season of seasons) {
    const players: PlayersEnhancedForMatch =
      season === thisSeason ? await ctx.runQuery(internal.intelSync.listPlayersEnhancedForSeason, { season }) : nextPool;
    const espnRefs: EspnPlayerRef[] = players.map((p) => ({ espnId: p.espnId, fullName: p.fullName, position: p.position, team: p.team }));
    const matchIndex = buildEspnMatchIndex(espnRefs);

    for (const format of FFC_FORMATS) {
      for (const teams of FFC_TEAM_SIZES) {
        const market = `${format}-${teams}`;
        try {
          const response = await fetchWithRetry(ffcAdpUrl(format, teams, season), { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
          if (!response.ok) {
            boards.push({ market, season, fetched: 0, matched: 0, unmatched: 0, error: `HTTP ${response.status}` });
            continue;
          }
          const body = (await response.json()) as { players?: FfcPlayer[] };
          const ffcPlayers = body.players ?? [];

          // Rank within this board's own response, per position - the board
          // is already sorted by overall adp; rank is just a running count.
          const positionSeen = new Map<string, number>();
          const sorted = [...ffcPlayers].sort((a, b) => a.adp - b.adp);

          let matched = 0;
          let unmatched = 0;
          for (const player of sorted) {
            const pos = normalizePosition(player.position);
            const nextRank = (positionSeen.get(pos) ?? 0) + 1;
            positionSeen.set(pos, nextRank);

            const espnId = matchPlayerToEspnId(matchIndex, { name: player.name, position: player.position, team: player.team });
            if (!espnId) {
              unmatched++;
              continue;
            }
            matched++;
            allIntelRows.push({
              espnId,
              season,
              source: "ffc",
              kind: "market",
              team: player.team,
              position: pos,
              adp: player.adp,
              adpPositionRank: nextRank,
              timesDrafted: player.times_drafted,
              bye: player.bye,
              market,
            });
          }

          boards.push({ market, season, fetched: ffcPlayers.length, matched, unmatched });
          if (unmatched > 0) {
            console.warn(`syncFfcAdp: ${unmatched} unmatched name(s) on ${market} (of ${ffcPlayers.length})`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "fetch failed";
          boards.push({ market, season, fetched: 0, matched: 0, unmatched: 0, error: message });
        }
      }
    }
    }

    let inserted = 0;
    let updated = 0;
    let touched = 0;
    for (const batch of chunk(allIntelRows, UPSERT_BATCH_SIZE)) {
      const result: IntelUpsertResult = await ctx.runMutation(internal.intelSync.upsertPlayerIntelBatch, { rows: batch });
      inserted += result.inserted;
      updated += result.updated;
      touched += result.touched;
    }

    // Next season's boards may 404 for weeks after ESPN opens its pool; only this season decides success.
    return { success: boards.filter((b) => b.season === thisSeason).every((b) => !b.error), boards, intel: { inserted, updated, touched } };
  },
});

// --- Run everything (cron entry point) ----------------------------------

export const syncAllPlayerIntel = internalAction({
  args: {},
  returns: v.object({
    sleeperPlayers: v.optional(v.any()),
    sleeperTrending: v.optional(v.any()),
    nflverseInjuries: v.optional(v.any()),
    ffcAdp: v.optional(v.any()),
    errors: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const errors: string[] = [];
    const result: {
      sleeperPlayers?: unknown;
      sleeperTrending?: unknown;
      nflverseInjuries?: unknown;
      ffcAdp?: unknown;
      errors: string[];
    } = { errors };

    try {
      const sleeperPlayers: unknown = await ctx.runAction(internal.intelSync.syncSleeperPlayers, {});
      result.sleeperPlayers = sleeperPlayers;
    } catch (err) {
      errors.push(`syncSleeperPlayers threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const sleeperTrending: unknown = await ctx.runAction(internal.intelSync.syncSleeperTrending, {});
      result.sleeperTrending = sleeperTrending;
    } catch (err) {
      errors.push(`syncSleeperTrending threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const nflverseInjuries: unknown = await ctx.runAction(internal.intelSync.syncNflverseInjuries, {});
      result.nflverseInjuries = nflverseInjuries;
    } catch (err) {
      errors.push(`syncNflverseInjuries threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const ffcAdp: unknown = await ctx.runAction(internal.intelSync.syncFfcAdp, {});
      result.ffcAdp = ffcAdp;
    } catch (err) {
      errors.push(`syncFfcAdp threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  },
});

// --- Cron entry point with a run log ------------------------------------

export const INTEL_SOURCES = ["sleeper_players", "sleeper_trending", "nflverse_injuries", "ffc_adp"] as const;
export type IntelSyncSource = (typeof INTEL_SOURCES)[number];

const syncRunSourceValidator = v.union(
  v.literal("sleeper_players"),
  v.literal("sleeper_trending"),
  v.literal("nflverse_injuries"),
  v.literal("ffc_adp"),
);

export const recordSyncRun = internalMutation({
  args: { source: syncRunSourceValidator, ranAt: v.number(), ok: v.boolean(), summary: v.string(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("intelSyncRuns", args);
    // Keep the log short: the digest reads the latest row per source, nothing reads history.
    const old = await ctx.db
      .query("intelSyncRuns")
      .withIndex("by_source_ranAt", (q) => q.eq("source", args.source).lt("ranAt", args.ranAt - 14 * 24 * 60 * 60 * 1000))
      .take(50);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});

/** The latest run per source, for the operator digest (convex/lib/feedFreshness.ts). */
export const latestSyncRuns = internalQuery({
  args: {},
  returns: v.array(
    v.object({ source: syncRunSourceValidator, ranAt: v.number(), ok: v.boolean(), summary: v.string(), error: v.optional(v.string()) }),
  ),
  handler: async (ctx) => {
    const out: Array<{ source: IntelSyncSource; ranAt: number; ok: boolean; summary: string; error?: string }> = [];
    for (const source of INTEL_SOURCES) {
      const row = await ctx.db
        .query("intelSyncRuns")
        .withIndex("by_source_ranAt", (q) => q.eq("source", source))
        .order("desc")
        .first();
      if (row) out.push({ source: row.source, ranAt: row.ranAt, ok: row.ok, summary: row.summary, error: row.error });
    }
    return out;
  },
});

/**
 * What the crons call (2026-09-05): one feed per run, its outcome written to `intelSyncRuns` so
 * a feed that silently stops (a moved URL, a schema change upstream) shows up in the next
 * operator digest instead of going unnoticed until an article reads stale intel.
 */
export const runIntelSync = internalAction({
  args: { source: syncRunSourceValidator },
  returns: v.object({ ok: v.boolean(), summary: v.string() }),
  handler: async (ctx, { source }): Promise<{ ok: boolean; summary: string }> => {
    const ranAt = Date.now();
    let ok = false;
    let summary = "";
    let error: string | undefined;
    try {
      switch (source) {
        case "sleeper_players": {
          const r = await ctx.runAction(internal.intelSync.syncSleeperPlayers, {});
          ok = r.success;
          error = "error" in r ? r.error : undefined;
          summary = `${r.kept} players (${r.matchedByName} matched by name), ${r.intel.inserted + r.intel.updated} changed`;
          break;
        }
        case "sleeper_trending": {
          const r = await ctx.runAction(internal.intelSync.syncSleeperTrending, {});
          ok = r.success;
          summary = `${r.mapped} of ${r.fetched} trending mapped`;
          break;
        }
        case "nflverse_injuries": {
          const r = await ctx.runAction(internal.intelSync.syncNflverseInjuries, {});
          ok = r.success;
          error = "error" in r ? r.error : undefined;
          summary = `${r.matched} players matched`;
          break;
        }
        case "ffc_adp": {
          const r = await ctx.runAction(internal.intelSync.syncFfcAdp, {});
          ok = r.success;
          const seasons = [...new Set(r.boards.filter((b) => !b.error).map((b) => b.season))].join("/");
          const failed = r.boards.filter((b) => b.error).length;
          summary = `${r.boards.length - failed} boards (${seasons || "none"}), ${r.intel.inserted + r.intel.updated} changed`;
          error = failed > 0 ? `${failed} board(s) failed` : undefined;
          break;
        }
      }
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    }
    await ctx.runMutation(internal.intelSync.recordSyncRun, { source, ranAt, ok, summary, error });
    return { ok, summary };
  },
});
