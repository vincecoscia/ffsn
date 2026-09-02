import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

describe("stripe webhook event idempotency", () => {
  it("claims once, treats retries as duplicates, and allows re-claiming after a failure", async () => {
    const t = convexTest(schema, modules);
    const eventId = "evt_test_123";
    const type = "checkout.session.completed";

    // First delivery claims the event and starts processing.
    const first = await t.mutation(internal.stripe.claimWebhookEvent, { eventId, type });
    expect(first).toEqual({ claimed: true, status: "processing" });

    // A retried delivery while still processing must not be claimed again.
    const second = await t.mutation(internal.stripe.claimWebhookEvent, { eventId, type });
    expect(second).toEqual({ claimed: false, status: "processing" });

    await t.mutation(internal.stripe.resolveWebhookEvent, { eventId, status: "processed" });

    // Once processed, any further duplicate delivery is also rejected.
    const third = await t.mutation(internal.stripe.claimWebhookEvent, { eventId, type });
    expect(third).toEqual({ claimed: false, status: "processed" });

    await t.mutation(internal.stripe.resolveWebhookEvent, {
      eventId,
      status: "failed",
      error: "simulated failure",
    });

    // A "failed" event is re-claimable so a subsequent Stripe retry can
    // actually reprocess it.
    const fourth = await t.mutation(internal.stripe.claimWebhookEvent, { eventId, type });
    expect(fourth).toEqual({ claimed: true, status: "processing" });
  });
});
