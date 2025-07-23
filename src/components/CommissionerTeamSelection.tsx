"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
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
  record: {
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

interface CommissionerTeamSelectionProps {
  league: League;
  teams: Team[];
}

export function CommissionerTeamSelection({ league, teams }: CommissionerTeamSelectionProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<Id<"teams"> | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  
  const claimTeam = useMutation(api.teamClaims.claimTeam);

  const handleClaimTeam = async () => {
    if (!selectedTeamId) return;
    
    setIsClaiming(true);
    try {
      await claimTeam({
        leagueId: league._id,
        teamId: selectedTeamId,
        seasonId: 2025,
      });
      
      toast.success("Team claimed successfully!", {
        description: "You are now the owner of this team."
      });
      
      setIsOpen(false);
      // Page will automatically re-render and move to next flow
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast.error("Failed to claim team", {
        description: errorMessage
      });
    } finally {
      setIsClaiming(false);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
      <Dialog.Content maxWidth="800px">
        <Dialog.Title className="text-2xl font-bold mb-2">
          Welcome to the 2025 Season!
        </Dialog.Title>
        <Dialog.Description className="text-gray-600 mb-6">
          As commissioner of {league.name}, please select your team first
        </Dialog.Description>

        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-4">Select Your Team</h3>
          <div className="grid gap-3 md:grid-cols-2 max-h-96 overflow-y-auto">
            {teams.map((team) => (
              <div
                key={team._id}
                onClick={() => setSelectedTeamId(team._id)}
                className={`
                  p-4 rounded-lg border-2 cursor-pointer transition-all
                  ${selectedTeamId === team._id
                    ? "border-red-500 bg-red-50"
                    : "border-gray-200 bg-white hover:border-gray-300"
                  }
                `}
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center">
                    <span className="text-gray-600 font-bold text-sm">
{team.name.substring(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <h4 className="font-bold text-gray-900">{team.name}</h4>
                    <p className="text-sm text-gray-600">
                      {team.record.wins}-{team.record.losses}-{team.record.ties || 0}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <Flex gap="3" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray" className="cursor-pointer">
              Cancel
            </Button>
          </Dialog.Close>
          <Button
            onClick={handleClaimTeam}
            disabled={!selectedTeamId || isClaiming}
            className="bg-red-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-red-700 transition-colors disabled:opacity-50 cursor-pointer"
          >
            {isClaiming ? "Claiming..." : "Claim Team"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}