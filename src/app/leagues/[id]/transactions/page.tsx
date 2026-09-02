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
import { Panel, SectionHeader, LoadingScreen, EmptyState } from "@/components/broadcast";
import { Inbox } from "lucide-react";

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
    return <LoadingScreen message="Loading transactions" />;
  }

  // If we have no transactions data yet, show loading
  if (!allTransactionsData) {
    return <LoadingScreen message="Loading transactions" />;
  }

  // If there are no transactions at all, show empty state
  if (allTransactionsData.transactions.length === 0) {
    return (
      <LeaguePageLayout
        leagueId={leagueId}
        currentUserId={userId}
        title="Transactions"
      >
        <EmptyState
          icon={<Inbox className="size-6" strokeWidth={1.8} />}
          title="No transactions found"
          description="No transaction data is available for this league yet. Transactions will appear here once the league data is synced."
        />
      </LeaguePageLayout>
    );
  }

  // If we have transactions but no selectedSeason yet, show loading
  if (selectedSeason === null) {
    return <LoadingScreen message="Loading season data" />;
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
      <Panel padding="md">
        <SectionHeader
          title="Transactions"
          kicker={`${selectedSeason} season`}
          actions={
            <SeasonSelector
              currentSeason={(availableSeasons && availableSeasons[0]) || new Date().getFullYear()}
              selectedSeason={selectedSeason!}
              onSeasonChange={setSelectedSeason}
              availableSeasons={availableSeasons || []}
            />
          }
        />

        <Tabs defaultValue="all" className="mt-5 w-full gap-5">
          <TabsList className="grid w-full grid-cols-3 sm:w-auto sm:inline-flex sm:grid-cols-none">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="trades">Trades</TabsTrigger>
            <TabsTrigger value="draft">Draft</TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            <PaginatedTransactionsTab
              leagueId={leagueId}
              selectedSeason={selectedSeason}
            />
          </TabsContent>

          <TabsContent value="trades">
            {!tradeData && selectedSeason ? (
              <div className="space-y-4">
                {/* Trade card skeletons */}
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="border border-bc-hairline p-4 space-y-3">
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

          <TabsContent value="draft">
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
                  <div key={i} className="border border-bc-hairline p-4 space-y-2">
                    <div className="flex justify-between items-start">
                      <div className="flex items-center space-x-3">
                        <Skeleton className="h-8 w-8" />
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
      </Panel>
    </LeaguePageLayout>
  );
}
