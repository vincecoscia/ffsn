/**
 * Pure gate logic for The Wire's writer-reply pipeline (spec ffsn-the-wire-spec.md §17.3,
 * `convex/wireSocial.ts#onManagerPost`). `onManagerPost` is a `"use node"` action (it calls
 * `generateWriterReply`, which imports `@anthropic-ai/sdk`) and so can't run under `convex-test`'s
 * edge-runtime environment - everything worth unit-testing about *when* it answers and *who*
 * answers is factored out here instead, where it can be.
 *
 * Nothing in this file touches `ctx.db` or the network: every input is plain data the caller
 * already resolved (counts, timestamps, target rows), so a test can construct it by hand.
 */

import { fnv1a } from "../../src/lib/ai/persona-prompts";
import {
  SAM_CHASE_ONE_IN,
  WRITER_REPLIES_PER_LEAGUE_PER_DAY,
  WRITER_REPLIES_PER_MANAGER_PER_HOUR,
  WRITER_REPLIES_PER_THREAD_PER_MANAGER,
} from "../../src/lib/ai/wire/types";

export const SAM_CHASE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** A manager post/reply's own shape, as far as mode decision needs it. */
export interface ManagerPostForMode {
  kind: "manager_post" | "manager_reply";
  replyTo?: { scope: "global" | "league"; id: string } | null;
}

/**
 * "reply": the manager answered a writer's post directly - a writer always tries to answer,
 * subject to the rate gates below. "chase": a standalone post - only Sam samples it (spec §17.3).
 * `null` for anything that isn't a manager post/reply at all (should never reach this pipeline).
 */
export function decideReplyMode(post: ManagerPostForMode): "reply" | "chase" | null {
  if (post.kind === "manager_reply") {
    return post.replyTo ? "reply" : null;
  }
  if (post.kind === "manager_post") {
    return "chase";
  }
  return null;
}

/** A reply target's shape, as far as "is this a writer's post" needs it (spec §17.3 mode "reply"):
 *  a global post is always a writer post; a league post is one only when it carries a persona and
 *  no author - which includes a `writer_reply`, so a conversation can continue. */
export interface ReplyTargetForPersona {
  persona?: string;
  authorUserId?: string;
}

/** The writer being answered, or `null` when the target is a manager's own post (nobody answers a
 *  manager replying to another manager - spec §17.3 only ever names a writer as the one replying). */
export function writerPersonaForTarget(target: ReplyTargetForPersona | null | undefined): string | null {
  if (!target) return null;
  if (target.authorUserId) return null;
  return target.persona ?? null;
}

/** Whether Sam's fnv1a-seeded sample lands on this post (spec §17.3: "1 in `SAM_CHASE_ONE_IN`"). */
export function samSamplesPost(leaguePostId: string): boolean {
  return fnv1a(leaguePostId) % SAM_CHASE_ONE_IN === 0;
}

/** Spec §17.3: "Sam has not chased this author in the last 24h." `undefined` = never chased. */
export function samChasedRecently(lastSamChaseAt: number | undefined, now: number): boolean {
  return lastSamChaseAt !== undefined && now - lastSamChaseAt < SAM_CHASE_COOLDOWN_MS;
}

/** Whether Sam should ask a follow-up on this standalone post right now. */
export function shouldSamChase(input: { leaguePostId: string; lastSamChaseAt: number | undefined; now: number }): boolean {
  if (samChasedRecently(input.lastSamChaseAt, input.now)) return false;
  return samSamplesPost(input.leaguePostId);
}

/** The counts a "reply" mode answer is gated on (spec §17.3), already resolved by the caller. */
export interface ReplyGateCounts {
  /** writer_reply rows answering this author, across all their posts, in the last hour. */
  repliesToManagerLastHour: number;
  /** writer_reply rows posted in this league in the last 24h. */
  repliesInLeagueToday: number;
  /** writer_reply rows in this thread that already answered this author. */
  repliesInThreadToManager: number;
  /** This league-season's automated spend so far (articles + interviews + writer replies). */
  seasonSpendUsd: number;
  /** `deskMetrics.automationSpendCapUsd()`. */
  spendCapUsd: number;
}

/** Why a writer reply was skipped, or `null` when every gate passes. Order matters only for the
 *  log line a caller might print - every reason is checked regardless of the others. */
export type ReplyGateReason =
  | "manager_hourly_limit"
  | "league_daily_limit"
  | "thread_limit"
  | "season_spend_cap";

export function replyGateReason(counts: ReplyGateCounts): ReplyGateReason | null {
  if (counts.repliesToManagerLastHour >= WRITER_REPLIES_PER_MANAGER_PER_HOUR) return "manager_hourly_limit";
  if (counts.repliesInLeagueToday >= WRITER_REPLIES_PER_LEAGUE_PER_DAY) return "league_daily_limit";
  if (counts.repliesInThreadToManager >= WRITER_REPLIES_PER_THREAD_PER_MANAGER) return "thread_limit";
  if (counts.seasonSpendUsd >= counts.spendCapUsd) return "season_spend_cap";
  return null;
}

/** The relationship-ledger event a writer's read of a manager's text produces (spec §17.3) - only
 *  in "reply" mode; "chase" mode still tags the post's own `sentiment` but never moves a meter. */
export function relationshipEventForSentiment(
  sentiment: "jab" | "thanks" | "neutral"
): "wire_jab" | "wire_praise" | null {
  if (sentiment === "jab") return "wire_jab";
  if (sentiment === "thanks") return "wire_praise";
  return null;
}

/** Oldest-first thread turns, capped at `MAX_THREAD_CONTEXT` (keep the most recent ones - a model
 *  answering the current turn cares about what was just said, not how the thread opened). */
export function capThreadContext<T>(turns: readonly T[], maxTurns: number): T[] {
  if (turns.length <= maxTurns) return [...turns];
  return turns.slice(turns.length - maxTurns);
}
