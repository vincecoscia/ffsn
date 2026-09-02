"use client";

import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TransactionCard } from "./TransactionCard";
import { Transaction } from "./types";
import { groupTransactionsByWeek } from "./utils";
import { EmptyState } from "@/components/broadcast";
import { Inbox } from "lucide-react";

interface TransactionsAllTabProps {
  transactions: Transaction[];
  selectedSeason: number;
  availableSeasons?: number[];
}

export const TransactionsAllTab: React.FC<TransactionsAllTabProps> = ({
  transactions,
  selectedSeason,
  availableSeasons
}) => {
  const transactionsByWeek = groupTransactionsByWeek(transactions);

  return (
    <ScrollArea className="h-[calc(100vh-200px)]">
      {/* Show non-draft transactions grouped by week */}
      {Object.keys(transactionsByWeek).length > 0 ? (
        Object.entries(transactionsByWeek)
          .sort(([a], [b]) => Number(b) - Number(a)) // Sort weeks in descending order
          .map(([week, weekTransactions]) => (
            <div key={week} className="mb-6">
              <span className="bc-label-sm text-bc-text-3">Week {week}</span>
              <div className="mt-2">
                {weekTransactions.map((transaction: Transaction) => (
                  <TransactionCard key={transaction._id} transaction={transaction} />
                ))}
              </div>
            </div>
          ))
      ) : (
        <EmptyState
          icon={<Inbox className="size-6" strokeWidth={1.8} />}
          title="No transactions"
          description={`No transactions found for ${selectedSeason} season.${
            availableSeasons?.length ? ` Available seasons: ${availableSeasons.join(", ")}.` : ""
          }`}
        />
      )}
    </ScrollArea>
  );
};
