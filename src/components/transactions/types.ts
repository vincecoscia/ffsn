import { Id } from "../../../convex/_generated/dataModel";

export interface TransactionItem {
  player: {
    name: string;
    position: string;
    team: string | undefined;
  } | null;
  fromTeam: {
    name: string;
    externalId?: string;
    _id?: string;
    abbreviation?: string;
    owner?: string;
    logo?: string;
    customLogo?: Id<"_storage"> | string;
    seasonId?: number;
  } | null | undefined;
  toTeam: {
    name: string;
    externalId?: string;
    _id?: string;
    abbreviation?: string;
    owner?: string;
    logo?: string;
    customLogo?: Id<"_storage"> | string;
    seasonId?: number;
  } | null | undefined;
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
  primaryTeam: {
    name: string;
    externalId?: string;
    _id?: string;
    abbreviation?: string;
    owner?: string;
    logo?: string;
    customLogo?: Id<"_storage"> | string;
    seasonId?: number;
  } | null | undefined;
  tradeDetails?: {
    team: {
      name: string;
      externalId?: string;
      _id?: string;
      abbreviation?: string;
      owner?: string;
      logo?: string;
      customLogo?: Id<"_storage"> | string;
      seasonId?: number;
    };
    playersReceived: string[];
    playersSent: string[];
  }[];
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
  team: {
    name: string;
    externalId?: string;
    _id?: string;
    abbreviation?: string;
    owner?: string;
    logo?: string;
    customLogo?: Id<"_storage"> | string;
    seasonId?: number;
  };
  picks: DraftPick[];
}

export interface TradeData {
  _id: Id<"transactions">;
  proposedDate: number;
  scoringPeriod: number;
  tradeDetails: {
    team: {
      name: string;
      externalId?: string;
      _id?: string;
      abbreviation?: string;
      owner?: string;
      logo?: string;
      customLogo?: Id<"_storage"> | string;
      seasonId?: number;
    };
    playersReceived: {
      name: string;
      position: string;
      team?: string;
    }[];
    playersSent: {
      name: string;
      position: string;
      team?: string;
    }[];
  }[];
}

export type DraftView = 'full' | 'round' | 'team';