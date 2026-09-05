/**
 * Read side of the player-intelligence layer: fresh, cited color for AI
 * sportswriters (injuries, practice status, depth chart, market data) beyond
 * points and projections. Populated by `convex/intelSync.ts`'s cron-driven
 * syncs; the freshness policy that decides what's still current enough to
 * state as fact lives in `convex/lib/intelFreshness.ts` (pure, unit tested).
 *
 * Internal only - call `internal.intel.getIntelForPlayers({ season, espnIds,
 * now: Date.now() })` from wherever article generation assembles player
 * context (e.g. `convex/aiQueries.ts`).
 */
import { v } from "convex/values";
import { internalQuery, QueryCtx } from "./_generated/server";
import { FreshIntelRow, FreshNewsRow, selectFreshIntel } from "./lib/intelFreshness";

/** One player's fresh intel, as the article payloads carry it (`playerIntel` on the league data). */
export interface PlayerIntelEntry {
  espnId: string;
  name?: string;
  injury?: ReturnType<typeof selectFreshIntel>["injury"];
  cleared?: ReturnType<typeof selectFreshIntel>["cleared"];
  depthChart?: ReturnType<typeof selectFreshIntel>["depthChart"];
  market?: ReturnType<typeof selectFreshIntel>["market"];
  news: ReturnType<typeof selectFreshIntel>["news"];
}

/** True when the entry says something an article could use; the rest is noise for the prompt. */
export function intelHasContent(entry: PlayerIntelEntry): boolean {
  return (
    entry.injury !== undefined ||
    entry.cleared !== undefined ||
    entry.depthChart !== undefined ||
    entry.market !== undefined ||
    entry.news.length > 0
  );
}

/** Convex read-limit guard: this query runs inside article generation, not paginated UI. */
const MAX_ESPN_IDS = 250;
/** Widest window any freshness rule needs (news-with-active-injury is 30 days); read once. */
const NEWS_LOOKBACK_DAYS = 30;
/** Bounded collection per Convex query guidelines - well above what 30 days of NFL news produces. */
const NEWS_READ_CAP = 1500;
/** An article tagged to more athletes than this is a listicle, not a story about a player. */
const LISTICLE_ATHLETE_LIMIT = 6;

const injuryValidator = v.object({
  status: v.string(),
  bodyPart: v.optional(v.string()),
  practice: v.optional(v.string()),
  notes: v.optional(v.string()),
  since: v.optional(v.number()),
  source: v.union(v.literal("sleeper"), v.literal("nflverse")),
  fetchedAt: v.number(),
  espnStatus: v.optional(v.string()),
});

const clearedValidator = v.object({
  source: v.union(v.literal("sleeper"), v.literal("nflverse")),
  fetchedAt: v.number(),
  espnStatus: v.string(),
});

const depthChartValidator = v.object({
  team: v.optional(v.string()),
  position: v.string(),
  order: v.number(),
  source: v.literal("sleeper"),
});

const marketValidator = v.object({
  /** The season the board belongs to; differs from the article's season only on a fallback. */
  season: v.optional(v.number()),
  ffcAdp: v.optional(v.number()),
  ffcPositionRank: v.optional(v.number()),
  bye: v.optional(v.number()),
  timesDrafted: v.optional(v.number()),
  market: v.optional(v.string()),
  trendingAdds: v.optional(v.number()),
});

const newsItemValidator = v.object({
  headline: v.string(),
  description: v.optional(v.string()),
  publishedAt: v.string(),
  url: v.optional(v.string()),
  source: v.literal("espn"),
});

export const getIntelForPlayers = internalQuery({
  args: {
    season: v.number(),
    espnIds: v.array(v.string()),
    /** Wall-clock time to evaluate freshness against; defaults to `Date.now()` for callers that don't need reactive caching. */
    now: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      espnId: v.string(),
      name: v.optional(v.string()),
      injury: v.optional(injuryValidator),
      cleared: v.optional(clearedValidator),
      depthChart: v.optional(depthChartValidator),
      market: v.optional(marketValidator),
      news: v.array(newsItemValidator),
    }),
  ),
  handler: async (ctx, args) => getIntelForPlayersImpl(ctx, args),
});

/**
 * The query's body as a helper, so `aiQueries.getLeagueDataForAI` / `getMockDraftDataForAI`
 * (queries themselves) can attach intel without a nested `ctx.runQuery`.
 */
