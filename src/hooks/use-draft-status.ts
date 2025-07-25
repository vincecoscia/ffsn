import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';

interface DraftInfo {
  draftDate?: number;
}

interface DraftSettings {
  availableDate?: number;
  date?: number;
  pickOrder?: number[];
  type?: string;
  orderType?: string;
}

interface DraftData {
  draftInfo?: DraftInfo;
  draftSettings?: DraftSettings;
}

interface DraftStatusResult {
  isDraftComplete: boolean;
  draftData: DraftData | null;
  isLoading: boolean;
}

export function useDraftStatus(leagueId: Id<"leagues">, seasonId: number): DraftStatusResult {
  const leagueSeason = useQuery(api.leagues.getLeagueSeasonByYear, {
    leagueId,
    seasonId: seasonId
  });

  const draftStatus = useMemo(() => {
    if (leagueSeason === undefined) {
      return {
        isDraftComplete: false,
        draftData: null,
        isLoading: true
      };
    }

    if (!leagueSeason) {
      return {
        isDraftComplete: false,
        draftData: null,
        isLoading: false
      };
    }

    // Check if draft is complete using multiple methods
    let isDraftComplete = false;

    // Method 1: Check draftInfo.draftDate
    if (leagueSeason.draftInfo?.draftDate === 1) {
      isDraftComplete = true;
    }

    // Method 2: Check if availableDate is in the past
    if (leagueSeason.draftSettings?.availableDate) {
      const draftDate = new Date(leagueSeason.draftSettings.availableDate);
      const now = new Date();
      if (draftDate < now) {
        isDraftComplete = true;
      }
    }

    return {
      isDraftComplete,
      draftData: {
        draftInfo: leagueSeason.draftInfo,
        draftSettings: leagueSeason.draftSettings
      },
      isLoading: false
    };
  }, [leagueSeason]);

  return draftStatus;
}