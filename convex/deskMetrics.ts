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

import { formatFeedFreshness, staleFeeds, type FeedRun } from "./lib/feedFreshness";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCommissioner } from "./lib/auth";
import { passSeasonId } from "./credits";
// Plain rendering module - no runtime deps. `emailService.ts` imports it from
// the same isolate.
import { renderSystemNoticeEmail } from "../src/lib/email/templates";

/** How many recent articles one call may scan. Keeps the query bounded as the table grows. */
const MAX_ARTICLES = 500;

/** How many verifier findings the flag feed returns. */
const MAX_FLAGS = 20;

/* -------------------------------------------------------------------------- *
 * Spend (spec §10.1 cap, §10.3.4 accounting)
 * -------------------------------------------------------------------------- */

/** How many articles / comment requests one season spend roll-up may scan. */
const MAX_SPEND_ROWS = 1000;

/** How many `wireLeaguePosts` rows one season spend roll-up may scan (spec ffsn-the-wire-spec.md
 *  §17.4) - generously above what a league's own per-day post rate limit could produce in a season. */
const MAX_WIRE_SPEND_ROWS = 2000;

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

  // The Wire (ffsn-the-wire-spec.md §17.4): a writer_reply's generation cost counts toward the
  // same automation cap an article's would - it's one Sonnet call same as any other, just billed
  // to the league instead of a manager. Overlay/routine posts never carry `generationStats` (no
  // model call), so this naturally only ever picks up writer replies without a `kind` filter.
  const wirePosts = await ctx.db
    .query("wireLeaguePosts")
    .withIndex("by_league_season", (q) => q.eq("leagueId", leagueId).eq("seasonId", seasonId))
    .take(MAX_WIRE_SPEND_ROWS);
  for (const post of wirePosts) {
    const cost = post.generationStats?.costUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) continue;
    automatedUsd += cost;
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
    truncated:
      articles.length === MAX_SPEND_ROWS ||
      requests.length === MAX_SPEND_ROWS ||
      wirePosts.length === MAX_WIRE_SPEND_ROWS,
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

/* ========================================================================== *
 * Operations (spec §11.3.10)
 *
 * Two things the operator gets, and only the operator: one email a day
 * summarising every league, and one email the moment an article is held or
 * fails. Neither reaches a commissioner - they have their own notifications -
 * and neither is allowed to fail the pipeline that triggered it.
 * ========================================================================== */

/** How many rows of each kind one league's digest reads. */
const MAX_DIGEST_ROWS = 400;

/** Flag kinds listed in the digest (spec §11.3.10: "top 5 flag kinds"). */
const TOP_FLAG_KINDS = 5;

/** Regular-season weeks used to turn a 24h spend into a season run-rate. */
const DIGEST_RUN_RATE_WEEKS = SEASON_WEEKS;

/** What `releaseDueBatchRows` writes when a batch misses print time. */
const BATCH_FALLBACK_MARKER = "Batch did not complete before print time";

/** What `recordDeferral` writes when a row is pushed out for missing data. */
const DEFERRAL_MARKER = "Waiting on league data";

/* -------------------------------------------------------------------------- *
 * Pure aggregation
 * -------------------------------------------------------------------------- */

/** The rows one league's digest is computed from. Structural, so tests can seed them. */
export interface DigestInputs {
  articles: ReadonlyArray<{
    status: string;
    createdAt?: number;
    _creationTime?: number;
    reviewFlags?: ReadonlyArray<{ kind: string; severity?: string }>;
  }>;
  scheduledRows: ReadonlyArray<{
    status: string;
    updatedAt?: number;
    deferrals?: number;
    errorMessage?: string;
    batchSubmittedAt?: number;
  }>;
  commentRequests: ReadonlyArray<{ status: string; createdAt?: number }>;
  /** Rows older than this are ignored. */
  since: number;
}

export interface LeagueDigest {
  published: number;
  held: number;
  failed: number;
  deferred: number;
  batchFallbacks: number;
  topFlagKinds: Array<{ kind: string; count: number }>;
  interviewsRequested: number;
  interviewsDeclined: number;
  /** declined / requested. `null` when nobody was asked - not the same as 0%. */
  declineRate: number | null;
  /** True when anything at all happened; a quiet league is left out of the email. */
  active: boolean;
}

