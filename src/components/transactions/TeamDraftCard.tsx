"use client";

import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TeamDraftData } from "./types";

interface TeamDraftCardProps {
  teamData: TeamDraftData;
  teamCount: number;
}

export const TeamDraftCard: React.FC<TeamDraftCardProps> = ({ teamData, teamCount }) => {
  const { team, picks } = teamData;
  
  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <Avatar className="w-10 h-10">
            <AvatarImage src={team.logo} />
            <AvatarFallback>{team.abbreviation || "?"}</AvatarFallback>
          </Avatar>
          <div>
            <CardTitle className="text-lg">{team.name}</CardTitle>
            <CardDescription>{picks.length} picks</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {picks.map((pick) => {
            const item = pick.items[0];
            const pickNumber = item?.overallPickNumber;
            const round = pickNumber ? Math.ceil(pickNumber / teamCount) : 'Unknown';
            const pickInRound = pickNumber ? ((pickNumber - 1) % teamCount) + 1 : 'Unknown';
            
            return (
              <div key={pick._id} className="flex items-center justify-between p-2 rounded-lg border bg-muted/30">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    #{pickNumber}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    R{round}P{pickInRound}
                  </span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium">
                    {item.player?.name || 'Unknown Player'}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {item.player?.position} - {item.player?.team}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};