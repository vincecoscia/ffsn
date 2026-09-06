"use node";

/**
 * The Wire — ESPN injuries poller (ffsn-the-wire-spec.md §5.1, §6, §12.1). "use node" only because
 * every other action file that hits an ESPN endpoint (`espnNews.ts`, `intelSync.ts`) already is;
 * this one only uses `fetch`, which works fine in the default runtime too, but keeping it Node
 * matches the repo's own convention for "poller" action files and leaves room to add a Node-only
 * dependency later without a file split.
 *
 * `https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries` is ~9 MB. Parsing (id
 * resolution from `athlete.links[].href`, the field shapes) is `src/lib/ai/wire/espn.ts`'s
 * `parseEspnInjuriesPayload` - the same parser the eval script and `wireDetect.ts` (which turns a
 * parsed entry into a fact card via `injuryEntryToCard`) use, so a payload shape change is handled
 * once, not three times.
 *
 * The cursor (`wireSourceState.cursor`, source `"espn_injuries"`) maps entry id -> `{date, status}`;
 * an entry is "changed" when its id is new or either field differs from the cursor. Changed entries
 * go to `wireDetect.ingestInjuryEntries` in chunks of <=100, each carrying its cursor `previousStatus`
 * so the detector (via `injuryEntryToCard`) can tell a status change from a same-status note - the
 * same default ("Active" when never seen before) `injuryEntryToCard` itself applies. Never throws
 * (same contract as `intelSync.ts`'s sync actions) - every failure path still records a
 * `wireSourceState` row so the operator digest sees it.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { parseEspnInjuriesPayload, type EspnInjuryEntry } from "../src/lib/ai/wire/espn";
import { wireEnabled } from "./lib/wireLeaguePosting";
import { nflSeasonYearFor } from "./lib/season";

const ESPN_INJURIES_PRIMARY = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";
// Fallback on a 403 from the primary host - the same trick convex/espnNews.ts documents.
const ESPN_INJURIES_FALLBACK = "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/injuries";
const USER_AGENT = "FFSN/1.0 (+https://www.ffsn.ai)";
const SOURCE = "espn_injuries";
const CHUNK_SIZE = 100;
/** Off-season throttle (spec §5.1): March-July, don't re-fetch inside this window of the last run. */
const OFFSEASON_THROTTLE_MS = 30 * 60 * 1000;

type CursorEntry = { date: string; status: string };
type Cursor = Record<string, CursorEntry>;

/** An entry whose ESPN `date` is older than this is never ingested, however new its id is to us. */
const MAX_ENTRY_AGE_MS = 48 * 60 * 60 * 1000;

function isOffSeasonMonth(date: Date): boolean {
  const month = date.getUTCMonth(); // 0-indexed: Jan=0 ... Dec=11
  return month >= 2 && month <= 6; // March - July
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function fetchInjuries(url: string): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
}

