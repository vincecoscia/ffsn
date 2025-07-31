"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Id } from "../../convex/_generated/dataModel";
import { RefreshCw, Calendar, AlertTriangle } from "lucide-react";
import { triggerHistoricalSync, getCurrentLeagueSync } from "../app/sync/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
    <div className="space-y-4">
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex gap-3">
          <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-medium text-yellow-800">Important Information</h4>
            <p className="text-sm text-yellow-700 mt-1">
              Syncing league data will refresh all information from ESPN, including teams, 
              owners, logos, rosters, matchups, scores, and playoff details. This process 
              may take a few moments depending on the amount of data.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-sm font-medium text-gray-700">
          Refresh Type
        </Label>
        <div className="grid grid-cols-2 gap-4">
          <Button
            variant={refreshType === "current" ? "default" : "outline"}
            onClick={() => setRefreshType("current")}
            className={`p-4 h-auto flex-col ${
              refreshType === "current"
                ? "border-red-500 bg-red-50 text-gray-900 hover:bg-red-100"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <Calendar className="h-6 w-6 mb-2 text-gray-600" />
            <div className="font-medium">Current Season</div>
            <div className="text-sm text-gray-600 mt-1">
              Sync only the current season&apos;s data
            </div>
          </Button>
          
          <Button
            variant={refreshType === "all" ? "default" : "outline"}
            onClick={() => setRefreshType("all")}
            className={`p-4 h-auto flex-col ${
              refreshType === "all"
                ? "border-red-500 bg-red-50 text-gray-900 hover:bg-red-100"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <RefreshCw className="h-6 w-6 mb-2 text-gray-600" />
            <div className="font-medium">All Seasons</div>
            <div className="text-sm text-gray-600 mt-1">
              Sync current and historical league data
            </div>
          </Button>
        </div>
      </div>

      {refreshType === "all" && (
        <div>
          <Label className="text-sm font-medium text-gray-700">
            Historical Years to Sync
          </Label>
          <Select
            value={historicalYears.toString()}
            onValueChange={(value) => setHistoricalYears(Number(value))}
          >
            <SelectTrigger className="w-full mt-2">
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

      <Button
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="w-full bg-red-600 hover:bg-red-700"
        size="lg"
      >
        {isRefreshing ? (
          <>
            <RefreshCw className="h-5 w-5 animate-spin" />
            Syncing League Data...
          </>
        ) : (
          <>
            <RefreshCw className="h-5 w-5" />
            Sync {refreshType === "current" ? "Current Season" : "All"} League Data
          </>
        )}
      </Button>
      
      <p className="text-xs text-gray-500 text-center">
        Last sync information is not currently tracked. Consider running a sync if league data seems outdated.
      </p>
    </div>
  );
}