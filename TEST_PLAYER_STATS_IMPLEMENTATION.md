# Testing the Player Stats Implementation

## Summary of Changes

1. **Added `playerStats` table** to store league-specific player statistics
2. **Created `syncPlayersDefaultStats`** function to sync PPR stats from ESPN's public API
3. **Created `calculateLeaguePlayerStats`** function to calculate league-specific stats
4. **Added queries** to fetch players with their league-specific stats

## How It Works

### Data Flow
1. **Default Stats Sync**: `syncPlayersDefaultStats` fetches PPR stats from ESPN's public endpoint and stores them in `playersEnhanced`
2. **League Stats Calculation**: `calculateLeaguePlayerStats` reads league scoring settings and creates league-specific stats in `playerStats`
3. **Queries**: New queries join `playersEnhanced` with `playerStats` to provide league-specific data

### Database Structure
- **playersEnhanced**: Contains base player info and default PPR stats
- **playerStats**: Contains league-specific calculated stats

## Testing Steps

### 1. Deploy the Schema Changes
```bash
npx convex deploy
```

### 2. Sync Default Player Stats
```javascript
// In Convex dashboard or via code
await syncPlayersDefaultStats({ season: 2025 });
```

### 3. Calculate League-Specific Stats
```javascript
// For each league
await calculateLeaguePlayerStats({ 
  leagueId: "your-league-id", 
  season: 2025 
});
```

### 4. Query Players with League Stats
```javascript
// Get free agents with league-specific stats
const freeAgents = await getLeagueFreeAgentsWithStats({
  leagueId: "your-league-id",
  season: 2025,
  limit: 20,
  position: "RB"
});

// Get specific players with league stats
const players = await getPlayersWithLeagueStats({
  leagueId: "your-league-id",
  playerIds: ["player1", "player2"],
  season: 2025
});
```

## Integration Notes

### For UI Components
Update components to use the new queries:
- Replace `getLeagueFreeAgents` with `getLeagueFreeAgentsWithStats`
- Access league-specific stats via `player.leagueStats.stats` instead of `player.stats`

### For AI Content Generation
The AI should now use league-specific stats when available:
```javascript
const stats = player.leagueStats?.stats || player.stats; // Fallback to default
```

## Future Enhancements

1. **Implement actual scoring calculations** in `calculateLeaguePlayerStats` based on:
   - Reception scoring (PPR vs Half-PPR vs Standard)
   - Custom scoring rules
   - Position-specific scoring

2. **Add caching** to avoid recalculating stats unnecessarily

3. **Create a UI** for commissioners to manually trigger stat recalculation

4. **Add historical stats tracking** for trend analysis