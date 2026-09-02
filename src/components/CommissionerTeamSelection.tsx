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
import { Badge } from "@/components/ui/badge";
import { Trophy, Users } from "lucide-react";
import { TeamTile } from "@/components/broadcast";
import { useLeagueSeason } from "@/hooks/use-league-season";
import { cn } from "@/lib/utils";

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

function initialsFor(team: Team): string {
  if (team.abbreviation) return team.abbreviation.slice(0, 3).toUpperCase();
  const words = team.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function CommissionerTeamSelection({ league, teams, onClose }: CommissionerTeamSelectionProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<Id<"teams"> | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isOpen, setIsOpen] = useState(true);

  const claimTeam = useMutation(api.teamClaims.claimTeam);
  const { currentSeason } = useLeagueSeason(league._id);

  const handleClaimTeam = async () => {
    if (!selectedTeamId) return;

    setIsClaiming(true);
    try {
      await claimTeam({
        leagueId: league._id,
        teamId: selectedTeamId,
        seasonId: currentSeason,
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Claim your team</DialogTitle>
          <DialogDescription>
            Select a team to claim for the {currentSeason} season in {league.name}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <span className="bc-label flex items-center gap-2 text-bc-text-2">
            <Users className="size-4" strokeWidth={1.8} />
            Available teams
          </span>
          <div className="grid max-h-[420px] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
            {teams.map((team) => {
              const selected = selectedTeamId === team._id;
              return (
                <button
                  key={team._id}
                  type="button"
                  onClick={() => setSelectedTeamId(team._id)}
                  className={cn(
                    "flex items-start gap-3 border p-3.5 text-left transition-colors",
                    selected
                      ? "border-bc-red bg-bc-panel-2"
                      : "border-bc-hairline bg-bc-panel hover:border-bc-border-strong"
                  )}
                >
                  <TeamTile initials={initialsFor(team)} src={team.logo} size={44} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate font-display text-[16px] font-bold text-bc-ink uppercase">
                      {team.name}
                    </span>
                    <span className="truncate text-[13px] text-bc-text-2">{team.owner}</span>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="bc-num text-[13px] text-bc-text-2">
                        {team.record.wins}-{team.record.losses}
                        {team.record.ties > 0 && `-${team.record.ties}`}
                      </span>
                      {selected && (
                        <Badge variant="default" className="text-[10px]">
                          Selected
                        </Badge>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleClaimTeam} disabled={!selectedTeamId || isClaiming}>
            <Trophy className="size-4" strokeWidth={1.8} />
            {isClaiming ? "Claiming…" : "Claim team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
