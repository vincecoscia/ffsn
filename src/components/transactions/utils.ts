import { Transaction, DraftPick, TeamDraftData } from "./types";

// Helper function to group transactions by week within a season
export const groupTransactionsByWeek = (transactions: Transaction[]) => {
  const filteredTransactions = transactions.filter((t: Transaction) => 
    t.type !== 'DRAFT' && t.type !== 'ROSTER'
  );
  const grouped = filteredTransactions.reduce((acc, transaction) => {
    const week = transaction.scoringPeriod;
    if (!acc[week]) {
      acc[week] = [];
    }
    acc[week].push(transaction);
    return acc;
  }, {} as Record<number, Transaction[]>);
  
  // Sort each week's transactions by date (newest first)
  Object.keys(grouped).forEach(week => {
    grouped[Number(week)].sort((a: Transaction, b: Transaction) => 
      b.proposedDate - a.proposedDate
    );
  });
  
  return grouped;
};

// Helper function to get draft transactions
export const getDraftTransactions = (transactions: Transaction[]): DraftPick[] => {
  return transactions
    .filter((t: Transaction) => t.type === 'DRAFT')
    .sort((a: Transaction, b: Transaction) => {
      // Sort by overall pick number if available, otherwise by date
      const aPickNum = a.items[0]?.overallPickNumber || 999;
      const bPickNum = b.items[0]?.overallPickNumber || 999;
      return aPickNum - bPickNum;
    }) as DraftPick[];
};

// Helper function to group draft picks by round (dynamic team count)
export const groupDraftByRound = (draftPicks: DraftPick[], teamCount: number) => {
  const grouped = draftPicks.reduce((acc, pick) => {
    const pickNumber = pick.items[0]?.overallPickNumber;
    const round = pickNumber ? Math.ceil(pickNumber / teamCount) : 999;
    if (!acc[round]) {
      acc[round] = [];
    }
    acc[round].push(pick);
    return acc;
  }, {} as Record<number, DraftPick[]>);
  
  return grouped;
};

// Helper function to group draft picks by team
export const groupDraftByTeam = (draftPicks: DraftPick[]): Record<string, TeamDraftData> => {
  const grouped = draftPicks.reduce((acc, pick) => {
    const team = pick.items[0]?.toTeam;
    if (team) {
      const teamKey = team._id;
      if (!acc[teamKey]) {
        acc[teamKey] = {
          team: team,
          picks: []
        };
      }
      acc[teamKey].picks.push(pick);
    }
    return acc;
  }, {} as Record<string, TeamDraftData>);
  
  return grouped;
};

// Helper function to get transaction icon type
export const getTransactionIcon = (type: string) => {
  switch (type) {
    case "DRAFT":
      return "trophy";
    case "TRADE_ACCEPT":
      return "repeat";
    case "WAIVER":
    case "FREEAGENT":
      return "package";
    default:
      return "users";
  }
};

// Helper function to get transaction type label
export const getTransactionTypeLabel = (type: string) => {
  switch (type) {
    case "DRAFT":
      return "Draft";
    case "TRADE_ACCEPT":
      return "Trade";
    case "WAIVER":
      return "Waiver";
    case "FREEAGENT":
      return "Free Agent";
    default:
      return type;
  }
};