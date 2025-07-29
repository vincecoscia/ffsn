# AI Content Generation System Flow

## Overview
Complete breakdown of how the AI content generation system works, from data collection through article generation.

## Data Flow Overview

### 1. ESPN Sync (`convex/espnSync.ts`)
- Fetches comprehensive data including `view=kona_league_communication` for transactions
- Processes and stores trades/transactions via `processTransactionData`
- Stores data in new tables: trades, transactions, weatherData, nflSchedules

### 2. Data Processing Pipeline (`convex/dataProcessing.ts`)
- `processLeagueDataAfterSync` orchestrates enhanced metric calculations
- Calculates strength of schedule, recent form, bench points
- Detects rivalries between teams based on historical matchups
- Updates manager activity metrics
- Analyzes transaction trends

### 3. Enhanced Data Query (`convex/aiQueries.ts:17`)
- `getLeagueDataForAI` fetches ALL enriched data in parallel:
  - Teams with rosters, standings, playoff seeds
  - Recent matchups with memorable moments
  - Trades & transactions (last 20-50)
  - Rivalries with intensity levels
  - Manager activity & engagement
  - Transaction trends analysis
  - Playoff probabilities
  - League history

### 4. Article Generation Trigger (`src/components/ContentGenerator.tsx:86`)
- User selects content type & persona
- Creates generation request via `createGenerationRequest`
- Triggers `generateContentAction` (`convex/aiContent.ts:202`)

### 5. Content Generation Process
- `getLeagueDataForGeneration` (`convex/aiContent.ts:345`) calls `getLeagueDataForAI`
- Passes enriched data to `generateAIContent` (`src/lib/ai/content-generation-service.ts:514`)
- `PromptBuilder` (`src/lib/ai/prompt-builder.ts`) formats data into prompts
- Uses Claude API with structured output for consistent article format

## Key Enhanced Data Features

### 30+ New Data Fields Added:
- `playoffSeed`, `strengthOfSchedule`, `recentForm`
- `benchPoints`, `divisionRecord`
- `trades`, `transactions`, `rivalries`
- `managerActivity`, `transactionTrends`
- `playoffProbabilities`, `leagueHistory`
- `weatherData`, `playerTrends`
- `memorableMoments` in matchups

### 7 Helper Functions (`src/lib/ai/data-aggregation-helpers.ts`):
- `calculateStrengthOfSchedule()` - opponent win %
- `calculateRecentForm()` - last 3 weeks performance
- `detectRivalries()` - close games, frequent matchups
- `calculateBenchPoints()` - unused roster points
- `analyzeTransactionTrends()` - waiver/trade patterns
- `calculatePlayoffProbabilities()` - Monte Carlo simulation
- `identifyMemorableMoments()` - upsets, comebacks, blowouts

## How Articles Use Enhanced Data

The `PromptBuilder` creates content-specific prompts:

- **Weekly Recap** (`buildWeeklyRecapData`): Uses matchups, bench points, injuries, standings with streaks, manager activity, transactions, weather impact
- **Power Rankings** (`buildPowerRankingsData`): Uses standings, SOS, recent form, playoff probabilities
- **Trade Analysis** (`buildTradeAnalysisData`): Uses trades, transaction trends, roster analysis
- **Rivalry Week** (`buildRivalryData`): Uses rivalry history, head-to-head records, memorable moments
- **Season Welcome** (`buildSeasonWelcomeData`): Uses league history, previous champions, returning managers

## Key Files Reference
- Data collection: `convex/espnSync.ts`
- Data processing: `convex/dataProcessing.ts`
- Data queries: `convex/aiQueries.ts`
- Content generation: `convex/aiContent.ts`, `src/lib/ai/content-generation-service.ts`
- Prompt building: `src/lib/ai/prompt-builder.ts`
- Helper functions: `src/lib/ai/data-aggregation-helpers.ts`
- UI trigger: `src/components/ContentGenerator.tsx`

The system now provides **10x more contextual data** to the AI, enabling highly personalized and accurate fantasy football articles that reference actual league dynamics, rivalries, and trends.