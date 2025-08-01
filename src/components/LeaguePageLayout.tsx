"use client";

import React from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { ESPNNewsWidget } from "./ESPNNewsWidget";
import { TeamLogo } from "./TeamLogo";

interface LeaguePageLayoutProps {
  children: React.ReactNode;
  leagueId: Id<"leagues">;
  currentUserId: string;
  title?: string;
}

export function LeaguePageLayout({
  children,
  leagueId,
  currentUserId,
  title,
}: LeaguePageLayoutProps) {
  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });

  // Get teams
  const teams =
    useQuery(api.teams.getByLeagueAndSeason, {
      leagueId,
      seasonId: 2025,
    }) || [];

  // Get team claims
  const teamClaims =
    useQuery(api.teamClaims.getByLeague, {
      leagueId,
      seasonId: 2025,
    }) || [];

  // Get user's claimed team
  const userTeam = teams.find((team) => {
    const claim = teamClaims.find(
      (claim) => claim.teamId === team._id && claim.userId === currentUserId
    );
    return !!claim;
  });

  if (!league) {
    return <div>Loading...</div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Main Content Area */}
      <div className="lg:col-span-3 space-y-6">
        {title && (
          <div className="bg-white rounded-lg shadow-sm p-6">
            <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          </div>
        )}
        {children}
      </div>

      {/* Sidebar */}
      <div className="lg:col-span-1 space-y-6">
        {/* Your Team Card */}
        {userTeam && (
          <div className="bg-white rounded-lg shadow-sm">
            <div className="border-b border-gray-200 p-4">
              <h3 className="text-lg font-bold text-gray-900">Your Team</h3>
            </div>
            <div className="p-6">
              <div className="text-center">
                {(userTeam.logo || userTeam.customLogo) && (
                  <TeamLogo
                    teamId={userTeam._id}
                    teamName={userTeam.name}
                    espnLogo={userTeam.logo}
                    customLogo={userTeam.customLogo}
                    size="md"
                    className="w-20 h-20 mx-auto mb-4 rounded-lg"
                  />
                )}
                <h4 className="font-bold text-xl text-gray-900 mb-1">
                  {userTeam.name}
                </h4>
                {userTeam.abbreviation && (
                  <p className="text-gray-600 text-sm mb-4">
                    {userTeam.abbreviation}
                  </p>
                )}
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <div>
                    <div className="text-gray-600 text-sm">Record</div>
                    <div className="font-bold text-2xl text-gray-900">
                      {userTeam.record.wins}-{userTeam.record.losses}
                      {userTeam.record.ties > 0 && `-${userTeam.record.ties}`}
                    </div>
                  </div>
                  {userTeam.record.pointsFor && (
                    <div>
                      <div className="text-gray-600 text-sm">Points For</div>
                      <div className="font-bold text-lg text-gray-900">
                        {userTeam.record.pointsFor.toFixed(1)}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ESPN Top Headlines */}
        <ESPNNewsWidget limit={5} />

        {/* League Info */}
        <div className="bg-white rounded-lg shadow-sm">
          <div className="border-b border-gray-200 p-4">
            <h3 className="text-lg font-bold text-gray-900">League Info</h3>
          </div>
          <div className="p-4 space-y-4">
            <div className="flex justify-between">
              <span className="text-gray-600 text-sm">Teams</span>
              <span className="font-semibold text-gray-900">
                {teams.length}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 text-sm">Scoring</span>
              <span className="font-semibold text-gray-900 capitalize">
                {league.settings.scoringType}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 text-sm">Your Role</span>
              <span className="font-semibold text-gray-900 capitalize">
                {league.role}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600 text-sm">Platform</span>
              <span className="font-semibold text-gray-900 uppercase">
                {league.platform}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
