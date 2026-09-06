"use node";

/**
 * The Wire — social layer actions (ffsn-the-wire-spec.md §17). `"use node"` only because
 * `src/lib/ai/wire/reply.ts` imports `@anthropic-ai/sdk`; the data access both actions need lives
 * in `convex/wireSocialData.ts` (default runtime) and `convex/relationships.ts`, reached through
 * `ctx.runQuery`/`ctx.runMutation`. Gate logic (mode decision, rate limits) is factored into pure
 * helpers in `convex/lib/wireSocialRules.ts` - this file is the thin orchestration around them, so
 * what actually decides "does a writer answer" stays unit-testable even though this file is not.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireEnv } from "./lib/nodeHelpers";
import { wireEnabled } from "./lib/wireLeaguePosting";
import { automationSpendCapUsd } from "./deskMetrics";
import {
  MAX_THREAD_CONTEXT,
  WIRE_JAB_DELTA,
  WIRE_THANKS_DELTA,
} from "../src/lib/ai/wire/types";
import type { WireFactCard, WirePersona, WriterReplyInput } from "../src/lib/ai/wire/types";
import { validateFactCard } from "../src/lib/ai/wire/card";
import { generateWriterReply } from "../src/lib/ai/wire/reply";
import { describeMove, type MoveDescriptionInput } from "../src/lib/ai/wire/moves";
import {
  decideReplyMode,
  relationshipEventForSentiment,
  replyGateReason,
  shouldSamChase,
  writerPersonaForTarget,
} from "./lib/wireSocialRules";
import { samQuestionGateReason } from "./lib/wireDeskRules";

/**
 * A reaction lands on `postKey`; only a WRITER's post moves the relationship meter (spec §17.2).
 * `wire.react` schedules this after every add/switch/remove - the actual reconciliation (reset the
 * ledger row, re-apply if the current reaction still has a non-zero delta) lives in
 * `relationships.syncWireReactionEvent`, which re-reads the current `wireReactions` row rather than
 * trusting this call's own timing, so two rapid taps still converge on the right result.
 */
export const syncWireReaction = internalAction({
  args: {
    postKey: v.string(),
    leagueId: v.id("leagues"),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { postKey, leagueId, userId }) => {
    const writerPost = await ctx.runQuery(internal.wireSocialData.getWriterPostForReaction, { postKey });
    if (!writerPost) return null; // a reaction on a manager's own post moves nothing

    await ctx.runMutation(internal.relationships.syncWireReactionEvent, {
      leagueId,
      userId,
      persona: writerPost.persona,
      wirePostKey: postKey,
      postText: writerPost.text,
    });
    return null;
  },
});

/**
 * A manager posted or replied - decide whether a writer answers, and if so, generate and post the
 * reply (spec §17.3). Every gate that can skip this does so silently (logged, never thrown): a
 * manager's post always lands regardless of whether a writer ever picks it up.
 */
