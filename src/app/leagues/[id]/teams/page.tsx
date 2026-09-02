"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { RivalriesTab } from "@/components/RivalriesTab";
import { TeamRelationships } from "@/components/TeamRelationships";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronDown, ChevronUp, Users, Swords, Radio } from "lucide-react";
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
import { Panel, SectionHeader, RankPlate, TeamTile, StatBlock, LoadingScreen } from "@/components/broadcast";
import { cn } from "@/lib/utils";

interface TeamsPageProps {
  params: Promise<{ id: string }>;
}

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  customLogo?: Id<"_storage">;
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

function initialsFor(team: Pick<Team, "name" | "abbreviation">) {
  if (team.abbreviation) return team.abbreviation.slice(0, 3).toUpperCase();
  const words = team.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export default function TeamsPage({ params }: TeamsPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();

  // Get current/available seasons for the league
  const { currentSeason, availableSeasons, isLoading: isSeasonLoading } = useLeagueSeason(leagueId);

  const [selectedSeason, setSelectedSeason] = useState(currentSeason);
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState("teams");
  // Which team's relationship meters the "The desk" tab is showing.
  const [deskTeamId, setDeskTeamId] = useState<Id<"teams"> | null>(null);

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
    seasonId: selectedSeason
  });

  const teams = React.useMemo(() => teamsData || [], [teamsData]);

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
      // First, separate starting players from bench/IR players
      // lineupSlotId === 20 indicates bench player, lineupSlotId === 21 indicates IR
      const aIsBench = a.lineupSlotId === 20 || a.lineupSlotId === 21;
      const bIsBench = b.lineupSlotId === 20 || b.lineupSlotId === 21;

      // Starting players come first
      if (aIsBench && !bIsBench) return 1;
      if (!aIsBench && bIsBench) return -1;

      // If both are starting or both are bench/IR, sort by position
      const aIndex = POSITION_ORDER.indexOf(a.position);
      const bIndex = POSITION_ORDER.indexOf(b.position);

      if (aIndex === -1 && bIndex === -1) return 0;
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;

      return aIndex - bIndex;
    });
  };

  if (!userId || !league) {
    return <LoadingScreen message="Loading teams" />;
  }

  return (
    <LeaguePageLayout
      leagueId={leagueId}
      currentUserId={userId}
      title="Teams"
    >
      <Panel padding="md">
        <SectionHeader
          title="Teams"
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

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-5 w-full gap-5">
          <TabsList>
            <TabsTrigger value="teams" className="gap-2">
              <Users className="size-4" />
              Teams
            </TabsTrigger>
            <TabsTrigger value="rivalries" className="gap-2">
              <Swords className="size-4" />
              Rivalries
            </TabsTrigger>
            <TabsTrigger value="desk" className="gap-2">
              <Radio className="size-4" />
              The desk
            </TabsTrigger>
          </TabsList>

          <TabsContent value="teams">
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {sortedTeams.map((team, index) => {
                const isExpanded = expandedTeams.has(team._id);
                const totalGames = team.record.wins + team.record.losses + team.record.ties;
                const winPercentage = totalGames > 0 ? (team.record.wins / totalGames) : 0;
                const pointDiff = (team.record.pointsFor || 0) - (team.record.pointsAgainst || 0);

                return (
                  <Panel key={team._id} padding="md" lifted>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 items-center gap-4">
                        <TeamTile initials={initialsFor(team)} src={team.logo} size={56} />
                        <div className="min-w-0">
                          <span className="block truncate font-display text-[22px] font-extrabold uppercase leading-none text-bc-ink">
                            {team.name}
                          </span>
                          <span className="mt-1.5 block truncate bc-label-sm text-bc-text-3">
                            {team.ownerInfo?.displayName || team.owner}
                          </span>
                        </div>
                      </div>
                      <RankPlate rank={index + 1} tone={index === 0 ? "first" : "default"} />
                    </div>

                    <div className="mt-5 grid grid-cols-3 border border-bc-hairline bg-bc-ground">
                      <StatBlock
                        align="center"
                        className="border-r border-bc-hairline p-3"
                        label="Record"
                        value={
                          <>
                            {team.record.wins}-{team.record.losses}
                            {team.record.ties > 0 && `-${team.record.ties}`}
                          </>
                        }
                      />
                      <StatBlock
                        align="center"
                        className="border-r border-bc-hairline p-3"
                        label={`Points for · ${(winPercentage * 100).toFixed(0)}% win`}
                        value={team.record.pointsFor?.toFixed(1) || "0.0"}
                      />
                      <StatBlock
                        align="center"
                        className="p-3"
                        label={`Diff · vs ${team.record.pointsAgainst?.toFixed(1) || "0.0"}`}
                        value={
                          <span className={pointDiff > 0 ? "text-bc-win" : pointDiff < 0 ? "text-bc-red-text" : undefined}>
                            {pointDiff > 0 && "+"}
                            {pointDiff.toFixed(1)}
                          </span>
                        }
                      />
                    </div>

                    <Collapsible open={isExpanded} onOpenChange={() => toggleTeamExpansion(team._id)}>
                      <CollapsibleTrigger asChild>
                        <Button variant="outline" className="mt-5 w-full">
                          <span>Roster ({team.roster.length} players)</span>
                          {isExpanded ? (
                            <ChevronUp className="ml-2 size-4" />
                          ) : (
                            <ChevronDown className="ml-2 size-4" />
                          )}
                        </Button>
                      </CollapsibleTrigger>

                      <CollapsibleContent className="mt-4">
                        <div className="overflow-x-auto border border-bc-hairline">
                          <Table>
                            <TableHeader>
                              <TableRow className="border-bc-hairline bg-bc-panel-2 hover:bg-bc-panel-2">
                                <TableHead className="bc-label-sm text-bc-text-3">Player</TableHead>
                                <TableHead className="bc-label-sm text-bc-text-3 text-center">Pos</TableHead>
                                <TableHead className="hidden bc-label-sm text-bc-text-3 text-center md:table-cell">
                                  Team
                                </TableHead>
                                <TableHead className="bc-label-sm text-bc-text-3 text-right">Points</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {(() => {
                                const sortedRoster = sortRosterByPosition(team.roster);
                                const startingPlayers = sortedRoster.filter(player => player.lineupSlotId !== 20 && player.lineupSlotId !== 21);
                                const benchPlayers = sortedRoster.filter(player => player.lineupSlotId === 20);
                                const irPlayers = sortedRoster.filter(player => player.lineupSlotId === 21);

                                const section = (
                                  key: string,
                                  label: string,
                                  players: typeof sortedRoster,
                                  tone: "starting" | "bench" | "ir"
                                ) =>
                                  players.length > 0 && (
                                    <React.Fragment key={key}>
                                      <TableRow className="border-bc-hairline hover:bg-transparent">
                                        <TableCell
                                          colSpan={4}
                                          className={cn(
                                            "bc-label-sm py-2",
                                            tone === "starting" && "text-bc-ink",
                                            tone === "bench" && "text-bc-text-3",
                                            tone === "ir" && "text-bc-red-text"
                                          )}
                                        >
                                          {label} ({players.length})
                                        </TableCell>
                                      </TableRow>
                                      {players.map((player, idx) => (
                                        <TableRow
                                          key={`${key}-${player.playerId}-${idx}`}
                                          className="border-bc-hairline hover:bg-bc-panel-2"
                                        >
                                          <TableCell
                                            className={cn(
                                              "font-medium",
                                              tone !== "starting" && "text-bc-text-2"
                                            )}
                                          >
                                            {player.playerName}
                                          </TableCell>
                                          <TableCell className="text-center">
                                            <Badge variant={tone === "ir" ? "red" : tone === "bench" ? "secondary" : "outline"}>
                                              {player.position}
                                            </Badge>
                                          </TableCell>
                                          <TableCell className="hidden text-center md:table-cell">
                                            <span className="bc-label-sm text-bc-text-3">{player.team}</span>
                                          </TableCell>
                                          <TableCell className="text-right">
                                            <span className="bc-num text-bc-ink">
                                              {player.playerStats?.appliedTotal?.toFixed(1) || "–"}
                                            </span>
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </React.Fragment>
                                  );

                                return (
                                  <>
                                    {section("starting", "Starting lineup", startingPlayers, "starting")}
                                    {section("bench", "Bench", benchPlayers, "bench")}
                                    {section("ir", "Injured reserve", irPlayers, "ir")}
                                  </>
                                );
                              })()}
                            </TableBody>
                          </Table>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </Panel>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="rivalries">
            <RivalriesTab leagueId={leagueId} />
          </TabsContent>

          <TabsContent value="desk" className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-2">
              {sortedTeams.map((team) => {
                const active = (deskTeamId ?? sortedTeams[0]?._id) === team._id;
                return (
                  <Button
                    key={team._id}
                    variant={active ? "default" : "outline"}
                    size="sm"
                    onClick={() => setDeskTeamId(team._id)}
                  >
                    {team.name}
                  </Button>
                );
              })}
            </div>
            {(deskTeamId ?? sortedTeams[0]?._id) && (
              <TeamRelationships
                leagueId={leagueId}
                teamId={(deskTeamId ?? sortedTeams[0]._id) as Id<"teams">}
              />
            )}
          </TabsContent>
        </Tabs>
      </Panel>
    </LeaguePageLayout>
  );
}
