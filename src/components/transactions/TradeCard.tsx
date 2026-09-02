"use client";

import React from "react";
import { Panel, SectionHeader, TeamTile } from "@/components/broadcast";
import { Calendar, Repeat } from "lucide-react";
import { format } from "date-fns";
import { TradeData } from "./types";

interface TradeCardProps {
  trade: TradeData;
}

function initialsFor(name?: string, abbreviation?: string) {
  if (abbreviation) return abbreviation.slice(0, 3).toUpperCase();
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export const TradeCard: React.FC<TradeCardProps> = ({ trade }) => {
  // Show the teams involved more clearly
  const teamsInvolved = trade.tradeDetails?.map((detail) => detail.team?.name).filter(Boolean) || [];

  return (
    <Panel padding="md" className="mb-4">
      <SectionHeader
        size="sm"
        title={
          <span className="flex items-center gap-2">
            <Repeat className="size-4 text-bc-signal" />
            Trade
          </span>
        }
        kicker={
          <span>
            {teamsInvolved.length === 2 && `${teamsInvolved[0]} ↔ ${teamsInvolved[1]} · `}
            Week {trade.scoringPeriod}
          </span>
        }
        actions={
          <span className="flex items-center gap-1.5 bc-label-sm text-bc-text-3">
            <Calendar className="size-3.5" />
            {format(new Date(trade.proposedDate), "MMM d, yyyy")}
          </span>
        }
      />

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {trade.tradeDetails?.map((detail, idx: number) => (
          <div key={idx} className="flex flex-col gap-2.5 border-l-2 border-bc-red pl-3">
            <div className="flex items-center gap-2.5">
              <TeamTile
                initials={initialsFor(detail.team?.name, detail.team?.abbreviation)}
                src={detail.team?.logo}
                size={32}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-[15px] font-bold uppercase leading-none text-bc-ink">
                  {detail.team?.name || "Unknown team"}
                </div>
                <div className="truncate bc-label-sm text-bc-text-3">{detail.team?.owner}</div>
              </div>
            </div>

            {detail.playersReceived.length > 0 && (
              <div>
                <div className="bc-label-sm mb-1 text-bc-win">Receives</div>
                <div className="flex flex-col gap-0.5">
                  {detail.playersReceived.map((player, pidx: number) => (
                    <div key={pidx} className="text-xs text-bc-text-2">
                      <span className="font-medium text-bc-ink">{player?.name || "Unknown player"}</span>
                      <span className="text-bc-text-3"> ({player?.position}{player?.team && ` - ${player.team}`})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail.playersSent.length > 0 && (
              <div>
                <div className="bc-label-sm mb-1 text-bc-red-text">Sends</div>
                <div className="flex flex-col gap-0.5">
                  {detail.playersSent.map((player, pidx: number) => (
                    <div key={pidx} className="text-xs text-bc-text-2">
                      <span className="font-medium text-bc-ink">{player?.name || "Unknown player"}</span>
                      <span className="text-bc-text-3"> ({player?.position}{player?.team && ` - ${player.team}`})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
};