export async function getIntelForPlayersImpl(
  ctx: QueryCtx,
  { season, espnIds, now }: { season: number; espnIds: string[]; now?: number },
): Promise<PlayerIntelEntry[]> {
  {
    const effectiveNow = now ?? Date.now();
    // Cap at 250 ids: this query does two indexed reads per id (playerIntel +
    // playersEnhanced) plus one shared news scan, so an uncapped roster list
    // could otherwise blow past Convex's per-call read limits.
    const ids = espnIds.slice(0, MAX_ESPN_IDS);
    if (ids.length === 0) return [];

    const idSet = new Set(ids);
    const cutoffIso = new Date(effectiveNow - NEWS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // One shared range-scan for news (published is the index key), then
    // group by athlete id in memory - cheaper than one query per player.
    const recentNews = await ctx.db
      .query("espnNews")
      .withIndex("by_published", (q) => q.gte("published", cutoffIso))
      .order("desc")
      .take(NEWS_READ_CAP);

    const newsByEspnId = new Map<string, FreshNewsRow[]>();
    for (const article of recentNews) {
      // A cheat sheet or a sleepers column is tagged to dozens of athletes; it is not news about
      // any one of them (same rule as convex/lib/mockDraftIntel.ts's indexNewsByPlayer).
      if (article.categories.athletes.length > LISTICLE_ATHLETE_LIMIT) continue;
      for (const athlete of article.categories.athletes) {
        // categories.athletes[].id is a number; playerIntel/playersEnhanced key on the string form.
        const athleteEspnId = String(athlete.id);
        if (!idSet.has(athleteEspnId)) continue;
        const list = newsByEspnId.get(athleteEspnId);
        const item: FreshNewsRow = {
          headline: article.headline,
          description: article.description,
          published: article.published,
          url: article.links.web ?? article.links.mobile,
        };
        if (list) list.push(item);
        else newsByEspnId.set(athleteEspnId, [item]);
      }
    }

    const results: PlayerIntelEntry[] = [];

    for (const espnId of ids) {
      const [thisSeasonDocs, playerDoc] = await Promise.all([
        ctx.db
          .query("playerIntel")
          .withIndex("by_player_season", (q) => q.eq("espnId", espnId).eq("season", season))
          .collect(),
        ctx.db
          .query("playersEnhanced")
          .withIndex("by_espn_id_season", (q) => q.eq("espnId", espnId).eq("season", season))
          .first(),
      ]);

      // Season labels are bookkeeping (Aug->Jul on the sync side, ESPN's on the league side): a
      // dynasty draft in May asks for next season while the feeds still stamp last season's
      // label. Injury, practice, depth chart and trending are season-agnostic, so last season's
      // rows stand in when this season has none (the freshness windows still apply, so nothing
      // stale gets through); a market board falls back too, carrying its own season for the
      // prompt to label.
      let intelDocs = thisSeasonDocs;
      const isMarket = (row: { kind: string }) => row.kind === "market";
      const needAgnostic = !thisSeasonDocs.some((row) => !isMarket(row));
      const needMarket = !thisSeasonDocs.some(isMarket);
      if (needAgnostic || needMarket) {
        const previous = await ctx.db
          .query("playerIntel")
          .withIndex("by_player_season", (q) => q.eq("espnId", espnId).eq("season", season - 1))
          .collect();
        intelDocs = [...thisSeasonDocs, ...previous.filter((row) => (isMarket(row) ? needMarket : needAgnostic))];
      }

      const freshRows: FreshIntelRow[] = intelDocs.map((row) => ({
        source: row.source,
        kind: row.kind,
        season: row.season,
        fetchedAt: row.fetchedAt,
        observedAt: row.observedAt,
        team: row.team,
        injuryStatus: row.injuryStatus,
        injuryBodyPart: row.injuryBodyPart,
        injuryNotes: row.injuryNotes,
        statusChangedAt: row.statusChangedAt,
        practiceStatus: row.practiceStatus,
        practiceDescription: row.practiceDescription,
        depthPosition: row.depthPosition,
        depthOrder: row.depthOrder,
        adp: row.adp,
        adpPositionRank: row.adpPositionRank,
        timesDrafted: row.timesDrafted,
        bye: row.bye,
        market: row.market,
        trendingAdds: row.trendingAdds,
      }));

      const selected = selectFreshIntel(freshRows, effectiveNow, {
        newsRows: newsByEspnId.get(espnId) ?? [],
        espnInjuryStatus: playerDoc?.injuryStatus,
      });

      results.push({
        espnId,
        name: playerDoc?.fullName,
        injury: selected.injury,
        cleared: selected.cleared,
        depthChart: selected.depthChart,
        market: selected.market,
        news: selected.news,
      });
    }

    return results;
  }
}
