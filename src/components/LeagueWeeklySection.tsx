import React from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useDraftStatus } from '../hooks/use-draft-status';
import { MatchupDisplay } from './MatchupDisplay';
import { DraftOrderDisplay } from './DraftOrderDisplay';
import { Id } from '../../convex/_generated/dataModel';

interface Team {
  _id: string;
  name: string;
  abbreviation?: string;
  logo?: string;
  owner: string;
  externalId: string;
  record: {
    wins: number;
    losses: number;
    ties: number;
    pointsFor?: number;
    pointsAgainst?: number;
  };
}

interface LeagueWeeklySectionProps {
  leagueId: Id<"leagues">;
  teams: Team[];
  seasonId?: number;
}

export function LeagueWeeklySection({ leagueId, teams, seasonId = 2025 }: LeagueWeeklySectionProps) {
  // Get draft status
  const { isDraftComplete, draftData, isLoading: draftLoading } = useDraftStatus(leagueId, seasonId);
  
  // Get current week matchups (only if draft is complete)
  const matchupData = useQuery(
    api.matchups.getCurrentWeekMatchups,
    isDraftComplete ? { leagueId, seasonId } : "skip"
  );

  // Loading state
  if (draftLoading) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="animate-pulse">
          <div className="h-5 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="flex space-x-3">
            <div className="flex-shrink-0 w-48 h-24 bg-gray-200 rounded-lg"></div>
            <div className="flex-shrink-0 w-48 h-24 bg-gray-200 rounded-lg"></div>
            <div className="flex-shrink-0 w-48 h-24 bg-gray-200 rounded-lg"></div>
          </div>
        </div>
      </div>
    );
  }

  // If draft is complete, show matchups
  if (isDraftComplete) {
    if (!matchupData) {
      return (
        <div className="bg-white rounded-lg shadow-sm p-4">
          <div className="animate-pulse">
            <div className="h-5 bg-gray-200 rounded w-1/4 mb-4"></div>
            <div className="flex space-x-3">
              <div className="flex-shrink-0 w-64 h-32 bg-gray-200 rounded-lg"></div>
              <div className="flex-shrink-0 w-64 h-32 bg-gray-200 rounded-lg"></div>
              <div className="flex-shrink-0 w-64 h-32 bg-gray-200 rounded-lg"></div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <MatchupDisplay
        matchups={matchupData.matchups}
        teams={teams}
        currentWeek={matchupData.currentWeek}
      />
    );
  }

  // If draft is not complete, show draft order
  if (draftData?.draftSettings) {
    return (
      <DraftOrderDisplay
        teams={teams}
        draftSettings={draftData.draftSettings}
      />
    );
  }

  // Fallback - no data available
  return (
    <div className="bg-white rounded-lg shadow-sm p-4">
      <h2 className="text-lg font-bold text-gray-900 mb-3">League Status</h2>
      <p className="text-sm text-gray-500">
        Draft and matchup information will be available once ESPN data is synced.
      </p>
    </div>
  );
}