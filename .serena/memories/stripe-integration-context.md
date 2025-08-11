# Stripe Integration Context for Fantasy Football App

## Current State Analysis
- **App**: Next.js 15 + TypeScript + Convex + Clerk + Stripe packages already installed
- **Current Flow**: 3-step league setup (Basic Info → ESPN Connection → Settings → Create League)
- **Schema Location**: `convex/schema.ts` - has leagues.subscription object, needs payment tables
- **Setup Page**: `src/app/setup/page.tsx` - current 3-step wizard implementation

## Payment Model Requirements
1. **League Creation**: $99.99 → Commissioner gets 1000 credits + league created
2. **Credit Top-ups**: $9.99 → 100 credits for any user
3. **Joining Bonus**: 100 credits when users join existing league
4. **AI Content**: Costs credits, need balance checking and deduction

## Integration Points Identified
- Add payment step after ESPN validation (between current step 3 and league creation)
- Update database schema for payment tracking
- Create Stripe checkout sessions and webhook handlers
- Integrate credit system with existing AI content generation

## Technical Context
- Using latest Stripe Node SDK with Next.js 15 App Router patterns
- Convex functions for backend logic
- TypeScript throughout with proper type safety
- Existing UI components from shadcn/ui

## Files Needing Updates
- `convex/schema.ts` - Add payment tracking tables
- `src/app/setup/page.tsx` - Add payment step 
- New: Stripe webhook route, payment success/cancel pages
- New: Convex functions for payment processing and credit management