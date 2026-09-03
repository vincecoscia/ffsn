"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/broadcast";

export interface MatchupRefreshManagerProps {
  leagueId: Id<"leagues">;
  /**
   * `"simple"` (the default surface, shown under ESPN connection) is just the
   * routine "Sync now" action for the current season — one button, the
   * last-synced line, and any warnings. `"advanced"` is the full historical
   * re-import: current season plus a chosen number of past seasons, with the
   * "this can take a while" warning banner and a years selector. Both modes
   * share the same sync actions, warnings list and last-synced line — only
   * which sync runs, and how much UI surrounds it, changes.
   */
  mode?: "simple" | "advanced";
}

interface SyncSummary {
  totalSynced: number;
  issues: Array<{ year: number; error: string }>;
}

/**
 * Translates a thrown/returned sync error into copy a commissioner can act on.
 * The two specific cases below are what the backend actually surfaces when the
 * commissioner's Convex identity is missing or ESPN rejects the saved cookies;
 * everything else falls back to the raw message.
 */
function describeSyncError(message: string): string {
  if (message.includes("Not authenticated")) {
    return "Your session expired. Sign in again and retry.";
  }
  if (/401|403|credentials|re-authenticate/i.test(message)) {
    return "ESPN rejected the saved cookies. Update them in the ESPN connection card above.";
  }
  return message;
}

export function MatchupRefreshManager({ leagueId, mode = "advanced" }: MatchupRefreshManagerProps) {
  const isAdvanced = mode === "advanced";
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [historicalYears, setHistoricalYears] = useState(10);
  const [lastResult, setLastResult] = useState<SyncSummary | null>(null);

  // Both actions carry the browser's Clerk -> Convex JWT, unlike the deleted
  // `src/app/sync/actions.ts` server actions they replace.
  const syncCurrentSeason = useAction(api.espnSync.syncAllLeagueData);
  const syncWithHistory = useAction(api.espnSync.syncAllDataWithRosters);
  const connection = useQuery(api.leagues.getEspnConnection, { leagueId });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setLastResult(null);

    try {
      const result = isAdvanced
        ? await syncWithHistory({
            leagueId,
            includeCurrentSeason: true,
            historicalYears,
            includeHistoricalRosters: true,
          })
        : await syncCurrentSeason({ leagueId, includeCurrentSeason: true, historicalYears: 0 });

      if (!result.success) {
        throw new Error(result.message || "No seasons were synced successfully");
      }

      const issues = result.results
        .filter((yearResult) => !yearResult.success || (yearResult.stepErrors?.length ?? 0) > 0)
        .map((yearResult) => ({
          year: yearResult.year,
          error: yearResult.error ?? yearResult.stepErrors?.[0] ?? "Unknown error",
        }));

      const hasWarnings = (result.warnings ?? 0) > 0 || issues.length > 0;

      setLastResult({ totalSynced: result.totalSynced, issues });

      toast.success(`Synced ${result.totalSynced} season${result.totalSynced === 1 ? "" : "s"}`, {
        description: hasWarnings
          ? `${issues.length} season${issues.length === 1 ? "" : "s"} had issues — see details below.`
          : "All league data has been updated (teams, owners, logos, rosters, matchups).",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Please try again or contact support.";
      toast.error("Failed to sync league data", { description: describeSyncError(message) });
      console.error("Refresh error:", error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const lastSyncedLabel = connection?.lastSyncedAt
    ? `Last synced ${formatDistanceToNow(new Date(connection.lastSyncedAt), { addSuffix: true })}`
    : "Never synced";

  return (
    <div className="flex flex-col gap-5">
      {isAdvanced && (
        <div className="flex items-start gap-3 border-l-4 border-l-bc-signal bg-bc-panel-2 p-4">
          <AlertTriangle className="mt-0.5 size-5 flex-none text-bc-signal" />
          <div>
            <p className="font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-ink">Important information</p>
            <p className="mt-1 text-sm leading-relaxed text-bc-text-2">
              Re-importing league data will refresh all information from ESPN, including teams,
              owners, logos, rosters, matchups, scores, and playoff details, for every season
              synced. This process may take a few moments depending on the amount of data.
            </p>
          </div>
        </div>
      )}

      {isAdvanced && (
        <div className="flex flex-col gap-2">
          <Label>Historical years to sync</Label>
          <Select
            value={historicalYears.toString()}
            onValueChange={(value) => setHistoricalYears(Number(value))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">Last 5 years</SelectItem>
              <SelectItem value="10">Last 10 years</SelectItem>
              <SelectItem value="15">Last 15 years</SelectItem>
              <SelectItem value="20">Last 20 years</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <Button onClick={handleRefresh} disabled={isRefreshing} size="lg" className="w-full">
        {isRefreshing ? <Spinner size={16} className="[&>span]:bg-white" /> : <RefreshCw className="size-5" />}
        {isRefreshing ? "Syncing league data" : isAdvanced ? "Sync all seasons" : "Sync now"}
      </Button>

      {lastResult && lastResult.issues.length > 0 && (
        <div className="flex flex-col gap-1.5 border-l-2 border-l-bc-signal pl-3">
          <span className="bc-label-sm text-bc-text-3">Seasons with issues</span>
          {lastResult.issues.map(({ year, error }) => (
            <p key={year} className="text-sm text-bc-text-2">
              <span className="font-semibold text-bc-ink">{year}</span> &mdash; {error}
            </p>
          ))}
        </div>
      )}

      <p className="text-center text-xs text-bc-text-3">{lastSyncedLabel}</p>
    </div>
  );
}
