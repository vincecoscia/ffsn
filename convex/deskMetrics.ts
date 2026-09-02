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
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireCommissioner } from "./lib/auth";

/** How many recent articles one call may scan. Keeps the query bounded as the table grows. */
const MAX_ARTICLES = 500;

/** How many verifier findings the flag feed returns. */
const MAX_FLAGS = 20;

const metricSummaryValidator = v.object({
  articles: v.number(),
  /** (blocks + strips) per 1,000 words. `null` when no article carried a word count. */
  ungroundedPer1k: v.union(v.number(), v.null()),
  /** quotesUsed / quotesOffered. `null` when no quotes were ever offered. */
  quoteFidelity: v.union(v.number(), v.null()),
  /** words per available fact. `null` when no article recorded a facts count. */
  paddingIndex: v.union(v.number(), v.null()),
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

    return {
      sinceDays,
      truncated: articles.length === MAX_ARTICLES,
      league: summarize(league),
      perWriter,
      recentFlags,
    };
  },
});
