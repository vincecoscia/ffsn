"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Users, Trophy, TrendingUp } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface TeamsPageProps {
  params: Promise<{ id: string }>;
}

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  owner: string;
  ownerInfo?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
  };
  record: {
    wins: number;
    losses: number;
    ties: number;
    pointsFor?: number;
    pointsAgainst?: number;
    playoffSeed?: number;
  };
  roster: Array<{
    playerId: string;
    playerName: string;
    position: string;
    team: string;
    lineupSlotId?: number;
    playerStats?: {
      appliedTotal?: number;
      projectedTotal?: number;
    };
  }>;
}

const POSITION_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "K", "D/ST", "BE"];

export default function TeamsPage({ params }: TeamsPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();
  
  const [selectedSeason, setSelectedSeason] = useState(2025);
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  
  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });
  
  // Get teams for the selected season
  const teams = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId,
    seasonId: selectedSeason 
  }) || [];
  
  // Sort teams by record
  const sortedTeams = React.useMemo(() => {
    return [...teams].sort((a, b) => {
      if (a.record.wins !== b.record.wins) {
        return b.record.wins - a.record.wins;
      }
      return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
    });
  }, [teams]);

  const toggleTeamExpansion = (teamId: string) => {
    setExpandedTeams(prev => {
      const newSet = new Set(prev);
      if (newSet.has(teamId)) {
        newSet.delete(teamId);
      } else {
        newSet.add(teamId);
      }
      return newSet;
    });
  };

  const sortRosterByPosition = (roster: Team['roster']) => {
    return [...roster].sort((a, b) => {
      const aIndex = POSITION_ORDER.indexOf(a.position);
      const bIndex = POSITION_ORDER.indexOf(b.position);
      
      if (aIndex === -1 && bIndex === -1) return 0;
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      
      return aIndex - bIndex;
    });
  };

  if (!userId || !league) {
    return <div>Loading...</div>;
  }

  return (
    <LeaguePageLayout 
      leagueId={leagueId} 
      currentUserId={userId}
      title="Teams"
    >
      {/* Season Selector */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-bold">{selectedSeason} Season Teams</h2>
          <SeasonSelector
            currentSeason={2025}
            selectedSeason={selectedSeason}
            onSeasonChange={setSelectedSeason}
          />
        </div>
      </div>

      {/* Teams Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {sortedTeams.map((team, index) => {
          const isExpanded = expandedTeams.has(team._id);
          const totalGames = team.record.wins + team.record.losses + team.record.ties;
          const winPercentage = totalGames > 0 ? (team.record.wins / totalGames) : 0;
          const pointDiff = (team.record.pointsFor || 0) - (team.record.pointsAgainst || 0);
          
          return (
            <Card key={team._id} className="overflow-hidden">
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    {team.logo && (
                      <img 
                        src={team.logo} 
                        alt={`${team.name} logo`}
                        className="w-16 h-16 rounded-lg"
                      />
                    )}
                    <div>
                      <CardTitle className="text-xl">{team.name}</CardTitle>
                      <CardDescription className="text-base">
                        {team.ownerInfo?.displayName || team.owner}
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-lg px-3 py-1">
                    #{index + 1}
                  </Badge>
                </div>
              </CardHeader>
              
              <CardContent className="space-y-4">
                {/* Team Stats */}
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center justify-center gap-1 text-gray-600 mb-1">
                      <Trophy className="h-4 w-4" />
                      <span className="text-xs">Record</span>
                    </div>
                    <div className="font-bold text-lg">
                      {team.record.wins}-{team.record.losses}
                      {team.record.ties > 0 && `-${team.record.ties}`}
                    </div>
                    <div className="text-xs text-gray-500">
                      {(winPercentage * 100).toFixed(0)}% Win
                    </div>
                  </div>
                  
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center justify-center gap-1 text-gray-600 mb-1">
                      <TrendingUp className="h-4 w-4" />
                      <span className="text-xs">Points For</span>
                    </div>
                    <div className="font-bold text-lg">
                      {team.record.pointsFor?.toFixed(1) || '0.0'}
                    </div>
                    <div className="text-xs text-gray-500">
                      {((team.record.pointsFor || 0) / Math.max(totalGames, 1)).toFixed(1)} PPG
                    </div>
                  </div>
                  
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center justify-center gap-1 text-gray-600 mb-1">
                      <Users className="h-4 w-4" />
                      <span className="text-xs">Diff</span>
                    </div>
                    <div className={`font-bold text-lg ${pointDiff > 0 ? 'text-green-600' : pointDiff < 0 ? 'text-red-600' : ''}`}>
                      {pointDiff > 0 && '+'}{pointDiff.toFixed(1)}
                    </div>
                    <div className="text-xs text-gray-500">
                      vs {team.record.pointsAgainst?.toFixed(1) || '0.0'}
                    </div>
                  </div>
                </div>
                
                {/* Roster Collapsible */}
                <Collapsible open={isExpanded} onOpenChange={() => toggleTeamExpansion(team._id)}>
                  <CollapsibleTrigger asChild>
                    <Button variant="outline" className="w-full">
                      <span>View Roster ({team.roster.length} players)</span>
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4 ml-2" />
                      ) : (
                        <ChevronDown className="h-4 w-4 ml-2" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  
                  <CollapsibleContent className="mt-4">
                    <div className="border rounded-lg overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-gray-50">
                            <TableHead>Player</TableHead>
                            <TableHead className="text-center">Pos</TableHead>
                            <TableHead className="text-center">Team</TableHead>
                            <TableHead className="text-right">Points</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sortRosterByPosition(team.roster).map((player, idx) => (
                            <TableRow key={`${player.playerId}-${idx}`}>
                              <TableCell className="font-medium">
                                {player.playerName}
                              </TableCell>
                              <TableCell className="text-center">
                                <Badge variant={player.lineupSlotId === 20 ? "secondary" : "default"}>
                                  {player.position}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-center text-sm">
                                {player.team}
                              </TableCell>
                              <TableCell className="text-right">
                                {player.playerStats?.appliedTotal?.toFixed(1) || '-'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </LeaguePageLayout>
  );
}