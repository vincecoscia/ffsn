"use client";

import React from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { TrendingUp, Users, Trophy, Flame, Zap, Swords } from "lucide-react";
import { Panel, SectionHeader, TeamTile, StatBlock, LoadingScreen, EmptyState } from "@/components/broadcast";

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

function initialsFor(team: Pick<Team, "name">) {
  const words = team.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const getIntensityIcon = (intensity: string) => {
  switch (intensity) {
    case "heated":
      return <Flame className="size-4 text-bc-red-text" />;
    default:
      return <Zap className="size-4 text-bc-signal" />;
  }
};

export function RivalriesTab({ leagueId }: RivalriesTabProps) {
  const rivalries = useQuery(api.rivalries.calculateHistoricalRivalries, { leagueId }) as Rivalry[] | undefined;

  if (!rivalries) {
    return <LoadingScreen message="Loading rivalries" />;
  }

  if (rivalries.length === 0) {
    return (
      <EmptyState
        icon={<Swords className="size-6" strokeWidth={1.8} />}
        title="No rivalries yet"
        description="Rivalries will appear as teams play more games against each other."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Rivalries Overview */}
      <div className="grid grid-cols-2 border border-bc-hairline bg-bc-ground lg:grid-cols-4">
        <div className="flex items-center justify-between gap-2 border-r border-b border-bc-hairline p-4 lg:border-b-0">
          <StatBlock label="Total rivalries" value={rivalries.length} />
          <Users className="size-4 text-bc-text-3" />
        </div>
        <div className="flex items-center justify-between gap-2 border-b border-bc-hairline p-4 lg:border-r lg:border-b-0">
          <StatBlock label="Heated rivalries" value={rivalries.filter(r => r.intensity === "heated").length} />
          <Flame className="size-4 text-bc-text-3" />
        </div>
        <div className="flex items-center justify-between gap-2 border-r border-bc-hairline p-4">
          <StatBlock label="Playoff battles" value={rivalries.reduce((sum, r) => sum + r.playoffMeetings, 0)} />
          <Trophy className="size-4 text-bc-text-3" />
        </div>
        <div className="flex items-center justify-between gap-2 p-4">
          <StatBlock label="Championships" value={rivalries.reduce((sum, r) => sum + r.championshipMeetings, 0)} />
          <Trophy className="size-4 text-bc-text-3" />
        </div>
      </div>

      {/* Rivalries List */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {rivalries.map((rivalry, index) => {
          const winPctA = (rivalry.winPercentageA || 0) * 100;
          const winPctB = (rivalry.winPercentageB || 0) * 100;

          return (
            <Panel key={`${rivalry.teamA._id}-${rivalry.teamB._id}`} padding="md">
              <SectionHeader
                size="sm"
                title={
                  <span className="flex items-center gap-2">
                    {getIntensityIcon(rivalry.intensity)}
                    Rivalry #{index + 1}
                  </span>
                }
                kicker={
                  <>
                    {rivalry.totalGames} games · {rivalry.playoffMeetings} playoff meetings
                    {rivalry.championshipMeetings > 0 &&
                      ` · ${rivalry.championshipMeetings} championship${rivalry.championshipMeetings > 1 ? "s" : ""}`}
                  </>
                }
                actions={
                  <Badge variant={rivalry.intensity === "heated" ? "red" : "signal"}>
                    {rivalry.intensity}
                  </Badge>
                }
              />

              <div className="mt-5 flex flex-col gap-4">
                {/* Head-to-Head Matchup */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-1 flex-col items-center gap-2 text-center">
                    <TeamTile initials={initialsFor(rivalry.teamA)} size={40} />
                    <div>
                      <div className="font-display text-[16px] font-bold uppercase leading-none text-bc-ink">
                        {rivalry.teamA.name}
                      </div>
                      <div className="bc-label-sm mt-1 text-bc-text-3">
                        {rivalry.teamA.ownerInfo?.displayName || rivalry.teamA.owner}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-1 px-2">
                    <span className="bc-num text-[24px] text-bc-ink">
                      {rivalry.teamAWins} – {rivalry.teamBWins}
                    </span>
                    {rivalry.ties > 0 && (
                      <span className="bc-label-sm text-bc-text-3">{rivalry.ties} ties</span>
                    )}
                  </div>

                  <div className="flex flex-1 flex-col items-center gap-2 text-center">
                    <TeamTile initials={initialsFor(rivalry.teamB)} size={40} />
                    <div>
                      <div className="font-display text-[16px] font-bold uppercase leading-none text-bc-ink">
                        {rivalry.teamB.name}
                      </div>
                      <div className="bc-label-sm mt-1 text-bc-text-3">
                        {rivalry.teamB.ownerInfo?.displayName || rivalry.teamB.owner}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Record bar: red = teamA's share, hairline = teamB's share */}
                <div className="flex flex-col gap-1.5">
                  <div className="h-2 w-full bg-bc-hairline">
                    <div className="h-2 bg-bc-red" style={{ width: `${winPctA}%` }} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="bc-label-sm text-bc-text-3">
                      {rivalry.teamA.name} · {winPctA.toFixed(0)}%
                    </span>
                    <span className="bc-label-sm text-bc-text-3">
                      {rivalry.teamB.name} · {winPctB.toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Recent Meetings */}
              {rivalry.recentMeetings && rivalry.recentMeetings.length > 0 && (
                <>
                  <Separator className="my-5 bg-bc-hairline" />
                  <div className="flex flex-col gap-3">
                    <span className="bc-label-sm flex items-center gap-2 text-bc-text-3">
                      <TrendingUp className="size-4" />
                      Recent meetings
                    </span>
                    <div className="flex flex-col">
                      {rivalry.recentMeetings.slice(0, 3).map((meeting, idx) => {
                        const homeTeamName = meeting.homeTeam === rivalry.teamA.externalId ? rivalry.teamA.name : rivalry.teamB.name;
                        const awayTeamName = meeting.awayTeam === rivalry.teamA.externalId ? rivalry.teamA.name : rivalry.teamB.name;

                        return (
                          <div
                            key={idx}
                            className="flex items-center justify-between gap-3 border-t border-bc-hairline py-2.5 first:border-t-0"
                          >
                            <div className="flex items-center gap-2">
                              <span className="bc-label-sm text-bc-text-2">
                                {meeting.seasonId} · W{meeting.week}
                              </span>
                              {meeting.isChampionship && <Badge variant="plate">Championship</Badge>}
                              {meeting.isPlayoff && !meeting.isChampionship && (
                                <Badge variant="outline">Playoff</Badge>
                              )}
                            </div>
                            <div className="text-right">
                              <div className="bc-label-sm text-bc-text-3">
                                {awayTeamName} @ {homeTeamName}
                              </div>
                              <div className="bc-num text-bc-ink">
                                {meeting.awayScore.toFixed(1)} – {meeting.homeScore.toFixed(1)}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
