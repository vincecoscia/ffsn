"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { useLeagueSeason } from "@/hooks/use-league-season";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Panel, SectionHeader, TeamTile, LoadingScreen, EmptyState } from "@/components/broadcast";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";

interface SchedulePageProps {
  params: Promise<{ id: string }>;
}

interface Player {
  lineupSlotId: number;
  espnId: number;
  firstName?: string;
  lastName?: string;
  fullName: string;
  position: string;
  points: number;
  projectedPoints?: number;
  projectedStats?: Record<string, number>;
}

interface Roster {
  appliedStatTotal: number;
  players: Player[];
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
  homeRoster?: Roster;
  awayRoster?: Roster;
  homeProjectedScore?: number;
  awayProjectedScore?: number;
  homePointsByScoringPeriod?: Record<number, number>;
  awayPointsByScoringPeriod?: Record<number, number>;
}

// Calculate projected score from roster data
const calculateProjectedScore = (roster?: Roster): number => {
  if (!roster || !roster.players) {
    return 0;
  }
  
  return roster.players
    .filter(player => player.lineupSlotId !== 20) // Exclude bench players (lineupSlotId 20)
    .reduce((total, player) => {
      return total + (player.projectedPoints || 0);
    }, 0);
};

function initialsFor(team: { name: string; abbreviation?: string } | null | undefined) {
  if (!team) return "??";
  if (team.abbreviation) return team.abbreviation.slice(0, 3).toUpperCase();
  const words = team.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Calculate actual score from roster data
const calculateActualScore = (roster?: Roster): number => {
  if (!roster || !roster.players) {
    return 0;
  }
  
  return roster.players
    .filter(player => player.lineupSlotId !== 20) // Exclude bench players (lineupSlotId 20)
    .reduce((total, player) => {
      return total + (player.points || 0);
    }, 0);
};

export default function SchedulePage({ params }: SchedulePageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();
  
  // Get current/available seasons for the league
  const { currentSeason, availableSeasons, isLoading: isSeasonLoading } = useLeagueSeason(leagueId);

  const [selectedSeason, setSelectedSeason] = useState(currentSeason);
  const [selectedTeamFilter, setSelectedTeamFilter] = useState<string>("all");
  const [selectedWeekFilter, setSelectedWeekFilter] = useState<string>("all");
  const [selectedSeasonType, setSelectedSeasonType] = useState<string>("all");

  // Sync the selected season once the real current season resolves
  const hasSyncedSeason = React.useRef(false);
  React.useEffect(() => {
    if (!isSeasonLoading && !hasSyncedSeason.current) {
      hasSyncedSeason.current = true;
      setSelectedSeason(currentSeason);
    }
  }, [isSeasonLoading, currentSeason]);

  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });

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

  // Group the filtered matchups by week for the week-by-week panels
  const matchupsByWeek = React.useMemo(() => {
    const map = new Map<number, Matchup[]>();
    filteredMatchups.forEach((matchup) => {
      if (!map.has(matchup.matchupPeriod)) {
        map.set(matchup.matchupPeriod, []);
      }
      map.get(matchup.matchupPeriod)!.push(matchup);
    });
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [filteredMatchups]);

  if (!userId || !league) {
    return <LoadingScreen message="Loading schedule" />;
  }

  return (
    <LeaguePageLayout
      leagueId={leagueId}
      currentUserId={userId}
      title="Schedule"
    >
      {/* Filters */}
      <Panel padding="md">
        <SectionHeader
          title="Schedule"
          kicker={`Regular season weeks 1-${regularSeasonWeeks} · Playoffs ${regularSeasonWeeks + 1}-${totalWeeks}`}
        />
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <span className="bc-label-sm text-bc-text-3">Team</span>
            <Select value={selectedTeamFilter} onValueChange={setSelectedTeamFilter}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="All teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All teams</SelectItem>
                {teams.map((team) => (
                  <SelectItem key={team._id} value={team.externalId}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="bc-label-sm text-bc-text-3">Week</span>
            <Select value={selectedWeekFilter} onValueChange={setSelectedWeekFilter}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="All weeks" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All weeks</SelectItem>
                {weekNumbers.map((week) => (
                  <SelectItem key={week} value={week.toString()}>
                    Week {week} {isPlayoffWeek(week) && "(Playoffs)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="bc-label-sm text-bc-text-3">Season type</span>
            <Select value={selectedSeasonType} onValueChange={setSelectedSeasonType}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="All games" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All games</SelectItem>
                <SelectItem value="regular">Regular season</SelectItem>
                <SelectItem value="playoffs">Playoffs</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="bc-label-sm text-bc-text-3">Season</span>
            <SeasonSelector
              currentSeason={currentSeason}
              selectedSeason={selectedSeason}
              onSeasonChange={setSelectedSeason}
              availableSeasons={availableSeasons}
            />
          </div>
        </div>
      </Panel>

      {/* Week-by-week schedule */}
      {isLoadingMatchups ? (
        <LoadingScreen message="Loading schedule" />
      ) : filteredMatchups.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="size-6" strokeWidth={1.8} />}
          title="No matchups found"
          description={
            allMatchups.length === 0
              ? "No matchup data available yet. Try syncing your league data first."
              : "No matchups match the selected filters."
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          {matchupsByWeek.map(([week, weekMatchups]) => (
            <Panel key={week} padding="md">
              <SectionHeader
                size="sm"
                title={`Week ${week}`}
                kicker={isPlayoffWeek(week) ? "Playoffs" : "Regular season"}
                actions={
                  <span className="bc-label-sm text-bc-text-3">
                    {weekMatchups.length} {weekMatchups.length === 1 ? "matchup" : "matchups"}
                  </span>
                }
              />
              <div className="mt-4 flex flex-col">
                {weekMatchups.map((matchup) => {
                  const homeTeam = getTeamByExternalId(matchup.homeTeamId);
                  const awayTeam = getTeamByExternalId(matchup.awayTeamId);
                  const isComplete = matchup.winner !== null && matchup.winner !== undefined;
                  const currentYear = new Date().getFullYear();
                  const isCurrentSeason = selectedSeason === currentYear;
                  const currentScoringPeriod = league?.espnData?.currentScoringPeriod || 1;
                  const isFuture = isCurrentSeason && matchup.matchupPeriod > currentScoringPeriod;

                  // Calculate actual scores from roster data if available, otherwise use stored values
                  const homeActualScore = matchup.homeRoster
                    ? calculateActualScore(matchup.homeRoster)
                    : matchup.homeScore;
                  const awayActualScore = matchup.awayRoster
                    ? calculateActualScore(matchup.awayRoster)
                    : matchup.awayScore;

                  const isLive =
                    isCurrentSeason && matchup.matchupPeriod === currentScoringPeriod && !isComplete;
                  const liveAwayScore =
                    matchup.awayPointsByScoringPeriod?.[matchup.matchupPeriod] ?? awayActualScore;
                  const liveHomeScore =
                    matchup.homePointsByScoringPeriod?.[matchup.matchupPeriod] ?? homeActualScore;

                  const homeProjected = matchup.homeRoster
                    ? calculateProjectedScore(matchup.homeRoster)
                    : matchup.homeProjectedScore;
                  const awayProjected = matchup.awayRoster
                    ? calculateProjectedScore(matchup.awayRoster)
                    : matchup.awayProjectedScore;

                  return (
                    <div
                      key={matchup._id}
                      className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-bc-hairline py-3 first:border-t-0 md:gap-5"
                    >
                      {/* Away team */}
                      <div className="flex min-w-0 items-center gap-3">
                        <TeamTile
                          initials={initialsFor(awayTeam)}
                          src={awayTeam?.logo}
                          size={36}
                        />
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span
                            className={cn(
                              "truncate font-display text-[16px] font-bold uppercase leading-none",
                              matchup.winner === "away" ? "text-bc-ink" : "text-bc-text-2"
                            )}
                          >
                            {awayTeam?.name || "TBD"}
                          </span>
                          <span className="bc-label-sm text-bc-text-3 truncate">
                            {awayTeam?.owner}
                          </span>
                        </div>
                      </div>

                      {/* Score / status */}
                      <div className="flex flex-col items-center gap-1.5">
                        {isFuture ? (
                          <span className="bc-num text-bc-signal">
                            {awayProjected !== undefined && homeProjected !== undefined
                              ? `${awayProjected.toFixed(1)} – ${homeProjected.toFixed(1)}`
                              : "Proj"}
                          </span>
                        ) : (
                          <span className="bc-num text-[19px] text-bc-ink">
                            {isLive
                              ? `${liveAwayScore.toFixed(1)} – ${liveHomeScore.toFixed(1)}`
                              : `${awayActualScore.toFixed(1)} – ${homeActualScore.toFixed(1)}`}
                          </span>
                        )}
                        {isPlayoffWeek(matchup.matchupPeriod) && (
                          <Badge variant="secondary">Playoffs</Badge>
                        )}
                        {isFuture ? (
                          <Badge variant="outline">Scheduled</Badge>
                        ) : isComplete ? (
                          <Badge variant="secondary">Final</Badge>
                        ) : (
                          <Badge variant="signal">In progress</Badge>
                        )}
                      </div>

                      {/* Home team */}
                      <div className="flex min-w-0 items-center justify-end gap-3 text-right">
                        <div className="flex min-w-0 flex-col gap-0.5 items-end">
                          <span
                            className={cn(
                              "truncate font-display text-[16px] font-bold uppercase leading-none",
                              matchup.winner === "home" ? "text-bc-ink" : "text-bc-text-2"
                            )}
                          >
                            {homeTeam?.name || "TBD"}
                          </span>
                          <span className="bc-label-sm text-bc-text-3 truncate">
                            {homeTeam?.owner}
                          </span>
                        </div>
                        <TeamTile
                          initials={initialsFor(homeTeam)}
                          src={homeTeam?.logo}
                          size={36}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </LeaguePageLayout>
  );
}