"use node";

/**
 * Message Batches for scheduled generation (spec §10.3 item 5).
 *
 * A scheduled article whose print time is still >= 2h away is written through
 * the Anthropic Message Batches API instead of the direct path: at print - 3h
 * `submitScheduledArticle` submits the exact params `prepareArticleRequest()`
 * would have sent, stores `batchId`/`batchCustomId` on the `scheduledContent`
 * row (status `batched`), and `pollBatches` picks the result up every 10
 * minutes. Batch is billed at 50%, so every accounting call passes
 * `{ batch: true }`.
 *
 * Falling back is always safe: any row this file cannot finish is put back to
 * `status: "pending"` with `nextRetryAt = now`, which is exactly the state
 * `contentScheduling.getPendingScheduledContent` looks for, so the direct path
 * (`processScheduledContent` -> `aiContent.generateContentAction`) picks it up
 * on its next tick and writes the article the normal way.
 *
 * This file is "use node" because the Anthropic SDK dynamically imports
 * `node:fs` (see the header of `convex/aiNode.ts`). "use node" modules cannot
 * export queries or mutations, so every database read and write here goes
 * through an existing `internal.*` function.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { FunctionArgs } from "convex/server";
import Anthropic from "@anthropic-ai/sdk";
import schema from "./schema";
// Plain data module (no runtime deps); `contentScheduling.defaultPersonaFor`
// is the same one-liner over the same map, inlined below rather than imported
// so this file does not take a value dependency on a module that registers
// Convex functions (see the note in convex/lib/generationFailure.ts about
// mutually recursive `internal.*` types).
import { contentTypePersonaMap, DEFAULT_PERSONA } from "../src/lib/ai/persona-prompts";
// The prompt layer (spec §10.3.5): `prepareArticleRequest` builds exactly what
// the direct path would send, and `completeArticleFromMessage` runs the same
// parse -> verify -> (rare) regeneration -> assemble path on the way back.
import {
  completeArticleFromMessage,
  prepareArticleRequest,
} from "../src/lib/ai/content-generation-service";
import type { GenerationRequest } from "../src/lib/ai/content-generation-service";
import type { LeagueDataContext } from "../src/lib/ai/prompt-builder";

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Content types whose prompt is built from a prepared-data pass
 * (`aiContentHelpers.prepareAIContentData` -> `generateAIContentWithData`)
 * rather than from `getLeagueDataForGenerationInternal` alone. Batching them
 * would mean reproducing that two-step chain, so they stay on the direct path.
 */
const PREPARED_PATH_CONTENT_TYPES = new Set([
  "mock_draft",
  "weekly_recap",
  "season_welcome",
  "draft_rankings",
]);

/* -------------------------------------------------------------------------- *
 * Pure helpers (unit-tested in tests/aiBatch.test.ts)
 * -------------------------------------------------------------------------- */

/** The shape of one entry's `result` in a batch's `.results()` stream. */
export type BatchIndividualResult =
  | { type: "succeeded"; message: Anthropic.Message }
  | { type: "errored"; error?: { error?: { message?: string }; type?: string } }
  | { type: "canceled" }
  | { type: "expired" };

/** What to do with one batch result. */
export type BatchDisposition =
  | { action: "complete"; message: Anthropic.Message }
  | {
      action: "requeue";
      reason: "errored" | "expired" | "canceled" | "missing" | "unknown";
      detail?: string;
    };

/**
 * Route one batch result: a succeeded result carries the message that
 * `completeArticleFromMessage()` parses and verifies; everything else - an
 * error, an expiry, a cancellation, or a result that never arrived for this
 * `custom_id` - sends the row back to the direct path.
 */
export function classifyBatchResult(
  result: BatchIndividualResult | null | undefined
): BatchDisposition {
  if (!result) {
    return { action: "requeue", reason: "missing", detail: "no result for custom_id" };
  }

  switch (result.type) {
    case "succeeded":
      return { action: "complete", message: result.message };
    case "errored":
      return {
        action: "requeue",
        reason: "errored",
        detail: result.error?.error?.message ?? result.error?.type ?? "unknown error",
      };
    case "expired":
      return { action: "requeue", reason: "expired" };
    case "canceled":
      return { action: "requeue", reason: "canceled" };
    default:
      return {
        action: "requeue",
        reason: "unknown",
        detail: `unrecognized result type ${String((result as { type?: unknown }).type)}`,
      };
  }
}

