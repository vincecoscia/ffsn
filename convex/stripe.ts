import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import Stripe from "stripe";
import { requireIdentity, requireLeagueMemberFromAction } from "./lib/auth";

// Initialize Stripe with the secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  typescript: true,
});

/**
 * The offer (spec §10.1). Three one-time USD purchases, no subscriptions:
 *
 *   league_pass   $100.00  every automated story for the season + 100 credits
 *                          for every manager, up to 12 managers
 *   extra_seat     $10.00  one manager beyond the included 12, including that
 *                          manager's 100 credits. Bought by the commissioner,
 *                          quantity >= 1.
 *   credit_topup    $5.00  100 credits for the manager who buys it. Any
 *                          signed-in manager, for themselves only.
 *
 * Prices are inline `price_data` by default - the pattern this integration has
 * always used, so nothing has to be provisioned in Stripe before a deploy.
 * Setting the matching Convex env var to a Stripe Price id switches that line
 * item to a real catalog Product instead; the charged amount is then read back
 * off the completed session (`amount_total`) rather than assumed here, so a
 * catalog price change never desyncs from the stored payment record.
 */
export const PURCHASE_CATALOG = {
  league_pass: {
    envPriceId: "STRIPE_PRICE_LEAGUE_PASS",
    unitAmount: 10000,
    maxQuantity: 1,
    name: "FFSN League Pass",
  },
  extra_seat: {
    envPriceId: "STRIPE_PRICE_EXTRA_SEAT",
    unitAmount: 1000,
    maxQuantity: 8,
    name: "Extra manager seat",
  },
  credit_topup: {
    envPriceId: "STRIPE_PRICE_CREDIT_TOPUP",
    unitAmount: 500,
    maxQuantity: 20,
    name: "100 FFSN credits",
  },
} as const;

export type PurchaseKind = keyof typeof PURCHASE_CATALOG;

/** Managers covered by the pass before a seat has to be bought (spec §10.1). */
export const INCLUDED_MANAGERS = 12;
/** Credits granted to a manager by the pass, by a seat, and by one top-up. */
export const CREDITS_PER_MANAGER = 100;

const CHECKOUT_TTL_SECONDS = 1800; // 30 minutes

function siteUrl(): string {
  return process.env.SITE_URL ?? "";
}

/**
 * Clamp a client-supplied quantity into the catalog's range. Quantity reaches
 * Stripe and (via metadata) the fulfillment path, so it is never trusted raw.
 */
function clampQuantity(kind: PurchaseKind, quantity: number | undefined): number {
  const max = PURCHASE_CATALOG[kind].maxQuantity;
  const parsed = Math.floor(Number(quantity ?? 1));
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(parsed, 1), max);
}

/**
 * Only same-origin relative paths are allowed back from Checkout - a raw
 * client string here would otherwise be an open redirect off `SITE_URL`.
 */
function safeReturnPath(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return fallback;
  return path;
}

function withQuery(path: string, params: Record<string, string>): string {
  const [base, existing] = path.split("?", 2);
  const search = new URLSearchParams(existing ?? "");
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  // Stripe substitutes {CHECKOUT_SESSION_ID} literally, so it must survive
  // un-encoded in the final URL.
  return `${siteUrl()}${base}?${search.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}")}`;
}

function buildLineItem(
  kind: PurchaseKind,
  quantity: number,
  productName: string,
  description: string
): Stripe.Checkout.SessionCreateParams.LineItem {
  const entry = PURCHASE_CATALOG[kind];
  const configuredPriceId = process.env[entry.envPriceId];
  if (configuredPriceId) {
    return { price: configuredPriceId, quantity };
  }
  return {
    price_data: {
      currency: "usd",
      product_data: { name: productName, description },
      unit_amount: entry.unitAmount,
    },
    quantity,
  };
}

/** Cents we expect to collect when the line item is inline `price_data`. */
function expectedAmount(kind: PurchaseKind, quantity: number): number {
  return PURCHASE_CATALOG[kind].unitAmount * quantity;
}

