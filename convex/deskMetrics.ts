/**
 * Desk metrics (spec §8.7).
 *
 * One commissioner-only query that turns the verifier's bookkeeping on `aiContent` into the three
 * numbers the desk is actually run on:
 *
 *   ungroundedPer1k  (blocks + strips) per 1,000 published words. How often a writer says something
 *                    the FACTS block does not support. Lower is better; 0 is the target.
 *   quoteFidelity    quotesUsed / quotesOffered. How much of the ledger a writer actually used.
 *                    `null` when nobody went on the record, which is not a failure.
 *   paddingIndex     wordCount / factsCount. Words spent per fact available. The spec's word
 *                    targets are ceilings, so a rising padding index is the failure mode to watch.
 *
 * Everything is read defensively: `generationStats` is optional, and the four §8.7 fields
 * (`factsCount`, `wordCount`, `quotesOffered`, `quotesUsed`) are optional inside it, because
 * articles generated before those fields existed are still in the table. A metric with no inputs
 * comes back `null` rather than 0 — "we don't have that yet" is a different statement from "zero".
 */

import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCommissioner } from "./lib/auth";
import { passSeasonId } from "./credits";

/** How many recent articles one call may scan. Keeps the query bounded as the table grows. */
const MAX_ARTICLES = 500;

/** How many verifier findings the flag feed returns. */
const MAX_FLAGS = 20;

/* -------------------------------------------------------------------------- *
 * Spend (spec §10.1 cap, §10.3.4 accounting)
 * -------------------------------------------------------------------------- */

/** How many articles / comment requests one season spend roll-up may scan. */
const MAX_SPEND_ROWS = 1000;

/** Regular season + playoffs. Used only to project a season from a run rate. */
const SEASON_WEEKS = 18;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Default per-league, per-season ceiling on measured API cost for automated
 * content, in USD (spec §10.1). A safety valve, not a product limit: the
 * projected worst case for a 12-manager season is about $16.50.
 *
 * Overridable with the Convex env var `AUTOMATION_SPEND_CAP_USD`. A malformed
 * or non-positive value falls back to the default rather than taking the whole
 * desk offline (or, worse, uncapping it).
 */
export const DEFAULT_AUTOMATION_SPEND_CAP_USD = 60;

export function automationSpendCapUsd(): number {
  const raw = process.env.AUTOMATION_SPEND_CAP_USD;
  if (!raw) return DEFAULT_AUTOMATION_SPEND_CAP_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `AUTOMATION_SPEND_CAP_USD is not a positive number ("${raw}"); using $${DEFAULT_AUTOMATION_SPEND_CAP_USD}`
    );
    return DEFAULT_AUTOMATION_SPEND_CAP_USD;
  }
  return parsed;
}

const seasonSpendValidator = v.object({
  seasonId: v.number(),
  /** Stories the League Pass paid for: the §9.1 calendar and event triggers. */
  automatedUsd: v.number(),
  /** Stories a manager spent their own credits on. */
  manualUsd: v.number(),
  /** Sam Ortega's interviews, whoever the article was for. */
  interviewUsd: v.number(),
  totalUsd: v.number(),
  articles: v.number(),
  interviews: v.number(),
  /** True when the scan hit its row cap and older rows went uncounted. */
  truncated: v.boolean(),
});

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * What one league has cost us in measured API spend this season.
 *
 * Bounded on both sides: articles come off `by_league_season` and comment
 * requests off `by_league`, each capped at {@link MAX_SPEND_ROWS}. An article
 * with no `generationStats.costUsd` (everything written before the cost
 * accounting shipped) contributes nothing rather than being guessed at.
 *
 * Billing attribution: `billing: "credits"` is a manager's own spend. Anything
 * else - including the legacy rows with no billing field at all - counts as
 * automated, so the cap errs towards pausing automation rather than towards
 * running up a bill nobody agreed to.
 */
