"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Trophy, Users } from "lucide-react";

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
  onClose?: () => void;
}

export function CommissionerTeamSelection({ league, teams, onClose }: CommissionerTeamSelectionProps) {
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
      onClose?.();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast.error("Failed to claim team", {
        description: errorMessage
      });
    } finally {
      setIsClaiming(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      onClose?.();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">
            Claim Your Team
          </DialogTitle>
          <DialogDescription className="text-gray-600">
            Select a team to claim for the 2025 season in {league.name}
          </DialogDescription>
        </DialogHeader>

        <div className="my-6">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Users className="w-5 h-5" />
            Available Teams
          </h3>
          <div className="grid gap-3 md:grid-cols-2 max-h-[400px] overflow-y-auto pr-2">
            {teams.map((team) => (
              <Card
                key={team._id}
                onClick={() => setSelectedTeamId(team._id)}
                className={`
                  p-4 cursor-pointer transition-all hover:shadow-md
                  ${selectedTeamId === team._id
                    ? "border-red-500 bg-red-50 ring-2 ring-red-500"
                    : "border-gray-200 hover:border-gray-300"
                  }
                `}
              >
                <div className="flex items-start gap-3">
                  {team.logo ? (
                    <img 
                      src={team.logo} 
                      alt={`${team.name} logo`}
                      className="w-12 h-12 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="w-12 h-12 bg-gradient-to-br from-red-500 to-red-600 rounded-lg flex items-center justify-center">
                      <span className="text-white font-bold text-sm">
                        {team.abbreviation || team.name.substring(0, 2).toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div className="flex-1">
                    <h4 className="font-bold text-gray-900">{team.name}</h4>
                    <p className="text-sm text-gray-600">{team.owner}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-sm font-medium text-gray-700">
                        {team.record.wins}-{team.record.losses}
                        {team.record.ties > 0 && `-${team.record.ties}`}
                      </span>
                      {selectedTeamId === team._id && (
                        <span className="text-xs bg-red-500 text-white px-2 py-0.5 rounded-full">
                          Selected
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleClaimTeam}
            disabled={!selectedTeamId || isClaiming}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            <Trophy className="w-4 h-4 mr-2" />
            {isClaiming ? "Claiming..." : "Claim Team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}