"use client";

import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trophy } from "lucide-react";
import { DraftCard } from "./DraftCard";
import { TeamDraftCard } from "./TeamDraftCard";
import { DraftPick, DraftView, TeamDraftData } from "./types";
import { groupDraftByRound, groupDraftByTeam } from "./utils";

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
    <div className="space-y-4">
      {draftTransactions.length > 0 ? (
        <>
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-3 sm:space-y-0">
            <div>
              <h3 className="text-lg font-semibold">Draft Results - {selectedSeason}</h3>
              <p className="text-sm text-muted-foreground">
                {draftTransactions.length} picks made
              </p>
            </div>
            
            {/* Draft view options - hidden on mobile */}
            <div className="hidden sm:block">
              <Tabs value={draftView} onValueChange={(value) => onDraftViewChange(value as DraftView)}>
                <TabsList>
                  <TabsTrigger value="full">Full Draft</TabsTrigger>
                  <TabsTrigger value="round">By Round</TabsTrigger>
                  <TabsTrigger value="team">By Team</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>

          {/* Draft view options - shown on mobile below header */}
          <div className="sm:hidden">
            <Tabs value={draftView} onValueChange={(value) => onDraftViewChange(value as DraftView)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="full" className="text-xs">Full Draft</TabsTrigger>
                <TabsTrigger value="round" className="text-xs">By Round</TabsTrigger>
                <TabsTrigger value="team" className="text-xs">By Team</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          
          <ScrollArea className="h-[calc(100vh-250px)]">
            {draftView === 'full' && (
              <div>
                {draftTransactions.map((draftPick) => (
                  <DraftCard key={draftPick._id} draftPick={draftPick} teamCount={teamCount} />
                ))}
              </div>
            )}
            
            {draftView === 'round' && (
              <div>
                {Object.entries(draftByRound)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([round, picks]) => (
                    <div key={round} className="mb-6">
                      <h4 className="text-md font-semibold mb-3 flex items-center gap-2">
                        <Trophy className="w-4 h-4 text-yellow-600" />
                        Round {round}
                      </h4>
                      {picks.map((draftPick: DraftPick) => (
                        <DraftCard key={draftPick._id} draftPick={draftPick} teamCount={teamCount} />
                      ))}
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
        <div className="text-center text-muted-foreground py-8">
          <div className="mb-2">No draft data found for {selectedSeason} season.</div>
          <div className="text-xs">
            Draft transactions may not have been synced yet.
          </div>
        </div>
      )}
    </div>
  );
};