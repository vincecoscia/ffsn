import React from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useDraftStatus } from '../hooks/use-draft-status';
import { useLeagueSeason } from '../hooks/use-league-season';
import { MatchupDisplay } from './MatchupDisplay';
import { DraftOrderDisplay } from './DraftOrderDisplay';
import { Id } from '../../convex/_generated/dataModel';
import { SectionHeader } from '@/components/broadcast';
import { Skeleton } from '@/components/ui/skeleton';

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

function SeasonMeta({ seasonId }: { seasonId: number }) {
  return <span className="bc-label text-bc-text-3">{seasonId} season</span>;
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[120px]" />
      ))}
    </div>
  );
}

export function LeagueWeeklySection({ leagueId, teams, seasonId: seasonIdProp }: LeagueWeeklySectionProps) {
  // Default to the league's current season when no season is explicitly provided
  const { currentSeason } = useLeagueSeason(leagueId);
  const seasonId = seasonIdProp ?? currentSeason;

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
      <div className="flex flex-col gap-5">
        <SectionHeader title="Scoreboard" actions={<SeasonMeta seasonId={seasonId} />} />
        <LoadingGrid />
      </div>
    );
  }

  // If draft is complete, show matchups
  if (isDraftComplete) {
    if (!matchupData) {
      return (
        <div className="flex flex-col gap-5">
          <SectionHeader title="Scoreboard" actions={<SeasonMeta seasonId={seasonId} />} />
          <LoadingGrid />
        </div>
      );
    }

    const isFinalWeek =
      matchupData.matchups.length > 0 && matchupData.matchups.every((m) => !!m.winner);

    return (
      <div className="flex flex-col gap-5">
        <SectionHeader
          title="Scoreboard"
          kicker={`Week ${matchupData.currentWeek} · ${isFinalWeek ? "Final" : "Live"}`}
          actions={<SeasonMeta seasonId={seasonId} />}
        />
        <MatchupDisplay
          matchups={matchupData.matchups}
          teams={teams}
          currentWeek={matchupData.currentWeek}
        />
      </div>
    );
  }

  // If draft is not complete, show draft order
  if (draftData?.draftSettings) {
    return (
      <div className="flex flex-col gap-5">
        <SectionHeader
          title="Draft order"
          kicker={draftData.draftSettings.type ? `${draftData.draftSettings.type} draft` : "Round 1"}
          actions={<SeasonMeta seasonId={seasonId} />}
        />
        <DraftOrderDisplay teams={teams} draftSettings={draftData.draftSettings} />
      </div>
    );
  }

  // Fallback - no data available
  return (
    <div className="flex flex-col gap-5">
      <SectionHeader title="Scoreboard" actions={<SeasonMeta seasonId={seasonId} />} />
      <p className="text-[15px] text-bc-text-2">
        Draft and matchup information will be available once ESPN data is synced.
      </p>
    </div>
  );
}
