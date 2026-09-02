"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";

import {
  Panel,
  SectionHeader,
  Chip,
  BannerPlaceholder,
  LowerThird,
  PersonaAvatar,
  RankPlate,
  contentTypeLabel,
  personaName,
  personaRole,
} from "@/components/broadcast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { ContentGenerator } from "./ContentGenerator";
import { LeagueWeeklySection } from "./LeagueWeeklySection";
import { ArticleList } from "./ArticleList";
import { TeamLogo } from "./TeamLogo";
import { LeagueSidebar } from "@/components/league/LeagueSidebar";
import { MyDeskRelationships } from "./MyDeskRelationships";
import { WriterLineup } from "./WriterLineup";
import { LeagueWaitingOnComment } from "./WaitingOnComment";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { cn } from "@/lib/utils";

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  owner: string;
  externalId: string;
  customLogo?: Id<"_storage">;
  record: {
    wins: number;
    losses: number;
    ties: number;
    pointsFor?: number;
    pointsAgainst?: number;
  };
}

interface League {
  _id: Id<"leagues">;
  name: string;
  role: "commissioner" | "member";
  platform: string;
  settings: {
    scoringType: string;
    rosterSize: number;
    playoffWeeks: number;
    categories: string[];
  };
}

interface TeamClaim {
  _id: Id<"teamClaims">;
  teamId: Id<"teams">;
  userId: string;
}

interface LeagueHomepageProps {
  league: League;
  teams: Team[];
  teamClaims: TeamClaim[];
  currentUserId?: string;
  isCommissioner: boolean;
}

// Bylines resolve through `getPersonaDisplay` (re-exported as personaName /
// personaRole from the broadcast kit), so archived articles by retired writers
// keep their real name and role instead of a de-slugged guess.

