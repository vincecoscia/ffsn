"use client";

import Link from "next/link";
import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";

interface LeagueCardProps {
  league: {
    _id: Id<"leagues">;
    name: string;
    platform: string;
    settings: {
      scoringType: string;
    };
    subscription: {
      tier: string;
        status?: string;
        paymentStatus?: "pending" | "completed" | "failed";
    };
    role: "commissioner" | "member";
  };
}

export function LeagueCard({ league }: LeagueCardProps) {
  const [isRefetching, setIsRefetching] = useState(false);
  const refreshLeagueData = useAction(api.espnSync.syncAllLeagueData);

  const handleDebugRefetch = async () => {
    if (isRefetching) return;
    
    setIsRefetching(true);
    try {
      const result = await refreshLeagueData({ leagueId: league._id });
      if (result.success) {
        toast.success("League data refreshed successfully!", {
          description: "All league data has been updated from ESPN."
        });
      } else {
        toast.error("Failed to refresh league data", {
          description: result.message || "An unknown error occurred."
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast.error("Failed to refresh league data", {
        description: errorMessage
      });
    } finally {
      setIsRefetching(false);
    }
  };

  return (
    <div className="bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-700 hover:border-gray-600 transition-colors">
      {/* Header: Name & Status */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg sm:text-xl font-bold text-white truncate">{league.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs sm:text-sm text-gray-400">
            <span className="capitalize">{league.settings.scoringType}</span>
            <span className="hidden sm:inline">•</span>
            <span className="capitalize">{league.platform}</span>
            <span className={`ml-0 sm:ml-1 px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-medium ${
              league.role === "commissioner"
                ? "bg-red-900 text-red-200"
                : "bg-gray-700 text-gray-300"
            }`}>
              {league.role}
            </span>
          </div>
        </div>

        {!(league.subscription.status === "paid") && (
          <div className="text-right shrink-0">
            <div className="text-xs text-gray-400">Status</div>
            <div className="text-sm sm:text-base font-bold text-white capitalize">
              {league.subscription.paymentStatus || "pending"}
            </div>
          </div>
        )}
      </div>

      {/* Subscription */}
      <div className="mt-3 sm:mt-4 text-xs sm:text-sm text-gray-400">
        Subscription: <span className="capitalize text-white">{league.subscription.tier}</span>
        {league.subscription.status === "paid" && (
          <span className="ml-2 text-green-400">(active)</span>
        )}
      </div>

      {/* Actions: stacked on mobile */}
      <div className="mt-4 flex flex-col sm:flex-row gap-2 sm:gap-3">
        {league.role === "commissioner" && (
          <Button
            onClick={handleDebugRefetch}
            disabled={isRefetching}
            className="w-full sm:w-auto bg-orange-600 hover:bg-orange-700 text-sm font-semibold"
            size="sm"
            title="Refresh league data from ESPN"
          >
            {isRefetching ? "Syncing..." : "Debug Refetch"}
          </Button>
        )}

        <Link
          href={`/leagues/${league._id}`}
          className="w-full sm:w-auto bg-red-600 text-white px-4 py-2 rounded-md text-center text-sm font-semibold hover:bg-red-700 transition-colors cursor-pointer"
        >
          View League
        </Link>
      </div>
    </div>
  );
}