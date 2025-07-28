"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Id } from "../../convex/_generated/dataModel";
import { RefreshCw, Calendar, AlertTriangle } from "lucide-react";
import { triggerHistoricalSync, getCurrentLeagueSync } from "../app/sync/actions";

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
          toast.success("Current season matchups refreshed!", {
            description: "All matchup data for the current season has been updated."
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
            toast.success(`Successfully refreshed ${totalSynced} season${totalSynced > 1 ? 's' : ''}!`, {
              description: totalErrors > 0 
                ? `${totalErrors} season${totalErrors > 1 ? 's' : ''} had errors. Check console for details.`
                : "All matchup data has been updated across all seasons."
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
      toast.error("Failed to refresh matchups", {
        description: error instanceof Error ? error.message : "Please try again or contact support."
      });
      console.error("Refresh error:", error);
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex gap-3">
          <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-medium text-yellow-800">Important Information</h4>
            <p className="text-sm text-yellow-700 mt-1">
              Refreshing matchups will re-sync all game data from ESPN, including scores, 
              winners, and points by scoring period (for two-week playoff games). This process 
              may take a few moments depending on the amount of data.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <label className="block text-sm font-medium text-gray-700">
          Refresh Type
        </label>
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={() => setRefreshType("current")}
            className={`p-4 border-2 rounded-lg transition-all ${
              refreshType === "current"
                ? "border-red-500 bg-red-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <Calendar className="h-6 w-6 mb-2 mx-auto text-gray-600" />
            <div className="font-medium">Current Season</div>
            <div className="text-sm text-gray-600 mt-1">
              Refresh only the current season&apos;s matchups
            </div>
          </button>
          
          <button
            onClick={() => setRefreshType("all")}
            className={`p-4 border-2 rounded-lg transition-all ${
              refreshType === "all"
                ? "border-red-500 bg-red-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <RefreshCw className="h-6 w-6 mb-2 mx-auto text-gray-600" />
            <div className="font-medium">All Seasons</div>
            <div className="text-sm text-gray-600 mt-1">
              Refresh current and historical matchups
            </div>
          </button>
        </div>
      </div>

      {refreshType === "all" && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Historical Years to Sync
          </label>
          <select
            value={historicalYears}
            onChange={(e) => setHistoricalYears(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value={5}>Last 5 years</option>
            <option value={10}>Last 10 years</option>
            <option value={15}>Last 15 years</option>
            <option value={20}>Last 20 years</option>
          </select>
        </div>
      )}

      <button
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="w-full px-4 py-3 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isRefreshing ? (
          <>
            <RefreshCw className="h-5 w-5 animate-spin" />
            Refreshing Matchups...
          </>
        ) : (
          <>
            <RefreshCw className="h-5 w-5" />
            Refresh {refreshType === "current" ? "Current Season" : "All"} Matchups
          </>
        )}
      </button>
      
      <p className="text-xs text-gray-500 text-center">
        Last sync information is not currently tracked. Consider running a refresh if matchup data seems outdated.
      </p>
    </div>
  );
}