/**
 * Roll one league's last 24 hours into the digest line.
 *
 * Deliberately pure and deliberately exported: this is the part worth testing,
 * and the part that must not change meaning when the queries around it do.
 *
 * Counting rules:
 *  - `published` / `held` / `failed` are article outcomes. "Held" is an
 *    article that finished generating and stayed in `draft` - the publish gate
 *    (spec §11.2.9) or a commissioner's own `requireApproval`.
 *  - `deferred` counts scheduled rows waiting on league data (spec §11.1), NOT
 *    article rows: a deferral happens before an article exists.
 *  - `failed` on a scheduled row that also produced a failed article would
 *    double count, so only articles are counted as failures; a scheduled row
 *    that failed without ever creating one is added on top.
 */
export function aggregateLeagueDigest(inputs: DigestInputs): LeagueDigest {
  const at = (row: { createdAt?: number; _creationTime?: number; updatedAt?: number }) =>
    row.createdAt ?? row.updatedAt ?? row._creationTime ?? 0;

  const articles = inputs.articles.filter((row) => at(row) >= inputs.since);
  const scheduledRows = inputs.scheduledRows.filter((row) => at(row) >= inputs.since);
  const commentRequests = inputs.commentRequests.filter((row) => at(row) >= inputs.since);

  let published = 0;
  let held = 0;
  let failed = 0;
  const flagCounts = new Map<string, number>();

  for (const article of articles) {
    if (article.status === "published") published += 1;
    else if (article.status === "draft") held += 1;
    else if (article.status === "failed") failed += 1;

    for (const flag of article.reviewFlags ?? []) {
      flagCounts.set(flag.kind, (flagCounts.get(flag.kind) ?? 0) + 1);
    }
  }

  let deferred = 0;
  let batchFallbacks = 0;
  for (const row of scheduledRows) {
    const waiting =
      (row.deferrals ?? 0) > 0 || (row.errorMessage ?? "").startsWith(DEFERRAL_MARKER);
    if (waiting && row.status === "pending") deferred += 1;
    if (row.status === "failed" && waiting) failed += 1;
    if ((row.errorMessage ?? "").includes(BATCH_FALLBACK_MARKER)) batchFallbacks += 1;
  }

  const interviewsRequested = commentRequests.length;
  const interviewsDeclined = commentRequests.filter((row) => row.status === "declined").length;

  const topFlagKinds = [...flagCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, TOP_FLAG_KINDS);

  return {
    published,
    held,
    failed,
    deferred,
    batchFallbacks,
    topFlagKinds,
    interviewsRequested,
    interviewsDeclined,
    declineRate:
      interviewsRequested === 0
        ? null
        : round(interviewsDeclined / interviewsRequested, 3),
    active:
      published + held + failed + deferred + batchFallbacks + interviewsRequested > 0,
  };
}

