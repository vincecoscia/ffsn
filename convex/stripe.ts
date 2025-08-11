import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import Stripe from "stripe";

// Initialize Stripe with the secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-06-30.basil",
  typescript: true,
});

// League creation checkout session - $99.99
export const createLeagueCheckoutSession = action({
  args: {
    leagueId: v.string(),
    leagueName: v.string(),
    userEmail: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
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
          userId: args.userId,
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
    userId: v.string(),
    userEmail: v.string(),
    creditsAmount: v.number(), // Number of credits to purchase (e.g., 100)
    leagueId: v.optional(v.id("leagues")),
  },
  handler: async (ctx, args) => {
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
          userId: args.userId,
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

// Verify payment completion by session ID
export const verifyPaymentCompleted = action({
  args: {
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const session = await stripe.checkout.sessions.retrieve(args.sessionId, {
        expand: ["payment_intent"],
      });

      const paymentIntent = session.payment_intent as Stripe.PaymentIntent;

      // Ensure we persist and process the payment even if webhook isn’t received
      if (paymentIntent?.id) {
        await ctx.runMutation(internal.stripe.processCheckoutSessionCompleted, {
          sessionId: session.id,
          paymentIntentId: paymentIntent.id,
          paymentStatus: session.payment_status,
          metadata: session.metadata || {},
        });
      }

      return {
        success: true,
        session: {
          id: session.id,
          paymentStatus: session.payment_status,
          customerEmail: session.customer_email,
          metadata: session.metadata,
          paymentIntentId: paymentIntent?.id,
          paymentIntentStatus: paymentIntent?.status,
        },
      };
    } catch (error) {
      console.error("Error verifying payment:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to verify payment",
      };
    }
  },
});

// Handle Stripe webhook events
export const handleStripeWebhook = action({
  args: {
    body: v.string(),
    signature: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        throw new Error("Missing STRIPE_WEBHOOK_SECRET environment variable");
      }

      // Verify webhook signature
      const event = stripe.webhooks.constructEvent(
        args.body,
        args.signature,
        webhookSecret
      );

      console.log(`Processing Stripe webhook: ${event.type}`);

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

      return { success: true, processed: event.type };
    } catch (error) {
      console.error("Webhook processing error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Webhook processing failed",
      };
    }
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
      
      // Create the payment record
      const paymentId = await ctx.db.insert("stripePayments", {
        paymentIntentId: args.paymentIntentId,
        checkoutSessionId: args.sessionId,
        amount: amount,
        currency: "usd",
        status: args.paymentStatus === "paid" ? "succeeded" : "pending",
        userId: userId,
        leagueId: args.metadata.leagueId ? (args.metadata.leagueId as any) : undefined,
        paymentType: paymentType,
        description: description,
        metadata: paymentMetadata,
        webhookProcessed: true,
        webhookProcessedAt: now,
        createdAt: now,
        updatedAt: now,
        paidAt: args.paymentStatus === "paid" ? now : undefined,
      });
      
      payment = await ctx.db.get(paymentId);
    } else {
      // Update existing payment record
      await ctx.db.patch(payment._id, {
        status: args.paymentStatus === "paid" ? "succeeded" : "pending",
        webhookProcessed: true,
        webhookProcessedAt: now,
        updatedAt: now,
        paidAt: args.paymentStatus === "paid" ? now : undefined,
      });
    }

    // Process based on payment type
    if (payment && args.metadata.paymentType === "league_creation") {
      await ctx.runMutation(internal.payments.processLeaguePayment, {
        paymentId: payment._id,
        sessionMetadata: args.metadata,
      });
    } else if (payment && args.metadata.paymentType === "credits_purchase") {
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