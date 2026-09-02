import { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";

/**
 * Shared failure handling for the AI generation chain (spec §9.2.5).
 *
 * Lives in its own module rather than in `aiContent.ts` because both
 * `aiContent.ts` and `aiContentHelpers.ts` need it, and a direct value import
 * between those two modules makes their `internal.*` types mutually recursive
 * (TypeScript then infers `any` for half the API surface).
 */

/**
 * `InsufficientDataError` (src/lib/ai/prompt-builder) is thrown when a content
 * type's core data is absent. It reaches the action through the Node runtime,
 * where only the name and message survive, so match on both. Its message is
 * written for a human and is stored verbatim as the article's failure reason.
 */
export function isInsufficientDataError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "InsufficientDataError" ||
    /^Not enough data to write a/i.test(error.message)
  );
}

/**
 * Content types whose generation is flaky enough to be worth an automatic
 * retry. Everything else fails once and waits for a human or for the cron.
 */
export const RETRYABLE_CONTENT_TYPES = new Set(["mock_draft", "weekly_recap"]);

/** Retries per article, counted across the whole prepare -> generate chain. */
export const MAX_GENERATION_RETRIES = 3;

export type GenerationFailureContext = {
  articleId: Id<"aiContent">;
  leagueId: Id<"leagues">;
  contentType: string;
  persona: string;
  customContext?: string;
  userId: string;
  seasonId?: number;
  week?: number;
  scheduledContentId?: Id<"scheduledContent">;
  creditsDeductedUpFront?: number;
  retryCount?: number;
  /** Where this failed. Used in the log line and the refund error message. */
  stage: string;
};

/**
 * Everything that has to happen when a generation fails, shared by the three
 * places it can (aiContent.generateContentAction,
 * aiContentHelpers.prepareAIContentData,
 * aiContentHelpers.generateAIContentWithData) so the retry cap, the refund and
 * the scheduled row behave the same wherever the chain broke.
 *
 * Order matters: the refund only happens when this is the end of the road. A
 * failure that is about to be retried keeps the credits with the run, so a
 * three-attempt article is charged once rather than refunded and re-charged on
 * every attempt.
 */
export async function handleGenerationFailure(
  ctx: ActionCtx,
  args: GenerationFailureContext,
  error: unknown
): Promise<{ retryScheduled: boolean; refunded: boolean }> {
  const message = error instanceof Error ? error.message : `${args.stage} failed`;
  const retryCount = args.retryCount ?? 0;
  // An InsufficientDataError is not flaky: the week's data is missing, and
  // retrying only burns the same path again.
  const retryable = !isInsufficientDataError(error);

  // Scheduled rows are the cron's to retry (it re-reads the row and re-runs
  // processScheduledContent), so this path never schedules one for them.
  const willRetry =
    retryable &&
    !args.scheduledContentId &&
    RETRYABLE_CONTENT_TYPES.has(args.contentType) &&
    retryCount < MAX_GENERATION_RETRIES;

  // Refunds only ever apply to a real person's credits. Automated content is
  // covered by the League Pass (spec §10.1) and is never charged, so a
  // "system" generation has nothing to give back - the old commissioner-refund
  // fallback here existed only for the per-story charge the pass replaced.
  let refundError: unknown = null;
  let refunded = false;
  const refundable =
    args.creditsDeductedUpFront && args.userId !== "system" ? args.creditsDeductedUpFront : 0;

  if (refundable > 0 && !willRetry) {
    try {
      await ctx.runMutation(internal.credits.refundCredits, {
        userId: args.userId,
        amount: refundable,
        description: `Refund: failed AI content generation (${args.contentType})`,
        leagueId: args.leagueId,
        relatedContentId: args.articleId,
      });
      refunded = true;
    } catch (e) {
      console.error(`Failed to refund credits after ${args.stage} failure:`, e);
      refundError = e;
    }
  }

  await ctx.runMutation(internal.aiContent.updateContentStatusInternal, {
    articleId: args.articleId,
    status: "failed",
    error: message,
  });

  if (args.scheduledContentId) {
    try {
      const outcome = await ctx.runMutation(
        internal.aiContent.recordScheduledGenerationFailure,
        {
          scheduledContentId: args.scheduledContentId,
          leagueId: args.leagueId,
          contentType: args.contentType,
          articleId: args.articleId,
          errorMessage: message,
          retryable,
        }
      );
      console.log(`Scheduled row after ${args.stage} failure:`, outcome);
    } catch (e) {
      console.warn("Failed to update scheduled content status after failure", e);
    }
  }

  if (willRetry) {
    console.log(
      `Scheduling retry ${retryCount + 1}/${MAX_GENERATION_RETRIES} for failed ${args.contentType} generation`
    );
    await ctx.scheduler.runAfter(2000, internal.aiContentHelpers.retryFailedGeneration, {
      articleId: args.articleId,
      leagueId: args.leagueId,
      contentType: args.contentType,
      persona: args.persona,
      customContext: args.customContext,
      userId: args.userId,
      seasonId: args.seasonId,
      week: args.week,
      retryCount,
      creditsDeductedUpFront: args.creditsDeductedUpFront,
      scheduledContentId: args.scheduledContentId,
    });
  }

  if (refundError) {
    // Surface loudly instead of swallowing: the refund did not happen and the
    // user's balance needs manual reconciliation.
    throw new Error(
      `${args.stage} failed for article ${args.articleId} and the credit refund also failed: ${
        refundError instanceof Error ? refundError.message : String(refundError)
      }`
    );
  }

  return { retryScheduled: willRetry, refunded };
}
