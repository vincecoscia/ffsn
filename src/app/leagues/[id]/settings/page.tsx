"use client";

import { use } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { LeagueSettingsPage } from "../../../../components/LeagueSettingsPage";

interface LeagueSettingsPageProps {
  params: Promise<{ id: string }>;
}

export default function LeagueSettings({ params }: LeagueSettingsPageProps) {
  const { user, isLoaded: userLoaded } = useUser();
  const router = useRouter();
  
  const { id } = use(params);
  
  const league = useQuery(api.leagues.getById, { 
    id: id as Id<"leagues"> 
  });
  
  const teams = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId: id as Id<"leagues">,
    seasonId: 2025
  });
  
  const teamClaims = useQuery(api.teamClaims.getByLeague, {
    leagueId: id as Id<"leagues">,
    seasonId: 2025
  });

  const teamInvitations = useQuery(api.teamInvitations.getByLeague, {
    leagueId: id as Id<"leagues">,
    seasonId: 2025
  });

  if (!userLoaded || league === undefined || teams === undefined || teamClaims === undefined || teamInvitations === undefined) {
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

  if (!isCommissioner) {
    router.push(`/leagues/${id}`);
    return null;
  }

  return (
    <LeagueSettingsPage
      league={league}
      teams={teams}
      teamClaims={teamClaims}
      teamInvitations={teamInvitations}
      currentUserId={currentUserId}
    />
  );
}