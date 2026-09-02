"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useUser } from "@clerk/nextjs";
import { TriangleAlert } from "lucide-react";
import { LeagueHomepage } from "@/components/LeagueHomepage";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { LoadingScreen, EmptyState } from "@/components/broadcast";
import { Button } from "@/components/ui/button";

interface LeaguePageProps {
  params: Promise<{
    id: string;
  }>;
}

export default function LeaguePage({ params }: LeaguePageProps) {
  const { user, isLoaded: userLoaded } = useUser();

  // Unwrap the params Promise
  const { id } = use(params);

  const league = useQuery(api.leagues.getById, {
    id: id as Id<"leagues">
  });

  const { currentSeason } = useLeagueSeason(id as Id<"leagues">);

  const teams = useQuery(api.teams.getByLeagueAndSeason, {
    leagueId: id as Id<"leagues">,
    seasonId: currentSeason
  });

  const teamClaims = useQuery(api.teamClaims.getByLeague, {
    leagueId: id as Id<"leagues">,
    seasonId: currentSeason
  });

  if (!userLoaded || league === undefined || teams === undefined || teamClaims === undefined) {
    return <LoadingScreen message="Loading your league" />;
  }

  if (!league) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
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

  const currentUserId = user?.id;
  const isCommissioner = league.role === "commissioner";

  return (
    <LeagueHomepage
      league={league}
      teams={teams}
      teamClaims={teamClaims}
      currentUserId={currentUserId}
      isCommissioner={isCommissioner}
    />
  );
}
