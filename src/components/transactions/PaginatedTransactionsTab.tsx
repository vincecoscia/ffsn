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
import { ChevronLeft, ChevronRight } from "lucide-react";

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
      <div className="text-center text-muted-foreground py-8">
        <div className="mb-2">No regular transactions found for {selectedSeason} season.</div>
        <div className="text-xs">
          Only draft transactions are available for this season.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Week Navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={goToPreviousWeek}
            disabled={!canGoToPrevious}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous Week
          </Button>
          
          <Select
            value={selectedWeek?.toString() || ""}
            onValueChange={(value) => setSelectedWeek(Number(value))}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Week" />
            </SelectTrigger>
            <SelectContent>
              {regularTransactionWeeks.map((weekData) => (
                <SelectItem key={weekData.week} value={weekData.week.toString()}>
                  Week {weekData.week} ({weekData.total - weekData.draft})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Button
            variant="outline"
            size="sm"
            onClick={goToNextWeek}
            disabled={!canGoToNext}
          >
            Next Week
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {selectedWeek && (
          <div className="text-sm text-muted-foreground">
            Week {selectedWeek} of {selectedSeason} season
          </div>
        )}
      </div>

      {/* Transactions Content */}
      <ScrollArea className="h-[calc(100vh-300px)]">
        {!weekTransactions && selectedWeek ? (
          <div className="space-y-4">
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
        ) : weekTransactions?.transactions.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No transactions found for Week {selectedWeek}.
          </div>
        ) : (
          <div className="space-y-4">
            {weekTransactions?.transactions.map((transaction) => (
              <TransactionCard key={transaction._id} transaction={transaction} />
            ))}
            
            {weekTransactions?.hasMore && (
              <div className="text-center py-4">
                <div className="text-sm text-muted-foreground">
                  More transactions available for this week
                </div>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};
