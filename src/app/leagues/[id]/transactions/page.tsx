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
  TransactionsTradesTab,
  TransactionsDraftTab,
  getDraftTransactions
} from "@/components/transactions";
import { PaginatedTransactionsTab } from "@/components/transactions/PaginatedTransactionsTab";

interface TransactionsPageProps {
  params: Promise<{ id: string }>;
}

export default function TransactionsPage({ params }: TransactionsPageProps) {
  const resolvedParams = React.use(params);
  const leagueId = resolvedParams.id as Id<"leagues">;
  const { userId } = useAuth();
  
  // Get league data
  const league = useQuery(api.leagues.getById, { id: leagueId });
  
  // First, get all transactions to see which seasons have data
  const allTransactionsData = useQuery(api.transactions.getTransactionsBySeason, {
    leagueId,
    // No seasonId = get all seasons
  });

  // Extract season IDs from transaction data and sort them in descending order
  const availableSeasons = React.useMemo(() => {
    if (!allTransactionsData) return undefined;
    return allTransactionsData.seasons || [];
  }, [allTransactionsData]);
  
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
  
  // Get teams for the selected season to determine team count for draft rounds
  const teamsData = useQuery(api.teams.getByLeagueAndSeason,
    selectedSeason ? {
      leagueId,
      seasonId: selectedSeason,
    } : "skip"
  );
  
  // Get trade transactions specifically (now requires seasonId)
  const tradeData = useQuery(api.transactions.getTradeTransactions, 
    selectedSeason ? {
      leagueId,
      seasonId: selectedSeason,
    } : "skip"
  );

  // Get draft transactions specifically
  const draftData = useQuery(api.transactions.getDraftTransactions,
    selectedSeason ? {
      leagueId,
      seasonId: selectedSeason,
    } : "skip"
  );
  

  



  // Early return only for critical missing data
  if (!userId || !league) {
    return <div>Loading...</div>;
  }

  // If we have no transactions data yet, show loading
  if (!allTransactionsData) {
    return <div>Loading transactions...</div>;
  }

  // If there are no transactions at all, show empty state
  if (allTransactionsData.transactions.length === 0) {
    return (
      <LeaguePageLayout 
        leagueId={leagueId}
        currentUserId={userId}
        title="Transactions"
      >
        <div className="text-center py-12">
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Transactions Found</h3>
          <p className="text-gray-500">
            No transaction data is available for this league yet. Transactions will appear here once the league data is synced.
          </p>
        </div>
      </LeaguePageLayout>
    );
  }

  // If we have transactions but no selectedSeason yet, show loading
  if (selectedSeason === null) {
    return <div>Loading season data...</div>;
  }
  
  // Process draft transactions - use new dedicated query or fallback to old method
  const draftTransactions = draftData || (allTransactionsData ? getDraftTransactions(allTransactionsData.groupedBySeasons[selectedSeason] || []) : []);
  
  // Get the actual team count for this season (with fallback while loading)
  const teamCount = teamsData?.length || 12; // Default to 12 teams while loading

  return (
    <LeaguePageLayout 
      leagueId={leagueId}
      currentUserId={userId}
      title="Transactions"
    >
      <div className="space-y-4">
        {/* Season Selector - Mobile Optimized */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <SeasonSelector
            currentSeason={(availableSeasons && availableSeasons[0]) || new Date().getFullYear()}
            selectedSeason={selectedSeason!}
            onSeasonChange={setSelectedSeason}
            availableSeasons={availableSeasons || []}
          />
        </div>

                 {/* Tabs for different transaction views - Mobile Optimized */}
         <Tabs defaultValue="all" className="w-full">
           <TabsList className="grid w-full grid-cols-3 sm:w-auto sm:grid-cols-none sm:inline-flex sm:justify-start">
             <TabsTrigger value="all" className="text-xs sm:text-sm sm:flex-none">All</TabsTrigger>
             <TabsTrigger value="trades" className="text-xs sm:text-sm sm:flex-none">Trades</TabsTrigger>
             <TabsTrigger value="draft" className="text-xs sm:text-sm sm:flex-none">Draft</TabsTrigger>
           </TabsList>

          <TabsContent value="all" className="mt-4 sm:mt-6">
            <PaginatedTransactionsTab 
              leagueId={leagueId}
              selectedSeason={selectedSeason}
            />
          </TabsContent>

          <TabsContent value="trades" className="mt-4 sm:mt-6">
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
          
          <TabsContent value="draft" className="mt-4 sm:mt-6">
            {(!draftData && !teamsData) && selectedSeason ? (
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