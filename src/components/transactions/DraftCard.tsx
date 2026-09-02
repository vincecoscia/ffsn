"use client";

import React from "react";
import { RankPlate, TeamTile } from "@/components/broadcast";
import { DraftPick } from "./types";

interface DraftCardProps {
  draftPick: DraftPick;
  teamCount: number;
}

function initialsFor(name?: string, abbreviation?: string) {
  if (abbreviation) return abbreviation.slice(0, 3).toUpperCase();
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export const DraftCard: React.FC<DraftCardProps> = ({ draftPick, teamCount }) => {
  const item = draftPick.items[0]; // Draft picks should have one item
  const pickNumber = item?.overallPickNumber;
  const round = pickNumber ? Math.ceil(pickNumber / teamCount) : "?";
  const pickInRound = pickNumber ? ((pickNumber - 1) % teamCount) + 1 : "?";

  return (
    <div className="flex items-center gap-3 border border-bc-hairline bg-bc-panel p-3">
      <RankPlate rank={pickNumber ?? "?"} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <TeamTile
            initials={initialsFor(item.toTeam?.name, item.toTeam?.abbreviation)}
            src={item.toTeam?.logo}
            size={24}
          />
          <span className="truncate bc-label-sm text-bc-text-3">{item.toTeam?.name}</span>
        </div>
        <div className="min-w-0">
          <div className="truncate font-display text-[15px] font-bold uppercase leading-none text-bc-ink">
            {item.player?.name || "Unknown player"}
          </div>
          <div className="bc-label-sm mt-1 text-bc-text-3">
            {item.player?.position} · R{round}P{pickInRound}
          </div>
        </div>
      </div>
    </div>
  );
};
