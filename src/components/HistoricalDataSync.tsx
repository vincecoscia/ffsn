'use client'

import { useState } from 'react'
import { useAction } from 'convex/react'
import { toast } from 'sonner'
import { AlertCircle } from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { PageHeader, Panel, SectionHeader, Chip, Spinner } from '@/components/broadcast'
import { cn } from '@/lib/utils'

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
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <PageHeader
        kicker="Archive"
        title="Historical data sync"
        description={
          leagueName
            ? `League: ${leagueName} · Sync comprehensive league data including teams, matchups, player stats, and league history.`
            : "Sync comprehensive league data including teams, matchups, player stats, and league history."
        }
      />

      {/* Sync Configuration */}
      <Panel padding="md">
        <SectionHeader size="sm" title="Sync configuration" kicker="Options" />
        <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label>Years of historical data</Label>
            <Input
              type="number"
              min="1"
              max="20"
              value={yearsToSync}
              onChange={(e) => setYearsToSync(parseInt(e.target.value) || 10)}
              className="w-32"
            />
          </div>

          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm text-bc-ink">
              <Checkbox
                checked={includeCurrentSeason}
                onCheckedChange={(checked) => setIncludeCurrentSeason(checked === true)}
              />
              Include current season ({new Date().getFullYear()})
            </label>

            <label className="flex items-center gap-2 text-sm text-bc-ink">
              <Checkbox
                checked={includeHistoricalRosters}
                onCheckedChange={(checked) => setIncludeHistoricalRosters(checked === true)}
              />
              Include historical rosters (slower but more detailed)
            </label>
          </div>
        </div>
      </Panel>

      {/* Sync Actions */}
      <Button onClick={handleSync} disabled={isLoading} size="lg" className="w-full">
        {isLoading && <Spinner size={16} className="[&>span]:bg-white" />}
        {isLoading ? "Syncing data" : "Sync league data"}
      </Button>

      {/* Historical Roster Section */}
      <Panel padding="md">
        <SectionHeader size="sm" title="Historical rosters" kicker="Per-season detail" />
        <p className="mt-3 text-sm leading-relaxed text-bc-text-2">
          Fetch detailed roster information for a specific season &mdash; the actual players that
          were on each team during that season.
        </p>

        <div className="mt-5 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-2">
            <Label>Season year</Label>
            <Input
              type="number"
              min="2010"
              max={new Date().getFullYear()}
              value={selectedSeason}
              onChange={(e) => setSelectedSeason(parseInt(e.target.value) || new Date().getFullYear() - 1)}
              className="w-32"
            />
          </div>

          <Button onClick={handleFetchHistoricalRosters} disabled={isLoadingRosters} variant="outline">
            {isLoadingRosters && <Spinner size={14} />}
            {isLoadingRosters ? "Fetching" : "Fetch historical rosters"}
          </Button>
        </div>
      </Panel>

      {/* Error Display */}
      {error && (
        <Panel padding="md" className="flex items-start gap-3 border-l-4 border-l-bc-red-deep">
          <AlertCircle className="mt-0.5 size-5 flex-none text-bc-red-text" />
          <div>
            <p className="font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-red-text">Error</p>
            <p className="mt-1 text-sm text-bc-text-2">{error}</p>
          </div>
        </Panel>
      )}

      {/* Historical Roster Results */}
      {rosterResult && (
        <Panel padding="md">
          <SectionHeader size="sm" title="Historical roster results" kicker={`Season ${selectedSeason}`} />
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-bc-text-2 sm:grid-cols-3">
            <p><span className="text-bc-text-3">Teams processed</span> &middot; {rosterResult.totalTeams}</p>
            <p><span className="text-bc-text-3">Successful fetches</span> &middot; {rosterResult.totalRostersFetched}</p>
            <p><span className="text-bc-text-3">Errors</span> &middot; {rosterResult.totalErrors}</p>
            <p className="sm:col-span-3"><span className="text-bc-text-3">Completed at</span> &middot; {formatDate(rosterResult.fetchedAt)}</p>
          </div>

          {rosterResult.results.length > 0 && (
            <div className="mt-5 flex flex-col gap-1.5">
              <span className="bc-label-sm text-bc-text-3">Team results</span>
              {rosterResult.results.map((result, index) => (
                <div key={index} className={cn("border-l-2 px-3 py-2 text-sm", result.success ? "border-l-bc-win" : "border-l-bc-red-deep")}>
                  <span className="font-semibold text-bc-ink">{result.teamName}</span>
                  {result.success ? (
                    <span className="text-bc-text-2"> &mdash; {result.playersCount} players fetched</span>
                  ) : (
                    <span className="text-bc-red-text"> &mdash; Error: {result.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {/* Sync Results */}
      {syncResult && (
        <Panel padding="md">
          <SectionHeader size="sm" title="Sync results" kicker="Summary" actions={<Chip variant={syncResult.success ? "win" : "red"}>{syncResult.success ? "Success" : "Error"}</Chip>} />
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-bc-text-2 sm:grid-cols-3">
            <p><span className="text-bc-text-3">Years requested</span> &middot; {syncResult.totalYearsRequested}</p>
            <p><span className="text-bc-text-3">Successfully synced</span> &middot; {syncResult.totalSynced}</p>
            <p><span className="text-bc-text-3">Errors</span> &middot; {syncResult.totalErrors}</p>
            <p className="sm:col-span-3"><span className="text-bc-text-3">Completed at</span> &middot; {formatDate(syncResult.syncedAt)}</p>
          </div>

          {syncResult.results.length > 0 && (
            <div className="mt-5 flex flex-col gap-1.5">
              <span className="bc-label-sm text-bc-text-3">Year-by-year results</span>
              {syncResult.results.map((result, index) => (
                <div key={index} className={cn("border-l-2 px-3 py-2 text-sm", result.success ? "border-l-bc-win" : "border-l-bc-red-deep")}>
                  <span className="font-semibold text-bc-ink">{result.year}</span>
                  {result.success ? (
                    <span className="text-bc-text-2">
                      {' '}&middot; Teams: {result.teamsCount}, Matchups: {result.matchupsCount}
                      {result.playersCount ? `, Players: ${result.playersCount}` : ''}
                      {result.rostersCount ? `, Rosters: ${result.rostersCount}` : ''}
                    </span>
                  ) : (
                    <span className="text-bc-red-text"> &mdash; {result.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}
