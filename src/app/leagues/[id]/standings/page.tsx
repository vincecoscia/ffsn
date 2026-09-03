"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Panel,
  SectionHeader,
  RankPlate,
  LoadingScreen,
  EmptyState,
} from "@/components/broadcast";
import { TeamLogo } from "@/components/TeamLogo";
import { Minus, Trophy } from "lucide-react";

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

function StandingsTable({
  teams,
  showRank = true,
  playoffLineAfter,
}: {
  teams: Team[];
  showRank?: boolean;
  playoffLineAfter?: number;
}) {
  if (teams.length === 0) {
    return (
      <EmptyState
        icon={<Trophy className="size-6" strokeWidth={1.8} />}
        title="No teams yet"
        description="Standings will appear once teams have results for this season."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-bc-hairline hover:bg-transparent">
            {showRank && (
              <TableHead className="bc-label-sm text-bc-text-3">Rk</TableHead>
            )}
            <TableHead className="bc-label-sm text-bc-text-3">Team</TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 md:table-cell">
              Owner
            </TableHead>
            <TableHead className="bc-label-sm text-bc-text-3 text-right">W-L</TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right sm:table-cell">
              Win %
            </TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right sm:table-cell">
              PF
            </TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right md:table-cell">
              PA
            </TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right xl:table-cell">
              Diff
            </TableHead>
            <TableHead className="hidden bc-label-sm text-bc-text-3 text-right xl:table-cell">
              Streak
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {teams.map((team, index) => {
            const totalGames = team.record.wins + team.record.losses + team.record.ties;
            const winPercentage = totalGames > 0 ? team.record.wins / totalGames : 0;
            const pointDiff = (team.record.pointsFor || 0) - (team.record.pointsAgainst || 0);
            const isPlayoffLine =
              playoffLineAfter !== undefined && index + 1 === playoffLineAfter;

            return (
              <TableRow
                key={team._id}
                className={
                  isPlayoffLine
                    ? "border-b-2 border-bc-red hover:bg-bc-panel-2"
                    : "border-bc-hairline hover:bg-bc-panel-2"
                }
              >
                {showRank && (
                  <TableCell>
                    <RankPlate rank={index + 1} tone={index === 0 ? "first" : "default"} />
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex items-center gap-3">
                    <TeamLogo
                      teamId={team._id}
                      teamName={team.name}
                      espnLogo={team.logo}
                      customLogo={team.customLogo}
                      size="sm"
                    />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="font-display text-[17px] font-bold uppercase leading-none text-bc-ink truncate">
                        {team.name}
                      </span>
                      <span className="bc-label-sm text-bc-text-3 md:hidden truncate">
                        {team.owner}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="bc-label-sm text-bc-text-2">{team.owner}</span>
                </TableCell>
                <TableCell className="text-right">
                  <span className="bc-num text-bc-ink">
                    {team.record.wins}-{team.record.losses}
                    {team.record.ties > 0 && `-${team.record.ties}`}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  <span className="bc-num text-bc-text-2">
                    {(winPercentage * 100).toFixed(1)}%
                  </span>
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  <span className="bc-num text-bc-ink">
                    {team.record.pointsFor?.toFixed(1) || "0.0"}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <span className="bc-num text-bc-text-2">
                    {team.record.pointsAgainst?.toFixed(1) || "0.0"}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right xl:table-cell">
                  <span
                    className={
                      pointDiff > 0
                        ? "bc-num text-bc-win"
                        : pointDiff < 0
                          ? "bc-num text-bc-red-text"
                          : "bc-num text-bc-ink"
                    }
                  >
                    {pointDiff > 0 && "+"}
                    {pointDiff.toFixed(1)}
                  </span>
                </TableCell>
                <TableCell className="hidden text-right xl:table-cell">
                  <div className="flex items-center justify-end">
                    {/* Placeholder for streak - would need to calculate from recent matchups */}
                    <Minus className="size-4 text-bc-text-3" />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function StandingsPage({ params }: StandingsPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();

  // Get current/available seasons for the league
  const { currentSeason, availableSeasons, isLoading: isSeasonLoading } = useLeagueSeason(leagueId);

  const [selectedSeason, setSelectedSeason] = useState(currentSeason);

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

  // Get teams for the selected season
  const teamsData = useQuery(api.teams.getByLeagueAndSeason, {
    leagueId,
    seasonId: selectedSeason,
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
    teams.forEach((team) => {
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
  const playoffTeamCount = league?.settings?.playoffTeamCount;

  if (!userId || !league) {
    return <LoadingScreen message="Loading standings" />;
  }

  return (
    <LeaguePageLayout leagueId={leagueId} currentUserId={userId} title="Standings">
      <Panel padding="md">
        <SectionHeader
          title="Standings"
          kicker={`${selectedSeason} season`}
          actions={
            <SeasonSelector
              currentSeason={currentSeason}
              selectedSeason={selectedSeason}
              onSeasonChange={setSelectedSeason}
              availableSeasons={availableSeasons}
            />
          }
        />

        <Tabs defaultValue="overall" className="mt-5 w-full gap-0">
          <TabsList>
            <TabsTrigger value="overall">Overall</TabsTrigger>
            {hasDivisions && <TabsTrigger value="division">Division</TabsTrigger>}
            <TabsTrigger value="power">Power rankings</TabsTrigger>
          </TabsList>

          <TabsContent value="overall" className="mt-5">
            <StandingsTable teams={sortedByRecord} playoffLineAfter={playoffTeamCount} />
          </TabsContent>

          {hasDivisions && (
            <TabsContent value="division" className="mt-5">
              <div className="flex flex-col gap-8">
                {Array.from(teamsByDivision.entries()).map(([divisionId, divTeams]) => {
                  // `leagues.settings.divisions[].id` is now `v.number()`
                  // (ESPN's division ids are numeric; matches
                  // `teams.divisionId`), so compare directly rather than
                  // stringifying - see `convex/lib/espnSettings.ts`.
                  const division = league.settings.divisions?.find(
                    (d) => d.id === divisionId
                  );
                  return (
                    <div key={divisionId} className="flex flex-col gap-3">
                      <span className="bc-h-title text-[20px]">
                        {division?.name || `Division ${divisionId}`}
                      </span>
                      <StandingsTable teams={divTeams} showRank={false} />
                    </div>
                  );
                })}
              </div>
            </TabsContent>
          )}

          <TabsContent value="power" className="mt-5">
            <p className="bc-label-sm text-bc-text-3 mb-4">
              Teams ranked by total points scored, reflecting offensive performance regardless of
              record.
            </p>
            <StandingsTable teams={sortedByPoints} />
          </TabsContent>
        </Tabs>
      </Panel>
    </LeaguePageLayout>
  );
}
