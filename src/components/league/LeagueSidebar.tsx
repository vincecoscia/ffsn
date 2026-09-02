"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Plus, UserPlus, Users } from "lucide-react";

import { Panel, SectionHeader, StatBlock, RankPlate, TeamTile } from "@/components/broadcast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { TeamLogo } from "@/components/TeamLogo";
import { ESPNNewsWidget } from "@/components/ESPNNewsWidget";
import { CommissionerTeamSelection } from "@/components/CommissionerTeamSelection";
import { TeamInviteManager } from "@/components/TeamInviteManager";

export interface LeagueSidebarProps {
  leagueId: Id<"leagues">;
  currentUserId?: string;
  className?: string;
}

function ordinalSuffix(n: number): string {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return "st";
  if (j === 2 && k !== 12) return "nd";
  if (j === 3 && k !== 13) return "rd";
  return "th";
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-bc-hairline py-3">
      <span className="bc-label-sm text-bc-text-3">{label}</span>
      <span className="font-display text-[17px] font-bold text-bc-ink">{value}</span>
    </div>
  );
}

/**
 * The league shell's right rail: "Your team" (or the claim-your-team state),
 * the ESPN "NFL wire" widget, "League info" and "Trending now". Fetches its
 * own data from `leagueId` so it can be dropped into both `LeagueHomepage`
 * and `LeaguePageLayout` without prop drilling.
 */
