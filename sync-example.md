# ESPN Fantasy Football Historical Data Sync

This guide shows how to sync the last 10 years of league data from ESPN Fantasy Football using the enhanced sync functions.

## What Gets Synced

### For All Years (Current + Historical)
- **Team Information**: Names, logos, abbreviations, owners, records
- **League Settings**: Scoring type, roster composition, playoff structure  
- **Season History**: Champions, runners-up, regular season winners
- **Matchup Results**: All game scores, winners, playoff tiers
- **Draft Information**: Draft dates, types, timing

### Current Season Only
- **Player Data**: Full rosters with stats, ownership percentages
- **Live Stats**: Current player performance and projections
- **Detailed Rosters**: Acquisition types, lineup positions

## How to Use

### 1. Using the Client Component

```tsx
import HistoricalDataSync from '@/components/HistoricalDataSync'

// In your React component
<HistoricalDataSync 
  leagueId={leagueId}
  leagueName="Your League Name"
/>
```

### 2. Using Convex Actions Directly

```typescript
import { useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'

const syncAllData = useAction(api.espnSync.syncAllLeagueData)

// Sync last 10 years + current season
const result = await syncAllData({
  leagueId: "your_league_id",
  includeCurrentSeason: true,
  historicalYears: 10
})

// Just historical data (no current season)
const historicalOnly = await syncAllData({
  leagueId: "your_league_id", 
  includeCurrentSeason: false,
  historicalYears: 5
})
```

### 3. Using Server Actions

```typescript
import { triggerHistoricalSync } from '@/app/sync/actions'

// Trigger sync from server component
const result = await triggerHistoricalSync(
  leagueId,
  10, // years back
  true // include current season
)
```

## Function Reference

### `syncAllLeagueData`
The main comprehensive sync function.

**Parameters:**
- `leagueId` (required): Convex ID of the league
- `includeCurrentSeason` (optional): Include current season data (default: true)
- `historicalYears` (optional): Number of past years to sync (default: 10)

**Returns:**
```typescript
{
  success: boolean
  totalYearsRequested: number
  totalSynced: number
  totalErrors: number
  results: Array<{
    year: number
    success: boolean
    teamsCount?: number
    matchupsCount?: number
    playersCount?: number
    error?: string
  }>
  message: string
  syncedAt: number
}
```

### `syncHistoricalData`
Legacy function for historical data only.

### `syncLeagueData`  
Current season sync with enhanced data.

## Database Schema

The sync functions populate these Convex tables:

- **`teams`**: Enhanced team data with logos, divisions, detailed records
- **`leagueSeasons`**: Historical season information and champions
- **`players`**: Player profiles with stats and ownership data
- **`matchups`**: All game results and scores
- **`leagues`**: Updated league metadata and sync timestamps

## Rate Limiting & Best Practices

- **Automatic delays**: 1 second between year requests to prevent ESPN rate limiting
- **Error handling**: Continues sync even if individual years fail
- **Private leagues**: Requires valid ESPN S2 cookies stored in league data
- **Data validation**: Checks for valid responses before processing
- **Progress tracking**: Detailed logging and result reporting

## Example Usage Scenarios

### Full Historical Sync (10 Years)
```typescript
await syncAllData({
  leagueId,
  includeCurrentSeason: true,
  historicalYears: 10
})
```

### Quick Historical Overview (3 Years)
```typescript
await syncAllData({
  leagueId,
  includeCurrentSeason: false, 
  historicalYears: 3
})
```

### Current Season + Last Year
```typescript
await syncAllData({
  leagueId,
  includeCurrentSeason: true,
  historicalYears: 1
})
```

## Error Handling

The sync function is resilient to failures:
- Individual year failures don't stop the overall sync
- Network errors are caught and reported
- Invalid data structures are detected
- Rate limiting is automatically handled
- Detailed error messages for troubleshooting

## Performance Considerations

- **10 years sync**: ~2-3 minutes (with rate limiting)
- **Large leagues**: 12-14 teams sync faster than smaller leagues
- **Private leagues**: May be slower due to authentication overhead
- **Current season**: Additional player data increases sync time

## Getting Started

1. Navigate to `/sync` page in your Next.js app
2. Select number of years to sync (1-20)
3. Choose whether to include current season
4. Click "Sync Data" and monitor progress
5. Review detailed results and error reports

The sync will provide comprehensive historical data for AI analysis, league insights, and historical comparisons.