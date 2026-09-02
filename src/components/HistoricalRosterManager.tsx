'use client'

import { useState } from 'react'
import { useAction } from 'convex/react'
import { toast } from 'sonner'
import { Info } from 'lucide-react'
import { api } from '../../convex/_generated/api'
import { Id } from '../../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner, Panel, Chip } from '@/components/broadcast'
import { cn } from '@/lib/utils'

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

interface HistoricalRosterManagerProps {
  leagueId: Id<"leagues">
}

export default function HistoricalRosterManager({ leagueId }: HistoricalRosterManagerProps) {
  const [selectedSeason, setSelectedSeason] = useState(new Date().getFullYear() - 1)
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<RosterResponse | null>(null)

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
    <div className="flex flex-col gap-6">
      <p className="max-w-2xl text-sm leading-relaxed text-bc-text-2">
        Retrieve detailed roster information for a specific season &mdash; the actual players
        that were on each team during that season.
      </p>

      <Panel lifted padding="md" className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <Label className="bc-label-sm text-bc-text-3">Season year</Label>
          <Input
            type="number"
            min="2010"
            max={new Date().getFullYear()}
            value={selectedSeason}
            onChange={(e) => setSelectedSeason(parseInt(e.target.value) || new Date().getFullYear() - 1)}
            className="w-32"
          />
        </div>

        <Button onClick={handleFetchRosters} disabled={isLoading}>
          {isLoading && <Spinner size={14} className="[&>span]:bg-white" />}
          {isLoading ? "Fetching" : "Fetch historical rosters"}
        </Button>
      </Panel>

      {/* Results Display */}
      {result && (
        <Panel padding="md" className={cn("border-l-4", result.success ? "border-l-bc-win" : "border-l-bc-red-deep")}>
          <div className="flex items-center justify-between gap-4">
            <span className="font-display text-[20px] font-bold uppercase tracking-[0.01em] text-bc-ink">
              {result.success ? 'Fetch completed' : 'Fetch failed'}
            </span>
            <Chip variant={result.success ? "win" : "red"}>{result.success ? "Success" : "Error"}</Chip>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-bc-text-2 sm:grid-cols-3">
            <p><span className="text-bc-text-3">Season</span> &middot; {selectedSeason}</p>
            <p><span className="text-bc-text-3">Teams processed</span> &middot; {result.totalTeams}</p>
            <p><span className="text-bc-text-3">Successful fetches</span> &middot; {result.totalRostersFetched}</p>
            <p><span className="text-bc-text-3">Errors</span> &middot; {result.totalErrors}</p>
            <p className="sm:col-span-2"><span className="text-bc-text-3">Completed at</span> &middot; {formatDate(result.fetchedAt)}</p>
          </div>

          {result.results && result.results.length > 0 && (
            <div className="mt-5 flex flex-col gap-2">
              <span className="bc-label-sm text-bc-text-3">Team results</span>
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {result.results.map((teamResult, index) => (
                  <div
                    key={index}
                    className={cn(
                      "border-l-2 px-3 py-2 text-sm",
                      teamResult.success ? "border-l-bc-win text-bc-ink" : "border-l-bc-red-deep text-bc-red-text"
                    )}
                  >
                    <span className="font-semibold">{teamResult.teamName}</span>
                    {teamResult.success ? (
                      <span className="text-bc-text-2"> &mdash; {teamResult.playersCount} players fetched</span>
                    ) : (
                      <span> &mdash; Error: {teamResult.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>
      )}

      <Panel lifted padding="md" className="flex items-start gap-3">
        <Info className="mt-0.5 size-5 flex-none text-bc-signal" />
        <div>
          <p className="font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-ink">How it works</p>
          <p className="mt-2 text-sm leading-relaxed text-bc-text-2">
            This feature fetches detailed roster information for each team from a specific season.
            Make sure you&apos;ve already synced basic team data for the season before fetching rosters.
            The process may take a few minutes for leagues with many teams.
          </p>
        </div>
      </Panel>
    </div>
  )
}
