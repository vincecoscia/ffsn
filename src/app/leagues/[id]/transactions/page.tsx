"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TransactionsAllTab,
  TransactionsTradesTab,
  TransactionsDraftTab,
  getDraftTransactions,
  Transaction,
  DraftView
} from "@/components/transactions";

interface TransactionsPageProps {
  params: Promise<{ id: string }>;
}

export default function TransactionsPage({ params }: TransactionsPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();
  
  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });
  
  // Get available seasons for the league
  const leagueSeasons = useQuery(api.leagues.getLeagueSeasons, { leagueId });
  
  // Extract season IDs and sort them in descending order
  const availableSeasons = React.useMemo(() => {
    if (!leagueSeasons) return undefined;
    return leagueSeasons
      .map(season => season.seasonId)
      .sort((a, b) => b - a);
  }, [leagueSeasons]);
  
  // State for selected season - start with most recent season
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  
  // State for draft view - must be at top level before any conditional returns
  const [draftView, setDraftView] = React.useState<'full' | 'round' | 'team'>('full');
  
  // Set selectedSeason to the most recent season when available seasons are loaded
  React.useEffect(() => {
    if (availableSeasons && availableSeasons.length > 0 && selectedSeason === null) {
      setSelectedSeason(availableSeasons[0]); // Most recent season
    }
  }, [availableSeasons, selectedSeason]);
  
  // First, get all transactions to see which seasons have data
  const allTransactionsData = useQuery(api.transactions.getTransactionsBySeason, {
    leagueId,
    // No seasonId = get all seasons
  });
  
  // Get transactions data for selected season
  const transactionsData = useQuery(api.transactions.getTransactionsBySeason, 
    selectedSeason ? {
      leagueId,
      seasonId: selectedSeason,
    } : "skip"
  );
  
  // Get teams for the selected season to determine team count for draft rounds
  const teamsData = useQuery(api.teams.getByLeagueAndSeason,
    selectedSeason ? {
      leagueId,
      seasonId: selectedSeason,
    } : "skip"
  );
  
  // Get trade transactions specifically
  const tradeData = useQuery(api.transactions.getTradeTransactions, 
    selectedSeason ? {
      leagueId,
      seasonId: selectedSeason,
    } : "skip"
  );
  
  // Set selectedSeason to the most recent season that has transaction data
  React.useEffect(() => {
    if (allTransactionsData && allTransactionsData.seasons && allTransactionsData.seasons.length > 0 && selectedSeason === null) {
      // Use the most recent season that actually has transaction data
      setSelectedSeason(allTransactionsData.seasons[0]);
    }
  }, [allTransactionsData, selectedSeason]);
  



  if (!userId || !league || !allTransactionsData || selectedSeason === null || !teamsData) {
    return <div>Loading...</div>;
  }
  
  // Use the appropriate data source
  const dataToDisplay = transactionsData || allTransactionsData;
  
  // Process the current season's transactions
  const currentSeasonTransactions = dataToDisplay.groupedBySeasons[selectedSeason] || [];
  const draftTransactions = getDraftTransactions(currentSeasonTransactions);
  
  // Get the actual team count for this season
  const teamCount = teamsData.length;

  return (
    <LeaguePageLayout 
      leagueId={leagueId}
      currentUserId={userId}
      title="Transactions"
    >
      <div className="space-y-6">
        {/* Season Selector */}
        <div className="flex items-center gap-4">
          <SeasonSelector
            currentSeason={(availableSeasons && availableSeasons[0]) || new Date().getFullYear()}
            selectedSeason={selectedSeason!}
            onSeasonChange={setSelectedSeason}
            availableSeasons={allTransactionsData.seasons || availableSeasons}
          />

        </div>

        {/* Tabs for different transaction views */}
        <Tabs defaultValue="all" className="w-full">
          <TabsList>
            <TabsTrigger value="all">All Transactions</TabsTrigger>
            <TabsTrigger value="trades">Trades</TabsTrigger>
            <TabsTrigger value="draft">Draft</TabsTrigger>
          </TabsList>

          <TabsContent value="all" className="mt-6">
            <TransactionsAllTab 
              transactions={currentSeasonTransactions}
              selectedSeason={selectedSeason}
              availableSeasons={allTransactionsData.seasons}
            />
          </TabsContent>

          <TabsContent value="trades" className="mt-6">
            <TransactionsTradesTab 
              tradeData={tradeData}
              selectedSeason={selectedSeason}
            />
          </TabsContent>
          
          <TabsContent value="draft" className="mt-6">
            <TransactionsDraftTab 
              draftTransactions={draftTransactions}
              selectedSeason={selectedSeason}
              teamCount={teamCount}
              draftView={draftView}
              onDraftViewChange={setDraftView}
            />
          </TabsContent>
        </Tabs>
      </div>
    </LeaguePageLayout>
  );
}