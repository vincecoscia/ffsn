"use node";

/**
 * The Wire — take batch flush (ffsn-the-wire-spec.md §3.1, §8.2, §8.4). Every event above the take
 * floor sits as `wirePosts.status: "take_pending"` (already visible to readers as a plain card)
 * until this cron picks it up: grouped by persona, one Sonnet call per persona covers the whole
 * batch, so the long persona system prompt is paid once per 10-minute window rather than once per
 * event. A result that comes back without a `take` (failed verification) falls back to the plain
 * card via `failTake` - the Wire never holds a post for review, it's too fast for a queue (spec
 * §8.1). `"use node"` only because `src/lib/ai/wire/take.ts` imports `@anthropic-ai/sdk`.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireEnv } from "./lib/nodeHelpers";
import { DEFAULT_GLOBAL_DAILY_CAP_USD } from "../src/lib/ai/wire/types";
import type { WireFactCard, WirePersona } from "../src/lib/ai/wire/types";
import { generateWireTakes, type WireTakeInput, type WireTakeResult } from "../src/lib/ai/wire/take";
import { wireEnabled } from "./lib/wireLeaguePosting";

interface PendingTake {
  postId: Id<"wirePosts">;
  persona: string;
  card: unknown;
}

function dailyCapUsd(): number {
  const raw = process.env.WIRE_GLOBAL_DAILY_CAP_USD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GLOBAL_DAILY_CAP_USD;
}

export const flushTakeBatch = internalAction({
  args: {},
  returns: v.object({
    pending: v.number(),
    applied: v.number(),
    failed: v.number(),
    costUsd: v.number(),
    cappedOut: v.boolean(),
  }),
  handler: async (ctx) => {
    if (!wireEnabled()) {
      return { pending: 0, applied: 0, failed: 0, costUsd: 0, cappedOut: false };
    }
    const pending: PendingTake[] = await ctx.runQuery(internal.wireDetect.getPendingTakes, {});
    if (pending.length === 0) {
      return { pending: 0, applied: 0, failed: 0, costUsd: 0, cappedOut: false };
    }

    const spentToday: number = await ctx.runQuery(internal.wireDetect.getGlobalSpendToday, {});
    if (spentToday >= dailyCapUsd()) {
      for (const post of pending) {
        await ctx.runMutation(internal.wireDetect.failTake, { postId: post.postId, flags: ["daily_cap"] });
      }
      return { pending: pending.length, applied: 0, failed: pending.length, costUsd: 0, cappedOut: true };
    }

    const byPersona = new Map<string, PendingTake[]>();
    for (const post of pending) {
      const list = byPersona.get(post.persona) ?? [];
      list.push(post);
      byPersona.set(post.persona, list);
    }

    let applied = 0;
    let failed = 0;
    let costUsd = 0;
    const apiKey = requireEnv("ANTHROPIC_API_KEY");

    for (const [persona, posts] of byPersona) {
      // Each card was validated at ingestion time (wireDetect.ts) before being stored as `v.any()` -
      // this cast just recovers that already-checked shape for the prompt layer.
      const inputs: WireTakeInput[] = posts.map((p) => ({ postId: p.postId, card: p.card as WireFactCard }));

      try {
        const batch = await generateWireTakes(inputs, persona as WirePersona, apiKey);
        const perPost = posts.length > 0 ? batch.costUsd / posts.length : 0;
        const resultByPostId = new Map<string, WireTakeResult>(batch.results.map((r) => [r.postId, r]));

        for (const post of posts) {
          const result = resultByPostId.get(post.postId);
          if (result?.take) {
            await ctx.runMutation(internal.wireDetect.applyTake, {
              postId: post.postId,
              take: result.take,
              stats: { costUsd: perPost, model: batch.model, effort: batch.effort },
            });
            applied++;
            costUsd += perPost;
          } else {
            await ctx.runMutation(internal.wireDetect.failTake, {
              postId: post.postId,
              flags: result?.flags && result.flags.length > 0 ? result.flags : ["take_failed_verify"],
              stats: { costUsd: perPost, model: batch.model, effort: batch.effort },
            });
            costUsd += perPost;
            failed++;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "generateWireTakes threw";
        console.error(`wireGenerate.flushTakeBatch: ${persona} batch failed:`, message);
        for (const post of posts) {
          await ctx.runMutation(internal.wireDetect.failTake, { postId: post.postId, flags: ["generation_error"] });
          failed++;
        }
      }
    }

    return { pending: pending.length, applied, failed, costUsd, cappedOut: false };
  },
});
