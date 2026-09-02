import { describe, expect, it } from "vitest";
import {
  classifyBatchResult,
  isBatchEligible,
  isBatchingEnabled,
  scheduledContentSupportsBatch,
  toCustomId,
  type BatchIndividualResult,
} from "../convex/aiBatch";

/**
 * Batch routing and eligibility (spec §10.3 item 5), tested as pure functions:
 * no network, no Convex, no Anthropic client. Everything else in
 * `convex/aiBatch.ts` is database plumbing around these two decisions - which
 * batch results become articles and which rows fall back to the direct path,
 * and which rows are far enough from print to be worth batching at all.
 */

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

/** A minimal stand-in for the Message the batch returns. */
function messageFixture(text: string) {
  return {
    id: "msg_batch_1",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-opus-5",
    content: [{ type: "text" as const, text, citations: null }],
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: { input_tokens: 12_000, output_tokens: 3_400 },
  };
}

describe("classifyBatchResult", () => {
  it("routes a succeeded result to the completion path, carrying the message", () => {
    const message = messageFixture("the power rankings");
    const disposition = classifyBatchResult({
      type: "succeeded",
      message,
    } as unknown as BatchIndividualResult);

    expect(disposition.action).toBe("complete");
    if (disposition.action !== "complete") throw new Error("expected complete");
    // The same object goes to completeArticleFromMessage(), not a copy of it.
    expect(disposition.message).toBe(message);
  });

  it("requeues an errored result and keeps the API error message", () => {
    const disposition = classifyBatchResult({
      type: "errored",
      error: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    } as unknown as BatchIndividualResult);

    expect(disposition).toEqual({
      action: "requeue",
      reason: "errored",
      detail: "Overloaded",
    });
  });

  it("falls back to the error type when an errored result carries no message", () => {
    const disposition = classifyBatchResult({
      type: "errored",
      error: { type: "invalid_request_error" },
    } as unknown as BatchIndividualResult);

    expect(disposition).toMatchObject({ action: "requeue", reason: "errored" });
    if (disposition.action !== "requeue") throw new Error("expected requeue");
    expect(disposition.detail).toBe("invalid_request_error");
  });

  it("requeues an expired result", () => {
    expect(classifyBatchResult({ type: "expired" })).toEqual({
      action: "requeue",
      reason: "expired",
    });
  });

  it("requeues a canceled result", () => {
    expect(classifyBatchResult({ type: "canceled" })).toEqual({
      action: "requeue",
      reason: "canceled",
    });
  });

  it("requeues when no result came back for the custom_id", () => {
    for (const absent of [null, undefined]) {
      const disposition = classifyBatchResult(absent);
      expect(disposition).toMatchObject({ action: "requeue", reason: "missing" });
    }
  });

  it("requeues an unrecognized result type rather than dropping the row", () => {
    const disposition = classifyBatchResult({
      type: "something_new",
    } as unknown as BatchIndividualResult);

    expect(disposition).toMatchObject({ action: "requeue", reason: "unknown" });
  });

  it("never completes without a message", () => {
    const results: Array<BatchIndividualResult | null> = [
      null,
      { type: "expired" },
      { type: "canceled" },
      { type: "errored" },
    ];
    for (const result of results) {
      expect(classifyBatchResult(result).action).toBe("requeue");
    }
  });
});

describe("isBatchEligible", () => {
  it("batches when print time is more than two hours away", () => {
    expect(isBatchEligible(NOW + 3 * 60 * 60 * 1000, NOW)).toBe(true);
  });

  it("batches at exactly two hours - the boundary is inclusive", () => {
    expect(isBatchEligible(NOW + TWO_HOURS_MS, NOW)).toBe(true);
  });

  it("does not batch just inside two hours", () => {
    expect(isBatchEligible(NOW + TWO_HOURS_MS - 1, NOW)).toBe(false);
    expect(isBatchEligible(NOW + 90 * 60 * 1000, NOW)).toBe(false);
  });

  it("does not batch a row whose print time has passed", () => {
    expect(isBatchEligible(NOW - 60_000, NOW)).toBe(false);
  });

  it("does not batch on a missing or unparsable timestamp", () => {
    expect(isBatchEligible(Number.NaN, NOW)).toBe(false);
    expect(isBatchEligible(NOW + TWO_HOURS_MS, Number.NaN)).toBe(false);
    expect(isBatchEligible(Number.POSITIVE_INFINITY, NOW)).toBe(false);
  });

  it("matches the print - 3h submission window the scheduler uses", () => {
    const printAt = NOW + 3 * 60 * 60 * 1000;
    expect(isBatchEligible(printAt, NOW)).toBe(true);
    // ...and the same row an hour and a half later is too close.
    expect(isBatchEligible(printAt, NOW + 100 * 60 * 1000)).toBe(false);
  });
});

describe("isBatchingEnabled", () => {
  it("defaults on when BATCH_SCHEDULED_GENERATION is unset or blank", () => {
    expect(isBatchingEnabled(undefined)).toBe(true);
    expect(isBatchingEnabled("")).toBe(true);
    expect(isBatchingEnabled("   ")).toBe(true);
  });

  it("is off for the falsy spellings", () => {
    for (const value of ["0", "false", "FALSE", "off", "no", " false "]) {
      expect(isBatchingEnabled(value)).toBe(false);
    }
  });

  it("is on for anything else", () => {
    for (const value of ["1", "true", "on", "yes"]) {
      expect(isBatchingEnabled(value)).toBe(true);
    }
  });
});

describe("scheduledContentSupportsBatch", () => {
  /**
   * The submit action refuses to batch until the deployed schema can actually
   * hold the bookkeeping. This asserts the introspection still reads the shape
   * `convex/schema.ts` declares - a rename of any batch field, or of the
   * `"batched"` status, turns batching off silently rather than throwing at
   * runtime, so it needs a test rather than a code review.
   */
  it("sees the batch fields and the batched status on scheduledContent", () => {
    expect(scheduledContentSupportsBatch()).toBe(true);
  });
});

describe("toCustomId", () => {
  it("passes a Convex document id through unchanged", () => {
    const id = "kd7abc123xyz456def789ghi012jkl";
    expect(toCustomId(id)).toBe(id);
  });

  it("keeps the id inside the API's 64-char, [a-zA-Z0-9_-] limit", () => {
    const customId = toCustomId(`${"a".repeat(70)} weird/chars`);
    expect(customId).toHaveLength(64);
    expect(customId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});
