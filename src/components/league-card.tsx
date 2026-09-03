"use client";

import Link from "next/link";
import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, StatBlock } from "@/components/broadcast";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

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
  // The two values `credits.hasActivePass` treats as active ("active" is the
  // current value, "paid" is the legacy alias written by pre-Broadcast-Desk
  // purchases).
  const isActive = league.subscription.status === "active" || league.subscription.status === "paid";

  const handleRefetch = async () => {
    if (isRefetching) return;

    setIsRefetching(true);
    try {
      // Current season only (ESPN refresh audit, Sept 2026, section 5.v) - the old default of
      // 10 historical years turned one dashboard click into several hundred ESPN requests with
      // no warning. A past season never goes stale on its own, so there's nothing routine to
      // catch up on here; use the league's own "Full re-import" settings tool for that.
      const result = await refreshLeagueData({ leagueId: league._id, includeCurrentSeason: true, historicalYears: 0 });
      if (result.success) {
        toast.success("Current season refreshed successfully!", {
          description: "Teams, rosters, matchups and scores have been updated from ESPN."
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
    <Panel padding="md" className="flex flex-col gap-5">
      <div className="flex min-w-0 flex-col gap-2.5">
        <h3 className="font-display truncate text-[22px] font-extrabold tracking-[0.01em] text-bc-ink uppercase">
          {league.name}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{league.settings.scoringType}</Badge>
          <Badge variant="outline">{league.platform}</Badge>
          <Badge variant={league.role === "commissioner" ? "red" : "secondary"}>
            {league.role}
          </Badge>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-bc-hairline pt-4">
        <StatBlock
          label="Subscription"
          value={<span className="capitalize">{league.subscription.tier}</span>}
        />
        <Badge variant={isActive ? "win" : "outline"}>
          {isActive ? "Active" : "Pass not active"}
        </Badge>
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row">
        {league.role === "commissioner" && (
          <Button
            type="button"
            onClick={handleRefetch}
            disabled={isRefetching}
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            title="Refresh the current season from ESPN"
          >
            <RefreshCw className={cn("size-4", isRefetching && "animate-spin")} strokeWidth={2} />
            {isRefetching ? "Syncing…" : "Sync current season"}
          </Button>
        )}

        <Button asChild size="sm" className="w-full sm:ml-auto sm:w-auto">
          <Link href={`/leagues/${league._id}`}>View league</Link>
        </Button>
      </div>
    </Panel>
  );
}
