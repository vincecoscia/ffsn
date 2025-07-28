# Player Stats Implementation - Final Version

## Overview

We've implemented a clean separation between default PPR stats and league-specific stats:

1. **`playersEnhanced`** - Stores base player info and default PPR stats from ESPN's public API
2. **`playerStats`** - Stores league-specific stats calculated by ESPN based on each league's scoring settings

## Key Insight

ESPN already calculates the correct stats for each league when you query with that league's ID and authentication cookies. We don't need to calculate anything ourselves - just store the league-specific stats separately.

## Implementation Details

### Database Schema

```typescript
// Base player information with default PPR stats
playersEnhanced: defineTable({
  espnId: v.string(),
  season: v.number(),
  // ... player info fields ...
  stats: v.optional(v.any()), // Default PPR stats
  // ...
})

// League-specific stats
playerStats: defineTable({
  leagueId: v.id("leagues"),
  espnId: v.string(),
  season: v.number(),
  scoringType: v.string(), // "PPR", "HALF_PPR", "STANDARD", etc.
  stats: v.any(), // League-specific stats from ESPN
  calculatedAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
```

### Sync Functions

1. **`syncPlayersDefaultStats`** - Syncs from ESPN's public PPR endpoint
   - No authentication required
   - Stores in `playersEnhanced`
   - Run daily

2. **`syncLeaguePlayerStats`** - Syncs league-specific stats
   - Requires league authentication (espnS2, SWID)
   - Stores in `playerStats` 
   - Run per league as needed

3. **`syncAllLeaguePlayerStats`** - Handles pagination for complete league sync

### Query Functions

1. **`getPlayersWithLeagueStats`** - Gets players with their league-specific stats
2. **`getLeagueFreeAgentsWithStats`** - Gets free agents with league-specific stats

## Usage Examples

### 1. Sync Default Stats (Daily)
```javascript
await syncPlayersDefaultStats({ season: 2025 });
```

### 2. Sync League-Specific Stats
```javascript
// For a specific league
await syncAllLeaguePlayerStats({ 
  leagueId: "your-league-id", 
  season: 2025 
});
```

### 3. Query Players with League Stats
```javascript
// Get free agents with league-specific scoring
const freeAgents = await getLeagueFreeAgentsWithStats({
  leagueId: "your-league-id",
  season: 2025,
  limit: 20,
  position: "RB"
});

// Access stats
const defaultStats = player.stats; // PPR stats
const leagueStats = player.leagueStats?.stats; // League-specific stats
```

## Integration Notes

### For UI Components
```javascript
// Use league stats when available, fallback to default
const displayStats = player.leagueStats?.stats || player.stats;
```

### For AI Content
The AI should prioritize league-specific stats when generating content for a specific league.

## Benefits

1. **Accurate Stats** - Each league sees stats calculated for their exact scoring rules
2. **No Calculation Needed** - ESPN does all the work
3. **Efficient Storage** - No duplicate players
4. **Flexible** - Easy to add new leagues without affecting others
5. **Fallback** - Default PPR stats always available

## Sync Strategy

1. Run `syncPlayersDefaultStats` once daily for base player data
2. Run `syncLeaguePlayerStats` when:
   - League is first added
   - Scoring settings change
   - Before generating league-specific content
   - On commissioner request

## Future Enhancements

1. Add caching to avoid unnecessary re-syncs
2. Create UI for commissioners to trigger stats refresh
3. Add webhook/cron for automated league stats updates
4. Track historical stats for trend analysis