/**
 * Batch turnaround is best-effort within 24h, so a row only goes to the batch
 * API when there is real slack before print (spec §10.3 item 5: "default on
 * when print time is >= 2h away"). Anything closer is written directly.
 */
export function isBatchEligible(printAt: number, now: number): boolean {
  if (!Number.isFinite(printAt) || !Number.isFinite(now)) return false;
  return printAt - now >= TWO_HOURS_MS;
}

/**
 * Convex env `BATCH_SCHEDULED_GENERATION`. Default on; set it to
 * "0"/"false"/"off"/"no" to send every scheduled article down the direct path.
 */
export function isBatchingEnabled(
  raw: string | undefined = process.env.BATCH_SCHEDULED_GENERATION
): boolean {
  if (raw === undefined || raw.trim() === "") return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

/** The roster default writer for a content type (`contentScheduling.defaultPersonaFor`). */
function defaultPersonaFor(contentType: string): string {
  return contentTypePersonaMap[contentType]?.[0] ?? DEFAULT_PERSONA;
}

/**
 * `custom_id` must match `^[a-zA-Z0-9_-]{1,64}$`. Convex document ids already
 * do, but sanitize rather than let a batch submission fail on a stray char.
 */
export function toCustomId(scheduledContentId: string): string {
  return scheduledContentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/* -------------------------------------------------------------------------- *
 * PRICE-B seam
 * -------------------------------------------------------------------------- */

type ScheduledStatusArgs = FunctionArgs<
  typeof internal.contentScheduling.updateScheduledContentStatus
>;

/**
 * `scheduledContent.batchId` / `batchCustomId` / `batchSubmittedAt` and the
 * `"batched"` status are PRICE-B's schema additions (spec §10.4). Until they
 * land, patching them would be rejected as unknown fields and `"batched"`
 * would fail the status union - so every batch submission is gated on what the
 * deployed schema actually declares, exactly like
 * `aiContent.scheduledContentHasField`.
 */
export function scheduledContentSupportsBatch(): boolean {
  const fields = (
    schema.tables.scheduledContent.validator as unknown as {
      fields?: Record<string, unknown>;
    }
  ).fields;
  if (!fields) return false;

  const hasFields = ["batchId", "batchCustomId", "batchSubmittedAt"].every(
    (field) => field in fields
  );
  if (!hasFields) return false;

  const status = fields.status as { members?: Array<{ value?: unknown }> } | undefined;
  return Boolean(status?.members?.some((member) => member.value === "batched"));
}

/** Single cast point for the batch fields PRICE-B adds to the status mutation. */
async function patchScheduledRow(
  ctx: ActionCtx,
  updates: Record<string, unknown> & { scheduledContentId: Id<"scheduledContent"> }
): Promise<void> {
  await ctx.runMutation(
    internal.contentScheduling.updateScheduledContentStatus,
    updates as unknown as ScheduledStatusArgs
  );
}

/**
 * Rows sitting in `status: "batched"`. `getBatchedScheduledContent` is the
 * query PRICE-B adds for this (spec §10.4); until it exists the poll falls
 * back to the ids the submitting action handed to the scheduler, which is why
 * `pollBatches` accepts (but never requires) them.
 */
async function loadBatchedRows(
  ctx: ActionCtx,
  fallbackIds: Id<"scheduledContent">[] | undefined
): Promise<Array<Doc<"scheduledContent">>> {
  const scheduling = internal.contentScheduling as unknown as {
    getBatchedScheduledContent: Parameters<ActionCtx["runQuery"]>[0];
  };

  try {
    const rows = (await ctx.runQuery(scheduling.getBatchedScheduledContent, {})) as Array<
      Doc<"scheduledContent">
    >;
    if (Array.isArray(rows)) return rows;
  } catch (error) {
    console.warn(
      "[batch] contentScheduling.getBatchedScheduledContent unavailable; falling back to the submitted ids",
      error instanceof Error ? error.message : error
    );
  }

  if (!fallbackIds?.length) return [];

  const rows: Array<Doc<"scheduledContent">> = [];
  for (const scheduledContentId of fallbackIds) {
    const row = await ctx.runQuery(internal.contentScheduling.getScheduledContentById, {
      scheduledContentId,
    });
    if (row && batchStatusOf(row) === "batched") rows.push(row);
  }
  return rows;
}

/* -------------------------------------------------------------------------- *
 * Shared plumbing
 * -------------------------------------------------------------------------- */

/** `status` widened to include PRICE-B's `"batched"` literal. */
function batchStatusOf(row: Doc<"scheduledContent">): string {
  return (row as unknown as { status: string }).status;
}

function batchFieldsOf(row: Doc<"scheduledContent">): {
  batchId?: string;
  batchCustomId?: string;
  batchSubmittedAt?: number;
} {
  return row as unknown as {
    batchId?: string;
    batchCustomId?: string;
    batchSubmittedAt?: number;
  };
}

function requireApiKey(): string {
  const value = process.env.ANTHROPIC_API_KEY;
  if (!value) {
    throw new Error(
      'ANTHROPIC_API_KEY not configured. Set it with: npx convex env set ANTHROPIC_API_KEY "..."'
    );
  }
  return value;
}

/**
 * Automated content never consumes credits - it is covered by the League Pass
 * while `league.subscription.status === "active"` (spec §10.1), which is why
 * nothing in this file deducts or refunds. `"paid"` is the pre-pass status
 * every existing league carries and counts as live, same as
 * `credits.hasActivePass` (inlined rather than imported: `credits.ts` registers
 * Convex functions, and a value import from here would make the two modules'
 * `internal.*` types mutually recursive).
 */
function hasActivePass(league: { subscription?: { status?: string } } | null): boolean {
  const status = league?.subscription?.status;
  return status === "active" || status === "paid";
}

/**
 * The `GenerationRequest` the direct path builds for a scheduled row - the
 * standard branch of `aiContent.generateContentAction`, field for field:
 * league data, the row's context as `customContext`, the interview ledger, the
 * writer's relationships and the writer's prior claims.
 *
 * `pollBatches` rebuilds this to recover `prepared` for
 * `completeArticleFromMessage()`, so it MUST be deterministic for a given row:
 * every input is read from the database rather than from the clock. Facts can
 * still move between submission and completion (a late trade, a new approved
 * quote); the message we already paid for is completed against the rebuilt
 * prompt regardless - the verifier then judges that message against the
 * current facts, which is the same standard the direct path applies.
 */
async function buildGenerationRequest(
  ctx: ActionCtx,
  row: Doc<"scheduledContent">,
  persona: string
): Promise<GenerationRequest> {
  const leagueId = row.leagueId;
  const contentType = row.contentType;
  const week = row.week ?? row.contextData?.week;

  const leagueData = await ctx.runQuery(
    internal.aiContent.getLeagueDataForGenerationInternal,
    { leagueId }
  );

  const commentResponses = await ctx.runQuery(
    internal.aiContentHelpers.getCommentResponsesForContent,
    { scheduledContentId: row._id, leagueId, contentType, week }
  );
  const nonRespondents = await ctx.runQuery(
    internal.aiContentHelpers.getNonRespondentsForScheduledContent,
    { scheduledContentId: row._id }
  );

  const relationships = await ctx.runQuery(
    internal.relationships.getRelationshipsForWriter,
    { leagueId, persona }
  );
  const priorClaims = await ctx.runQuery(internal.claims.getPriorClaimsForWriter, {
    leagueId,
    persona,
  });
  // League language rating + per-manager opt-down (owner ask, Sept 2026), resolved the same
  // way every other generation path resolves it.
  const languageSettings = await ctx.runQuery(internal.languageSettings.getLeagueLanguage, {
    leagueId,
  });

  return {
    leagueId,
    contentType,
    persona,
    leagueData: leagueData as unknown as LeagueDataContext,
    customContext: row.contextData ? JSON.stringify(row.contextData) : undefined,
    userId: "system",
    commentResponses: commentResponses.length ? commentResponses : undefined,
    nonRespondents: nonRespondents.length ? nonRespondents : undefined,
    relationships: relationships.length ? relationships : undefined,
    priorClaims: priorClaims.items,
    priorRecord: priorClaims.record,
    languageRating: languageSettings.languageRating,
    cleanTeamNames: languageSettings.cleanTeamNames.length
      ? languageSettings.cleanTeamNames
      : undefined,
  } as GenerationRequest;
}

/** The writer for a row: the schedule's choice, else the roster default. */
async function personaFor(ctx: ActionCtx, row: Doc<"scheduledContent">): Promise<string> {
  const contentSchedule = await ctx.runQuery(
    internal.contentScheduling.getContentScheduleById,
    { contentScheduleId: row.contentScheduleId }
  );
  return contentSchedule?.preferredPersona || defaultPersonaFor(row.contentType);
}

/**
 * Hand the row back to the direct path: fail the placeholder article the batch
 * created, and drop the row to `pending` with `nextRetryAt = now` so the very
 * next scheduler tick regenerates it. No credit movement - automated content
 * does not spend credits (spec §10.1).
 */
async function requeueForDirectPath(
  ctx: ActionCtx,
  row: Doc<"scheduledContent">,
  reason: string,
  detail?: string
): Promise<void> {
  const message = detail ? `[batch] ${reason}: ${detail}` : `[batch] ${reason}`;
  const articleId = row.generatedContentId;

  if (articleId) {
    try {
      await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
        articleId,
        status: "failed",
        error: message,
      });
    } catch (error) {
      console.warn("[batch] could not fail the placeholder article", articleId, error);
    }
  }

  await patchScheduledRow(ctx, {
    scheduledContentId: row._id,
    status: "pending",
    // Now, not a cooldown: the direct path should pick this up immediately.
    nextRetryAt: Date.now(),
    errorMessage: message,
  });

  console.log(`[batch] requeued ${row.contentType} row=${row._id} reason=${message}`);
}