async function seasonSpend(
  ctx: QueryCtx,
  leagueId: Id<"leagues">,
  seasonId: number
): Promise<{
  seasonId: number;
  automatedUsd: number;
  manualUsd: number;
  interviewUsd: number;
  totalUsd: number;
  articles: number;
  interviews: number;
  truncated: boolean;
  firstArticleAt: number | null;
}> {
  const articles = await ctx.db
    .query("aiContent")
    .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .order("desc")
    .take(MAX_SPEND_ROWS);

  let automatedUsd = 0;
  let manualUsd = 0;
  let counted = 0;
  let firstArticleAt: number | null = null;

  for (const article of articles) {
    const cost = article.generationStats?.costUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) continue;
    if (article.generationStats?.billing === "credits") {
      manualUsd += cost;
    } else {
      automatedUsd += cost;
    }
    counted++;
    const createdAt = article.createdAt ?? article._creationTime;
    if (firstArticleAt === null || createdAt < firstArticleAt) firstArticleAt = createdAt;
  }

  // Interviews are keyed to the article they feed, not to a season column, so
  // this reads the league's requests and matches on the context season. A
  // request with no season recorded is counted: it can only belong to a live
  // article, and undercounting the cap is the dangerous direction.
  const requests = await ctx.db
    .query("commentRequests")
    .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
    .order("desc")
    .take(MAX_SPEND_ROWS);

  let interviewUsd = 0;
  let interviews = 0;
  for (const request of requests) {
    const cost = request.interviewCostUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) continue;
    const requestSeason = request.articleContext?.seasonId;
    if (requestSeason !== undefined && requestSeason !== seasonId) continue;
    interviewUsd += cost;
    interviews++;
  }

  const totalUsd = automatedUsd + manualUsd + interviewUsd;

  return {
    seasonId,
    automatedUsd: round4(automatedUsd),
    manualUsd: round4(manualUsd),
    interviewUsd: round4(interviewUsd),
    totalUsd: round4(totalUsd),
    articles: counted,
    interviews,
    truncated: articles.length === MAX_SPEND_ROWS || requests.length === MAX_SPEND_ROWS,
    firstArticleAt,
  };
}

/**
 * Season spend for one league, for the automation gate in
 * `contentScheduling.processScheduledContent`. Internal: the cap decision is
 * ours, not a client's.
 */
export const getLeagueSeasonSpend = internalQuery({
  args: { leagueId: v.id("leagues"), seasonId: v.number() },
  returns: seasonSpendValidator,
  handler: async (ctx, args) => {
    // `firstArticleAt` only exists to date the run-rate projection, which the
    // spend gate does not use; it is dropped rather than returned.
    const { firstArticleAt, ...spend } = await seasonSpend(ctx, args.leagueId, args.seasonId);
    void firstArticleAt;
    return spend;
  },
});

/**
 * The same numbers for the commissioner, plus the cap they are measured
 * against and what the season projects to at the current weekly run rate.
 * Commissioner-only: it is the league's bill.
 */
export const getLeagueSpend = query({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
    /** Passed in rather than read from the clock, so the query stays cacheable. */
    now: v.optional(v.number()),
  },
  returns: v.object({
    seasonId: v.number(),
    automatedUsd: v.number(),
    manualUsd: v.number(),
    interviewUsd: v.number(),
    totalUsd: v.number(),
    articles: v.number(),
    interviews: v.number(),
    truncated: v.boolean(),
    capUsd: v.number(),
    remainingUsd: v.number(),
    overCap: v.boolean(),
    weeklyRunRateUsd: v.number(),
    projectedSeasonUsd: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireCommissioner(ctx, args.leagueId);
    const league = await ctx.db.get(args.leagueId);
    const seasonId = args.seasonId ?? passSeasonId(league);
    const spend = await seasonSpend(ctx, args.leagueId, seasonId);
    return { ...projectSpend(spend, args.now ?? Date.now()), seasonId };
  },
});

/**
 * Turn a season-to-date total into a run rate and a projection.
 *
 * The rate is measured from the first article that cost anything, not from an
 * arbitrary season start, so a league that imported in week 9 is not projected
 * as if it had been quiet for eight weeks. A season with less than a week of
 * history projects flat rather than extrapolating a single day.
 */
