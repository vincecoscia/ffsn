"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ArrowRight, Trophy } from "lucide-react";
import { DraftPick } from "./types";

interface DraftCardProps {
  draftPick: DraftPick;
  teamCount: number;
}

export const DraftCard: React.FC<DraftCardProps> = ({ draftPick, teamCount }) => {
  const item = draftPick.items[0]; // Draft picks should have one item
  const pickNumber = item?.overallPickNumber;
  const round = pickNumber ? Math.ceil(pickNumber / teamCount) : 'Unknown';
  const pickInRound = pickNumber ? ((pickNumber - 1) % teamCount) + 1 : 'Unknown';
  
  return (
    <div className="border rounded-lg p-3 mb-3 bg-card hover:bg-accent/50 transition-colors">
      {/* Mobile-optimized layout */}
      <div className="space-y-2 sm:space-y-0">
        {/* Header with pick info */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-yellow-600" />
            <Badge variant="outline" className="text-xs">
              #{pickNumber}
            </Badge>
            <span className="text-xs text-muted-foreground">
              R{round}P{pickInRound}
            </span>
          </div>
          
          {/* Player info - mobile first */}
          <div className="text-right sm:hidden">
            <div className="text-sm font-medium truncate max-w-[120px]">
              {item.player?.name || 'Unknown Player'}
            </div>
            <div className="text-xs text-muted-foreground">
              {item.player?.position}
            </div>
          </div>
        </div>
        
        {/* Team and player info */}
        <div className="flex items-center justify-between sm:mt-0">
          <div className="flex items-center gap-2">
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Avatar className="w-5 h-5">
              <AvatarImage src={item.toTeam?.logo} />
              <AvatarFallback className="text-xs">{item.toTeam?.abbreviation || "?"}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium truncate">{item.toTeam?.name}</span>
          </div>
          
          {/* Player info - desktop */}
          <div className="text-right flex-shrink-0 hidden sm:block">
            <div className="text-sm font-medium">
              {item.player?.name || 'Unknown Player'}
            </div>
            <div className="text-xs text-muted-foreground">
              {item.player?.position} - {item.player?.team}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};