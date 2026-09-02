"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Id } from "../../convex/_generated/dataModel";
import { RefreshCw, Calendar, AlertTriangle } from "lucide-react";
import { triggerHistoricalSync, getCurrentLeagueSync } from "../app/sync/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/broadcast";
import { cn } from "@/lib/utils";

interface MatchupRefreshManagerProps {
  leagueId: Id<"leagues">;
}

export function MatchupRefreshManager({ leagueId }: MatchupRefreshManagerProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshType, setRefreshType] = useState<"current" | "all">("current");
  const [historicalYears, setHistoricalYears] = useState(10);

  const handleRefresh = async () => {
    setIsRefreshing(true);

    try {
      let result;

      if (refreshType === "current") {
        // Only refresh current season
        result = await getCurrentLeagueSync(leagueId);

        if (result.success) {
          toast.success("Current season data synced!", {
            description: "All league data for the current season has been updated (teams, owners, logos, rosters, matchups)."
          });
        } else {
          throw new Error(result.error);
        }
      } else {
        // Refresh all historical data
        result = await triggerHistoricalSync(leagueId, historicalYears, true);

        if (result.success && result.data) {
          const { totalSynced, totalErrors, results } = result.data;

          if (totalSynced > 0) {
            toast.success(`Successfully synced ${totalSynced} season${totalSynced > 1 ? 's' : ''}!`, {
              description: totalErrors > 0
                ? `${totalErrors} season${totalErrors > 1 ? 's' : ''} had errors. Check console for details.`
                : "All league data has been updated across all seasons."
            });

            // Log detailed results for debugging
            console.log("Sync results:", results);
          } else {
            throw new Error("No seasons were synced successfully");
          }
        } else {
          throw new Error(result.error);
        }
      }
    } catch (error) {
      toast.error("Failed to sync league data", {
        description: error instanceof Error ? error.message : "Please try again or contact support."
      });
      console.error("Refresh error:", error);
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3 border-l-4 border-l-bc-signal bg-bc-panel-2 p-4">
        <AlertTriangle className="mt-0.5 size-5 flex-none text-bc-signal" />
        <div>
          <p className="font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-ink">Important information</p>
          <p className="mt-1 text-sm leading-relaxed text-bc-text-2">
            Syncing league data will refresh all information from ESPN, including teams,
            owners, logos, rosters, matchups, scores, and playoff details. This process
            may take a few moments depending on the amount of data.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Label>Refresh type</Label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setRefreshType("current")}
            className={cn(
              "flex flex-col items-start gap-2 border p-4 text-left transition-colors",
              refreshType === "current"
                ? "border-bc-red bg-bc-red/10"
                : "border-bc-hairline bg-bc-panel-2 hover:border-bc-border-strong"
            )}
          >
            <Calendar className="size-6 text-bc-text-2" />
            <div className="font-display text-[16px] font-bold uppercase tracking-[0.01em] text-bc-ink">Current season</div>
            <div className="hidden text-sm text-bc-text-2 md:block">
              Sync only the current season&apos;s data
            </div>
          </button>

          <button
            type="button"
            onClick={() => setRefreshType("all")}
            className={cn(
              "flex flex-col items-start gap-2 border p-4 text-left transition-colors",
              refreshType === "all"
                ? "border-bc-red bg-bc-red/10"
                : "border-bc-hairline bg-bc-panel-2 hover:border-bc-border-strong"
            )}
          >
            <RefreshCw className="size-6 text-bc-text-2" />
            <div className="font-display text-[16px] font-bold uppercase tracking-[0.01em] text-bc-ink">All seasons</div>
            <div className="hidden text-sm text-bc-text-2 md:block">
              Sync current and historical league data
            </div>
          </button>
        </div>
      </div>

      {refreshType === "all" && (
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
        {isRefreshing
          ? "Syncing league data"
          : `Sync ${refreshType === "current" ? "current season" : "all"} league data`}
      </Button>

      <p className="text-center text-xs text-bc-text-3">
        Last sync information is not currently tracked. Consider running a sync if league data seems outdated.
      </p>
    </div>
  );
}
