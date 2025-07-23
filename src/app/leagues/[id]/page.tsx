"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { LeagueHomepage } from "@/components/LeagueHomepage";
import { CommissionerTeamSelection } from "@/components/CommissionerTeamSelection";
import { TeamInviteManager } from "@/components/TeamInviteManager";

interface LeaguePageProps {
  params: {
    id: string;
  };
}

export default function LeaguePage({ params }: LeaguePageProps) {
  const { user, isLoaded: userLoaded } = useUser();
  const router = useRouter();
  
  const league = useQuery(api.leagues.getById, { 
    id: params.id as Id<"leagues"> 
  });
  
  const teams = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId: params.id as Id<"leagues">,
    seasonId: 2025
  });
  
  const teamClaims = useQuery(api.teamClaims.getByLeague, {
    leagueId: params.id as Id<"leagues">,
    seasonId: 2025
  });

  if (!userLoaded || league === undefined || teams === undefined || teamClaims === undefined) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  if (!league) {
    router.push("/dashboard");
    return null;
  }

  const currentUserId = user?.id;
  const isCommissioner = league.role === "commissioner";
  const userHasClaimedTeam = teamClaims.some(claim => claim.userId === currentUserId);
  const isCurrentSeason = true; // For 2025 season
  
  // Check if this is first time setup (no teams claimed for current season)
  const noTeamsClaimed = teamClaims.length === 0;

  // Flow 1: Commissioner needs to select their team first
  if (isCommissioner && noTeamsClaimed && isCurrentSeason) {
    return (
      <CommissionerTeamSelection 
        league={league}
        teams={teams}
      />
    );
  }

  // Flow 2: Commissioner has claimed team, now manage invites for others
  if (isCommissioner && userHasClaimedTeam && isCurrentSeason && teamClaims.length < teams.length) {
    return (
      <TeamInviteManager
        league={league}
        teams={teams}
        teamClaims={teamClaims}
      />
    );
  }

  // Flow 3: All teams claimed or regular season view - show league homepage
  return (
    <LeagueHomepage
      league={league}
      teams={teams}
      teamClaims={teamClaims}
      currentUserId={currentUserId}
    />
  );
}