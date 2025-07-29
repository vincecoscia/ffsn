"use client";

import React from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { TrendingUp, Users, Trophy, Flame, Zap, Swords } from "lucide-react";
// Table components removed as they're not currently used

interface RivalriesTabProps {
  leagueId: Id<"leagues">;
}

interface Team {
  _id: Id<"teams">;
  name: string;
  owner: string;
  externalId: string;
  ownerInfo?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
  };
}

interface Rivalry {
  teamA: Team;
  teamB: Team;
  teamAWins: number;
  teamBWins: number;
  ties: number;
  totalGames: number;
  winPercentageA?: number;
  winPercentageB?: number;
  competitiveness?: number;
  avgMarginOfVictory?: number;
  intensity: "competitive" | "heated";
  playoffMeetings: number;
  championshipMeetings: number;
  recentMeetings?: Array<{
    seasonId: number;
    week: number;
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
    winner: "home" | "away" | "tie";
    isPlayoff: boolean;
    isChampionship: boolean;
  }>;
}

const getIntensityIcon = (intensity: string) => {
  switch (intensity) {
    case "heated":
      return <Flame className="h-4 w-4 text-red-500" />;
    case "competitive":
      return <Zap className="h-4 w-4 text-orange-500" />;
    default:
      return <Zap className="h-4 w-4 text-orange-500" />;
  }
};

const getIntensityColor = (intensity: string) => {
  switch (intensity) {
    case "heated":
      return "destructive";
    case "competitive":
      return "default";
    default:
      return "default";
  }
};

export function RivalriesTab({ leagueId }: RivalriesTabProps) {
  const rivalries = useQuery(api.rivalries.calculateHistoricalRivalries, { leagueId }) as Rivalry[] | undefined;

  if (!rivalries) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading rivalries...</p>
        </div>
      </div>
    );
  }

  if (rivalries.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Swords className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No Rivalries Yet</h3>
          <p className="text-gray-600">
            Rivalries will appear as teams play more games against each other.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Rivalries Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Rivalries</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{rivalries.length}</div>
            <p className="text-xs text-muted-foreground">
              Active team rivalries
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Heated Rivalries</CardTitle>
            <Flame className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {rivalries.filter(r => r.intensity === "heated").length}
            </div>
            <p className="text-xs text-muted-foreground">
              Premier rivalries
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Playoff Battles</CardTitle>
            <Trophy className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {rivalries.reduce((sum, r) => sum + r.playoffMeetings, 0)}
            </div>
            <p className="text-xs text-muted-foreground">
              Postseason meetings
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Championships</CardTitle>
            <Trophy className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {rivalries.reduce((sum, r) => sum + r.championshipMeetings, 0)}
            </div>
            <p className="text-xs text-muted-foreground">
              Title game meetings
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Rivalries List */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {rivalries.map((rivalry, index) => (
          <Card key={`${rivalry.teamA._id}-${rivalry.teamB._id}`} className="overflow-hidden">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  {getIntensityIcon(rivalry.intensity)}
                  Rivalry #{index + 1}
                </CardTitle>
                <Badge variant={getIntensityColor(rivalry.intensity) as "default" | "destructive" | "outline" | "secondary"}>
                  {rivalry.intensity}
                </Badge>
              </div>
              <CardDescription>
                {rivalry.totalGames} games • {rivalry.playoffMeetings} playoff meetings
                {rivalry.championshipMeetings > 0 && ` • ${rivalry.championshipMeetings} championship${rivalry.championshipMeetings > 1 ? 's' : ''}`}
              </CardDescription>
            </CardHeader>
            
            <CardContent className="space-y-4">
              {/* Head-to-Head Matchup */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-center flex-1">
                    <div className="font-bold text-lg">{rivalry.teamA.name}</div>
                    <div className="text-sm text-gray-600">
                      {rivalry.teamA.ownerInfo?.displayName || rivalry.teamA.owner}
                    </div>
                  </div>
                  
                  <div className="text-center px-4">
                    <div className="text-xl font-bold">
                      {rivalry.teamAWins} - {rivalry.teamBWins}
                    </div>
                    {rivalry.ties > 0 && (
                      <div className="text-xs text-gray-500">{rivalry.ties} ties</div>
                    )}
                  </div>
                  
                  <div className="text-center flex-1">
                    <div className="font-bold text-lg">{rivalry.teamB.name}</div>
                    <div className="text-sm text-gray-600">
                      {rivalry.teamB.ownerInfo?.displayName || rivalry.teamB.owner}
                    </div>
                  </div>
                </div>
                
                {/* Win Percentage Bars */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs w-20 text-right">
                      {rivalry.teamA.name}
                    </span>
                    <Progress 
                      value={(rivalry.winPercentageA || 0) * 100} 
                      className="flex-1 h-2"
                    />
                    <span className="text-xs w-10">
                      {((rivalry.winPercentageA || 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs w-20 text-right">
                      {rivalry.teamB.name}
                    </span>
                    <Progress 
                      value={(rivalry.winPercentageB || 0) * 100} 
                      className="flex-1 h-2"
                    />
                    <span className="text-xs w-10">
                      {((rivalry.winPercentageB || 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>
              
              <Separator />
              
              {/* Recent Meetings */}
              {rivalry.recentMeetings && rivalry.recentMeetings.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-2 flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Recent Meetings
                  </h4>
                  <div className="space-y-2">
                    {rivalry.recentMeetings.slice(0, 3).map((meeting, idx) => {
                      // Map external team IDs to team names using the rivalry team data
                      const homeTeamName = meeting.homeTeam === rivalry.teamA.externalId ? rivalry.teamA.name : rivalry.teamB.name;
                      const awayTeamName = meeting.awayTeam === rivalry.teamA.externalId ? rivalry.teamA.name : rivalry.teamB.name;
                      
                      return (
                        <div key={idx} className="flex items-center justify-between text-sm bg-gray-50 rounded-lg p-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{meeting.seasonId} W{meeting.week}</span>
                            {meeting.isChampionship && (
                              <Badge variant="outline" className="text-xs bg-yellow-100 text-yellow-800 border-yellow-300">
                                Championship
                              </Badge>
                            )}
                            {meeting.isPlayoff && !meeting.isChampionship && (
                              <Badge variant="outline" className="text-xs">
                                Playoff
                              </Badge>
                            )}
                          </div>
                          <div className="text-center">
                            <div>
                              {awayTeamName} @ {homeTeamName}
                            </div>
                            <div className="font-mono">
                              {meeting.awayScore.toFixed(1)} - {meeting.homeScore.toFixed(1)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}