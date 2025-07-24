"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RefreshCw, Users, AlertCircle } from "lucide-react";
import { toast } from "sonner";

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

export function PlayerManagement({ leagueId, season = 2025 }: PlayerManagementProps) {
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
  const syncLeaguePlayersComplete = useAction(api.playerSync.syncAllLeaguePlayersComplete);
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
        toast.loading(`✓ Synced ${allPlayersResult.playersCount} NFL players. Now syncing league data...`, { id: toastId });
        setSyncProgress(50);
        
        // Step 2: Sync league-specific data
        const leagueResult = await syncLeaguePlayersComplete({ leagueId, season });
        
        if (leagueResult.status === "success") {
          toast.success(`🎉 Full sync complete! Synced ${allPlayersResult.playersCount} NFL players and ${leagueResult.totalPlayersProcessed} league players in ${leagueResult.batches} batches`, { 
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
          toast.success(`✓ League sync complete! Updated ${leagueResult.totalPlayersProcessed} league players in ${leagueResult.batches} batches`, { 
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
  
  // Initial sync check
  useEffect(() => {
    if (!syncStatus || !syncStatus.lastFullSync) {
      // Prompt for initial sync
      toast.info("Player database needs to be initialized", {
        action: {
          label: "Sync Now",
          onClick: handleFullSync,
        },
      });
    }
  }, [syncStatus, handleFullSync]);
  
  const handleLeagueSync = async () => {
    setIsSyncing(true);
    
    const toastId = toast.loading('Updating league player statuses...');
    
    try {
      const result = await syncLeaguePlayersBatch({ leagueId, season, maxBatches: 2 });
      
      if (result.status === "complete" || result.status === "partial") {
        const statusText = result.status === "complete" ? "✓ Complete" : "⚠️ Partial (more data available)";
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
  
  return (
    <div className="space-y-6">
      {/* Sync Status Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Player Database Status</span>
            <div className="flex gap-2">
              <Button
                onClick={handleLeagueSync}
                disabled={isSyncing}
                size="sm"
                variant="outline"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? "animate-spin" : ""}`} />
                Update League Players
              </Button>
              <Button
                onClick={handleFullSync}
                disabled={isSyncing}
                size="sm"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? "animate-spin" : ""}`} />
                Full Sync
              </Button>
            </div>
          </CardTitle>
          <CardDescription>
            Manage player data synchronization with ESPN
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isSyncing && (
            <div className="mb-4">
              <Progress value={syncProgress} className="mb-2" />
              <p className="text-sm text-muted-foreground">
                Syncing player data... {syncProgress}%
              </p>
            </div>
          )}
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Total Players</p>
              <p className="text-2xl font-bold">
                {syncStatus?.totalPlayers || 0}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Last Full Sync</p>
              <p className="text-sm text-muted-foreground">
                {formatLastSync(syncStatus?.lastFullSync)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Status</p>
              <Badge variant={syncStatus?.status === "error" ? "destructive" : "default"}>
                {syncStatus?.status || "Not Synced"}
              </Badge>
            </div>
          </div>
          
          {syncStatus?.error && (
            <div className="mt-4 p-4 bg-destructive/10 rounded-lg flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
              <div>
                <p className="font-medium text-destructive">Sync Error</p>
                <p className="text-sm text-muted-foreground">{syncStatus.error}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Player Tabs */}
      <Tabs defaultValue="free-agents" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="free-agents">Free Agents</TabsTrigger>
          <TabsTrigger value="all-players">All Players</TabsTrigger>
          <TabsTrigger value="trending">Trending</TabsTrigger>
        </TabsList>
        
        <TabsContent value="free-agents" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Top Available Players</CardTitle>
              <CardDescription>
                Best free agents available in your league
              </CardDescription>
            </CardHeader>
            <CardContent>
              {freeAgents ? (
                <div className="space-y-2">
                  {freeAgents.map((player: Player) => (
                    <div
                      key={player._id}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div>
                        <p className="font-medium">{player.fullName}</p>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Badge variant="outline">{player.defaultPosition}</Badge>
                          <span>{player.proTeamAbbrev || "FA"}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium">
                          {player.ownership.percentOwned.toFixed(1)}% owned
                        </p>
                        {player.stats?.averagePoints && (
                          <p className="text-sm text-muted-foreground">
                            {player.stats.averagePoints.toFixed(1)} avg pts
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No player data available</p>
                  <p className="text-sm mt-1">Run a sync to load players</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        
        <TabsContent value="all-players">
          <Card>
            <CardHeader>
              <CardTitle>All Players</CardTitle>
              <CardDescription>
                Browse and search all NFL players
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Player search and filtering coming soon...
              </p>
            </CardContent>
          </Card>
        </TabsContent>
        
        <TabsContent value="trending">
          <Card>
            <CardHeader>
              <CardTitle>Trending Players</CardTitle>
              <CardDescription>
                Players with significant ownership changes
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                Trending analysis coming soon...
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}