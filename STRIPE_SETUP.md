# Stripe Payment Integration Setup

## Overview

This application includes a comprehensive Stripe payment integration for:
- **League Creation**: $99.99 one-time payment for full season access + 1000 credits
- **Credit Purchases**: $9.99 for 100 credits (additional packages available)
- **Credit System**: AI content generation costs credits, users can purchase more

## Environment Variables

Copy `.env.example` to `.env.local` and configure:

```bash
# Stripe Keys (get from Stripe Dashboard)
STRIPE_SECRET_KEY=sk_test_...                    # Test key, use sk_live_... for production
STRIPE_PUBLISHABLE_KEY=pk_test_...               # Test key, use pk_live_... for production  
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...   # Same as STRIPE_PUBLISHABLE_KEY
STRIPE_WEBHOOK_SECRET=whsec_...                  # From webhook endpoint configuration

# Application URL
SITE_URL=http://localhost:3000                   # Your app URL (production URL in prod)
```

## Stripe Dashboard Setup

### 1. Create Stripe Account
- Go to [stripe.com](https://stripe.com) and create account
- Get API keys from Dashboard → Developers → API keys

### 2. Configure Webhook Endpoint
- Go to Dashboard → Developers → Webhooks
- Add endpoint: `{SITE_URL}/api/stripe/webhook`
- Select events to send:
  - `checkout.session.completed`
  - `payment_intent.succeeded` 
  - `payment_intent.payment_failed`
- Copy webhook signing secret to `STRIPE_WEBHOOK_SECRET`

### 3. Test Configuration
Use Stripe CLI for local testing:
```bash
# Install Stripe CLI
npm install -g stripe-cli

# Login to your Stripe account
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

## Database Schema

The integration adds these tables to your Convex schema:

- **`stripePayments`** - All Stripe transactions with webhook tracking
- **`creditTransactions`** - Audit trail of all credit movements  
- **`leaguePayments`** - Season-based payment records for leagues
- **`userCredits`** - Current credit balances and lifetime stats

## Payment Flow

### League Creation Payment ($99.99)
1. User completes ESPN validation in setup flow
2. Payment step shows $99.99 checkout with features
3. Redirects to Stripe Checkout with league metadata
4. On success: Creates league + grants 1000 credits + syncs ESPN data
5. On cancel: Returns to setup with option to retry

### Credit Purchases ($9.99+ packages)
1. User visits `/dashboard/credits`
2. Selects credit package (100, 250, or 500 credits)
3. Redirects to Stripe Checkout
4. On success: Credits added to user balance
5. Credit history tracks all transactions

## Credit System

### Content Costs
- Weekly Recap: 15 credits
- Trade Analysis: 20 credits  
- Power Rankings: 18 credits
- Custom Roast: 8 credits
- (Costs calculated dynamically based on content type/length)

### Credit Flow
- **Commissioner**: Gets 1000 credits when creating paid league
- **Members**: Get 100 credits when joining existing league  
- **Purchases**: Users can buy additional credits anytime
- **Usage**: Credits deducted before AI content generation

## API Routes

### `/api/stripe/webhook`
- Handles all Stripe webhook events
- Verifies webhook signatures for security
- Processes payments and updates database
- Returns proper HTTP responses for Stripe

## Convex Functions

### `stripe.ts`
- `createLeagueCheckoutSession` - Create $99.99 checkout
- `createCreditsCheckoutSession` - Create credit purchase checkout  
- `verifyPaymentCompleted` - Verify payment by session ID
- `handleStripeWebhook` - Process webhook events

### `payments.ts` 
- `processLeaguePayment` - Handle league creation payment completion
- `processCreditsPurchase` - Handle credit purchase completion
- `getUserPaymentHistory` - Get user's payment history
- `getLeaguePaymentStatus` - Check if league payment completed

### `credits.ts`
- `grantCredits` - Add credits to user (internal)
- `deductCredits` - Remove credits for content generation
- `getUserCredits` - Get current balance and stats
- `getCreditHistory` - Get transaction history
- `checkSufficientCredits` - Validate before content generation

## Testing

### Test Cards (Stripe Test Mode)
```
Success: 4242424242424242
Declined: 4000000000000002
Requires 3D Secure: 4000002760003184
```

### Local Testing Workflow
1. Use Stripe CLI to forward webhooks: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
2. Copy webhook secret from CLI output to `.env.local`
3. Test league creation with test card numbers
4. Test credit purchases with different amounts
5. Verify webhooks process correctly in Convex dashboard

### Production Checklist
- [ ] Switch to live Stripe keys (`sk_live_`, `pk_live_`)
- [ ] Configure production webhook endpoint URL
- [ ] Update `SITE_URL` to production domain
- [ ] Test webhook delivery in production
- [ ] Monitor payment processing and error handling

## Security Features

- ✅ Webhook signature verification using Stripe's `constructEvent`
- ✅ Idempotency for webhook processing
- ✅ PCI compliance (no card data stored)
- ✅ Environment variable separation
- ✅ Proper error handling and logging
- ✅ Payment intent tracking and reconciliation

## Monitoring & Support

### Key Metrics to Monitor
- Payment success/failure rates
- Webhook delivery success
- Credit balance trends
- Revenue by payment type (leagues vs credits)

### Troubleshooting
- Check Convex logs for webhook processing errors
- Monitor Stripe Dashboard for failed payments
- Use Stripe CLI events for testing webhook flows
- Check environment variables if webhooks fail

### Support Contacts
- **Stripe Issues**: Stripe Dashboard → Support
- **Implementation Issues**: Check Convex logs and webhook delivery status
- **User Payment Problems**: Verify in Stripe Dashboard → Payments