"use client";

import { useState, useCallback } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RefreshCw, Users, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { Panel, SectionHeader, Chip, StatBlock, EmptyState } from "@/components/broadcast";

interface PlayerManagementProps {
  leagueId: Id<"leagues">;
  season?: number;
}

interface Player {
  _id: string;
  fullName: string;
  defaultPosition: string;
  proTeamAbbrev?: string;
  ownership: {
    percentOwned: number;
  };
  stats?: {
    averagePoints?: number;
    seasonProjectedTotal?: number;
    seasonActualTotal?: number;
    lastWeekPoints?: number;
  };
}

const SYNC_STATUS_CHIP: Record<string, { variant: "win" | "signal" | "red"; label: string; live?: boolean }> = {
  completed: { variant: "win", label: "Completed" },
  syncing: { variant: "signal", label: "Syncing", live: true },
  failed: { variant: "red", label: "Failed" },
};

export function PlayerManagement({ leagueId, season: seasonProp }: PlayerManagementProps) {
  // Default to the league's current season when no season is explicitly provided
  const { currentSeason } = useLeagueSeason(leagueId);
  const season = seasonProp ?? currentSeason;

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);

  // Get sync status
  const syncStatus = useQuery(api.playerSyncInternal.getSyncStatus, { season });

  // Get free agents
  const freeAgents = useQuery(api.playerSyncInternal.getLeagueFreeAgents, {
    leagueId,
    limit: 20,
  });

  // Actions
  const syncAllPlayers = useAction(api.playerSync.syncAllPlayers);
  const syncLeaguePlayersComplete = useAction(api.playerSync.completeLeagueSync);
  const syncLeaguePlayersBatch = useAction(api.playerSync.syncAllLeaguePlayers);

  const handleFullSync = useCallback(async () => {
    setIsSyncing(true);
    setSyncProgress(0);

    // Create a single toast that we'll update throughout the process
    const toastId = toast.loading('Starting full sync...');

    try {
      // Step 1: Sync all players from ESPN
      toast.loading('Fetching all NFL players from ESPN...', { id: toastId });
      setSyncProgress(10);

      const allPlayersResult = await syncAllPlayers({ season, forceUpdate: true, leagueId });

      if (allPlayersResult.status === "success") {
        toast.loading(`Synced ${allPlayersResult.playersCount} NFL players. Now syncing league data...`, { id: toastId });
        setSyncProgress(50);

        // Step 2: Sync league-specific data
        const leagueResult = await syncLeaguePlayersComplete({ leagueId, season });

        if (leagueResult.status === "success") {
          toast.success(`Full sync complete! Synced ${allPlayersResult.playersCount} NFL players and ${leagueResult.totalPlayersProcessed} league players in ${leagueResult.batches} batches`, {
            id: toastId,
            duration: 5000
          });
          setSyncProgress(100);

          // Auto-hide progress after a moment
          setTimeout(() => setSyncProgress(0), 2000);
        } else {
          throw new Error("League sync failed");
        }
      } else if (allPlayersResult.status === "skipped") {
        // NFL players were skipped, still sync league data
        toast.loading(`NFL players up to date. Syncing league data...`, { id: toastId });
        setSyncProgress(50);

        const leagueResult = await syncLeaguePlayersComplete({ leagueId, season });

        if (leagueResult.status === "success") {
          toast.success(`League sync complete! Updated ${leagueResult.totalPlayersProcessed} league players in ${leagueResult.batches} batches`, {
            id: toastId,
            duration: 4000
          });
          setSyncProgress(100);
          setTimeout(() => setSyncProgress(0), 2000);
        }
      }
    } catch (error) {
      toast.error(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`, {
        id: toastId,
        duration: 6000
      });
      setSyncProgress(0);
    } finally {
      setIsSyncing(false);
    }
  }, [syncAllPlayers, syncLeaguePlayersComplete, leagueId, season]);

  const handleLeagueSync = async () => {
    setIsSyncing(true);

    const toastId = toast.loading('Updating league player statuses...');

    try {
      const result = await syncLeaguePlayersBatch({ leagueId, season, maxBatches: 2 });

      if (result.status === "complete" || result.status === "partial") {
        const statusText = result.status === "complete" ? "Complete" : "Partial (more data available)";
        toast.success(`${statusText}: Updated ${result.totalPlayersProcessed} player statuses`, {
          id: toastId,
          duration: 3000
        });
      }
    } catch (error) {
      toast.error(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`, {
        id: toastId,
        duration: 5000
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const formatLastSync = (timestamp?: number) => {
    if (!timestamp) return "Never";

    const hours = (Date.now() - timestamp) / (1000 * 60 * 60);
    if (hours < 1) return "Less than 1 hour ago";
    if (hours < 24) return `${Math.floor(hours)} hours ago`;
    return `${Math.floor(hours / 24)} days ago`;
  };

  const statusChip = syncStatus?.status ? SYNC_STATUS_CHIP[syncStatus.status] : undefined;

  return (
    <div className="flex flex-col gap-6">
      {/* Sync Status */}
      <Panel lifted padding="md">
        <SectionHeader
          size="sm"
          title="Player database status"
          kicker="Sync with ESPN"
          actions={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={handleLeagueSync} disabled={isSyncing} size="sm" variant="outline">
                <RefreshCw className={`size-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                Update league players
              </Button>
              <Button onClick={handleFullSync} disabled={isSyncing} size="sm">
                <RefreshCw className={`size-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                Full sync
              </Button>
            </div>
          }
        />

        {isSyncing && (
          <div className="mt-5">
            <Progress value={syncProgress} />
            <p className="mt-2 bc-label-sm text-bc-text-3">Syncing player data&hellip; {syncProgress}%</p>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
          <StatBlock label="Total players" value={syncStatus?.totalPlayers ?? 0} />
          <div className="flex flex-col gap-1.5">
            <span className="bc-label-sm text-bc-text-3">Last full sync</span>
            <span className="text-[15px] text-bc-text-2">{formatLastSync(syncStatus?.completedAt)}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="bc-label-sm text-bc-text-3">Status</span>
            <div>
              <Chip variant={statusChip?.variant ?? "outline"} live={statusChip?.live}>
                {statusChip?.label ?? "Not synced"}
              </Chip>
            </div>
          </div>
        </div>

        {syncStatus?.error && (
          <div className="mt-5 flex items-start gap-3 border border-bc-red-deep bg-bc-red-deep/10 p-4">
            <AlertCircle className="mt-0.5 size-5 flex-none text-bc-red-text" />
            <div>
              <p className="font-display text-[15px] font-bold uppercase tracking-[0.02em] text-bc-red-text">Sync error</p>
              <p className="mt-1 text-sm text-bc-text-2">{syncStatus.error}</p>
            </div>
          </div>
        )}
      </Panel>

      {/* Player Tabs */}
      <Tabs defaultValue="free-agents" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="free-agents">Free agents</TabsTrigger>
          <TabsTrigger value="all-players">All players</TabsTrigger>
          <TabsTrigger value="trending">Trending</TabsTrigger>
        </TabsList>

        <TabsContent value="free-agents" className="mt-4">
          <Panel padding="md">
            <SectionHeader size="sm" title="Top available players" kicker="Free agents" />
            <div className="mt-5">
              {freeAgents ? (
                <div className="flex flex-col">
                  {freeAgents.map((player: Player) => (
                    <div
                      key={player._id}
                      className="flex items-center justify-between gap-4 border-t border-bc-hairline py-3 first:border-t-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-sans text-[15px] font-semibold text-bc-ink">{player.fullName}</p>
                        <div className="mt-1 flex items-center gap-2 text-sm text-bc-text-3">
                          <Badge variant="outline">{player.defaultPosition}</Badge>
                          <span>{player.proTeamAbbrev || "FA"}</span>
                        </div>
                      </div>
                      <div className="flex-none text-right">
                        <p className="bc-num text-[16px] text-bc-ink">
                          {player.ownership.percentOwned.toFixed(1)}% owned
                        </p>
                        {player.stats?.averagePoints && (
                          <p className="text-sm text-bc-text-3">
                            {player.stats.averagePoints.toFixed(1)} avg pts
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Users className="size-6" strokeWidth={1.8} />}
                  title="No player data available"
                  description="Run a sync to load players."
                />
              )}
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="all-players" className="mt-4">
          <Panel padding="md">
            <SectionHeader size="sm" title="All players" kicker="Browse" />
            <p className="mt-5 text-sm text-bc-text-2">Player search and filtering coming soon.</p>
          </Panel>
        </TabsContent>

        <TabsContent value="trending" className="mt-4">
          <Panel padding="md">
            <SectionHeader size="sm" title="Trending players" kicker="Ownership" />
            <p className="mt-5 text-sm text-bc-text-2">Trending analysis coming soon.</p>
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
