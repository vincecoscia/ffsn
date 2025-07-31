"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Minus } from "lucide-react";
import { TeamLogo } from "@/components/TeamLogo";

interface StandingsPageProps {
  params: Promise<{ id: string }>;
}

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  customLogo?: Id<"_storage">;
  owner: string;
  divisionId?: number;
  record: {
    wins: number;
    losses: number;
    ties: number;
    pointsFor?: number;
    pointsAgainst?: number;
    playoffSeed?: number;
    divisionRecord?: {
      wins: number;
      losses: number;
      ties: number;
    };
  };
}

export default function StandingsPage({ params }: StandingsPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();
  
  const [selectedSeason, setSelectedSeason] = useState(2025);
  
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
  
  // Sort teams by various criteria
  const sortedByRecord = React.useMemo(() => {
    return [...teams].sort((a, b) => {
      // Sort by wins first
      if (a.record.wins !== b.record.wins) {
        return b.record.wins - a.record.wins;
      }
      // Then by win percentage
      const aWinPct = a.record.wins / (a.record.wins + a.record.losses + a.record.ties || 1);
      const bWinPct = b.record.wins / (b.record.wins + b.record.losses + b.record.ties || 1);
      if (aWinPct !== bWinPct) {
        return bWinPct - aWinPct;
      }
      // Then by points for
      return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
    });
  }, [teams]);
  
  // Sort by points (power rankings)
  const sortedByPoints = React.useMemo(() => {
    return [...teams].sort((a, b) => {
      return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
    });
  }, [teams]);
  
  // Group teams by division if applicable
  const teamsByDivision = React.useMemo(() => {
    const divisions = new Map<number, Team[]>();
    teams.forEach(team => {
      const divId = team.divisionId || 0;
      if (!divisions.has(divId)) {
        divisions.set(divId, []);
      }
      divisions.get(divId)!.push(team);
    });
    
    // Sort teams within each division
    divisions.forEach((divTeams) => {
      divTeams.sort((a, b) => {
        // Sort by division record if available
        if (a.record.divisionRecord && b.record.divisionRecord) {
          const aDivWins = a.record.divisionRecord.wins;
          const bDivWins = b.record.divisionRecord.wins;
          if (aDivWins !== bDivWins) {
            return bDivWins - aDivWins;
          }
        }
        // Fall back to overall record
        if (a.record.wins !== b.record.wins) {
          return b.record.wins - a.record.wins;
        }
        return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
      });
    });
    
    return divisions;
  }, [teams]);
  
  const hasDivisions = league?.settings?.divisions && league.settings.divisions.length > 0;

  if (!userId || !league) {
    return <div>Loading...</div>;
  }

  const StandingsTable = ({ teams, showRank = true }: { teams: Team[], showRank?: boolean }) => (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            {showRank && (
              <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Rank
              </th>
            )}
            <th className="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Team
            </th>
            <th className="px-6 py-4 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Record
            </th>
            <th className="px-6 py-4 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Win %
            </th>
            <th className="px-6 py-4 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              PF
            </th>
            <th className="px-6 py-4 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              PA
            </th>
            <th className="px-6 py-4 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Diff
            </th>
            <th className="px-6 py-4 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Streak
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {teams.map((team, index) => {
            const totalGames = team.record.wins + team.record.losses + team.record.ties;
            const winPercentage = totalGames > 0 ? (team.record.wins / totalGames) : 0;
            const pointDiff = (team.record.pointsFor || 0) - (team.record.pointsAgainst || 0);
            const isPlayoffTeam = team.record.playoffSeed && team.record.playoffSeed <= (league?.settings?.playoffTeamCount || 6);
            
            return (
              <tr key={team._id} className="hover:bg-gray-50 transition-colors">
                {showRank && (
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-900">{index + 1}</span>
                      {isPlayoffTeam && (
                        <Badge variant="secondary" className="text-xs">
                          Playoff
                        </Badge>
                      )}
                    </div>
                  </td>
                )}
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <TeamLogo 
                      teamId={team._id}
                      teamName={team.name}
                      espnLogo={team.logo}
                      customLogo={team.customLogo}
                      size="md"
                      className="mr-3"
                    />
                    <div>
                      <div className="text-sm font-bold text-gray-900">{team.name}</div>
                      <div className="text-sm text-gray-500">{team.owner}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center">
                  <span className="text-sm font-semibold text-gray-900">
                    {team.record.wins}-{team.record.losses}
                    {team.record.ties > 0 && `-${team.record.ties}`}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center">
                  <span className="text-sm font-medium text-gray-900">
                    {(winPercentage * 100).toFixed(1)}%
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-semibold text-gray-900">
                  {team.record.pointsFor?.toFixed(1) || '0.0'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center text-sm font-semibold text-gray-900">
                  {team.record.pointsAgainst?.toFixed(1) || '0.0'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center">
                  <span className={`text-sm font-semibold ${pointDiff > 0 ? 'text-green-600' : pointDiff < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                    {pointDiff > 0 && '+'}{pointDiff.toFixed(1)}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center">
                  <div className="flex items-center justify-center">
                    {/* Placeholder for streak - would need to calculate from recent matchups */}
                    <Minus className="h-4 w-4 text-gray-400" />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <LeaguePageLayout 
      leagueId={leagueId} 
      currentUserId={userId}
      title="Standings"
    >
      {/* Season Selector */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-bold">{selectedSeason} Season Standings</h2>
          <SeasonSelector
            currentSeason={2025}
            selectedSeason={selectedSeason}
            onSeasonChange={setSelectedSeason}
            availableSeasons={availableSeasons}
          />
        </div>
      </div>

      {/* Standings Tabs */}
      <div className="bg-white rounded-lg shadow-sm">
        <Tabs defaultValue="overall" className="w-full">
          <div className="border-b border-gray-200">
            <TabsList className="h-auto p-0 bg-transparent">
              <TabsTrigger 
                value="overall" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-red-600 rounded-none px-6 py-4"
              >
                Overall
              </TabsTrigger>
              {hasDivisions && (
                <TabsTrigger 
                  value="division" 
                  className="data-[state=active]:border-b-2 data-[state=active]:border-red-600 rounded-none px-6 py-4"
                >
                  Division
                </TabsTrigger>
              )}
              <TabsTrigger 
                value="power" 
                className="data-[state=active]:border-b-2 data-[state=active]:border-red-600 rounded-none px-6 py-4"
              >
                Power Rankings
              </TabsTrigger>
            </TabsList>
          </div>
          
          <TabsContent value="overall" className="p-0">
            <StandingsTable teams={sortedByRecord} />
          </TabsContent>
          
          {hasDivisions && (
            <TabsContent value="division" className="p-0">
              <div className="divide-y divide-gray-200">
                {Array.from(teamsByDivision.entries()).map(([divisionId, divTeams]) => {
                  const division = league.settings.divisions?.find(d => d.id === divisionId.toString());
                  return (
                    <div key={divisionId}>
                      <div className="px-6 py-4 bg-gray-50">
                        <h3 className="text-lg font-semibold text-gray-900">
                          {division?.name || `Division ${divisionId}`}
                        </h3>
                      </div>
                      <StandingsTable teams={divTeams} showRank={false} />
                    </div>
                  );
                })}
              </div>
            </TabsContent>
          )}
          
          <TabsContent value="power" className="p-0">
            <div className="p-6">
              <p className="text-sm text-gray-600 mb-4">
                Teams ranked by total points scored, reflecting offensive performance regardless of record.
              </p>
            </div>
            <StandingsTable teams={sortedByPoints} />
          </TabsContent>
        </Tabs>
      </div>
    </LeaguePageLayout>
  );
}