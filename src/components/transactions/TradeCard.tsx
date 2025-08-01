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
  const teamsInvolved = trade.tradeDetails?.map((detail: any) => detail.team?.name).filter(Boolean) || [];
  
  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Repeat className="w-5 h-5 text-blue-500" />
            <CardTitle className="text-lg">Trade</CardTitle>
            {teamsInvolved.length === 2 && (
              <div className="text-sm text-muted-foreground">
                {teamsInvolved[0]} ↔ {teamsInvolved[1]}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Calendar className="w-3 h-3" />
            {format(new Date(trade.proposedDate), "MMM d, yyyy")}
          </div>
        </div>
        <div className="text-sm text-muted-foreground">Week {trade.scoringPeriod}</div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {trade.tradeDetails?.map((detail: any, idx: number) => (
            <div key={idx} className="space-y-2">
              <div className="flex items-center gap-2">
                <Avatar className="w-8 h-8">
                  <AvatarImage src={detail.team?.logo} />
                  <AvatarFallback>{detail.team?.abbreviation || "?"}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-medium">{detail.team?.name || "Unknown Team"}</div>
                  <div className="text-sm text-muted-foreground">{detail.team?.owner}</div>
                </div>
              </div>
              
              {detail.playersReceived.length > 0 && (
                <div className="pl-10">
                  <div className="text-sm font-medium text-green-600 mb-1">Receives:</div>
                  {detail.playersReceived.map((player: any, pidx: number) => (
                    <div key={pidx} className="text-sm text-muted-foreground">
                      {player?.name || 'Unknown Player'} ({player?.position} - {player?.team})
                    </div>
                  ))}
                </div>
              )}
              
              {detail.playersSent.length > 0 && (
                <div className="pl-10">
                  <div className="text-sm font-medium text-red-600 mb-1">Sends:</div>
                  {detail.playersSent.map((player: any, pidx: number) => (
                    <div key={pidx} className="text-sm text-muted-foreground">
                      {player?.name || 'Unknown Player'} ({player?.position} - {player?.team})
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};