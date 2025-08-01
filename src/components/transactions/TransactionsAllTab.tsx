"use client";

import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TransactionCard } from "./TransactionCard";
import { Transaction } from "./types";
import { groupTransactionsByWeek } from "./utils";

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
              <h4 className="text-md font-semibold mb-3 text-gray-700">Week {week}</h4>
              {weekTransactions.map((transaction: Transaction) => (
                <TransactionCard key={transaction._id} transaction={transaction} />
              ))}
            </div>
          ))
      ) : (
        <div className="text-center text-muted-foreground py-8">
          <div className="mb-2">No transactions found for {selectedSeason} season.</div>
          <div className="text-xs">
            Available seasons with data: {availableSeasons?.join(', ') || 'None'}
          </div>
        </div>
      )}
    </ScrollArea>
  );
};