function projectSpend(
  spend: Awaited<ReturnType<typeof seasonSpend>>,
  now: number
): {
  seasonId: number;
  automatedUsd: number;
  manualUsd: number;
  interviewUsd: number;
  totalUsd: number;
  articles: number;
  interviews: number;
  truncated: boolean;
  capUsd: number;
  remainingUsd: number;
  overCap: boolean;
  weeklyRunRateUsd: number;
  projectedSeasonUsd: number;
} {
  const { firstArticleAt, ...rest } = spend;
  const capUsd = automationSpendCapUsd();
  const observedWeeks =
    firstArticleAt === null ? 0 : Math.max(1, Math.ceil((now - firstArticleAt) / WEEK_MS));
  const weeklyRunRateUsd = observedWeeks === 0 ? 0 : rest.totalUsd / observedWeeks;
  const projectedSeasonUsd = Math.max(rest.totalUsd, weeklyRunRateUsd * SEASON_WEEKS);

  return {
    ...rest,
    capUsd,
    remainingUsd: round4(Math.max(0, capUsd - rest.automatedUsd - rest.interviewUsd)),
    overCap: rest.automatedUsd + rest.interviewUsd >= capUsd,
    weeklyRunRateUsd: round4(weeklyRunRateUsd),
    projectedSeasonUsd: round4(projectedSeasonUsd),
  };
}

const metricSummaryValidator = v.object({
  articles: v.number(),
  /** (blocks + strips) per 1,000 words. `null` when no article carried a word count. */
  ungroundedPer1k: v.union(v.number(), v.null()),
  /** quotesUsed / quotesOffered. `null` when no quotes were ever offered. */
  quoteFidelity: v.union(v.number(), v.null()),
  /** words per available fact. `null` when no article recorded a facts count. */
  paddingIndex: v.union(v.number(), v.null()),
});

/** The money half of the desk scorecard (spec §10.3.4). */
const deskSpendValidator = v.object({
  seasonId: v.number(),
  automatedUsd: v.number(),
  manualUsd: v.number(),
  interviewUsd: v.number(),
  totalUsd: v.number(),
  articles: v.number(),
  interviews: v.number(),
  truncated: v.boolean(),
  capUsd: v.number(),
  remainingUsd: v.number(),
  overCap: v.boolean(),
  weeklyRunRateUsd: v.number(),
  projectedSeasonUsd: v.number(),
});

const deskMetricsValidator = v.object({
  /** The window actually applied, in days. `null` means "everything in range". */
  sinceDays: v.union(v.number(), v.null()),
  /** True when the article scan hit `MAX_ARTICLES` and older articles were not counted. */
  truncated: v.boolean(),
  /** League-wide totals, aggregated across writers rather than averaged per writer. */
  league: metricSummaryValidator,
  perWriter: v.array(
    v.object({
      persona: v.string(),
      articles: v.number(),
      ungroundedPer1k: v.union(v.number(), v.null()),
      quoteFidelity: v.union(v.number(), v.null()),
      paddingIndex: v.union(v.number(), v.null()),
    })
  ),
  recentFlags: v.array(
    v.object({
      articleId: v.id("aiContent"),
      title: v.string(),
      persona: v.string(),
      severity: v.string(),
      kind: v.string(),
      detail: v.string(),
      section: v.optional(v.string()),
      createdAt: v.number(),
    })
  ),
  /**
   * Season-to-date API spend, split by who paid, with the automation cap and
   * the projection at the current weekly run rate. Always the whole season,
   * not the `sinceDays` window: a cap is only meaningful against the season.
   */
  spend: deskSpendValidator,
});

/** Running totals for one writer (or the whole league). */
interface Totals {
  articles: number;
  ungrounded: number;
  words: number;
  /** Articles that actually reported a word count, so an empty set stays `null`. */
  wordArticles: number;
  quotesOffered: number;
  quotesUsed: number;
  facts: number;
  factArticles: number;
}

