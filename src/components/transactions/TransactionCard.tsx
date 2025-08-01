"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import { Trophy, Repeat, Package, Users } from "lucide-react";
import { format } from "date-fns";
import { Transaction, TransactionItem } from "./types";
import { getTransactionTypeLabel } from "./utils";

interface TransactionCardProps {
  transaction: Transaction;
}

const getTransactionIcon = (type: string) => {
  switch (type) {
    case "DRAFT":
      return <Trophy className="w-4 h-4" />;
    case "TRADE_ACCEPT":
      return <Repeat className="w-4 h-4" />;
    case "WAIVER":
    case "FREEAGENT":
      return <Package className="w-4 h-4" />;
    default:
      return <Users className="w-4 h-4" />;
  }
};

const formatCompactTransactionDescription = (transaction: Transaction) => {
  const items = transaction.items;
  
  if (transaction.type === "TRADE_ACCEPT" && transaction.tradeDetails) {
    // For trades, show a compact summary
    const teams = transaction.tradeDetails.map(detail => detail.team?.name).filter(Boolean);
    return (
      <div className="text-sm text-muted-foreground">
        Trade between {teams.join(" and ")}
      </div>
    );
  }
  
  // For other transaction types - show all players
  if (!items || items.length === 0) return null;
  
  // Group players by action type
  const addedPlayers = items.filter((item: TransactionItem) => item.fromTeamId === 0);
  const droppedPlayers = items.filter((item: TransactionItem) => item.toTeamId === 0);
  const movedPlayers = items.filter((item: TransactionItem) => item.fromTeamId !== 0 && item.toTeamId !== 0);
  
  return (
    <div className="text-sm space-y-1">
      {addedPlayers.length > 0 && (
        <div>
          <span className="text-green-600 font-medium">Added:</span>
          {addedPlayers.map((item: TransactionItem, idx: number) => (
            <span key={idx} className="ml-1">
              <span className="font-medium text-foreground">{item.player?.name || "Unknown"}</span>
              <span className="text-muted-foreground"> ({item.player?.position})</span>
              {item.toTeam && (
                <span className="text-muted-foreground"> → {item.toTeam.name}</span>
              )}
              {idx < addedPlayers.length - 1 && <span className="text-muted-foreground">, </span>}
            </span>
          ))}
          {transaction.type === "WAIVER" && transaction.bidAmount && transaction.bidAmount > 0 && (
            <span className="text-xs text-blue-600 font-medium ml-2">
              (${transaction.bidAmount} FAAB)
            </span>
          )}
        </div>
      )}
      
      {droppedPlayers.length > 0 && (
        <div>
          <span className="text-red-600 font-medium">Dropped:</span>
          {droppedPlayers.map((item: TransactionItem, idx: number) => (
            <span key={idx} className="ml-1">
              <span className="font-medium text-foreground">{item.player?.name || "Unknown"}</span>
              <span className="text-muted-foreground"> ({item.player?.position})</span>
              {item.fromTeam && (
                <span className="text-muted-foreground"> from {item.fromTeam.name}</span>
              )}
              {idx < droppedPlayers.length - 1 && <span className="text-muted-foreground">, </span>}
            </span>
          ))}
        </div>
      )}
      
      {movedPlayers.length > 0 && (
        <div>
          <span className="text-blue-600 font-medium">Moved:</span>
          {movedPlayers.map((item: TransactionItem, idx: number) => (
            <span key={idx} className="ml-1">
              <span className="font-medium text-foreground">{item.player?.name || "Unknown"}</span>
              <span className="text-muted-foreground"> ({item.player?.position})</span>
              {item.fromTeam && item.toTeam && (
                <span className="text-muted-foreground"> {item.fromTeam.name} → {item.toTeam.name}</span>
              )}
              {idx < movedPlayers.length - 1 && <span className="text-muted-foreground">, </span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export const TransactionCard: React.FC<TransactionCardProps> = ({ transaction }) => (
  <div className="border rounded-lg p-3 mb-2 bg-card hover:bg-accent/50 transition-colors">
    <div className="flex items-start justify-between">
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-shrink-0 pt-0.5">
          {getTransactionIcon(transaction.type)}
          <Badge variant="secondary" className="text-xs">
            {getTransactionTypeLabel(transaction.type)}
          </Badge>
        </div>
        
        <div className="min-w-0 flex-1">
          {formatCompactTransactionDescription(transaction)}
        </div>
      </div>
      
      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-shrink-0 pt-0.5">
        <span className="font-medium">W{transaction.scoringPeriod}</span>
        <span>{format(new Date(transaction.proposedDate), "MMM d")}</span>
      </div>
    </div>
  </div>
);