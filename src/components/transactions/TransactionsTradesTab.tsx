"use client";

import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TradeCard } from "./TradeCard";
import { TradeData } from "./types";

interface TransactionsTradesTabProps {
  tradeData: TradeData[] | undefined;
  selectedSeason: number;
}

export const TransactionsTradesTab: React.FC<TransactionsTradesTabProps> = ({ 
  tradeData, 
  selectedSeason 
}) => {
  return (
    <ScrollArea className="h-[calc(100vh-200px)]">
      {tradeData && tradeData.length > 0 ? (
        tradeData.map((trade) => (
          <TradeCard key={trade._id} trade={trade} />
        ))
      ) : (
        <div className="text-center text-muted-foreground py-8">
          <div className="mb-2">No trades found for {selectedSeason} season.</div>
          <div className="text-xs">
            Try selecting a different season or check the "All Transactions" tab.
          </div>
        </div>
      )}
    </ScrollArea>
  );
};