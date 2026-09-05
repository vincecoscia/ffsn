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
