"use client";

import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DraftCard } from "./DraftCard";
import { TeamDraftCard } from "./TeamDraftCard";
import { DraftPick, DraftView, TeamDraftData } from "./types";
import { groupDraftByRound, groupDraftByTeam } from "./utils";
import { EmptyState } from "@/components/broadcast";
import { Trophy } from "lucide-react";

interface TransactionsDraftTabProps {
  draftTransactions: DraftPick[];
  selectedSeason: number;
  teamCount: number;
  draftView: DraftView;
  onDraftViewChange: (view: DraftView) => void;
}

export const TransactionsDraftTab: React.FC<TransactionsDraftTabProps> = ({
  draftTransactions,
  selectedSeason,
  teamCount,
  draftView,
  onDraftViewChange
}) => {
  const draftByRound = groupDraftByRound(draftTransactions, teamCount);
  const draftByTeam = groupDraftByTeam(draftTransactions);

  return (
    <div className="flex flex-col gap-4">
      {draftTransactions.length > 0 ? (
        <>
          {/* Header + view switch */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="bc-h-title text-[22px]">Draft results · {selectedSeason}</span>
              <p className="bc-label-sm mt-1.5 text-bc-text-3">
                {draftTransactions.length} picks made
              </p>
            </div>

            <Tabs value={draftView} onValueChange={(value) => onDraftViewChange(value as DraftView)}>
              <TabsList className="grid w-full grid-cols-3 sm:inline-flex sm:w-auto">
                <TabsTrigger value="full">Full draft</TabsTrigger>
                <TabsTrigger value="round">By round</TabsTrigger>
                <TabsTrigger value="team">By team</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <ScrollArea className="h-[calc(100vh-250px)]">
            {draftView === 'full' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {draftTransactions.map((draftPick) => (
                  <DraftCard key={draftPick._id} draftPick={draftPick} teamCount={teamCount} />
                ))}
              </div>
            )}

            {draftView === 'round' && (
              <div className="flex flex-col gap-6">
                {Object.entries(draftByRound)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([round, picks]) => (
                    <div key={round} className="flex flex-col gap-3">
                      <span className="bc-h-title text-[20px]">Round {round}</span>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {picks.map((draftPick: DraftPick) => (
                          <DraftCard key={draftPick._id} draftPick={draftPick} teamCount={teamCount} />
                        ))}
                      </div>
                    </div>
                  ))
                }
              </div>
            )}

            {draftView === 'team' && (
              <div>
                {Object.values(draftByTeam)
                  .sort((a: TeamDraftData, b: TeamDraftData) => a.team.name.localeCompare(b.team.name))
                  .map((teamData: TeamDraftData) => (
                    <TeamDraftCard key={teamData.team._id} teamData={teamData} teamCount={teamCount} />
                  ))
                }
              </div>
            )}
          </ScrollArea>
        </>
      ) : (
        <EmptyState
          icon={<Trophy className="size-6" strokeWidth={1.8} />}
          title="No draft data"
          description={`No draft data found for ${selectedSeason} season. Draft transactions may not have been synced yet.`}
        />
      )}
    </div>
  );
};
