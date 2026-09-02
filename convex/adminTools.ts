/**
 * Operator-only administration. Every function here is `internal*`, so it can only be invoked
 * with deploy credentials (`npx convex run --prod adminTools:...` or the dashboard), never from
 * the client. Each one records what it did so the ledger explains itself later.
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { INCLUDED_MANAGERS_DEFAULT } from "./credits";
import { leagueCurrentSeason } from "./lib/season";

/**
 * Marks a league's League Pass active without a Stripe payment - the operator's own league, a
 * make-good, a partner league. Writes the same subscription fields `payments.processLeaguePayment`
 * writes for a real purchase, plus `compedAt`/`compedReason` so it is never mistaken for revenue.
 */
export const setLeaguePassComped = internalMutation({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  returns: v.object({ changed: v.boolean(), status: v.string(), seasonId: v.number() }),
  handler: async (ctx, args) => {
    const league = await ctx.db.get(args.leagueId);
    if (!league) throw new Error("League not found");

    const seasonId = args.seasonId ?? league.subscription.seasonId ?? leagueCurrentSeason(league);
    const now = Date.now();
    const alreadyActive =
      (league.subscription.status === "active" || league.subscription.status === "paid") &&
      league.subscription.seasonId === seasonId;

    if (alreadyActive) {
      return { changed: false, status: league.subscription.status, seasonId };
    }

    await ctx.db.patch(args.leagueId, {
      subscription: {
        ...league.subscription,
        tier: "league_pass",
        status: "active",
        paymentStatus: "completed",
        paidAt: league.subscription.paidAt ?? now,
        seasonYear: seasonId,
        seasonId,
        includedManagers: league.subscription.includedManagers ?? INCLUDED_MANAGERS_DEFAULT,
        extraSeats: league.subscription.extraSeats ?? 0,
        compedAt: now,
        compedReason: args.reason ?? "operator comp",
      },
    });
    return { changed: true, status: "active", seasonId };
  },
});

/**
 * Comp a League Pass end to end: activate the subscription, then grant every current manager
 * (commissioner included) the pass's 100 credits through the same idempotent grant a purchase
 * uses. Safe to re-run; a second call changes nothing and grants nothing twice.
 */
export const compLeaguePass = internalAction({
  args: {
    leagueId: v.id("leagues"),
    seasonId: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    subscription: v.object({ changed: v.boolean(), status: v.string(), seasonId: v.number() }),
    credits: v.object({ granted: v.number(), skipped: v.number(), amountPerManager: v.number() }),
  }),
  handler: async (ctx, args) => {
    const subscription = await ctx.runMutation(internal.adminTools.setLeaguePassComped, {
      leagueId: args.leagueId,
      seasonId: args.seasonId,
      reason: args.reason,
    });
    const grant = await ctx.runMutation(internal.credits.grantPassCredits, {
      leagueId: args.leagueId,
      seasonId: subscription.seasonId,
    });
    console.log(
      `[adminTools] comped League Pass for ${args.leagueId}: subscription ${subscription.status} ` +
        `(changed=${subscription.changed}), credits granted to ${grant.granted} manager(s), ${grant.skipped} already had them`
    );
    return {
      subscription,
      credits: { granted: grant.granted, skipped: grant.skipped, amountPerManager: grant.amountPerManager },
    };
  },
});
