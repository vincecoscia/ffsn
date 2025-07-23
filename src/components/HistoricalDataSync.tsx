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

  const syncAllData = useAction(api.espnSync.syncAllLeagueData)

  const handleSync = async () => {
    if (!leagueId) {
      setError('No league ID provided')
      return
    }

    setIsLoading(true)
    setError(null)
    setSyncResult(null)

    try {
      const result = await syncAllData({
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
              disabled={isLoading}
            />
            <p className="text-xs text-gray-500 mt-1">
              Number of past seasons to sync (1-20 years)
            </p>
          </div>
          
          <div className="flex items-center">
            <input
              type="checkbox"
              id="includeCurrentSeason"
              checked={includeCurrentSeason}
              onChange={(e) => setIncludeCurrentSeason(e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              disabled={isLoading}
            />
            <label htmlFor="includeCurrentSeason" className="ml-2 block text-sm text-gray-700">
              Include current season data
            </label>
          </div>
        </div>
      </div>

      {/* Sync Button */}
      <div className="mb-6">
        <button
          onClick={handleSync}
          disabled={isLoading}
          className={`w-full py-3 px-6 rounded-lg font-semibold text-white transition-colors ${
            isLoading
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500'
          }`}
        >
          {isLoading ? (
            <span className="flex items-center justify-center">
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Syncing Data...
            </span>
          ) : (
            `Sync ${includeCurrentSeason ? yearsToSync + 1 : yearsToSync} Season${includeCurrentSeason ? 's' : yearsToSync === 1 ? '' : 's'} of Data`
          )}
        </button>
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
              <h3 className="text-sm font-medium text-red-800">Sync Error</h3>
              <p className="text-sm text-red-700 mt-1">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Sync Results */}
      {syncResult && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="p-6 bg-gradient-to-r from-green-50 to-blue-50 border border-green-200 rounded-lg">
            <div className="flex items-center mb-4">
              <svg className="h-6 w-6 text-green-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="text-lg font-semibold text-gray-900">Sync Summary</h3>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">{syncResult.totalSynced}</div>
                <div className="text-sm text-gray-600">Years Synced</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-600">{syncResult.totalErrors}</div>
                <div className="text-sm text-gray-600">Errors</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">{syncResult.totalYearsRequested}</div>
                <div className="text-sm text-gray-600">Total Requested</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gray-600">
                  {Math.round((syncResult.totalSynced / syncResult.totalYearsRequested) * 100)}%
                </div>
                <div className="text-sm text-gray-600">Success Rate</div>
              </div>
            </div>
            
            <p className="text-sm text-gray-700 mb-2">{syncResult.message}</p>
            <p className="text-xs text-gray-500">Completed at: {formatDate(syncResult.syncedAt)}</p>
          </div>

          {/* Detailed Results */}
          <div>
            <h4 className="text-lg font-semibold text-gray-900 mb-4">Detailed Results</h4>
            <div className="space-y-3">
              {syncResult.results.map((result) => (
                <div
                  key={result.year}
                  className={`p-4 rounded-lg border ${
                    result.success
                      ? 'bg-green-50 border-green-200'
                      : 'bg-red-50 border-red-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <div className={`w-3 h-3 rounded-full mr-3 ${
                        result.success ? 'bg-green-500' : 'bg-red-500'
                      }`} />
                      <span className="font-semibold text-gray-900">
                        {result.year} Season
                      </span>
                    </div>
                    
                    {result.success ? (
                      <div className="flex space-x-4 text-sm text-gray-600">
                        {result.teamsCount !== undefined && (
                          <span>{result.teamsCount} teams</span>
                        )}
                        {result.matchupsCount !== undefined && (
                          <span>{result.matchupsCount} matchups</span>
                        )}
                        {result.playersCount !== undefined && result.playersCount > 0 && (
                          <span>{result.playersCount} players</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-red-600">{result.error}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}