export const pollEspnInjuries = internalAction({
  args: {},
  returns: v.object({
    success: v.boolean(),
    fetched: v.number(),
    changed: v.number(),
    posted: v.number(),
    skippedOffSeason: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const empty = { success: false, fetched: 0, changed: 0, posted: 0, skippedOffSeason: false };

    if (!wireEnabled()) {
      return { ...empty, success: true, skippedOffSeason: true };
    }

    try {
      const previous: { cursor?: unknown; lastRunAt: number; ok: boolean } | null = await ctx.runQuery(
        internal.wireDetect.getSourceCursor,
        { source: SOURCE }
      );

      if (isOffSeasonMonth(new Date(now)) && previous && now - previous.lastRunAt < OFFSEASON_THROTTLE_MS) {
        return { ...empty, success: true, skippedOffSeason: true };
      }

      let response = await fetchInjuries(ESPN_INJURIES_PRIMARY);
      if (response.status === 403) {
        response = await fetchInjuries(ESPN_INJURIES_FALLBACK);
      }
      if (!response.ok) {
        const error = `ESPN injuries HTTP ${response.status}`;
        await ctx.runMutation(internal.wireDetect.recordSourceRun, {
          source: SOURCE,
          cursor: previous?.cursor,
          ok: false,
          summary: "fetch failed",
          error,
        });
        return { ...empty, error };
      }

      const payload: unknown = await response.json();
      const parsed = parseEspnInjuriesPayload(payload);
      const previousCursor = (previous?.cursor as Cursor | undefined) ?? {};
      const nextCursor: Cursor = {};
      const changed: Array<{ entry: EspnInjuryEntry; previousStatus?: string }> = [];

      // Cold start (2026-09-05, first dev poll): with no cursor every one of ESPN's ~800 entries is
      // "new", most of them August notes - seed the cursor and post nothing. From then on only a
      // genuinely changed entry is ingested, and never one whose own `date` is older than
      // MAX_ENTRY_AGE_MS (a stale note that only surfaced because its id was new to us).
      const coldStart = Object.keys(previousCursor).length === 0;
      let stale = 0;

      for (const { entry } of parsed) {
        const date = entry.date ?? "";
        nextCursor[entry.id] = { date, status: entry.status };
        if (coldStart) continue;
        const prior = previousCursor[entry.id];
        const isChanged = !prior || prior.date !== date || prior.status !== entry.status;
        if (!isChanged) continue;
        const dateMs = Date.parse(date);
        if (Number.isFinite(dateMs) && now - dateMs > MAX_ENTRY_AGE_MS) {
          stale++;
          continue;
        }
        changed.push({ entry, previousStatus: prior?.status });
      }

      let posted = 0;
      for (const batch of chunk(changed, CHUNK_SIZE)) {
        const result: { posted: number } = await ctx.runMutation(internal.wireDetect.ingestInjuryEntries, {
          entries: batch,
          fetchedAt: now,
        });
        posted += result.posted;
      }

      await ctx.runMutation(internal.wireDetect.recordSourceRun, {
        source: SOURCE,
        cursor: nextCursor,
        ok: true,
        summary: coldStart
          ? `cold start: seeded ${parsed.length} entries, nothing posted`
          : `${parsed.length} entries, ${changed.length} changed, ${stale} stale skipped, ${posted} posted`,
      });

      return { success: true, fetched: parsed.length, changed: changed.length, posted, skippedOffSeason: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to poll ESPN injuries";
      console.error("pollEspnInjuries failed:", message);
      try {
        await ctx.runMutation(internal.wireDetect.recordSourceRun, {
          source: SOURCE,
          ok: false,
          summary: "threw",
          error: message,
        });
      } catch {
        // Recording the failure is best-effort; the outer catch already has the real error.
      }
      return { ...empty, error: message };
    }
  },
});

/* -------------------------------------------------------------------------- *
 * NFL schedule / kickoffs (Dex Desk, ffsn-the-wire-spec.md §18): the current NFL week and the next,
 * from ESPN's public scoreboard - no cookies, same host family as the injuries poll above. Rows are
 * upserted and upcoming kickoffs are scheduled for lineup-lock checks by `convex/wireDesk.ts`
 * (`upsertNflScheduleRows`, `scheduleLineupLockChecks`) - this file only fetches and parses.
 * -------------------------------------------------------------------------- */

const NFL_SCOREBOARD_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

interface ScoreboardTeam {
  id?: string;
  abbreviation?: string;
}
interface ScoreboardCompetitor {
  team?: ScoreboardTeam;
  homeAway?: string;
}
interface ScoreboardCompetition {
  date?: string;
  competitors?: ScoreboardCompetitor[];
}
interface ScoreboardEvent {
  date?: string;
  competitions?: ScoreboardCompetition[];
}
interface ScoreboardPayload {
  week?: { number?: number };
  season?: { year?: number };
  events?: ScoreboardEvent[];
}

async function fetchScoreboard(week?: number): Promise<ScoreboardPayload> {
  const url = week ? `${NFL_SCOREBOARD_BASE}?seasontype=2&week=${week}` : `${NFL_SCOREBOARD_BASE}?seasontype=2`;
  let response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (response.status === 403) {
    // Same bot filter the injuries poll and espnNews.ts hit: site.web.api.espn.com serves the
    // identical payload without it (dev, 2026-09-05: the primary host answered 403 from Convex).
    response = await fetch(url.replace("https://site.api.espn.com/", "https://site.web.api.espn.com/"), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  }
  if (!response.ok) throw new Error(`ESPN scoreboard HTTP ${response.status}`);
  return (await response.json()) as ScoreboardPayload;
}

interface ScheduleRow {
  season: number;
  week: number;
  teamId: number;
  teamAbbrev: string;
  opponent: string;
  isHome: boolean;
  gameTime: number;
  isByeWeek: boolean;
}

export const pollNflSchedule = internalAction({
  args: {},
  returns: v.object({ success: v.boolean(), rows: v.number(), scheduled: v.number(), error: v.optional(v.string()) }),
  handler: async (ctx) => {
    if (!wireEnabled()) return { success: true, rows: 0, scheduled: 0 };

    try {
      // Called without `week` first so ESPN's own `week.number` tells us the current NFL week
      // (spec §18: "week from the scoreboard's own week.number when called without params").
      const discovery = await fetchScoreboard();
      const currentWeek = discovery.week?.number;
      if (!currentWeek) throw new Error("ESPN scoreboard did not report a current week");
      const season = discovery.season?.year ?? nflSeasonYearFor();

      const rows: ScheduleRow[] = [];
      const kickoffsByWeek = new Map<number, Set<number>>();

      for (const week of [currentWeek, currentWeek + 1]) {
        const payload = week === currentWeek ? discovery : await fetchScoreboard(week);
        for (const event of payload.events ?? []) {
          const competition = event.competitions?.[0];
          if (!competition) continue;
          const gameTime = Date.parse(event.date ?? competition.date ?? "");
          if (!Number.isFinite(gameTime)) continue;
          const competitors = competition.competitors ?? [];
          for (const competitor of competitors) {
            const abbrev = competitor.team?.abbreviation;
            const teamIdNum = parseInt(competitor.team?.id ?? "", 10);
            if (!abbrev || !Number.isFinite(teamIdNum)) continue;
            const opponent = competitors.find((c) => c !== competitor)?.team?.abbreviation ?? "";
            rows.push({ season, week, teamId: teamIdNum, teamAbbrev: abbrev, opponent, isHome: competitor.homeAway === "home", gameTime, isByeWeek: false });
          }
          const set = kickoffsByWeek.get(week) ?? new Set<number>();
          set.add(gameTime);
          kickoffsByWeek.set(week, set);
        }
      }

      const upsertResult: { upserted: number } = await ctx.runMutation(internal.wireDesk.upsertNflScheduleRows, { rows });
      const upserted = upsertResult.upserted;

      const now = Date.now();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      const kickoffs: Array<{ kickoffAt: number; season: number; week: number }> = [];
      for (const [week, set] of kickoffsByWeek) {
        for (const kickoffAt of set) {
          if (kickoffAt > now && kickoffAt <= now + sevenDays) kickoffs.push({ kickoffAt, season, week });
        }
      }
      const scheduleResult: { scheduled: number } = await ctx.runMutation(internal.wireDesk.scheduleLineupLockChecks, { kickoffs });
      const scheduled = scheduleResult.scheduled;

      // The live game engine (spec §19.1): a freshly-discovered game week's kickoffs should wake a
      // dead clock immediately rather than waiting for the next daily `ensureWireClock` cron.
      try {
        await ctx.runMutation(internal.wireLive.ensureWireClock, {});
      } catch (clockError) {
        console.error("pollNflSchedule: ensureWireClock failed:", clockError);
      }

      return { success: true, rows: upserted, scheduled };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to poll NFL schedule";
      console.error("pollNflSchedule failed:", message);
      try {
        const state = await ctx.runQuery(internal.wireDetect.getSourceCursor, { source: "nfl_kickoffs" });
        await ctx.runMutation(internal.wireDetect.recordSourceRun, {
          source: "nfl_kickoffs",
          cursor: state?.cursor,
          ok: false,
          summary: "threw",
          error: message,
        });
      } catch {
        // best-effort - the outer catch already has the real error
      }
      return { success: false, rows: 0, scheduled: 0, error: message };
    }
  },
});
