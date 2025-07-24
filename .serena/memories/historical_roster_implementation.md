# Historical Roster Implementation Plan

## What's been done:
1. Added `fetchHistoricalRosters` action to `convex/espnSync.ts` that:
   - Takes leagueId, seasonId, and optional teamIds
   - Uses the ESPN API endpoint with `rosterForTeamId` parameter
   - Fetches detailed roster data for specific teams and seasons
   - Updates the team records in the database with historical roster data

2. Updated the existing `syncAllLeagueData` function to indicate historical rosters can be fetched separately

## Next steps:
1. Create a UI component for manual historical roster fetching
2. Add the component to the league homepage or settings page
3. Test the implementation with real data

## API endpoint used:
`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2024/segments/0/leagues/63275619?rosterForTeamId=5&view=mDraftDetail&view=mLiveScoring&view=mMatchupScore&view=mPendingTransactions&view=mPositionalRatings&view=mRoster&view=mSettings&view=mTeam&view=modular&view=mNav`