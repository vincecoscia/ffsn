/**
 * Dex Desk — data access for the `sam_question` pipeline (ffsn-the-wire-spec.md §18,
 * `convex/wireSocial.ts#askSamAboutMove`). Default-runtime queries/mutations, reached through
 * `ctx.runQuery`/`ctx.runMutation` from that `"use node"` action (actions have no `ctx.db`).
 *
 * Deliberately imports nothing from `./_generated/api`: `wireSocial.ts` defines its own internal
 * actions against `internal.*`, and a convex/*.ts module that references `internal`/`api` makes the
 * generated `api` type recursive for anything that imports it as a plain value (the repo's
 * documented cross-module value-import gotcha - see `convex/lib/wireLeaguePosting.ts`'s header).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { insertLeaguePostIfNew } from "./lib/wireLeaguePosting";
import { userForTeam } from "./lib/teamClaims";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bounded scan of a league's last day of posts - generously above the league's own 80/day cap
 *  (`LEAGUE_POSTS_PER_DAY`), same pattern as `wireLeaguePosting.ts`'s `RATE_LIMIT_SCAN_CAP`. */
const SAM_QUESTION_SCAN_CAP = 300;

/**
 * The manager who claimed this team, for `askSamAboutMove` (spec §18: "the manager must have a
 * claimed team, else skip") - actions have no `ctx.db` of their own, so `userForTeam`
 * (`lib/teamClaims.ts`) is wrapped here instead of called directly from `wireSocial.ts`.
 */
export const getManagerForTeam = internalQuery({
  args: { teamId: v.id("teams"), seasonId: v.number() },
  returns: v.union(v.object({ userId: v.id("users") }), v.null()),
  handler: async (ctx, { teamId, seasonId }) => {
    const user = await userForTeam(ctx, teamId, seasonId);
    return user ? { userId: user._id } : null;
  },
});

/**
 * How many `sam_question` posts already went out today: to this team's manager specifically, and
 * league-wide - the counts `wireDeskRules`-style gate functions in `wireSocial.ts#askSamAboutMove`
 * are checked against (spec §18: 1/manager/day, 10/league/day).
 */
export const getSamQuestionCountsToday = internalQuery({
  args: { leagueId: v.id("leagues"), teamId: v.id("teams"), now: v.number() },
  returns: v.object({ perManagerToday: v.number(), perLeagueToday: v.number() }),
  handler: async (ctx, { leagueId, teamId, now }) => {
    const recent = await ctx.db
      .query("wireLeaguePosts")
      .withIndex("by_league_created", (q) => q.eq("leagueId", leagueId).gt("createdAt", now - DAY_MS))
      .take(SAM_QUESTION_SCAN_CAP);
    const samQuestions = recent.filter((row) => row.kind === "sam_question");
    const perManagerToday = samQuestions.filter((row) => row.featuredTeams.includes(teamId)).length;
    return { perManagerToday, perLeagueToday: samQuestions.length };
  },
});

/**
 * Insert Sam's chase question on a Dex Desk post (spec §18 `sam_question`) - idempotent on
 * `sam_question:<deskPostId>:<teamId>` (a trade proposal asks both sides, each its own row).
 */
export const insertSamQuestion = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    week: v.optional(v.number()),
    deskPostId: v.id("wireLeaguePosts"),
    teamId: v.id("teams"),
    text: v.string(),
    generationStats: v.object({ costUsd: v.number(), model: v.string(), effort: v.string() }),
  },
  returns: v.object({ inserted: v.boolean() }),
  handler: async (ctx, args) => {
    const { inserted } = await insertLeaguePostIfNew(ctx, Date.now(), {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
      week: args.week,
      kind: "sam_question",
      persona: "sam-ortega",
      text: args.text,
      tags: [],
      featuredTeams: [args.teamId],
      dedupeKey: `sam_question:${args.deskPostId}:${args.teamId}`,
      generationStats: args.generationStats,
      replyTo: { scope: "league", id: args.deskPostId },
      rootScope: "league",
      rootId: args.deskPostId,
    });
    return { inserted };
  },
});
