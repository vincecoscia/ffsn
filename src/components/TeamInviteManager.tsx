"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { TeamTile } from "@/components/broadcast";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  isOpen?: boolean;
  onClose?: () => void;
}

function initialsFor(team: Team): string {
  if (team.abbreviation) return team.abbreviation.slice(0, 3).toUpperCase();
  const words = team.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function TeamInviteManager({ league, teams, teamClaims, isOpen = true, onClose }: TeamInviteManagerProps) {
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<Id<"teams">>>(new Set());
  const [emailInputs, setEmailInputs] = useState<Record<string, string>>({});
  const [isCreatingInvites, setIsCreatingInvites] = useState(false);
  const [createdInvites, setCreatedInvites] = useState<Array<{
    teamName: string;
    inviteUrl: string;
    email?: string;
  }>>([]);

  const { currentSeason } = useLeagueSeason(league._id);
  const createInvitation = useMutation(api.teamInvitations.createInvitation);
  const invitations = useQuery(api.teamInvitations.getByLeague, {
    leagueId: league._id,
    seasonId: currentSeason
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
          seasonId: currentSeason,
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
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Invitations created</DialogTitle>
            <DialogDescription>
              Send these links to your league members to claim their teams
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-96 flex-col gap-3 overflow-y-auto">
            {createdInvites.map((invite, index) => (
              <div key={index} className="flex flex-col gap-2.5 border border-bc-hairline bg-bc-panel-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[16px] font-bold text-bc-ink uppercase">
                    {invite.teamName}
                  </span>
                  {invite.email && (
                    <span className="truncate text-[13px] text-bc-text-2">{invite.email}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input value={invite.inviteUrl} readOnly className="flex-1" />
                  <Button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(invite.inviteUrl);
                        toast.success("Invite link copied to clipboard!", {
                          description: "The invite link is ready to share."
                        });
                      } catch {
                        toast.error("Failed to copy invite link", {
                          description: "Please try again or manually copy the link."
                        });
                      }
                    }}
                    size="sm"
                  >
                    Copy
                  </Button>
                </div>
                <span className="bc-label-sm text-bc-text-3">This link expires in 7 days</span>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button onClick={() => setCreatedInvites([])} variant="outline">
              Create more invites
            </Button>
            <Button onClick={onClose}>Continue to league</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Invite league members</DialogTitle>
          <DialogDescription>
            Select teams and invite members to join {league.name}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <span className="bc-label text-bc-text-2">Available teams</span>
          <div className="grid max-h-96 gap-3 overflow-y-auto sm:grid-cols-2">
            {unclaimedTeams.map((team) => {
              const isSelected = selectedTeamIds.has(team._id);
              const isInvited = invitedTeamIds.has(team._id);

              return (
                <div
                  key={team._id}
                  className={cn(
                    "flex flex-col gap-3 border p-3.5 transition-colors",
                    isInvited
                      ? "cursor-not-allowed border-bc-hairline bg-bc-panel-2 opacity-60"
                      : isSelected
                        ? "cursor-pointer border-bc-red bg-bc-panel-2"
                        : "cursor-pointer border-bc-hairline bg-bc-panel hover:border-bc-border-strong"
                  )}
                  onClick={() => !isInvited && handleTeamSelect(team._id)}
                >
                  <div className="flex items-center gap-3">
                    <TeamTile initials={initialsFor(team)} src={team.logo} size={44} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate font-display text-[16px] font-bold text-bc-ink uppercase">
                        {team.name}
                      </span>
                      <span className="bc-num text-[13px] text-bc-text-2">
                        {team.record
                          ? `${team.record.wins}-${team.record.losses}${team.record.ties ? `-${team.record.ties}` : ""}`
                          : "No record"}
                      </span>
                    </div>
                    {isInvited && <Badge variant="secondary">Invited</Badge>}
                    {isSelected && !isInvited && <Badge variant="default">Selected</Badge>}
                  </div>

                  {isSelected && !isInvited && (
                    <div className="flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <label className="bc-label-sm text-bc-text-3">Email (optional)</label>
                      <Input
                        type="email"
                        value={emailInputs[team._id] || ""}
                        onChange={(e) => handleEmailChange(team._id, e.target.value)}
                        placeholder="member@example.com"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Skip for now
          </Button>
          <Button
            onClick={handleCreateInvites}
            disabled={selectedTeamIds.size === 0 || isCreatingInvites}
          >
            {isCreatingInvites ? "Creating…" : `Create ${selectedTeamIds.size} invite${selectedTeamIds.size !== 1 ? 's' : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