export function LeagueHomepage({ league, teams, teamClaims, currentUserId, isCommissioner }: LeagueHomepageProps) {
  const { currentSeason } = useLeagueSeason(league._id);
  const [showContentGenerator, setShowContentGenerator] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);

  // Get featured story (most recent AI content with image)
  const featuredStory = useQuery(api.aiContent.getMostRecentWithImage, {
    leagueId: league._id
  });

  // Get AI content result for pagination controls
  const aiContentResult = useQuery(api.aiContent.getByLeague, {
    leagueId: league._id,
    paginationOpts: {
      numItems: 3,
      cursor: cursor
    }
  });

  // Pagination functions
  const handleNextPage = () => {
    if (aiContentResult && !aiContentResult.isDone) {
      setCursor(aiContentResult.continueCursor);
      setCurrentPage(prev => prev + 1);
    }
  };

  const handlePreviousPage = () => {
    if (currentPage > 1) {
      // For simplicity, we'll reset to first page when going back
      // In a more complex implementation, you'd store previous cursors
      setCursor(null);
      setCurrentPage(1);
    }
  };

  const canGoNext = aiContentResult && !aiContentResult.isDone;
  const canGoPrevious = currentPage > 1;

  // Get user's claimed team (for the standings "You" highlight)
  const userTeam = teams.find(team => {
    const claim = teamClaims.find(claim =>
      claim.teamId === team._id && claim.userId === currentUserId
    );
    return !!claim;
  });

  // Sort teams by wins, then by points for
  const sortedTeams = [...teams].sort((a, b) => {
    if (a.record.wins !== b.record.wins) {
      return b.record.wins - a.record.wins;
    }
    return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
  });

  const isRecent =
    !!featuredStory &&
    Date.now() - new Date(featuredStory.publishedAt || featuredStory.createdAt).getTime() <
      1 * 24 * 60 * 60 * 1000;

  return (
    <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* Main content */}
      <div className="flex min-w-0 flex-col gap-10">
        {/* Featured story */}
        {featuredStory && (
          <Panel cut="tr" scan className="relative h-[320px] overflow-hidden sm:h-[400px] lg:h-[460px]">
            <div className="absolute inset-0">
              {featuredStory.bannerImageUrl ? (
                <img
                  src={featuredStory.bannerImageUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <BannerPlaceholder
                  text={typeof featuredStory.metadata.week === "number" ? `WK ${featuredStory.metadata.week}` : undefined}
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-bc-ground via-bc-ground/55 to-transparent" />
            </div>

            <div className="absolute inset-x-4 bottom-4 flex flex-col gap-4 sm:inset-x-6 sm:bottom-6">
              <div className="flex flex-wrap items-center gap-2.5">
                {isRecent && <Chip live>New</Chip>}
                <Badge variant="plate">{contentTypeLabel(featuredStory.type)}</Badge>
                <span className="bc-label text-bc-text-2">
                  {new Date(featuredStory.publishedAt || featuredStory.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              </div>

              <Link href={`/articles/${featuredStory._id}`}>
                <h1 className="bc-display max-w-2xl text-[28px] text-bc-ink sm:text-[36px] lg:text-[44px]">
                  {featuredStory.title}
                </h1>
              </Link>

              <MarkdownPreview
                content={featuredStory.content}
                preview
                maxLines={2}
                className="max-w-xl text-[15px] leading-relaxed text-bc-text-2"
              />

              <div className="flex flex-wrap items-center justify-between gap-4">
                <LowerThird
                  compact
                  name={personaName(featuredStory.persona)}
                  role={personaRole(featuredStory.persona)}
                  avatar={<PersonaAvatar persona={featuredStory.persona} size={40} />}
                />
                <Button asChild variant="glow">
                  <Link href={`/articles/${featuredStory._id}`}>
                    Read the story
                    <ArrowRight className="size-[18px]" strokeWidth={2} />
                  </Link>
                </Button>
              </div>
            </div>
          </Panel>
        )}

        {/* Scoreboard */}
        <LeagueWeeklySection leagueId={league._id} teams={teams} seasonId={currentSeason} />

        {/* League stories */}
        <div className="flex flex-col gap-5">
          <SectionHeader
            title="League stories"
            actions={
              isCommissioner ? (
                <div className="flex items-center gap-3.5">
                  <span className="bc-label hidden text-bc-text-3 sm:inline">Commissioner only</span>
                  <Button variant="outline" onClick={() => setShowContentGenerator((v) => !v)}>
                    {showContentGenerator ? "Hide generator" : "Generate a story"}
                  </Button>
                </div>
              ) : undefined
            }
          />

          {showContentGenerator && isCommissioner && (
            <Panel padding="md">
              <ContentGenerator leagueId={league._id} isCommissioner={true} />
            </Panel>
          )}

          {/* A story holding for comment sits above the stories that already ran —
              it's the only one anyone can still change (spec §8.2). */}
          <LeagueWaitingOnComment leagueId={league._id} />


          <ArticleList
            leagueId={league._id}
            cursor={cursor}
            isCommissioner={isCommissioner}
            onShowContentGenerator={() => setShowContentGenerator(true)}
          />

          {aiContentResult && aiContentResult.page && aiContentResult.page.length > 0 && (canGoNext || canGoPrevious) && (
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="outline"
                size="icon"
                onClick={handlePreviousPage}
                disabled={!canGoPrevious}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-5" strokeWidth={2} />
              </Button>
              <Badge variant="secondary">Page {currentPage}</Badge>
              <Button
                variant="outline"
                size="icon"
                onClick={handleNextPage}
                disabled={!canGoNext}
                aria-label="Next page"
              >
                <ChevronRight className="size-5" strokeWidth={2} />
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Sidebar */}
      <div className="flex flex-col gap-7">
        <MyDeskRelationships leagueId={league._id} />
        <LeagueSidebar leagueId={league._id} currentUserId={currentUserId} />
      </div>

      {/* On-air talent */}
      <div className="col-span-full flex flex-col gap-5">
        <SectionHeader
          title="The desk"
          actions={
            <span className="bc-label text-bc-text-3">
              Who covers {league.name}
            </span>
          }
        />
        <WriterLineup leagueId={league._id} />
      </div>

      {/* Standings: full-width big board */}
      <div className="col-span-full flex flex-col gap-5">
        <SectionHeader
          title="Standings"
          actions={
            <span className="bc-label text-bc-text-3">
              {teams.length} teams &middot; {league.settings.scoringType.toUpperCase()}
            </span>
          }
        />
        <Panel className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="h-10 hover:bg-transparent">
                <TableHead className="bc-label-sm w-[60px] text-bc-text-3">Rk</TableHead>
                <TableHead className="bc-label-sm text-bc-text-3">Team</TableHead>
                <TableHead className="bc-label-sm text-bc-text-3">Owner</TableHead>
                <TableHead className="bc-label-sm text-right text-bc-text-3">W-L</TableHead>
                <TableHead className="bc-label-sm text-right text-bc-text-3">PF</TableHead>
                <TableHead className="bc-label-sm text-right text-bc-text-3">PA</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedTeams.map((team, index) => {
                const rank = index + 1;
                const isUser = userTeam?._id === team._id;
                return (
                  <TableRow key={team._id} className={cn("h-[54px]", isUser && "bg-bc-panel-2")}>
                    <TableCell>
                      <RankPlate rank={rank} tone={rank === 1 ? "first" : isUser ? "outline" : "default"} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <TeamLogo
                          teamId={team._id}
                          teamName={team.name}
                          espnLogo={team.logo}
                          customLogo={team.customLogo}
                          size="sm"
                        />
                        <span className="font-display text-[15px] font-bold tracking-[0.02em] text-bc-ink uppercase">
                          {team.name}
                        </span>
                        {isUser && (
                          <Badge className="text-[10px]" variant="default">
                            You
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="bc-label-sm text-bc-text-3">{team.owner}</TableCell>
                    <TableCell className="bc-num text-right text-[15px] text-bc-ink">
                      {team.record.wins}-{team.record.losses}
                      {team.record.ties > 0 && `-${team.record.ties}`}
                    </TableCell>
                    <TableCell className="bc-num text-right text-[15px] text-bc-ink">
                      {(team.record.pointsFor ?? 0).toFixed(1)}
                    </TableCell>
                    <TableCell className="bc-num text-right text-[15px] text-bc-text-2">
                      {(team.record.pointsAgainst ?? 0).toFixed(1)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Panel>
      </div>
    </div>
  );
}
