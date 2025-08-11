import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";

// Initialize Convex client
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// Disable body parsing so we can access the raw body
export const config = {
  api: {
    bodyParser: false,
  },
};

// Handle POST requests from Stripe webhooks
export async function POST(req: NextRequest) {
  try {
    // Get the raw body as text
    const body = await req.text();
    
    // Get Stripe signature from headers
    const signature = req.headers.get("stripe-signature");
    
    if (!signature) {
      console.error("Missing Stripe signature header");
      return NextResponse.json(
        { error: "Missing signature" },
        { status: 400 }
      );
    }

    if (!body) {
      console.error("Missing request body");
      return NextResponse.json(
        { error: "Missing body" },
        { status: 400 }
      );
    }

    // Process webhook through Convex action
    const result = await convex.action(api.stripe.handleStripeWebhook, {
      body,
      signature,
    });

    if (!result.success) {
      console.error("Webhook processing failed:", result.error);
      return NextResponse.json(
        { error: result.error || "Webhook processing failed" },
        { status: 400 }
      );
    }

    console.log(`Successfully processed webhook: ${result.processed}`);
    
    // Return success response
    return NextResponse.json({ 
      received: true, 
      processed: result.processed 
    });

  } catch (error) {
    console.error("Webhook handler error:", error);
    
    return NextResponse.json(
      { 
        error: "Webhook handler failed",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}

// Handle GET requests (for webhook endpoint verification)
export async function GET() {
  return NextResponse.json({
    message: "Stripe webhook endpoint is active",
    timestamp: new Date().toISOString(),
  });
}