"use client";

import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@clerk/nextjs";
import { LeaguePageLayout } from "@/components/LeaguePageLayout";
import { SeasonSelector } from "@/components/SeasonSelector";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TransactionsAllTab,
  TransactionsTradesTab,
  TransactionsDraftTab,
  getDraftTransactions
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
  



  // Early return only for critical missing data
  if (!userId || !league || !allTransactionsData || selectedSeason === null) {
    return <div>Loading...</div>;
  }
  
  // Use the appropriate data source
  const dataToDisplay = transactionsData || allTransactionsData;
  
  // Process the current season's transactions
  const currentSeasonTransactions = dataToDisplay.groupedBySeasons[selectedSeason] || [];
  const draftTransactions = getDraftTransactions(currentSeasonTransactions);
  
  // Get the actual team count for this season (with fallback while loading)
  const teamCount = teamsData?.length || 12; // Default to 12 teams while loading

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
            {!transactionsData && selectedSeason ? (
              <div className="space-y-4">
                {/* Week header skeleton */}
                <Skeleton className="h-6 w-20" />
                {/* Transaction card skeletons */}
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="border rounded-lg p-4 space-y-2">
                    <div className="flex justify-between items-start">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                ))}
              </div>
            ) : (
              <TransactionsAllTab 
                transactions={currentSeasonTransactions}
                selectedSeason={selectedSeason}
                availableSeasons={allTransactionsData.seasons}
              />
            )}
          </TabsContent>

          <TabsContent value="trades" className="mt-6">
            {!tradeData && selectedSeason ? (
              <div className="space-y-4">
                {/* Trade card skeletons */}
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="border rounded-lg p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <Skeleton className="h-5 w-24" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-3/4" />
                      </div>
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-3/4" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <TransactionsTradesTab 
                tradeData={tradeData}
                selectedSeason={selectedSeason}
              />
            )}
          </TabsContent>
          
          <TabsContent value="draft" className="mt-6">
            {!teamsData && selectedSeason ? (
              <div className="space-y-4">
                {/* Draft header skeleton */}
                <div className="flex justify-between items-center">
                  <div className="space-y-1">
                    <Skeleton className="h-6 w-48" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                  <Skeleton className="h-10 w-64" />
                </div>
                {/* Draft pick skeletons */}
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="border rounded-lg p-4 space-y-2">
                    <div className="flex justify-between items-start">
                      <div className="flex items-center space-x-3">
                        <Skeleton className="h-8 w-8 rounded-full" />
                        <div className="space-y-1">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-3 w-24" />
                        </div>
                      </div>
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <TransactionsDraftTab 
                draftTransactions={draftTransactions}
                selectedSeason={selectedSeason}
                teamCount={teamCount}
                draftView={draftView}
                onDraftViewChange={setDraftView}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </LeaguePageLayout>
  );
}