// League Pass checkout session - $100.00 for the season (spec §10.1).
export const createLeagueCheckoutSession = action({
  args: {
    leagueId: v.string(),
    leagueName: v.string(),
    userEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const userId = identity.subject;
    const seasonYear = new Date().getFullYear();

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          buildLineItem(
            "league_pass",
            1,
            `FFSN League Pass: ${args.leagueName}`,
            `Every automated story for the ${seasonYear} season, plus ${CREDITS_PER_MANAGER} credits for every manager (up to ${INCLUDED_MANAGERS}).`
          ),
        ],
        customer_email: identity.email ?? args.userEmail,
        metadata: {
          kind: "league_pass",
          userId,
          leagueId: args.leagueId,
          leagueName: args.leagueName,
          quantity: "1",
          // Legacy key kept so sessions created by either version of this file
          // fulfill the same way while a deploy rolls out.
          paymentType: "league_creation",
          amount: expectedAmount("league_pass", 1).toString(),
          seasonYear: seasonYear.toString(),
        },
        allow_promotion_codes: true,
        success_url: `${siteUrl()}/setup/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl()}/setup/payment-cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS,
      });

      // Payment record will be created when webhook fires with actual payment intent ID

      return {
        success: true,
        sessionId: session.id,
        url: session.url,
      };
    } catch (error) {
      console.error("Error creating league checkout session:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create checkout session",
      };
    }
  },
});

// Extra manager seat checkout - $10.00 each, commissioner only (spec §10.1).
// `seatUserId` is the manager the seat is being bought for, when the
// commissioner already knows who is joining; the webhook grants that manager
// their 100 credits. Buying seats ahead of time (no `seatUserId`) just raises
// the league's capacity.
export const createExtraSeatCheckoutSession = action({
  args: {
    leagueId: v.id("leagues"),
    quantity: v.optional(v.number()),
    seatUserId: v.optional(v.string()),
    returnPath: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Seats change what a league is allowed to do, so only its commissioner
    // may buy them.
    const { identity } = await requireLeagueMemberFromAction(ctx, args.leagueId, {
      commissioner: true,
    });
    const quantity = clampQuantity("extra_seat", args.quantity);
    const returnPath = safeReturnPath(args.returnPath, `/leagues/${args.leagueId}/settings`);

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          buildLineItem(
            "extra_seat",
            quantity,
            "FFSN extra manager seat",
            `One manager beyond the ${INCLUDED_MANAGERS} included by the League Pass, with ${CREDITS_PER_MANAGER} credits for that manager.`
          ),
        ],
        customer_email: identity.email,
        metadata: {
          kind: "extra_seat",
          userId: identity.subject,
          leagueId: args.leagueId,
          quantity: quantity.toString(),
          seatUserId: args.seatUserId ?? "",
          amount: expectedAmount("extra_seat", quantity).toString(),
          seasonYear: new Date().getFullYear().toString(),
        },
        allow_promotion_codes: true,
        success_url: withQuery(returnPath, {
          seat: "success",
          session_id: "{CHECKOUT_SESSION_ID}",
        }),
        cancel_url: withQuery(returnPath, { seat: "cancelled" }),
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS,
      });

      return {
        success: true,
        sessionId: session.id,
        url: session.url,
        quantity,
      };
    } catch (error) {
      console.error("Error creating extra seat checkout session:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create checkout session",
      };
    }
  },
});

// Credit top-up checkout - $5.00 for 100 credits (spec §10.1). Any signed-in
// manager, always for themselves: the credited user is the authenticated
// identity, never a client-supplied id.
export const createCreditTopUpSession = action({
  args: {
    quantity: v.optional(v.number()),
    returnPath: v.optional(v.string()),
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const quantity = clampQuantity("credit_topup", args.quantity);
    const credits = CREDITS_PER_MANAGER * quantity;
    const returnPath = safeReturnPath(args.returnPath, "/dashboard/credits");

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          buildLineItem(
            "credit_topup",
            quantity,
            `${CREDITS_PER_MANAGER} FFSN credits`,
            "Credits for stories you generate yourself. Automated stories are covered by the League Pass."
          ),
        ],
        customer_email: identity.email,
        metadata: {
          kind: "credit_topup",
          userId: identity.subject,
          quantity: quantity.toString(),
          credits: credits.toString(),
          leagueId: args.leagueId ?? "",
          // Legacy key, see createLeagueCheckoutSession.
          paymentType: "credits_purchase",
          creditsPurchased: credits.toString(),
          amount: expectedAmount("credit_topup", quantity).toString(),
        },
        allow_promotion_codes: true,
        success_url: withQuery(returnPath, {
          topup: "success",
          session_id: "{CHECKOUT_SESSION_ID}",
        }),
        cancel_url: withQuery(returnPath, { topup: "cancelled" }),
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS,
      });

      return {
        success: true,
        sessionId: session.id,
        url: session.url,
        credits,
      };
    } catch (error) {
      console.error("Error creating credit top-up checkout session:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create checkout session",
      };
    }
  },
});

// Verify payment completion by session ID. Requires auth and checks that the
// checkout session belongs to the caller before triggering (idempotent)
// fulfillment - this used to be an unauthenticated free-credits endpoint.
export const verifyPaymentCompleted = action({
  args: {
    sessionId: v.string(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    status: string;
    fulfilled: boolean;
    // Only the metadata WE set at checkout-session creation (kind/userId/
    // leagueId/quantity) is exposed, none of Stripe's own fields.
    metadata: Record<string, string>;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const session = await stripe.checkout.sessions.retrieve(args.sessionId, {
      expand: ["payment_intent"],
    });

    // Every checkout-session creator above sets metadata.userId to the Clerk
    // user id of the purchaser - use that as the ownership check.
    if (session.metadata?.userId !== identity.subject) {
      throw new Error("This checkout session does not belong to the current user");
    }

    const paymentIntent = session.payment_intent as Stripe.PaymentIntent | null;

    // processCheckoutSessionCompleted is idempotent (paid gate + already-
    // fulfilled guard), so it's safe to call here even if the webhook has
    // already processed (or will process) this same session.
    if (paymentIntent?.id) {
      await ctx.runMutation(internal.stripe.processCheckoutSessionCompleted, {
        sessionId: session.id,
        paymentIntentId: paymentIntent.id,
        paymentStatus: session.payment_status,
        amountTotal: session.amount_total ?? undefined,
        metadata: session.metadata || {},
      });
    }

    const fulfilled = session.payment_status === "paid" && !!paymentIntent?.id;

    return {
      status: session.payment_status,
      fulfilled,
      metadata: session.metadata || {},
    };
  },
});

// Handle Stripe webhook events
export const handleStripeWebhook = action({
  args: {
    body: v.string(),
    signature: v.string(),
  },
  handler: async (ctx, args) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error("Missing STRIPE_WEBHOOK_SECRET environment variable");
    }

    // Verify webhook signature. A bad signature can never be "retried into
    // success", so this is reported back as a failure response rather than
    // thrown (which would surface as a 500 and cause Stripe to keep retrying).
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(args.body, args.signature, webhookSecret);
    } catch (error) {
      console.error("Stripe webhook signature verification failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Invalid webhook signature",
      };
    }

    console.log(`Stripe webhook: ${event.type} ${event.id}`);

    // Idempotency: claim this event id before doing any work. Stripe retries
    // webhook deliveries (e.g. on timeout or a non-2xx response), and without
    // this guard a retry would re-run fulfillment for the same event.
    const claim = await ctx.runMutation(internal.stripe.claimWebhookEvent, {
      eventId: event.id,
      type: event.type,
    });

    if (!claim.claimed && (claim.status === "processed" || claim.status === "processing")) {
      console.log(`Stripe webhook ${event.id} is a duplicate (status=${claim.status}); skipping dispatch`);
      return { received: true, duplicate: true };
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          await ctx.runMutation(internal.stripe.processCheckoutSessionCompleted, {
            sessionId: session.id,
            paymentIntentId: session.payment_intent as string,
            paymentStatus: session.payment_status,
            // What Stripe actually collected, after any promotion code. Trusted
            // over the amount we predicted in metadata.
            amountTotal: session.amount_total ?? undefined,
            metadata: session.metadata || {},
          });
          break;
        }

        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          await ctx.runMutation(internal.stripe.processPaymentIntentSucceeded, {
            paymentIntentId: paymentIntent.id,
            amountReceived: paymentIntent.amount_received,
            metadata: paymentIntent.metadata || {},
          });
          break;
        }

        case "payment_intent.payment_failed": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          await ctx.runMutation(internal.stripe.processPaymentIntentFailed, {
            paymentIntentId: paymentIntent.id,
            metadata: paymentIntent.metadata || {},
          });
          break;
        }

        default:
          console.log(`Unhandled webhook event type: ${event.type}`);
      }

      await ctx.runMutation(internal.stripe.resolveWebhookEvent, {
        eventId: event.id,
        status: "processed",
      });

      return { success: true, processed: event.type };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook processing failed";
      console.error("Webhook processing error:", error);

      await ctx.runMutation(internal.stripe.resolveWebhookEvent, {
        eventId: event.id,
        status: "failed",
        error: message,
      });

      // Rethrow so the HTTP route returns a non-2xx and Stripe retries -
      // claimWebhookEvent allows a "failed" event to be re-claimed and
      // reprocessed on the next delivery attempt.
      throw error;
    }
  },
});

// Claim a Stripe webhook event for processing. Inserts a "processing" row if
// this event id hasn't been seen before (claimed: true). If the event was
// already seen and is "processed" or currently "processing", the caller
// should treat this as a duplicate delivery and skip dispatch entirely. If
// the prior attempt "failed", it is re-claimed here so a Stripe retry can
// actually reprocess it.
export const claimWebhookEvent = internalMutation({
  args: {
    eventId: v.string(),
    type: v.string(),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ claimed: boolean; status: "processing" | "processed" | "failed" }> => {
    const existing = await ctx.db
      .query("stripeWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .first();

    if (!existing) {
      await ctx.db.insert("stripeWebhookEvents", {
        eventId: args.eventId,
        type: args.type,
        receivedAt: Date.now(),
        status: "processing",
      });
      return { claimed: true, status: "processing" };
    }

    if (existing.status === "processed" || existing.status === "processing") {
      return { claimed: false, status: existing.status };
    }

    // Previously failed - allow this delivery to retry it.
    await ctx.db.patch(existing._id, {
      status: "processing",
      error: undefined,
    });
    return { claimed: true, status: "processing" };
  },
});

// Mark a claimed webhook event as processed or failed.
export const resolveWebhookEvent = internalMutation({
  args: {
    eventId: v.string(),
    status: v.union(v.literal("processed"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("stripeWebhookEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .first();

    if (!existing) {
      console.error(`resolveWebhookEvent: no row found for event ${args.eventId}`);
      return;
    }

    await ctx.db.patch(existing._id, {
      status: args.status,
      error: args.error,
    });
  },
});

// Internal mutation to create payment records
export const createPaymentRecord = internalMutation({
  args: {
    paymentIntentId: v.string(),
    checkoutSessionId: v.optional(v.string()),
    amount: v.number(),
    currency: v.string(),
    status: v.union(v.literal("pending"), v.literal("succeeded"), v.literal("failed")),
    userId: v.string(),
    leagueId: v.optional(v.id("leagues")),
    paymentType: v.union(v.literal("league_creation"), v.literal("credits_purchase")),
    description: v.string(),
    metadata: v.optional(v.object({
      seasonYear: v.optional(v.number()),
      creditsPurchased: v.optional(v.number()),
      isCommissionerPayment: v.optional(v.boolean()),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    return await ctx.db.insert("stripePayments", {
      paymentIntentId: args.paymentIntentId,
      checkoutSessionId: args.checkoutSessionId,
      amount: args.amount,
      currency: args.currency,
      status: args.status,
      userId: args.userId,
      leagueId: args.leagueId,
      paymentType: args.paymentType,
      description: args.description,
      metadata: args.metadata,
      webhookProcessed: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * What this session was buying. New sessions carry `kind`; sessions created
 * before the Broadcast Desk pricing shipped only carry `paymentType`, and are
 * mapped onto the equivalent kind so an in-flight checkout still fulfills.
 */
function resolvePurchaseKind(metadata: Record<string, string>): PurchaseKind | null {
  const kind = metadata.kind;
  if (kind === "league_pass" || kind === "extra_seat" || kind === "credit_topup") {
    return kind;
  }
  if (metadata.paymentType === "league_creation") return "league_pass";
  if (metadata.paymentType === "credits_purchase") return "credit_topup";
  return null;
}

/**
 * `stripePayments.paymentType` is a two-value union owned by PRICE-B's schema,
 * so seats are stored alongside the pass as a league-level purchase. The
 * authoritative discriminator for fulfillment is the session's `kind`, which is
 * passed through to the processing mutations below.
 */
function storedPaymentType(kind: PurchaseKind): "league_creation" | "credits_purchase" {
  return kind === "credit_topup" ? "credits_purchase" : "league_creation";
}

// Internal mutation to process successful checkout session
export const processCheckoutSessionCompleted = internalMutation({
  args: {
    sessionId: v.string(),
    paymentIntentId: v.string(),
    paymentStatus: v.string(),
    amountTotal: v.optional(v.number()),
    metadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const isPaid = args.paymentStatus === "paid";

    const kind = resolvePurchaseKind(args.metadata);
    if (!kind) {
      console.error(
        `Checkout session ${args.sessionId} has no recognizable purchase kind; skipping`
      );
      return;
    }

    const quantity = clampQuantity(kind, Number(args.metadata.quantity || "1"));

    // Check if payment record exists
    let payment = await ctx.db
      .query("stripePayments")
      .withIndex("by_payment_intent", (q) => q.eq("paymentIntentId", args.paymentIntentId))
      .first();

    if (!payment) {
      // Create the payment record now that we have the payment intent ID
      console.log(`Creating payment record for payment intent: ${args.paymentIntentId}`);

      // Prefer what Stripe says it collected (promotion codes, catalog price
      // changes) over the amount predicted when the session was created.
      const amount =
        args.amountTotal ??
        (parseInt(args.metadata.amount || "0") || expectedAmount(kind, quantity));
      const userId = args.metadata.userId;
      const seasonYear =
        parseInt(args.metadata.seasonYear || "") || new Date().getFullYear();

      // Build description and metadata based on what was bought.
      let description = "";
      const paymentMetadata: {
        seasonYear?: number;
        creditsPurchased?: number;
        isCommissionerPayment?: boolean;
        appliedCouponId?: string;
        appliedPromotionCodeId?: string;
        discountAmount?: number;
      } = {};

      if (kind === "league_pass") {
        description = `League Pass for ${args.metadata.leagueName || "league"} (${seasonYear} season)`;
        paymentMetadata.seasonYear = seasonYear;
        paymentMetadata.isCommissionerPayment = true;
      } else if (kind === "extra_seat") {
        description = `${quantity} extra manager seat${quantity === 1 ? "" : "s"}`;
        paymentMetadata.seasonYear = seasonYear;
        paymentMetadata.isCommissionerPayment = true;
      } else {
        const credits = CREDITS_PER_MANAGER * quantity;
        description = `Credit top-up - ${credits} credits`;
        paymentMetadata.creditsPurchased = credits;
      }

      // Capture discounts metadata if present
      if (args.metadata.appliedCouponId) {
        paymentMetadata.appliedCouponId = args.metadata.appliedCouponId;
      }
      if (args.metadata.appliedPromotionCodeId) {
        paymentMetadata.appliedPromotionCodeId = args.metadata.appliedPromotionCodeId;
      }
      if (args.metadata.discountAmount) {
        const parsed = parseInt(args.metadata.discountAmount);
        if (!Number.isNaN(parsed)) paymentMetadata.discountAmount = parsed;
      }

      // Create the payment record. Status starts "pending" even when Stripe
      // already reports the session as paid: the processors below are the ones
      // that flip it to "succeeded", atomically with recording the seat /
      // granting the credits, so their idempotency guards can tell "recorded"
      // apart from "actually fulfilled".
      const paymentId = await ctx.db.insert("stripePayments", {
        paymentIntentId: args.paymentIntentId,
        checkoutSessionId: args.sessionId,
        amount: amount,
        currency: "usd",
        status: "pending",
        userId: userId,
        leagueId: args.metadata.leagueId
          ? (args.metadata.leagueId as Id<"leagues">)
          : undefined,
        paymentType: storedPaymentType(kind),
        description: description,
        metadata: paymentMetadata,
        webhookProcessed: true,
        webhookProcessedAt: now,
        createdAt: now,
        updatedAt: now,
        paidAt: isPaid ? now : undefined,
      });

      payment = await ctx.db.get(paymentId);
    } else {
      // Update existing payment record. Only downgrade to "pending" here if
      // Stripe now reports the session as not paid; never overwrite an
      // already-"succeeded" status, and never set "succeeded" here - that
      // happens atomically with the credit/seat/league grant below.
      await ctx.db.patch(payment._id, {
        status: isPaid ? payment.status : "pending",
        webhookProcessed: true,
        webhookProcessedAt: now,
        updatedAt: now,
        paidAt: isPaid ? (payment.paidAt ?? now) : payment.paidAt,
      });
      payment = await ctx.db.get(payment._id);
    }

    // Only fulfill (grant credits / league access / seats) once Stripe actually
    // reports this session as paid. Anything else (unpaid, expired, etc.)
    // just records status above and stops here - no grant, no dispatch.
    if (!isPaid) {
      console.log(`Checkout session ${args.sessionId} payment_status=${args.paymentStatus}; skipping fulfillment`);
      return;
    }

    if (!payment) {
      console.error(`Payment record missing after upsert for payment intent ${args.paymentIntentId}`);
      return;
    }

    // Fulfillment is dispatched on the session's `kind` (spec §10.1):
    //   league_pass  -> activate the pass, 12 included managers, pass credits
    //   extra_seat   -> +N seats on the league, and that manager's credits
    //   credit_topup -> 100 credits per unit to the buyer
    if (kind === "league_pass") {
      await ctx.runMutation(internal.payments.processLeaguePayment, {
        paymentId: payment._id,
        sessionMetadata: args.metadata,
      });
    } else if (kind === "extra_seat") {
      await ctx.runMutation(internal.payments.processExtraSeatPurchase, {
        paymentId: payment._id,
        sessionMetadata: args.metadata,
      });
    } else {
      await ctx.runMutation(internal.payments.processCreditsPurchase, {
        paymentId: payment._id,
        sessionMetadata: args.metadata,
      });
    }
  },
});

// Internal mutation to process successful payment intent.
//
// Deliberately does NOT flip status to "succeeded": that transition belongs to
// the fulfillment mutations, which set it in the same transaction as the grant
// they perform, and which use it as their idempotency guard. Marking a payment
// succeeded from here would let an unfulfilled record look fulfilled if this
// event were delivered before (or instead of) checkout.session.completed. Use
// `reconcilePayment` for manual repair.
export const processPaymentIntentSucceeded = internalMutation({
  args: {
    paymentIntentId: v.string(),
    amountReceived: v.number(),
    metadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db
      .query("stripePayments")
      .withIndex("by_payment_intent", (q) => q.eq("paymentIntentId", args.paymentIntentId))
      .first();

    if (!payment) {
      console.error(`Payment record not found for payment intent: ${args.paymentIntentId}`);
      return;
    }

    const now = Date.now();
    await ctx.db.patch(payment._id, {
      webhookProcessed: true,
      webhookProcessedAt: now,
      updatedAt: now,
      paidAt: payment.paidAt ?? now,
    });
  },
});

// Internal mutation to process failed payment intent
export const processPaymentIntentFailed = internalMutation({
  args: {
    paymentIntentId: v.string(),
    metadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const payment = await ctx.db
      .query("stripePayments")
      .withIndex("by_payment_intent", (q) => q.eq("paymentIntentId", args.paymentIntentId))
      .first();

    if (!payment) {
      console.error(`Payment record not found for payment intent: ${args.paymentIntentId}`);
      return;
    }

    await ctx.db.patch(payment._id, {
      status: "failed",
      webhookProcessed: true,
      webhookProcessedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});
