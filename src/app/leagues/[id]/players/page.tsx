"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@/lib/auth";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertCircle, TrendingUp, TrendingDown } from "lucide-react";

interface PlayersPageProps {
  params: Promise<{ id: string }>;
}

interface Player {
  espnId: string;
  fullName: string;
  defaultPosition: string;
  proTeamAbbrev: string;
  ownerTeamId?: string;
  ownerTeamName?: string;
  injured?: boolean;
  injuryStatus?: string;
  active?: boolean;
  stats: {
    actualTotal: number;
    actualAverage: number;
    projectedTotal?: number;
  };
  hasLeagueSpecificStats?: boolean;
}

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "D/ST"];

// Free Agents Tab Component
function FreeAgentsTab({ 
  leagueId, 
  seasonId, 
  selectedPosition 
}: { 
  leagueId: Id<"leagues">; 
  seasonId: number; 
  selectedPosition: string;
}) {
  const freeAgentsData = useQuery(api.players.getFreeAgentsWithStats, {
    leagueId,
    seasonId,
    position: selectedPosition === "ALL" ? undefined : selectedPosition,
    limit: 100
  });

  const freeAgents = React.useMemo(() => freeAgentsData || [], [freeAgentsData]);

  if (!freeAgents.length) {
    return (
      <div className="text-center py-8">
        <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <p className="text-gray-500 mb-2">No free agents found.</p>
        <p className="text-sm text-gray-400">
          {selectedPosition === "ALL" 
            ? "All available players are currently rostered." 
            : `No available ${selectedPosition} players found.`}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">Rank</TableHead>
            <TableHead>Player</TableHead>
            <TableHead className="text-center">Pos</TableHead>
            <TableHead className="text-center">Team</TableHead>
            <TableHead className="text-right">Points</TableHead>
            <TableHead className="text-right">Avg/Game</TableHead>
            <TableHead className="text-right">% Owned</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {freeAgents.map((player, index) => {
            const avgPoints = player.stats?.actualAverage || 0;
            
            return (
              <TableRow key={player.espnId}>
                <TableCell className="font-bold text-gray-600">
                  {index + 1}
                </TableCell>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {player.fullName}
                    {player.injured && (
                      <Badge variant="destructive" className="text-xs">
                        {player.injuryStatus || 'INJ'}
                      </Badge>
                    )}
                    {player.hasLeagueSpecificStats && (
                      <Badge variant="outline" className="text-xs">
                        League Stats
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <Badge variant="secondary">
                    {player.defaultPosition}
                  </Badge>
                </TableCell>
                <TableCell className="text-center text-sm">
                  {player.proTeamAbbrev}
                </TableCell>
                <TableCell className="text-right font-semibold">
                  {player.stats?.actualTotal?.toFixed(1) || '0.0'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <span className="font-medium">{avgPoints.toFixed(1)}</span>
                    {avgPoints > 15 ? (
                      <TrendingUp className="h-4 w-4 text-green-500" />
                    ) : avgPoints < 8 ? (
                      <TrendingDown className="h-4 w-4 text-red-500" />
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right text-sm">
                  {player.ownership?.percentOwned?.toFixed(1) || '0.0'}%
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function PlayersPage({ params }: PlayersPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();
  
  const [selectedSeason, setSelectedSeason] = useState(2025);
  const [selectedPosition, setSelectedPosition] = useState("ALL");
  
  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });
  
  // Get available seasons for the league
  const leagueSeasons = useQuery(api.leagues.getLeagueSeasons, { leagueId });
  
  // Extract season IDs and sort them in descending order
  const availableSeasons = React.useMemo(() => {
    if (!leagueSeasons) return undefined;
    return leagueSeasons
      .map(season => season.seasonId)
      .sort((a, b) => b - a);
  }, [leagueSeasons]);
  
  // Get top performers using the optimized query (more players per position)
  const topPerformersData = useQuery(api.players.getTopPerformersByPosition, {
    leagueId,
    seasonId: selectedSeason,
    limit: 10 // Get top 10 per position instead of just 1
  });
  
  // Get single top performer per position for the summary cards
  const topPerformersSummaryData = useQuery(api.players.getTopPerformersByPosition, {
    leagueId,
    seasonId: selectedSeason,
    limit: 1
  });
  
  // Convert top performers data to a flat array for filtering
  const allTopPerformers = React.useMemo(() => {
    if (!topPerformersData) return [];
    
    const players: Player[] = [];
    Object.entries(topPerformersData).forEach(([position, positionPlayers]) => {
      if (Array.isArray(positionPlayers)) {
        players.push(...(positionPlayers as Player[]));
      }
    });
    
    return players;
  }, [topPerformersData]);
  
  // Filter top performers by position
  const filteredPlayers = React.useMemo(() => {
    let filtered = allTopPerformers;
    
    if (selectedPosition !== "ALL") {
      filtered = filtered.filter(player => player.defaultPosition === selectedPosition);
    }
    
    // Already sorted by points in the query, but ensure consistency
    return filtered.sort((a, b) => {
      const aPoints = a.stats?.actualTotal || 0;
      const bPoints = b.stats?.actualTotal || 0;
      return bPoints - aPoints;
    });
  }, [allTopPerformers, selectedPosition]);
  
  // Group top performers by position for position view
  const playersByPosition = React.useMemo(() => {
    const grouped = new Map<string, Player[]>();
    
    if (topPerformersData) {
      Object.entries(topPerformersData).forEach(([position, players]) => {
        if (Array.isArray(players)) {
          grouped.set(position, players as Player[]);
        }
      });
    }
    
    return grouped;
  }, [topPerformersData]);
  
  // Convert top performers summary data to Map for summary cards
  const topPerformers = React.useMemo(() => {
    const top = new Map<string, Player>();
    
    if (topPerformersSummaryData) {
      Object.entries(topPerformersSummaryData).forEach(([position, players]) => {
        if (Array.isArray(players) && players.length > 0) {
          top.set(position, players[0] as Player);
        }
      });
    }
    
    return top;
  }, [topPerformersSummaryData]);

  if (!userId || !league) {
    return <div>Loading...</div>;
  }

  const PlayerTable = ({ players }: { players: typeof filteredPlayers }) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">Rank</TableHead>
          <TableHead>Player</TableHead>
          <TableHead className="text-center">Pos</TableHead>
          <TableHead className="text-center">Team</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead className="text-right">Points</TableHead>
          <TableHead className="text-right">Avg/Game</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {players.map((player, index) => {
          const avgPoints = player.stats?.actualAverage || 0;
          
          return (
            <TableRow key={`${player.espnId}-${player.ownerTeamId}`}>
              <TableCell className="font-bold text-gray-600">
                {index + 1}
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  {player.fullName}
                  {player.injured && (
                    <Badge variant="destructive" className="text-xs">
                      {player.injuryStatus || 'INJ'}
                    </Badge>
                  )}
                  {player.hasLeagueSpecificStats && (
                    <Badge variant="outline" className="text-xs">
                      League Stats
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-center">
                <Badge variant="secondary">
                  {player.defaultPosition}
                </Badge>
              </TableCell>
              <TableCell className="text-center text-sm">
                {player.proTeamAbbrev}
              </TableCell>
              <TableCell>
                <div className="text-sm">
                  <div className="font-medium">{player.ownerTeamName}</div>
                </div>
              </TableCell>
              <TableCell className="text-right font-semibold">
                {player.stats?.actualTotal?.toFixed(1) || '0.0'}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <span className="font-medium">{avgPoints.toFixed(1)}</span>
                  {avgPoints > 15 ? (
                    <TrendingUp className="h-4 w-4 text-green-500" />
                  ) : avgPoints < 8 ? (
                    <TrendingDown className="h-4 w-4 text-red-500" />
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );

  return (
    <LeaguePageLayout 
      leagueId={leagueId} 
      currentUserId={userId}
      title="Players"
    >
      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-700 mb-1 block">
              Filter by Position
            </label>
            <Select value={selectedPosition} onValueChange={setSelectedPosition}>
              <SelectTrigger>
                <SelectValue placeholder="All Positions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Positions</SelectItem>
                {POSITIONS.map((pos) => (
                  <SelectItem key={pos} value={pos}>
                    {pos}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-700 mb-1 block">
              Season
            </label>
            <SeasonSelector
              currentSeason={2025}
              selectedSeason={selectedSeason}
              onSeasonChange={setSelectedSeason}
              availableSeasons={availableSeasons}
            />
          </div>
        </div>
      </div>

      {/* Top Performers Summary */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h2 className="text-xl font-bold mb-4">Top Performers by Position</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {POSITIONS.map(position => {
            const topPlayer = topPerformers.get(position);
            return (
              <Card key={position}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-gray-600">
                    {position}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {topPlayer ? (
                    <div>
                      <div className="font-bold text-sm truncate">
                        {topPlayer.fullName}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {topPlayer.ownerTeamName}
                      </div>
                      <div className="text-lg font-bold text-red-600 mt-1">
                        {topPlayer.stats?.actualTotal?.toFixed(1) || '0.0'}
                      </div>
                      {topPlayer.hasLeagueSpecificStats && (
                        <div className="text-xs text-green-600 mt-1">
                          League Scoring
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-gray-400 text-sm">No players</div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Player Tables */}
      <div className="bg-white rounded-lg shadow-sm">
        <Tabs defaultValue="top-performers" className="w-full">
          <div className="border-b border-gray-200">
            <TabsList className="h-auto p-0 bg-transparent">
              <TabsTrigger 
                value="top-performers" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-red-600 rounded-none px-6 py-4"
              >
                Top Performers
              </TabsTrigger>
              <TabsTrigger 
                value="by-position" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-red-600 rounded-none px-6 py-4"
              >
                By Position
              </TabsTrigger>
              <TabsTrigger 
                value="free-agents" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-red-600 rounded-none px-6 py-4"
              >
                Free Agents
              </TabsTrigger>
            </TabsList>
          </div>
          
          <TabsContent value="top-performers" className="p-0">
            <div className="p-6 border-b border-gray-200 bg-blue-50">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                <h3 className="text-lg font-semibold text-gray-900">League Top Performers</h3>
              </div>
              <p className="text-sm text-gray-600">
                Showing the top 10 performers in each position based on league-specific scoring rules.
              </p>
            </div>
            <div className="overflow-x-auto">
              <PlayerTable players={filteredPlayers} />
            </div>
          </TabsContent>
          
          <TabsContent value="by-position" className="p-0">
            <div className="divide-y divide-gray-200">
              {POSITIONS.map(position => {
                const positionPlayers = playersByPosition.get(position) || [];
                return (
                  <div key={position}>
                    <div className="px-6 py-4 bg-gray-50">
                      <h3 className="text-lg font-semibold text-gray-900">
                        Top {position} Players ({positionPlayers.length} shown)
                      </h3>
                      <p className="text-sm text-gray-600 mt-1">
                        Ranked by total fantasy points using league scoring rules
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <PlayerTable players={positionPlayers} />
                    </div>
                  </div>
                );
              })}
            </div>
          </TabsContent>
          
          <TabsContent value="free-agents" className="p-0">
            <FreeAgentsTab 
              leagueId={leagueId} 
              seasonId={selectedSeason} 
              selectedPosition={selectedPosition}
            />
          </TabsContent>
        </Tabs>
      </div>
    </LeaguePageLayout>
  );
}
