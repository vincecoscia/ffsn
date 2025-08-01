import { Id } from "../../../convex/_generated/dataModel";

export interface TransactionItem {
  player: {
    name: string;
    position: string;
    team: string | undefined;
  } | null;
  fromTeam: any;
  toTeam: any;
  fromTeamId: number;
  toTeamId: number;
  type: string;
  overallPickNumber?: number;
  playerId?: number;
}

export interface Transaction {
  _id: Id<"transactions">;
  type: string;
  processedDate?: number;
  proposedDate: number;
  items: TransactionItem[];
  primaryTeam: any;
  tradeDetails?: any[];
  status: string;
  scoringPeriod: number;
  bidAmount?: number;
}

export interface DraftPick {
  _id: Id<"transactions">;
  items: TransactionItem[];
  proposedDate: number;
  scoringPeriod: number;
}

export interface TeamDraftData {
  team: any;
  picks: DraftPick[];
}

export interface TradeData {
  _id: Id<"transactions">;
  proposedDate: number;
  scoringPeriod: number;
  tradeDetails: {
    team: any;
    playersReceived: any[];
    playersSent: any[];
  }[];
}

export type DraftView = 'full' | 'round' | 'team';