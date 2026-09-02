"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Transaction, TransactionItem } from "./types";
import { getTransactionTypeLabel } from "./utils";

interface TransactionCardProps {
  transaction: Transaction;
}

function typeChipVariant(type: string): "red" | "signal" | "plate" | "outline" {
  switch (type) {
    case "DRAFT":
      return "plate";
    case "TRADE_ACCEPT":
      return "red";
    case "WAIVER":
      return "signal";
    default:
      return "outline";
  }
}

const formatCompactTransactionDescription = (transaction: Transaction) => {
  const items = transaction.items;

  if (transaction.type === "TRADE_ACCEPT" && transaction.tradeDetails) {
    // For trades, show a compact summary
    const teams = transaction.tradeDetails.map(detail => detail.team?.name).filter(Boolean);
    return (
      <div className="text-sm text-bc-text-2">
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
    <div className="flex flex-col gap-1.5 text-sm">
      {addedPlayers.length > 0 && (
        <div className="flex flex-wrap items-start gap-1.5">
          <span className="bc-label-sm text-bc-win">Added</span>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {addedPlayers.map((item: TransactionItem, idx: number) => (
              <span key={idx} className="inline-flex items-center">
                <span className="font-medium text-bc-ink">{item.player?.name || "Unknown"}</span>
                <span className="ml-1 text-xs text-bc-text-3">({item.player?.position})</span>
                {item.toTeam && (
                  <span className="hidden text-xs text-bc-text-3 sm:inline"> → {item.toTeam.name}</span>
                )}
                {idx < addedPlayers.length - 1 && <span className="text-bc-text-3">,</span>}
              </span>
            ))}
            {transaction.type === "WAIVER" && transaction.bidAmount && transaction.bidAmount > 0 && (
              <span className="text-xs font-medium text-bc-signal">
                ${transaction.bidAmount} FAAB
              </span>
            )}
          </div>
        </div>
      )}

      {droppedPlayers.length > 0 && (
        <div className="flex flex-wrap items-start gap-1.5">
          <span className="bc-label-sm text-bc-red-text">Dropped</span>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {droppedPlayers.map((item: TransactionItem, idx: number) => (
              <span key={idx} className="inline-flex items-center">
                <span className="font-medium text-bc-ink">{item.player?.name || "Unknown"}</span>
                <span className="ml-1 text-xs text-bc-text-3">({item.player?.position})</span>
                {item.fromTeam && (
                  <span className="hidden text-xs text-bc-text-3 sm:inline"> from {item.fromTeam.name}</span>
                )}
                {idx < droppedPlayers.length - 1 && <span className="text-bc-text-3">,</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {movedPlayers.length > 0 && (
        <div className="flex flex-wrap items-start gap-1.5">
          <span className="bc-label-sm text-bc-signal">Moved</span>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {movedPlayers.map((item: TransactionItem, idx: number) => (
              <span key={idx} className="inline-flex items-center">
                <span className="font-medium text-bc-ink">{item.player?.name || "Unknown"}</span>
                <span className="ml-1 text-xs text-bc-text-3">({item.player?.position})</span>
                {item.fromTeam && item.toTeam && (
                  <span className="hidden text-xs text-bc-text-3 sm:inline"> {item.fromTeam.name} → {item.toTeam.name}</span>
                )}
                {idx < movedPlayers.length - 1 && <span className="text-bc-text-3">,</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const TransactionCard: React.FC<TransactionCardProps> = ({ transaction }) => (
  <div className="flex flex-col gap-2 border-t border-bc-hairline py-3 first:border-t-0">
    <div className="flex items-center justify-between gap-2">
      <Badge variant={typeChipVariant(transaction.type)}>
        {getTransactionTypeLabel(transaction.type)}
      </Badge>

      <div className="flex items-center gap-2 bc-label-sm text-bc-text-3">
        <span>W{transaction.scoringPeriod}</span>
        <span>·</span>
        <span>{format(new Date(transaction.proposedDate), "MMM d")}</span>
      </div>
    </div>

    <div>{formatCompactTransactionDescription(transaction)}</div>
  </div>
);
