import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import Stripe from "stripe";
import { requireIdentity } from "./lib/auth";

// Initialize Stripe with the secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  typescript: true,
});

// League creation checkout session - $99.99
export const createLeagueCheckoutSession = action({
  args: {
    leagueId: v.string(),
    leagueName: v.string(),
    userEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const userId = identity.subject;

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `Fantasy League: ${args.leagueName}`,
                description: `Full season access for ${new Date().getFullYear()} + 1000 credits`,
                images: [],
              },
              unit_amount: 9999, // $99.99 in cents
            },
            quantity: 1,
          },
        ],
        customer_email: args.userEmail,
        metadata: {
          userId,
          leagueId: args.leagueId,
          leagueName: args.leagueName,
          paymentType: "league_creation",
          amount: "9999", // Amount in cents for webhook processing
          seasonYear: new Date().getFullYear().toString(),
        },
        allow_promotion_codes: true,
        success_url: `${process.env.SITE_URL}/setup/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_URL}/setup/payment-cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
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

// Credits purchase checkout session - $9.99 for 100 credits
export const createCreditsCheckoutSession = action({
  args: {
    userEmail: v.string(),
    creditsAmount: v.number(), // Number of credits to purchase (e.g., 100)
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const userId = identity.subject;

    try {
      const pricePerCredit = 0.0999; // $9.99 for 100 credits = $0.0999 per credit
      const totalAmount = Math.round(args.creditsAmount * pricePerCredit * 100); // Convert to cents

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `${args.creditsAmount} FFSN Credits`,
                description: `Credits for AI-generated fantasy football content`,
              },
              unit_amount: totalAmount,
            },
            quantity: 1,
          },
        ],
        customer_email: args.userEmail,
        metadata: {
          userId,
          paymentType: "credits_purchase",
          amount: totalAmount.toString(), // Amount in cents for webhook processing
          creditsPurchased: args.creditsAmount.toString(),
          leagueId: args.leagueId || "",
        },
        allow_promotion_codes: true,
        success_url: `${process.env.SITE_URL}/dashboard/credits/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_URL}/dashboard/credits`,
        expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
      });

      // Payment record will be created when webhook fires with actual payment intent ID

      return {
        success: true,
        sessionId: session.id,
        url: session.url,
      };
    } catch (error) {
      console.error("Error creating credits checkout session:", error);
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
    // Only the metadata WE set at checkout-session creation (userId/leagueId/
    // creditsPurchased/paymentType) is exposed, none of Stripe's own fields.
    metadata: Record<string, string>;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const session = await stripe.checkout.sessions.retrieve(args.sessionId, {
      expand: ["payment_intent"],
    });

    // Both checkout-session creators (createLeagueCheckoutSession and
    // createCreditsCheckoutSession) set metadata.userId to the Clerk user id
    // of the purchaser - use that as the ownership check.
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

// Internal mutation to process successful checkout session
export const processCheckoutSessionCompleted = internalMutation({
  args: {
    sessionId: v.string(),
    paymentIntentId: v.string(),
    paymentStatus: v.string(),
    metadata: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const isPaid = args.paymentStatus === "paid";

    // Check if payment record exists
    let payment = await ctx.db
      .query("stripePayments")
      .withIndex("by_payment_intent", (q) => q.eq("paymentIntentId", args.paymentIntentId))
      .first();

    if (!payment) {
      // Create the payment record now that we have the payment intent ID
      console.log(`Creating payment record for payment intent: ${args.paymentIntentId}`);

      // Extract necessary data from metadata
      const amount = parseInt(args.metadata.amount || "0");
      const userId = args.metadata.userId;
      const paymentType = args.metadata.paymentType as "league_creation" | "credits_purchase";

      // Build description based on payment type
      let description = "";
      if (paymentType === "league_creation") {
        description = `League creation payment for ${args.metadata.leagueName}`;
      } else if (paymentType === "credits_purchase") {
        description = `Purchase of ${args.metadata.creditsPurchased} credits`;
      }

      // Build metadata object
      const paymentMetadata: any = {};
      if (paymentType === "league_creation") {
        paymentMetadata.seasonYear = parseInt(args.metadata.seasonYear);
        paymentMetadata.isCommissionerPayment = true;
      } else if (paymentType === "credits_purchase") {
        paymentMetadata.creditsPurchased = parseInt(args.metadata.creditsPurchased);
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
      // already reports the session as paid: processLeaguePayment /
      // processCreditsPurchase are the ones that flip it to "succeeded",
      // atomically with granting credits, so their idempotency guard can
      // tell "recorded" apart from "actually fulfilled".
      const paymentId = await ctx.db.insert("stripePayments", {
        paymentIntentId: args.paymentIntentId,
        checkoutSessionId: args.sessionId,
        amount: amount,
        currency: "usd",
        status: "pending",
        userId: userId,
        leagueId: args.metadata.leagueId ? (args.metadata.leagueId as any) : undefined,
        paymentType: paymentType,
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
      // happens atomically with the credit/league grant below.
      await ctx.db.patch(payment._id, {
        status: isPaid ? payment.status : "pending",
        webhookProcessed: true,
        webhookProcessedAt: now,
        updatedAt: now,
        paidAt: isPaid ? (payment.paidAt ?? now) : payment.paidAt,
      });
      payment = await ctx.db.get(payment._id);
    }

    // Only fulfill (grant credits / league access) once Stripe actually
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

    // Process based on payment type
    if (args.metadata.paymentType === "league_creation") {
      await ctx.runMutation(internal.payments.processLeaguePayment, {
        paymentId: payment._id,
        sessionMetadata: args.metadata,
      });
    } else if (args.metadata.paymentType === "credits_purchase") {
      await ctx.runMutation(internal.payments.processCreditsPurchase, {
        paymentId: payment._id,
        sessionMetadata: args.metadata,
      });
    }
  },
});

// Internal mutation to process successful payment intent
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
      status: "succeeded",
      webhookProcessed: true,
      webhookProcessedAt: now,
      updatedAt: now,
      paidAt: now,
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