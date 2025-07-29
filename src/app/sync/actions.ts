'use server'

import { fetchAction } from 'convex/nextjs'
import { api } from '../../../convex/_generated/api'
import { Id } from '../../../convex/_generated/dataModel'

export async function triggerHistoricalSync(
  leagueId: Id<"leagues">,
  historicalYears: number = 10,
  includeCurrentSeason: boolean = true
) {
  try {
    const result = await fetchAction(api.espnSync.syncAllDataWithRosters, {
      leagueId,
      includeCurrentSeason,
      historicalYears,
      includeHistoricalRosters: true,
    })

    return {
      success: true,
      data: result,
    }
  } catch (error) {
    console.error('Historical sync failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}

export async function getCurrentLeagueSync(leagueId: Id<"leagues">) {
  try {
    const result = await fetchAction(api.espnSync.syncAllLeagueData, {
      leagueId,
    })

    return {
      success: true,
      data: result,
    }
  } catch (error) {
    console.error('Current season sync failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}