"use client";

import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TradeCard } from "./TradeCard";
import { TradeData } from "./types";
import { EmptyState } from "@/components/broadcast";
import { Repeat } from "lucide-react";

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
        <EmptyState
          icon={<Repeat className="size-6" strokeWidth={1.8} />}
          title="No trades"
          description={`No trades found for ${selectedSeason} season. Try a different season or the All tab.`}
        />
      )}
    </ScrollArea>
  );
};
