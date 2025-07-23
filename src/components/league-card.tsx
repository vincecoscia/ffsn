"use client";

import Link from "next/link";
import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

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
      creditsRemaining: number;
    };
    role: "commissioner" | "member";
  };
}

export function LeagueCard({ league }: LeagueCardProps) {
  const [isRefetching, setIsRefetching] = useState(false);
  const debugClearAndRefetch = useAction(api.leagues.debugClearAndRefetch);

  const handleDebugRefetch = async () => {
    if (isRefetching) return;
    
    setIsRefetching(true);
    try {
      const result = await debugClearAndRefetch({ leagueId: league._id });
      if (result.success) {
        toast.success("League data refreshed successfully!", {
          description: "All league data has been cleared and refetched."
        });
      } else {
        toast.error("Failed to refresh league data", {
          description: result.error || "An unknown error occurred."
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
    <div className="bg-gray-800 rounded-lg p-6 border border-gray-700 hover:border-gray-600 transition-colors">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-xl font-bold text-white mb-1">{league.name}</h3>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span className="capitalize">{league.settings.scoringType}</span>
            <span>•</span>
            <span className="capitalize">{league.platform}</span>
            <span>•</span>
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${
              league.role === "commissioner" 
                ? "bg-red-900 text-red-200" 
                : "bg-gray-700 text-gray-300"
            }`}>
              {league.role}
            </span>
          </div>
        </div>
        
        <div className="text-right">
          <div className="text-sm text-gray-400">Credits</div>
          <div className="text-lg font-bold text-white">
            {league.subscription.creditsRemaining}
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center">
        <div className="text-sm text-gray-400">
          Subscription: <span className="capitalize text-white">{league.subscription.tier}</span>
        </div>
        
        <div className="flex gap-2">
          {league.role === "commissioner" && (
            <button
              onClick={handleDebugRefetch}
              disabled={isRefetching}
              className="bg-orange-600 text-white px-3 py-2 rounded-md text-sm font-semibold hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Clear all data and refetch from ESPN (Debug)"
            >
              {isRefetching ? "Syncing..." : "🔄 Debug Refetch"}
            </button>
          )}
          
          <Link
            href={`/leagues/${league._id}`}
            className="bg-red-600 text-white px-4 py-2 rounded-md font-semibold hover:bg-red-700 transition-colors cursor-pointer"
          >
            View League
          </Link>
        </div>
      </div>
    </div>
  );
}