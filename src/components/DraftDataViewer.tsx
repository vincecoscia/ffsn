"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";

interface DraftDataViewerProps {
  leagueId: Id<"leagues">;
}

export function DraftDataViewer({ leagueId }: DraftDataViewerProps) {
  const [selectedSeason, setSelectedSeason] = useState<number>(2025);
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

  // Get available seasons
  const leagueSeasons = useQuery(api.leagues.getLeagueSeasons, { leagueId });
  const availableSeasons = useMemo(() => {
    return leagueSeasons?.map(s => s.seasonId).sort((a, b) => b - a) || [];
  }, [leagueSeasons]);

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

  if (!draftData) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600 mx-auto"></div>
        <p className="text-gray-600 mt-2">Loading draft data...</p>
      </div>
    );
  }

  if (!draftData.hasData) {
    return (
      <div className="space-y-6">
        {/* Header with season selector */}
        <div className="flex items-center gap-4">
          <select
            value={selectedSeason}
            onChange={(e) => setSelectedSeason(parseInt(e.target.value))}
            className="px-4 py-2 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {availableSeasons.map(season => (
              <option key={season} value={season}>
                {season} Season
              </option>
            ))}
          </select>
        </div>

        {/* No data message with sync button */}
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="text-gray-600 mt-4 text-lg font-medium">No draft data available for the {selectedSeason} season</p>
          <p className="text-gray-500 text-sm mt-2">
            Draft data can be synced from ESPN after the draft is completed
          </p>
          <button
            onClick={handleSyncDraftData}
            disabled={isSyncing}
            className="mt-6 px-6 py-3 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {isSyncing ? (
              <>
                <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Syncing Draft Data...
              </>
            ) : (
              <>
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Sync Draft Data from ESPN
              </>
            )}
          </button>
        </div>
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
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div className="flex items-center gap-4">
          <select
            value={selectedSeason}
            onChange={(e) => setSelectedSeason(parseInt(e.target.value))}
            className="px-4 py-2 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {availableSeasons.map(season => (
              <option key={season} value={season}>
                {season} Season
              </option>
            ))}
          </select>
          
          {draftData.draftInfo && (
            <div className="text-sm text-gray-600">
              <span className="font-medium">Draft Date:</span>{" "}
              {draftData.draftInfo.draftDate 
                ? new Date(draftData.draftInfo.draftDate).toLocaleDateString()
                : "Not scheduled"}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleSyncDraftData}
            disabled={isSyncing}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {isSyncing ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Syncing...
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh
              </>
            )}
          </button>
          <button
            onClick={exportDraftData}
            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <input
          type="text"
          placeholder="Search by player or team name..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full px-4 py-2 pl-10 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
        />
        <svg className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>

      {/* Draft Settings Summary */}
      {draftData.draftSettings && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="font-semibold text-blue-900 mb-2">Draft Settings</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {Object.entries(draftData.draftSettings).slice(0, 8).map(([key, value]) => (
              <div key={key}>
                <span className="text-blue-700 font-medium">{key}:</span>{" "}
                <span className="text-blue-900">{String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search Results */}
      {filteredPicks && searchTerm && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <h3 className="font-semibold text-gray-900 mb-3">
            Search Results ({filteredPicks.length} picks)
          </h3>
          <div className="space-y-2">
            {filteredPicks.map(pick => (
              <div key={pick.id} className="flex items-center justify-between p-2 bg-white rounded border border-gray-200">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-gray-500">
                    #{pick.overallPickNumber}
                  </span>
                  <div>
                    <div className="font-medium">{pick.player?.fullName || `Player ${pick.playerId}`}</div>
                    <div className="text-sm text-gray-600">
                      {pick.player?.defaultPosition} • {pick.team?.name || `Team ${pick.teamId}`}
                    </div>
                  </div>
                </div>
                <div className="text-sm text-gray-500">
                  Round {pick.roundId}, Pick {pick.roundPickNumber}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Draft Picks by Round */}
      {!searchTerm && (
        <div className="space-y-3">
          {Object.entries(picksByRound).map(([round, picks]) => (
            <div key={round} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={() => toggleRound(Number(round))}
                className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors flex items-center justify-between"
              >
                <h3 className="font-semibold text-gray-900">Round {round}</h3>
                <svg
                  className={`h-5 w-5 text-gray-600 transform transition-transform ${
                    expandedRounds.has(Number(round)) ? "rotate-180" : ""
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              {expandedRounds.has(Number(round)) && (
                <div className="border-t border-gray-200">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Pick</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Team</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Player</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Position</th>
                        <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">Keeper</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {picks.sort((a, b) => a.roundPickNumber - b.roundPickNumber).map(pick => (
                        <tr key={pick.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm">
                            <div className="font-medium">#{pick.overallPickNumber}</div>
                            <div className="text-gray-500">Pick {pick.roundPickNumber}</div>
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <div className="font-medium">{pick.team?.name || `Team ${pick.teamId}`}</div>
                            {pick.team?.abbreviation && (
                              <div className="text-gray-500">{pick.team.abbreviation}</div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <div className="font-medium">
                              {pick.player?.fullName || `Player ${pick.playerId}`}
                            </div>
                            {pick.player?.proTeamAbbrev && (
                              <div className="text-gray-500">{pick.player.proTeamAbbrev}</div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span className="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-800 rounded">
                              {pick.player?.defaultPosition || "Unknown"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-center">
                            {pick.keeper && (
                              <span className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded">
                                Keeper
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}