"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Panel, SectionHeader, Chip, Spinner, EmptyState } from "@/components/broadcast";

export interface SeasonSyncBoardProps {
  leagueId: Id<"leagues">;
  /** Only the commissioner gets the "Re-check now" action per row. */
  isCommissioner: boolean;
  className?: string;
}

function relativeOrNever(timestamp?: number): string {
  return timestamp ? formatDistanceToNow(new Date(timestamp), { addSuffix: true }) : "Never";
}

/**
 * Per-season sync status board (ESPN refresh audit, Sept 2026, section 5.v): replaces the old
 * "Automatic: ..." claims on the Advanced tools cards with what's actually true for each synced
 * season - when it was last fully pulled, how many weeks are closed out, whether the draft and
 * champion are recorded. Reads `api.seasonSyncStatus.getLeagueSeasonSyncStatus`; a season's row
 * never changes what it shows until that query's underlying sync bookkeeping does, so this board
 * can't drift from the data the rest of the app reads.
 */
export function SeasonSyncBoard({ leagueId, isCommissioner, className }: SeasonSyncBoardProps) {
  const rows = useQuery(api.seasonSyncStatus.getLeagueSeasonSyncStatus, { leagueId });
  const requestRecheck = useAction(api.seasonSyncStatus.requestSeasonRecheck);
  const [recheckingSeason, setRecheckingSeason] = useState<number | null>(null);

  const handleRecheck = async (seasonId: number) => {
    setRecheckingSeason(seasonId);
    try {
      const result = await requestRecheck({ leagueId, seasonId });
      toast.success(`Re-checked the ${seasonId} season`, {
        description: result.seasonClosedPullRan
          ? "Ran the weekly refresh and a full season-closed pull."
          : "Ran the weekly refresh — the season isn't decided yet, so a full pull wasn't needed.",
      });
    } catch (error) {
      toast.error("Re-check failed", {
        description: error instanceof Error ? error.message : "Please try again or contact support.",
      });
    } finally {
      setRecheckingSeason(null);
    }
  };

  return (
    <Panel padding="md" className={className}>
      <SectionHeader
        kicker="Status"
        title="Season sync"
        actions={<span className="bc-label-sm max-w-xs text-right text-bc-text-3">What ESPN has vs. what we&apos;ve pulled in</span>}
      />

      {rows === undefined ? (
        <div className="mt-6 flex justify-center py-8">
          <Spinner size={20} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No seasons synced yet" description="Run a sync from the ESPN connection card above to get started." />
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          {rows.map((row) => {
            const isRechecking = recheckingSeason === row.seasonId;

            return (
              <Panel key={row.seasonId} lifted padding="sm" className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[18px] font-bold uppercase tracking-[0.01em] text-bc-ink">
                      {row.seasonId} season
                    </span>
                    {row.isCurrent && <Chip variant="signal">Current</Chip>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-bc-text-2">
                    <span>Last full pull: {relativeOrNever(row.lastFullSyncAt)}</span>
                    {row.isCurrent && <span>Live sync: {relativeOrNever(row.lastLivenessSyncAt)}</span>}
                    <span>{row.periodsFinal.length}/{row.seasonEndWeek} weeks closed out</span>
                    <span>{row.transactionPeriods.length}/{row.seasonEndWeek} weeks of transactions</span>
                    {row.playerStatsUpdatedAt && <span>Player stats {relativeOrNever(row.playerStatsUpdatedAt)}</span>}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Chip variant={row.draftPicks > 0 ? "win" : "outline"}>
                    {row.draftPicks > 0 ? `Draft: ${row.draftPicks} picks` : "No draft picks"}
                  </Chip>
                  <Chip variant={row.champion ? "win" : "outline"}>
                    {row.champion
                      ? `Champion: ${row.champion.teamName}${row.champion.source === "bracket" ? " (bracket)" : ""}`
                      : "Champion not decided"}
                  </Chip>
                  {isCommissioner && (
                    <Button size="sm" variant="outline" onClick={() => handleRecheck(row.seasonId)} disabled={isRechecking}>
                      {isRechecking ? <Spinner size={14} /> : <RefreshCw className="size-3.5" />}
                      {isRechecking ? "Checking" : "Re-check now"}
                    </Button>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