export const onManagerPost = internalAction({
  args: { leaguePostId: v.id("wireLeaguePosts") },
  returns: v.null(),
  handler: async (ctx, { leaguePostId }) => {
    if (!wireEnabled()) return null;

    const managerPost = await ctx.runQuery(internal.wireSocialData.getManagerPostContext, { leaguePostId });
    if (!managerPost || !managerPost.authorUsersId) return null;

    const mode = decideReplyMode({ kind: managerPost.kind as "manager_post" | "manager_reply", replyTo: managerPost.replyTo });
    if (!mode) return null;

    let persona: WirePersona;
    let writerPostText: string | undefined;
    let card: WireFactCard | undefined;

    if (mode === "reply") {
      const target = await ctx.runQuery(internal.wireSocialData.getReplyTarget, managerPost.replyTo!);
      const resolvedPersona = writerPersonaForTarget(target);
      if (!resolvedPersona) return null; // the manager replied to another manager - no writer answers that
      persona = resolvedPersona as WirePersona;
      writerPostText = target!.text;

      if (managerPost.rootScope === "global" && target!.cardEventId) {
        const facts: unknown = await ctx.runQuery(internal.wireSocialData.getEventFacts, {
          eventId: target!.cardEventId,
        });
        if (facts) {
          try {
            card = validateFactCard(facts);
          } catch {
            // A malformed stored card shouldn't block the reply - it just goes out without one.
          }
        }
      }
    } else {
      persona = "sam-ortega";
    }

    const now = Date.now();
    const gateCounts = await ctx.runQuery(internal.wireSocialData.getReplyGateCounts, {
      leagueId: managerPost.leagueId,
      authorUserId: managerPost.authorUserId,
      rootScope: managerPost.rootScope,
      rootId: managerPost.rootId,
      now,
    });

    if (mode === "chase" && !shouldSamChase({ leaguePostId, lastSamChaseAt: gateCounts.lastSamChaseAt, now })) {
      return null;
    }

    const spend = await ctx.runQuery(internal.deskMetrics.getLeagueSeasonSpend, {
      leagueId: managerPost.leagueId,
      seasonId: managerPost.seasonId,
    });
    const reason = replyGateReason({
      repliesToManagerLastHour: gateCounts.repliesToManagerLastHour,
      repliesInLeagueToday: gateCounts.repliesInLeagueToday,
      repliesInThreadToManager: gateCounts.repliesInThreadToManager,
      seasonSpendUsd: spend.totalUsd,
      spendCapUsd: automationSpendCapUsd(),
    });
    if (reason) {
      console.log(`wireSocial.onManagerPost: skipped leaguePost ${leaguePostId} (${reason})`);
      return null;
    }

    const relationships = await ctx.runQuery(internal.relationships.getRelationshipsForWriter, {
      leagueId: managerPost.leagueId,
      persona,
      userIds: [managerPost.authorUsersId],
    });
    const rel = relationships[0];

    const language = await ctx.runQuery(internal.languageSettings.getLeagueLanguage, {
      leagueId: managerPost.leagueId,
    });
    const cleanTeam = rel !== undefined && language.cleanTeamNames.includes(rel.teamName);

    const thread = await ctx.runQuery(internal.wireSocialData.getThreadContext, {
      leagueId: managerPost.leagueId,
      rootScope: managerPost.rootScope,
      rootId: managerPost.rootId,
      limit: MAX_THREAD_CONTEXT,
    });

    const input: WriterReplyInput = {
      persona,
      mode,
      writerPostText,
      card,
      managerText: managerPost.text,
      manager: {
        displayName: rel?.managerName ?? "A manager",
        teamName: rel?.teamName ?? "Unclaimed team",
        relationshipTier: rel?.tier ?? "neutral",
        recentEvidence: (rel?.recentEvents ?? []).slice(0, 3).map((event) => event.evidence),
      },
      thread,
      languageRating: language.languageRating,
      cleanTeam,
      week: managerPost.week,
    };

    const result = await generateWriterReply(input, requireEnv("ANTHROPIC_API_KEY"));

    if (result.text) {
      await ctx.runMutation(internal.wireSocialData.insertWriterReply, {
        leagueId: managerPost.leagueId,
        seasonId: managerPost.seasonId,
        week: managerPost.week,
        persona,
        text: result.text,
        authorTeamId: managerPost.authorTeamId,
        replyToId: leaguePostId,
        rootScope: managerPost.rootScope,
        rootId: managerPost.rootId,
        generationStats: { costUsd: result.costUsd, model: result.model, effort: result.effort },
      });
    }

    // The relationship move only happens in "reply" mode - "chase" mode (Sam's follow-up on a
    // standalone post) has no specific writer relationship to move, even though the post still
    // gets tagged with the sentiment below. A failed verification (no `result.text`) still records
    // the sentiment (spec §17.3).
    if (mode === "reply") {
      const eventType = relationshipEventForSentiment(result.sentiment);
      if (eventType) {
        await ctx.runMutation(internal.relationships.recordEvent, {
          leagueId: managerPost.leagueId,
          userId: managerPost.authorUsersId,
          persona,
          type: eventType,
          delta: eventType === "wire_jab" ? WIRE_JAB_DELTA : WIRE_THANKS_DELTA,
          evidence: managerPost.text.slice(0, 280),
          teamId: managerPost.authorTeamId,
          week: managerPost.week,
          wirePostKey: `league:${leaguePostId}`,
        });
      }
    }

    await ctx.runMutation(internal.wireSocialData.patchManagerPostSentiment, {
      leaguePostId,
      sentiment: result.sentiment,
    });

    return null;
  },
});

