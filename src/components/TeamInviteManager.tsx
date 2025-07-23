"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  owner: string;
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

interface TeamInviteManagerProps {
  league: League;
  teams: Team[];
  teamClaims: TeamClaim[];
}

export function TeamInviteManager({ league, teams, teamClaims }: TeamInviteManagerProps) {
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<Id<"teams">>>(new Set());
  const [emailInputs, setEmailInputs] = useState<Record<string, string>>({});
  const [isCreatingInvites, setIsCreatingInvites] = useState(false);
  const [createdInvites, setCreatedInvites] = useState<Array<{
    teamName: string;
    inviteUrl: string;
    email?: string;
  }>>([]);
  
  const createInvitation = useMutation(api.teamInvitations.createInvitation);
  const invitations = useQuery(api.teamInvitations.getByLeague, {
    leagueId: league._id,
    seasonId: 2025
  });

  // Get teams that haven't been claimed yet
  const claimedTeamIds = new Set(teamClaims.map(claim => claim.teamId));
  const unclaimedTeams = teams.filter(team => !claimedTeamIds.has(team._id));

  // Get teams with existing invitations
  const invitedTeamIds = new Set(
    invitations?.filter(inv => inv.status === "pending").map(inv => inv.teamId) || []
  );

  const handleTeamSelect = (teamId: Id<"teams">) => {
    setSelectedTeamIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(teamId)) {
        newSet.delete(teamId);
      } else {
        newSet.add(teamId);
      }
      return newSet;
    });
  };

  const handleEmailChange = (teamId: string, email: string) => {
    setEmailInputs(prev => ({
      ...prev,
      [teamId]: email
    }));
  };

  const handleCreateInvites = async () => {
    if (selectedTeamIds.size === 0) return;

    setIsCreatingInvites(true);
    const newInvites: Array<{
      teamName: string;
      inviteUrl: string;
      email?: string;
    }> = [];

    try {
      for (const teamId of selectedTeamIds) {
        const team = teams.find(t => t._id === teamId);
        const email = emailInputs[teamId];
        
        const result = await createInvitation({
          leagueId: league._id,
          teamId,
          seasonId: 2025,
          email: email || undefined,
        });

        newInvites.push({
          teamName: team?.name || 'Unknown Team',
          inviteUrl: `${window.location.origin}${result.inviteUrl}`,
          email: email,
        });
      }

      setCreatedInvites(newInvites);
      setSelectedTeamIds(new Set());
      setEmailInputs({});
    } catch (error) {
      alert(`Error creating invites: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsCreatingInvites(false);
    }
  };

  if (createdInvites.length > 0) {
    return (
      <div className="min-h-screen bg-gray-900">
        <header className="bg-red-600 border-b border-red-700">
          <div className="container mx-auto px-6 py-4 flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Link href="/" className="text-2xl font-bold text-white">
                FFSN
              </Link>
              <span className="text-red-200">|</span>
              <span className="text-white font-semibold">{league.name}</span>
            </div>
            <UserButton />
          </div>
        </header>

        <main className="container mx-auto px-6 py-8">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold text-white mb-2">
                Invitations Created!
              </h1>
              <p className="text-gray-400">
                Send these links to your league members to claim their teams
              </p>
            </div>

            <div className="space-y-4 mb-8">
              {createdInvites.map((invite, index) => (
                <div key={index} className="bg-gray-800 rounded-lg p-6">
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="text-lg font-bold text-white">{invite.teamName}</h3>
                    {invite.email && (
                      <span className="text-sm text-gray-400">Email: {invite.email}</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={invite.inviteUrl}
                      readOnly
                      className="flex-1 bg-gray-700 text-white p-2 rounded text-sm"
                    />
                    <button
                      onClick={() => navigator.clipboard.writeText(invite.inviteUrl)}
                      className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 transition-colors"
                    >
                      Copy
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    This link expires in 7 days
                  </p>
                </div>
              ))}
            </div>

            <div className="text-center space-x-4">
              <button
                onClick={() => setCreatedInvites([])}
                className="bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-gray-700 transition-colors"
              >
                Create More Invites
              </button>
              <Link
                href={`/leagues/${league._id}`}
                className="bg-red-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors inline-block"
              >
                Go to League Homepage
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="bg-red-600 border-b border-red-700">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-2xl font-bold text-white">
              FFSN
            </Link>
            <span className="text-red-200">|</span>
            <span className="text-white font-semibold">{league.name}</span>
          </div>
          <UserButton />
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">
              Invite League Members
            </h1>
            <p className="text-gray-400">
              Send invitations for unclaimed teams. Each link expires in 7 days.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 mb-8">
            {unclaimedTeams.map((team) => {
              const hasInvite = invitedTeamIds.has(team._id);
              const isSelected = selectedTeamIds.has(team._id);
              
              return (
                <div
                  key={team._id}
                  className={`
                    p-4 rounded-lg border-2 transition-all
                    ${hasInvite
                      ? "border-yellow-500 bg-yellow-900/20"
                      : isSelected
                      ? "border-red-500 bg-red-900/20 cursor-pointer"
                      : "border-gray-600 bg-gray-700 hover:border-gray-500 cursor-pointer"
                    }
                  `}
                  onClick={() => !hasInvite && handleTeamSelect(team._id)}
                >
                  <div className="flex items-center gap-3 mb-2">
                    {team.logo && (
                      <img 
                        src={team.logo} 
                        alt={`${team.name} logo`}
                        className="w-10 h-10 rounded"
                      />
                    )}
                    <div>
                      <h3 className="font-bold text-white">{team.name}</h3>
                      {team.abbreviation && (
                        <p className="text-sm text-gray-400">{team.abbreviation}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-gray-300 mb-2">
                    Owner: {team.owner}
                  </div>
                  
                  {hasInvite ? (
                    <div className="text-sm text-yellow-400 font-semibold">
                      ✓ Invitation Pending
                    </div>
                  ) : isSelected ? (
                    <input
                      type="email"
                      placeholder="Email (optional)"
                      value={emailInputs[team._id] || ''}
                      onChange={(e) => handleEmailChange(team._id, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full bg-gray-600 text-white p-2 rounded text-sm mt-2"
                    />
                  ) : (
                    <div className="text-sm text-gray-400">
                      Click to select
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {selectedTeamIds.size > 0 && (
            <div className="text-center">
              <button
                onClick={handleCreateInvites}
                disabled={isCreatingInvites}
                className="bg-red-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreatingInvites 
                  ? "Creating Invitations..." 
                  : `Create ${selectedTeamIds.size} Invitation${selectedTeamIds.size === 1 ? '' : 's'}`
                }
              </button>
            </div>
          )}

          {unclaimedTeams.length === 0 && (
            <div className="text-center">
              <p className="text-gray-400 mb-4">All teams have been claimed or invited!</p>
              <Link
                href={`/leagues/${league._id}`}
                className="bg-red-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-red-700 transition-colors inline-block"
              >
                Go to League Homepage
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}