export function LeagueSidebar({ leagueId, currentUserId, className }: LeagueSidebarProps) {
  const [showTeamClaimModal, setShowTeamClaimModal] = useState(false);
  const [showTeamInviteManager, setShowTeamInviteManager] = useState(false);

  const league = useQuery(api.leagues.getById, { id: leagueId });
  const { currentSeason } = useLeagueSeason(leagueId);

  const teams = useQuery(api.teams.getByLeagueAndSeason, {
    leagueId,
    seasonId: currentSeason,
  });

  const teamClaims = useQuery(api.teamClaims.getByLeague, {
    leagueId,
    seasonId: currentSeason,
  });

  const trendingNews = useQuery(api.news.getLatestNews, {
    type: "Media",
    limit: 3,
  });

  if (league === undefined || teams === undefined || teamClaims === undefined) {
    return (
      <div className={cn("flex flex-col gap-7", className)}>
        <Skeleton className="h-[320px]" />
        <Skeleton className="h-[240px]" />
      </div>
    );
  }

  if (!league) {
    return null;
  }

  const isCommissioner = league.role === "commissioner";

  const userTeam = teams.find((team) =>
    teamClaims.some((claim) => claim.teamId === team._id && claim.userId === currentUserId)
  );

  const sortedTeams = [...teams].sort((a, b) => {
    if (a.record.wins !== b.record.wins) return b.record.wins - a.record.wins;
    return (b.record.pointsFor || 0) - (a.record.pointsFor || 0);
  });
  const place = userTeam ? sortedTeams.findIndex((t) => t._id === userTeam._id) + 1 : 0;

  const claimedTeamIds = new Set(teamClaims.map((claim) => claim.teamId));
  const allTeamsClaimed = teams.length > 0 && claimedTeamIds.size === teams.length;
  const shouldShowInviteOption = isCommissioner && !allTeamsClaimed;

  return (
    <div className={cn("flex flex-col gap-7", className)}>
      {/* Your team */}
      {userTeam ? (
        <Panel cut="tr" padding="md" className="flex flex-col gap-[18px] border-t-4 border-t-bc-red">
          <div className="flex items-center justify-between">
            <span className="bc-label text-bc-text-2">Your team</span>
            {isCommissioner && <Badge variant="outline">Commissioner</Badge>}
          </div>

          <div className="flex items-center gap-4">
            <TeamLogo
              teamId={userTeam._id}
              teamName={userTeam.name}
              espnLogo={userTeam.logo}
              customLogo={userTeam.customLogo}
              size="lg"
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="truncate font-display text-[24px] leading-[0.95] font-extrabold text-bc-ink uppercase sm:text-[26px]">
                {userTeam.name}
              </span>
              <span className="truncate text-[15px] text-bc-text-2">{userTeam.owner}</span>
            </div>
          </div>

          <div className="grid grid-cols-3 border border-bc-hairline bg-bc-ground">
            <div className="border-r border-bc-hairline p-3">
              <StatBlock
                label="Record"
                value={`${userTeam.record.wins}-${userTeam.record.losses}${userTeam.record.ties > 0 ? `-${userTeam.record.ties}` : ""}`}
              />
            </div>
            <div className="border-r border-bc-hairline p-3">
              <StatBlock label="Points for" value={(userTeam.record.pointsFor ?? 0).toFixed(1)} />
            </div>
            <div className="p-3">
              <StatBlock
                label="Place"
                value={
                  place > 0 ? (
                    <>
                      {place}
                      <span className="align-top text-[0.55em]">{ordinalSuffix(place)}</span>
                    </>
                  ) : (
                    "—"
                  )
                }
              />
            </div>
          </div>

          {shouldShowInviteOption && (
            <Button variant="outline" onClick={() => setShowTeamInviteManager(true)}>
              <UserPlus className="size-4" strokeWidth={1.8} />
              Invite players
            </Button>
          )}
        </Panel>
      ) : (
        currentUserId && (
          <Panel
            cut="tr"
            padding="md"
            className="flex flex-col items-center gap-4 border-t-4 border-t-bc-red text-center"
          >
            <span className="bc-label self-start text-bc-text-2">Your team</span>
            <span className="inline-flex size-16 items-center justify-center border border-bc-hairline bg-bc-panel-2 text-bc-text-2">
              <Users className="size-7" strokeWidth={1.8} />
            </span>
            <div className="flex flex-col gap-1.5">
              <span className="font-display text-[20px] font-extrabold text-bc-ink uppercase">
                No team claimed
              </span>
              <p className="max-w-xs text-[14px] text-bc-text-2">
                Join the league by claiming your team for the {currentSeason} season.
              </p>
            </div>
            <Button className="w-full" onClick={() => setShowTeamClaimModal(true)}>
              <Plus className="size-4" strokeWidth={2} />
              Claim your team
            </Button>
            {shouldShowInviteOption && (
              <Button variant="outline" className="w-full" onClick={() => setShowTeamInviteManager(true)}>
                <UserPlus className="size-4" strokeWidth={1.8} />
                Invite players
              </Button>
            )}
          </Panel>
        )
      )}

      {/* NFL wire */}
      <ESPNNewsWidget limit={5} />

      {/* League info */}
      <Panel padding="none" className="flex flex-col px-5 pt-5 pb-2 sm:px-[22px]">
        <SectionHeader
          size="sm"
          title="League info"
          actions={<span className="bc-label-sm text-bc-text-3">{league.name}</span>}
          className="pb-3"
        />
        <div className="flex flex-col">
          <InfoRow label="Teams" value={teams.length} />
          <InfoRow label="Scoring" value={league.settings.scoringType.toUpperCase()} />
          <InfoRow label="Your role" value={<span className="capitalize">{league.role}</span>} />
          <InfoRow label="Platform" value={league.platform.toUpperCase()} />
        </div>
      </Panel>

      {/* Trending now */}
      {trendingNews && trendingNews.articles.length > 0 && (
        <Panel padding="none" className="flex flex-col px-5 pt-5 pb-2 sm:px-[22px]">
          <SectionHeader
            size="sm"
            title="Trending now"
            actions={<span className="bc-label-sm text-bc-text-3">Fantasy wire</span>}
            className="pb-3"
          />
          <div className="flex flex-col">
            {trendingNews.articles.map((article, index) => {
              const image = article.images?.[0];
              return (
                <a
                  key={article.espnId}
                  href={article.links.web}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="grid grid-cols-[32px_72px_1fr] items-center gap-3 border-t border-bc-hairline py-3 sm:grid-cols-[32px_88px_1fr]"
                >
                  <RankPlate rank={index + 1} tone={index === 0 ? "first" : "default"} />
                  <div className="h-14 w-[72px] flex-none overflow-hidden border border-bc-hairline bg-bc-panel-2 sm:w-[88px]">
                    {image ? (
                      <img
                        src={image.url}
                        alt={image.alt || article.headline}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <TeamTile initials="FF" size={32} />
                      </div>
                    )}
                  </div>
                  <span className="line-clamp-2 text-[15px] font-medium text-bc-ink">
                    {article.headline}
                  </span>
                </a>
              );
            })}
          </div>
        </Panel>
      )}

      {/* Team Claim Modal */}
      {showTeamClaimModal && currentUserId && !userTeam && (
        <CommissionerTeamSelection
          league={league}
          teams={teams}
          onClose={() => setShowTeamClaimModal(false)}
        />
      )}

      {/* Team Invite Manager Modal */}
      {showTeamInviteManager && shouldShowInviteOption && (
        <TeamInviteManager
          league={league}
          teams={teams}
          teamClaims={teamClaims}
          isOpen={showTeamInviteManager}
          onClose={() => setShowTeamInviteManager(false)}
        />
      )}
    </div>
  );
}