/** One league's digest line, rendered for a plain-text email. */
export function formatLeagueDigestLine(
  leagueName: string,
  digest: LeagueDigest,
  spend: {
    automatedUsd: number;
    interviewUsd: number;
    capUsd: number;
    weeklyRunRateUsd: number;
    projectedSeasonUsd: number;
  }
): string {
  const covered = spend.automatedUsd + spend.interviewUsd;
  const pctOfCap = spend.capUsd > 0 ? Math.round((covered / spend.capUsd) * 100) : 0;
  const flags =
    digest.topFlagKinds.length === 0
      ? "none"
      : digest.topFlagKinds.map((entry) => `${entry.kind} x${entry.count}`).join(", ");
  const decline =
    digest.declineRate === null
      ? "nobody asked"
      : `${Math.round(digest.declineRate * 100)}% (${digest.interviewsDeclined}/${digest.interviewsRequested})`;

  return [
    `${leagueName}`,
    `  published ${digest.published} · held ${digest.held} · failed ${digest.failed} · deferred ${digest.deferred}`,
    `  spend $${covered.toFixed(2)} of $${spend.capUsd.toFixed(2)} cap (${pctOfCap}%), ` +
      `$${spend.weeklyRunRateUsd.toFixed(2)}/week, season projects to $${spend.projectedSeasonUsd.toFixed(2)}`,
    `  flags: ${flags}`,
    `  batch fallbacks ${digest.batchFallbacks} · interview declines ${decline}`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- *
 * Digest data
 * -------------------------------------------------------------------------- */

const leagueDigestValidator = v.object({
  published: v.number(),
  held: v.number(),
  failed: v.number(),
  deferred: v.number(),
  batchFallbacks: v.number(),
  topFlagKinds: v.array(v.object({ kind: v.string(), count: v.number() })),
  interviewsRequested: v.number(),
  interviewsDeclined: v.number(),
  declineRate: v.union(v.number(), v.null()),
  active: v.boolean(),
});

/**
 * One league's last 24 hours plus its season spend.
 *
 * Every scan is bounded and every window filter happens in
 * `aggregateLeagueDigest`, so a league with a busy day costs the same reads as
 * a quiet one and the arithmetic stays testable without a database.
 */
export const getLeagueDigest = internalQuery({
  args: {
    leagueId: v.id("leagues"),
    since: v.number(),
    now: v.optional(v.number()),
  },
  returns: v.object({
    leagueName: v.string(),
    seasonId: v.number(),
    digest: leagueDigestValidator,
    spend: deskSpendValidator,
  }),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    const seasonId = passSeasonId(league);

    const articles = await ctx.db
      .query("aiContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(MAX_DIGEST_ROWS);

    const scheduledRows = await ctx.db
      .query("scheduledContent")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(MAX_DIGEST_ROWS);

    const commentRequests = await ctx.db
      .query("commentRequests")
      .withIndex("by_league", (q) => q.eq("leagueId", args.leagueId))
      .order("desc")
      .take(MAX_DIGEST_ROWS);

    const digest = aggregateLeagueDigest({
      articles,
      scheduledRows,
      commentRequests,
      since: args.since,
    });

    const spend = projectSpend(
      await seasonSpend(ctx, args.leagueId, seasonId),
      args.now ?? Date.now()
    );

    return {
      leagueName: league?.name ?? "Unknown league",
      seasonId,
      digest,
      spend: { ...spend, seasonId },
    };
  },
});

/* -------------------------------------------------------------------------- *
 * Operator notices
 * -------------------------------------------------------------------------- */

/**
 * Claim one operator notice, or discover that it has already been sent.
 *
 * The row IS the lock: `operatorNotices.key` is unique by construction, so a
 * finalize that runs twice, or a failure that is retried, still costs the
 * operator exactly one email. Returns false when the key is already taken.
 */
export const claimOperatorNotice = internalMutation({
  args: {
    key: v.string(),
    kind: v.string(),
    subject: v.string(),
    leagueId: v.optional(v.id("leagues")),
    articleId: v.optional(v.id("aiContent")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("operatorNotices")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (existing) return false;

    await ctx.db.insert("operatorNotices", {
      key: args.key,
      kind: args.kind,
      leagueId: args.leagueId,
      articleId: args.articleId,
      subject: args.subject,
      sentAt: Date.now(),
      delivered: false,
    });
    return true;
  },
});

/** Stamp whether the claimed notice actually got out of the building. */
export const markOperatorNoticeDelivered = internalMutation({
  args: { key: v.string(), delivered: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("operatorNotices")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (row) await ctx.db.patch(row._id, { delivered: args.delivered });
    return null;
  },
});

/**
 * Send one operator email, or log it loudly when there is nowhere to send it.
 *
 * `ADMIN_ALERT_EMAIL` is a Convex env var and is normally unset in
 * development, which is exactly when a `console.error` is the right delivery
 * mechanism. A send that fails never throws: every caller is on a path that
 * has already done the important work.
 */
async function deliverToOperator(
  ctx: ActionCtx,
  subject: string,
  text: string,
  html?: string
): Promise<boolean> {
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) {
    console.error(`[operator] ${subject}\n${text}`);
    return false;
  }
  try {
    const result = await ctx.runAction(internal.emailService.sendPlainEmail, {
      to,
      subject,
      text,
      html,
      fromName: "FFSN Desk",
      relatedEntityType: "operator_alert",
    });
    if (!result.success) {
      console.error(`[operator] send failed (${result.error}): ${subject}\n${text}`);
    }
    return result.success;
  } catch (error) {
    console.error(`[operator] send threw for "${subject}"`, error);
    return false;
  }
}

/**
 * The immediate notice (spec §11.3.10): "any held or failed article also
 * triggers an immediate single notice (deduped per article)".
 *
 * Called from `aiContent.finalizeGeneratedArticle` (held) and
 * `lib/generationFailure.handleGenerationFailure` (failed). Both call it
 * fire-and-forget; nothing here may throw back into them.
 */
export const notifyOperatorOfArticle = internalAction({
  args: {
    leagueId: v.id("leagues"),
    articleId: v.id("aiContent"),
    kind: v.union(v.literal("held"), v.literal("failed")),
    contentType: v.string(),
    persona: v.optional(v.string()),
    reasons: v.array(v.string()),
    // Season backfill (owner directive, Sept 2026): claim/record the notice - so it still surfaces
    // in the daily digest - but skip the immediate email. A 30-article catch-up run would otherwise
    // put one email per held/failed article straight into the operator's inbox.
    digestOnly: v.optional(v.boolean()),
  },
  returns: v.object({ sent: v.boolean(), deduped: v.boolean() }),
  handler: async (ctx, args): Promise<{ sent: boolean; deduped: boolean }> => {
    const key = `${args.kind}:${args.articleId}`;
    const typeLabel = args.contentType.replace(/_/g, " ");
    const subject =
      args.kind === "held"
        ? `FFSN held a ${typeLabel} for review`
        : `FFSN failed to file a ${typeLabel}`;

    const claimed: boolean = await ctx.runMutation(internal.deskMetrics.claimOperatorNotice, {
      key,
      kind: args.kind,
      subject,
      leagueId: args.leagueId,
      articleId: args.articleId,
    });
    if (!claimed) return { sent: false, deduped: true };

    // The notice is claimed (so it counts toward the digest) but never mailed - left `delivered:
    // false`, exactly as claimOperatorNotice's insert already defaults it.
    if (args.digestOnly) return { sent: false, deduped: false };

    const text = [
      subject,
      "",
      `League: ${args.leagueId}`,
      `Article: ${args.articleId}`,
      `Writer: ${args.persona ?? "unknown"}`,
      "",
      args.kind === "held" ? "Why it was held:" : "Why it failed:",
      ...args.reasons.map((reason) => `  - ${reason}`),
    ].join("\n");

    const sent = await deliverToOperator(ctx, subject, text);
    await ctx.runMutation(internal.deskMetrics.markOperatorNoticeDelivered, {
      key,
      delivered: sent,
    });
    return { sent, deduped: false };
  },
});

/**
 * The daily operator digest (spec §11.3.10). Wired to 13:00 UTC in `crons.ts`.
 *
 * One email for the whole deployment rather than one per league: an operator
 * reading twenty leagues wants one page, and a league with a quiet day is left
 * out entirely so the ones that need attention are the ones on the page.
 */
export const sendOperatorDigest = internalAction({
  args: {
    /** Window length in hours. Defaults to the 24h the spec asks for. */
    hours: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    leagues: v.number(),
    activeLeagues: v.number(),
    sent: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{ leagues: number; activeLeagues: number; sent: boolean }> => {
    const now = args.now ?? Date.now();
    const since = now - (args.hours ?? 24) * 60 * 60 * 1000;

    const leagues = await ctx.runQuery(internal.leagues.listLeagues, {});

    // The feeds behind PLAYER INTEL and the mock draft's ADP (2026-09-05): a feed that stopped is
    // in the subject line, not buried.
    const feedRuns: FeedRun[] = await ctx.runQuery(internal.intelSync.latestSyncRuns, {});
    const latestNews = await ctx.runQuery(internal.espnNews.latestPublishedAt, {});
    if (latestNews !== null) feedRuns.push({ source: "espn_news", ranAt: latestNews, ok: true });

    // The Wire (ffsn-the-wire-spec.md §11): the injuries poller's own health row, same treatment
    // as every other feed above.
    const wireInjuryHealth = await ctx.runQuery(internal.wireDetect.getSourceHealth, { source: "espn_injuries" });
    if (wireInjuryHealth) {
      feedRuns.push({
        source: "espn_injuries",
        ranAt: wireInjuryHealth.lastRunAt,
        ok: wireInjuryHealth.ok,
        summary: wireInjuryHealth.summary,
        error: wireInjuryHealth.error,
      });
    }
    // Dex Desk (spec §18 "Not built": "a digest line for the desk"): the transaction-log poll and
    // the NFL schedule/kickoffs poll, both `wireSourceState` rows already, same treatment.
    const wireTransactionsHealth = await ctx.runQuery(internal.wireDetect.getSourceHealth, { source: "espn_transactions" });
    if (wireTransactionsHealth) {
      feedRuns.push({
        source: "espn_transactions",
        ranAt: wireTransactionsHealth.lastRunAt,
        ok: wireTransactionsHealth.ok,
        summary: wireTransactionsHealth.summary,
        error: wireTransactionsHealth.error,
      });
    }
    const nflKickoffsHealth = await ctx.runQuery(internal.wireDetect.getSourceHealth, { source: "nfl_kickoffs" });
    if (nflKickoffsHealth) {
      feedRuns.push({
        source: "nfl_kickoffs",
        ranAt: nflKickoffsHealth.lastRunAt,
        ok: nflKickoffsHealth.ok,
        summary: nflKickoffsHealth.summary,
        error: nflKickoffsHealth.error,
      });
    }
    const stale = staleFeeds(feedRuns, now);

    const lines: string[] = [];
    const totals = { published: 0, held: 0, failed: 0, deferred: 0, coveredUsd: 0 };
    let activeLeagues = 0;

    for (const league of leagues) {
      const row = await ctx.runQuery(internal.deskMetrics.getLeagueDigest, {
        leagueId: league._id,
        since,
        now,
      });
      const covered = row.spend.automatedUsd + row.spend.interviewUsd;
      const overCap = row.spend.overCap;

      totals.published += row.digest.published;
      totals.held += row.digest.held;
      totals.failed += row.digest.failed;
      totals.deferred += row.digest.deferred;
      totals.coveredUsd += covered;

      // A league that did nothing and spent nothing is not news - unless it is
      // over its cap, which is news every day until somebody acts on it.
      if (!row.digest.active && !overCap) continue;

      activeLeagues += 1;
      lines.push(
        formatLeagueDigestLine(`${row.leagueName}${overCap ? "  [OVER CAP]" : ""}`, row.digest, row.spend)
      );
    }

    const window = `${new Date(since).toISOString()} → ${new Date(now).toISOString()}`;
    const subject =
      `FFSN desk digest: ${totals.published} published, ${totals.held} held, ` +
      `${totals.failed} failed, ${totals.deferred} deferred` +
      (stale.length > 0 ? ` - ${stale.length} feed(s) stale` : "");

    // The Wire (ffsn-the-wire-spec.md §11): events / posts / takes / card fallbacks / global cost,
    // same 24h window as the rest of the digest.
    const wireStats = await ctx.runQuery(internal.wireDetect.getDigestStats, { since });
    const wireLine =
      `Wire: ${wireStats.events} events / ${wireStats.posts} posts / ${wireStats.takes} takes / ` +
      `${wireStats.cardFallbacks} card fallback(s) / $${wireStats.costUsd.toFixed(2)} global cost`;
    // Dex Desk (spec §18 "Not built": "a digest line for the desk").
    const deskLine =
      `Desk: ${wireStats.desk.lineupMoves} lineup move(s) / ${wireStats.desk.lateSwaps} late swap(s) / ` +
      `${wireStats.desk.proposals} proposal(s) / ${wireStats.desk.claimsIn} claims_in / ` +
      `${wireStats.desk.lockWarnings} lock warning(s) / ${wireStats.desk.samQuestions} Sam question(s)`;

    const body = [
      `Window: ${window}`,
      `Leagues: ${leagues.length} (${activeLeagues} with activity)`,
      `Automated + interview spend across all leagues this season: ${totals.coveredUsd.toFixed(2)}`,
      `Season run-rate horizon: ${DIGEST_RUN_RATE_WEEKS} weeks`,
      formatFeedFreshness(feedRuns, now),
      wireLine,
      deskLine,
      "",
      lines.length > 0 ? lines.join("\n\n") : "Nothing to report.",
    ].join("\n");

    const siteUrl = process.env.SITE_URL || "https://ffsn.ai";
    let html: string | undefined;
    try {
      html = renderSystemNoticeEmail({
        kicker: "Desk digest",
        title: subject,
        paragraphs: body.split("\n\n"),
        preferencesUrl: `${siteUrl}/dashboard/settings/notifications`,
        siteUrl,
      }).html;
    } catch (error) {
      // A rendering failure must not cost the operator the digest itself.
      console.warn("Could not render the operator digest as HTML; sending plain text", error);
    }

    const sent = await deliverToOperator(ctx, subject, body, html);
    return { leagues: leagues.length, activeLeagues, sent };
  },
});
