"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { useLeagueSeason } from "@/hooks/use-league-season";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Panel, SectionHeader, ScoreBug, TeamTile, Chip, LoadingScreen, EmptyState } from "@/components/broadcast";
import { CalendarDays } from "lucide-react";

interface SchedulePageProps {
  params: Promise<{ id: string }>;
}

function initialsFor(team: { name: string; abbreviation?: string } | null | undefined) {
  if (!team) return "??";
  if (team.abbreviation) return team.abbreviation.slice(0, 3).toUpperCase();
  const words = team.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

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
    seasonId: selectedSeason,
  });

  // Get teams for the selected season
  const teamsData = useQuery(api.teams.getByLeagueAndSeason, {
    leagueId,
    seasonId: selectedSeason,
  });

  const teams = React.useMemo(() => teamsData || [], [teamsData]);

  // The full season schedule in one query — server computes `status`, trust it.
  const schedule = useQuery(api.matchups.getScheduleBySeason, {
    leagueId,
    seasonId: selectedSeason,
  });

  // Get the total number of weeks including playoffs from season-specific settings
  const regularSeasonWeeks =
    leagueSeason?.settings?.regularSeasonMatchupPeriods ||
    league?.settings?.regularSeasonMatchupPeriods ||
    14;
  const playoffWeeks = leagueSeason?.settings?.playoffWeeks || league?.settings?.playoffWeeks || 3;
  const totalWeeks = regularSeasonWeeks + playoffWeeks;

  // Create an array of week numbers based on the league's settings
  const weekNumbers = React.useMemo(() => {
    return Array.from({ length: totalWeeks }, (_, i) => i + 1);
  }, [totalWeeks]);

  // Determine if a week is a playoff week
  const isPlayoffWeek = React.useCallback(
    (week: number) => week > regularSeasonWeeks,
    [regularSeasonWeeks]
  );

  // Create a map for quick team lookup
  const teamMap = React.useMemo(() => {
    const map = new Map<string, (typeof teams)[0]>();
    teams.forEach((team) => {
      map.set(team.externalId, team);
    });
    return map;
  }, [teams]);

  const getTeamByExternalId = (externalId: string) => {
    return teamMap.get(externalId) || null;
  };

  // Filter the schedule based on selected filters
  const filteredMatchups = React.useMemo(() => {
    let filtered = [...(schedule ?? [])];

    if (selectedTeamFilter !== "all") {
      filtered = filtered.filter(
        (matchup) =>
          matchup.homeTeamId === selectedTeamFilter || matchup.awayTeamId === selectedTeamFilter
      );
    }

    if (selectedWeekFilter !== "all") {
      filtered = filtered.filter((matchup) => matchup.matchupPeriod === parseInt(selectedWeekFilter));
    }

    if (selectedSeasonType !== "all") {
      filtered = filtered.filter((matchup) => {
        const isPlayoff = isPlayoffWeek(matchup.matchupPeriod);
        return selectedSeasonType === "playoffs" ? isPlayoff : !isPlayoff;
      });
    }

    return filtered.sort((a, b) => a.matchupPeriod - b.matchupPeriod);
  }, [schedule, selectedTeamFilter, selectedWeekFilter, selectedSeasonType, isPlayoffWeek]);

  // Group the filtered matchups by week for the week-by-week panels
  const matchupsByWeek = React.useMemo(() => {
    const map = new Map<number, typeof filteredMatchups>();
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

  const currentScoringPeriod = league?.espnData?.currentScoringPeriod ?? 1;
  const isCurrentSeasonSelected = selectedSeason === currentSeason;

  return (
    <LeaguePageLayout leagueId={leagueId} currentUserId={userId} title="Schedule">
      {/* Filters */}
      <Panel padding="md">
        <SectionHeader
          title="Schedule"
          kicker={`Regular season weeks 1-${regularSeasonWeeks} · Playoffs ${regularSeasonWeeks + 1}-${totalWeeks}`}
        />
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
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
            <Select
              value={selectedSeason.toString()}
              onValueChange={(value) => setSelectedSeason(parseInt(value))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a season" />
              </SelectTrigger>
              <SelectContent>
                {(availableSeasons.length > 0 ? availableSeasons : [currentSeason]).map((season) => (
                  <SelectItem key={season} value={season.toString()}>
                    {season} Season
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Panel>

      {/* Week-by-week schedule */}
      {schedule === undefined ? (
        <LoadingScreen message="Loading schedule" />
      ) : schedule.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="size-6" strokeWidth={1.8} />}
          title="No matchups found"
          description="No matchup data available yet. Try syncing your league data first."
        />
      ) : filteredMatchups.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="size-6" strokeWidth={1.8} />}
          title="No matchups found"
          description="No matchups match the selected filters."
        />
      ) : (
        <div className="flex flex-col gap-8">
          {matchupsByWeek.map(([week, weekMatchups]) => (
            <Panel key={week} padding="none" className="p-4 sm:p-5">
              <SectionHeader
                size="sm"
                title={`Week ${week}`}
                kicker={isPlayoffWeek(week) ? "Playoffs" : "Regular season"}
                actions={
                  <div className="flex items-center gap-3">
                    <span className="bc-label-sm text-bc-text-3">
                      {weekMatchups.length} {weekMatchups.length === 1 ? "matchup" : "matchups"}
                    </span>
                    {isCurrentSeasonSelected && week === currentScoringPeriod && (
                      <Chip variant="signal" live>
                        This week
                      </Chip>
                    )}
                  </div>
                }
              />
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
                {weekMatchups.map((matchup) => {
                  const homeTeam = getTeamByExternalId(matchup.homeTeamId);
                  const awayTeam = getTeamByExternalId(matchup.awayTeamId);
                  const isProjected = matchup.status === "scheduled";

                  const strip =
                    matchup.status === "final" ? (
                      "Final"
                    ) : matchup.status === "live" ? (
                      <span className="flex items-center gap-1.5 text-bc-signal">
                        <span className="bc-pulse size-[7px] rounded-full bg-current" />
                        Live
                      </span>
                    ) : (
                      "Scheduled · Projected"
                    );

                  const isConsolation =
                    !!matchup.playoffTier &&
                    (matchup.playoffTier.includes("LOSERS") || matchup.playoffTier.includes("CONSOLATION"));
                  const isPlayoffTier =
                    matchup.playoffTier === "WINNERS_BRACKET" || matchup.matchupPeriod > regularSeasonWeeks;
                  const stripRight = isConsolation ? "Consolation" : isPlayoffTier ? "Playoffs" : undefined;

                  return (
                    <ScoreBug
                      key={matchup._id}
                      mode={isProjected ? "projected" : matchup.status === "live" ? "live" : "final"}
                      strip={strip}
                      stripRight={stripRight}
                      stripRightTone="muted"
                      home={{
                        leading: <TeamTile initials={initialsFor(homeTeam)} src={homeTeam?.logo} size={32} />,
                        name: homeTeam?.name ?? "TBD",
                        sub: homeTeam?.owner,
                        score: isProjected
                          ? (matchup.homeProjected?.toFixed(1) ?? "—")
                          : matchup.homeScore.toFixed(1),
                        winner: matchup.winner === "home",
                      }}
                      away={{
                        leading: <TeamTile initials={initialsFor(awayTeam)} src={awayTeam?.logo} size={32} />,
                        name: awayTeam?.name ?? "TBD",
                        sub: awayTeam?.owner,
                        score: isProjected
                          ? (matchup.awayProjected?.toFixed(1) ?? "—")
                          : matchup.awayScore.toFixed(1),
                        winner: matchup.winner === "away",
                      }}
                    />
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
