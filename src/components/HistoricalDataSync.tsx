'use client'

import { useState } from 'react'
import { useAction } from 'convex/react'
import { toast } from 'sonner'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'

interface SyncResult {
  year: number
  success: boolean
  teamsCount?: number
  matchupsCount?: number
  playersCount?: number
  rostersCount?: number
  error?: string
}

interface SyncResponse {
  success: boolean
  totalYearsRequested: number
  totalSynced: number
  totalErrors: number
  results: SyncResult[]
  message: string
  syncedAt: number
}

interface RosterResult {
  teamId: string
  teamName: string
  success: boolean
  error?: string
  playersCount?: number
}

interface RosterResponse {
  success: boolean
  totalTeams: number
  totalRostersFetched: number
  totalErrors: number
  results: RosterResult[]
  message: string
  fetchedAt: number
}

interface HistoricalDataSyncProps {
  leagueId: Id<"leagues">
  leagueName?: string
}

export default function HistoricalDataSync({ leagueId, leagueName }: HistoricalDataSyncProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [yearsToSync, setYearsToSync] = useState(10)
  const [includeCurrentSeason, setIncludeCurrentSeason] = useState(true)
  const [includeHistoricalRosters, setIncludeHistoricalRosters] = useState(false)
  
  // Historical roster specific state
  const [isLoadingRosters, setIsLoadingRosters] = useState(false)
  const [rosterResult, setRosterResult] = useState<RosterResponse | null>(null)
  const [selectedSeason, setSelectedSeason] = useState(new Date().getFullYear() - 1)

  const syncAllData = useAction(api.espnSync.syncAllLeagueData)
  const syncAllDataWithRosters = useAction(api.espnSync.syncAllDataWithRosters)
  const fetchHistoricalRosters = useAction(api.espnSync.fetchHistoricalRosters)

  const handleSync = async () => {
    if (!leagueId) {
      setError('No league ID provided')
      return
    }

    setIsLoading(true)
    setError(null)
    setSyncResult(null)

    try {
      const result = includeHistoricalRosters 
        ? await syncAllDataWithRosters({
            leagueId,
            includeCurrentSeason,
            historicalYears: yearsToSync,
            includeHistoricalRosters: true,
          })
        : await syncAllData({
            leagueId,
            includeCurrentSeason,
            historicalYears: yearsToSync,
          })

      setSyncResult(result)
      
      if (result.success) {
        console.log('Sync completed successfully:', result)
        toast.success("League data sync completed successfully!", {
          description: `Synced ${result.totalSynced} of ${result.totalYearsRequested} seasons with ${result.totalErrors} errors.`
        })
      } else {
        setError(result.message)
        toast.error("League data sync failed", {
          description: result.message
        })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred'
      setError(errorMessage)
      console.error('Sync failed:', err)
      toast.error("League data sync failed", {
        description: errorMessage
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleFetchHistoricalRosters = async () => {
    if (!leagueId) {
      setError('No league ID provided')
      return
    }

    setIsLoadingRosters(true)
    setError(null)
    setRosterResult(null)

    try {
      const result = await fetchHistoricalRosters({
        leagueId,
        seasonId: selectedSeason,
        // teamIds: undefined // Fetch for all teams
      })

      setRosterResult(result)
      
      if (result.success) {
        console.log('Historical rosters fetch completed successfully:', result)
        toast.success("Historical rosters fetched successfully!", {
          description: `Fetched rosters for ${result.totalRostersFetched} of ${result.totalTeams} teams.`
        })
      } else {
        setError(result.message)
        toast.error("Historical roster fetch failed", {
          description: result.message
        })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred'
      setError(errorMessage)
      console.error('Historical roster fetch failed:', err)
      toast.error("Historical roster fetch failed", {
        description: errorMessage
      })
    } finally {
      setIsLoadingRosters(false)
    }
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString()
  }

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Historical Data Sync
        </h2>
        {leagueName && (
          <p className="text-gray-600">League: {leagueName}</p>
        )}
        <p className="text-sm text-gray-500 mt-2">
          Sync comprehensive league data including teams, matchups, player stats, and league history.
        </p>
      </div>

      {/* Sync Configuration */}
      <div className="mb-6 p-4 bg-gray-50 rounded-lg">
        <h3 className="text-lg font-semibold mb-4">Sync Configuration</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Years of Historical Data
            </label>
            <input
              type="number"
              min="1"
              max="20"
              value={yearsToSync}
              onChange={(e) => setYearsToSync(parseInt(e.target.value) || 10)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          
          <div className="space-y-3">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="includeCurrentSeason"
                checked={includeCurrentSeason}
                onChange={(e) => setIncludeCurrentSeason(e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="includeCurrentSeason" className="ml-2 block text-sm text-gray-900">
                Include Current Season ({new Date().getFullYear()})
              </label>
            </div>
            
            <div className="flex items-center">
              <input
                type="checkbox"
                id="includeHistoricalRosters"
                checked={includeHistoricalRosters}
                onChange={(e) => setIncludeHistoricalRosters(e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="includeHistoricalRosters" className="ml-2 block text-sm text-gray-900">
                Include Historical Rosters (slower but more detailed)
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Sync Actions */}
      <div className="flex gap-4 mb-6">
        <button
          onClick={handleSync}
          disabled={isLoading}
          className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-6 py-3 rounded-lg font-semibold transition-colors duration-200"
        >
          {isLoading ? (
            <div className="flex items-center justify-center">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
              Syncing Data...
            </div>
          ) : (
            'Sync League Data'
          )}
        </button>
      </div>

      {/* Historical Roster Section */}
      <div className="mb-6 p-4 bg-gray-50 rounded-lg">
        <h3 className="text-lg font-semibold mb-4">Historical Rosters</h3>
        <p className="text-sm text-gray-600 mb-4">
          Fetch detailed roster information for a specific season. This will retrieve the actual players that were on each team during that season.
        </p>
        
        <div className="flex gap-4 items-end">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Season Year
            </label>
            <input
              type="number"
              min="2010"
              max={new Date().getFullYear()}
              value={selectedSeason}
              onChange={(e) => setSelectedSeason(parseInt(e.target.value) || new Date().getFullYear() - 1)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          
          <button
            onClick={handleFetchHistoricalRosters}
            disabled={isLoadingRosters}
            className="bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white px-6 py-2 rounded-lg font-semibold transition-colors duration-200"
          >
            {isLoadingRosters ? (
              <div className="flex items-center">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                Fetching...
              </div>
            ) : (
              'Fetch Historical Rosters'
            )}
          </button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">Error</h3>
              <div className="mt-2 text-sm text-red-700">{error}</div>
            </div>
          </div>
        </div>
      )}

      {/* Historical Roster Results */}
      {rosterResult && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <h4 className="text-lg font-semibold text-green-800 mb-3">Historical Roster Results</h4>
          <div className="text-sm text-green-700 mb-3">
            <p><strong>Season:</strong> {selectedSeason}</p>
            <p><strong>Teams Processed:</strong> {rosterResult.totalTeams}</p>
            <p><strong>Successful Fetches:</strong> {rosterResult.totalRostersFetched}</p>
            <p><strong>Errors:</strong> {rosterResult.totalErrors}</p>
            <p><strong>Completed At:</strong> {formatDate(rosterResult.fetchedAt)}</p>
          </div>
          
          {rosterResult.results.length > 0 && (
            <div className="space-y-2">
              <h5 className="font-medium text-green-800">Team Results:</h5>
              {rosterResult.results.map((result, index) => (
                <div key={index} className={`p-2 rounded text-sm ${result.success ? 'bg-green-100' : 'bg-red-100'}`}>
                  <span className="font-medium">{result.teamName}</span>
                  {result.success ? (
                    <span className="text-green-700"> - {result.playersCount} players fetched</span>
                  ) : (
                    <span className="text-red-700"> - Error: {result.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sync Results */}
      {syncResult && (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h4 className="text-lg font-semibold text-blue-800 mb-3">Sync Results</h4>
          <div className="text-sm text-blue-700 mb-3">
            <p><strong>Years Requested:</strong> {syncResult.totalYearsRequested}</p>
            <p><strong>Successfully Synced:</strong> {syncResult.totalSynced}</p>
            <p><strong>Errors:</strong> {syncResult.totalErrors}</p>
            <p><strong>Completed At:</strong> {formatDate(syncResult.syncedAt)}</p>
          </div>
          
          {syncResult.results.length > 0 && (
            <div className="space-y-2">
              <h5 className="font-medium text-blue-800">Year-by-Year Results:</h5>
              {syncResult.results.map((result, index) => (
                <div key={index} className={`p-2 rounded text-sm ${result.success ? 'bg-green-100' : 'bg-red-100'}`}>
                  <span className="font-medium">{result.year}</span>
                  {result.success ? (
                    <span className="text-green-700">
                      {' '}✓ Teams: {result.teamsCount}, Matchups: {result.matchupsCount}
                      {result.playersCount ? `, Players: ${result.playersCount}` : ''}
                      {result.rostersCount ? `, Rosters: ${result.rostersCount}` : ''}
                    </span>
                  ) : (
                    <span className="text-red-700"> ✗ {result.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}