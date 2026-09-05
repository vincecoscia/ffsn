"use client";

import React from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AppHeader,
  LoadingScreen,
  EmptyState,
  Chip,
  type AppHeaderNavItem,
} from "@/components/broadcast";
import { NotificationDropdown } from "@/components/notifications";
import { CreditWallet } from "@/components/CreditWallet";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { useLeagueTicker } from "@/components/league/useLeagueTicker";

interface LeagueLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

export default function LeagueLayout({ children, params }: LeagueLayoutProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;

  const league = useQuery(api.leagues.getById, { id: leagueId });
  const { currentSeason } = useLeagueSeason(leagueId);

  const teams = useQuery(api.teams.getByLeagueAndSeason, {
    leagueId,
    seasonId: currentSeason,
  });

  const ticker = useLeagueTicker(leagueId, league?.settings);

  // Loading
  if (league === undefined) {
    return <LoadingScreen message="Loading your league" />;
  }

  // Not found / no access
  if (!league) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bc-ground px-4">
        <EmptyState
          icon={<TriangleAlert className="size-6" strokeWidth={1.8} />}
          title="League not found"
          description="This league doesn't exist or you don't have access to it."
          action={
            <Button asChild>
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const isCommissioner = league.role === "commissioner";
  const teamCount = teams?.length ?? league.espnData?.size ?? 0;

  const nav: AppHeaderNavItem[] = [
    { label: "Home", href: `/leagues/${league._id}`, exact: true },
    { label: "The Wire", href: `/leagues/${league._id}/wire` },
    { label: "Scores", href: `/leagues/${league._id}/scores` },
    { label: "Schedule", href: `/leagues/${league._id}/schedule` },
    { label: "Standings", href: `/leagues/${league._id}/standings` },
    { label: "Teams", href: `/leagues/${league._id}/teams` },
    { label: "Transactions", href: `/leagues/${league._id}/transactions` },
    { label: "Players", href: `/leagues/${league._id}/players` },
    { label: "AI Content", href: `/leagues/${league._id}/ai-generation` },
    { label: "Calendar", href: `/leagues/${league._id}/content-calendar` },
    ...(isCommissioner
      ? [{ label: "Settings", href: `/leagues/${league._id}/settings` }]
      : []),
  ];

  const leagueMeta = `${teamCount} team${teamCount === 1 ? "" : "s"} · ${league.settings.scoringType.toUpperCase()} · ${league.platform.toUpperCase()}`;

  // Week context chips follow the league phase the ticker derived.
  const context = (
    <>
      <span className="bc-label text-bc-text-3">{currentSeason} season</span>
      {ticker.phase === "predraft" && (
        <Chip variant="signal" live>
          {ticker.draftDate
            ? `Draft · ${new Date(ticker.draftDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
            : "Draft pending"}
        </Chip>
      )}
      {ticker.phase === "offseason" && <Chip variant="outline">Season complete</Chip>}
      {(ticker.phase === "week-live" || ticker.phase === "week-upcoming") && ticker.week && (
        <Chip variant={ticker.phase === "week-live" ? "signal" : "outline"} live={ticker.phase === "week-live"}>
          Week {ticker.week} &middot; {ticker.phase === "week-live" ? "Live" : "Upcoming"}
        </Chip>
      )}
      {ticker.phase === "week-final" && ticker.week && (
        <>
          <Chip variant="outline">Week {ticker.week} &middot; Final</Chip>
          <Chip variant="signal" live>Week {ticker.week + 1} &middot; On deck</Chip>
        </>
      )}
      <CreditWallet leagueId={league._id} variant="header" />
    </>
  );

  return (
    <div className="min-h-screen bg-bc-ground">
      <AppHeader
        leagueName={league.name}
        leagueMeta={leagueMeta}
        homeHref={`/leagues/${league._id}`}
        nav={nav}
        context={context}
        ticker={ticker.items}
        tickerLabel={ticker.label}
        notifications={<NotificationDropdown leagueId={league._id} />}
      />
      <div className="px-4 py-8 sm:px-6 lg:px-12">{children}</div>
    </div>
  );
}