const moveDescriptionValidator = v.object({
  kind: v.union(v.literal("lineup_move"), v.literal("late_swap"), v.literal("trade_proposal")),
  team: v.string(),
  manager: v.string(),
  players: v.array(v.string()),
  slot: v.optional(v.string()),
  benched: v.optional(v.string()),
  minutes: v.optional(v.number()),
  otherTeam: v.optional(v.string()),
});

/**
 * Sam follows a notable Dex Desk move with one question (spec §18 `sam_question`): a late swap, a
 * trade proposal (both managers), or a lineup move of a widely-rostered player. Unlike
 * `onManagerPost`'s "chase" mode, there is no standalone manager post to read - `managerText` is a
 * plain-English description of the move itself (`describeMove`, `chaseSubject: "move"`), and
 * `reply.ts` treats it accordingly (never quoted back as if the manager said it). Every gate here
 * skips silently: a Dex Desk post always lands regardless of whether Sam ever follows up.
 */
export const askSamAboutMove = internalAction({
  args: {
    leaguePostId: v.id("wireLeaguePosts"),
    leagueId: v.id("leagues"),
    seasonId: v.number(),
    week: v.optional(v.number()),
    teamId: v.id("teams"),
    move: moveDescriptionValidator,
  },
  returns: v.null(),
  handler: async (ctx, { leaguePostId, leagueId, seasonId, week, teamId, move }) => {
    if (!wireEnabled()) return null;

    const manager: { userId: Id<"users"> } | null = await ctx.runQuery(internal.wireDeskData.getManagerForTeam, {
      teamId,
      seasonId,
    });
    if (!manager) return null; // no claimed team - spec §18: skip

    const now = Date.now();
    const counts: { perManagerToday: number; perLeagueToday: number } = await ctx.runQuery(
      internal.wireDeskData.getSamQuestionCountsToday,
      { leagueId, teamId, now }
    );
    const spend: { totalUsd: number } = await ctx.runQuery(internal.deskMetrics.getLeagueSeasonSpend, { leagueId, seasonId });
    const reason = samQuestionGateReason({
      perManagerToday: counts.perManagerToday,
      perLeagueToday: counts.perLeagueToday,
      seasonSpendUsd: spend.totalUsd,
      spendCapUsd: automationSpendCapUsd(),
    });
    if (reason) {
      console.log(`wireSocial.askSamAboutMove: skipped leaguePost ${leaguePostId} (${reason})`);
      return null;
    }

    const relationships = await ctx.runQuery(internal.relationships.getRelationshipsForWriter, {
      leagueId,
      persona: "sam-ortega",
      userIds: [manager.userId],
    });
    const rel = relationships[0];

    const language = await ctx.runQuery(internal.languageSettings.getLeagueLanguage, { leagueId });
    const cleanTeam = language.cleanTeamNames.includes(move.team);

    const input: WriterReplyInput = {
      persona: "sam-ortega",
      mode: "chase",
      chaseSubject: "move",
      managerText: describeMove(move as MoveDescriptionInput),
      manager: {
        displayName: rel?.managerName ?? move.manager,
        teamName: rel?.teamName ?? move.team,
        relationshipTier: rel?.tier ?? "neutral",
        recentEvidence: (rel?.recentEvents ?? []).slice(0, 3).map((event) => event.evidence),
      },
      thread: [],
      languageRating: language.languageRating,
      cleanTeam,
      week,
    };

    const result = await generateWriterReply(input, requireEnv("ANTHROPIC_API_KEY"));

    if (result.text) {
      await ctx.runMutation(internal.wireDeskData.insertSamQuestion, {
        leagueId,
        seasonId,
        week,
        deskPostId: leaguePostId,
        teamId,
        text: result.text,
        generationStats: { costUsd: result.costUsd, model: result.model, effort: result.effort },
      });
    }

    // Chase mode never moves the relationship meter (spec §17.3: only "reply" mode does) - the
    // sentiment classification exists on `result` but there is no manager post to tag it onto here.
    return null;
  },
});
