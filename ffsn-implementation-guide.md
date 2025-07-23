# FFSN - Fantasy Football Sports Network
## Complete Implementation Guide

## 🎯 Project Vision

FFSN is a SaaS platform that makes fantasy football leagues feel more "alive" through AI-generated sports content. Commissioners sign up their entire league, connect via ESPN/Yahoo/Sleeper APIs, and the platform generates personalized, entertaining articles about their league using AI writer personas.

### Core Value Propositions:
1. **AI-Generated Content**: Automated weekly recaps, trade analysis, and power rankings written by distinct AI personalities
2. **League-Wide Engagement**: Content that mentions real teams, players, and events from YOUR league
3. **Commissioner-Centric Model**: One subscription covers the entire league
4. **ESPN-Quality Interface**: Professional sports media aesthetic

## 📋 Feature Requirements Summary

### Must-Have Features (MVP):
1. **Commissioner League Setup**
   - Sign up via Clerk
   - Create league and input settings
   - Connect ESPN data
   - Subscribe for entire league

2. **AI Content Generation**
   - 5 distinct writer personas with unique personalities
   - Multiple content types (recaps, previews, analysis)
   - Credit-based system for content generation
   - Real league data integration

3. **Subscription Management**
   - League-wide tiers (Free, Pro, Commissioner)
   - Credit packages for additional content
   - Stripe integration for payments

### AI Writer Personas:
1. **Mel Diaper** - Hot take artist, mock draft specialist (angry, outrageous)
2. **The Statistician** - Premium analytics writer (data-driven, precise)
3. **The Insider** - Trade rumor specialist (mysterious, speculative)
4. **The Hype Man** - Player promotion expert (enthusiastic, celebratory)
5. **The Commenter** - Community engagement (conversational, interactive)

### Content Types:
- Weekly Recaps
- Matchup Previews
- Power Rankings
- Trade Analysis
- Waiver Wire Suggestions
- Draft Grades
- Mid-season Awards
- Playoff Previews

## 🛠 Technology Stack

- **Frontend**: Next.js 14+ (App Router), TypeScript
- **Styling**: Tailwind CSS + shadcn/ui
- **Authentication**: Clerk (with Organizations for multi-tenancy)
- **Backend**: Convex (real-time database)
- **Payments**: Stripe
- **AI**: OpenAI GPT-4
- **Fantasy APIs**: ESPN, Yahoo Sports, Sleeper (future)

## 📐 Architecture Overview

```
User Journey:
1. Commissioner signs up → Creates Clerk Organization
2. Sets up league → Stored in Convex
3. Imports team data → Via API
4. Subscribes → Stripe payment
5. Generates content → OpenAI API
6. League members access → Via invite link
```