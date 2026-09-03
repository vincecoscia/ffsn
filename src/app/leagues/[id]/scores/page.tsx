"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { ChevronLeft, ChevronRight, ListX, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TeamLogo } from "@/components/TeamLogo";
import {
  Panel,
  SectionHeader,
  ScoreBug,
  RankPlate,
  Chip,
  LoadingScreen,
  EmptyState,
} from "@/components/broadcast";
import { cn } from "@/lib/utils";

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

  // Get current/available seasons for the league
  const { currentSeason, availableSeasons, isLoading: isSeasonLoading } = useLeagueSeason(leagueId);

  const [selectedSeason, setSelectedSeason] = useState(currentSeason);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [topScoresView, setTopScoresView] = useState<"all-time" | "season">(
    "all-time"
  );
  const [scoreType, setScoreType] = useState<"single" | "twoWeek">("single");
  const [scoreDirection, setScoreDirection] = useState<"highest" | "lowest">(
    "highest"
  );

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

  // Get current scoring period from ESPN data
  const currentWeek = league?.espnData?.currentScoringPeriod || 1;

  // Total weeks (regular season + playoffs), falling back to 18 if settings aren't loaded yet
  const maxWeek =
    league?.settings?.regularSeasonMatchupPeriods !== undefined
      ? league.settings.regularSeasonMatchupPeriods + league.settings.playoffWeeks
      : 18;

  // Set selected week to current week if not set
  React.useEffect(() => {
    if (selectedWeek === null && currentWeek) {
      setSelectedWeek(currentWeek);
    }
  }, [currentWeek, selectedWeek]);

  // Get teams for the selected season (for weekly view)
  const teamsDataBySeason = useQuery(api.teams.getByLeagueAndSeason, {
    leagueId,
    seasonId: selectedSeason,
  });

  // Get all teams for the league (for all-time view)
  const allTeamsData = useQuery(api.teams.getByLeague, { leagueId });

  const teams = React.useMemo(
    () => teamsDataBySeason || [],
    [teamsDataBySeason]
  );

  // Full season schedule in one query — server computes `status`, trust it.
  const schedule = useQuery(api.matchups.getScheduleBySeason, {
    leagueId,
    seasonId: selectedSeason,
  });

  // Matchups for the selected week, filtered client-side from the schedule.
  const matchups = React.useMemo(
    () => (schedule ?? []).filter((matchup) => matchup.matchupPeriod === (selectedWeek || currentWeek)),
    [schedule, selectedWeek, currentWeek]
  );

  // Get top scores all time
  const topScoresAllTime =
    useQuery(api.matchups.getTopScoresAllTime, {
      leagueId,
      limit: 10,
      scoreType,
    }) || [];

  // Get top scores by season
  const topScoresBySeason =
    useQuery(api.matchups.getTopScoresBySeason, {
      leagueId,
      seasonId: selectedSeason,
      limit: 10,
      scoreType,
    }) || [];

  // Get lowest scores all time
  const lowestScoresAllTime =
    useQuery(api.matchups.getLowestScoresAllTime, {
      leagueId,
      limit: 10,
      scoreType,
    }) || [];

  // Get lowest scores by season
  const lowestScoresBySeason =
    useQuery(api.matchups.getLowestScoresBySeason, {
      leagueId,
      seasonId: selectedSeason,
      limit: 10,
      scoreType,
    }) || [];

  // Create a map for quick team lookup
  const teamMap = React.useMemo(() => {
    const map = new Map<string, (typeof teams)[0]>();
    teams.forEach((team) => {
      map.set(team.externalId, team);
    });
    return map;
  }, [teams]);

  // Create a season-aware map for all-time scores
  const allTeamsMap = React.useMemo(() => {
    const map = new Map<string, Map<number, (typeof teams)[0]>>();
    if (allTeamsData) {
      allTeamsData.forEach((team) => {
        if (!map.has(team.externalId)) {
          map.set(team.externalId, new Map());
        }
        map.get(team.externalId)!.set(team.seasonId, team);
      });
    }
    return map;
  }, [allTeamsData]);

  const getTeamByExternalId = (externalId: string) => {
    return teamMap.get(externalId) || null;
  };

  const getTeamByExternalIdAndSeason = (
    externalId: string,
    seasonId: number
  ) => {
    const teamSeasons = allTeamsMap.get(externalId);
    if (teamSeasons) {
      return teamSeasons.get(seasonId) || null;
    }
    return null;
  };

  const handleWeekChange = (direction: "prev" | "next") => {
    if (!selectedWeek) return;

    if (direction === "prev" && selectedWeek > 1) {
      setSelectedWeek(selectedWeek - 1);
    } else if (direction === "next" && selectedWeek < maxWeek) {
      setSelectedWeek(selectedWeek + 1);
    }
  };

  if (!userId || !league) {
    return <LoadingScreen message="Loading scores" />;
  }

  // Find the closest final matchup this week for the "game of the week" strip
  let gameOfWeekId: string | null = null;
  let smallestMargin = Infinity;
  matchups.forEach((m) => {
    if (m.status !== "final") return;
    const margin = Math.abs(m.homeScore - m.awayScore);
    if (margin < smallestMargin) {
      smallestMargin = margin;
      gameOfWeekId = m._id;
    }
  });

  const topScores = (() => {
    if (scoreDirection === "highest") {
      return topScoresView === "all-time" ? topScoresAllTime : topScoresBySeason;
    }
    return topScoresView === "all-time" ? lowestScoresAllTime : lowestScoresBySeason;
  })();

  return (
    <LeaguePageLayout leagueId={leagueId} currentUserId={userId} title="Scores">
      <Tabs defaultValue="weekly" className="w-full gap-6">
        <TabsList>
          <TabsTrigger value="weekly">Weekly scores</TabsTrigger>
          <TabsTrigger value="top-scores">Top scores</TabsTrigger>
        </TabsList>

        <TabsContent value="weekly" className="flex flex-col gap-6">
          {/* Week + season controls */}
          <Panel padding="md">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleWeekChange("prev")}
                  disabled={!selectedWeek || selectedWeek <= 1}
                  aria-label="Previous week"
                >
                  <ChevronLeft className="size-4" />
                </Button>

                <div className="flex flex-col items-center gap-1.5">
                  <span className="bc-display text-[28px] leading-none">
                    Week {selectedWeek || currentWeek}
                  </span>
                  {selectedWeek === currentWeek && (
                    <Chip variant="signal" live>
                      Current week
                    </Chip>
                  )}
                </div>

                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => handleWeekChange("next")}
                  disabled={!selectedWeek || selectedWeek >= maxWeek}
                  aria-label="Next week"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>

              <SeasonSelector
                currentSeason={currentSeason}
                selectedSeason={selectedSeason}
                onSeasonChange={setSelectedSeason}
                availableSeasons={availableSeasons}
              />
            </div>
          </Panel>

          {/* Scores display */}
          <Panel padding="md">
            <Tabs defaultValue="cards" className="w-full gap-5">
              <TabsList>
                <TabsTrigger value="cards">Scoreboard</TabsTrigger>
                <TabsTrigger value="list">List</TabsTrigger>
              </TabsList>

              <TabsContent value="cards">
                {matchups.length === 0 ? (
                  <EmptyState
                    icon={<ListX className="size-6" strokeWidth={1.8} />}
                    title="No matchups"
                    description="No matchups available for this week."
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {matchups.map((matchup) => {
                      const homeTeam = getTeamByExternalId(matchup.homeTeamId);
                      const awayTeam = getTeamByExternalId(matchup.awayTeamId);
                      const isFuture = matchup.status === "scheduled";
                      const isGameOfWeek = matchup._id === gameOfWeekId;

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

                      return (
                        <ScoreBug
                          key={matchup._id}
                          mode={isFuture ? "projected" : matchup.status === "live" ? "live" : "final"}
                          strip={strip}
                          stripRight={isGameOfWeek ? "Game of the week" : undefined}
                          stripRightTone="highlight"
                          away={{
                            leading: awayTeam && (
                              <TeamLogo
                                teamId={awayTeam._id}
                                teamName={awayTeam.name}
                                espnLogo={awayTeam.logo}
                                customLogo={awayTeam.customLogo}
                                size="sm"
                              />
                            ),
                            name: awayTeam?.name || "Unknown team",
                            sub: awayTeam?.owner,
                            score: isFuture
                              ? (matchup.awayProjected?.toFixed(1) ?? "—")
                              : matchup.awayScore.toFixed(1),
                            winner: matchup.winner === "away",
                          }}
                          home={{
                            leading: homeTeam && (
                              <TeamLogo
                                teamId={homeTeam._id}
                                teamName={homeTeam.name}
                                espnLogo={homeTeam.logo}
                                customLogo={homeTeam.customLogo}
                                size="sm"
                              />
                            ),
                            name: homeTeam?.name || "Unknown team",
                            sub: homeTeam?.owner,
                            score: isFuture
                              ? (matchup.homeProjected?.toFixed(1) ?? "—")
                              : matchup.homeScore.toFixed(1),
                            winner: matchup.winner === "home",
                          }}
                        />
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="list">
                {matchups.length === 0 ? (
                  <EmptyState
                    icon={<ListX className="size-6" strokeWidth={1.8} />}
                    title="No matchups"
                    description="No matchups available for this week."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-bc-hairline hover:bg-transparent">
                          <TableHead className="bc-label-sm text-bc-text-3">Away</TableHead>
                          <TableHead className="bc-label-sm text-bc-text-3 text-center">
                            Score
                          </TableHead>
                          <TableHead className="bc-label-sm text-bc-text-3">Home</TableHead>
                          <TableHead className="hidden bc-label-sm text-bc-text-3 text-center md:table-cell">
                            Status
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {matchups.map((matchup) => {
                          const homeTeam = getTeamByExternalId(matchup.homeTeamId);
                          const awayTeam = getTeamByExternalId(matchup.awayTeamId);
                          const isFuture = matchup.status === "scheduled";

                          const homeScoreValue = isFuture
                            ? (matchup.homeProjected?.toFixed(1) ?? "—")
                            : matchup.homeScore.toFixed(1);
                          const awayScoreValue = isFuture
                            ? (matchup.awayProjected?.toFixed(1) ?? "—")
                            : matchup.awayScore.toFixed(1);

                          return (
                            <TableRow
                              key={matchup._id}
                              className="border-bc-hairline hover:bg-bc-panel-2"
                            >
                              <TableCell>
                                <div className="flex items-center gap-3">
                                  {(awayTeam?.logo || awayTeam?.customLogo) && (
                                    <TeamLogo
                                      teamId={awayTeam._id}
                                      teamName={awayTeam.name}
                                      espnLogo={awayTeam.logo}
                                      customLogo={awayTeam.customLogo}
                                      size="sm"
                                    />
                                  )}
                                  <div className="flex min-w-0 flex-col gap-0.5">
                                    <span
                                      className={cn(
                                        "truncate font-display text-[15px] font-bold uppercase leading-none",
                                        matchup.winner === "away"
                                          ? "text-bc-ink"
                                          : "text-bc-text-2"
                                      )}
                                    >
                                      {awayTeam?.name || "Unknown team"}
                                    </span>
                                    <span className="bc-label-sm text-bc-text-3 truncate">
                                      {awayTeam?.owner}
                                    </span>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="text-center">
                                <span className="bc-num text-bc-ink">
                                  {awayScoreValue} – {homeScoreValue}
                                </span>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-3">
                                  {(homeTeam?.logo || homeTeam?.customLogo) && (
                                    <TeamLogo
                                      teamId={homeTeam._id}
                                      teamName={homeTeam.name}
                                      espnLogo={homeTeam.logo}
                                      customLogo={homeTeam.customLogo}
                                      size="sm"
                                    />
                                  )}
                                  <div className="flex min-w-0 flex-col gap-0.5">
                                    <span
                                      className={cn(
                                        "truncate font-display text-[15px] font-bold uppercase leading-none",
                                        matchup.winner === "home"
                                          ? "text-bc-ink"
                                          : "text-bc-text-2"
                                      )}
                                    >
                                      {homeTeam?.name || "Unknown team"}
                                    </span>
                                    <span className="bc-label-sm text-bc-text-3 truncate">
                                      {homeTeam?.owner}
                                    </span>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="hidden text-center md:table-cell">
                                {matchup.status === "final" ? (
                                  <Badge variant="secondary">Final</Badge>
                                ) : matchup.status === "live" ? (
                                  <Chip variant="signal" live>
                                    Live
                                  </Chip>
                                ) : (
                                  <Badge variant="outline">Scheduled</Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </Panel>
        </TabsContent>

        <TabsContent value="top-scores">
          <Panel padding="md">
            <SectionHeader
              title={scoreDirection === "highest" ? "Top scores" : "Lowest scores"}
              kicker="League scoring leaders"
            />

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Tabs
                value={scoreDirection}
                onValueChange={(value) => setScoreDirection(value as "highest" | "lowest")}
              >
                <TabsList>
                  <TabsTrigger value="highest">Highest</TabsTrigger>
                  <TabsTrigger value="lowest">Lowest</TabsTrigger>
                </TabsList>
              </Tabs>
              <Tabs
                value={scoreType}
                onValueChange={(value) => setScoreType(value as "single" | "twoWeek")}
              >
                <TabsList>
                  <TabsTrigger value="single">Single week</TabsTrigger>
                  <TabsTrigger value="twoWeek">Two-week</TabsTrigger>
                </TabsList>
              </Tabs>
              <Tabs
                value={topScoresView}
                onValueChange={(value) => setTopScoresView(value as "all-time" | "season")}
              >
                <TabsList>
                  <TabsTrigger value="all-time">All-time</TabsTrigger>
                  <TabsTrigger value="season">Season</TabsTrigger>
                </TabsList>
              </Tabs>
              {topScoresView === "season" && (
                <SeasonSelector
                  currentSeason={currentSeason}
                  selectedSeason={selectedSeason}
                  onSeasonChange={setSelectedSeason}
                  availableSeasons={availableSeasons}
                />
              )}
            </div>

            {topScores.length === 0 ? (
              <div className="mt-5">
                <EmptyState
                  icon={<Trophy className="size-6" strokeWidth={1.8} />}
                  title="No scores yet"
                  description="Scores will appear here once games have been played."
                />
              </div>
            ) : (
              <div className="mt-5 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-bc-hairline hover:bg-transparent">
                      <TableHead className="bc-label-sm text-bc-text-3">Rank</TableHead>
                      <TableHead className="bc-label-sm text-bc-text-3">Team</TableHead>
                      <TableHead className="bc-label-sm text-bc-text-3 text-right">
                        {scoreType === "twoWeek" ? "Total" : "Score"}
                      </TableHead>
                      {scoreType === "twoWeek" && (
                        <>
                          <TableHead className="hidden bc-label-sm text-bc-text-3 text-right sm:table-cell">
                            Week 1
                          </TableHead>
                          <TableHead className="hidden bc-label-sm text-bc-text-3 text-right sm:table-cell">
                            Week 2
                          </TableHead>
                        </>
                      )}
                      <TableHead className="hidden bc-label-sm text-bc-text-3 text-right md:table-cell">
                        {scoreType === "twoWeek" ? "Weeks" : "Week"}
                      </TableHead>
                      <TableHead className="hidden bc-label-sm text-bc-text-3 text-right md:table-cell">
                        Season
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topScores.map((score, index) => {
                      const team =
                        topScoresView === "all-time"
                          ? getTeamByExternalIdAndSeason(score.teamId, score.seasonId)
                          : getTeamByExternalId(score.teamId);
                      const isTwoWeek = scoreType === "twoWeek";
                      const twoWeekScore = score as TwoWeekScore;
                      const singleScore = score as SingleWeekScore;

                      return (
                        <TableRow
                          key={
                            isTwoWeek
                              ? `${twoWeekScore.matchupIds?.join("-")}-${score.isHome}`
                              : `${singleScore.matchupId}-${score.isHome}`
                          }
                          className={cn(
                            "border-bc-hairline hover:bg-bc-panel-2",
                            index === 0 && "bg-bc-panel-2"
                          )}
                        >
                          <TableCell>
                            <RankPlate rank={index + 1} tone={index === 0 ? "first" : "default"} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              {team && (team.logo || team.customLogo) && (
                                <TeamLogo
                                  teamId={team._id}
                                  teamName={team.name}
                                  espnLogo={team.logo}
                                  customLogo={team.customLogo}
                                  size="sm"
                                />
                              )}
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="truncate font-display text-[15px] font-bold uppercase leading-none text-bc-ink">
                                  {team?.name || "Unknown team"}
                                </span>
                                <span className="bc-label-sm text-bc-text-3 truncate">
                                  {team?.owner}
                                </span>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="bc-num text-[19px] text-bc-ink">
                              {isTwoWeek
                                ? twoWeekScore.totalScore?.toFixed(1)
                                : singleScore.score?.toFixed(1)}
                            </span>
                          </TableCell>
                          {scoreType === "twoWeek" && (
                            <>
                              <TableCell className="hidden text-right sm:table-cell">
                                <span className="bc-num text-bc-text-2">
                                  {twoWeekScore.week1Score?.toFixed(1)}
                                </span>
                              </TableCell>
                              <TableCell className="hidden text-right sm:table-cell">
                                <span className="bc-num text-bc-text-2">
                                  {twoWeekScore.week2Score?.toFixed(1)}
                                </span>
                              </TableCell>
                            </>
                          )}
                          <TableCell className="hidden text-right md:table-cell">
                            <span className="bc-label-sm text-bc-text-2">
                              {isTwoWeek
                                ? `${twoWeekScore.startWeek}-${twoWeekScore.startWeek + 1}`
                                : `Week ${singleScore.matchupPeriod}`}
                            </span>
                          </TableCell>
                          <TableCell className="hidden text-right md:table-cell">
                            <span className="bc-label-sm text-bc-text-2">{score.seasonId}</span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </LeaguePageLayout>
  );
}
