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
  
  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });
  
  // Get teams for the selected season
  const teams = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId,
    seasonId: selectedSeason 
  }) || [];
  
  // For now, we'll simulate getting matchups for all weeks
  // In production, you'd want a query that returns all matchups for a season
  const [allMatchups, setAllMatchups] = useState<Matchup[]>([]);
  
  React.useEffect(() => {
    // Simulate fetching all weeks' matchups
    const fetchAllMatchups = async () => {
      const matchupsByWeek: Matchup[] = [];
      // This is a placeholder - in production you'd batch this or have a proper query
      for (let week = 1; week <= 17; week++) {
        // You would actually fetch each week here
        // For now, we'll just use empty data
      }
      setAllMatchups(matchupsByWeek);
    };
    
    fetchAllMatchups();
  }, [leagueId, selectedSeason]);
  
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
    
    return filtered.sort((a, b) => a.matchupPeriod - b.matchupPeriod);
  }, [allMatchups, selectedTeamFilter, selectedWeekFilter]);

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
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
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
          
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-700 mb-1 block">
              Filter by Week
            </label>
            <Select value={selectedWeekFilter} onValueChange={setSelectedWeekFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All Weeks" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Weeks</SelectItem>
                {Array.from({ length: 17 }, (_, i) => i + 1).map((week) => (
                  <SelectItem key={week} value={week.toString()}>
                    Week {week}
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
            />
          </div>
        </div>
      </div>

      {/* Schedule Table */}
      <div className="bg-white rounded-lg shadow-sm">
        <div className="p-6">
          <h2 className="text-xl font-bold mb-4">
            {selectedSeason} Season Schedule
            {selectedTeamFilter !== "all" && ` - ${getTeamByExternalId(selectedTeamFilter)?.name}`}
            {selectedWeekFilter !== "all" && ` - Week ${selectedWeekFilter}`}
          </h2>
          
          {filteredMatchups.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-500">No matchups found for the selected filters.</p>
              <p className="text-sm text-gray-400 mt-2">
                Note: Full schedule data is being implemented. Check back soon!
              </p>
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
                    const isComplete = matchup.winner !== null;
                    const currentWeek = league?.espnData?.currentScoringPeriod || 1;
                    const isFuture = matchup.matchupPeriod > currentWeek;
                    
                    return (
                      <TableRow key={matchup._id}>
                        <TableCell className="font-medium">
                          Week {matchup.matchupPeriod}
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