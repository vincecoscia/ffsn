"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface ScoresPageProps {
  params: Promise<{ id: string }>;
}

type SingleWeekScore = {
  score: number;
  teamId: string;
  seasonId: number;
  matchupPeriod: number;
  matchupId: string;
  isHome: boolean;
};

type TwoWeekScore = {
  totalScore: number;
  week1Score: number;
  week2Score: number;
  teamId: string;
  seasonId: number;
  startWeek: number;
  matchupIds: string[];
  isHome: boolean;
};

export default function ScoresPage({ params }: ScoresPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();
  
  const [selectedSeason, setSelectedSeason] = useState(2025);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [topScoresView, setTopScoresView] = useState<"all-time" | "season">("all-time");
  const [scoreType, setScoreType] = useState<"single" | "twoWeek">("single");
  
  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });
  
  // Get current scoring period from ESPN data
  const currentWeek = league?.espnData?.currentScoringPeriod || 1;
  
  // Set selected week to current week if not set
  React.useEffect(() => {
    if (selectedWeek === null && currentWeek) {
      setSelectedWeek(currentWeek);
    }
  }, [currentWeek, selectedWeek]);
  
  // Get teams for the selected season
  const teamsData = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId,
    seasonId: selectedSeason 
  });
  
  const teams = React.useMemo(() => teamsData || [], [teamsData]);
  
  // Get matchups for the selected week
  const matchups = useQuery(api.matchups.getByLeagueAndPeriod, {
    leagueId,
    seasonId: selectedSeason,
    matchupPeriod: selectedWeek || currentWeek,
  }) || [];
  
  // Get top scores all time
  const topScoresAllTime = useQuery(api.matchups.getTopScoresAllTime, {
    leagueId,
    limit: 10,
    scoreType
  }) || [];
  
  // Get top scores by season
  const topScoresBySeason = useQuery(api.matchups.getTopScoresBySeason, {
    leagueId,
    seasonId: selectedSeason,
    limit: 10,
    scoreType
  }) || [];
  
  // Create a map for quick team lookup
  const teamMap = React.useMemo(() => {
    const map = new Map<string, typeof teams[0]>();
    teams.forEach(team => {
      map.set(team.externalId, team);
    });
    return map;
  }, [teams]);

  const getTeamByExternalId = (externalId: string) => {
    return teamMap.get(externalId) || null;
  };

  const handleWeekChange = (direction: 'prev' | 'next') => {
    if (!selectedWeek) return;
    
    if (direction === 'prev' && selectedWeek > 1) {
      setSelectedWeek(selectedWeek - 1);
    } else if (direction === 'next' && selectedWeek < 17) {
      setSelectedWeek(selectedWeek + 1);
    }
  };

  if (!userId || !league) {
    return <div>Loading...</div>;
  }

  return (
    <LeaguePageLayout 
      leagueId={leagueId} 
      currentUserId={userId}
      title="Scores"
    >
      <Tabs defaultValue="weekly" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="weekly">Weekly Scores</TabsTrigger>
          <TabsTrigger value="top-scores">Top Scores</TabsTrigger>
        </TabsList>
        
        <TabsContent value="weekly">
          {/* Controls */}
          <div className="bg-white rounded-lg shadow-sm p-6 mb-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleWeekChange('prev')}
                  disabled={!selectedWeek || selectedWeek <= 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                
                <div className="text-center">
                  <h2 className="text-xl font-bold">Week {selectedWeek || currentWeek}</h2>
                  {selectedWeek === currentWeek && (
                    <Badge variant="secondary" className="mt-1">Current Week</Badge>
                  )}
                </div>
                
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleWeekChange('next')}
                  disabled={!selectedWeek || selectedWeek >= 17}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              
              <SeasonSelector
                currentSeason={2025}
                selectedSeason={selectedSeason}
                onSeasonChange={setSelectedSeason}
              />
            </div>
          </div>

          {/* Scores Display */}
          <div className="bg-white rounded-lg shadow-sm p-6">
            <Tabs defaultValue="cards" className="w-full">
              <TabsList className="mb-4">
                <TabsTrigger value="cards">Card View</TabsTrigger>
                <TabsTrigger value="list">List View</TabsTrigger>
              </TabsList>
              
              <TabsContent value="cards">
                {matchups.length === 0 ? (
                  <p className="text-gray-500 text-center py-8">No matchups available for this week.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {matchups.map((matchup) => {
                      const homeTeam = getTeamByExternalId(matchup.homeTeamId);
                      const awayTeam = getTeamByExternalId(matchup.awayTeamId);
                      const isComplete = matchup.winner !== null;
                      
                      return (
                        <div key={matchup._id} className="border rounded-lg p-4 hover:shadow-md transition-shadow">
                          <div className="space-y-3">
                            {/* Away Team */}
                            <div className={`flex items-center justify-between ${matchup.winner === 'away' ? 'font-bold' : ''}`}>
                              <div className="flex items-center gap-3">
                                {awayTeam?.logo && (
                                  <img 
                                    src={awayTeam.logo} 
                                    alt={awayTeam.name}
                                    className="w-10 h-10 rounded"
                                  />
                                )}
                                <div>
                                  <div className="font-medium">{awayTeam?.name || 'Unknown Team'}</div>
                                  <div className="text-sm text-gray-500">{awayTeam?.owner}</div>
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-xl font-bold">
                                  {matchup.awayScore.toFixed(1)}
                                </div>
                                {!isComplete && matchup.awayProjectedScore && (
                                  <div className="text-xs text-gray-500">
                                    Proj: {matchup.awayProjectedScore.toFixed(1)}
                                  </div>
                                )}
                              </div>
                            </div>
                            
                            <div className="border-t"></div>
                            
                            {/* Home Team */}
                            <div className={`flex items-center justify-between ${matchup.winner === 'home' ? 'font-bold' : ''}`}>
                              <div className="flex items-center gap-3">
                                {homeTeam?.logo && (
                                  <img 
                                    src={homeTeam.logo} 
                                    alt={homeTeam.name}
                                    className="w-10 h-10 rounded"
                                  />
                                )}
                                <div>
                                  <div className="font-medium">{homeTeam?.name || 'Unknown Team'}</div>
                                  <div className="text-sm text-gray-500">{homeTeam?.owner}</div>
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-xl font-bold">
                                  {matchup.homeScore.toFixed(1)}
                                </div>
                                {!isComplete && matchup.homeProjectedScore && (
                                  <div className="text-xs text-gray-500">
                                    Proj: {matchup.homeProjectedScore.toFixed(1)}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          
                          {/* Status Badge */}
                          <div className="mt-3 text-center">
                            {isComplete ? (
                              <Badge variant="secondary">Final</Badge>
                            ) : (
                              <Badge variant="default">In Progress</Badge>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>
              
              <TabsContent value="list">
                {matchups.length === 0 ? (
                  <p className="text-gray-500 text-center py-8">No matchups available for this week.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Away Team
                          </th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Score
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Home Team
                          </th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {matchups.map((matchup) => {
                          const homeTeam = getTeamByExternalId(matchup.homeTeamId);
                          const awayTeam = getTeamByExternalId(matchup.awayTeamId);
                          const isComplete = matchup.winner !== null;
                          
                          return (
                            <tr key={matchup._id}>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex items-center">
                                  {awayTeam?.logo && (
                                    <img 
                                      src={awayTeam.logo} 
                                      alt={awayTeam.name}
                                      className="w-8 h-8 rounded mr-3"
                                    />
                                  )}
                                  <div>
                                    <div className={`font-medium ${matchup.winner === 'away' ? 'font-bold' : ''}`}>
                                      {awayTeam?.name || 'Unknown Team'}
                                    </div>
                                    <div className="text-sm text-gray-500">{awayTeam?.owner}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-center">
                                <div className="text-lg font-bold">
                                  {matchup.awayScore.toFixed(1)} - {matchup.homeScore.toFixed(1)}
                                </div>
                                {!isComplete && (
                                  <div className="text-xs text-gray-500">
                                    Proj: {matchup.awayProjectedScore?.toFixed(1)} - {matchup.homeProjectedScore?.toFixed(1)}
                                  </div>
                                )}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex items-center">
                                  {homeTeam?.logo && (
                                    <img 
                                      src={homeTeam.logo} 
                                      alt={homeTeam.name}
                                      className="w-8 h-8 rounded mr-3"
                                    />
                                  )}
                                  <div>
                                    <div className={`font-medium ${matchup.winner === 'home' ? 'font-bold' : ''}`}>
                                      {homeTeam?.name || 'Unknown Team'}
                                    </div>
                                    <div className="text-sm text-gray-500">{homeTeam?.owner}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-center">
                                {isComplete ? (
                                  <Badge variant="secondary">Final</Badge>
                                ) : (
                                  <Badge variant="default">In Progress</Badge>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>
        
        <TabsContent value="top-scores">
          <div className="bg-white rounded-lg shadow-sm p-6">
            <div className="mb-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <h2 className="text-2xl font-bold">Top Scores</h2>
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <Tabs value={scoreType} onValueChange={(value) => setScoreType(value as "single" | "twoWeek")}>
                    <TabsList>
                      <TabsTrigger value="single">Single Week</TabsTrigger>
                      <TabsTrigger value="twoWeek">Two Week Games</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <Tabs value={topScoresView} onValueChange={(value) => setTopScoresView(value as "all-time" | "season")}>
                    <TabsList>
                      <TabsTrigger value="all-time">All Time</TabsTrigger>
                      <TabsTrigger value="season">Season</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {topScoresView === "season" && (
                    <SeasonSelector
                      currentSeason={2025}
                      selectedSeason={selectedSeason}
                      onSeasonChange={setSelectedSeason}
                    />
                  )}
                </div>
              </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Rank
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Team
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {scoreType === "twoWeek" ? "Total Score" : "Score"}
                    </th>
                    {scoreType === "twoWeek" && (
                      <>
                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Week 1
                        </th>
                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Week 2
                        </th>
                      </>
                    )}
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {scoreType === "twoWeek" ? "Weeks" : "Week"}
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Season
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {(topScoresView === "all-time" ? topScoresAllTime : topScoresBySeason).map((score, index) => {
                    const team = getTeamByExternalId(score.teamId);
                    const isTwoWeek = scoreType === "twoWeek";
                    const twoWeekScore = score as TwoWeekScore;
                    const singleScore = score as SingleWeekScore;
                    
                    return (
                      <tr key={isTwoWeek ? `${twoWeekScore.matchupIds?.join('-')}-${score.isHome}` : `${singleScore.matchupId}-${score.isHome}`} className={index === 0 ? "bg-yellow-50" : ""}>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-lg font-bold">
                            {index === 0 && "🏆"} #{index + 1}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            {team?.logo && (
                              <img 
                                src={team.logo} 
                                alt={team.name}
                                className="w-10 h-10 rounded mr-3"
                              />
                            )}
                            <div>
                              <div className="font-medium">{team?.name || 'Unknown Team'}</div>
                              <div className="text-sm text-gray-500">{team?.owner}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-center">
                          <div className="text-xl font-bold">
                            {isTwoWeek ? twoWeekScore.totalScore?.toFixed(1) : singleScore.score?.toFixed(1)}
                          </div>
                        </td>
                        {scoreType === "twoWeek" && (
                          <>
                            <td className="px-6 py-4 whitespace-nowrap text-center">
                              <div className="text-sm">
                                {twoWeekScore.week1Score?.toFixed(1)}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-center">
                              <div className="text-sm">
                                {twoWeekScore.week2Score?.toFixed(1)}
                              </div>
                            </td>
                          </>
                        )}
                        <td className="px-6 py-4 whitespace-nowrap text-center">
                          {isTwoWeek ? `${twoWeekScore.startWeek}-${twoWeekScore.startWeek + 1}` : `Week ${singleScore.matchupPeriod}`}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-center">
                          {score.seasonId}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </LeaguePageLayout>
  );
}