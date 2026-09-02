import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

describe("processCreditsPurchase idempotency", () => {
  it("grants credits exactly once and flips the payment to succeeded, even when called twice", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_payments_idempotency";

    const paymentId = await t.run((ctx) =>
      ctx.db.insert("stripePayments", {
        paymentIntentId: "pi_test_credits_1",
        checkoutSessionId: "cs_test_credits_1",
        amount: 999,
        currency: "usd",
        status: "pending",
        userId,
        paymentType: "credits_purchase",
        description: "Purchase of 100 credits",
        metadata: { creditsPurchased: 100 },
        webhookProcessed: true,
        webhookProcessedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const sessionMetadata = {
      userId,
      paymentType: "credits_purchase",
      creditsPurchased: "100",
    };

    // Simulates a Stripe webhook retry (or verifyPaymentCompleted racing the
    // webhook) calling the same fulfillment mutation twice.
    await t.mutation(internal.payments.processCreditsPurchase, { paymentId, sessionMetadata });
    await t.mutation(internal.payments.processCreditsPurchase, { paymentId, sessionMetadata });

    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_payment", (q) => q.eq("relatedPaymentId", paymentId))
        .collect()
    );
    expect(transactions).toHaveLength(1);
    expect(transactions[0].type).toBe("purchased");
    expect(transactions[0].amount).toBe(100);

    const payment = await t.run((ctx) => ctx.db.get(paymentId));
    expect(payment?.status).toBe("succeeded");
  });
});
