"use client";

import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Info } from "lucide-react";

export interface TradeRumorData {
  rumorType: "my_trade" | "other_offer";
  targetTeamId?: Id<"teams">;
  playersInvolved: string[]; // Use string[] for player IDs from roster
  additionalContext?: string;
}

interface TradeRumorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leagueId: Id<"leagues">;
  currentTeamId?: Id<"teams">;
  onConfirm: (data: TradeRumorData) => void;
}

export function TradeRumorDialog({
  open,
  onOpenChange,
  leagueId,
  currentTeamId,
  onConfirm,
}: TradeRumorDialogProps) {
  const [rumorType, setRumorType] = useState<"my_trade" | "other_offer">("my_trade");
  const [selectedTeam, setSelectedTeam] = useState<Id<"teams"> | null>(null);
  const [selectedPlayers, setSelectedPlayers] = useState<string[]>([]);
  const [additionalContext, setAdditionalContext] = useState("");

  // Get only current season teams in the league
  const currentSeason = new Date().getFullYear();
  const teams = useQuery(api.teams.getByLeagueAndSeason, { 
    leagueId, 
    seasonId: currentSeason 
  });
  
  // Get players for selected team (for other_offer type)
  const teamPlayers = useQuery(
    api.players.getPlayersByTeam,
    selectedTeam && rumorType === "other_offer" ? { teamId: selectedTeam } : "skip"
  );

  // Get current user's players (for my_trade type)
  const myPlayers = useQuery(
    api.players.getPlayersByTeam,
    currentTeamId && rumorType === "my_trade" ? { teamId: currentTeamId } : "skip"
  );

  // Reset selections when rumor type changes
  useEffect(() => {
    setSelectedTeam(null);
    setSelectedPlayers([]);
  }, [rumorType]);

  const handleConfirm = () => {
    if (rumorType === "other_offer" && !selectedTeam) {
      return; // Require team selection for other's offer
    }
    
    if (selectedPlayers.length === 0) {
      return; // Require at least one player
    }

    onConfirm({
      rumorType,
      targetTeamId: selectedTeam || undefined,
      playersInvolved: selectedPlayers,
      additionalContext: additionalContext.trim() || undefined,
    });

    // Reset state
    setRumorType("my_trade");
    setSelectedTeam(null);
    setSelectedPlayers([]);
    setAdditionalContext("");
    onOpenChange(false);
  };

  const availableTeams = teams?.filter(t => t._id !== currentTeamId) || [];
  const playersToShow = rumorType === "my_trade" ? myPlayers : teamPlayers;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Leak Trade Rumor to Vinny &quot;The Sauce&quot; Marinara</DialogTitle>
          <DialogDescription className="sr-only">
            Share trade rumors with Vinny for article generation
          </DialogDescription>
        </DialogHeader>
        <div className="mb-4 flex items-start gap-2 border-l-2 border-l-bc-signal bg-bc-panel-2 p-3">
          <Info className="mt-0.5 size-4 shrink-0 text-bc-signal" />
          <span className="text-sm text-bc-text-2">
            Vinny will take your &quot;inside information&quot; and spin it into a mysterious rumor article.
            Remember, he takes some creative liberties with the truth...
          </span>
        </div>

        <ScrollArea className="h-[400px] pr-4">
          <div className="space-y-6">
            {/* Rumor Type Selection */}
            <div className="space-y-3">
              <Label>What kind of rumor are you leaking?</Label>
              <RadioGroup value={rumorType} onValueChange={(v) => setRumorType(v as typeof rumorType)}>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="my_trade" id="my_trade" />
                  <Label htmlFor="my_trade" className="font-normal cursor-pointer">
                    I&apos;m looking to trade one of my players
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="other_offer" id="other_offer" />
                  <Label htmlFor="other_offer" className="font-normal cursor-pointer">
                    Another team offered me a trade
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Team Selection */}
            <div className="space-y-2">
              <Label htmlFor="team-select">
                {rumorType === "my_trade" 
                  ? "Which team are you targeting for this trade? (Optional)" 
                  : "Which team made the offer?"}
              </Label>
              <Select value={selectedTeam || ""} onValueChange={(v) => setSelectedTeam(v as Id<"teams">)}>
                <SelectTrigger id="team-select">
                  <SelectValue placeholder={rumorType === "my_trade" ? "No specific team..." : "Select a team..."} />
                </SelectTrigger>
                <SelectContent>
                  {availableTeams.map((team) => (
                    <SelectItem key={team._id} value={team._id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Player Selection */}
            {((rumorType === "my_trade") || 
              (rumorType === "other_offer" && selectedTeam)) && (
              <div className="space-y-2">
                <Label>
                  {rumorType === "my_trade" 
                    ? "Which player(s) are you looking to trade?" 
                    : "Which player(s) were offered?"}
                </Label>
                <div className="flex max-h-48 flex-col gap-2 overflow-y-auto border border-bc-hairline p-3">
                  {playersToShow?.map((player) => (
                    <div key={player._id} className="flex items-start gap-2.5 px-2 py-2 hover:bg-bc-panel-2">
                      <Checkbox
                        id={player.playerId}
                        checked={selectedPlayers.includes(player.playerId)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedPlayers([...selectedPlayers, player.playerId]);
                          } else {
                            setSelectedPlayers(selectedPlayers.filter(p => p !== player.playerId));
                          }
                        }}
                        className="mt-1"
                      />
                      <Label
                        htmlFor={player.playerId}
                        className="flex-1 cursor-pointer text-sm font-normal"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="font-medium text-bc-ink">
                              {player.name} - {player.position} ({player.team})
                              {player.injured && (
                                <span className="ml-2 text-xs text-bc-red-text">
                                  {player.injuryStatus || "Injured"}
                                </span>
                              )}
                            </div>
                            {player.stats && (
                              <div className="mt-1 text-xs text-bc-text-3">
                                {player.stats.gamesPlayed > 0 && (
                                  <>
                                    {player.position === "QB" && (
                                      <span>
                                        {player.stats.passingYards} yds, {player.stats.passingTDs} TD
                                        {player.stats.interceptions > 0 && `, ${player.stats.interceptions} INT`}
                                      </span>
                                    )}
                                    {player.position === "RB" && (
                                      <span>
                                        {player.stats.rushingYards} rush yds, {player.stats.rushingTDs} TD
                                        {player.stats.receptions > 0 && `, ${player.stats.receptions} rec`}
                                      </span>
                                    )}
                                    {(player.position === "WR" || player.position === "TE") && (
                                      <span>
                                        {player.stats.receptions} rec, {player.stats.receivingYards} yds, {player.stats.receivingTDs} TD
                                      </span>
                                    )}
                                    {!["QB", "RB", "WR", "TE"].includes(player.position) && player.stats.points > 0 && (
                                      <span>{player.stats.points.toFixed(1)} pts</span>
                                    )}
                                    {player.stats.pointsPerGame > 0 && (
                                      <span className="ml-2">&middot; {player.stats.pointsPerGame.toFixed(1)} PPG</span>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                            {player.ownership && player.ownership.percentOwned > 0 && (
                              <div className="mt-0.5 text-xs text-bc-text-3">
                                {player.ownership.percentOwned.toFixed(1)}% owned
                                {player.ownership.averageDraftPosition && (
                                  <span> &middot; ADP: {player.ownership.averageDraftPosition.toFixed(1)}</span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </Label>
                    </div>
                  ))}
                  {(!playersToShow || playersToShow.length === 0) && (
                    <p className="text-sm text-bc-text-2">No players available</p>
                  )}
                </div>
              </div>
            )}

            {/* Additional Context */}
            <div className="space-y-2">
              <Label htmlFor="context">Additional Context (Optional)</Label>
              <Textarea
                id="context"
                placeholder="Any additional details Vinny should know? (e.g., 'Looking for a RB1', 'They want too much')"
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                className="h-20 resize-none"
              />
            </div>
          </div>
        </ScrollArea>

        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleConfirm}
            disabled={
              selectedPlayers.length === 0 || 
              (rumorType === "other_offer" && !selectedTeam)
            }
          >
            Leak to Vinny
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}