function emptyTotals(): Totals {
  return {
    articles: 0,
    ungrounded: 0,
    words: 0,
    wordArticles: 0,
    quotesOffered: 0,
    quotesUsed: 0,
    facts: 0,
    factArticles: 0,
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function summarize(totals: Totals) {
  return {
    articles: totals.articles,
    ungroundedPer1k:
      totals.wordArticles === 0 ? null : round((totals.ungrounded / Math.max(totals.words, 1)) * 1000, 2),
    quoteFidelity: totals.quotesOffered === 0 ? null : round(totals.quotesUsed / totals.quotesOffered, 3),
    paddingIndex: totals.factArticles === 0 ? null : round(totals.words / Math.max(totals.facts, 1), 2),
  };
}

/**
 * Words in a generated article. Prefers the generator's own count (which is taken before the
 * commissioner edits the draft) and falls back to counting the stored body.
 */
function wordsIn(article: Doc<"aiContent">): number {
  const reported = article.generationStats?.wordCount;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported;
  return (article.content ?? "").split(/\s+/).filter(Boolean).length;
}

/**
 * Findings that mean the writer said something FACTS does not support: everything the verifier
 * blocked or stripped. Warnings are surfaced in `recentFlags` but do not count against the score.
 */
function ungroundedIn(article: Doc<"aiContent">): number {
  const stats = article.generationStats;
  if (stats && (typeof stats.blocks === "number" || typeof stats.strips === "number")) {
    return (stats.blocks ?? 0) + (stats.strips ?? 0);
  }
  return (article.reviewFlags ?? []).filter(flag => flag.severity === "block" || flag.severity === "strip").length;
}

function accumulate(totals: Totals, article: Doc<"aiContent">): void {
  const stats = article.generationStats;
  totals.articles += 1;
  totals.ungrounded += ungroundedIn(article);

  const words = wordsIn(article);
  if (words > 0) {
    totals.words += words;
    totals.wordArticles += 1;
  }

  const offered = stats?.quotesOffered;
  if (typeof offered === "number" && offered > 0) {
    totals.quotesOffered += offered;
    totals.quotesUsed += Math.min(stats?.quotesUsed ?? 0, offered);
  }

  const facts = stats?.factsCount;
  if (typeof facts === "number" && facts > 0) {
    totals.facts += facts;
    totals.factArticles += 1;
  }
}

/**
 * Verifier scorecard for one league's writers. Commissioner only: it exposes the desk's own
 * failure rate, which is not something every member of the league should be reading.
 *
 * `now` exists so the caller can supply a stable clock (queries should not read the wall clock,
 * because they are not re-run merely because time passed). It defaults to the server clock so a
 * one-off call still works.
 */
export const getDeskMetrics = query({
  args: {
    leagueId: v.id("leagues"),
    sinceDays: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: deskMetricsValidator,
  handler: async (ctx, args) => {
    await requireCommissioner(ctx, args.leagueId);

    const articles = await ctx.db
      .query("aiContent")
      .withIndex("by_league", q => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(MAX_ARTICLES);

    const sinceDays = args.sinceDays && args.sinceDays > 0 ? args.sinceDays : null;
    const cutoff = sinceDays === null ? null : (args.now ?? Date.now()) - sinceDays * 24 * 60 * 60 * 1000;

    const inWindow = articles.filter(article => {
      if (cutoff === null) return true;
      const createdAt = article.createdAt ?? article._creationTime;
      return createdAt >= cutoff;
    });

    const league = emptyTotals();
    const byPersona = new Map<string, Totals>();

    for (const article of inWindow) {
      accumulate(league, article);
      const persona = article.persona || "unknown";
      let totals = byPersona.get(persona);
      if (!totals) {
        totals = emptyTotals();
        byPersona.set(persona, totals);
      }
      accumulate(totals, article);
    }

    const perWriter = [...byPersona.entries()]
      .map(([persona, totals]) => ({ persona, ...summarize(totals) }))
      .sort((a, b) => b.articles - a.articles || a.persona.localeCompare(b.persona));

    const recentFlags = inWindow
      .flatMap(article =>
        (article.reviewFlags ?? []).map(flag => ({
          articleId: article._id,
          title: article.title,
          persona: article.persona || "unknown",
          severity: flag.severity,
          kind: flag.kind,
          detail: flag.detail,
          section: flag.section,
          createdAt: article.createdAt ?? article._creationTime,
        }))
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_FLAGS);

    // Spend is deliberately season-wide rather than windowed: `sinceDays`
    // scopes the quality metrics, but the cap is a season number.
    const leagueDoc = await ctx.db.get(args.leagueId);
    const seasonId = passSeasonId(leagueDoc);
    const spend = projectSpend(
      await seasonSpend(ctx, args.leagueId, seasonId),
      args.now ?? Date.now()
    );

    return {
      sinceDays,
      truncated: articles.length === MAX_ARTICLES,
      league: summarize(league),
      perWriter,
      recentFlags,
      spend: { ...spend, seasonId },
    };
  },
});
