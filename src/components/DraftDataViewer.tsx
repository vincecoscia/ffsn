"use client";

import { useState, useEffect } from "react";
import { useQuery, useAction } from "convex/react";
import { ChevronDown, Search, RefreshCw, Download, FileStack } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingScreen, EmptyState, Spinner } from "@/components/broadcast";
import { cn } from "@/lib/utils";

interface DraftDataViewerProps {
  leagueId: Id<"leagues">;
}

export function DraftDataViewer({ leagueId }: DraftDataViewerProps) {
  // Get current/available seasons for the league
  const { currentSeason, availableSeasons } = useLeagueSeason(leagueId);

  const [selectedSeason, setSelectedSeason] = useState<number>(currentSeason);
  const [expandedRounds, setExpandedRounds] = useState<Set<number>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);

  // Action to fetch draft data
  const fetchDraftData = useAction(api.espnSync.fetchDraftDataForSeason);

  // Fetch draft data for the selected season
  const draftData = useQuery(api.leagues.getDraftData, {
    leagueId,
    seasonId: selectedSeason,
  });

  // Update selected season to most recent with draft data
  useEffect(() => {
    if (availableSeasons.length > 0 && !availableSeasons.includes(selectedSeason)) {
      setSelectedSeason(availableSeasons[0]);
    }
  }, [availableSeasons, selectedSeason]);

  const toggleRound = (round: number) => {
    const newExpanded = new Set(expandedRounds);
    if (newExpanded.has(round)) {
      newExpanded.delete(round);
    } else {
      newExpanded.add(round);
    }
    setExpandedRounds(newExpanded);
  };
  const handleSyncDraftData = async () => {
    setIsSyncing(true);
    try {
      const result = await fetchDraftData({
        leagueId,
        seasonId: selectedSeason,
      });

      if (result.success) {
        toast.success(result.message, {
          description: result.picksCount ? `${result.picksCount} draft picks loaded` : undefined,
        });
      } else {
        toast.error(result.message, {
          description: result.error,
        });
      }
    } catch (error) {
      toast.error("Failed to sync draft data", {
        description: error instanceof Error ? error.message : "Unknown error occurred",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const exportDraftData = () => {
    if (!draftData?.picks || draftData.picks.length === 0) {
      toast.error("No draft data to export");
      return;
    }

    // Create CSV content
    const headers = ["Overall Pick", "Round", "Pick", "Team", "Player", "Position", "Keeper"];
    const rows = draftData.picks.map(pick => [
      pick.overallPickNumber,
      pick.roundId,
      pick.roundPickNumber,
      pick.team?.name || `Team ${pick.teamId}`,
      pick.player?.fullName || `Player ${pick.playerId}`,
      pick.player?.defaultPosition || "Unknown",
      pick.keeper ? "Yes" : "No"
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map(row => row.join(","))
    ].join("\n");

    // Download CSV
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `draft-${selectedSeason}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    toast.success("Draft data exported successfully!");
  };

  const seasonSelect = (
    <Select value={String(selectedSeason)} onValueChange={(value) => setSelectedSeason(parseInt(value))}>
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {availableSeasons.map(season => (
          <SelectItem key={season} value={String(season)}>
            {season} season
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (!draftData) {
    return <LoadingScreen message="Loading draft data" />;
  }

  if (!draftData.hasData) {
    return (
      <div className="flex flex-col gap-6">
        {/* Header with season selector */}
        <div className="flex items-center gap-4">{seasonSelect}</div>

        {/* No data message with sync button */}
        <EmptyState
          icon={<FileStack className="size-6" strokeWidth={1.8} />}
          title={`No draft data for the ${selectedSeason} season`}
          description="Draft data can be synced from ESPN after the draft is completed."
          action={
            <Button onClick={handleSyncDraftData} disabled={isSyncing}>
              {isSyncing ? <Spinner size={16} className="[&>span]:bg-white" /> : <RefreshCw className="size-4" />}
              {isSyncing ? "Syncing draft data" : "Sync draft data from ESPN"}
            </Button>
          }
        />
      </div>
    );
  }

  // Group picks by round
  const picksByRound = draftData.picks.reduce((acc, pick) => {
    if (!acc[pick.roundId]) {
      acc[pick.roundId] = [];
    }
    acc[pick.roundId].push(pick);
    return acc;
  }, {} as Record<number, typeof draftData.picks>);

  // Filter picks based on search
  const filteredPicks = searchTerm
    ? draftData.picks.filter(pick =>
        pick.player?.fullName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        pick.team?.name?.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : null;

  return (
    <div className="flex flex-col gap-6">
      {/* Header Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-4">
          {seasonSelect}

          {draftData.draftInfo && (
            <div className="text-sm text-bc-text-2">
              <span className="bc-label-sm text-bc-text-3">Draft date</span>{" "}
              {draftData.draftSettings.availableDate ? new Date(draftData.draftSettings.availableDate).toLocaleString() : "Not scheduled"}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSyncDraftData} disabled={isSyncing} variant="outline" size="sm">
            {isSyncing ? <Spinner size={14} /> : <RefreshCw className="size-3.5" />}
            {isSyncing ? "Syncing" : "Refresh"}
          </Button>
          <Button onClick={exportDraftData} size="sm">
            <Download className="size-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-bc-text-3" />
        <Input
          type="text"
          placeholder="Search by player or team name..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Draft Settings Summary */}
      {draftData.draftSettings && (
        <div className="border border-bc-hairline bg-bc-panel-2 p-4">
          <span className="bc-label-sm text-bc-text-3">Draft settings</span>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            {Object.entries(draftData.draftSettings).slice(0, 8).map(([key, value]) => (
              <div key={key}>
                <span className="font-medium text-bc-text-2">{key}:</span>{" "}
                <span className="text-bc-ink">{String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search Results */}
      {filteredPicks && searchTerm && (
        <div className="border border-bc-hairline bg-bc-panel-2 p-4">
          <span className="bc-label-sm text-bc-text-3">Search results ({filteredPicks.length} picks)</span>
          <div className="mt-3 flex flex-col gap-2">
            {filteredPicks.map(pick => (
              <div key={pick.id} className="flex items-center justify-between border border-bc-hairline bg-bc-panel px-3 py-2">
                <div className="flex items-center gap-4">
                  <span className="bc-num text-sm text-bc-text-3">
                    #{pick.overallPickNumber}
                  </span>
                  <div>
                    <div className="font-medium text-bc-ink">{pick.player?.fullName || `Player ${pick.playerId}`}</div>
                    <div className="text-sm text-bc-text-2">
                      {pick.player?.defaultPosition} &middot; {pick.team?.name || `Team ${pick.teamId}`}
                    </div>
                  </div>
                </div>
                <div className="text-sm text-bc-text-3">
                  Round {pick.roundId}, Pick {pick.roundPickNumber}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Draft Picks by Round */}
      {!searchTerm && (
        <div className="flex flex-col gap-3">
          {Object.entries(picksByRound).map(([round, picks]) => (
            <div key={round} className="border border-bc-hairline bg-bc-panel">
              <button
                onClick={() => toggleRound(Number(round))}
                className="flex w-full items-center justify-between bg-bc-panel-2 px-4 py-3 transition-colors hover:bg-bc-hairline/40"
              >
                <span className="font-display text-[17px] font-bold uppercase tracking-[0.01em] text-bc-ink">Round {round}</span>
                <ChevronDown
                  className={cn(
                    "size-5 text-bc-text-3 transition-transform",
                    expandedRounds.has(Number(round)) && "rotate-180"
                  )}
                />
              </button>

              {expandedRounds.has(Number(round)) && (
                <div className="border-t border-bc-hairline">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="bc-label-sm text-bc-text-3">Pick</TableHead>
                        <TableHead className="bc-label-sm text-bc-text-3">Team</TableHead>
                        <TableHead className="bc-label-sm text-bc-text-3">Player</TableHead>
                        <TableHead className="bc-label-sm text-bc-text-3">Position</TableHead>
                        <TableHead className="bc-label-sm text-center text-bc-text-3">Keeper</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {picks.sort((a, b) => a.roundPickNumber - b.roundPickNumber).map(pick => (
                        <TableRow key={pick.id}>
                          <TableCell>
                            <div className="bc-num text-bc-ink">#{pick.overallPickNumber}</div>
                            <div className="text-bc-text-3">Pick {pick.roundPickNumber}</div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-bc-ink">{pick.team?.name || `Team ${pick.teamId}`}</div>
                            {pick.team?.abbreviation && (
                              <div className="text-bc-text-3">{pick.team.abbreviation}</div>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-bc-ink">
                              {pick.player?.fullName || `Player ${pick.playerId}`}
                            </div>
                            {pick.player?.proTeamAbbrev && (
                              <div className="text-bc-text-3">{pick.player.proTeamAbbrev}</div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{pick.player?.defaultPosition || "Unknown"}</Badge>
                          </TableCell>
                          <TableCell className="text-center">
                            {pick.keeper && <Badge variant="signal">Keeper</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
