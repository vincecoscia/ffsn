"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
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

interface DepthChartsPageProps {
  params: Promise<{ id: string }>;
}

interface Player {
  playerId: string;
  playerName: string;
  position: string;
  team: string;
  ownerTeamId?: string;
  ownerTeamName?: string;
  playerStats?: {
    appliedTotal?: number;
    projectedTotal?: number;
  };
}

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "D/ST"];

export default function DepthChartsPage({ params }: DepthChartsPageProps) {
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
  
  // Get teams for the selected season
  const teamsData = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId,
    seasonId: selectedSeason 
  });
  
  const teams = React.useMemo(() => teamsData || [], [teamsData]);
  
  // Aggregate all players from all teams
  const allPlayers = React.useMemo(() => {
    const playersMap = new Map<string, Player & { ownerTeamId: string; ownerTeamName: string }>();
    
    teams.forEach(team => {
      team.roster.forEach(player => {
        // Use a composite key to handle duplicate players
        const key = `${player.playerId}-${team._id}`;
        playersMap.set(key, {
          ...player,
          ownerTeamId: team._id,
          ownerTeamName: team.name,
        });
      });
    });
    
    return Array.from(playersMap.values());
  }, [teams]);
  
  // Filter and sort players by position
  const filteredPlayers = React.useMemo(() => {
    let filtered = allPlayers;
    
    if (selectedPosition !== "ALL") {
      filtered = filtered.filter(player => player.position === selectedPosition);
    }
    
    // Sort by points scored (descending)
    return filtered.sort((a, b) => {
      const aPoints = a.playerStats?.appliedTotal || 0;
      const bPoints = b.playerStats?.appliedTotal || 0;
      return bPoints - aPoints;
    });
  }, [allPlayers, selectedPosition]);
  
  // Group players by position for depth chart view
  const playersByPosition = React.useMemo(() => {
    const grouped = new Map<string, typeof filteredPlayers>();
    
    POSITIONS.forEach(pos => {
      const positionPlayers = allPlayers
        .filter(p => p.position === pos)
        .sort((a, b) => {
          const aPoints = a.playerStats?.appliedTotal || 0;
          const bPoints = b.playerStats?.appliedTotal || 0;
          return bPoints - aPoints;
        });
      
      grouped.set(pos, positionPlayers);
    });
    
    return grouped;
  }, [allPlayers]);
  
  // Get top performers by position
  const topPerformers = React.useMemo(() => {
    const top = new Map<string, typeof filteredPlayers[0]>();
    
    playersByPosition.forEach((players, position) => {
      if (players.length > 0) {
        top.set(position, players[0]);
      }
    });
    
    return top;
  }, [playersByPosition]);

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
          const currentWeek = league?.espnData?.currentScoringPeriod || 1;
          const avgPoints = (player.playerStats?.appliedTotal || 0) / Math.max(currentWeek - 1, 1);
          
          return (
            <TableRow key={`${player.playerId}-${player.ownerTeamId}`}>
              <TableCell className="font-bold text-gray-600">
                {index + 1}
              </TableCell>
              <TableCell className="font-medium">
                {player.playerName}
              </TableCell>
              <TableCell className="text-center">
                <Badge variant="secondary">
                  {player.position}
                </Badge>
              </TableCell>
              <TableCell className="text-center text-sm">
                {player.team}
              </TableCell>
              <TableCell>
                <div className="text-sm">
                  <div className="font-medium">{player.ownerTeamName}</div>
                </div>
              </TableCell>
              <TableCell className="text-right font-semibold">
                {player.playerStats?.appliedTotal?.toFixed(1) || '0.0'}
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
      title="Depth Charts"
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
                        {topPlayer.playerName}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {topPlayer.ownerTeamName}
                      </div>
                      <div className="text-lg font-bold text-red-600 mt-1">
                        {topPlayer.playerStats?.appliedTotal?.toFixed(1) || '0.0'}
                      </div>
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

      {/* Depth Chart Tables */}
      <div className="bg-white rounded-lg shadow-sm">
        <Tabs defaultValue="all" className="w-full">
          <div className="border-b border-gray-200">
            <TabsList className="h-auto p-0 bg-transparent">
              <TabsTrigger 
                value="all" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-red-600 rounded-none px-6 py-4"
              >
                All Players
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
          
          <TabsContent value="all" className="p-0">
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
                        {position} ({positionPlayers.length} players)
                      </h3>
                    </div>
                    <div className="overflow-x-auto">
                      <PlayerTable players={positionPlayers.slice(0, 20)} />
                    </div>
                  </div>
                );
              })}
            </div>
          </TabsContent>
          
          <TabsContent value="free-agents" className="p-6">
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500 mb-2">Free agent tracking is not yet available.</p>
              <p className="text-sm text-gray-400">
                This feature will show available players not currently on any roster.
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </LeaguePageLayout>
  );
}