/* -------------------------------------------------------------------------- *
 * 1. Submit
 * -------------------------------------------------------------------------- */

export const submitScheduledArticle = internalAction({
  args: { scheduledContentId: v.id("scheduledContent") },
  handler: async (
    ctx,
    args
  ): Promise<{
    submitted: boolean;
    reason?: string;
    batchId?: string;
    articleId?: Id<"aiContent">;
  }> => {
    const row = await ctx.runQuery(internal.contentScheduling.getScheduledContentById, {
      scheduledContentId: args.scheduledContentId,
    });

    if (!row) return { submitted: false, reason: "row_missing" };
    if (batchStatusOf(row) !== "pending") return { submitted: false, reason: "not_pending" };
    if (!isBatchingEnabled()) return { submitted: false, reason: "disabled" };
    if (!scheduledContentSupportsBatch()) {
      console.warn(
        "[batch] scheduledContent schema has no batch fields yet (PRICE-B); using the direct path"
      );
      return { submitted: false, reason: "schema_missing" };
    }
    if (!isBatchEligible(row.scheduledFor, Date.now())) {
      return { submitted: false, reason: "too_close_to_print" };
    }
    if (PREPARED_PATH_CONTENT_TYPES.has(row.contentType)) {
      return { submitted: false, reason: "prepared_path" };
    }

    // The same gates processScheduledContent applies before it spends a
    // generation slot. A gate that fails here is NOT resolved by this action:
    // the row is left `pending` so the direct path cancels it with the right
    // reason and sends the right notification.
    const contentSchedule = await ctx.runQuery(
      internal.contentScheduling.getContentScheduleById,
      { contentScheduleId: row.contentScheduleId }
    );
    if (!contentSchedule?.enabled) return { submitted: false, reason: "schedule_disabled" };

    const preferences = await ctx.runQuery(internal.contentScheduling.getLeaguePreferences, {
      leagueId: row.leagueId,
    });
    if (!preferences?.contentEnabled) return { submitted: false, reason: "content_disabled" };
    if (
      preferences.monthlyContentBudget &&
      preferences.currentMonthSpent >= preferences.monthlyContentBudget
    ) {
      return { submitted: false, reason: "budget_exceeded" };
    }

    const league = await ctx.runQuery(internal.contentScheduling.getLeagueById, {
      leagueId: row.leagueId,
    });
    if (!league) return { submitted: false, reason: "league_missing" };
    // Only spend real API money ahead of print for a league whose pass is live;
    // anything else goes down the direct path, which owns the cancel/notify.
    if (!hasActivePass(league)) return { submitted: false, reason: "no_active_pass" };

    const persona = contentSchedule.preferredPersona || defaultPersonaFor(row.contentType);

    const articleId = await ctx.runMutation(internal.aiContent.createScheduledArticle, {
      leagueId: row.leagueId,
      type: row.contentType,
      persona,
      userId: "system",
    });

    const customId = toCustomId(args.scheduledContentId);

    try {
      const request = await buildGenerationRequest(ctx, row, persona);
      const prepared = await prepareArticleRequest(request);

      const anthropic = new Anthropic({ apiKey: requireApiKey() });
      const batch = await anthropic.messages.batches.create({
        requests: [{ custom_id: customId, params: prepared.params }],
      });

      await patchScheduledRow(ctx, {
        scheduledContentId: row._id,
        status: "batched",
        generatedContentId: articleId,
        batchId: batch.id,
        batchCustomId: customId,
        batchSubmittedAt: Date.now(),
        lastAttemptAt: Date.now(),
        // `attempts` is deliberately not spent here. It is the direct path's
        // retry budget, and a batch that errors hands the row straight back to
        // it - burning one of three attempts on a queue submission would make a
        // bad Anthropic afternoon look like a bad article.
      });

      // Poll on our own schedule; a cron may also call pollBatches with no args.
      await ctx.scheduler.runAfter(POLL_INTERVAL_MS, internal.aiBatch.pollBatches, {
        scheduledContentIds: [row._id],
      });

      const promptChars = prepared.systemPrompt.length + prepared.userPrompt.length;
      console.log(
        `[batch] submitted ${row.contentType} batch=${batch.id} custom_id=${customId} ` +
          `article=${articleId} model=${String(prepared.params.model)} ` +
          `maxTokens=${prepared.params.max_tokens} promptChars=${promptChars} ` +
          `billing=batch(50%) printAt=${new Date(row.scheduledFor).toISOString()}`
      );

      return { submitted: true, batchId: batch.id, articleId };
    } catch (error) {
      console.error("[batch] submission failed; falling back to the direct path", error);
      await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
        articleId,
        status: "failed",
        error: `[batch] submit failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      // The row is still `pending`, so the scheduler writes it directly.
      return { submitted: false, reason: "submit_failed" };
    }
  },
});

/* -------------------------------------------------------------------------- *
 * 2. Poll
 * -------------------------------------------------------------------------- */

/**
 * Finish one succeeded batch result through the same mutations the direct path
 * uses: `updateGeneratedContent` then `finalizeGeneratedArticle`. The row is
 * moved to `generating` first because `finalizeGeneratedArticle` only closes a
 * scheduled row that is `generating` or `pending`.
 */
async function completeFromMessage(
  ctx: ActionCtx,
  row: Doc<"scheduledContent">,
  message: Anthropic.Message
): Promise<boolean> {
  // Two polls can overlap (the self-schedule and a cron tick). Re-read the row
  // before spending anything: verification and any section rewrite inside
  // completeArticleFromMessage are real model calls, and a second pass would
  // also overwrite an article that is already finished.
  const current = await ctx.runQuery(internal.contentScheduling.getScheduledContentById, {
    scheduledContentId: row._id,
  });
  if (!current || batchStatusOf(current) !== "batched") {
    console.log(
      `[batch] row ${row._id} is no longer batched (${
        current ? batchStatusOf(current) : "deleted"
      }); another poll finished it`
    );
    return false;
  }

  const persona = await personaFor(ctx, row);

  let articleId = row.generatedContentId;
  if (!articleId) {
    articleId = await ctx.runMutation(internal.aiContent.createScheduledArticle, {
      leagueId: row.leagueId,
      type: row.contentType,
      persona,
      userId: "system",
    });
  }

  const request = await buildGenerationRequest(ctx, row, persona);
  const prepared = await prepareArticleRequest(request);
  // `batch: true` halves `metadata.costUsd` (batch is billed at 50%);
  // `startedAt` is the submission, so `metadata.generationTime` reports the
  // real wall clock of the batch rather than the few seconds this poll took.
  const generated = await completeArticleFromMessage(message, prepared, requireApiKey(), {
    batch: true,
    startedAt: batchFieldsOf(row).batchSubmittedAt ?? prepared.startedAt,
  });

  await patchScheduledRow(ctx, {
    scheduledContentId: row._id,
    status: "generating",
    lastAttemptAt: Date.now(),
  });

  await ctx.runMutation(internal.aiContent.updateGeneratedContent, {
    articleId,
    title: generated.title,
    content: generated.content,
    summary: generated.summary,
    metadata: generated.metadata,
  });

  let scheduledRowCompleted = false;
  try {
    const finalized = await ctx.runMutation(internal.aiContent.finalizeGeneratedArticle, {
      articleId,
      leagueId: row.leagueId,
      scheduledContentId: row._id,
      reviewFlags: generated.metadata.reviewFlags,
      generatedByUserId: "system",
      // The batch API only ever runs for scheduled (automated) content - never a manual,
      // credits-billed request - so this is always "pass" (spec §10.1).
      billing: "pass",
    });
    scheduledRowCompleted = finalized.scheduledRowCompleted;
    console.log("[batch] article finalized:", finalized);
  } catch (error) {
    console.error("[batch] failed to finalize generated article", articleId, error);
  }

  if (!scheduledRowCompleted) {
    await patchScheduledRow(ctx, {
      scheduledContentId: row._id,
      status: "completed",
      generatedContentId: articleId,
      generatedAt: Date.now(),
    });
  }

  // Parity with the direct path: banner image, then monthly spend. Neither may
  // fail an article that already exists.
  try {
    const storageId = await ctx.runAction(internal.aiNode.generateBannerImage, {
      title: generated.title,
      contentType: row.contentType,
      persona,
      metadata: {
        week: generated.metadata?.week,
        featuredTeams: generated.metadata?.featuredTeams,
        featuredPlayers: generated.metadata?.featuredPlayers,
      },
    });
    if (storageId) {
      await ctx.runMutation(internal.aiContent.storeBannerImage, { articleId, storageId });
    }
  } catch (error) {
    console.error("[batch] failed to generate/store banner image", error);
  }

  try {
    const preferences = await ctx.runQuery(internal.contentScheduling.getLeaguePreferences, {
      leagueId: row.leagueId,
    });
    if (preferences?._id) {
      await ctx.runMutation(internal.contentScheduling.updateMonthlySpending, {
        preferencesId: preferences._id,
        creditsUsed: generated.metadata.creditsUsed,
      });
    }
  } catch (error) {
    console.warn("[batch] failed to update monthly content spending", error);
  }

  const costUsd = generated.metadata.costUsd;
  console.log(
    `[batch] completed ${row.contentType} row=${row._id} article=${articleId} ` +
      `model=${generated.metadata.modelUsed} in=${generated.metadata.promptTokens} ` +
      `out=${generated.metadata.completionTokens} ` +
      `msgIn=${message.usage?.input_tokens ?? 0} msgOut=${message.usage?.output_tokens ?? 0} ` +
      `cost=$${costUsd.toFixed(4)} cacheRead=${generated.metadata.cacheReadTokens} billing=batch(50%)`
  );

  return true;
}

export const pollBatches = internalAction({
  args: {
    // Optional: the ids `submitScheduledArticle` handed to the scheduler, used
    // only when `getBatchedScheduledContent` is not deployed yet. A cron calls
    // this with no arguments.
    scheduledContentIds: v.optional(v.array(v.id("scheduledContent"))),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    checked: number;
    completed: number;
    requeued: number;
    stillProcessing: number;
  }> => {
    const rows = await loadBatchedRows(ctx, args.scheduledContentIds);
    if (rows.length === 0) {
      return { checked: 0, completed: 0, requeued: 0, stillProcessing: 0 };
    }

    const anthropic = new Anthropic({ apiKey: requireApiKey() });

    // One row per batch today, but group anyway so a future multi-row batch
    // costs one retrieve and one results stream rather than N.
    const byBatchId = new Map<string, Array<Doc<"scheduledContent">>>();
    let requeued = 0;
    for (const row of rows) {
      const batchId = batchFieldsOf(row).batchId;
      if (!batchId) {
        await requeueForDirectPath(ctx, row, "missing", "row has no batchId");
        requeued += 1;
        continue;
      }
      const group = byBatchId.get(batchId);
      if (group) group.push(row);
      else byBatchId.set(batchId, [row]);
    }

    let completed = 0;
    let stillProcessing = 0;
    const stillBatched: Id<"scheduledContent">[] = [];

    for (const [batchId, group] of byBatchId) {
      let batch: Anthropic.Messages.MessageBatch;
      try {
        batch = await anthropic.messages.batches.retrieve(batchId);
      } catch (error) {
        console.error(`[batch] retrieve failed for ${batchId}`, error);
        for (const row of group) {
          await requeueForDirectPath(
            ctx,
            row,
            "errored",
            error instanceof Error ? error.message : String(error)
          );
          requeued += 1;
        }
        continue;
      }

      if (batch.processing_status !== "ended") {
        const counts = batch.request_counts;
        console.log(
          `[batch] ${batchId} ${batch.processing_status} ` +
            `processing=${counts.processing} succeeded=${counts.succeeded} ` +
            `errored=${counts.errored} expired=${counts.expired} canceled=${counts.canceled}`
        );
        const now = Date.now();
        for (const row of group) {
          // Still processing at print time: give up on the batch and let the
          // direct path write the article on time (spec §10.3 item 5).
          if (now >= row.scheduledFor) {
            try {
              await anthropic.messages.batches.cancel(batchId);
            } catch (error) {
              console.warn(`[batch] could not cancel ${batchId}`, error);
            }
            await requeueForDirectPath(ctx, row, "canceled", "still processing at print time");
            requeued += 1;
          } else {
            stillProcessing += 1;
            stillBatched.push(row._id);
          }
        }
        continue;
      }

      const dispositions = new Map<string, BatchDisposition>();
      try {
        const results = await anthropic.messages.batches.results(batchId);
        for await (const entry of results) {
          dispositions.set(
            entry.custom_id,
            classifyBatchResult(entry.result as BatchIndividualResult)
          );
        }
      } catch (error) {
        console.error(`[batch] results stream failed for ${batchId}`, error);
      }

      for (const row of group) {
        const customId = batchFieldsOf(row).batchCustomId ?? toCustomId(row._id);
        const disposition = classifyBatchResultFor(dispositions, customId);

        if (disposition.action === "requeue") {
          await requeueForDirectPath(ctx, row, disposition.reason, disposition.detail);
          requeued += 1;
          continue;
        }

        try {
          if (await completeFromMessage(ctx, row, disposition.message)) {
            completed += 1;
          }
        } catch (error) {
          console.error(`[batch] completion failed for row ${row._id}`, error);
          await requeueForDirectPath(
            ctx,
            row,
            "errored",
            error instanceof Error ? error.message : String(error)
          );
          requeued += 1;
        }
      }
    }

    if (stillBatched.length > 0) {
      await ctx.scheduler.runAfter(POLL_INTERVAL_MS, internal.aiBatch.pollBatches, {
        scheduledContentIds: stillBatched,
      });
    }

    return { checked: rows.length, completed, requeued, stillProcessing };
  },
});

/** A `custom_id` with no line in the results file is a missing result. */
function classifyBatchResultFor(
  dispositions: Map<string, BatchDisposition>,
  customId: string
): BatchDisposition {
  return dispositions.get(customId) ?? classifyBatchResult(null);
}
