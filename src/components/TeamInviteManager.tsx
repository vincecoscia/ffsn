"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Dialog, Button, Flex } from "@radix-ui/themes";

interface Team {
  _id: Id<"teams">;
  name: string;
  abbreviation?: string;
  logo?: string;
  owner: string;
  record?: {
    wins: number;
    losses: number;
    ties: number;
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
  const [isOpen, setIsOpen] = useState(true);
  
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
      
      toast.success("Team invitations created successfully!", {
        description: `Created ${newInvites.length} invitation${newInvites.length > 1 ? 's' : ''}.`
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast.error("Failed to create invitations", {
        description: errorMessage
      });
    } finally {
      setIsCreatingInvites(false);
    }
  };

  if (createdInvites.length > 0) {
    return (
      <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
        <Dialog.Content maxWidth="600px">
          <Dialog.Title className="text-2xl font-bold mb-2">
            Invitations Created!
          </Dialog.Title>
          <Dialog.Description className="text-gray-600 mb-6">
            Send these links to your league members to claim their teams
          </Dialog.Description>

          <div className="space-y-4 mb-6 max-h-96 overflow-y-auto">
            {createdInvites.map((invite, index) => (
              <div key={index} className="bg-gray-50 rounded-lg p-4 border">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="font-semibold text-gray-900">{invite.teamName}</h3>
                  {invite.email && (
                    <span className="text-sm text-gray-500">Email: {invite.email}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={invite.inviteUrl}
                    readOnly
                    className="flex-1 bg-white border border-gray-300 text-gray-900 p-2 rounded text-sm"
                  />
                  <Button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(invite.inviteUrl);
                        toast.success("Invite link copied to clipboard!", {
                          description: "The invite link is ready to share."
                        });
                      } catch (err) {
                        toast.error("Failed to copy invite link", {
                          description: "Please try again or manually copy the link."
                        });
                      }
                    }}
                    variant="solid"
                    color="red"
                    size="2"
                    className="cursor-pointer"
                  >
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  This link expires in 7 days
                </p>
              </div>
            ))}
          </div>

          <Flex gap="3" justify="end">
            <Button
              onClick={() => setCreatedInvites([])}
              variant="soft"
              color="gray"
              className="cursor-pointer"
            >
              Create More Invites
            </Button>
            <Dialog.Close>
              <Button variant="solid" color="red" className="cursor-pointer">
                Continue to League
              </Button>
            </Dialog.Close>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    );
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
      <Dialog.Content maxWidth="800px">
        <Dialog.Title className="text-2xl font-bold mb-2">
          Invite League Members
        </Dialog.Title>
        <Dialog.Description className="text-gray-600 mb-6">
          Select teams and invite members to join {league.name}
        </Dialog.Description>

        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-4">Available Teams</h3>
          <div className="grid gap-3 md:grid-cols-2 max-h-96 overflow-y-auto">
            {unclaimedTeams.map((team) => {
              const isSelected = selectedTeamIds.has(team._id);
              const isInvited = invitedTeamIds.has(team._id);
              
              return (
                <div
                  key={team._id}
                  className={`
                    p-4 rounded-lg border-2 transition-all
                    ${isInvited 
                      ? "border-yellow-300 bg-yellow-50 opacity-75" 
                      : isSelected
                        ? "border-red-500 bg-red-50 cursor-pointer"
                        : "border-gray-200 bg-white hover:border-gray-300 cursor-pointer"
                    }
                  `}
                  onClick={() => !isInvited && handleTeamSelect(team._id)}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center">
                      <span className="text-gray-600 font-bold text-sm">
{team.name.substring(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1">
                      <h4 className="font-bold text-gray-900">{team.name}</h4>
                      <p className="text-sm text-gray-600">
                        {team.record ? `${team.record.wins}-${team.record.losses}-${team.record.ties || 0}` : 'No record'}
                      </p>
                    </div>
                    {isInvited && (
                      <span className="text-xs bg-yellow-200 text-yellow-800 px-2 py-1 rounded">
                        Invited
                      </span>
                    )}
                  </div>
                  
                  {isSelected && !isInvited && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Email (optional):
                      </label>
                      <input
                        type="email"
                        value={emailInputs[team._id] || ""}
                        onChange={(e) => handleEmailChange(team._id, e.target.value)}
                        placeholder="member@example.com"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <Flex gap="3" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray" className="cursor-pointer">
              Skip for Now
            </Button>
          </Dialog.Close>
          <Button
            onClick={handleCreateInvites}
            disabled={selectedTeamIds.size === 0 || isCreatingInvites}
            variant="solid"
            color="red"
            className="cursor-pointer"
          >
            {isCreatingInvites ? "Creating..." : `Create ${selectedTeamIds.size} Invite${selectedTeamIds.size !== 1 ? 's' : ''}`}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}