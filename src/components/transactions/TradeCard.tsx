"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Calendar, Repeat } from "lucide-react";
import { format } from "date-fns";
import { TradeData } from "./types";

interface TradeCardProps {
  trade: TradeData;
}

export const TradeCard: React.FC<TradeCardProps> = ({ trade }) => {
  // Show the teams involved more clearly
  const teamsInvolved = trade.tradeDetails?.map((detail) => detail.team?.name).filter(Boolean) || [];
  
  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        {/* Mobile-first header */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Repeat className="w-4 h-4 text-blue-500" />
              <CardTitle className="text-base sm:text-lg">Trade</CardTitle>
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="w-3 h-3" />
              <span className="hidden sm:inline">{format(new Date(trade.proposedDate), "MMM d, yyyy")}</span>
              <span className="sm:hidden">{format(new Date(trade.proposedDate), "MMM d")}</span>
            </div>
          </div>
          
          <div className="flex items-center justify-between text-sm">
            {teamsInvolved.length === 2 && (
              <div className="text-muted-foreground">
                <span className="hidden sm:inline">{teamsInvolved[0]} ↔ {teamsInvolved[1]}</span>
                <span className="sm:hidden">{teamsInvolved[0]} ↔ {teamsInvolved[1]}</span>
              </div>
            )}
            <div className="text-muted-foreground">Week {trade.scoringPeriod}</div>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="pt-0">
        <div className="space-y-4 sm:grid sm:grid-cols-2 sm:gap-4 sm:space-y-0">
          {trade.tradeDetails?.map((detail, idx: number) => (
            <div key={idx} className="space-y-2 border-l-2 border-l-blue-100 pl-3 sm:border-l-0 sm:pl-0">
              <div className="flex items-center gap-2">
                <Avatar className="w-6 h-6 sm:w-8 sm:h-8">
                  <AvatarImage src={detail.team?.logo} />
                  <AvatarFallback className="text-xs">{detail.team?.abbreviation || "?"}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm sm:text-base truncate">{detail.team?.name || "Unknown Team"}</div>
                  <div className="text-xs text-muted-foreground truncate">{detail.team?.owner}</div>
                </div>
              </div>
              
              {detail.playersReceived.length > 0 && (
                <div className="pl-0 sm:pl-10">
                  <div className="text-xs font-medium text-green-600 mb-1">Receives:</div>
                  <div className="space-y-0.5">
                    {detail.playersReceived.map((player, pidx: number) => (
                      <div key={pidx} className="text-xs text-muted-foreground">
                        <span className="font-medium">{player?.name || 'Unknown Player'}</span>
                        <span className="text-muted-foreground/70"> ({player?.position}{player?.team && ` - ${player.team}`})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {detail.playersSent.length > 0 && (
                <div className="pl-0 sm:pl-10">
                  <div className="text-xs font-medium text-red-600 mb-1">Sends:</div>
                  <div className="space-y-0.5">
                    {detail.playersSent.map((player, pidx: number) => (
                      <div key={pidx} className="text-xs text-muted-foreground">
                        <span className="font-medium">{player?.name || 'Unknown Player'}</span>
                        <span className="text-muted-foreground/70"> ({player?.position}{player?.team && ` - ${player.team}`})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};