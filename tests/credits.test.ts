import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.*s");

describe("credits ledger", () => {
  it("grant -> deduct -> refund leaves the expected balance and a 3-row audit trail", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_credits_grant_deduct_refund";

    const grant = await t.mutation(internal.credits.grantCredits, {
      userId,
      amount: 100,
      type: "earned",
      description: "test grant",
    });
    expect(grant.newBalance).toBe(100);

    const deduct = await t.mutation(internal.credits.deductCredits, {
      userId,
      amount: 30,
      description: "test deduct",
    });
    expect(deduct.newBalance).toBe(70);

    const refund = await t.mutation(internal.credits.refundCredits, {
      userId,
      amount: 30,
      description: "test refund",
    });
    expect(refund.newBalance).toBe(100);

    const transactions = await t.run((ctx) =>
      ctx.db
        .query("creditTransactions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    );
    expect(transactions).toHaveLength(3);
    expect(transactions.map((tx) => tx.type).sort()).toEqual(["earned", "refunded", "spent"]);
  });

  it("checkSufficientCredits is true at the exact balance and false one credit over", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_credits_boundary";

    await t.mutation(internal.credits.grantCredits, {
      userId,
      amount: 50,
      type: "earned",
      description: "seed balance",
    });

    const atBoundary = await t.query(internal.credits.checkSufficientCredits, {
      userId,
      requiredAmount: 50,
    });
    expect(atBoundary.hasSufficientCredits).toBe(true);

    const overBoundary = await t.query(internal.credits.checkSufficientCredits, {
      userId,
      requiredAmount: 51,
    });
    expect(overBoundary.hasSufficientCredits).toBe(false);
  });
});
