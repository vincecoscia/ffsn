"use client";

import React, { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TransactionCard } from "./TransactionCard";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { EmptyState } from "@/components/broadcast";

interface PaginatedTransactionsTabProps {
  leagueId: Id<"leagues">;
  selectedSeason: number;
}

export const PaginatedTransactionsTab: React.FC<PaginatedTransactionsTabProps> = ({
  leagueId,
  selectedSeason
}) => {
  // Get available weeks for the season
  const availableWeeks = useQuery(api.transactions.getAvailableWeeks, {
    leagueId,
    seasonId: selectedSeason,
  });

  // Filter to weeks that have regular transactions (non-draft)
  const regularTransactionWeeks = useMemo(() => {
    if (!availableWeeks) return [];
    return availableWeeks
      .filter(week => week.hasRegularTransactions)
      .sort((a, b) => b.week - a.week); // Most recent first
  }, [availableWeeks]);

  // State for selected week
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);

  // Set default week to most recent when data loads
  React.useEffect(() => {
    if (regularTransactionWeeks.length > 0 && selectedWeek === null) {
      setSelectedWeek(regularTransactionWeeks[0].week);
    }
  }, [regularTransactionWeeks, selectedWeek]);

  // Get transactions for selected week
  const weekTransactions = useQuery(api.transactions.getTransactionsByWeek,
    selectedWeek ? {
      leagueId,
      seasonId: selectedSeason,
      scoringPeriod: selectedWeek,
      limit: 50,
    } : "skip"
  );

  // Navigation functions
  const currentWeekIndex = regularTransactionWeeks.findIndex(w => w.week === selectedWeek);
  const canGoToPrevious = currentWeekIndex > 0;
  const canGoToNext = currentWeekIndex < regularTransactionWeeks.length - 1;

  const goToPreviousWeek = () => {
    if (canGoToPrevious) {
      setSelectedWeek(regularTransactionWeeks[currentWeekIndex - 1].week);
    }
  };

  const goToNextWeek = () => {
    if (canGoToNext) {
      setSelectedWeek(regularTransactionWeeks[currentWeekIndex + 1].week);
    }
  };

  // Loading states
  if (!availableWeeks) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  // No transaction weeks available
  if (regularTransactionWeeks.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="size-6" strokeWidth={1.8} />}
        title="No transactions"
        description={`No regular transactions found for ${selectedSeason} season. Only draft transactions are available for this season.`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Week Navigation */}
      <div className="flex flex-col gap-3">
        {/* Week Info Header */}
        {selectedWeek && (
          <div>
            <span className="bc-h-title text-[22px]">Week {selectedWeek}</span>
            <p className="bc-label-sm mt-1.5 text-bc-text-3">{selectedSeason} season</p>
          </div>
        )}

        {/* Navigation Controls */}
        <div className="flex items-center justify-start gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={goToPreviousWeek}
            disabled={!canGoToPrevious}
            className="flex-shrink-0"
          >
            <ChevronLeft className="size-4 sm:mr-1" />
            <span className="hidden sm:inline">Prev</span>
          </Button>

          <Select
            value={selectedWeek?.toString() || ""}
            onValueChange={(value) => setSelectedWeek(Number(value))}
          >
            <SelectTrigger className="w-24 sm:w-32">
              <SelectValue placeholder="Week" />
            </SelectTrigger>
            <SelectContent>
              {regularTransactionWeeks.map((weekData) => (
                <SelectItem key={weekData.week} value={weekData.week.toString()}>
                  <span className="sm:hidden">W{weekData.week}</span>
                  <span className="hidden sm:inline">Week {weekData.week}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            onClick={goToNextWeek}
            disabled={!canGoToNext}
            className="flex-shrink-0"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="size-4 sm:ml-1" />
          </Button>
        </div>
      </div>

      {/* Transactions Content */}
      <ScrollArea className="h-[calc(100vh-280px)] sm:h-[calc(100vh-300px)]">
        {!weekTransactions && selectedWeek ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="border border-bc-hairline p-4 space-y-2">
                <div className="flex justify-between items-start">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            ))}
          </div>
        ) : weekTransactions?.transactions.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-6" strokeWidth={1.8} />}
            title="No transactions"
            description={`No transactions found for Week ${selectedWeek}.`}
          />
        ) : (
          <div>
            {weekTransactions?.transactions.map((transaction) => (
              <TransactionCard key={transaction._id} transaction={transaction} />
            ))}

            {weekTransactions?.hasMore && (
              <div className="text-center py-4">
                <span className="bc-label-sm text-bc-text-3">
                  More transactions available for this week
                </span>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};
