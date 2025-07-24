'use client'

import { useState } from 'react'
import { useAction } from 'convex/react'
import { toast } from 'sonner'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'

interface HistoricalRosterManagerProps {
  leagueId: Id<"leagues">
}

export default function HistoricalRosterManager({ leagueId }: HistoricalRosterManagerProps) {
  const [selectedSeason, setSelectedSeason] = useState(new Date().getFullYear() - 1)
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  const fetchHistoricalRosters = useAction(api.espnSync.fetchHistoricalRosters)

  const handleFetchRosters = async () => {
    if (!leagueId) {
      toast.error('No league ID provided')
      return
    }

    setIsLoading(true)
    setResult(null)

    try {
      const fetchResult = await fetchHistoricalRosters({
        leagueId,
        seasonId: selectedSeason,
      })

      setResult(fetchResult)
      
      if (fetchResult.success) {
        toast.success("Historical rosters fetched successfully!", {
          description: `Fetched rosters for ${fetchResult.totalRostersFetched} of ${fetchResult.totalTeams} teams.`
        })
      } else {
        toast.error("Historical roster fetch failed", {
          description: fetchResult.message
        })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred'
      console.error('Historical roster fetch failed:', err)
      toast.error("Historical roster fetch failed", {
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Fetch Historical Rosters</h3>
          <p className="text-sm text-gray-600 mt-1">
            Retrieve detailed roster information for a specific season. This will get the actual players that were on each team during that season.
          </p>
        </div>
      </div>

      <div className="bg-gray-50 rounded-lg p-4">
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
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
            />
          </div>
          
          <button
            onClick={handleFetchRosters}
            disabled={isLoading}
            className="bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white px-6 py-2 rounded-md font-semibold transition-colors duration-200"
          >
            {isLoading ? (
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

      {/* Results Display */}
      {result && (
        <div className={`p-4 rounded-lg border ${result.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <h4 className={`text-lg font-semibold mb-3 ${result.success ? 'text-green-800' : 'text-red-800'}`}>
            {result.success ? 'Fetch Completed' : 'Fetch Failed'}
          </h4>
          
          <div className={`text-sm mb-3 ${result.success ? 'text-green-700' : 'text-red-700'}`}>
            <p><strong>Season:</strong> {selectedSeason}</p>
            <p><strong>Teams Processed:</strong> {result.totalTeams}</p>
            <p><strong>Successful Fetches:</strong> {result.totalRostersFetched}</p>
            <p><strong>Errors:</strong> {result.totalErrors}</p>
            <p><strong>Completed At:</strong> {formatDate(result.fetchedAt)}</p>
          </div>
          
          {result.results && result.results.length > 0 && (
            <div className="space-y-2">
              <h5 className={`font-medium ${result.success ? 'text-green-800' : 'text-red-800'}`}>
                Team Results:
              </h5>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {result.results.map((teamResult: any, index: number) => (
                  <div 
                    key={index} 
                    className={`p-2 rounded text-sm ${
                      teamResult.success 
                        ? 'bg-green-100 text-green-800' 
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    <span className="font-medium">{teamResult.teamName}</span>
                    {teamResult.success ? (
                      <span> - {teamResult.playersCount} players fetched</span>
                    ) : (
                      <span> - Error: {teamResult.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <h3 className="text-sm font-medium text-blue-800">How it works</h3>
            <div className="mt-2 text-sm text-blue-700">
              <p>
                This feature fetches detailed roster information for each team from a specific season. 
                Make sure you've already synced basic team data for the season before fetching rosters.
                The process may take a few minutes for leagues with many teams.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}