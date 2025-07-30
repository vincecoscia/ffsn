"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useUser } from "@clerk/nextjs";
import { LeagueHomepage } from "@/components/LeagueHomepage";

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
  
  const teams = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId: id as Id<"leagues">,
    seasonId: 2025
  });
  
  const teamClaims = useQuery(api.teamClaims.getByLeague, {
    leagueId: id as Id<"leagues">,
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
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="bg-gray-800 rounded-lg p-8 max-w-md mx-auto text-center">
          <div className="text-red-500 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.864-.833-2.634 0L4.168 15.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">League Not Found</h1>
          <p className="text-gray-400 mb-6">
            This league doesn&apos;t exist or you don&apos;t have access to it.
          </p>
          <Link href="/dashboard" className="bg-red-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors inline-block">
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const currentUserId = user?.id;
  const isCommissioner = league.role === "commissioner";
  const userHasClaimedTeam = teamClaims.some(claim => claim.userId === currentUserId);
  const isCurrentSeason = true; // For 2025 season
  

  return (
    <>
      {/* Always show the League Homepage as the background */}
      <LeagueHomepage
        league={league}
        teams={teams}
        teamClaims={teamClaims}
        currentUserId={currentUserId}
        isCommissioner={isCommissioner}
      />
    
    </>
  );
}