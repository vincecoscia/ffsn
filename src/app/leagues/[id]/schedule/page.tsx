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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SchedulePageProps {
  params: Promise<{ id: string }>;
}

interface Matchup {
  _id: Id<"matchups">;
  leagueId: Id<"leagues">;
  seasonId: number;
  matchupPeriod: number;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  winner?: "home" | "away" | "tie" | null;
}

export default function SchedulePage({ params }: SchedulePageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();
  
  const [selectedSeason, setSelectedSeason] = useState(2025);
  const [selectedTeamFilter, setSelectedTeamFilter] = useState<string>("all");
  const [selectedWeekFilter, setSelectedWeekFilter] = useState<string>("all");
  const [selectedSeasonType, setSelectedSeasonType] = useState<string>("all");
  
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
  
  // Get season-specific data
  const leagueSeason = useQuery(api.leagues.getLeagueSeasonByYear, {
    leagueId,
    seasonId: selectedSeason
  });
  
  // Get teams for the selected season
  const teamsData = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId,
    seasonId: selectedSeason 
  });
  
  const teams = React.useMemo(() => teamsData || [], [teamsData]);
  
  // Fetch matchups for each week
  const [allMatchups, setAllMatchups] = useState<Matchup[]>([]);
  const [isLoadingMatchups, setIsLoadingMatchups] = useState(true);
  
  // Get the total number of weeks including playoffs from season-specific settings
  const regularSeasonWeeks = leagueSeason?.settings?.regularSeasonMatchupPeriods || league?.settings?.regularSeasonMatchupPeriods || 14;
  const playoffWeeks = leagueSeason?.settings?.playoffWeeks || league?.settings?.playoffWeeks || 3;
  const totalWeeks = regularSeasonWeeks + playoffWeeks;
  
  // Don't fetch matchups until we have league data and season data
  const shouldFetchMatchups = !!league && !!leagueSeason;
  
  // Create an array of week numbers based on the league's settings
  const weekNumbers = React.useMemo(() => {
    return Array.from({ length: totalWeeks }, (_, i) => i + 1);
  }, [totalWeeks]);
  
  // Determine if a week is a playoff week
  const isPlayoffWeek = React.useCallback((week: number) => week > regularSeasonWeeks, [regularSeasonWeeks]);
  
  
  // Fetch matchups for each week (up to 18 weeks to cover most leagues)
  // Always call all hooks to maintain consistent order
  const week1 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 1 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 1 } : "skip");
  const week2 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 2 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 2 } : "skip");
  const week3 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 3 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 3 } : "skip");
  const week4 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 4 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 4 } : "skip");
  const week5 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 5 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 5 } : "skip");
  const week6 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 6 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 6 } : "skip");
  const week7 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 7 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 7 } : "skip");
  const week8 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 8 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 8 } : "skip");
  const week9 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 9 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 9 } : "skip");
  const week10 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 10 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 10 } : "skip");
  const week11 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 11 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 11 } : "skip");
  const week12 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 12 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 12 } : "skip");
  const week13 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 13 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 13 } : "skip");
  const week14 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 14 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 14 } : "skip");
  const week15 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 15 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 15 } : "skip");
  const week16 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 16 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 16 } : "skip");
  const week17 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 17 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 17 } : "skip");
  const week18 = useQuery(api.matchups.getByLeagueAndPeriod, 
    shouldFetchMatchups && 18 <= totalWeeks ? { leagueId, seasonId: selectedSeason, matchupPeriod: 18 } : "skip");
  
  // Combine matchups when they're loaded
  React.useEffect(() => {
    if (!shouldFetchMatchups) {
      return;
    }
    
    const allQueries = [
      { week: 1, data: week1 },
      { week: 2, data: week2 },
      { week: 3, data: week3 },
      { week: 4, data: week4 },
      { week: 5, data: week5 },
      { week: 6, data: week6 },
      { week: 7, data: week7 },
      { week: 8, data: week8 },
      { week: 9, data: week9 },
      { week: 10, data: week10 },
      { week: 11, data: week11 },
      { week: 12, data: week12 },
      { week: 13, data: week13 },
      { week: 14, data: week14 },
      { week: 15, data: week15 },
      { week: 16, data: week16 },
      { week: 17, data: week17 },
      { week: 18, data: week18 }
    ];
    
    // Filter to only weeks that should exist for this league
    const relevantQueries = allQueries.filter(q => q.week <= totalWeeks);
    
    // Check if all relevant queries have returned data
    const allLoaded = relevantQueries.every(q => q.data !== undefined);
    
    if (allLoaded) {
      // Combine all non-empty query results
      const combined = [];
      for (const query of relevantQueries) {
        if (query.data && Array.isArray(query.data) && query.data.length > 0) {
          combined.push(...query.data);
        }
      }
      
      console.log('Schedule data combined:', {
        selectedSeason,
        totalWeeks,
        totalMatchups: combined.length,
        uniqueWeeks: [...new Set(combined.map(m => m.matchupPeriod))].sort((a, b) => a - b)
      });
      
      setAllMatchups(combined);
      setIsLoadingMatchups(false);
    }
  }, [shouldFetchMatchups, week1, week2, week3, week4, week5, week6, week7, week8, week9,
      week10, week11, week12, week13, week14, week15, week16, week17, week18, totalWeeks, selectedSeason]);
  
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
  
  // Filter matchups based on selected filters
  const filteredMatchups = React.useMemo(() => {
    let filtered = [...allMatchups];
    
    if (selectedTeamFilter !== "all") {
      filtered = filtered.filter(matchup => 
        matchup.homeTeamId === selectedTeamFilter || 
        matchup.awayTeamId === selectedTeamFilter
      );
    }
    
    if (selectedWeekFilter !== "all") {
      filtered = filtered.filter(matchup => 
        matchup.matchupPeriod === parseInt(selectedWeekFilter)
      );
    }
    
    if (selectedSeasonType !== "all") {
      filtered = filtered.filter(matchup => {
        const isPlayoff = isPlayoffWeek(matchup.matchupPeriod);
        return selectedSeasonType === "playoffs" ? isPlayoff : !isPlayoff;
      });
    }
    
    return filtered.sort((a, b) => a.matchupPeriod - b.matchupPeriod);
  }, [allMatchups, selectedTeamFilter, selectedWeekFilter, selectedSeasonType, isPlayoffWeek]);

  if (!userId || !league) {
    return <div>Loading...</div>;
  }

  return (
    <LeaguePageLayout 
      leagueId={leagueId} 
      currentUserId={userId}
      title="Schedule"
    >
      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">
              Filter by Team
            </label>
            <Select value={selectedTeamFilter} onValueChange={setSelectedTeamFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All Teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Teams</SelectItem>
                {teams.map((team) => (
                  <SelectItem key={team._id} value={team.externalId}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">
              Filter by Week
            </label>
            <Select value={selectedWeekFilter} onValueChange={setSelectedWeekFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All Weeks" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Weeks</SelectItem>
                {weekNumbers.map((week) => (
                  <SelectItem key={week} value={week.toString()}>
                    Week {week} {isPlayoffWeek(week) && "(Playoffs)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">
              Season Type
            </label>
            <Select value={selectedSeasonType} onValueChange={setSelectedSeasonType}>
              <SelectTrigger>
                <SelectValue placeholder="All Games" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Games</SelectItem>
                <SelectItem value="regular">Regular Season</SelectItem>
                <SelectItem value="playoffs">Playoffs</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div>
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

      {/* Schedule Table */}
      <div className="bg-white rounded-lg shadow-sm">
        <div className="p-6">
          <div className="mb-4">
            <h2 className="text-xl font-bold">
              {selectedSeason} Season Schedule
              {selectedTeamFilter !== "all" && ` - ${getTeamByExternalId(selectedTeamFilter)?.name}`}
              {selectedWeekFilter !== "all" && ` - Week ${selectedWeekFilter}`}
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              Regular Season: Weeks 1-{regularSeasonWeeks} • 
              Playoffs: Weeks {regularSeasonWeeks + 1}-{totalWeeks}
            </p>
          </div>
          
          {isLoadingMatchups ? (
            <div className="text-center py-8">
              <p className="text-gray-500">Loading schedule...</p>
            </div>
          ) : filteredMatchups.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-500">No matchups found for the selected filters.</p>
              {allMatchups.length === 0 && (
                <p className="text-sm text-gray-400 mt-2">
                  No matchup data available yet. Try syncing your league data first.
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Week</TableHead>
                    <TableHead>Away Team</TableHead>
                    <TableHead className="text-center">Score</TableHead>
                    <TableHead>Home Team</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMatchups.map((matchup) => {
                    const homeTeam = getTeamByExternalId(matchup.homeTeamId);
                    const awayTeam = getTeamByExternalId(matchup.awayTeamId);
                    const isComplete = matchup.winner !== null && matchup.winner !== undefined;
                    const currentYear = new Date().getFullYear();
                    const isCurrentSeason = selectedSeason === currentYear;
                    const currentScoringPeriod = league?.espnData?.currentScoringPeriod || 1;
                    const isFuture = isCurrentSeason && matchup.matchupPeriod > currentScoringPeriod;
                    
                    return (
                      <TableRow key={matchup._id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <span>Week {matchup.matchupPeriod}</span>
                            {isPlayoffWeek(matchup.matchupPeriod) && (
                              <Badge variant="secondary" className="text-xs">
                                Playoffs
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {awayTeam?.logo && (
                              <img 
                                src={awayTeam.logo} 
                                alt={awayTeam.name}
                                className="w-8 h-8 rounded"
                              />
                            )}
                            <div>
                              <div className={matchup.winner === 'away' ? 'font-bold' : ''}>
                                {awayTeam?.name || 'TBD'}
                              </div>
                              <div className="text-sm text-gray-500">{awayTeam?.owner}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          {isFuture ? (
                            <span className="text-gray-400">-</span>
                          ) : (
                            <div className="font-bold">
                              {matchup.awayScore.toFixed(1)} - {matchup.homeScore.toFixed(1)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {homeTeam?.logo && (
                              <img 
                                src={homeTeam.logo} 
                                alt={homeTeam.name}
                                className="w-8 h-8 rounded"
                              />
                            )}
                            <div>
                              <div className={matchup.winner === 'home' ? 'font-bold' : ''}>
                                {homeTeam?.name || 'TBD'}
                              </div>
                              <div className="text-sm text-gray-500">{homeTeam?.owner}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          {isFuture ? (
                            <Badge variant="outline">Scheduled</Badge>
                          ) : isComplete ? (
                            <Badge variant="secondary">Final</Badge>
                          ) : (
                            <Badge variant="default">In Progress</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </LeaguePageLayout>
  );
}