"use client";

import React from "react";
import { Panel, SectionHeader, RankPlate, TeamTile } from "@/components/broadcast";
import { TeamDraftData } from "./types";

interface TeamDraftCardProps {
  teamData: TeamDraftData;
  teamCount: number;
}

function initialsFor(name?: string, abbreviation?: string) {
  if (abbreviation) return abbreviation.slice(0, 3).toUpperCase();
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export const TeamDraftCard: React.FC<TeamDraftCardProps> = ({ teamData, teamCount }) => {
  const { team, picks } = teamData;

  return (
    <Panel padding="md" className="mb-4">
      <SectionHeader
        size="sm"
        title={
          <span className="flex items-center gap-3">
            <TeamTile initials={initialsFor(team.name, team.abbreviation)} src={team.logo} size={40} />
            {team.name}
          </span>
        }
        kicker={`${picks.length} picks`}
      />
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {picks.map((pick) => {
          const item = pick.items[0];
          const pickNumber = item?.overallPickNumber;
          const round = pickNumber ? Math.ceil(pickNumber / teamCount) : "?";
          const pickInRound = pickNumber ? ((pickNumber - 1) % teamCount) + 1 : "?";

          return (
            <div
              key={pick._id}
              className="flex items-center justify-between gap-3 border border-bc-hairline bg-bc-ground p-2.5"
            >
              <div className="flex items-center gap-2.5">
                <RankPlate rank={pickNumber ?? "?"} className="size-7 text-[12px]" />
                <span className="bc-label-sm text-bc-text-3">
                  R{round}P{pickInRound}
                </span>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium text-bc-ink">
                  {item.player?.name || "Unknown player"}
                </div>
                <div className="bc-label-sm text-bc-text-3">
                  {item.player?.position}
                  {item.player?.team && ` · ${item.player.team}`}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
};
